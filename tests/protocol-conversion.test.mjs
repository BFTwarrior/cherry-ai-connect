import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolWorker } from '../gateway/protocol-worker.mjs';
import { sourceProtocol, conversionTarget, unsupportedFeature, upstreamHeaders } from '../gateway/conversion-proxy.mjs';
const worker=new ProtocolWorker();after(()=>worker.stop());
import {requests,responses,streams} from './protocol-fixtures.mjs';
for(const from of Object.keys(requests)) for(const to of Object.keys(requests)) if(from!==to) test(`${from} -> ${to}: native request and non-stream tool response`,async()=>{
 const session=await worker.request(from,to,'test-model',Buffer.from(JSON.stringify(requests[from])),false);
 try {
  const body=JSON.parse(session.body);assert.ok(JSON.stringify(body).includes('Weather?'));assert.ok(JSON.stringify(body).includes('weather'));
  const result=Buffer.concat(await session.convert('response',Buffer.from(JSON.stringify(responses[to]))));
  const output=JSON.parse(result);const text=JSON.stringify(output);
  assert.ok(text.includes('Checking'),text);assert.ok(text.includes('weather'),text);assert.ok(text.includes('Paris'),text);
 } finally {await session.close();}
});
test('protocol URL and auth mapping has no client credentials or model-path injection',()=>{
 assert.equal(sourceProtocol('/v1beta/models/vendor%2Fgemini:streamGenerateContent?key=secret').model,'vendor/gemini');
 const url=conversionTarget('https://relay.invalid/prefix/v1?key=secret','gemini','vendor/gemini?a#b',true);
 assert.equal(url.pathname,'/prefix/v1beta/models/vendor%2Fgemini%3Fa%23b:streamGenerateContent');
 assert.equal(url.search,'?alt=sse');
 const headers=upstreamHeaders('gemini','upstream',10,true);assert.equal(headers['x-goog-api-key'],'upstream');assert.equal(headers.authorization,undefined);
 assert.equal(unsupportedFeature({previous_response_id:'resp_old'}),'previous_response_id');
 assert.equal(unsupportedFeature({tools:[{type:'web_search'}]}),'tools[0].type');
});
for(const from of Object.keys(requests)) for(const to of Object.keys(requests)) if(from!==to) test(`${from} -> ${to}: streaming tool name and argument chunks survive`,async()=>{
 const session=await worker.request(from,to,'test-model',Buffer.from(JSON.stringify({...requests[from],stream:true})),true);
 try {
  const chunks=[];
  for(const event of streams[to]) chunks.push(...await session.convert('chunk',Buffer.from(`data: ${typeof event==='string'?event:JSON.stringify(event)}`)));
  const text=Buffer.concat(chunks).toString('utf8');
  assert.ok(text.includes('Checking'),text);assert.ok(text.includes('weather'),text);assert.ok(text.includes('Paris'),text);
 } finally {await session.close();}
});
