import { useState } from 'react';
import { DEFAULT_SETTINGS, type Settings, type AgentDefinition, type AgentDefinitionConfig } from '../shared/protocol';
import { agentLabels } from './labels';
import { AgentManager } from './AgentManager';
import { TerminalFields } from './TerminalFields';
import { AppearanceControls } from './AppearanceControls';
import { PreviewSettings } from './PreviewSettings';
import { McpSettings } from './RemoteTerminal';
import { AboutCard } from './AboutCard';

export function SettingsPage({ connected, apiVersion, agents, usedAgents, onSaveAgent, onDeleteAgent, settings, draft, onChange, onDiscard, conflict, onError, error, platform, disabled, busy, restartDisabled, onSave, onRestart, running }: {
  connected: boolean; apiVersion: number; agents: AgentDefinition[]; usedAgents: string[]; onSaveAgent: (value: AgentDefinitionConfig, id?: string) => Promise<AgentDefinition | undefined>; onDeleteAgent: (id: string) => Promise<unknown>;
  settings: Settings; draft: Settings; onChange: (value: Settings) => void; onDiscard: () => void; conflict: boolean; onError: (error: string) => void; error: string;
  platform: string; disabled: boolean; busy: boolean; restartDisabled: boolean; onSave: (value: Settings) => Promise<boolean>; onRestart: () => void; running: number;
}) {
  const [saved, setSaved] = useState(false);
  const key = JSON.stringify(settings);
  const change = (value: Settings) => { onChange(value); setSaved(false); };
  return <section className="settings-page"><header><span className="eyebrow">PREFERENCES</span><h1>设置</h1><p>选择每个新终端的运行环境，让会话按你的习惯启动。</p></header>
    <AppearanceControls />
    <PreviewSettings />
    <form className="settings-card" onSubmit={async event => { event.preventDefault(); if (await onSave(draft)) setSaved(true); }}>
      <h2>终端与会话</h2>
      {conflict && <p className="draft-notice" role="status">后台设置已更新，当前草稿已保留。保存将应用此处的值，也可以取消修改以加载后台设置。</p>}
      {error && <div className="form-error" role="alert">{error.replace(/^Error: /, '')}</div>}
      <TerminalFields value={draft.terminal} platform={platform} disabled={disabled} onError={onError} onChange={terminal => change({ ...draft, terminal: terminal! })} />
      <p className="form-hint">选择工作台内的 Shell。系统默认在 Windows 使用 Windows PowerShell，在 Linux 使用当前用户 Shell。设置保存后用于下一次启动；单个会话可以指定自己的终端。</p>
      <label>默认 Agent<select aria-label="默认 Agent" value={draft.defaultAgent} disabled={disabled} onChange={event => change({ ...draft, defaultAgent: event.target.value as Settings['defaultAgent'] })}>{Object.entries(agentLabels(agents)).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      {draft.defaultAgent === 'custom' && <><label>默认启动命令<input aria-label="默认启动命令" required pattern=".*\S.*" title="请填写至少一个非空白字符" maxLength={4096} value={draft.defaultCommand} disabled={disabled} onChange={event => change({ ...draft, defaultCommand: event.target.value })} placeholder="例如 my-agent --interactive" /></label><p className="form-hint">保存后自动填入新建的自定义 Agent 会话，可在会话中单独修改。</p></>}
      <label>终端字号<input aria-label="终端字号" type="number" min={10} max={24} required value={draft.fontSize} disabled={disabled} onChange={event => change({ ...draft, fontSize: Number(event.target.value) })} /></label>
      <footer><span role="status">{saved ? '设置已保存' : JSON.stringify(draft) !== key ? '草稿已保留，保存后应用' : ''}</span>{JSON.stringify(draft) !== key && <button type="button" className="subtle" disabled={disabled} onClick={() => { onDiscard(); setSaved(false); }}>取消修改</button>}<button type="button" className="subtle" disabled={disabled} onClick={() => change(structuredClone(DEFAULT_SETTINGS))}>恢复默认值</button><button className="primary" disabled={disabled || JSON.stringify(draft) === key}>保存设置</button></footer>
    </form>
    <AgentManager hotUpdates={apiVersion >= 15} agents={agents} used={usedAgents} defaultAgent={settings.defaultAgent} disabled={disabled} busy={busy} error={error} onError={onError} onSave={onSaveAgent} onDelete={onDeleteAgent} />
    <section className="settings-card backend-card"><h2>后台服务</h2><p>{running ? `${running} 个终端正在后台运行。先停止全部终端，再更新后台。` : '安装新版本后，可在这里更新后台以加载新功能。项目、会话和设置会保留。'}</p><button className="subtle" disabled={restartDisabled || running > 0} onClick={onRestart}>更新后台</button></section>
    {apiVersion >= 20 && <McpSettings disabled={!connected} onError={onError} />}
    <AboutCard connected={connected} apiVersion={apiVersion} running={running} onError={onError} />
  </section>;
}
