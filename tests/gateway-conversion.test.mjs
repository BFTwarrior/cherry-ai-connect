import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {protocolWorker} from '../gateway/protocol-worker.mjs';
import {requests,responses,streams} from './protocol-fixtures.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('real gateway: four native and twelve cross-protocol paths, streaming, auth, failure and exactly-once usage',async t=>{
 const root=path.resolve('.test-runtime');fs.mkdirSync(root,{recursive:true});const directory=fs.mkdtempSync(path.join(root,'conversion-'));
 let received=[],behavior='ok',upstreamClosed=false;
 let workerRequests=0;
 const originalWorkerRequest=protocolWorker.request;
 protocolWorker.request=function(...args){workerRequests++;return originalWorkerRequest.apply(this,args);};
 t.after(()=>{protocolWorker.request=originalWorkerRequest;});
 const upstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  received.push({url:req.url,headers:req.headers,body});
  if(req.method==='GET') {res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'gpt-5'},{id:'claude-4'},{id:'deepseek-chat'}]}));}
  const format=req.url.includes(':generateContent')||req.url.includes(':streamGenerateContent')?'gemini':req.url.includes('/chat/completions')?'chat':req.url.includes('/responses')?'responses':'messages';
  if(behavior==='error') {res.writeHead(429,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'DO_NOT_LEAK_UPSTREAM_SECRET'}}));}
  if(behavior==='disconnect') {req.socket.destroy();return;}
  if(behavior==='hold') {
   upstreamClosed=false;res.writeHead(200,{'content-type':'text/event-stream'});
   res.write(`data: ${JSON.stringify(streams[format][0])}\n\n`);
   res.once('close',()=>{upstreamClosed=true;});return;
  }
  if(body.stream || req.url.includes(':streamGenerateContent')) {
   res.writeHead(200,{'content-type':'text/event-stream'});
   const events=behavior==='truncated'?streams[format].slice(0,1):streams[format];
   for(const event of events) {
    const frame=Buffer.from(`event: ${typeof event==='string'?'done':event.type||'message'}\r\ndata: ${typeof event==='string'?event:JSON.stringify(event)}\r\n\r\n`);
    // Deliberately split SSE fields and UTF-8 byte sequences across writes.
    for(let offset=0;offset<frame.length;offset+=7) res.write(frame.subarray(offset,offset+7));
   }
   return res.end();
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify(responses[format]));
 });
 const port=await listen(upstream);
 process.env.GATEWAY_DATA_DIR=directory;process.env.GATEWAY_EMBEDDED='1';process.env.GATEWAY_PORT='0';process.env.CODEX_USAGE_ORIGIN='http://127.0.0.1:1';
 const gateway=await import(`../gateway/gateway.mjs?conversion=${Date.now()}`);await gateway.startGateway({port:0});const origin=`http://127.0.0.1:${gateway.server.address().port}`;
 const api=async(url,body)=>{const result=await fetch(origin+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await result.json();assert.equal(result.status,200,JSON.stringify(value));return value;};
 const endpoint=(format,stream)=>format==='gemini'?`/v1beta/models/test-model:${stream?'streamGenerateContent':'generateContent'}?key=CLIENT_QUERY_SECRET`:{chat:'/v1/chat/completions',responses:'/v1/responses',messages:'/v1/messages'}[format];
 const totals=async()=>{const snapshot=await api('/admin/api/usage?source=relay');return snapshot.lifetime.requests;};
 try {
  await api('/admin/api/providers',{id:'multi',baseUrl:`http://127.0.0.1:${port}/base/v1`,apiKey:'UPSTREAM_ONLY'});
  const key=(await api('/admin/api/client-keys',{providerId:'multi',reasoningLevel:'unchanged'})).key;
  for(const source of Object.keys(requests))for(const target of Object.keys(requests))for(const stream of [false,true])await t.test(`${source} -> ${target}, stream=${stream}`,async()=>{
   await api('/admin/api/catalog',{kind:'route-protocol',providerId:'multi',value:target});received=[];const count=await totals(), workerBefore=workerRequests;
   const url=endpoint(source,stream).replace('CLIENT_QUERY_SECRET',encodeURIComponent(key));
   const response=await fetch(origin+url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`,'x-api-key':'CLIENT_OTHER_SECRET','x-goog-api-key':'CLIENT_OTHER_SECRET','anthropic-version':'2023-06-01','anthropic-beta':'native-feature-test','openai-beta':'native-feature-test'},body:JSON.stringify({...requests[source],stream})});
   const text=await response.text();assert.equal(response.status,200,text);assert.ok(text.includes('Checking'),text);assert.ok(text.includes('weather'),text);assert.ok(text.includes('中文🙂'),text);
   assert.equal(workerRequests-workerBefore,source===target?0:1);
   assert.equal(received.length,1);const call=received[0];
   assert.ok(!call.url.includes(key));assert.ok(!call.url.includes('key='));assert.ok(!JSON.stringify(call.headers).includes('CLIENT_OTHER_SECRET'));
   assert.equal(call.headers[target==='messages'?'x-api-key':target==='gemini'?'x-goog-api-key':'authorization'],target==='chat'||target==='responses'?'Bearer UPSTREAM_ONLY':'UPSTREAM_ONLY');
   assert.equal(call.headers['anthropic-beta'],source===target&&target==='messages'?'native-feature-test':undefined);
   assert.equal(call.headers['openai-beta'],source===target&&(target==='chat'||target==='responses')?'native-feature-test':undefined);
   assert.equal(await totals(),count+1);
   const record=(await api('/admin/api/usage?source=relay')).records[0];assert.equal(record.inputTokens,12);assert.equal(record.outputTokens,8);assert.equal(record.cacheReadTokens,4);assert.equal(record.totalTokens,20);
  });
  await api('/admin/api/catalog',{kind:'route-protocol',providerId:'multi',value:'passthrough'});
  for(const source of Object.keys(requests)) for(const stream of [false,true]) await t.test(`passthrough ${source}, stream=${stream}`,async()=>{
   received=[];const before=workerRequests,count=await totals();
   const response=await fetch(origin+endpoint(source,stream).replace('CLIENT_QUERY_SECRET',encodeURIComponent(key)),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({...requests[source],stream})});
   const text=await response.text();assert.equal(response.status,200,text);assert.ok(text.includes('weather'),text);
   assert.equal(workerRequests,before);assert.equal(received.length,1);assert.equal(await totals(),count+1);
   assert.ok(!received[0].url.includes('key='));
   assert.ok(!JSON.stringify(received[0].headers).includes(key));
   if(source==='gemini') assert.match(received[0].url,/^\/base\/v1beta\/models\/test-model:/);
  });
  await api('/admin/api/catalog',{kind:'route-protocol',providerId:'multi',value:'chat'});
  const call=async body=>fetch(origin+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({...requests.responses,...body})});
  await t.test('unsupported fields never reach upstream',async()=>{received=[];const r=await call({previous_response_id:'resp_private'});assert.equal(r.status,400);assert.match(await r.text(),/unsupported_protocol_feature/);assert.equal(received.length,0);});
  await t.test('upstream non-2xx remains failure and hides raw errors',async()=>{behavior='error';const before=await totals();const r=await call({});assert.equal(r.status,429);assert.ok(!(await r.text()).includes('DO_NOT_LEAK'));assert.equal(await totals(),before+1);});
  await t.test('truncated SSE is response.failed rather than successful completion',async()=>{behavior='truncated';const r=await call({stream:true});const text=await r.text();assert.match(text,/response.failed/);assert.match(text,/upstream_stream_truncated/);const usage=await api('/admin/api/usage?source=relay&status=error');assert.ok(usage.records.some(record=>record.status===502));});
  await t.test('client disconnect cancels upstream and records one 499 without replay',async()=>{
   behavior='hold';received=[];const before=await totals(),controller=new AbortController();
   const response=await fetch(origin+'/v1/responses',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({...requests.responses,stream:true})});
   const reader=response.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});
   for(let i=0;i<100 && !upstreamClosed;i++)await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(upstreamClosed,true);assert.equal(received.length,1);assert.equal(await totals(),before+1);
   const usage=await api('/admin/api/usage?source=relay');assert.equal(usage.records[0].status,499);
  });
 } finally {await gateway.stopGateway();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
});
