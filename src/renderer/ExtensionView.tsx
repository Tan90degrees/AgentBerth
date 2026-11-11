import { WebExtensionView } from './WebExtensionView';
import { useLayoutEffect, useRef } from 'react';
import type { ExtensionInfo } from '../shared/extensions';

// Mirror every semantic token from tokens.css into the sandboxed plugin view.
// view-document.ts applies them on :root, so bundled plugin CSS can share the
// main window's type scale, radii, motion and colors.
const PLUGIN_THEME_TOKENS = [
  '--color-scheme', '--font-sans', '--font-mono',
  // --fs-* are calc() expressions that reference --ui-font-scale, so the scale
  // itself must travel into the iframe or every one of them becomes invalid.
  '--ui-font-scale',
  '--fs-2xs', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl', '--fs-3xl',
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill',
  '--motion-fast', '--motion-base', '--motion-slow', '--ease-out',
  '--bg', '--sidebar', '--surface', '--surface-muted', '--panel', '--input', '--hover', '--selected',
  '--text', '--text-secondary', '--text-muted', '--border', '--primary', '--primary-hover', '--on-primary',
  '--focus', '--link', '--success', '--success-soft', '--success-border', '--danger', '--danger-soft', '--danger-border',
  '--warning', '--warning-soft', '--warning-border', '--overlay', '--shadow-color', '--selection', '--scrollbar', '--terminal',
];
function pluginTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = {};
  for (const name of PLUGIN_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) theme[name] = value;
  }
  theme['--muted'] = theme['--text-muted'] ?? ''; // legacy alias used by the bundled Superagent view
  return theme;
}

export function ExtensionView(props:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void;initialTaskId?:string;suspended?:boolean}){
  return props.plugin.manifest.views.find(v=>v.id===props.viewId)?.web?<WebExtensionView {...props}/>:<HtmlExtensionView {...props}/>;
}
function HtmlExtensionView({plugin,viewId,onError,initialTaskId}:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void;initialTaskId?:string}){
  const frame=useRef<HTMLIFrameElement>(null);
  // Attach the message bridge before paint: a fast iframe can otherwise send
  // its first command before the passive effect subscribes to window messages.
  useLayoutEffect(()=>{let pending=0,alive=true,draftFlush:Promise<void>|undefined;const draftWrites=new Map<string,Record<string,unknown>>(),draftFailures=new Map<string,string>();
  // Keep the latest snapshot in the host, so closing/reloading an iframe does
  // not discard writes queued behind an earlier save in that iframe.
  const saveDraft=async(params:Record<string,unknown>)=>{
    const call=(command:string,value:Record<string,unknown>)=>window.berth.extensions({action:'call',id:plugin.manifest.id,command,params:value});
    const bytes=new TextEncoder().encode(JSON.stringify(params.fields??{}));
    if(params.discard===true||bytes.length<40000){await call('save_editor_draft',params);return;}
    const upload=await call('draft_upload_start',{key:params.key}) as unknown as {id:string};
    try{for(let offset=0;offset<bytes.length;offset+=36*1024){const part=bytes.subarray(offset,offset+36*1024);await call('draft_upload_chunk',{id:upload.id,base64:btoa(Array.from(part,byte=>String.fromCharCode(byte)).join('')),done:offset+36*1024>=bytes.length});}}
    catch(error){await call('cancel_transfer',{id:upload.id}).catch(()=>{});throw error;}
  };
  const flushDrafts=():Promise<void>=>{
    if(draftFlush)return draftFlush;
    draftFlush=(async()=>{while(draftWrites.size){const [key,params]=draftWrites.entries().next().value!;draftWrites.delete(key);try{await saveDraft(params);draftFailures.delete(key);if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-draft-saved',key},'*');}catch(error){draftFailures.set(key,String(error));onError('草稿保存失败：'+String(error));}}})().finally(()=>{draftFlush=undefined;});
    return draftFlush;
  };
  const theme=pluginTheme;const observer=new MutationObserver(()=>frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-theme',theme:theme()},'*'));observer.observe(document.documentElement,{attributes:true});const receive=async(event:MessageEvent)=>{
    if(!alive||event.source!==frame.current?.contentWindow)return;
    if(event.data?.kind==='agentberth-plugin-save-draft'&&plugin.manifest.id==='notes-wiki'){
      const params=event.data.params;try{if(!params||typeof params.key!=='string'||draftWrites.size>=100&&!draftWrites.has(params.key))return;}catch{return;}
      draftWrites.set(params.key,params);void flushDrafts();return;
    }
    if(event.data?.kind==='agentberth-plugin-flush-drafts'&&plugin.manifest.id==='notes-wiki'&&typeof event.data.id==='string'&&event.data.id.length<=80){
      const id=event.data.id;await flushDrafts();if(alive)frame.current?.contentWindow?.postMessage({kind:'agentberth-plugin-drafts-flushed',id,error:draftFailures.size?[...draftFailures.values()][0]:undefined},'*');return;
    }
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
  return <iframe className="extension-view" ref={frame} title={plugin.manifest.views.find(v=>v.id===viewId)?.title??plugin.manifest.name} sandbox={'allow-scripts allow-forms'+(plugin.manifest.id==='notes-wiki'?' allow-downloads':'')} src={src}/>;
}
