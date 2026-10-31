import { useLayoutEffect, useRef } from 'react';
import type { ExtensionInfo } from '../shared/extensions';

export function ExtensionView({plugin,viewId,onError}:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void}){
  const frame=useRef<HTMLIFrameElement>(null);
  // Attach the message bridge before paint: a fast iframe can otherwise send
  // its first command before the passive effect subscribes to window messages.
  useLayoutEffect(()=>{let pending=0,alive=true;const receive=async(event:MessageEvent)=>{
    if(event.source!==frame.current?.contentWindow||event.data?.kind!=='agentberth-plugin-call')return;
    const {id,command,params}=event.data;if(typeof id!=='string'||typeof command!=='string')return;
    const reject=()=>frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,error:'插件视图请求过多或参数无效'},'*');
    try{if(pending>=8||params!==undefined&&(!params||typeof params!=='object'||Array.isArray(params))||JSON.stringify(params??{}).length>65536){reject();return;}}catch{reject();return;}pending++;
    try{const result=await window.berth.extensions({action:'call',id:plugin.manifest.id,command,params:params??{}});if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,result},'*');}catch(error){if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,error:String(error)},'*');}finally{pending--;}
  };window.addEventListener('message',receive);return()=>{alive=false;window.removeEventListener('message',receive);};},[plugin.manifest.id]);
  const src=`agentberth-plugin://view/${plugin.manifest.id}/${viewId}?generation=${plugin.generation}`;
  return <iframe className="extension-view" ref={frame} title={plugin.manifest.views.find(v=>v.id===viewId)?.title??plugin.manifest.name} sandbox="allow-scripts" src={src}/>;
}
