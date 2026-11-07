import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { State } from '../shared/protocol';
import { agentLabels, statusNames } from './labels';
import { Dialog } from './Dialog';

export function matchesQuery(text: string, query: string): boolean {
  const normalized = text.toLocaleLowerCase().replaceAll('\\', '/');
  return query.trim().toLocaleLowerCase().replaceAll('\\', '/').split(/\s+/).every(part => normalized.includes(part));
}
export type SwitchTarget = { kind: 'project' | 'session' | 'action'; id: string; label: string; detail: string; projectId?: string; sessionId?: string; action?: 'settings' | 'session' | 'project' | 'shortcuts' };

const RECENT_KEY = 'berth.quickSwitcher.recent';
const RECENT_LIMIT = 8;
const RESULT_LIMIT = 50;

function loadRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, RECENT_LIMIT) : [];
  } catch { return []; }
}

/** Higher is better; -1 means the text does not contain the query, even as a subsequence. */
export function scoreMatch(text: string, query: string): number {
  const normalized = text.toLocaleLowerCase().replaceAll('\\', '/');
  const parts = query.trim().toLocaleLowerCase().replaceAll('\\', '/').split(/\s+/).filter(Boolean);
  if (!parts.length) return 0;
  let total = 0;
  for (const part of parts) {
    const exact = normalized.indexOf(part);
    if (exact >= 0) {
      const boundary = exact === 0 ? 40 : /[\s/·._\-:]/.test(normalized[exact - 1] ?? '') ? 22 : 0;
      total += 90 + boundary + part.length * 2 - Math.min(exact, 50);
      continue;
    }
    let cursor = 0, gaps = 0, first = -1;
    for (const char of part) {
      const found = normalized.indexOf(char, cursor);
      if (found < 0) return -1;
      if (first < 0) first = found;
      gaps += found - cursor;
      cursor = found + 1;
    }
    total += Math.max(8, 46 - gaps - Math.min(first, 25));
  }
  return total;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const part = query.trim().toLocaleLowerCase().replaceAll('\\', '/').split(/\s+/)[0] ?? '';
  if (!part) return <>{text}</>;
  const lower = text.toLocaleLowerCase().replaceAll('\\', '/');
  const exact = lower.indexOf(part);
  if (exact >= 0) return <>{text.slice(0, exact)}<mark className="switch-match">{text.slice(exact, exact + part.length)}</mark>{text.slice(exact + part.length)}</>;
  const marks = new Set<number>();
  let cursor = 0;
  for (const char of part) {
    const found = lower.indexOf(char, cursor);
    if (found < 0) return <>{text}</>;
    marks.add(found); cursor = found + 1;
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!marks.has(i)) continue;
    if (i > start) parts.push(<span key={start}>{text.slice(start, i)}</span>);
    parts.push(<mark key={`m${i}`} className="switch-match">{text[i]}</mark>);
    start = i + 1;
  }
  if (start < text.length) parts.push(<span key={start}>{text.slice(start)}</span>);
  return <>{parts}</>;
}

type Candidate = { target: SwitchTarget; score: number; recentRank: number };
type Result = { target: SwitchTarget; group?: string };

export function QuickSwitcher({ state, canCreate, hasProject, onSelect, onClose, returnFocus }: {
  state: State; canCreate: boolean; hasProject: boolean; onSelect: (target: SwitchTarget) => void; onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const recent = useMemo(loadRecent, []);
  const agentNames = useMemo(() => agentLabels(state.agents), [state.agents]);
  const byProject = useMemo(() => new Map(state.projects.map(project => [project.id, project])), [state.projects]);
  const bySession = useMemo(() => new Map(state.sessions.map(session => [session.id, session])), [state.sessions]);
  const targets = useMemo<SwitchTarget[]>(() => [
    { kind: 'action', id: 'settings', label: '打开设置', detail: '默认终端、Agent 和字号 · Ctrl+,', action: 'settings' },
    { kind: 'action', id: 'shortcuts', label: '键盘快捷键', detail: '查看全部快捷键 · Ctrl+/', action: 'shortcuts' },
    ...(canCreate && hasProject ? [{ kind: 'action' as const, id: 'new-session', label: '新建会话', detail: '在当前项目创建会话 · Ctrl+Shift+N', action: 'session' as const }] : []),
    ...(canCreate ? [{ kind: 'action' as const, id: 'new-project', label: '添加项目目录', detail: '登记一个本机项目 · Ctrl+Shift+O', action: 'project' as const }] : []),
    ...state.projects.map(project => ({ kind: 'project' as const, id: 'project:' + project.id, label: project.name, detail: project.path, projectId: project.id })),
    ...state.sessions.map(session => ({ kind: 'session' as const, id: 'session:' + session.id, label: session.title, detail: `${byProject.get(session.projectId)?.name ?? ''} · ${agentNames[session.agent]} · ${statusNames[session.latestRun?.status ?? ''] ?? '待启动'}`, projectId: session.projectId, sessionId: session.id })),
  ], [state.projects, state.sessions, agentNames, canCreate, hasProject, byProject]);

  const { results, total } = useMemo(() => {
    const candidates: Candidate[] = [];
    for (const target of targets) {
      const session = target.sessionId ? bySession.get(target.sessionId) : undefined;
      const haystack = `${target.detail} ${byProject.get(target.projectId ?? '')?.path ?? ''} ${session ? session.command + ' ' + (session.nativeSessionId ?? '') : ''}`;
      const labelScore = scoreMatch(target.label, query);
      const detailScore = scoreMatch(haystack, query);
      if (labelScore < 0 && detailScore < 0) continue;
      const recentRank = recent.indexOf(target.id);
      const base = Math.max(labelScore >= 0 ? labelScore * 2 : 0, detailScore >= 0 ? detailScore : 0);
      const bonus = (recentRank >= 0 ? (RECENT_LIMIT - recentRank) * 18 : 0) + (target.kind === 'action' ? 14 : target.kind === 'project' ? 6 : 0);
      candidates.push({ target, score: base + bonus, recentRank });
    }
    const byRelevance = (a: Candidate, b: Candidate) => b.score - a.score || a.target.label.localeCompare(b.target.label);
    if (query.trim()) {
      return { results: candidates.sort(byRelevance).slice(0, RESULT_LIMIT).map((item): Result => ({ target: item.target })), total: candidates.length };
    }
    const groups: [string, Candidate[]][] = [
      ['最近使用', candidates.filter(item => item.recentRank >= 0).sort((a, b) => a.recentRank - b.recentRank).slice(0, 5)],
      ['操作', candidates.filter(item => item.target.kind === 'action' && item.recentRank < 0)],
      ['项目', candidates.filter(item => item.target.kind === 'project' && item.recentRank < 0)],
      ['会话', candidates.filter(item => item.target.kind === 'session' && item.recentRank < 0)],
    ];
    const grouped: Result[] = [];
    for (const [label, items] of groups) {
      if (!items.length || grouped.length >= RESULT_LIMIT) continue;
      const slice = items.sort(byRelevance).slice(0, RESULT_LIMIT - grouped.length);
      slice.forEach((item, offset) => grouped.push({ target: item.target, group: offset === 0 ? label : undefined }));
    }
    return { results: grouped, total: candidates.length };
  }, [targets, query, recent, byProject, bySession]);

  const groupedView = !query.trim(); // group headings already carry the type, so per-row badges would repeat them
  const selected = Math.min(index, results.length - 1);
  useEffect(() => { document.getElementById(`switch-result-${selected}`)?.scrollIntoView({ block: 'nearest' }); }, [selected, query]);
  const select = (target: SwitchTarget) => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([target.id, ...recent.filter(id => id !== target.id)].slice(0, RECENT_LIMIT))); } catch { /* storage may be unavailable */ }
    onSelect(target);
  };
  return <Dialog title="快速切换" onClose={onClose} returnFocus={returnFocus}>
    <input className="switch-search" autoFocus role="combobox" aria-label="搜索项目、会话和操作" aria-expanded="true" aria-autocomplete="list" aria-controls="switch-results" aria-activedescendant={selected >= 0 ? `switch-result-${selected}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} placeholder="输入项目、会话名称、目录或 Agent…" onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.nativeEvent.isComposing && event.key === '/') { event.preventDefault(); select(targets.find(target => target.action === 'shortcuts')!); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (results.length) setIndex(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length); }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setIndex(event.key === 'Home' ? 0 : Math.max(0, results.length - 1)); }
      if (event.key === 'Enter') { event.preventDefault(); if (results[selected]) select(results[selected].target); }
    }} />
    <div className="switch-results" id="switch-results" role="listbox" aria-label="切换结果">{results.map((entry, offset) => <Fragment key={entry.target.id}>
      {entry.group && <div className="switch-group" role="presentation">{entry.group}</div>}
      <button type="button" role="option" aria-selected={selected === offset} id={`switch-result-${offset}`} className={`switch-result ${selected === offset ? 'selected' : ''}`} onMouseEnter={() => setIndex(offset)} onClick={() => select(entry.target)} title={entry.target.detail}>{!groupedView && <span className="switch-kind">{entry.target.kind === 'project' ? '项目' : entry.target.kind === 'session' ? '会话' : '操作'}</span>}<span><strong><Highlight text={entry.target.label} query={query} /></strong><small>{entry.target.detail}</small></span></button>
    </Fragment>)}{!results.length && <div className="switch-empty"><p>没有匹配结果，试试项目名称、目录或 Agent。</p>{query && <button type="button" className="text-button" onClick={() => { setQuery(''); setIndex(0); }}>清除搜索</button>}</div>}</div>
    <footer className="switch-help"><span>↑ ↓ 选择 · Home/End 首尾 · Enter 打开 · Esc 关闭</span><span>{total > RESULT_LIMIT ? `显示前 ${RESULT_LIMIT} / ${total} 个结果` : `${total} 个结果`}</span></footer>
  </Dialog>;
}
