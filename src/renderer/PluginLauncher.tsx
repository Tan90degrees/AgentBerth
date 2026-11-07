import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ExtensionSnapshot} from '../shared/extensions';
import type {AgentActivity} from '../shared/pet';

export const PluginLauncher=memo(function PluginLauncher({snapshot,activities=[],compact=false,selected,onSelect,onManage}:{snapshot?:ExtensionSnapshot;activities?:AgentActivity[];compact?:boolean;selected?:{pluginId:string;viewId:string}|null;onSelect:(pluginId:string,viewId:string)=>void;onManage:()=>void}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[position,setPosition]=useState({left:8,top:8});
  const anchor=useRef<HTMLButtonElement>(null),popup=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null);
  const entries=useMemo(()=>snapshot?.plugins.filter(p=>p.status==='active').flatMap(plugin=>plugin.views.filter(v=>v.location!=='settings').map(view=>({plugin,view})))??[],[snapshot]);
  const counts=useMemo(()=>{const result=new Map<string,number>();for(const activity of activities)if(activity.pluginId&&['waiting','error','unknown'].includes(activity.status))result.set(activity.pluginId,(result.get(activity.pluginId)??0)+1);return result;},[activities]);
  const pending=(id:string)=>counts.get(id)??0;
  const attention=[...new Set(entries.map(entry=>entry.plugin.manifest.id))].reduce((sum,id)=>sum+pending(id),0);
  const visible=entries.filter(({plugin,view})=>(plugin.manifest.name+' '+view.title).toLowerCase().includes(query.trim().toLowerCase()));
  const close=(restore=false)=>{setOpen(false);if(restore)anchor.current?.focus();};
  useLayoutEffect(()=>{if(!open)return;const a=anchor.current!.getBoundingClientRect(),p=popup.current!.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(a.left,window.innerWidth-p.width-8)),top:Math.max(8,a.top-p.height-8)});search.current?.focus();},[open,query,entries.length]);
  useEffect(()=>{if(!open)return;
    const outside=(event:PointerEvent)=>{if(!popup.current?.contains(event.target as Node)&&!anchor.current?.contains(event.target as Node))close();};
    const focus=(event:FocusEvent)=>{if(!popup.current?.contains(event.target as Node)&&!anchor.current?.contains(event.target as Node))close();};
    const resized=()=>close();document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',focus);window.addEventListener('resize',resized);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',focus);window.removeEventListener('resize',resized);};
  },[open]);
  return <>
    <button type="button" className={compact?'icon-button plugin-launcher-button':'plugin-launcher-button'} aria-label="扩展应用" title="扩展应用" aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setQuery('');setOpen(value=>!value);}} ref={anchor}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>
      {!compact&&<span>扩展应用</span>}{attention>0&&<span className="extension-nav-badge" aria-label={attention+' 项待处理'}>{attention}</span>}{!compact&&<span className="plugin-launcher-chevron" aria-hidden="true">⌃</span>}
    </button>
    {open&&createPortal(<section className="plugin-launcher-popup" role="dialog" aria-label="扩展应用" ref={popup} style={position} onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&event.target!==search.current){const items=[...popup.current!.querySelectorAll<HTMLButtonElement>('.plugin-launcher-entry')],index=items.indexOf(document.activeElement as HTMLButtonElement);event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
    }}>
      <header><strong>扩展应用</strong><button type="button" className="icon-button" aria-label="关闭扩展应用" onClick={()=>close(true)}>×</button></header>
      <input ref={search} aria-label="搜索扩展应用" placeholder="搜索扩展应用" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();popup.current?.querySelector<HTMLButtonElement>('.plugin-launcher-entry')?.focus();}}}/>
      <nav className="plugin-launcher-list" aria-label="扩展视图">{visible.map(({plugin,view})=><button type="button" className="plugin-launcher-entry" key={plugin.manifest.id+':'+view.id} aria-label={view.title} aria-current={selected?.pluginId===plugin.manifest.id&&selected.viewId===view.id?'page':undefined} onClick={()=>{close();onSelect(plugin.manifest.id,view.id);}}><span><strong>{view.title}</strong>{plugin.manifest.name!==view.title&&<small>{plugin.manifest.name}</small>}</span>{pending(plugin.manifest.id)>0&&<span className="extension-nav-badge">{pending(plugin.manifest.id)}</span>}</button>)}{!visible.length&&<p>{query?'没有匹配的扩展':'暂无可用扩展'}</p>}</nav>
      <footer><button type="button" className="text-button" onClick={()=>{close();onManage();}}>管理插件</button></footer>
    </section>,document.body)}
  </>;
});
