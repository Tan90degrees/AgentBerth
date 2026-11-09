import {memo,useEffect,useMemo,useRef,useState,type DragEvent,type KeyboardEvent,type ReactNode} from 'react';
import type {ExtensionIcon,ExtensionSnapshot} from '../shared/extensions';
import type {AgentActivity} from '../shared/pet';
import {loadActivityOrder,moveActivityItem,orderActivityItems,reconcileActivityOrder} from './activity-order';
import {saveStored} from './storage';

const paths:Record<ExtensionIcon,string>={
  puzzle:'M9 4a2 2 0 1 1 4 0v2h3a2 2 0 0 1 2 2v3h-2a2 2 0 1 0 0 4h2v3a2 2 0 0 1-2 2h-3v-2a2 2 0 1 0-4 0v2H6a2 2 0 0 1-2-2v-3h2a2 2 0 1 0 0-4H4V8a2 2 0 0 1 2-2h3V4Z',
  terminal:'m5 7 4 4-4 4m7 0h6',brain:'M12 5a3 3 0 0 0-5-2 3 3 0 0 0-3 5 3 3 0 0 0 0 6 3 3 0 0 0 3 5 3 3 0 0 0 5-2m0-12a3 3 0 0 1 5-2 3 3 0 0 1 3 5 3 3 0 0 1 0 6 3 3 0 0 1-3 5 3 3 0 0 1-5-2M12 5v14m-4-9h4m4-3h-4',
  paw:'M7 11c-2 0-3 2-3 4 0 2 2 3 4 2l2-1h4l2 1c2 1 4 0 4-2 0-2-1-4-3-4-1 0-2 1-3 1h-4c-1 0-2-1-3-1ZM6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  workflow:'M6 4h4v4H6zM14 16h4v4h-4zM4 18h4v4H4zM10 6h4a2 2 0 0 1 2 2v8m-6-8v8a2 2 0 0 1-2 2H8',
  code:'m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14',chart:'M4 19V5m0 14h17M8 15l3-4 3 2 6-7',database:'M4 5c0-2 4-3 8-3s8 1 8 3-4 3-8 3-8-1-8-3Zm0 0v7c0 2 4 3 8 3s8-1 8-3V5m-16 7v7c0 2 4 3 8 3s8-1 8-3v-7',globe:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-10-10h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z',sparkles:'m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Zm7 11 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z',message:'M4 4h16v12H9l-5 4V4Z',book:'M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4zM20 4h-3a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h3z',image:'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M9 8h.01',search:'m20 20-5-5m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',plug:'M9 3v6m6-6v6M7 9h10v3a5 5 0 0 1-5 5v4m-5-12H5v3a7 7 0 0 0 14 0V9h-2'
};
function Glyph({name}:{name:ExtensionIcon|'sessions'|'manage'|'settings'|'collapse'}){
  // The settings entry is a proper gear: the previous sun-shaped glyph was
  // indistinguishable from the appearance (theme) toggle next to it.
  const d=name==='sessions'?'M4 5h16v14H4zM8 9h8M8 13h5':name==='manage'?'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z':name==='settings'?'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z':name==='collapse'?'M4 5h16v14H4zM9 5v14m7-10-3 3 3 3':paths[name];
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
}
type Entry={id:string;pluginId:string;viewId:string;title:string;pluginName:string;icon:ExtensionIcon};
export const ActivityBar=memo(function ActivityBar({snapshot,activities=[],selected,sessionSelected,sessionUnread=false,sidebarCollapsed,draftDirty,appearance,onSessions,onToggleSidebar,onSelect,onManage,onSettings}:{snapshot?:ExtensionSnapshot;activities?:AgentActivity[];selected:{pluginId:string;viewId:string}|null;sessionSelected:boolean;sessionUnread?:boolean;sidebarCollapsed:boolean;draftDirty:boolean;appearance?:ReactNode;onSessions:()=>void;onToggleSidebar:()=>void;onSelect:(pluginId:string,viewId:string)=>void;onManage:()=>void;onSettings:()=>void}){
  const known=useMemo(()=>snapshot?.plugins.flatMap(plugin=>plugin.views.filter(view=>view.location!=='settings').map(view=>plugin.manifest.id+':'+view.id))??[],[snapshot]);
  const entries=useMemo<Entry[]>(()=>snapshot?.plugins.filter(plugin=>plugin.status==='active').flatMap(plugin=>plugin.views.filter(view=>view.location!=='settings').map(view=>({id:plugin.manifest.id+':'+view.id,pluginId:plugin.manifest.id,viewId:view.id,title:view.title,pluginName:plugin.manifest.name,icon:plugin.manifest.icon??'puzzle'})))??[],[snapshot]);
  const [order,setOrder]=useState(loadActivityOrder),drag=useRef<string|null>(null);
  const ordered=orderActivityItems(entries,order.items);
  // Keep disabled views in the saved order so re-enabling an extension restores
  // its previous position. Uninstalled views disappear from the snapshot entirely.
  useEffect(()=>{if(!snapshot)return;setOrder(previous=>reconcileActivityOrder(previous,known));},[snapshot?.revision]);
  useEffect(()=>{saveStored('berth.activityOrder',JSON.stringify(order.items));},[order]);
  const counts=useMemo(()=>{const result=new Map<string,number>();for(const item of activities)if(item.pluginId&&['waiting','error','unknown'].includes(item.status))result.set(item.pluginId,(result.get(item.pluginId)??0)+1);return result;},[activities]);
  const move=(id:string,targetId:string,edge:'before'|'after')=>setOrder(previous=>({items:moveActivityItem(known,previous.items,id,targetId,edge)}));
  const onDrop=(event:DragEvent<HTMLButtonElement>,target:Entry)=>{event.preventDefault();const source=drag.current;drag.current=null;if(!source||source===target.id)return;const box=event.currentTarget.getBoundingClientRect();move(source,target.id,event.clientY<box.top+box.height/2?'before':'after');};
  const onKeyDown=(event:KeyboardEvent<HTMLButtonElement>,entry:Entry)=>{if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const index=ordered.findIndex(item=>item.id===entry.id),target=ordered[index+(event.key==='ArrowUp'?-1:1)];if(target)move(entry.id,target.id,event.key==='ArrowUp'?'before':'after');};
  return <aside className="activity-bar" aria-label="活动栏">
    <nav className="activity-bar-main" aria-label="会话与扩展应用">
      <button type="button" className={'activity-item'+(sessionSelected?' selected':'')} aria-label="会话" title="会话管理" aria-pressed={sessionSelected} onClick={onSessions}><Glyph name="sessions"/><span className="activity-label">会话</span>{sessionUnread&&<span className="rail-unread" aria-label="有新输出"/>}</button>
      <div className="activity-divider"/>
      {ordered.map(entry=>{const count=counts.get(entry.pluginId)??0,isSelected=selected?.pluginId===entry.pluginId&&selected.viewId===entry.viewId;return <button type="button" draggable className={'activity-item extension-activity'+(isSelected?' selected':'')} key={entry.id} aria-label={entry.pluginName+' · '+entry.title} aria-current={isSelected?'page':undefined} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title={entry.pluginName+' · '+entry.title+'（可拖动排序）'} onClick={()=>onSelect(entry.pluginId,entry.viewId)} onKeyDown={event=>onKeyDown(event,entry)} onDragStart={event=>{drag.current=entry.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',entry.id);}} onDragEnd={()=>{drag.current=null;}} onDragOver={event=>{if(drag.current){event.preventDefault();event.dataTransfer.dropEffect='move';}}} onDrop={event=>onDrop(event,entry)}><Glyph name={entry.icon}/><span className="activity-label">{entry.title}</span>{count>0&&<span className="activity-badge" aria-label={count+' 项待处理'}>{count>9?'9+':count}</span>}</button>;})}
    </nav>
    <nav className="activity-bar-bottom" aria-label="工作台设置">
      <button type="button" className="activity-item" aria-label={sidebarCollapsed?'展开会话侧栏':'折叠会话侧栏'} title={sidebarCollapsed?'展开会话侧栏':'折叠会话侧栏'} aria-pressed={!sidebarCollapsed} onClick={onToggleSidebar}><Glyph name="collapse"/><span className="activity-label">{sidebarCollapsed?'展开':'折叠'}</span></button>
      <button type="button" className="activity-item" aria-label="扩展管理" title="扩展管理" onClick={onManage}><Glyph name="manage"/><span className="activity-label">扩展</span></button>
      <button type="button" className={'activity-item'+(draftDirty?' has-draft':'')} aria-label="设置" title="设置 · Ctrl+," onClick={onSettings}><Glyph name="settings"/><span className="activity-label">设置</span>{draftDirty&&<span className="activity-draft-dot"/>}</button>
      {appearance&&<div className="activity-appearance">{appearance}</div>}
    </nav>
  </aside>;
});
