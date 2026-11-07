import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {pluginWebStateSchema,type ExtensionInfo,type PluginWebState} from '../shared/extensions';
import type {Project,State} from '../shared/protocol';
import {ResourceBadge} from './Resources';

export function WebExtensionView({plugin,viewId,onError,suspended=false}:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void;suspended?:boolean}){
  const [status,setStatus]=useState<PluginWebState|null>(null),[projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState(''),[pending,setPending]=useState(false),[logs,setLogs]=useState(false);
  const host=useRef<HTMLDivElement>(null),alive=useRef(true),errors=useRef(onError);errors.current=onError;
  const definition=plugin.manifest.views.find(v=>v.id===viewId)!.web!;
  const needsProject=definition.project!==false;
  const target={id:plugin.manifest.id,view:viewId,generation:plugin.generation};
  const control=async(action:'status'|'start'|'stop'|'restart',id?:string)=>pluginWebStateSchema.parse(await window.berth.extensions({action:'call',id:target.id,command:definition.command,params:{action,...(needsProject&&id?{projectId:id}:{})}}));
  useEffect(()=>{
    alive.current=true;let reading=false;
    const update=(state:State)=>{setProjects(state.projects.filter(p=>!p.remoteWorkspace));};
    if(needsProject)void window.berth.rpc<State>('state').then(state=>{if(!alive.current)return;update(state);const saved=localStorage.getItem('berth.project');setProjectId(state.projects.find(p=>p.id===saved&&!p.remoteWorkspace)?.id??state.projects.find(p=>!p.remoteWorkspace)?.id??'');}).catch(error=>errors.current(String(error)));
    const off=needsProject?window.berth.onEvent(event=>{if(event.event==='state'&&alive.current)update(event.data);}):()=>{};
    async function refresh(){if(reading)return;reading=true;try{const value=await control('status');if(alive.current){setStatus(value);if(value.projectId)setProjectId(value.projectId);}}catch(error){if(alive.current)errors.current(String(error));}finally{reading=false;}}
    void refresh();const timer=setInterval(()=>void refresh(),1500);
    return()=>{alive.current=false;clearInterval(timer);off();};
  },[target.id,target.view,target.generation]);
  useLayoutEffect(()=>{
    const element=host.current;if(!element)return;
    let frame=0,last='',disposed=false;
    const send=()=>{frame=0;if(disposed)return;
      const rect=element.getBoundingClientRect(),visible=!suspended&&status?.state==='running'&&!!status.url&&!!element.getClientRects().length&&rect.width>0&&rect.height>0&&!document.hidden&&!document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]');
      const request=visible?{...target,action:'show' as const,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}:{...target,action:'hide' as const};
      const key=JSON.stringify(request);if(key===last)return;last=key;
      void window.berth.pluginBrowser(request).catch(error=>{if(!disposed)errors.current(String(error));});
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(send);};
    const resize=new ResizeObserver(schedule);resize.observe(element);
    // Modal portals are direct body children; observing the whole subtree caused terminal/UI churn to schedule unnecessary native-view IPC.
    const mutation=new MutationObserver(schedule);mutation.observe(document.body,{childList:true});
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);document.addEventListener('visibilitychange',schedule);
    send();return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',schedule);void window.berth.pluginBrowser({...target,action:'hide'}).catch(()=>{});};
  },[target.id,target.view,target.generation,status?.state,status?.url,suspended]);
  async function action(value:'start'|'stop'|'restart'){
    if(pending)return;setPending(true);try{const result=await control(value,projectId);if(alive.current)setStatus(result);}catch(error){errors.current(String(error));}finally{if(alive.current)setPending(false);}
  }
  const active=status?.state==='starting'||status?.state==='running'||status?.state==='stopping';
  return <section className="plugin-web" aria-label={plugin.manifest.name+' Web'}>
    <header className="plugin-web-toolbar">
      {needsProject&&<select aria-label="Web 服务项目" disabled={pending||active} value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      <span className="plugin-web-status" role="status">{status?{stopped:'未启动',starting:'正在启动',running:'运行中',stopping:'正在停止',failed:'已退出'}[status.state]:'正在连接'}</span>
      {plugin.manifest.id==='deepseek-harness'&&<ResourceBadge scope="application" id="deepseekHarness" full/>}
      <div className="plugin-web-actions"><button className="subtle" disabled={!status||pending||needsProject&&!projectId||active} onClick={()=>void action('start')}>启动</button><button className="subtle" disabled={!status||pending||!active} onClick={()=>void action('stop')}>停止</button><button className="subtle" disabled={!status||pending||needsProject&&!projectId||status.state==='stopping'} onClick={()=>void action('restart')}>重启</button><button className="subtle" disabled={status?.state!=='running'} onClick={()=>void window.berth.pluginBrowser({...target,action:'reload',bounds:host.current?(()=>{const r=host.current!.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})():undefined}).catch(error=>errors.current(String(error)))}>刷新页面</button><button className="text-button" aria-expanded={logs} onClick={()=>setLogs(v=>!v)}>启动日志</button><button className="text-button" onClick={()=>window.dispatchEvent(new CustomEvent('berth:plugin-settings',{detail:{pluginId:target.id,isAgent:plugin.isAgent}}))}>设置</button></div>
    </header>
    {status?.error&&<div className="launch-error" role="alert">{status.error}</div>}
    {logs&&<pre className="plugin-web-log" aria-label="Web 启动日志">{status?.log||'暂无日志'}</pre>}
    <div className="plugin-web-host" ref={host}>{status?.state!=='running'&&<div className="empty-page"><h2>{status?.state==='starting'?'正在启动 '+plugin.manifest.name:plugin.manifest.name}</h2><p>{status?.state==='starting'?'首次运行可能需要下载软件包，可展开启动日志查看进度。':needsProject?'选择项目后启动原生 Web 工作台。':'启动后在原生工作台中管理工作区与会话。'}</p></div>}</div>
  </section>;
}
