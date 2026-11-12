import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolWorker} from '../gateway/protocol-worker.mjs';
import {requests, responses, streams} from './protocol-fixtures.mjs';
const worker=new ProtocolWorker();after(()=>worker.stop());
const histories={
 chat:{...requests.chat,messages:[...requests.chat.messages,{role:'assistant',content:'Check both',tool_calls:[{id:'call_paris',type:'function',function:{name:'weather',arguments:'{"city":"Paris"}'}},{id:'call_rome',type:'function',function:{name:'weather',arguments:'{"city":"Rome"}'}}]},{role:'tool',tool_call_id:'call_paris',content:'PARIS_RESULT_21'},{role:'tool',tool_call_id:'call_rome',content:'ROME_RESULT_28'},{role:'user',content:'Compare both'}]},
 responses:{...requests.responses,input:[...requests.responses.input,{type:'function_call',call_id:'call_paris',name:'weather',arguments:'{"city":"Paris"}'},{type:'function_call',call_id:'call_rome',name:'weather',arguments:'{"city":"Rome"}'},{type:'function_call_output',call_id:'call_paris',output:'PARIS_RESULT_21'},{type:'function_call_output',call_id:'call_rome',output:'ROME_RESULT_28'},{role:'user',content:[{type:'input_text',text:'Compare both'}]}]},
 messages:{...requests.messages,messages:[...requests.messages.messages,{role:'assistant',content:[{type:'tool_use',id:'call_paris',name:'weather',input:{city:'Paris'}},{type:'tool_use',id:'call_rome',name:'weather',input:{city:'Rome'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call_paris',content:'PARIS_RESULT_21'},{type:'tool_result',tool_use_id:'call_rome',content:'ROME_RESULT_28'}]},{role:'user',content:'Compare both'}]},
 gemini:{...requests.gemini,contents:[...requests.gemini.contents,{role:'model',parts:[{functionCall:{id:'call_paris',name:'weather',args:{city:'Paris'}}},{functionCall:{id:'call_rome',name:'weather',args:{city:'Rome'}}}]},{role:'user',parts:[{functionResponse:{id:'call_paris',name:'weather',response:{result:'PARIS_RESULT_21'}}},{functionResponse:{id:'call_rome',name:'weather',response:{result:'ROME_RESULT_28'}}}]},{role:'user',parts:[{text:'Compare both'}]}]},
};
for(const from of Object.keys(histories))for(const to of Object.keys(histories))if(from!==to)test(`${from} -> ${to}: parallel tool history and results`,async()=>{
 const request=await worker.request(from,to,'test-model',Buffer.from(JSON.stringify(histories[from])),false);
 try {
  const body=JSON.parse(request.body);const text=JSON.stringify(body);
  for(const expected of ['Paris','Rome','PARIS_RESULT_21','ROME_RESULT_28','Compare both','Be concise'])assert.ok(text.includes(expected),`${from}->${to} lost ${expected}: ${text}`);
  // Check a follow-up response too: history conversion must not corrupt the inverse state.
  const reply=JSON.parse(Buffer.concat(await request.convert('response',Buffer.from(JSON.stringify(responses[to])))));
  assert.match(JSON.stringify(reply),/weather/);
 } finally {await request.close();}
});
test('concurrent stream state stays isolated between client IDs',async()=>{
 const sessions=await Promise.all(Array.from({length:8},(_,index)=>worker.request('messages','chat',`model-${index}`,Buffer.from(JSON.stringify({...requests.messages,model:`model-${index}`})),true)));
 try {
  const outputs=await Promise.all(sessions.map(async(session,index)=>{
   const chunks=[];
   for(const event of streams.chat){const text=typeof event==='string'?event:JSON.stringify(event).replaceAll('Paris',`CITY_${index}`).replaceAll('Checking',`TEXT_${index}`);chunks.push(...await session.convert('chunk',Buffer.from(`data: ${text}`)));}
   return Buffer.concat(chunks).toString();
  }));
  outputs.forEach((value,index)=>{assert.ok(value.includes(`CITY_${index}`));for(let other=0;other<8;other++)if(other!==index)assert.ok(!value.includes(`CITY_${other}`));});
 }finally{await Promise.all(sessions.map(session=>session.close()));}
});
for(const from of Object.keys(histories))for(const to of Object.keys(histories))if(from!==to)test(`${from} -> ${to}: token-limit finish reason is not reported as success stop`,async()=>{
 const reply=structuredClone(responses[to]);
 if(to==='chat') reply.choices[0].finish_reason='length';
 if(to==='responses'){reply.status='incomplete';reply.incomplete_details={reason:'max_output_tokens'};}
 if(to==='messages')reply.stop_reason='max_tokens';
 if(to==='gemini')reply.candidates[0].finishReason='MAX_TOKENS';
 const session=await worker.request(from,to,'test-model',Buffer.from(JSON.stringify(requests[from])),false);
 try {
  const value=JSON.parse(Buffer.concat(await session.convert('response',Buffer.from(JSON.stringify(reply)))));
  const reason=from==='chat'?value.choices[0].finish_reason:from==='responses'?value.status:from==='messages'?value.stop_reason:value.candidates[0].finishReason;
  assert.equal(reason,{chat:'length',responses:'incomplete',messages:'max_tokens',gemini:'MAX_TOKENS'}[from],JSON.stringify(value));
 }finally{await session.close();}
});
for(const from of Object.keys(histories))for(const to of Object.keys(histories))if(from!==to)test(`${from} -> ${to}: streaming token-limit reason survives`,async()=>{
 const events=structuredClone(streams[to]);
 for(const event of events){if(typeof event==='string')continue;
  if(to==='chat' && event.choices[0]?.finish_reason)event.choices[0].finish_reason='length';
  if(to==='responses' && event.type==='response.completed'){event.type='response.incomplete';event.response.status='incomplete';event.response.incomplete_details={reason:'max_output_tokens'};}
  if(to==='messages' && event.type==='message_delta')event.delta.stop_reason='max_tokens';
  if(to==='gemini' && event.candidates[0]?.finishReason)event.candidates[0].finishReason='MAX_TOKENS';
 }
 const session=await worker.request(from,to,'test-model',Buffer.from(JSON.stringify({...requests[from],stream:true})),true);
 try {
  const chunks=[];for(const event of events)chunks.push(...await session.convert('chunk',Buffer.from(`data: ${typeof event==='string'?event:JSON.stringify(event)}`)));
  const text=Buffer.concat(chunks).toString();const expected={chat:'length',responses:'max_output_tokens',messages:'max_tokens',gemini:'MAX_TOKENS'}[from];
  assert.ok(text.includes(expected),`${from}->${to}: ${text}`);
 }finally{await session.close();}
});
