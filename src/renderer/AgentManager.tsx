import { useRef, useState } from 'react';
import type { AgentDefinition, AgentDefinitionConfig } from '../shared/protocol';
import { Dialog } from './Dialog';

type Draft = { name: string; command: string; resumeCommand: string; enabled: boolean; executable: string; args: string; history: boolean; resume: boolean; runtime?: 'node' | 'executable'; sourceId?: string };
const empty: Draft = { name: '', command: '', resumeCommand: '', enabled: false, executable: '', args: '[]', history: true, resume: false };
export function AgentManager({ agents, defaultAgent, used, disabled, busy, error, onSave, onDelete, onError }: {
  agents: AgentDefinition[]; defaultAgent: string; used: string[]; disabled: boolean; busy: boolean; error: string; onError: (value: string) => void;
  onSave: (value: AgentDefinitionConfig, id?: string) => Promise<AgentDefinition | undefined>; onDelete: (id: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [kitFolder, setKitFolder] = useState('');
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState('');
  const initial = useRef('');
  const opener = useRef<HTMLElement | null>(null);
  const change = (value: Partial<Draft>) => { setDraft(previous => ({ ...previous, ...value })); setLocalError(''); };
  const open = (agent?: AgentDefinitionConfig & { id?: string }) => {
    opener.current = document.activeElement as HTMLElement;
    const value = agent ? { name: agent.name, command: agent.command, resumeCommand: agent.resumeCommand, enabled: !!agent.plugin, executable: agent.plugin?.executable ?? '', args: JSON.stringify(agent.plugin?.args ?? [], null, 2), history: agent.plugin?.history ?? true, resume: agent.plugin?.resume ?? false, runtime: agent.plugin?.runtime, sourceId: agent.plugin?.sourceId } : { ...empty };
    setDraft(value); initial.current = JSON.stringify(value); setEditing(agent?.id ?? 'new'); setLocalError(''); onError('');
  };
  async function task(work: () => Promise<void>) {
    setWorking(true); setNotice(''); onError('');
    try { await work(); } catch (reason) { onError(String(reason)); } finally { setWorking(false); }
  }
  async function check(agent: AgentDefinition) {
    await task(async () => {
      setChecks(previous => ({ ...previous, [agent.id]: '正在检查…' }));
      try { const result = await window.berth.rpc<{ message: string }>('checkAgentPlugin', { agentId: agent.id }); setChecks(previous => ({ ...previous, [agent.id]: result.message })); }
      catch (reason) { setChecks(previous => ({ ...previous, [agent.id]: '检查失败，查看提示后重新导入' })); throw reason; }
    });
  }
  const blocked = disabled || working;
  return <section className="settings-card agent-manager"><div className="agent-manager-heading"><div><h2>自定义 Agent 类型</h2><p>保存多种 Agent，分别配置启动命令和扩展能力。会话保存独立启动命令；类型的启动命令修改用于新建会话。</p></div><div className="agent-manager-buttons"><button className="primary" disabled={blocked || agents.length >= 64} onClick={() => void task(async () => { const value = await window.berth.importAgentPlugin(); if (value) { const previous = agents.find(agent => agent.plugin?.sourceId && agent.plugin.sourceId === value.plugin?.sourceId); open({ ...value, id: previous?.id }); } })}>导入插件</button><button className="subtle" disabled={blocked || agents.length >= 64} onClick={() => open()}>新增 Agent 类型</button></div></div>
    <ul className="agent-definitions">{agents.map(agent => <li key={agent.id}><div><strong>{agent.name}</strong>{defaultAgent === agent.id && <span className="badge">默认</span>}<code title={agent.command}>{agent.command}</code><small>{[agent.plugin?.history && '历史插件', agent.plugin?.resume ? '恢复插件' : agent.resumeCommand && '恢复命令'].filter(Boolean).join(' · ') || '终端会话'}</small>{checks[agent.id] && <small className="plugin-check" role="status">{checks[agent.id]}</small>}</div><div>{agent.plugin && <button className="subtle" aria-label={`检查插件 ${agent.name}`} disabled={blocked} onClick={() => void check(agent)}>检查插件</button>}<button className="subtle" aria-label={`编辑 Agent ${agent.name}`} disabled={blocked} onClick={() => open(agent)}>编辑</button><button className="subtle danger-text" aria-label={`删除 Agent ${agent.name}`} disabled={disabled || used.includes(agent.id) || defaultAgent === agent.id} title={defaultAgent === agent.id ? '先更换默认 Agent' : used.includes(agent.id) ? '仍被会话使用，请先修改或删除会话' : '删除此类型'} onClick={() => void onDelete(agent.id)}>删除</button></div></li>)}</ul>
    {!agents.length && <p className="form-hint">例如分别保存 Aider、Gemini CLI 或不同启动参数的 Agent。旧版“自定义 Agent”会话继续可用。</p>}
    <p className="form-hint">选择插件的 agentberth-plugin.json 即可安装。程序、参数和能力自动填写；Node 插件使用软件自带运行时。</p><div className="plugin-development"><strong>让 Agent 帮你开发插件</strong><p>导出完整开发套件，或复制包含协议、示例和验收要求的指令，直接交给编程 Agent。</p><div><button className="subtle" disabled={blocked} onClick={() => void task(async () => { const folder = await window.berth.exportPluginKit(); if (folder) { setKitFolder(folder); await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(folder)); setNotice('开发套件已导出，给 Agent 的开发指令已复制'); } })}>导出开发套件</button><button className="subtle" disabled={blocked} onClick={() => void task(async () => { await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(kitFolder || undefined)); setNotice('完整开发指令已复制，可直接粘贴给 Agent'); })}>复制 Agent 开发指令</button></div>{kitFolder && <code>{kitFolder}</code>}{notice && <p role="status">{notice}</p>}</div>
    {editing && <Dialog title={editing === 'new' ? '新增 Agent 类型' : '编辑 Agent 类型'} dirty={JSON.stringify(draft) !== initial.current} busy={busy || working} error={localError || error} returnFocus={opener.current} onClose={() => { setEditing(null); onError(''); }}><form onSubmit={async event => {
      event.preventDefault(); setLocalError(''); onError('');
      try {
        const args: unknown = draft.enabled ? JSON.parse(draft.args) : [];
        if (draft.enabled && (!Array.isArray(args) || args.some(value => typeof value !== 'string'))) throw new Error('插件参数须为 JSON 字符串数组，例如 ["D:/plugins/history.cjs"]');
        const value: AgentDefinitionConfig = { name: draft.name, command: draft.command, resumeCommand: draft.resumeCommand, plugin: draft.enabled ? { executable: draft.executable, args: args as string[], history: draft.history, resume: draft.resume, ...(draft.runtime ? { runtime: draft.runtime } : {}), ...(draft.sourceId ? { sourceId: draft.sourceId } : {}) } : null };
        setWorking(true);
        if (draft.sourceId && draft.enabled) await window.berth.rpc('probeAgentPlugin', value);
        const result = await onSave(value, editing === 'new' ? undefined : editing);
        if (result) { if (draft.sourceId) setChecks(previous => ({ ...previous, [result.id]: '插件连接正常' })); setEditing(null); }
      } catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); } finally { setWorking(false); }
    }}>
      <label>类型名称<input aria-label="类型名称" required maxLength={100} value={draft.name} onChange={event => change({ name: event.target.value })} placeholder="例如 Aider" /></label>
      <label>类型启动命令<input aria-label="类型启动命令" required maxLength={4096} value={draft.command} onChange={event => change({ command: event.target.value })} placeholder="例如 aider --model …" /></label>
      {draft.sourceId && <div className="imported-plugin" role="status">插件已导入 · {draft.runtime === 'node' ? '自带运行时，无需安装 Node' : '独立程序'} · {draft.history ? '对话历史' : ''}{draft.resume ? ' / 原生恢复' : ''}<p>点击保存即可使用。更新插件时重新导入同一插件文件。</p></div>}<details className="advanced-options"><summary>高级选项（可选）</summary><label>恢复命令（可选）<input aria-label="类型恢复命令" maxLength={4096} value={draft.resumeCommand} onChange={event => change({ resumeCommand: event.target.value })} placeholder="例如 my-agent --resume {sessionId}" /></label>
      <p className="form-hint">恢复命令用 {'{sessionId}'} 填入关联的原生 ID。启用恢复插件时，由插件提供命令。</p>
      <label className="checkbox-label"><input aria-label="启用 Agent 插件" type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />启用本地扩展插件</label>
      {draft.enabled && <><label>插件程序<div className="input-with-button"><input aria-label="插件程序" required value={draft.executable} onChange={event => change({ executable: event.target.value })} placeholder="完整程序路径，例如 C:\\Program Files\\nodejs\\node.exe" /><button type="button" className="subtle" onClick={async () => { try { const value = await window.berth.chooseExecutable(); if (value) change({ executable: value }); } catch (reason) { setLocalError(String(reason)); } }}>选择程序</button></div></label>
        <label>插件参数（JSON 数组）<textarea aria-label="插件参数" rows={3} value={draft.args} onChange={event => change({ args: event.target.value })} /></label>
        <label className="checkbox-label"><input aria-label="插件对话历史" type="checkbox" checked={draft.history} onChange={event => change({ history: event.target.checked })} />读取和刷新对话历史</label>
        <label className="checkbox-label"><input aria-label="插件会话恢复" type="checkbox" checked={draft.resume} onChange={event => change({ resume: event.target.checked })} />生成会话恢复命令</label>
        <p className="form-hint">仅调用你配置的本地程序，插件拥有本机程序权限。程序直接启动，参数按数组传入；10 秒超时，最多 2 MiB 返回内容，退出应用时取消请求。</p></>}
      </details><footer><button type="button" data-dismiss="dialog" className="subtle">取消</button><button className="primary" disabled={busy || disabled || working}>{draft.sourceId ? '保存并启用插件' : '保存 Agent 类型'}</button></footer>
    </form></Dialog>}
  </section>;
}
