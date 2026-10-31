import { createContext, useContext, useEffect, useState } from 'react';
import { extensionEnabled, type ExtensionInfo, type ExtensionSnapshot, type ExtensionConfig } from '../shared/extensions';
import { ExtensionView } from './ExtensionView';

export const ExtensionsContext=createContext<ExtensionSnapshot|undefined>(undefined);
export const useExtension=(id:string)=>extensionEnabled(useContext(ExtensionsContext),id);
export function ExtensionManager({snapshot,onError,onConfigureBuiltin}:{snapshot?:ExtensionSnapshot;onError:(error:string)=>void;onConfigureBuiltin?:Record<string,()=>void>}){
  const [current,setCurrent]=useState(snapshot),[busy,setBusy]=useState(''),[query,setQuery]=useState(''),[drafts,setDrafts]=useState<Record<string,ExtensionConfig>>({}),[message,setMessage]=useState('');
  useEffect(()=>setCurrent(snapshot),[snapshot]);
  const perform=async(id:string,action:()=>Promise<ExtensionSnapshot|null>)=>{setBusy(id);setMessage('');onError('');try{const next=await action();if(next){setCurrent(next);setDrafts({});setMessage('插件已更新，即时生效');}}catch(error){onError(String(error));}finally{setBusy('');}};
  const exportKit=async()=>{setBusy('$kit');try{const folder=await window.berth.exportPluginKit();if(folder){await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(folder));setMessage('开发套件已导出，开发指令已复制：'+folder);}}catch(error){onError(String(error));}finally{setBusy('');}};
  if(!current)return <p>更新空闲后台至 API 41 后可管理 Cordis 插件。</p>;
  return <section className="extension-manager" aria-label="插件管理">
    <header><div><h2>插件</h2><p>安装、配置和启停即时生效。Agent 接入与它的 Skills 统一管理。</p></div><div className="extension-actions"><button type="button" className="primary" disabled={!!busy} onClick={()=>void perform('$install',()=>window.berth.installExtension(false))}>安装插件包</button><button type="button" className="subtle" disabled={!!busy} onClick={()=>void perform('$develop',()=>window.berth.installExtension(true))}>加载开发目录</button></div></header>
    <p className="form-hint">插件包运行本机代码，请安装可信来源。卸载保留配置与数据；开发目录修改后自动重载。</p><button type="button" className="subtle" disabled={!!busy} aria-busy={busy==='$kit'} onClick={()=>void exportKit()}>导出插件开发套件并复制指令</button>
    <input aria-label="搜索插件" placeholder="搜索名称、能力或插件 ID" value={query} onChange={event=>setQuery(event.target.value)}/>
    {message&&<p role="status">{message}</p>}
    {current.warnings?.map(warning=><p className="form-error" key={warning}>{warning}</p>)}
    <ul className="extension-list">{current.plugins.filter(p=>`${p.manifest.name} ${p.manifest.id} ${p.manifest.description}`.toLowerCase().includes(query.toLowerCase())).map(plugin=>{
      const {manifest}=plugin,draft=drafts[manifest.id]??plugin.config,changed=JSON.stringify(draft)!==JSON.stringify(plugin.config);
      const action=(action:'enable'|'disable'|'uninstall'|'reload')=>perform(manifest.id,()=>window.berth.extensions({action,id:manifest.id}));
      return <li key={manifest.id} data-plugin-id={manifest.id}><header><div><strong>{manifest.name}</strong><span className={`extension-status ${plugin.status}`}>{!plugin.installed?'未安装':({active:'已启用',disabled:'已停用',blocked:'等待依赖',failed:'启动失败'})[plugin.status]}</span><small>{manifest.id} · {manifest.version}{plugin.builtin?' · 内置':''}{plugin.development?' · 开发模式':''}</small></div><div className="extension-actions">{plugin.builtin&&plugin.status==='active'&&onConfigureBuiltin?.[manifest.id]&&<button type="button" className="text-button" disabled={!!busy} onClick={onConfigureBuiltin[manifest.id]}>配置</button>}<button type="button" className="subtle" disabled={!!busy} aria-busy={busy===manifest.id} onClick={()=>void(!plugin.installed&&!plugin.builtin?perform('$install',()=>window.berth.installExtension(false)):action(plugin.enabled&&plugin.installed?'disable':'enable'))}>{!plugin.installed?'安装':plugin.enabled?'停用':'启用'}</button>{plugin.installed&&<><button type="button" className="text-button" disabled={!!busy} onClick={()=>void action('reload')}>重新加载</button><button type="button" className="text-button danger" disabled={!!busy} onClick={()=>void action('uninstall')}>卸载</button></>}</div></header>
      <p>{manifest.description}</p>{manifest.dependencies.length>0&&<small>依赖：{manifest.dependencies.map(id=>current.plugins.find(p=>p.manifest.id===id)?.manifest.name??id).join('、')}</small>}
      {plugin.error&&<p className="form-error" role="alert">{plugin.error}</p>}
      {plugin.desktopError&&<p className="form-error" role="alert">桌面入口启动失败：{plugin.desktopError}。修复后重新加载插件。</p>}
      {plugin.installed&&Object.keys(manifest.config).length>0&&<form onSubmit={event=>{event.preventDefault();void perform(manifest.id,()=>window.berth.extensions({action:'configure',id:manifest.id,config:draft}));}}><div className="extension-fields">{Object.entries(manifest.config).map(([key,field])=><label key={key}>{field.title}{field.type==='boolean'?<input aria-label={`${manifest.name} ${field.title}`} type="checkbox" checked={!!draft[key]} onChange={e=>setDrafts({...drafts,[manifest.id]:{...draft,[key]:e.target.checked}})}/>:field.enum?<select aria-label={`${manifest.name} ${field.title}`} value={String(draft[key]??'')} onChange={e=>setDrafts({...drafts,[manifest.id]:{...draft,[key]:e.target.value}})}>{field.enum.map(value=><option key={value}>{value}</option>)}</select>:<input aria-label={`${manifest.name} ${field.title}`} type={field.type==='number'?'number':'text'} min={field.minimum} max={field.maximum} value={draft[key] as string|number??''} onChange={e=>setDrafts({...drafts,[manifest.id]:{...draft,[key]:field.type==='number'?Number(e.target.value):e.target.value}})}/>}<small>{field.description}</small></label>)}</div><button type="submit" className="subtle" disabled={!!busy||!changed}>应用配置</button></form>}
      {plugin.status==='active'&&plugin.views.filter(view=>view.location==='settings').map(view=><details key={view.id}><summary>{view.title}</summary><ExtensionView key={plugin.generation+view.id} plugin={plugin} viewId={view.id} onError={onError}/></details>)}
      </li>;
    })}</ul>
  </section>;
}
