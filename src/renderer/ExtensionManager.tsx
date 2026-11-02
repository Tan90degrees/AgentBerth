import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { extensionEnabled, type ExtensionInfo, type ExtensionSnapshot, type ExtensionConfig } from '../shared/extensions';
import { ExtensionView } from './ExtensionView';
import { PluginSettingsPanel } from './PluginSettingsPanel';
import { Dialog } from './Dialog';
import type { Project } from '../shared/protocol';

export const ExtensionsContext=createContext<ExtensionSnapshot|undefined>(undefined);
export const useExtension=(id:string)=>extensionEnabled(useContext(ExtensionsContext),id);

export function ExtensionManager({snapshot,onError,mode='all',openId,onOpenHandled,projects=[],currentProjectId,apiVersion=0}:{
  snapshot?:ExtensionSnapshot;onError:(error:string)=>void;mode?:'all'|'agents';
  openId?:string|null;onOpenHandled?:()=>void;
  projects?:Project[];currentProjectId?:string;apiVersion?:number;
}){
  const [current,setCurrent]=useState(snapshot),[busy,setBusy]=useState(''),[query,setQuery]=useState(''),[editing,setEditing]=useState<string|null>(null),[draft,setDraft]=useState<ExtensionConfig>({}),[message,setMessage]=useState(''),[configError,setConfigError]=useState('');
  const opener=useRef<HTMLElement|null>(null);
  useEffect(()=>setCurrent(snapshot),[snapshot]);
  const perform=async(id:string,action:()=>Promise<ExtensionSnapshot|null>)=>{setBusy(id);setMessage('');onError('');try{const next=await action();if(next){setCurrent(next);setEditing(null);setMessage('插件已更新，即时生效');}}catch(error){onError(String(error));}finally{setBusy('');}};
  const exportKit=async()=>{setBusy('$kit');try{const folder=await window.berth.exportPluginKit();if(folder){await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(folder));setMessage('开发套件已导出，开发指令已复制：'+folder);}}catch(error){onError(String(error));}finally{setBusy('');}};
  const plugins=current?.plugins.filter(plugin=>mode==='agents'?plugin.isAgent:!plugin.isAgent)??[];
  const configured=current?.plugins.find(plugin=>plugin.manifest.id===editing);
  const dirty=!!configured&&JSON.stringify(draft)!==JSON.stringify(configured.config);
  const canConfigure=(plugin:ExtensionInfo)=>Object.keys(plugin.manifest.config).length>0||plugin.manifest.id==='pet'||plugin.manifest.views.some(view=>view.location==='settings');
  const openConfig=(plugin:ExtensionInfo)=>{opener.current=document.activeElement as HTMLElement;setDraft({...plugin.config});setEditing(plugin.manifest.id);setConfigError('');onError('');};
  useEffect(()=>{
    if(!openId||!current)return;
    const plugin=current.plugins.find(value=>value.manifest.id===openId);
    if(plugin&&canConfigure(plugin)){openConfig(plugin);onOpenHandled?.();}
  },[openId,current?.revision]);
  const saveConfig=async()=>{if(!configured)return;setBusy(configured.manifest.id);onError('');try{const next=await window.berth.extensions({action:'configure',id:configured.manifest.id,config:draft});setCurrent(next);setEditing(null);setMessage('插件配置已保存，即时生效');}catch(error){setConfigError(String(error));}finally{setBusy('');}};
  if(!current)return <p>插件后台未连接。请检查后台服务。</p>;
  return <section className="extension-manager" aria-label="插件管理">
    <header><div><h2>{mode==='agents'?'Agent 接入':'扩展插件'}</h2><p>{mode==='agents'?'每个 Agent 都是独立的 Cordis 接入插件；Agent 注册、选择、历史和 Skills 管理由工作台核心提供。':'扩展用于增加功能或增强已有能力。项目、文件、Git、主题、SSH 等基础功能不在此管理。'}</p></div><div className="extension-actions"><button type="button" className="extension-button primary" disabled={!!busy} onClick={()=>void perform('$install',()=>window.berth.installExtension(false))}>{mode==='agents'?'安装 Agent 插件':'安装扩展插件'}</button><button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>void perform('$develop',()=>window.berth.installExtension(true))}>加载开发目录</button></div></header>
    <p className="form-hint">插件只负责提供可选接入或新增能力，不承载工作台基础服务。插件运行本机代码，请仅安装可信来源。</p>
    <div className="extension-utilities"><input aria-label="搜索插件" placeholder={mode==='agents'?'搜索 Agent 名称或插件 ID':'搜索扩展功能或插件 ID'} value={query} onChange={event=>setQuery(event.target.value)}/><button type="button" className="extension-button subtle" disabled={!!busy} aria-busy={busy==='$kit'} onClick={()=>void exportKit()}>导出插件开发套件并复制指令</button></div>
    {message&&<p role="status">{message}</p>}
    {current.warnings?.map(warning=><p className="form-error" key={warning}>{warning}</p>)}
    <ul className="extension-list">{plugins.filter(plugin=>`${plugin.manifest.name} ${plugin.manifest.id} ${plugin.manifest.description}`.toLowerCase().includes(query.toLowerCase())).map(plugin=>{
      const {manifest}=plugin;
      const action=(action:'enable'|'disable'|'uninstall'|'reload')=>perform(manifest.id,()=>window.berth.extensions({action,id:manifest.id}));
      const configurable=canConfigure(plugin);
      return <li key={manifest.id} data-plugin-id={manifest.id}><header><div><strong>{manifest.name}</strong><span className={`extension-status ${plugin.status}`}>{!plugin.installed?'未安装':({active:'已启用',disabled:'已停用',blocked:'等待依赖',failed:'启动失败'})[plugin.status]}</span><small>{manifest.id} · {manifest.version}{plugin.builtin?' · 内置接入':''}{plugin.development?' · 开发模式':''}</small></div><div className="extension-actions">{plugin.installed&&configurable&&<button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>openConfig(plugin)}>配置</button>}<button type="button" className="extension-button subtle" disabled={!!busy} aria-busy={busy===manifest.id} onClick={()=>void(!plugin.installed&&!plugin.builtin?perform('$install',()=>window.berth.installExtension(false)):action(plugin.enabled?'disable':'enable'))}>{!plugin.installed?'安装':plugin.enabled?'停用':'启用'}</button>{!plugin.builtin&&plugin.installed&&<><button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>void action('reload')}>重新加载</button><button type="button" className="extension-button danger" disabled={!!busy} onClick={()=>void action('uninstall')}>卸载</button></>}</div></header>
      <p>{manifest.description}</p>
      {plugin.error&&<p className="form-error" role="alert">{plugin.error}</p>}
      {plugin.desktopError&&<p className="form-error" role="alert">桌面入口启动失败：{plugin.desktopError}。修复后重新加载插件。</p>}
      </li>;
    })}</ul>
    {!plugins.length&&<p className="form-hint">{mode==='agents'?'尚无 Agent 接入插件。可安装内置 CLI 对应的接入，或导入自定义 Agent 插件。':'尚无扩展插件。可安装插件包或加载开发目录。'}</p>}
    {configured&&<Dialog key={configured.manifest.id} title={'配置插件 · '+configured.manifest.name} busy={!!busy} dirty={dirty} error={configError} returnFocus={opener.current} onClose={()=>setEditing(null)}>
      <div className="extension-config-dialog">
        {configured.manifest.id==='pet'&&<PluginSettingsPanel projects={projects} currentProjectId={currentProjectId} apiVersion={apiVersion}/>}
        <form onSubmit={event=>{event.preventDefault();void saveConfig();}}>
          {Object.entries(configured.manifest.config).map(([key,field])=><label key={key}>{field.title}
            {field.type==='boolean'?<input aria-label={configured.manifest.name+' '+field.title} type="checkbox" checked={!!draft[key]} onChange={event=>setDraft({...draft,[key]:event.target.checked})}/>:field.enum?<select aria-label={configured.manifest.name+' '+field.title} value={String(draft[key]??'')} onChange={event=>setDraft({...draft,[key]:event.target.value})}>{field.enum.map(value=><option key={value} value={value}>{value}</option>)}</select>:<input aria-label={configured.manifest.name+' '+field.title} type={field.type==='number'?'number':'text'} min={field.minimum} max={field.maximum} value={draft[key] as string|number??''} onChange={event=>setDraft({...draft,[key]:field.type==='number'?Number(event.target.value):event.target.value})}/>}
            {field.description&&<small>{field.description}</small>}
          </label>)}
          {configured.status==='active'&&configured.manifest.views.filter(view=>view.location==='settings').map(view=><section className="extension-dialog-view" key={view.id}><h3>{view.title}</h3><ExtensionView key={configured.generation+view.id} plugin={configured} viewId={view.id} onError={setConfigError}/></section>)}
          <footer><button className="extension-button subtle" type="button" onClick={()=>setEditing(null)} disabled={!!busy}>关闭</button>{dirty&&<button className="extension-button primary" type="submit" disabled={!!busy}>保存配置</button>}</footer>
        </form>
      </div>
    </Dialog>}
  </section>;
}
