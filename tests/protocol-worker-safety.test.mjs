import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {ProtocolWorker} from '../gateway/protocol-worker.mjs';
const fake=()=>new ProtocolWorker({file:process.execPath,args:[fileURLToPath(new URL('./fixtures/fault-worker.mjs',import.meta.url))],verify:false});
test('worker pool enforces active, queued, byte budgets and cleans queued cancellation',async()=>{
 const worker=fake();const active=[];
 for(let i=0;i<8;i++)active.push(await worker.acquire(10));
 const queued=Array.from({length:16},()=>worker.acquire(10));const settled=Promise.allSettled(queued);
 await assert.rejects(worker.acquire(10),/translator_busy/);assert.equal(worker.sessions.size,8);
 worker.stop();const outcomes=await settled;assert.ok(outcomes.every(result=>result.status==='rejected'));
 for(const session of active)worker.release(session);
 assert.equal(worker.bytes,0);assert.equal(worker.sessions.size,0);
 const large=[];for(let i=0;i<2;i++)large.push(await worker.acquire(25*1024*1024));
 assert.ok(worker.bytes<=128*1024*1024);for(const session of large)worker.release(session);
 await assert.rejects(worker.acquire(25*1024*1024+1),/request_too_large/);
});
for(const failure of ['crash','malformed','base64'])test(`worker ${failure} rejects pending RPCs, marks active sessions failed and restarts cleanly`,async()=>{
 const worker=fake();let a,b;
 try {
  a=await worker.request('chat','messages','a',Buffer.from('{}'),true);
  b=await worker.request('chat','messages','b',Buffer.from('{}'),true);
  await assert.rejects(a.convert('chunk',Buffer.from(failure)),/translator_exited|invalid_worker_reply/);
  assert.equal(b.session.controller.signal.aborted,true);
  await assert.rejects(b.convert('chunk',Buffer.from('anything')),/translator_exited|invalid_worker_reply/);
  await a.close();await b.close();assert.equal(worker.bytes,0);
  const fresh=await worker.request('chat','messages','fresh',Buffer.from('{}'),false);await fresh.close();
 } finally {await a?.close();await b?.close();worker.stop();}
});
test('worker integrity failure is closed before child process launch',async()=>{
 const worker=new ProtocolWorker({file:fileURLToPath(new URL('./fixtures/fault-worker.mjs',import.meta.url))});
 await assert.rejects(worker.start());assert.equal(worker.process,null);worker.stop();
});
test('queued requests can be cancelled before any worker operation',async()=>{
 const worker=fake(),active=[];
 for(let i=0;i<8;i++)active.push(await worker.acquire(1));
 const controller=new AbortController();const queued=worker.acquire(1,controller.signal);controller.abort();
 await assert.rejects(queued,/client_disconnected/);assert.equal(worker.queue.length,0);
 for(const session of active)worker.release(session);worker.stop();assert.equal(worker.bytes,0);
});
test('five-second queue expiry and total session timeout release resources',async t=>{
 const worker=fake(),active=[];
 for(let i=0;i<8;i++)active.push(await worker.acquire(1));
 t.mock.timers.enable({apis:['setTimeout']});
 const queued=worker.acquire(1);const assertion=assert.rejects(queued,/translator_queue_timeout/);
 t.mock.timers.tick(5001);await assertion;t.mock.timers.reset();
 for(const session of active)worker.release(session);
 const request=await worker.request('chat','messages','timeout',Buffer.from('{}'),true);
 request.session.started=Date.now()-16*60*1000;
 await assert.rejects(request.convert('chunk',Buffer.from('anything')),/translator_total_timeout/);
 await request.close();assert.equal(worker.bytes,0);worker.stop();
});
test('real Go contract rejects duplicate IDs and invalid Base64 without corrupting an active session',async()=>{
 const worker=new ProtocolWorker();let session;
 try {
  session=await worker.request('chat','messages','gpt-test',Buffer.from('{"model":"gpt-test","messages":[{"role":"user","content":"hello"}]}'),true);
  await assert.rejects(worker.rpc(session.session.id,'request',{from:'chat',to:'messages',payload:Buffer.from('{}').toString('base64')}),/duplicate_request_id/);
  await assert.rejects(worker.rpc(session.session.id,'chunk',{payload:'not base64!'}),/invalid_worker_payload/);
  assert.equal(worker.sessions.size,1);
  await assert.rejects(worker.rpc(session.session.id,'not-an-operation'),/invalid_worker_operation/);
 }finally{await session?.close();worker.stop();}
});
