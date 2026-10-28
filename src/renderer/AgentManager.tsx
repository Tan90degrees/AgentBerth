import { useRef, useState } from 'react';
import type { AgentDefinition, AgentDefinitionConfig } from '../shared/protocol';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';

const capabilities = (agent: AgentDefinitionConfig) => [agent.skills && 'Skill 管理',agent.plugin?.list && '会话列表', agent.plugin?.history && '原生对话历史', (agent.plugin?.resume || agent.resumeCommand) && '会话恢复'].filter(Boolean).join(' · ') || '终端会话';
export function AgentManager({ agents, defaultAgent, used, disabled, busy, hotUpdates, error, onSave, onDelete, onError }: {
  hotUpdates: boolean; agents: AgentDefinition[]; defaultAgent: string; used: string[]; disabled: boolean; busy: boolean; error: string; onError: (value: string) => void;
  onSave: (value: AgentDefinitionConfig, id?: string) => Promise<AgentDefinition | undefined>; onDelete: (id: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<{ config: AgentDefinitionConfig; id?: string; imported: boolean } | null>(null);
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [kitFolder, setKitFolder] = useState('');
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState('');
  const update = (agent: AgentDefinition) => task(async () => {
    setUpdateErrors(previous => ({ ...previous, [agent.id]: '' }));
    try {
      const value = await window.berth.importAgentPlugin();
      if (!value) return 'cancelled';
      const identity = agent.sourceId ?? agent.plugin?.sourceId;
      if (identity && identity !== (value.sourceId ?? value.plugin?.sourceId)) throw new Error('插件 ID 与当前类型不一致，请选择同一类型的更新文件');
      setChecks(previous => ({ ...previous, [agent.id]: '正在校验更新…' }));
      const result = await window.berth.rpc<AgentDefinition>('updateAgent', { ...value, name: agent.name, agentId: agent.id });
      setChecks(previous => ({ ...previous, [agent.id]: result.plugin ? '插件已热更新，后续读取使用新版本' : '配置已热更新' }));
      setNotice('已更新 ' + agent.name + '，运行中的终端保持不变');
    } catch (reason) {
      setUpdateErrors(previous => ({ ...previous, [agent.id]: reason instanceof Error ? reason.message : String(reason) }));
      setChecks(previous => ({ ...previous, [agent.id]: '更新失败，继续使用旧版本' }));return false;
    }
  });
  const opener = useRef<HTMLElement | null>(null);
  const open = (config: AgentDefinitionConfig, id?: string, imported = false) => {
    const { name, command, resumeCommand, plugin, sourceId, skills } = config;
    setEditing({ config: { name, command, resumeCommand, plugin, ...(skills ? { skills } : {}), ...(sourceId ? { sourceId } : {}) }, id, imported });
    setName(name); setLocalError(''); onError('');
  };
  async function task(work: () => Promise<unknown>) {
    setWorking(true); setNotice(''); onError('');
    try { return await work(); } catch (reason) { onError(String(reason)); return false; } finally { setWorking(false); }
  }
  async function check(agent: AgentDefinition) {
    return task(async () => {
      setChecks(previous => ({ ...previous, [agent.id]: '正在检查…' }));
      try { const result = await window.berth.rpc<{ message: string }>('checkAgentPlugin', { agentId: agent.id }); setChecks(previous => ({ ...previous, [agent.id]: result.message })); }
      catch (reason) { setChecks(previous => ({ ...previous, [agent.id]: '检查失败，查看提示后重新导入' })); throw reason; }
    });
  }
  const blocked = disabled || working || busy;
  return <section className="settings-card agent-manager"><div className="agent-manager-heading"><div><h2>自定义 Agent 类型</h2><p>导入配置文件或脚本，设置名称即可使用。启动命令、历史和恢复能力由文件自动提供。</p></div><div className="agent-manager-buttons"><AsyncButton className="primary" disabled={blocked} onAction={() => {
    opener.current = document.activeElement as HTMLElement;
    return task(async () => {
      const value = await window.berth.importAgentPlugin();
      if (!value) return 'cancelled';
      const sourceId = value.sourceId ?? value.plugin?.sourceId;
      const previous = sourceId ? agents.find(agent => (agent.sourceId ?? agent.plugin?.sourceId) === sourceId) : undefined;
      if (!previous && agents.length >= 64) throw new Error('最多保存 64 个 Agent 类型，请先删除不用的类型');
      open({ ...value, name: previous?.name ?? value.name }, previous?.id, true);
    });
  }}>导入 Agent</AsyncButton></div></div>
    <ul className="agent-definitions">{agents.map(agent => <li key={agent.id}><div><strong>{agent.name}</strong>{defaultAgent === agent.id && <span className="badge">默认</span>}<code title={agent.command}>{agent.command}</code><small>{capabilities(agent)}</small>{updateErrors[agent.id] && <small className="danger-text" role="alert">{updateErrors[agent.id]}</small>}{checks[agent.id] && <small className={updateErrors[agent.id] ? "plugin-check plugin-check-failed" : "plugin-check"} role="status">{checks[agent.id]}</small>}</div><div><AsyncButton className="subtle" aria-label={`更新插件 ${agent.name}`} title={hotUpdates ? "选择更新文件，校验成功后立即生效" : "更新后台后支持插件热更新"} disabled={blocked || !hotUpdates} onAction={() => update(agent)}>更新插件</AsyncButton>{agent.plugin && <AsyncButton className="subtle" aria-label={`检查插件 ${agent.name}`} disabled={blocked} onAction={() => check(agent)}>检查插件</AsyncButton>}<button className="subtle" aria-label={`编辑 Agent ${agent.name}`} disabled={blocked} onClick={() => { opener.current = document.activeElement as HTMLElement; open(agent, agent.id); }}>重命名</button><AsyncButton className="subtle danger-text" aria-label={`删除 Agent ${agent.name}`} disabled={blocked || used.includes(agent.id) || defaultAgent === agent.id} title={defaultAgent === agent.id ? '先更换默认 Agent' : used.includes(agent.id) ? '仍被会话使用，请先修改或删除会话' : '删除此类型'} onAction={async () => (await onDelete(agent.id))!==undefined}>删除</AsyncButton></div></li>)}</ul>
    {!agents.length && <p className="form-hint">还没有自定义 Agent。导入一个文件即可添加；也可以让编程 Agent 按下方指南为你制作。</p>}
    <p className="form-hint">支持 .json 配置和 .cjs / .mjs / .js 自描述脚本，无需另装 Node。点击“更新插件”选择同一类型的新文件，校验后立即生效，无需停止终端或重启工作台。失败保留旧版；名称和会话关联保留。脚本会在本机运行，请选择可信文件。</p><div className="plugin-development"><strong>让 Agent 帮你制作导入文件</strong><p>复制开发指令交给编程 Agent；需要示例时可导出包含完整指南的开发套件。</p><div><AsyncButton className="subtle" disabled={working || busy} onAction={() => task(async () => { const folder = await window.berth.exportPluginKit(); if (folder) { setKitFolder(folder); await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(folder)); setNotice('开发套件已导出，给 Agent 的开发指令已复制'); } else return 'cancelled'; })}>导出开发套件</AsyncButton><AsyncButton className="subtle" disabled={working || busy} onAction={() => task(async () => { await window.berth.copyText(await window.berth.pluginDevelopmentPrompt(kitFolder || undefined)); setNotice('完整开发指令已复制，可直接粘贴给 Agent'); })}>复制 Agent 开发指令</AsyncButton></div>{kitFolder && <code>{kitFolder}</code>}{notice && <p role="status">{notice}</p>}</div>
    {editing && <Dialog title={editing.imported ? editing.id ? '更新 Agent 类型' : '添加 Agent 类型' : '重命名 Agent 类型'} dirty={name !== editing.config.name} busy={busy || working} error={localError || error} returnFocus={opener.current} onClose={() => { setEditing(null); onError(''); }}><form onSubmit={async event => {
      event.preventDefault(); setLocalError(''); onError(''); setWorking(true);
      try {
        const value = { ...editing.config, name: name.trim() };
        if (editing.imported && value.plugin) await window.berth.rpc('probeAgentPlugin', value);
        const result = await onSave(value, editing.id);
        if (result) { if (editing.imported && value.plugin) setChecks(previous => ({ ...previous, [result.id]: '插件连接正常' })); setEditing(null); }
      } catch (reason) { setLocalError(reason instanceof Error ? reason.message : String(reason)); } finally { setWorking(false); }
    }}>
      <label>类型名称<input aria-label="类型名称" required maxLength={100} value={name} onChange={event => { setName(event.target.value); setLocalError(''); }} placeholder="例如 Aider" /></label>
      <div className="imported-plugin"><strong>{capabilities(editing.config)}</strong><p>启动命令：<code>{editing.config.command}</code></p>{editing.imported ? <p>{editing.id ? '将更新已有类型，保留会话关联。已有会话继续使用各自保存的启动命令。' : '文件已导入，保存即可使用。'}{editing.config.plugin && '扩展能力自动启用。'}</p> : <p>需要修改命令或能力时，重新导入更新后的文件。</p>}</div>
      <footer><button type="button" data-dismiss="dialog" className="subtle">取消</button><button className="primary" aria-busy={working} data-feedback={working?'pending':localError||error?'error':'idle'} disabled={blocked || !name.trim()}>保存 Agent 类型</button></footer>
    </form></Dialog>}
  </section>;
}
