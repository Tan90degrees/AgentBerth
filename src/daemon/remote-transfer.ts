import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SFTPWrapper } from 'ssh2';
import type { RemoteAction, RemoteTransfer, TransferEndpoint, TransferSpec } from '../shared/protocol';
import type { Store } from './store';

interface FileStat {size:number;mtime:number;mode:number;file:boolean;directory:boolean;symlink:boolean}
export interface TransferFs {
  join:(...parts:string[])=>string;
  dirname:(file:string)=>string;
  stat:(file:string)=>Promise<FileStat|null>;
  list:(file:string)=>Promise<string[]>;
  mkdir:(file:string,mode:number)=>Promise<void>;
  read:(file:string,start:number,end?:number)=>Readable;
  write:(file:string,flags:'wx'|'w'|'r+',start:number,mode:number)=>Writable;
  close:()=>void;
}
const missing=(error:unknown)=>(error as {code?:unknown})?.code==='ENOENT'||(error as {code?:unknown})?.code===2;
// Keep a bounded 1 MiB window in flight instead of paying one network round
// trip for every packet. 32 KiB requests also work with non-OpenSSH servers.
const WRITE_CHUNK=32*1024,WRITE_CONCURRENCY=32,WRITE_WINDOW=WRITE_CHUNK*WRITE_CONCURRENCY;
export const localTransferFs=():TransferFs=>({
  join:path.join,
  dirname:path.dirname,
  stat:async file=>{try{const s=await lstat(file);return {size:s.size,mtime:s.mtimeMs,mode:s.mode,file:s.isFile(),directory:s.isDirectory(),symlink:s.isSymbolicLink()};}catch(error){if(missing(error))return null;throw error;}},
  list:readdir,
  mkdir:async(file,mode)=>{await mkdir(file,{mode});},
  read:(file,start,end)=>createReadStream(file,{start,end,highWaterMark:WRITE_WINDOW}),
  write:(file,flags,start,mode)=>createWriteStream(file,{flags,start,mode,highWaterMark:256*1024}),
  close:()=>{},
});
export function sftpTransferFs(sftp:SFTPWrapper):TransferFs {
  let alive=true;sftp.on('close',()=>{alive=false;});sftp.on('end',()=>{alive=false;});
  const closeHandle=(handle:Buffer|null)=>{if(handle&&alive)try{sftp.close(handle,()=>{});}catch{}};
  return {
    join:path.posix.join,dirname:path.posix.dirname,
    stat:file=>new Promise((resolve,reject)=>sftp.lstat(file,(error,s)=>{if(error){if(missing(error))resolve(null);else reject(error);}else resolve({size:s.size,mtime:s.mtime,mode:s.mode,file:s.isFile(),directory:s.isDirectory(),symlink:s.isSymbolicLink()});})),
    list:file=>new Promise((resolve,reject)=>sftp.readdir(file,(error,entries)=>error?reject(error):resolve(entries.map(entry=>entry.filename)))),
    mkdir:(file,mode)=>new Promise((resolve,reject)=>sftp.mkdir(file,{mode},error=>error?reject(error):resolve())),
    read:(file,start,end)=>{
      let handle:Buffer|null=null,position=start;
      return new Readable({highWaterMark:256*1024,
        construct(callback){
          if(!alive){callback(new Error('SFTP 通道已关闭'));return;}
          sftp.open(file,'r',(error,value)=>{handle=value??null;callback(error);});
        },
        read(size){
          if(!alive||!handle){this.destroy(new Error('SFTP 通道已关闭'));return;}
          const length=Math.min(size,64*1024,end===undefined?Infinity:end-position+1);
          if(length<=0){this.push(null);return;}
          const buffer=Buffer.alloc(length);
          sftp.read(handle,buffer,0,length,position,(error,bytes)=>{if(this.destroyed)return;if(error){this.destroy(error);return;}if(!bytes){this.push(null);return;}position+=bytes;this.push(buffer.subarray(0,bytes));});
        },
        destroy(error,callback){closeHandle(handle);handle=null;callback(error);},
      });
    },
    write:(file,flags,start,mode)=>{
      let handle:Buffer|null=null,position=start;
      return new Writable({highWaterMark:WRITE_WINDOW,
        construct(callback){
          if(!alive){callback(new Error('SFTP 通道已关闭'));return;}
          sftp.open(file,flags,{mode},(error,value)=>{handle=value??null;callback(error);});
        },
        write(chunk,_encoding,callback){
          if(!alive||!handle){callback(new Error('SFTP 通道已关闭'));return;}
          let offset=0,pending=0,settled=false,pumping=false;
          const stream=this,opened=handle;
          const fail=(error:Error)=>{if(settled||stream.destroyed)return;settled=true;callback(error);};
          const pump=()=>{
            if(pumping||settled||stream.destroyed)return;
            pumping=true;
            try {
              while(offset<chunk.length&&pending<WRITE_CONCURRENCY&&!settled&&!stream.destroyed){
                if(!alive){fail(new Error('SFTP 通道已关闭'));break;}
                const start=offset,length=Math.min(WRITE_CHUNK,chunk.length-start);
                offset+=length;pending++;
                sftp.write(opened,chunk,start,length,position+start,error=>{
                  pending--;
                  if(error)fail(error);else pump();
                });
              }
            }catch(error){fail(error instanceof Error?error:new Error(String(error)));}
            finally{pumping=false;}
            if(!settled&&!stream.destroyed&&offset===chunk.length&&!pending){settled=true;position+=chunk.length;callback();}
          };
          // Do not acknowledge the stream chunk until every offset is confirmed;
          // final/close, progress completion and resume must never race writes.
          pump();
        },
        final(callback){if(!handle||!alive){callback(new Error('SFTP 通道已关闭'));return;}const value=handle;handle=null;sftp.close(value,callback);},
        // Never await an acknowledgement from a closed/unresponsive channel
        // while destroying a stream. Channel close releases remote handles.
        destroy(error,callback){closeHandle(handle);handle=null;callback(error);},
      });
    },
    close:()=>{if(alive){alive=false;sftp.end();}},
  };
}

/** Local and SFTP streams share one bounded copy path. No remote command,
 * archive utility, runtime, credential forwarding or in-memory file payload. */
export async function copyTransfer(spec:TransferSpec,source:TransferFs,destination:TransferFs,signal:AbortSignal,progress:(bytes:number,totalBytes:number,files:number,totalFiles:number)=>void):Promise<void> {
  const plan:{source:string;destination:string;stat:FileStat}[]=[],directories:{file:string;mode:number}[]=[];
  let entries=0,totalBytes=0,bytes=0,files=0;
  const walk=async(from:string,to:string,depth:number):Promise<void>=>{
    signal.throwIfAborted();
    if(++entries>10000||depth>64)throw new Error('目录传输超过 10000 个条目或 64 层，请分批传输');
    const stat=await source.stat(from);
    if(!stat)throw new Error('源文件不存在');
    if(stat.symlink)throw new Error('不自动跟随符号链接，请指定实际源路径');
    if(stat.directory){
      if(!spec.recursive)throw new Error('目录传输请指定 recursive=true');
      directories.push({file:to,mode:stat.mode&0o777});
      for(const name of await source.list(from)){
        if(name==='.'||name==='..')continue;
        if(!name||/[\\/\x00]/.test(name)||name.includes(':')||/[. ]$/.test(name)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new Error('目录包含无法安全映射到目标平台的文件名');
        await walk(source.join(from,name),destination.join(to,name),depth+1);
      }
    }else if(stat.file){
      if(!Number.isSafeInteger(stat.size)||stat.size<0)throw new Error('无法识别源文件大小');
      plan.push({source:from,destination:to,stat});totalBytes+=stat.size;
      if(!Number.isSafeInteger(totalBytes))throw new Error('传输总大小超过安全统计范围');
    }else throw new Error('仅支持普通文件和目录');
  };
  await walk(spec.source.path,spec.destination.path,0);progress(0,totalBytes,0,plan.length);
  const ensureDirectory=async(file:string,mode=0o755,depth=0):Promise<void>=>{
    signal.throwIfAborted();if(depth>64)throw new Error('目标目录层级过深');
    const existing=await destination.stat(file);
    if(existing){if(!existing.directory||existing.symlink)throw new Error('目标目录不是普通目录');return;}
    const parent=destination.dirname(file);if(parent===file)throw new Error('目标根目录不存在');
    await ensureDirectory(parent,0o755,depth+1);
    try{await destination.mkdir(file,mode);}catch(error){const current=await destination.stat(file);if(!current?.directory||current.symlink)throw error;}
  };
  for(const directory of directories){
    await ensureDirectory(directory.file,directory.mode);
  }
  const digest=async(fs:TransferFs,file:string,length:number)=>{
    const hash=createHash('sha256');
    if(length)await pipeline(fs.read(file,0,length-1),new Writable({write(chunk,_encoding,callback){hash.update(chunk);callback();}}),{signal});
    return hash.digest('hex');
  };
  for(const file of plan){
    await ensureDirectory(destination.dirname(file.destination));
    signal.throwIfAborted();const target=await destination.stat(file.destination);
    if(target&&(target.symlink||!target.file))throw new Error('目标路径不是普通文件');
    let offset=0;
    if(target){
      if(spec.resume){
        if(target.size>file.stat.size)throw new Error('目标文件比源文件大，不能续传');
        const [a,b]=await Promise.all([digest(source,file.source,target.size),digest(destination,file.destination,target.size)]);
        if(a!==b)throw new Error('已有文件内容与源文件前缀不同，拒绝续传');
        const current=await destination.stat(file.destination);
        if(!current||current.size!==target.size||current.mtime!==target.mtime)throw new Error('目标文件在续传核对期间变化，请重新确认');
        offset=target.size;
      }else if(!spec.overwrite)throw new Error('目标文件已存在；确认后指定 overwrite=true，或对已知中断传输使用 resume=true');
    }
    bytes+=offset;progress(bytes,totalBytes,files,plan.length);
    if(!target||offset<file.stat.size||!spec.resume){
      let copied=0;
      const meter=new Transform({transform(chunk,_encoding,callback){copied+=chunk.length;bytes+=chunk.length;progress(bytes,totalBytes,files,plan.length);callback(null,chunk);}});
      // Exclusive creation by default; overwrite/resume always require an
      // explicit option. A failed copy leaves a visible partial file for resume.
      const input=file.stat.size?source.read(file.source,offset,file.stat.size-1):Readable.from([]);input.on('error',()=>{});
      let output:Writable|undefined;
      try{output=destination.write(file.destination,target?(spec.resume?'r+':'w'):'wx',offset,file.stat.mode&0o777);await pipeline(input,meter,output,{signal});}
      catch(error){input.destroy();output?.destroy();throw error;}
      if(copied!==file.stat.size-offset)throw new Error('源文件在传输期间变更或提前结束；请核实部分文件');
    }
    const after=await source.stat(file.source);
    if(!after||after.size!==file.stat.size||after.mtime!==file.stat.mtime)throw new Error('源文件在传输期间发生变化，结果未确认');
    files++;progress(bytes,totalBytes,files,plan.length);
  }
}

interface ActiveTransfer {value:RemoteTransfer;abort:AbortController;done:Promise<void>}
export class RemoteTransfers {
  private active=new Map<string,ActiveTransfer>();
  constructor(private store:Pick<Store,'remoteAction'|'saveRemoteAction'|'remoteTransfers'>,private endpoint:(endpoint:TransferEndpoint)=>Promise<TransferFs>,private publish:(value:RemoteTransfer)=>void,private action:(value:RemoteAction)=>void,private scope:(endpoint:TransferEndpoint)=>string=endpoint=>endpoint.kind==='local'?'local':endpoint.sessionId) {}
  get(id:string):RemoteTransfer {
    const live=this.active.get(id);if(live)return structuredClone(live.value);
    const action=this.store.remoteAction(id);if(!action?.transfer)throw new Error('传输任务不存在');
    return {...action.transfer,status:action.status==='unknown'?'unknown':action.transfer.status};
  }
  list(sessionId:string):RemoteTransfer[] {
    const values=new Map(this.store.remoteTransfers(sessionId).map(value=>[value.id,value]));
    for(const active of this.active.values())if(this.belongs(active.value,sessionId))values.set(active.value.id,structuredClone(active.value));
    return [...values.values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,20);
  }
  start(spec:TransferSpec):RemoteTransfer {
    const existing=this.store.remoteAction(spec.requestId);
    if(existing){if(!existing.transfer||JSON.stringify(existing.transfer.spec)!==JSON.stringify(spec))throw new Error('requestId 已用于另一个操作');return this.get(spec.requestId);}
    const overlaps=(a:TransferEndpoint,b:TransferEndpoint)=>{
      const normalize=(endpoint:TransferEndpoint)=>endpoint.kind==='remote'?path.posix.normalize(endpoint.path):path.resolve(endpoint.path).replaceAll('\\','/');
      let aPath=normalize(a),bPath=normalize(b);if(process.platform==='win32'&&a.kind==='local'){aPath=aPath.toLowerCase();bPath=bPath.toLowerCase();}
      return this.scope(a)===this.scope(b)&&(aPath===bPath||aPath.startsWith(bPath.replace(/\/$/,'')+'/')||bPath.startsWith(aPath.replace(/\/$/,'')+'/'));
    };
    for(const item of this.active.values())if(overlaps(spec.destination,item.value.spec.destination)||overlaps(spec.source,item.value.spec.destination)||overlaps(spec.destination,item.value.spec.source))throw new Error('路径正被其他传输占用，请等待完成后再试');
    if(this.active.size>=4)throw new Error('已有 4 个传输正在运行，请等待或取消后再试');
    const remote=spec.source.kind==='remote'?spec.source:spec.destination.kind==='remote'?spec.destination:null;
    if(!remote)throw new Error('至少一端必须是 SSH 服务器');
    for(const endpoint of [spec.source,spec.destination])if(endpoint.kind==='local'&&!path.isAbsolute(endpoint.path))throw new Error('本机文件请使用绝对路径');
    if(spec.source.kind===spec.destination.kind&&spec.source.path===spec.destination.path&&spec.source.kind==='remote'&&spec.destination.kind==='remote'&&spec.source.sessionId===spec.destination.sessionId)throw new Error('源路径和目标路径相同');
    const value:RemoteTransfer={id:spec.requestId,spec,sessionId:remote.sessionId,runId:remote.runId,status:'running',bytes:0,totalBytes:0,files:0,totalFiles:0,startedAt:new Date().toISOString(),endedAt:null,error:null};
    const abort=new AbortController(),active:ActiveTransfer={value,abort,done:Promise.resolve()};this.active.set(value.id,active);
    this.save(value);this.publish({...value});active.done=this.run(active);return structuredClone(value);
  }
  private async run(active:ActiveTransfer):Promise<void> {
    const {value,abort}=active;const opened:TransferFs[]=[];let emitted=0;
    const notify=(bytes:number,totalBytes:number,files:number,totalFiles:number)=>{
      Object.assign(value,{bytes,totalBytes,files,totalFiles});
      if(Date.now()-emitted>=100){emitted=Date.now();this.publish(structuredClone(value));}
    };
    const timeout=setTimeout(()=>abort.abort(new Error('传输超过 24 小时，请核实部分文件后显式续传')),24*60*60*1000);timeout.unref();
    try {
      const source=await this.endpoint(value.spec.source);opened.push(source);abort.signal.throwIfAborted();
      const destination=await this.endpoint(value.spec.destination);opened.push(destination);abort.signal.throwIfAborted();
      const end=()=>{for(const endpoint of opened)endpoint.close();};abort.signal.addEventListener('abort',end,{once:true});
      try {await copyTransfer(value.spec,source,destination,abort.signal,notify);}finally{abort.signal.removeEventListener('abort',end);}
      value.status='completed';
    }catch(error){value.status=abort.signal.aborted?'cancelled':value.bytes?'unknown':'failed';value.error=(error instanceof Error?error.message:String(error)).replace(/[\x00-\x1f]/g,' ').slice(0,500);}
    finally{
      clearTimeout(timeout);for(const endpoint of opened)endpoint.close();value.endedAt=new Date().toISOString();
      this.save(value);this.publish(structuredClone(value));this.active.delete(value.id);
    }
  }
  private save(value:RemoteTransfer):void {
    this.action(this.store.saveRemoteAction({id:value.id,sessionId:value.sessionId,runId:value.runId,kind:'transfer',label:`文件传输 ${path.posix.basename(value.spec.source.path).slice(0,100)} → ${path.posix.basename(value.spec.destination.path).slice(0,100)}`,status:value.status==='running'?'running':value.status==='unknown'?'unknown':'completed',startedAt:value.startedAt,endedAt:value.endedAt,exitCode:value.status==='running'||value.status==='unknown'?null:value.status==='completed'?0:1,transfer:structuredClone(value)}));
  }
  async wait(id:string,timeoutMs:number,signal?:AbortSignal):Promise<RemoteTransfer> {
    const active=this.active.get(id);if(!active||!timeoutMs||signal?.aborted)return this.get(id);
    let timer:ReturnType<typeof setTimeout>|undefined,stop:()=>void=()=>{};
    try{await Promise.race([active.done,new Promise<void>(resolve=>{timer=setTimeout(resolve,timeoutMs);stop=()=>resolve();signal?.addEventListener('abort',stop,{once:true});})]);}
    finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',stop);}
    return this.get(id);
  }
  async cancel(id:string):Promise<RemoteTransfer> {const active=this.active.get(id);if(active){active.abort.abort();await active.done;}return this.get(id);}
  private belongs(value:RemoteTransfer,sessionId:string):boolean {return [value.spec.source,value.spec.destination].some(endpoint=>endpoint.kind==='remote'&&endpoint.sessionId===sessionId);}
  async stopSession(sessionId:string):Promise<void> {await Promise.all([...this.active.values()].filter(item=>this.belongs(item.value,sessionId)).map(item=>this.cancel(item.value.id)));}
  async close():Promise<void> {await Promise.all([...this.active.keys()].map(id=>this.cancel(id)));}
}
