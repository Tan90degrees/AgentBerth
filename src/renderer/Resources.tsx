import { memo, useEffect, useSyncExternalStore } from 'react';
import type { ResourceSnapshot, ResourceUsage } from '../shared/protocol';

let snapshot:ResourceSnapshot|null=null;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const publish=(value:ResourceSnapshot|null)=>{snapshot=value;for(const listener of listeners)listener();};
// Only badges subscribe to telemetry: terminal and project/session state never rerender on a sample.
export function ResourceMonitor({enabled}:{enabled:boolean}){
  useEffect(()=>{
    let alive=true,pending=false;publish(null);
    const refresh=async()=>{if(!enabled||pending||document.visibilityState!=='visible'||!document.hasFocus())return;pending=true;try{const value=await window.berth.rpc<ResourceSnapshot>('resources',{});if(alive)publish(value);}catch{if(alive)publish({sampledAt:new Date().toISOString(),cpuCount:0,sessions:{},projects:{},workspace:{cpuPercent:null,memoryBytes:null,processCount:0,partial:true},desktopIncluded:false,error:'资源信息暂不可用，稍后自动重试'});}finally{pending=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),3000);
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);publish(null);};
  },[enabled]);return null;
}
export function memoryLabel(bytes:number|null):string{
  if(bytes===null)return '—';if(bytes<1024*1024)return `${Math.round(bytes/1024)}K`;
  if(bytes>=1024**3)return `${(bytes/1024**3).toFixed(1)}G`;return `${Math.round(bytes/1024**2)}M`;
}
export const ResourceBadge=memo(function ResourceBadge({scope,id,runId,full=false}:{scope:'session'|'project'|'workspace';id?:string;runId?:string;full?:boolean}){
  const value=useSyncExternalStore(subscribe,()=>snapshot);
  let usage:ResourceUsage|undefined=scope==='workspace'?value?.workspace:scope==='project'?value?.projects[id??'']:value?.sessions[id??''];
  if(scope==='session'&&value?.sessions[id??'']?.runId!==runId)usage=undefined;
  const cpu=usage?.cpuPercent==null?'—':`${usage.cpuPercent<10?usage.cpuPercent.toFixed(1):Math.round(usage.cpuPercent)}%`,memory=memoryLabel(usage?.memoryBytes??null);
  const label=scope==='workspace'?'工作台':scope==='project'?'项目':'会话';
  const detail=value?.error??(!value?'正在读取资源占用':`${label}：CPU ${cpu}，内存 ${memory}（${usage?.processCount??0} 个进程）\nCPU 100% 表示占满全部 ${value.cpuCount} 个逻辑处理器；内存为工作集/RSS 之和，按 1024 换算，可能包含共享页。\n${scope==='workspace'?(value.desktopIncluded?'包含桌面、后台、终端及子进程':'后台及终端统计，桌面进程信息暂不可用'):'包含该会话/项目的运行中终端和子进程；项目不含桌面公共开销'}${usage?.partial?'；部分进程暂不可读':''}\n${usage?.cpuPercent===null?'CPU 正在等待第二次采样；':''}更新于 ${new Date(value.sampledAt).toLocaleTimeString('zh-CN')}`);
  return <span className={`resource-usage ${full?'resource-full':''}`} data-resource-scope={scope} data-resource-id={id} data-resource-ready={!!usage&&usage.memoryBytes!==null} title={detail} aria-label={`${label}资源占用：CPU ${cpu}，内存 ${memory}`}><span>{full?'CPU ':''}{cpu}</span><span className="resource-divider">·</span><span>{memory}</span></span>;
});
