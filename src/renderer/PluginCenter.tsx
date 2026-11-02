import { useContext } from 'react';
import { ExtensionManager, ExtensionsContext } from './ExtensionManager';
import type { Project } from '../shared/protocol';

export type PluginCenterTab = 'installed' | 'agents';
const tabs: {id:PluginCenterTab;title:string;description:string}[]=[
  {id:'installed',title:'扩展插件',description:'新增功能和可选增强能力'},
  {id:'agents',title:'Agent 接入',description:'每个 Agent 独立作为接入插件'},
];
export function PluginCenter({tab,onTabChange,projects,currentProjectId,apiVersion,onError,openPluginId,onOpenHandled}:{
  tab:PluginCenterTab;onTabChange:(tab:PluginCenterTab)=>void;
  projects:Project[];currentProjectId?:string;apiVersion:number;
  onError:(error:string)=>void;openPluginId?:string|null;onOpenHandled?:()=>void;
}){
  const snapshot=useContext(ExtensionsContext);
  const visible=snapshot?.plugins.filter(p=>tab==='agents'?p.isAgent:!p.isAgent)??[];
  const installed=visible.filter(p=>p.installed).length;
  const active=visible.filter(p=>p.status==='active').length;
  return <section className="plugin-center" aria-label="插件中心">
    <header className="plugin-center-heading"><div>
      <span className="eyebrow">EXTENSIONS</span><h1>插件中心</h1>
      <p>工作台基础能力始终可用；这里仅管理 Agent 接入插件和额外扩展。主题、文件、Git、SSH、Agent 注册中心等不作为插件开关。</p>
    </div><div className="plugin-center-summary" aria-label="插件运行概览">
      <span><strong>{installed}</strong><small>{tab==='agents'?'Agent 接入':'扩展插件'}</small></span><span><strong>{active}</strong><small>已启用</small></span>
    </div></header>
    <nav className="plugin-center-tabs" aria-label="插件分类">{tabs.map(item=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} className={tab===item.id?'selected':''} onClick={()=>onTabChange(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}</nav>
    <div className="plugin-center-content">
      <ExtensionManager snapshot={snapshot} mode={tab==='agents'?'agents':'all'} onError={onError} openId={openPluginId} onOpenHandled={onOpenHandled} projects={projects} currentProjectId={currentProjectId} apiVersion={apiVersion}/>
    </div>
  </section>;
}
