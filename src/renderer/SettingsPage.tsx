import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '../shared/protocol';
import { agentNames } from './labels';
import { TerminalFields } from './TerminalFields';

export function SettingsPage({ settings, platform, disabled, restartDisabled, onSave, onRestart, running }: {
  settings: Settings; platform: string; disabled: boolean; restartDisabled: boolean; onSave: (value: Settings) => Promise<boolean>; onRestart: () => void; running: number;
}) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const key = JSON.stringify(settings);
  useEffect(() => { setDraft(JSON.parse(key)); }, [key]);
  const change = (value: Settings) => { setDraft(value); setSaved(false); };
  return <section className="settings-page"><header><span className="eyebrow">PREFERENCES</span><h1>设置</h1><p>选择每个新终端的运行环境，让会话按你的习惯启动。</p></header>
    <form className="settings-card" onSubmit={async event => { event.preventDefault(); if (await onSave(draft)) setSaved(true); }}>
      <h2>终端与会话</h2>
      <TerminalFields value={draft.terminal} platform={platform} disabled={disabled} onChange={terminal => change({ ...draft, terminal: terminal! })} />
      <p className="form-hint">选择工作台内的 Shell。系统默认在 Windows 使用 Windows PowerShell，在 Linux 使用当前用户 Shell。设置保存后用于下一次启动；单个会话可以指定自己的终端。</p>
      <label>默认 Agent<select aria-label="默认 Agent" value={draft.defaultAgent} disabled={disabled} onChange={event => change({ ...draft, defaultAgent: event.target.value as Settings['defaultAgent'] })}>{Object.entries(agentNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label>终端字号<input aria-label="终端字号" type="number" min={10} max={24} required value={draft.fontSize} disabled={disabled} onChange={event => change({ ...draft, fontSize: Number(event.target.value) })} /></label>
      <footer><span role="status">{saved ? '设置已保存' : JSON.stringify(draft) !== key ? '有未保存的修改' : ''}</span><button type="button" className="subtle" disabled={disabled} onClick={() => change(structuredClone(DEFAULT_SETTINGS))}>恢复默认值</button><button className="primary" disabled={disabled || JSON.stringify(draft) === key}>保存设置</button></footer>
    </form>
    <section className="settings-card backend-card"><h2>后台服务</h2><p>{running ? `${running} 个终端正在后台运行。先停止全部终端，再更新后台。` : '安装新版本后，可在这里更新后台以加载新功能。项目、会话和设置会保留。'}</p><button className="subtle" disabled={restartDisabled || running > 0} onClick={onRestart}>更新后台</button></section>
  </section>;
}
