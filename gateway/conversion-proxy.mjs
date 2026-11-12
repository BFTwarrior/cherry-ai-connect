import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { protocolWorker } from './protocol-worker.mjs';
import { streamSignal } from './stream-observation.mjs';

const MiB=1024*1024;
export function sourceProtocol(url) {
  const path=new URL(url,'http://localhost').pathname;
  if(/^\/v1\/chat\/completions\/?$/.test(path)) return {protocol:'chat'};
  if(/^\/v1\/responses\/?$/.test(path)) return {protocol:'responses'};
  if(/^\/v1\/messages\/?$/.test(path)) return {protocol:'messages'};
  const match=path.match(/^\/(?:gemini\/)?v1(?:beta)?\/models\/(.+):(streamGenerateContent|generateContent)$/);
  if(!match) return {protocol:''};
  try {return {protocol:'gemini',model:decodeURIComponent(match[1]),stream:match[2]==='streamGenerateContent'};} catch {return {protocol:'',invalid:true};}
}
export function conversionTarget(baseUrl, protocol, model, stream) {
  const url=new URL(baseUrl);
  if(url.username || url.password) throw new Error('credentials_in_base_url');
  url.search='';url.hash='';
  const base=url.pathname.replace(/\/(?:v1|v1beta)\/?$/,'').replace(/\/+$/,'');
  const suffix={chat:'/v1/chat/completions',responses:'/v1/responses',messages:'/v1/messages',gemini:`/v1beta/models/${encodeURIComponent(model)}:${stream?'streamGenerateContent':'generateContent'}`}[protocol];
  if(!suffix) throw new Error('configuration_unsupported');
  url.pathname=base+suffix;
  if(protocol==='gemini' && stream) url.searchParams.set('alt','sse');
  return url;
}
export function protocolError(protocol,code,status=400,field='') {
  const message=field ? `${code}: ${field}` : code;
  if(protocol==='messages') return {type:'error',error:{type:code,message}};
  if(protocol==='gemini') return {error:{code:status,status:status>=500?'INTERNAL':'INVALID_ARGUMENT',message}};
  return {error:{type:code,code,message,...(field?{param:field}:{})}};
}
export function unsupportedFeature(body, protocol) {
  for(const field of ['previous_response_id','conversation','background','cachedContent']) if(body[field]) return field;
  if(Array.isArray(body.include) && body.include.length) return 'include';
  if(body.store===true) return 'store';
  if(body.response_format && body.response_format.type !== 'text') return 'response_format';
  if(body.text?.format && body.text.format.type !== 'text') return 'text.format';
  if(body.generationConfig?.responseSchema || body.generationConfig?.responseJsonSchema) return 'generationConfig.responseSchema';
  if(body.output_config?.format) return 'output_config.format';
  if(body.safetySettings?.length) return 'safetySettings';
  // Only a verified dialogue subset crosses protocols. Reject proprietary top-
  // level fields before translation instead of relying on adapters to ignore them.
  const allowed={
    chat:['model','messages','tools','tool_choice','parallel_tool_calls','stream','stream_options','max_tokens','max_completion_tokens','temperature','top_p','stop','reasoning_effort','response_format'],
    responses:['model','input','instructions','tools','tool_choice','parallel_tool_calls','stream','max_output_tokens','temperature','top_p','reasoning','text','store'],
    messages:['model','messages','system','tools','tool_choice','stream','max_tokens','temperature','top_p','top_k','stop_sequences','thinking','output_config'],
    gemini:['model','contents','systemInstruction','system_instruction','tools','toolConfig','generationConfig','stream'],
  }[protocol];
  if(allowed) for(const field of Object.keys(body)) if(!allowed.includes(field)) return field;
  for(let i=0;i<(body.tools || []).length;i++) {
    const tool=body.tools[i];
    if(tool.type && tool.type!=='function') return `tools[${i}].type`;
    if(tool.googleSearch || tool.codeExecution || tool.urlContext || tool.retrieval || tool.googleSearchRetrieval) return `tools[${i}]`;
  }
  const visit=(value,path='')=>{
    if(!value || typeof value!=='object') return '';
    for(const [key,child] of Object.entries(value)) {
      const at=path?`${path}.${key}`:key;
      if(['signature','thoughtSignature','encrypted_content'].includes(key) && child) return at;
      // Images are deliberately gated until their complete conversion matrix is
      // verified. Native same-protocol image requests remain untouched.
      if(['image_url','image','inlineData','inline_data','fileData','file_data'].includes(key) && child) return at;
      if(key==='type' && ['image','input_image','output_image','document','item_reference'].includes(child)) return at;
      if(key==='type' && /audio|video|file|computer|web_search|server_tool/.test(String(child))) return at;
      if(key==='mimeType' && /^(audio|video)\//.test(String(child))) return at;
      const found=visit(child,at);if(found) return found;
    }return '';
  };
  return visit(body);
}
export function upstreamHeaders(protocol,key,length,stream) {
  const headers={'content-type':'application/json','content-length':length,accept:stream?'text/event-stream':'application/json','accept-encoding':'identity'};
  if(protocol==='messages') {headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
  else if(protocol==='gemini') headers['x-goog-api-key']=key;
  else headers.authorization=`Bearer ${key}`;
  return headers;
}
function extractUsage(value,protocol) {
  const usage=value?.usage || value?.response?.usage || value?.message?.usage || value?.usageMetadata;
  if(!usage) return null;
  if(value?.usageMetadata) return {input_tokens:usage.promptTokenCount || 0,output_tokens:(usage.candidatesTokenCount || 0)+(usage.thoughtsTokenCount || 0),total_tokens:usage.totalTokenCount,cache_read_input_tokens:usage.cachedContentTokenCount || 0};
  // Anthropic reports uncached input separately; Cherry's canonical input
  // includes cache reads so the existing UI can subtract them consistently.
  if(protocol==='messages') return {...usage,input_tokens:Number(usage.input_tokens || 0)+Number(usage.cache_read_input_tokens || 0)+Number(usage.cache_creation_input_tokens || 0)};
  return usage;
}
export async function convertedProxy({req,res,provider,client,model,payload,source,target,apiKey,record,normalizeUsage,updateStatus,worker=protocolWorker}) {
  const started=performance.now();let sent=0,first=0,ended=false,terminal=false,translation,upstream,totalTimer,workerAbort;
  let usage=normalizeUsage({});
  const isStreaming=source.protocol==='gemini'?source.stream:payload.stream===true;
  const cross=source.protocol!==target;
  const cancellation=new AbortController();
  const observe=value=>{const next=normalizeUsage(extractUsage(value,target)||{});for(const key of Object.keys(usage)) usage[key]=Math.max(usage[key],next[key]||0);};
  const finish=(status,error='')=>{
    if(ended) return;ended=true;clearTimeout(totalTimer);
    usage.totalTokens=Math.max(usage.totalTokens,usage.inputTokens+usage.outputTokens);
    updateStatus(status>=200 && status<300?'ok':'error',model);
    record({id:crypto.randomUUID(),at:new Date().toISOString(),clientKeyId:client.id,clientKeyName:client.name,providerId:provider.id,providerName:provider.name,model,endpoint:new URL(req.url,'http://local').pathname,method:req.method,reasoningLevel:client.reasoningLevel||'unchanged',stream:isStreaming,status,durationMs:Math.round(performance.now()-(sent||started)),ttftMs:first?Math.round(first-(sent||started)):0,...usage,error,sourceProtocol:source.protocol,targetProtocol:target});
  };
  const sendError=(status,code,field='')=>{
    finish(status,code);
    const value=protocolError(source.protocol,code,status,field);
    if(res.destroyed || res.writableEnded) return;
    if(!res.headersSent) {res.writeHead(status,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify(value));}
    else {
      const frame=source.protocol==='messages'?`event: error\ndata: ${JSON.stringify(value)}\n\n`:source.protocol==='responses'?`event: response.failed\ndata: ${JSON.stringify({type:'response.failed',response:{status:'failed',error:value.error}})}\n\n`:`data: ${JSON.stringify(value)}\n\n`;
      res.end(frame);
    }
  };
  const write=async bytes=>{
    if(res.destroyed) throw new Error('client_disconnected');
    if(!res.write(bytes)) await new Promise((resolve,reject)=>{
      const cleanup=()=>{res.off('drain',drain);res.off('close',close);res.off('error',close);};
      const drain=()=>{cleanup();resolve();};const close=()=>{cleanup();reject(new Error('client_disconnected'));};
      res.once('drain',drain);res.once('close',close);res.once('error',close);
      if(res.destroyed) close();
    });
  };
  res.once('close',()=>{if(!res.writableEnded){cancellation.abort();upstream?.destroy();finish(499,'client_disconnected');}});
  try {
    if(!source.protocol) throw new Error('unsupported_client_protocol');
    if(cross) {const field=unsupportedFeature(payload,source.protocol);if(field){sendError(400,'unsupported_protocol_feature',field);return;}}
    let body=Buffer.from(JSON.stringify(payload));
    if(cross) {translation=await worker.request(source.protocol,target,model,body,isStreaming,cancellation.signal);body=translation.body;}
    if(translation) {
      workerAbort=()=>{upstream?.destroy(new Error('translator_exited'));sendError(502,'translator_exited');};
      translation.session.controller.signal.addEventListener('abort',workerAbort,{once:true});
      if(translation.session.controller.signal.aborted) workerAbort();
    }
    if(ended || res.destroyed) throw new Error('client_disconnected');
    const url=conversionTarget(provider.baseUrl,target,model,isStreaming);
    const transport=url.protocol==='https:'?https:http;
    const headers=upstreamHeaders(target,apiKey,body.length,isStreaming);
    // Native API feature/version negotiation survives transparent forwarding;
    // never carry those headers into an unrelated target protocol.
    if(!cross) for(const name of target==='messages'?['anthropic-version','anthropic-beta']:target==='chat'||target==='responses'?['openai-beta']:[]) {
      if(typeof req.headers[name]==='string') headers[name]=req.headers[name];
    }
    const response=await new Promise((resolve,reject)=>{
      upstream=transport.request(url,{method:'POST',headers},resolve);
      upstream.once('error',reject);upstream.once('finish',()=>{sent=performance.now();});upstream.setTimeout(120000,()=>upstream.destroy(new Error('upstream_timeout')));
      totalTimer=setTimeout(()=>upstream.destroy(new Error('upstream_total_timeout')),15*60*1000);totalTimer.unref?.();upstream.end(body);
    });
    const status=response.statusCode || 502;
    if(response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {response.destroy();throw new Error('unsupported_upstream_encoding');}
    if(status<200 || status>=300) {response.destroy();sendError(status,'upstream_error');return;}
    if(isStreaming && !String(response.headers['content-type']).includes('text/event-stream')) {response.destroy();throw new Error('invalid_upstream_stream');}
    if(!isStreaming) {
      const chunks=[];let size=0;
      for await(const chunk of response) {size+=chunk.length;if(size>25*MiB) throw new Error('upstream_response_too_large');chunks.push(chunk);}
      const raw=Buffer.concat(chunks);let value;try{value=JSON.parse(raw);}catch{throw new Error('invalid_upstream_response');}
      if(value?.error || value?.status==='failed') throw new Error('upstream_response_error');observe(value);
      const converted=cross?await translation.convert('response',raw):[raw];
      const output=Buffer.concat(converted);
      try {const value=JSON.parse(output);if(!value || typeof value!=='object' || value.error) throw new Error();} catch {throw new Error('invalid_translated_response');}
      res.writeHead(status,{'content-type':'application/json','access-control-allow-origin':'*'});
      first=performance.now();await write(output);finish(status);res.end();return;
    }
    res.writeHead(status,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','access-control-allow-origin':'*'});
    const decoder=new StringDecoder('utf8');let remainder='';
    const event=async block=>{
      let eventName='';const data=[];
      for(const line of block.split(/\r?\n/)){if(line.startsWith('event:'))eventName=line.slice(6).trim();if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));}
      if(!data.length) return;
      const raw=data.join('\n');if(Buffer.byteLength(raw)>MiB) throw new Error('stream_event_too_large');
      let value=null;if(raw!=='[DONE]'){try{value=JSON.parse(raw);}catch{throw new Error('invalid_upstream_stream');}}
      observe(value);
      const signal=streamSignal(eventName,value,raw);
      if(signal.failed) throw new Error('upstream_stream_error');
      if(signal.hasOutput || value?.candidates?.some(c=>c.content?.parts?.length)) first ||= performance.now();
      const parts=cross?await translation.convert('chunk',Buffer.from(`data: ${raw}`)):[Buffer.from(block+'\n\n')];
      if(parts.reduce((size,part)=>size+part.length,0)>8*MiB) throw new Error('translated_stream_limit');
      for(const part of parts) await write(part);
      terminal=signal.terminal || (target==='gemini' && value?.candidates?.some(c=>c.finishReason));
    };
    for await(const chunk of response) {
      remainder+=decoder.write(chunk);if(Buffer.byteLength(remainder)>8*MiB) throw new Error('stream_buffer_limit');
      let match;
      while((match=/\r?\n\r?\n/.exec(remainder))) {const block=remainder.slice(0,match.index);remainder=remainder.slice(match.index+match[0].length);await event(block);if(terminal) break;}
      if(terminal) break;
    }
    if(!terminal) {remainder+=decoder.end();if(remainder.trim()) await event(remainder);}
    if(!terminal) throw new Error('upstream_stream_truncated');
    finish(status);res.end();response.destroy();
  } catch(error) {
    const code=/^[a-z_]+$/.test(error.message)?error.message:'conversion_failed';
    sendError(/^(unsupported_|invalid_json)/.test(code)?400:code==='translator_busy'||code==='translator_queue_timeout'?503:502,code);
  } finally {upstream?.destroy();if(translation) {translation.session.controller.signal.removeEventListener('abort',workerAbort);await translation.close().catch(()=>{});}}
}
