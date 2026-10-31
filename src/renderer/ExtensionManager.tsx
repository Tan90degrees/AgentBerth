import { createContext, useContext, useEffect, useState } from 'react';
import { extensionEnabled, type ExtensionInfo, type ExtensionSnapshot, type ExtensionConfig } from '../shared/extensions';
import { ExtensionView } from './ExtensionView';
import { Dialog } from './Dialog';
import { useRef } from 'react';

export const ExtensionsContext=createContext<ExtensionSnapshot|undefined>(undefined);
export const useExtension=(id:string)=>extensionEnabled(useContext(ExtensionsContext),id);
export function ExtensionManager({snapshot,onError,onConfigureBuiltin,mode='all'}:{snapshot?:ExtensionSnapshot;onError:(error:string)=>void;onConfigureBuiltin?:Record<string,()=>void>;mode?:'all'|'agents'}){
  const [current,setCurrent]=useState(snapshot),[busy,setBusy]=useState(''),[query,setQuery]=useState(''),[editing,setEditing]=useState<string|null>(null),[draft,setDraft]=useState<ExtensionConfig>({}),[message,setMessage]=useState('');
  const opener=useRef<HTMLElement|null>(null);
  useEffect(()=>setCurrent(snapshot),[snapshot]);
  const perform=async(id:string,action:()=>Promise<ExtensionSnapshot|null>)=>{setBusy(id);setMessage('');onError('');try{const next=await action();if(next){setCurrent(next);setEditing(null);setMessage('插件已更新，即时生效');}}catch(error){onError(String(error));}finally{setBusy('');}};
  const exportKit=async()=>{setBusy('$kit');try{const folder=await window.berth.exportPluginKit();if(folder){await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(folder));setMessage('开发套件已导出，开发指令已复制：'+folder);}}catch(error){onError(String(error));}finally{setBusy('');}};
  const plugins=current?.plugins.filter(plugin=>mode==='all'||plugin.isAgent)??[];
  const configured=current?.plugins.find(plugin=>plugin.manifest.id===editing);
  const dirty=!!configured&&JSON.stringify(draft)!==JSON.stringify(configured.config);
  const openConfig=(plugin:ExtensionInfo)=>{opener.current=document.activeElement as HTMLElement;setDraft({...plugin.config});setEditing(plugin.manifest.id);onError('');};
  const saveConfig=async()=>{if(!configured)return;setBusy(configured.manifest.id);onError('');try{const next=await window.berth.extensions({action:'configure',id:configured.manifest.id,config:draft});setCurrent(next);setEditing(null);setMessage('插件配置已保存，即时生效');}catch(error){onError(String(error));}finally{setBusy('');}};
  if(!current)return <p>插件后台未连接。请检查后台服务。</p>;
  return <section className="extension-manager" aria-label="插件管理">
    <header><div><h2>{mode==='agents'?'Agent 接入':'插件'}</h2><p>{mode==='agents'?'Codex、Claude Code、OpenCode 和自定义 Agent 都是同级插件，统一安装、配置、启停和卸载；Skills 随接入生效。':'安装、配置和启停即时生效。Agent 接入与它的 Skills 统一管理。'}</p></div><div className="extension-actions"><button type="button" className="extension-button primary" disabled={!!busy} onClick={()=>void perform('$install',()=>window.berth.installExtension(false))}>{mode==='agents'?'安装 Agent 插件包':'安装插件包'}</button><button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>void perform('$develop',()=>window.berth.installExtension(true))}>加载开发目录</button></div></header>
    <p className="form-hint">{mode==='agents'?'Agent 接入只接受 Cordis 插件包；自定义与内置 Agent 使用相同的插件生命周期。':'插件配置在独立弹窗中编辑；开发目录修改后自动重载。'} 插件运行本机代码，请仅安装可信来源。</p>
    <div className="extension-utilities"><input aria-label="搜索插件" placeholder={mode==='agents'?'搜索 Agent 接入或插件 ID':'搜索名称、能力或插件 ID'} value={query} onChange={event=>setQuery(event.target.value)}/><button type="button" className="extension-button subtle" disabled={!!busy} aria-busy={busy==='$kit'} onClick={()=>void exportKit()}>导出插件开发套件并复制指令</button></div>
    {message&&<p role="status">{message}</p>}
    {current.warnings?.map(warning=><p className="form-error" key={warning}>{warning}</p>)}
    <ul className="extension-list">{plugins.filter(p=>`${p.manifest.name} ${p.manifest.id} ${p.manifest.description}`.toLowerCase().includes(query.toLowerCase())).map(plugin=>{
      const {manifest}=plugin;
      const action=(action:'enable'|'disable'|'uninstall'|'reload')=>perform(manifest.id,()=>window.berth.extensions({action,id:manifest.id}));
      return <li key={manifest.id} data-plugin-id={manifest.id}><header><div><strong>{manifest.name}</strong><span className={`extension-status ${plugin.status}`}>{!plugin.installed?'未安装':({active:'已启用',disabled:'已停用',blocked:'等待依赖',failed:'启动失败'})[plugin.status]}</span><small>{manifest.id} · {manifest.version}{plugin.builtin?' · 内置':''}{plugin.development?' · 开发模式':''}</small></div><div className="extension-actions">{plugin.installed&&(Object.keys(manifest.config).length>0||plugin.views.some(view=>view.location==='settings'))&&<button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>openConfig(plugin)}>配置</button>}{plugin.builtin&&plugin.status==='active'&&onConfigureBuiltin?.[manifest.id]&&<button type="button" className="extension-button subtle" disabled={!!busy} onClick={onConfigureBuiltin[manifest.id]}>功能设置</button>}<button type="button" className="extension-button subtle" disabled={!!busy} aria-busy={busy===manifest.id} onClick={()=>void(!plugin.installed&&!plugin.builtin?perform('$install',()=>window.berth.installExtension(false)):action(plugin.enabled&&plugin.installed?'disable':'enable'))}>{!plugin.installed?'安装':plugin.enabled?'停用':'启用'}</button>{plugin.installed&&<><button type="button" className="extension-button subtle" disabled={!!busy} onClick={()=>void action('reload')}>重新加载</button><button type="button" className="extension-button danger" disabled={!!busy} onClick={()=>void action('uninstall')}>卸载</button></>}</div></header>
      <p>{manifest.description}</p>{manifest.dependencies.length>0&&<small>依赖：{manifest.dependencies.map(id=>current.plugins.find(p=>p.manifest.id===id)?.manifest.name??id).join('、')}</small>}
      {plugin.error&&<p className="form-error" role="alert">{plugin.error}</p>}
      {plugin.desktopError&&<p className="form-error" role="alert">桌面入口启动失败：{plugin.desktopError}。修复后重新加载插件。</p>}
      {plugin.installed&&Object.keys(manifest.config).length>0&&<form onSubmit={event=>{event.preventDefault();void perform(manifest.id,()=>window.berth.extensions({action:'configure',id:manifest.id,config:draft}));}}><div className="extension-fields">{Object.entries(manifest.config).map(([key,field])=><label key={key}>{field.title}{field.type==='boolean'?<input aria-label={`${manifest.name} ${field.title}`} type="checkbox" checked={!!draft[key]} onChange={e=>setDrafts({...drafts,[manifest.id]:{...draft,[key]:e.target.checked}})}/>:field.enum?<select aria-label={`${manifest.name} ${field.title}`} value={String(draft[key]??'')} onChange={e=>setDrafts({...drafts,[manifest.id]:{...draft,[key]:e.target.value}})}>{field.enum.map(value=><option key={value}>{value}</option>)}</select>:<input aria-label={`${manifest.name} ${field.title}`} type={field.type==='number'?'number':'text'} min={field.minimum} max={field.maximum} value={draft[key] as string|number??''} onChange={e=>setDrafts({...drafts,[manifest.id]:{...draft,[key]:field.type==='number'?Number(e.target.value):e.target.value}})}/>}<small>{field.description}</small></label>)}</div><button type="submit" className="extension-button primary" disabled={!!busy||!changed}>应用配置</button></form>}
      {plugin.status==='active'&&plugin.views.filter(view=>view.location==='settings').map(view=><details key={view.id}><summary>{view.title}</summary><ExtensionView key={plugin.generation+view.id} plugin={plugin} viewId={view.id} onError={onError}/></details>)}
      </li>;
    })}</ul>
    {mode==='agents'&&!plugins.length&&<p className="form-hint">尚无 Agent 接入。请启用内置接入或安装 Cordis Agent 插件。</p>}
  </section>;
}
