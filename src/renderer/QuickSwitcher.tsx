import { useEffect, useState } from 'react';
import type { State } from '../shared/protocol';
import { agentNames, statusNames } from './labels';
import { Dialog } from './Dialog';

export function matchesQuery(text: string, query: string): boolean {
  const normalized = text.toLocaleLowerCase().replaceAll('\\', '/');
  return query.trim().toLocaleLowerCase().replaceAll('\\', '/').split(/\s+/).every(part => normalized.includes(part));
}
export type SwitchTarget = { kind: 'project' | 'session' | 'action'; id: string; label: string; detail: string; projectId?: string; sessionId?: string; action?: 'settings' | 'session' | 'project' };

export function QuickSwitcher({ state, canCreate, hasProject, onSelect, onClose, returnFocus }: {
  state: State; canCreate: boolean; hasProject: boolean; onSelect: (target: SwitchTarget) => void; onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const byProject = new Map(state.projects.map(project => [project.id, project]));
  const bySession = new Map(state.sessions.map(session => [session.id, session]));
  const targets: SwitchTarget[] = [
    { kind: 'action', id: 'settings', label: '打开设置', detail: '默认终端、Agent 和字号 · Ctrl+,', action: 'settings' },
    ...(canCreate && hasProject ? [{ kind: 'action' as const, id: 'new-session', label: '新建会话', detail: '在当前项目创建会话 · Ctrl+Shift+N', action: 'session' as const }] : []),
    ...(canCreate ? [{ kind: 'action' as const, id: 'new-project', label: '添加项目目录', detail: '登记一个本机项目 · Ctrl+Shift+O', action: 'project' as const }] : []),
    ...state.projects.map(project => ({ kind: 'project' as const, id: 'project:' + project.id, label: project.name, detail: project.path, projectId: project.id })),
    ...state.sessions.map(session => ({ kind: 'session' as const, id: 'session:' + session.id, label: session.title, detail: `${byProject.get(session.projectId)?.name ?? ''} · ${agentNames[session.agent]} · ${statusNames[session.latestRun?.status ?? ''] ?? '待启动'}`, projectId: session.projectId, sessionId: session.id })),
  ];
  const filtered = targets.filter(target => {
    const session = target.sessionId && bySession.get(target.sessionId);
    return matchesQuery(`${target.label} ${target.detail} ${byProject.get(target.projectId ?? '')?.path ?? ''} ${session ? session.command + ' ' + (session.nativeSessionId ?? '') : ''}`, query);
  });
  const results = filtered.slice(0, 50);
  const selected = Math.min(index, results.length - 1);
  useEffect(() => { document.getElementById(`switch-result-${selected}`)?.scrollIntoView({ block: 'nearest' }); }, [selected, query]);
  return <Dialog title="快速切换" onClose={onClose} returnFocus={returnFocus}>
    <input className="switch-search" autoFocus role="combobox" aria-label="搜索项目、会话和操作" aria-expanded="true" aria-autocomplete="list" aria-controls="switch-results" aria-activedescendant={selected >= 0 ? `switch-result-${selected}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} placeholder="输入项目、会话名称、目录或 Agent…" onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (results.length) setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length); }
      if (event.key === 'Enter') { event.preventDefault(); if (results[selected]) onSelect(results[selected]); }
    }} />
    <div className="switch-results" id="switch-results" role="listbox" aria-label="切换结果">{results.map((target, offset) => <button type="button" role="option" aria-selected={selected === offset} id={`switch-result-${offset}`} key={target.id} className={`switch-result ${selected === offset ? 'selected' : ''}`} onMouseEnter={() => setIndex(offset)} onClick={() => onSelect(target)} title={target.detail}><span className="switch-kind">{target.kind === 'project' ? '项目' : target.kind === 'session' ? '会话' : '操作'}</span><span><strong>{target.label}</strong><small>{target.detail}</small></span></button>)}{!results.length && <p className="switch-empty">没有匹配结果，试试项目名称、目录或 Agent。</p>}</div>
    <footer className="switch-help"><span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span><span>{filtered.length > 50 ? '显示前 50 个结果' : `${filtered.length} 个结果`}</span></footer>
  </Dialog>;
}
