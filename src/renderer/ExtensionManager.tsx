import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { extensionEnabled, type ExtensionInfo, type ExtensionSnapshot, type ExtensionConfig } from '../shared/extensions';
import { ExtensionView } from './ExtensionView';
import { PluginSettingsPanel, type BuiltinSettingsId } from './PluginSettingsPanel';
import { Dialog } from './Dialog';
import type { AgentDefinition, Project, Settings } from '../shared/protocol';

export const ExtensionsContext=createContext<ExtensionSnapshot|undefined>(undefined);
export const useExtension=(id:string)=>extensionEnabled(useContext(ExtensionsContext),id);

const groupMembers:Record<string,string[]>={
  agents:['agents','agent.codex','agent.claude','agent.opencode','pet'],
  files:['files','git'],
};
const hiddenBuiltins=new Set(['workspace','agent.codex','agent.claude','agent.opencode','pet','git']);
const labels:Record<string,{name:string;description:string}>={
  agents:{name:'Agent 与桌宠',description:'Codex、Claude Code、OpenCode、自定义 Agent、Skills、历史恢复与桌宠整合管理'},
  files:{name:'文件与 Git',description:'文件树、预览、Markdown、Git 分支、暂存和差异查看统一管理'},
};
export function ExtensionManager({snapshot,onError,mode='all',openId,onOpenHandled,agents=[],projects=[],currentProjectId,settings,apiVersion=0,connected=false}:{
  snapshot?:ExtensionSnapshot;onError:(error:string)=>void;mode?:'all'|'agents';
  openId?:string|null;onOpenHandled?:()=>void;
  agents?:AgentDefinition[];projects?:Project[];currentProjectId?:string;
  settings?:Settings;apiVersion?:number;connected?:boolean;
}){
  const [current,setCurrent]=useState(snapshot),[busy,setBusy]=useState(''),[query,setQuery]=useState(''),[editing,setEditing]=useState<string|null>(null),[draft,setDraft]=useState<ExtensionConfig>({}),[message,setMessage]=useState(''),[configError,setConfigError]=useState('');
  const opener=useRef<HTMLElement|null>(null);
  useEffect(()=>setCurrent(snapshot),[snapshot]);
  const perform=async(id:string,action:()=>Promise<ExtensionSnapshot|null>)=>{setBusy(id);setMessage('');onError('');try{const next=await action();if(next){setCurrent(next);setEditing(null);setMessage('插件已更新，即时生效');}}catch(error){onError(String(error));}finally{setBusy('');}};
  const exportKit=async()=>{setBusy('$kit');try{const folder=await window.berth.exportPluginKit();if(folder){await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(folder));setMessage('开发套件已导出，开发指令已复制：'+folder);}}catch(error){onError(String(error));}finally{setBusy('');}};
  const plugins=current?.plugins.filter(plugin=>!hiddenBuiltins.has(plugin.manifest.id)&&(mode==='all'||plugin.isAgent||plugin.manifest.id==='agents'))??[];
  const configured=current?.plugins.find(plugin=>plugin.manifest.id===editing);
  const dirty=!!configured&&JSON.stringify(draft)!==JSON.stringify(configured.config);
  const openConfig=(plugin:ExtensionInfo)=>{opener.current=document.activeElement as HTMLElement;setDraft({...plugin.config});setEditing(plugin.manifest.id);setConfigError('');onError('');};
  useEffect(()=>{
    if(!openId||!current)return;
    const root=openId==='pet'||openId.startsWith('agent.')?'agents':openId==='git'?'files':openId;
    const plugin=current.plugins.find(value=>value.manifest.id===root);
    if(plugin){openConfig(plugin);onOpenHandled?.();}
  },[openId,current?.revision]);
  const saveConfig=async()=>{if(!configured)return;setBusy(configured.manifest.id);onError('');try{const next=await window.berth.extensions({action:'configure',id:configured.manifest.id,config:draft});setCurrent(next);setEditing(null);setMessage('插件配置已保存，即时生效');}catch(error){setConfigError(String(error));}finally{setBusy('');}};
  if(!current)return <p>插件后台未连接。请检查后台服务。</p>;
  return <section className="extension-manager" aria-label="插件管理">
    <header><div><h2>{mode==='agents'?'Agent 接入':'插件'}</h2><p>{mode==='agents'?'所有内置 Agent、桌宠与 Skills 作为同一个功能包管理；自定义 Agent 仍是独立的 Cordis 插件。':'每个功能包只需一次启停；专属设置只在自己的配置弹窗中展示。'}</p></div><div className="extension-actions"><button type="button" className="extension-button primary" disabled={!!busy} onClick={()=>void perform('$install',()=>window.berth.installExtension(false))}>{mode==='agents'?'安装 Agent 插件包':'安装插件包'}</button><button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>void perform('$develop',()=>window.berth.installExtension(true))}>加载开发目录</button></div></header>
    <p className="form-hint">相关内置子功能统一启停，底层依赖由插件运行时管理；插件运行本机代码，请仅安装可信来源。</p>
    <div className="extension-utilities"><input aria-label="搜索插件" placeholder={mode==='agents'?'搜索 Agent 接入':'搜索功能或插件 ID'} value={query} onChange={event=>setQuery(event.target.value)}/><button type="button" className="extension-button subtle" disabled={!!busy} aria-busy={busy==='$kit'} onClick={()=>void exportKit()}>导出插件开发套件并复制指令</button></div>
    {message&&<p role="status">{message}</p>}
    {current.warnings?.map(warning=><p className="form-error" key={warning}>{warning}</p>)}
    <ul className="extension-list">{plugins.filter(plugin=>`${labels[plugin.manifest.id]?.name??plugin.manifest.name} ${plugin.manifest.id} ${labels[plugin.manifest.id]?.description??plugin.manifest.description}`.toLowerCase().includes(query.toLowerCase())).map(plugin=>{
      const {manifest}=plugin;
      const grouped=Object.hasOwn(groupMembers,manifest.id);
      const members=groupMembers[manifest.id]?.map(id=>current.plugins.find(p=>p.manifest.id===id)).filter((p):p is ExtensionInfo=>!!p)??[plugin];
      const enabled=grouped?members.every(p=>p.enabled):plugin.enabled;
      const active=grouped?members.every(p=>p.status==='active'):plugin.status==='active';
      const status=grouped&&!enabled?'disabled':grouped&&active?'active':plugin.status;
      const action=(action:'enable'|'disable'|'uninstall'|'reload')=>perform(manifest.id,()=>window.berth.extensions({action,id:manifest.id}));
      const toggle=()=>grouped?perform(manifest.id,()=>window.berth.extensions({action:'bundle',id:manifest.id as 'agents'|'files',enabled:!enabled})):action(enabled&&plugin.installed?'disable':'enable');
      const label=labels[manifest.id];
      return <li key={manifest.id} data-plugin-id={manifest.id}><header><div><strong>{label?.name??manifest.name}</strong><span className={`extension-status ${status}`}>{!plugin.installed?'未安装':({active:'已启用',disabled:'已停用',blocked:'暂不可用',failed:'启动失败'})[status]}</span><small>{manifest.id} · {manifest.version}{plugin.builtin?' · 内置':''}{plugin.development?' · 开发模式':''}</small></div><div className="extension-actions">{plugin.installed&&<button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>openConfig(plugin)}>配置</button>}<button type="button" className="extension-button subtle" disabled={!!busy} aria-busy={busy===manifest.id} onClick={()=>void(!plugin.installed&&!plugin.builtin?perform('$install',()=>window.berth.installExtension(false)):toggle())}>{!plugin.installed?'安装':enabled?'停用':'启用'}</button>{!plugin.builtin&&plugin.installed&&<><button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>void action('reload')}>重新加载</button><button type="button" className="extension-button danger" disabled={!!busy} onClick={()=>void action('uninstall')}>卸载</button></>}</div></header>
      <p>{label?.description??manifest.description}</p>
      {plugin.error&&!grouped&&<p className="form-error" role="alert">{plugin.error}</p>}
      {grouped&&members.filter(p=>p.status==='failed').map(p=><p key={p.manifest.id} className="form-error" role="alert">{p.manifest.name}：{p.error}</p>)}
      {plugin.desktopError&&<p className="form-error" role="alert">桌面入口启动失败：{plugin.desktopError}。修复后重新加载插件。</p>}
      </li>;
    })}</ul>
    {mode==='agents'&&!plugins.length&&<p className="form-hint">尚无 Agent 接入。请启用内置接入或安装 Cordis Agent 插件。</p>}
    {configured&&<Dialog key={configured.manifest.id} title={'配置插件 · '+(labels[configured.manifest.id]?.name??configured.manifest.name)} busy={!!busy} dirty={dirty} error={configError} returnFocus={opener.current} onClose={()=>setEditing(null)}>
      <div className="extension-config-dialog">
        {configured.builtin&&settings&&<PluginSettingsPanel id={configured.manifest.id as BuiltinSettingsId} agents={agents} projects={projects} currentProjectId={currentProjectId} settings={settings} apiVersion={apiVersion} connected={connected} onError={setConfigError}/>}
        <form onSubmit={event=>{event.preventDefault();void saveConfig();}}>
          {Object.entries(configured.manifest.config).map(([key,field])=><label key={key}>{field.title}
            {field.type==='boolean'?<input aria-label={configured.manifest.name+' '+field.title} type="checkbox" checked={!!draft[key]} onChange={event=>setDraft({...draft,[key]:event.target.checked})}/>:field.enum?<select aria-label={configured.manifest.name+' '+field.title} value={String(draft[key]??'')} onChange={event=>setDraft({...draft,[key]:event.target.value})}>{field.enum.map(value=><option key={value} value={value}>{value}</option>)}</select>:<input aria-label={configured.manifest.name+' '+field.title} type={field.type==='number'?'number':'text'} min={field.minimum} max={field.maximum} value={draft[key] as string|number??''} onChange={event=>setDraft({...draft,[key]:field.type==='number'?Number(event.target.value):event.target.value})}/>}
            {field.description&&<small>{field.description}</small>}
          </label>)}
          {!configured.builtin&&Object.keys(configured.manifest.config).length===0&&configured.views.every(view=>view.location!=='settings')&&<p className="form-hint">此插件没有需要编辑的配置项。</p>}
          {configured.status==='active'&&configured.views.filter(view=>view.location==='settings').map(view=><section className="extension-dialog-view" key={view.id}><h3>{view.title}</h3><ExtensionView key={configured.generation+view.id} plugin={configured} viewId={view.id} onError={setConfigError}/></section>)}
          <footer><button className="extension-button subtle" type="button" onClick={()=>setEditing(null)} disabled={!!busy}>关闭</button>{dirty&&<button className="extension-button primary" type="submit" disabled={!!busy}>保存配置</button>}</footer>
        </form>
      </div>
    </Dialog>}
  </section>;
}
