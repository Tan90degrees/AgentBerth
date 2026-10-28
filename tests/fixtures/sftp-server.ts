import { lstat, readdir, open, mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { utils, type SFTPWrapper } from 'ssh2';

export interface WriteProbe {active:number;peak:number;packets:number;bytes:number;delayMs:number}
export function serveSftp(sftp:SFTPWrapper,root:string,holdWrite:()=>boolean=()=>false,probe?:WriteProbe):void {
  let next=0;const handles=new Map<string,FileHandle|string[]>();
  const file=(name:string)=>{const value=path.resolve(root,'.'+name);if(!value.startsWith(root+path.sep)&&value!==root)throw new Error('outside fixture');return value;};
  const attrs=(s:Awaited<ReturnType<typeof lstat>>)=>({mode:Number(s.mode),size:Number(s.size),uid:0,gid:0,atime:Math.floor(Number(s.atimeMs)/1000),mtime:Math.floor(Number(s.mtimeMs)/1000)});
  const safe=(id:number,fn:()=>Promise<void>)=>{void fn().catch((error:NodeJS.ErrnoException)=>sftp.status(id,error.code==='ENOENT'?2:4,error.code));};
  sftp.on('OPEN',(id,name,flags,a)=>safe(id,async()=>{const handle=await open(file(name),utils.sftp.flagsToString(flags)!,a.mode),key=String(++next);handles.set(key,handle);sftp.handle(id,Buffer.from(key));}));
  sftp.on('CLOSE',(id,key)=>safe(id,async()=>{const handle=handles.get(key.toString());if(handle&&!Array.isArray(handle))await handle.close();handles.delete(key.toString());sftp.status(id,0);}));
  sftp.on('READ',(id,key,offset,length)=>safe(id,async()=>{const handle=handles.get(key.toString()) as FileHandle,bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,offset);if(read.bytesRead)sftp.data(id,bytes.subarray(0,read.bytesRead));else sftp.status(id,1);}));
  sftp.on('WRITE',(id,key,offset,data)=>{if(holdWrite())return;safe(id,async()=>{
    if(probe){probe.active++;probe.peak=Math.max(probe.peak,probe.active);probe.packets++;probe.bytes+=data.length;}
    try {
      const handle=handles.get(key.toString()) as FileHandle;let written=0;
      while(written<data.length)written+=(await handle.write(data,written,data.length-written,offset+written)).bytesWritten;
      // Different delays exercise out-of-order acknowledgements as well as RTT.
      if(probe?.delayMs)await new Promise(resolve=>setTimeout(resolve,probe.delayMs+(offset/32768%4)*3));
      sftp.status(id,0);
    }finally{if(probe)probe.active--;}
  });});
  for(const event of ['LSTAT','STAT'] as const)sftp.on(event,(id:number,name:string)=>safe(id,async()=>{sftp.attrs(id,attrs(await lstat(file(name))));}));
  sftp.on('FSTAT',(id,key)=>safe(id,async()=>{const handle=handles.get(key.toString()) as FileHandle;sftp.attrs(id,attrs(await handle.stat()));}));
  sftp.on('MKDIR',(id,name,a)=>safe(id,async()=>{await mkdir(file(name),{mode:a.mode});sftp.status(id,0);}));
  sftp.on('OPENDIR',(id,name)=>safe(id,async()=>{const entries=await readdir(file(name));const key=String(++next);handles.set(key,entries.map(entry=>path.posix.join(name,entry)));sftp.handle(id,Buffer.from(key));}));
  sftp.on('READDIR',(id,key)=>safe(id,async()=>{const entries=handles.get(key.toString()) as string[];if(!entries.length){sftp.status(id,1);return;}const batch=entries.splice(0,100);sftp.name(id,await Promise.all(batch.map(async name=>({filename:path.posix.basename(name),longname:name,attrs:attrs(await lstat(file(name)))}))));}));
  sftp.on('error',()=>{});sftp.on('close',()=>{for(const handle of handles.values())if(!Array.isArray(handle))void handle.close().catch(()=>{});handles.clear();});
}

