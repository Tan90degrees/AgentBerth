import { useState } from 'react';
import { TERMINAL_LIMIT_MAX, type AgentDefinition, type Project, type Settings } from '../shared/protocol';
import { AppearanceControls } from './AppearanceControls';
import { PreviewSettings } from './PreviewSettings';
import { PetSettings } from './DesktopPet';
import { McpSettings } from './RemoteTerminal';
import { SshConnections } from './SshConnections';
import { SkillManager } from './SkillManager';
import { agentLabels } from './labels';

export type BuiltinSettingsId = 'appearance' | 'files' | 'agents' | 'ssh' | 'resources' | 'workspace';
export function PluginSettingsPanel({ id, agents, projects, currentProjectId, settings, apiVersion, connected, onError }: {
  id: BuiltinSettingsId;
  agents: AgentDefinition[];
  projects: Project[];
  currentProjectId?: string;
  settings: Settings;
  apiVersion: number;
  connected: boolean;
  onError: (value: string) => void;
}) {
  const [busy,setBusy] = useState(false);
  const save = async (value: Partial<Settings>) => {
    setBusy(true);
    try { await window.berth.rpc('saveSettings', {...settings,...value}); onError(''); }
    catch(error){ onError(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="plugin-builtin-settings">
    {id === 'appearance' && <AppearanceControls />}
    {id === 'files' && <PreviewSettings />}
    {id === 'agents' && <>
      <section className="settings-card">
        <h2>Agent 接入默认值</h2>
        <label>默认 Agent
          <select aria-label="默认 Agent" disabled={busy||!connected} value={settings.defaultAgent} onChange={event => void save({defaultAgent:event.target.value as Settings['defaultAgent']})}>
            {!['shell','codex','claude','opencode',...agents.map(a=>a.id)].includes(settings.defaultAgent)&&<option value={settings.defaultAgent}>已停用的 Agent</option>}
            {Object.entries(agentLabels(agents)).filter(([key])=>key!=='custom').map(([key,label])=><option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <p className="form-hint">此处仅配置 Agent 插件的默认启动类型；工作台核心设置不再重复展示。</p>
      </section>
      <PetSettings projects={projects} currentProjectId={currentProjectId} apiVersion={apiVersion} />
      <SkillManager agents={agents} projects={projects} currentProjectId={currentProjectId} />
    </>}
    {id === 'ssh' && <>
      <section className="settings-card">
        <h2>SSH 连接上限</h2>
        <label>SSH 会话上限<input type="number" aria-label="SSH 会话上限" min={1} max={TERMINAL_LIMIT_MAX} value={settings.maxSshTerminals} disabled={busy||!connected} onChange={event => {
          const value=Number(event.target.value);
          if(Number.isInteger(value)&&value>=1&&value<=TERMINAL_LIMIT_MAX)void save({maxSshTerminals:value});
        }}/></label>
        <p className="form-hint">与本机终端独立计数，保存后立即生效。</p>
      </section>
      {apiVersion>=22&&<SshConnections disabled={!connected||busy} onError={onError} />}
      {apiVersion>=21&&<McpSettings metricsSupported={apiVersion>=33} disabled={!connected} onError={onError}/>}
    </>}
    {id === 'resources' && <p className="form-hint">资源监控无额外配置，启用后在工作台展示资源用量。</p>}
    {id === 'workspace' && <p className="form-hint">工作区、终端和项目是应用基础能力，其全局参数在核心设置中配置。</p>}
  </div>;
}
