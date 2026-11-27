import { createWriteStream, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage,ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EXTENSION_ARCHIVE_MAX_BYTES } from '../shared/extensions';

export class WorkspaceExtensionUpload {
  private uploading=false;
  constructor(private directory:string,private install:(file:string)=>Promise<unknown>){
    rmSync(directory,{recursive:true,force:true});
  }

  async handle(request:IncomingMessage,response:ServerResponse){
    const size=Number(request.headers['content-length']);
    if(request.method!=='POST'){this.reply(response,405,'请选择 ZIP 插件包');return;}
    if(!Number.isSafeInteger(size)||size<=0||size>EXTENSION_ARCHIVE_MAX_BYTES){this.reply(response,413,'插件压缩包须大于 0 字节且不超过 256 MiB');return;}
    if(this.uploading){this.reply(response,409,'服务器正在安装另一个插件，请稍后重试');return;}
    this.uploading=true;
    const cancel=new AbortController();
    response.once('close',()=>cancel.abort());
    let stage:string|undefined;
    try{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      stage=await mkdtemp(path.join(this.directory,'upload-'));
      const file=path.join(stage,'extension.zip');
      if(request.headers.expect?.toLowerCase()==='100-continue')response.writeContinue();
      await pipeline(request,createWriteStream(file,{flags:'wx',mode:0o600}),{signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(8*60_000)])});
      cancel.signal.throwIfAborted();
      await this.install(file);
      response.writeHead(204).end();
    }catch(error){
      if(!response.destroyed)this.reply(response,422,(error instanceof Error?error.message:String(error)).slice(0,4096));
    }finally{
      try{if(stage)await rm(stage,{recursive:true,force:true});}
      finally{this.uploading=false;}
    }
  }

  private reply(response:ServerResponse,status:number,message:string){
    response.writeHead(status,{'Content-Type':'text/plain; charset=utf-8',Connection:'close'}).end(message);
  }
}
