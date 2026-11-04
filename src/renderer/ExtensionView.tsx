import { WebExtensionView } from './WebExtensionView';
import { useLayoutEffect, useRef } from 'react';
import type { ExtensionInfo } from '../shared/extensions';

export function ExtensionView(props:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void;initialTaskId?:string;suspended?:boolean}){
  return props.plugin.manifest.views.find(v=>v.id===props.viewId)?.web?<WebExtensionView {...props}/>:<HtmlExtensionView {...props}/>;
}
function HtmlExtensionView({plugin,viewId,onError,initialTaskId}:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void;initialTaskId?:string}){
  const frame=useRef<HTMLIFrameElement>(null);
  // Attach the message bridge before paint: a fast iframe can otherwise send
  // its first command before the passive effect subscribes to window messages.
  useLayoutEffect(()=>{let pending=0,alive=true;const theme=()=>{const style=getComputedStyle(document.documentElement);return {...Object.fromEntries(['--text','--surface','--surface-muted','--border','--focus','--color-scheme','--scrollbar','--hover'].map(name=>[name,style.getPropertyValue(name)])),'--muted':style.getPropertyValue('--text-muted')||style.getPropertyValue('--muted')};};const observer=new MutationObserver(()=>frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-theme',theme:theme()},'*'));observer.observe(document.documentElement,{attributes:true});const receive=async(event:MessageEvent)=>{
    if(!alive||event.source!==frame.current?.contentWindow)return;
    if(event.data?.kind==='agentberth-plugin-open-settings'){window.dispatchEvent(new CustomEvent('berth:plugin-settings',{detail:{pluginId:plugin.manifest.id,isAgent:plugin.isAgent}}));return;}
    if(event.data?.kind==='agentberth-plugin-ready'){
      frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-ready-ack',theme:theme()},'*');
      return;
    }
    if(event.data?.kind==='agentberth-plugin-open-session'&&typeof event.data.sessionId==='string'&&/^[a-f0-9-]{36}$/.test(event.data.sessionId)){window.dispatchEvent(new CustomEvent('berth:open-session',{detail:{sessionId:event.data.sessionId,pluginId:plugin.manifest.id}}));return;}
    if(event.data?.kind!=='agentberth-plugin-call')return;
    const {id,command,params}=event.data;if(typeof id!=='string'||typeof command!=='string')return;
    const reject=()=>frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,error:'插件视图请求过多或参数无效'},'*');
    try{if(pending>=8||params!==undefined&&(!params||typeof params!=='object'||Array.isArray(params))||JSON.stringify(params??{}).length>65536){reject();return;}}catch{reject();return;}pending++;
    try{const result=await window.berth.extensions({action:'call',id:plugin.manifest.id,command,params:params??{}});if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,result},'*');}catch(error){if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-result',id,error:String(error)},'*');}finally{pending--;}
  };window.addEventListener('message',receive);return()=>{alive=false;observer.disconnect();window.removeEventListener('message',receive);};},[plugin.manifest.id]);
  const src=`agentberth-plugin://view/${plugin.manifest.id}/${viewId}?generation=${plugin.generation}`+(initialTaskId?'&task='+encodeURIComponent(initialTaskId):'');
  return <iframe className="extension-view" ref={frame} title={plugin.manifest.views.find(v=>v.id===viewId)?.title??plugin.manifest.name} sandbox="allow-scripts allow-forms" src={src}/>;
}
