import { ExtensionsContext } from './ExtensionManager';
import { extensionEnabled } from '../shared/extensions';
import { useContext, useEffect, useRef, useState } from 'react';
import type { AgentDefinition, Project } from '../shared/protocol';
import type { SkillItem, SkillLocation, SkillPage } from '../shared/skills';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';
import { builtinSkillProviders } from '../shared/skills';

export function SkillManager({ agents, projects, currentProjectId }: { agents: AgentDefinition[]; projects: Project[]; currentProjectId?: string }) {
  const extensions=useContext(ExtensionsContext);
  const providers = [...builtinSkillProviders.filter(p=>extensionEnabled(extensions,'agent.'+p.id)), ...agents.flatMap(agent => {
    const skills = agent.skills ?? builtinSkillProviders.find(provider => provider.id === agent.integration)?.skills;
    return skills ? [{ id: agent.id, name: agent.name, skills }] : [];
  })];
  const [agentId, setAgentId] = useState('codex');
  const provider = providers.find(item => item.id === agentId) ?? providers[0] ?? builtinSkillProviders[0];
  const [projectId, setProjectId] = useState<string>(currentProjectId || '');
  const [page, setPage] = useState<SkillPage | null>(null), [query, setQuery] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<{ item: SkillItem; original: string; content: string } | null>(null);
  const [removing, setRemoving] = useState<SkillItem | null>(null);
  const opener = useRef<HTMLElement | null>(null), generation = useRef(0);
  const location: SkillLocation = { agentId: provider.id, projectId: provider.skills.project ? projectId || null : null };
  const key = JSON.stringify([location, provider.skills]);
  useEffect(() => {
    if(!providers.length){setBusy(false);return;}
    const token = ++generation.current;
    setPage(null); setError(''); setNotice('');
    setBusy(true);
    void window.berth.skills({ action: 'list', location }).then(result => { if (token === generation.current && 'items' in result) setPage(result); })
      .catch(reason => { if (token === generation.current) setError(String(reason)); }).finally(() => { if (token === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [key, revision, providers.map(p=>p.id).join(',')]);
  async function mutate(action: 'toggle' | 'remove', item: SkillItem) {
    setBusy(true); setError('');
    try {
      const result = await window.berth.skills({ action, location, name: item.folder, enabled: item.enabled });
      if ('items' in result) setPage(result);
      setNotice(action === 'remove' ? '已移出技能目录，原文件保留在同级的 .agentberth-trash 目录。' : item.enabled ? '已移出加载目录；运行中的 Agent 是否立即生效取决于其自身实现。' : '已放回加载目录；可在 Agent 中检查是否已发现。');
    } finally { setBusy(false); }
  }
  if(!providers.length)return <section className="settings-card"><h2>Skill 管理</h2><p>启用 Agent 接入插件后，其 Skills 会自动出现在这里。</p></section>;
  const items = page?.items.filter(item => `${item.name} ${item.description} ${item.folder}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="settings-card skill-manager"><h2>Skill 管理</h2><p className="form-hint">选择 Agent 类型和作用范围，管理已接入的 Skills。新增能力可更新原 Agent 插件，实际加载和热更新由 Agent 决定。</p>
    <div className="skill-filters"><label>Agent 类型<select aria-label="Skill Agent 类型" value={provider.id} disabled={busy || !!editor} onChange={event => setAgentId(event.target.value)}>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>作用范围<select aria-label="Skill 作用范围" value={location.projectId || ''} disabled={busy || !!editor} onChange={event => setProjectId(event.target.value)}><option value="" disabled={!provider.skills.user}>用户级 · 所有项目</option>{provider.skills.project && projects.map(project => <option key={project.id} value={project.id}>项目 · {project.name}</option>)}</select></label>
    </div>
    {page?.root && <code className="skill-root">{page.root}</code>}
    <div className="skill-toolbar"><input aria-label="搜索 Skill" placeholder="搜索名称和说明" value={query} onChange={event => setQuery(event.target.value)} /><AsyncButton className="subtle" disabled={busy || !page} onError={setError} onAction={async () => {
      const source = await window.berth.chooseDirectory(); if (!source) return 'cancelled';
      setBusy(true); try { const result = await window.berth.skills({ action: 'import', location, source }); if ('items' in result) setPage(result); setNotice('已导入完整 Skill 文件夹；请在 Agent 中检查加载情况。'); } finally { setBusy(false); }
    }}>导入 Skill 文件夹</AsyncButton><button className="subtle" disabled={busy || !page} onClick={() => setRevision(value => value + 1)}>刷新</button></div>
    {error && <p className="inline-error" role="alert">{error.replace(/^Error: /, '')}</p>}{notice && <p className="form-hint" role="status">{notice}</p>}
    {page?.warnings.map(warning => <p className="form-hint" key={warning}>{warning}</p>)}
    <p className="form-hint">列表仅显示具备 Skill 能力的类型。新增或更新 Agent 请到「插件中心 → Agent 接入」安装或配置 Cordis 插件，同一份插件提供启动、历史和 Skill 管理。</p>
    <div className="skill-list" aria-label="已安装的 Skills">{items.map(item => <article className="skill-row" key={`${item.enabled}:${item.folder}`}><div><strong>{item.name}</strong><span className="badge">{item.enabled ? '在加载目录' : '已停用'}</span><p>{item.error || item.description}</p><code title={item.path}>{item.path}</code>{item.linked && <small>链接目录：请在来源位置管理。</small>}</div><div className="skill-row-actions">
      <AsyncButton className="subtle" disabled={busy || item.linked} onError={setError} onAction={async () => { opener.current = document.activeElement as HTMLElement; setBusy(true); try { const result = await window.berth.skills({ action: 'read', location, name: item.folder, enabled: item.enabled }); if ('content' in result) setEditor({ item, original: result.content, content: result.content }); } finally { setBusy(false); } }}>查看 / 编辑</AsyncButton>
      <AsyncButton className="subtle" disabled={busy || item.linked || !!item.error} onError={setError} onAction={() => mutate('toggle', item)}>{item.enabled ? '停用' : '启用'}</AsyncButton><button className="subtle" disabled={busy || item.linked} onClick={() => { opener.current = document.activeElement as HTMLElement; setRemoving(item); }}>移除</button>
    </div></article>)}</div>
    {!items.length && <p className="form-hint">{busy ? '正在读取…' : query ? '没有匹配的 Skill。' : '此目录没有 Skill，可导入包含 SKILL.md 的文件夹。'}</p>}
    {editor && <Dialog title={`编辑 Skill · ${editor.item.name}`} dirty={editor.content !== editor.original} busy={busy} returnFocus={opener.current} onClose={() => setEditor(null)} error={error}><label>SKILL.md<textarea className="skill-editor" aria-label="Skill 文档" spellCheck={false} value={editor.content} disabled={busy} onChange={event => setEditor({ ...editor, content: event.target.value })} /></label><p className="form-hint">只保存说明文档；scripts、references 和 assets 保持原样。</p><footer><button className="subtle" disabled={busy} data-dismiss="dialog">取消</button><AsyncButton className="primary" disabled={busy || editor.content === editor.original} onError={setError} onAction={async () => { setBusy(true); try { const result = await window.berth.skills({ action: 'save', location, name: editor.item.folder, enabled: editor.item.enabled, content: editor.content }); if ('items' in result) setPage(result); setEditor(null); setNotice('Skill 文档已保存。'); } finally { setBusy(false); } }}>保存文档</AsyncButton></footer></Dialog>}
    {removing && <Dialog title="移除 Skill" busy={busy} returnFocus={opener.current} onClose={() => setRemoving(null)} error={error}><p>将 {removing.name} 移出当前管理目录。文件保留在同级回收目录，其他副本不受影响。</p><footer><button className="subtle" disabled={busy} onClick={() => setRemoving(null)}>取消</button><AsyncButton className="primary" disabled={busy} onError={setError} onAction={async () => { await mutate('remove', removing); setRemoving(null); }}>移除 Skill</AsyncButton></footer></Dialog>}
  </section>;
}
