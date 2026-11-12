import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MiB = 1024 * 1024;
const VERSION = 'cherry-translator-1';
const defaultFile = process.resourcesPath ? path.join(process.resourcesPath, 'cherry-translator.exe') : fileURLToPath(new URL('../electron/assets/cherry-translator.exe', import.meta.url));
export class ProtocolWorker {
  constructor({file = defaultFile, verify = true, args = []} = {}) {
    this.file=file;this.args=args;this.verify=verify;this.process=null;this.pending=new Map();this.sessions=new Map();this.queue=[];this.bytes=0;this.restarts=[];this.sequence=0;this.starting=null;this.cooldownUntil=0;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.process) return;
    this.starting=this.#start().finally(() => {this.starting=null;});
    return this.starting;
  }
  async #start() {
    const now=Date.now();this.restarts=this.restarts.filter(t => now-t<60000);
    if(this.restarts.length>=3 || now<this.cooldownUntil) throw new Error('translator_cooling_down');
    if(this.verify) {
      const manifest=JSON.parse(fs.readFileSync(`${this.file}.json`,'utf8'));
      const hash=crypto.createHash('sha256').update(fs.readFileSync(this.file)).digest('hex');
      if(manifest.version!==VERSION || manifest.sha256!==hash) throw new Error('translator_integrity_failed');
    }
    this.restarts.push(now);
    const child=spawn(this.file,this.args,{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot || '',WINDIR:process.env.WINDIR || ''}});
    this.process=child;let buffer='';
    child.stdout.setEncoding('ascii');
    child.stdout.on('data',chunk => {
      if(this.process!==child) return;
      buffer+=chunk;
      if(buffer.length>36*MiB && !buffer.includes('\n')) return this.#fail('translator_output_limit');
      let index;
      while((index=buffer.indexOf('\n'))>=0) {
        if(index>36*MiB) return this.#fail('translator_output_limit');
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        try {
          const response=JSON.parse(line);
          const key=JSON.stringify([response.id,response.seq]);const pending=this.pending.get(key);
          if(response.v!==1 || !pending) throw new Error('invalid_worker_reply');
          if(response.payloads && (!Array.isArray(response.payloads) || response.payloads.some(p => typeof p!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p)))) throw new Error('invalid_worker_reply');
          this.pending.delete(key);clearTimeout(pending.timer);
          if(response.error) pending.reject(new Error(/^[a-z_]+$/.test(response.error) ? response.error : 'translation_failed'));
          else {
            pending.resolve(response);
          }
        } catch {return this.#fail('invalid_worker_reply');}
      }
    });
    child.on('error',() => this.#fail('translator_unavailable',child));
    child.on('exit',() => this.#fail('translator_exited',child));
    child.stdin.on('error',() => this.#fail('translator_unavailable',child));
    const hello=await this.rpc('hello','hello');
    if(hello.version!==VERSION) {this.#fail('translator_version_mismatch');throw new Error('translator_version_mismatch');}
  }
  #fail(code, expected=this.process) {
    if(expected!==this.process) return;
    const child=this.process;this.process=null;child?.kill();
    if(child && this.restarts.length>=3) this.cooldownUntil=Date.now()+30000;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(code));}this.pending.clear();
    for(const item of this.queue){clearTimeout(item.timer);item.reject(new Error(code));}this.queue=[];
    for(const session of this.sessions.values()) {session.failed=code;session.controller.abort(code);}
  }
  rpc(id,op,fields={}) {
    if(!this.process) return Promise.reject(new Error('translator_unavailable'));
    const seq=++this.sequence;const key=JSON.stringify([id,seq]);
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => {this.pending.delete(key);reject(new Error('translator_timeout'));this.#fail('translator_timeout');},120000);timer.unref?.();
      this.pending.set(key,{resolve,reject,timer});
      const line=JSON.stringify({v:1,id,seq,op,...fields})+'\n';
      if(line.length>36*MiB) {clearTimeout(timer);this.pending.delete(key);reject(new Error('translator_frame_limit'));return;}
      this.process.stdin.write(line,error => {if(error) this.#fail('translator_unavailable');});
    });
  }
  async acquire(size, signal) {
    if(signal?.aborted) throw new Error('client_disconnected');
    if(size>25*MiB) throw new Error('request_too_large');
    const reserved=size*2+8*MiB;
    if(this.sessions.size>=8 || this.bytes+reserved>128*MiB) {
      if(this.queue.length>=16 || this.queue.reduce((n,item) => n+item.size,0)+size>64*MiB) throw new Error('translator_busy');
      return new Promise((resolve,reject) => {
        const cleanup=()=>signal?.removeEventListener('abort',abort);
        const item={size,reserved,resolve:value=>{cleanup();resolve(value);},reject:error=>{cleanup();reject(error);},timer:null};
        const abort=()=>{clearTimeout(item.timer);this.queue=this.queue.filter(v=>v!==item);item.reject(new Error('client_disconnected'));};
        item.timer=setTimeout(()=>{this.queue=this.queue.filter(v=>v!==item);item.reject(new Error('translator_queue_timeout'));},5000);
        this.queue.push(item);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted) abort();
      });
    }
    return this.#grant(reserved);
  }
  #grant(reserved) {
    const id=crypto.randomUUID();const session={id,reserved,started:Date.now(),failed:'',controller:new AbortController()};this.sessions.set(id,session);this.bytes+=reserved;
    return session;
  }
  release(session) {
    if(!this.sessions.delete(session.id)) return;
    this.bytes-=session.reserved;
    const next=this.queue[0];
    if(next && this.sessions.size<8 && this.bytes+next.reserved<=128*MiB){this.queue.shift();clearTimeout(next.timer);next.resolve(this.#grant(next.reserved));}
  }
  async request(from,to,model,body,stream,signal) {
    const session=await this.acquire(body.length,signal);
    try {
      await this.start();
      if(signal?.aborted) throw new Error('client_disconnected');
      const response=await this.rpc(session.id,'request',{from,to,model,stream,payload:body.toString('base64')});
      if(response.payloads?.length!==1) throw new Error('invalid_worker_reply');
      const request=Buffer.from(response.payloads?.[0] || '', 'base64');
      const actual=body.length+request.length+8*MiB;
      if(signal?.aborted) throw new Error('client_disconnected');
      if(request.length>25*MiB || this.bytes-session.reserved+actual>128*MiB) {await this.rpc(session.id,'cancel');throw new Error('translator_memory_limit');}
      this.bytes+=actual-session.reserved;session.reserved=actual;
      return {body:request,session,convert:async(op,bytes) => {
        if(session.failed) throw new Error(session.failed);
        if(Date.now()-session.started>15*60*1000) throw new Error('translator_total_timeout');
        const r=await this.rpc(session.id,op,{payload:bytes.toString('base64')});
        return (r.payloads || []).map(p=>Buffer.from(p,'base64'));
      },close:async() => {try {if(this.process && !session.failed) await this.rpc(session.id,'cancel');} finally {this.release(session);}}};
    } catch(error) {try {if(this.process && !session.failed) await this.rpc(session.id,'cancel');} finally {this.release(session);}throw error;}
  }
  stop(){this.#fail('translator_stopped');}
}
export const protocolWorker=new ProtocolWorker();
