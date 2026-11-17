/** One limiter per Wiki service, shared by text, vision, tests and retries. */
export class ModelScheduler {
  private active=0;
  private readonly queue:Array<{signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(reason:unknown)=>void;abort:()=>void}>=[];
  constructor(readonly limit:number){modelInteger(limit,1,1,16);}
  run<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
    const perform=(release:()=>void)=>{try{signal.throwIfAborted();return work().finally(release);}catch(error){release();return Promise.reject(error);}};
    if(signal.aborted)return Promise.reject(signal.reason);
    // Start an available slot immediately; only queued calls cross a microtask.
    if(this.active<this.limit&&!this.queue.length){this.active++;return perform(()=>{this.active--;this.pump();});}
    return this.acquire(signal).then(perform);
  }
  private acquire(signal:AbortSignal):Promise<()=>void>{
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const item={signal,resolve,reject,abort:()=>{const i=this.queue.indexOf(item);if(i>=0)this.queue.splice(i,1);signal.removeEventListener('abort',item.abort);reject(signal.reason);}};
      signal.addEventListener('abort',item.abort,{once:true});this.queue.push(item);this.pump();
    });
  }
  private pump(){
    while(this.active<this.limit&&this.queue.length){
      const item=this.queue.shift()!;item.signal.removeEventListener('abort',item.abort);
      if(item.signal.aborted){item.reject(item.signal.reason);continue;}
      this.active++;let released=false;item.resolve(()=>{if(released)return;released=true;this.active--;this.pump();});
    }
  }
}
export function modelInteger(value:unknown,fallback:number,min:number,max:number):number{
  if(value===undefined)return fallback;
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error(`模型请求配置必须为 ${min}–${max} 的整数`);
  return value;
}
