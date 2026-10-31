import { useEffect, useRef, useState } from 'react';
import type { ExtensionInfo } from '../shared/extensions';

export function ExtensionView({plugin,viewId,onError}:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void}){
  const frame=useRef<HTMLIFrameElement>(null),[html,setHtml]=useState('');
  useEffect(()=>{let alive=true;setHtml('');void window.berth.extensions<string>({action:'view',id:plugin.manifest.id,view:viewId}).then(value=>{if(alive)setHtml(value);}).catch(error=>onError(String(error)));return()=>{alive=false;};},[plugin.manifest.id,plugin.generation,viewId]);
  useEffect(()=>{let pending=0,alive=true;const receive=async(event:MessageEvent)=>{
    if(event.source!==frame.current?.contentWindow||event.data?.kind!=='agentberth-plugin-call')return;
    const {id,command,params}=event.data;if(typeof id!=='string'||typeof command!=='string')return;
    const reject=()=>frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,error:'插件视图请求过多或参数无效'},'*');
    try{if(pending>=8||params!==undefined&&(!params||typeof params!=='object'||Array.isArray(params))||JSON.stringify(params??{}).length>65536){reject();return;}}catch{reject();return;}pending++;
    try{const result=await window.berth.extensions({action:'call',id:plugin.manifest.id,command,params:params??{}});if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,result},'*');}catch(error){if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,error:String(error)},'*');}finally{pending--;}
  };window.addEventListener('message',receive);return()=>{alive=false;window.removeEventListener('message',receive);};},[plugin.manifest.id]);
  const bridge=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'"><style>body{font:14px system-ui;margin:16px;color:#ddd;background:#212121}button,input{font:inherit}</style><script>window.agentberth={call:(command,params={})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{removeEventListener('message',listener);reject(new Error('等待插件结果超时，操作不会自动重试'))},30000);const listener=e=>{if(e.source!==parent||e.data?.kind!=='agentberth-plugin-result'||e.data.id!==id)return;clearTimeout(timer);removeEventListener('message',listener);e.data.error?reject(new Error(e.data.error)):resolve(e.data.result)};addEventListener('message',listener);parent.postMessage({kind:'agentberth-plugin-call',id,command,params},'*')})};</script>`;
  return <iframe className="extension-view" ref={frame} title={plugin.manifest.views.find(v=>v.id===viewId)?.title??plugin.manifest.name} sandbox="allow-scripts" srcDoc={bridge+html}/>;
}
