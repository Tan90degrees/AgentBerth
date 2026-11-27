import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { EXTENSION_ARCHIVE_MAX_BYTES } from '../shared/extensions';
import { WORKSPACE_EXTENSION_PATH, workspaceServerAddress, type WorkspaceEndpoint } from '../shared/workspace-server';

export async function workspaceExtensionSize(file:string):Promise<number>{
  if(!file.toLowerCase().endsWith('.zip'))throw new Error('请选择 ZIP 插件包');
  const info=await lstat(file);
  if(!info.isFile())throw new Error('请选择普通的 ZIP 插件文件');
  if(info.size===0||info.size>EXTENSION_ARCHIVE_MAX_BYTES)throw new Error('插件压缩包须大于 0 字节且不超过 256 MiB');
  return info.size;
}

async function checkResponse(response:IncomingMessage){
  if(response.statusCode===204){response.resume();return;}
  let message='';
  response.setEncoding('utf8');
  for await(const text of response){
    message+=text;
    if(message.length>4096)break;
  }
  if(response.statusCode===404)throw new Error('当前服务器不支持通过地址与令牌上传插件，请更新服务端');
  if(response.statusCode===401)throw new Error('服务器拒绝插件上传，请检查工作区令牌');
  throw new Error(message.slice(0,4096)||'服务器安装插件失败');
}

export async function uploadWorkspaceExtension(endpoint:WorkspaceEndpoint,file:string,signal:AbortSignal){
  const size=await workspaceExtensionSize(file);
  const source=await open(file,'r');
  try{
    const current=await source.stat();
    if(!current.isFile()||current.size!==size)throw new Error('插件包已更改，请重新选择');
    const url=new URL(workspaceServerAddress(endpoint.address));
    url.protocol=url.protocol==='wss:'?'https:':'http:';
    url.pathname=WORKSPACE_EXTENSION_PATH;
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
      method:'POST',headers:{Authorization:'Bearer '+endpoint.token,'Content-Length':size,'Content-Type':'application/zip',Expect:'100-continue'},
      ca:endpoint.ca,rejectUnauthorized:true,agent:false,signal:AbortSignal.any([signal,AbortSignal.timeout(10*60_000)]),
    });
    let body:Promise<void>|undefined;
    const response=new Promise<void>((resolve,reject)=>{
      request.once('error',reject);
      request.once('response',value=>void checkResponse(value).then(resolve,reject));
      request.once('continue',()=>{
        body=pipeline(source.createReadStream({autoClose:false,end:size-1}),request);
        void body.catch(reject);
      });
    });
    try{
      request.flushHeaders();
      await response;
      await body;
    }finally{
      request.destroy();
      await body?.catch(()=>{});
    }
  }finally{await source.close();}
}
