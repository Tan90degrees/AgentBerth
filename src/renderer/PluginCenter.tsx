import { useContext } from 'react';
import { ExtensionManager, ExtensionsContext } from './ExtensionManager';
import type { AgentDefinition, Project, Settings } from '../shared/protocol';

export type PluginCenterTab = 'installed' | 'agents';
const tabs: {id:PluginCenterTab;title:string;description:string}[]=[
  {id:'installed',title:'已安装插件',description:'按功能包整体管理和配置'},
  {id:'agents',title:'Agent 接入',description:'内置与自定义 Agent 统一管理'},
];
export function PluginCenter({tab,onTabChange,agents,projects,currentProjectId,settings,apiVersion,connected,onError,openPluginId,onOpenHandled}:{
  tab:PluginCenterTab;onTabChange:(tab:PluginCenterTab)=>void;
  agents:AgentDefinition[];projects:Project[];currentProjectId?:string;settings:Settings;
  apiVersion:number;connected:boolean;onError:(error:string)=>void;
  openPluginId?:string|null;onOpenHandled?:()=>void;
}){
  const snapshot=useContext(ExtensionsContext);
  const visible=snapshot?.plugins.filter(p=>!['workspace','agent.codex','agent.claude','agent.opencode','pet','git'].includes(p.manifest.id))??[];
  const installed=visible.filter(p=>p.installed).length;
  const active=visible.filter(p=>p.status==='active').length;
  const agentCount=visible.filter(p=>p.isAgent||p.manifest.id==='agents').length;
  return <section className="plugin-center" aria-label="插件中心">
    <header className="plugin-center-heading"><div>
      <span className="eyebrow">EXTENSIONS</span><h1>插件中心</h1>
      <p>插件与核心设置完全隔离。Git 和文件管理、Agent 与桌宠分别作为统一功能包；每个插件只在自己的配置弹窗内展示设置。</p>
    </div><div className="plugin-center-summary" aria-label="插件运行概览">
      <span><strong>{installed}</strong><small>功能包</small></span><span><strong>{active}</strong><small>已启用</small></span><span><strong>{agentCount}</strong><small>Agent 接入</small></span>
    </div></header>
    <nav className="plugin-center-tabs" aria-label="插件分类">{tabs.map(item=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} className={tab===item.id?'selected':''} onClick={()=>onTabChange(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}</nav>
    <div className="plugin-center-content">
      <ExtensionManager snapshot={snapshot} mode={tab==='agents'?'agents':'all'} onError={onError} openId={openPluginId} onOpenHandled={onOpenHandled} agents={agents} projects={projects} currentProjectId={currentProjectId} settings={settings} apiVersion={apiVersion} connected={connected}/>
    </div>
  </section>;
}
