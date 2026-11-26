import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { openPromise } from 'yauzl';
import { validSourcePath } from '../wiki/source-directory';

const maxDownload = 96 * 1024 * 1024;
const maxUnpacked = 256 * 1024 * 1024;
const maxEntries = 4000;

export interface AcpBinaryRecipe {url:string;sha256:string;command:string;args:string[];kind:'zip'|'tar.gz'|'raw'}

async function requestArchive(url:string, signal:AbortSignal) {
  for(let count=0;count<6;count++){
    const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password)throw new Error('ACP 安装包地址必须使用 HTTPS');
    const response=await fetch(target,{signal,redirect:'manual'});
    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');
      await response.body?.cancel();
      if(!location)throw new Error('ACP 安装包下载地址无效');
      url=new URL(location,target).href;
      continue;
    }
    if(!response.ok||!response.body)throw new Error('ACP 安装包下载失败（HTTP '+response.status+'）');
    return response.body;
  }
  throw new Error('ACP 安装包重定向次数过多');
}

function safeEntry(root:string,name:string){
  const relative=name.replace(/^\.\//,'').replace(/\/$/,'');
  if(!validSourcePath(relative))throw new Error('ACP 安装包包含不安全的文件路径');
  return path.join(root,relative);
}

async function unpackZip(file:string,root:string,signal:AbortSignal){
  const zip=await openPromise(file,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true});
  let bytes=0;
  try{
    if(zip.entryCount>maxEntries)throw new Error('ACP 安装包文件数量过多');
    for await(const entry of zip.eachEntry()){
      signal.throwIfAborted();
      const directory=entry.fileName.endsWith('/'),target=safeEntry(root,entry.fileName);
      const mode=entry.externalFileAttributes>>>16,type=mode&0o170000;
      if(type&&type!==(directory?0o040000:0o100000))throw new Error('ACP 安装包包含链接或特殊文件');
      bytes+=entry.uncompressedSize;
      if(bytes>maxUnpacked)throw new Error('ACP 安装包展开后过大');
      if(directory){await mkdir(target,{recursive:true,mode:0o700});continue;}
      await mkdir(path.dirname(target),{recursive:true,mode:0o700});
      let crc=0;
      const verify=new Transform({transform(chunk:Buffer,_,next){crc=crc32(chunk,crc);next(null,chunk);}});
      await pipeline(await zip.openReadStreamPromise(entry),verify,createWriteStream(target,{flags:'wx',mode:mode&0o100?0o700:0o600}),{signal});
      if(crc!==entry.crc32)throw new Error('ACP 安装包条目校验失败');
    }
  }finally{zip.close();}
}

// The registry's portable binaries commonly contain a plain ustar archive.
// Extensions that override entry paths and any type of link are rejected.
async function unpackTar(buffer:Buffer,root:string,signal:AbortSignal){
  const tar=await promisify(gunzip)(buffer,{maxOutputLength:maxUnpacked});
  const field=(header:Buffer,start:number,end:number)=>header.subarray(start,end).toString('utf8').split('\0',1)[0];
  let count=0;
  for(let offset=0;offset+512<=tar.length;){
    signal.throwIfAborted();
    const header=tar.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))return;
    if(++count>maxEntries)throw new Error('ACP 安装包文件数量过多');
    const sizeField=field(header,124,136).trim(),modeField=field(header,100,108).trim(),type=header[156];
    if(!/^[0-7]+$/.test(sizeField)||!/^[0-7]+$/.test(modeField)||![0,48,53].includes(type))throw new Error('ACP TAR 包含不受支持的条目');
    const size=parseInt(sizeField,8),mode=parseInt(modeField,8),prefix=field(header,345,500);
    if(!Number.isSafeInteger(size)||offset+512+size>tar.length)throw new Error('ACP TAR 条目大小无效');
    const name=[prefix,field(header,0,100)].filter(Boolean).join('/');
    if(type===53&&(name==='.'||name==='./')){offset+=512;continue;}
    const target=safeEntry(root,name);
    if(type===53)await mkdir(target,{recursive:true,mode:0o700});
    else{
      await mkdir(path.dirname(target),{recursive:true,mode:0o700});
      await writeFile(target,tar.subarray(offset+512,offset+512+size),{flag:'wx',mode:mode&0o100?0o700:0o600});
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  throw new Error('ACP TAR 未正常结束');
}

export async function installAcpBinary(base:string,recipe:AcpBinaryRecipe) {
  await mkdir(base,{recursive:true,mode:0o700});
  const staging=await mkdtemp(path.join(base,'agent-'));
  const root=path.join(staging,'files');
  const signal=AbortSignal.timeout(120_000);
  try{
    const archive=path.join(staging,'download');
    const stream=await requestArchive(recipe.url,signal);
    const hash=createHash('sha256');
    let bytes=0;
    const limit=new Transform({transform(chunk:Buffer,_,next){
      bytes+=chunk.length;
      if(bytes>maxDownload){next(new Error('ACP 安装包超过下载大小上限'));return;}
      hash.update(chunk);next(null,chunk);
    }});
    await pipeline(stream,limit,createWriteStream(archive,{flags:'wx',mode:0o600}),{signal});
    if(hash.digest('hex')!==recipe.sha256.toLowerCase())throw new Error('ACP 安装包 SHA-256 不匹配');
    await mkdir(root,{mode:0o700});
    const command=safeEntry(root,recipe.command);
    if(recipe.kind==='zip')await unpackZip(archive,root,signal);
    else if(recipe.kind==='tar.gz'){
      const {readFile}=await import('node:fs/promises');
      await unpackTar(await readFile(archive),root,signal);
    }else{
      const {rename}=await import('node:fs/promises');
      await mkdir(path.dirname(command),{recursive:true,mode:0o700});
      await rename(archive,command);
    }
    if(!(await lstat(command)).isFile())throw new Error('ACP 安装包未包含声明的启动程序');
    if(process.platform!=='win32')await chmod(command,0o700);
    await rm(archive,{force:true});
    return command;
  }catch(error){
    await rm(staging,{recursive:true,force:true});
    throw error;
  }
}
