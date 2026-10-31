import { useContext, type ReactNode } from 'react';
import { ExtensionManager, ExtensionsContext } from './ExtensionManager';
import { SkillManager } from './SkillManager';
import type { AgentDefinition, Project } from '../shared/protocol';

export type PluginCenterTab = 'installed' | 'agents' | 'skills';

const tabs: { id: PluginCenterTab; title: string; description: string }[] = [
  { id: 'installed', title: '已安装插件', description: '管理所有 Cordis 插件与内置功能' },
  { id: 'agents', title: 'Agent 接入', description: 'Codex、Claude Code、OpenCode 与自定义 Agent' },
  { id: 'skills', title: 'Skills', description: '管理 Agent 提供的技能和作用范围' },
];

/** A first-class workbench page. Core settings never mounts plugin lifecycle controls. */
export function PluginCenter({ tab, onTabChange, agents, projects, currentProjectId, onError }: {
  tab: PluginCenterTab;
  onTabChange: (tab: PluginCenterTab) => void;
  agents: AgentDefinition[];
  projects: Project[];
  currentProjectId?: string;
  onError: (error: string) => void;
}) {
  const snapshot = useContext(ExtensionsContext);
  const installed = snapshot?.plugins.filter(plugin => plugin.installed).length ?? 0;
  const active = snapshot?.plugins.filter(plugin => plugin.status === 'active').length ?? 0;
  const agentCount = snapshot?.plugins.filter(plugin => plugin.isAgent && plugin.installed).length ?? 0;
  return <section className="plugin-center" aria-label="插件中心">
    <header className="plugin-center-heading">
      <div>
        <span className="eyebrow">EXTENSIONS</span>
        <h1>插件中心</h1>
        <p>所有插件统一管理，核心配置留在独立的设置页面。安装、启停、更新即时生效，详细配置使用弹窗。</p>
      </div>
      <div className="plugin-center-summary" aria-label="插件运行概览">
        <span><strong>{installed}</strong><small>已安装</small></span>
        <span><strong>{active}</strong><small>运行中</small></span>
        <span><strong>{agentCount}</strong><small>Agent 接入</small></span>
      </div>
    </header>
    <nav className="plugin-center-tabs" aria-label="插件分类">
      {tabs.map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'selected' : ''} onClick={() => onTabChange(item.id)}>
        <strong>{item.title}</strong><small>{item.description}</small>
      </button>)}
    </nav>
    <div className="plugin-center-content">
      {tab === 'installed' && <ExtensionManager snapshot={snapshot} onError={onError} />}
      {tab === 'agents' && <ExtensionManager snapshot={snapshot} onError={onError} mode="agents" />}
      {tab === 'skills' && <SkillManager agents={agents} projects={projects} currentProjectId={currentProjectId} />}
    </div>
  </section>;
}
