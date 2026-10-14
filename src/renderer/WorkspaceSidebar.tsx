import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { TreeMenuTarget } from './ContextMenu';
import type { Project, Session } from '../shared/protocol';
import { agentNames, statusNames } from './labels';
import { matchesQuery } from './QuickSwitcher';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, loadSidebarWidth, saveStored } from './storage';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
export function matchesSession(session: Session, project: Project, query: string, filter: string, names = agentNames): boolean {
  return matchesQuery(`${project.name} ${project.path} ${session.title} ${names[session.agent] ?? '自定义 Agent'} ${session.command} ${session.nativeSessionId ?? ''}`, query)
    && (filter === 'all' || (filter === 'active' ? active(session) : filter === 'inactive' ? !active(session) : session.agent === filter));
}

// Preview width in CSS once per frame. The React tree and terminal are kept
// intact while dragging; persist only when the drag ends.
export function ResizableSidebar({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(() => clampSidebarWidth(loadSidebarWidth(), window.innerWidth));
  const [viewport, setViewport] = useState(window.innerWidth);
  const host = useRef<HTMLElement>(null);
  const desired = useRef(loadSidebarWidth());
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const preview = useRef(width);
  const frame = useRef(0);
  const commit = (value: number) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = clampSidebarWidth(value, window.innerWidth);
    host.current?.style.setProperty('--sidebar-width', `${next}px`);
    desired.current = next; preview.current = next; setWidth(next);
    saveStored('berth.sidebarWidth', String(next));
  };
  useEffect(() => {
    const resized = () => { setViewport(window.innerWidth); setWidth(clampSidebarWidth(desired.current, window.innerWidth)); };
    window.addEventListener('resize', resized);
    return () => { window.removeEventListener('resize', resized); if (frame.current) cancelAnimationFrame(frame.current); document.body.classList.remove('sidebar-resizing'); };
  }, []);
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== drag.current?.id) return;
    drag.current = null; document.body.classList.remove('sidebar-resizing'); commit(preview.current);
  };
  return <aside ref={host} className="sidebar" style={{ '--sidebar-width': `${width}px` } as CSSProperties}>
    {children}
    <div className="sidebar-resizer" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={216} aria-valuemax={clampSidebarWidth(480, viewport)} aria-valuenow={width}
      title="拖动调整宽度，双击恢复默认；方向键微调"
      onDoubleClick={() => commit(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        commit(event.key === 'Home' ? 216 : event.key === 'End' ? 480 : width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10));
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        preview.current = host.current!.getBoundingClientRect().width;
        drag.current = { id: event.pointerId, x: event.clientX, width: preview.current };
        document.body.classList.add('sidebar-resizing');
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        preview.current = clampSidebarWidth(current.width + event.clientX - current.x, window.innerWidth);
        if (!frame.current) frame.current = requestAnimationFrame(() => { host.current?.style.setProperty('--sidebar-width', `${preview.current}px`); frame.current = 0; });
      }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
  </aside>;
}

export const ProjectTree = memo(function ProjectTree({ projects, sessions, projectId, sessionId, collapsed, query, filter, names = agentNames, disabled, onToggle, onProject, onSession, onNewSession, onMenu }: {
  projects: Project[]; sessions: Session[]; projectId: string; sessionId: string; collapsed: string[]; query: string; filter: string; names?: Record<string, string>; disabled: boolean;
  onToggle: (id: string) => void; onProject: (id: string) => void; onSession: (projectId: string, sessionId: string) => void; onNewSession: (id: string) => void; onMenu: (target: TreeMenuTarget) => void;
}) {
  function menu(kind: 'project' | 'session', id: string, element: HTMLElement, x?: number, y?: number) {
    const rect = element.getBoundingClientRect();
    onMenu({ kind, id, x: x ?? rect.right, y: y ?? rect.bottom, opener: element });
  }
  const grouped = useMemo(() => {
    const result = new Map<string, Session[]>();
    for (const session of sessions) { const group = result.get(session.projectId) ?? []; group.push(session); result.set(session.projectId, group); }
    return result;
  }, [sessions]);
  const searching = !!query.trim() || filter !== 'all';
  const visible = useMemo(() => projects.flatMap(project => {
    const all = grouped.get(project.id) ?? [], children = all.filter(session => matchesSession(session, project, query, filter, names));
    return children.length || (filter === 'all' && matchesQuery(`${project.name} ${project.path}`, query)) ? [{ project, all, children }] : [];
  }), [projects, grouped, query, filter, names]);
  return <nav className="projects" aria-label="项目与会话"><ul className="project-tree">{visible.map(({ project, all, children }) => {
    const expanded = searching || !collapsed.includes(project.id), count = all.filter(active).length;
    return <li key={project.id} className="project-branch" data-project-id={project.id}>
      <div className={`project-row ${projectId === project.id ? 'current-project' : ''}`} onContextMenu={event => { event.preventDefault(); menu('project', project.id, event.currentTarget.querySelector<HTMLElement>('.project-item')!, event.clientX, event.clientY); }}>
        <button className="project-toggle icon-button" aria-label={`${expanded ? '收起' : '展开'}项目 ${project.name}`} aria-expanded={expanded} aria-controls={`sessions-${project.id}`} disabled={searching} onClick={() => onToggle(project.id)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg>
        </button>
        <button className="project-item" onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menu('project', project.id, event.currentTarget); } }} onClick={() => onProject(project.id)} title={project.path}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3V7Z" /></svg><span>{project.name}</span>{count > 0 && <em title={`${count} 个终端运行中`}>{count}</em>}
        </button>
        <button className="tree-more icon-button" aria-label={`项目操作 ${project.name}`} title="项目操作（也可右键）" onClick={event => menu('project', project.id, event.currentTarget)}>⋯</button>
      </div>
      {expanded && <ul className="session-list" id={`sessions-${project.id}`}>{children.map(session => <li key={session.id} className="session-row" data-session-id={session.id} onContextMenu={event => { event.preventDefault(); menu('session', session.id, event.currentTarget.querySelector<HTMLElement>('.session-item')!, event.clientX, event.clientY); }}><button className={`session-item ${sessionId === session.id ? 'selected' : ''}`} aria-current={sessionId === session.id ? 'page' : undefined} onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menu('session', session.id, event.currentTarget); } }} onClick={() => onSession(project.id, session.id)} title={`${names[session.agent] ?? '自定义 Agent'} · ${statusNames[session.latestRun?.status ?? ''] ?? '待启动'}${session.nativeSessionId ? ' · 已关联对话' : ''}`}>
        <span className={`dot ${active(session) ? 'live' : ''}`} /><span className="session-title">{session.title}</span><span className="session-agent">{names[session.agent] ?? '自定义 Agent'}</span>
      </button><button className="tree-more icon-button" aria-label={`会话操作 ${session.title}`} title="会话操作（也可右键）" onClick={event => menu('session', session.id, event.currentTarget)}>⋯</button></li>)}{!children.length && <li className="tree-empty">{searching ? '没有匹配的会话' : <button className="text-button" disabled={disabled} onClick={() => onNewSession(project.id)}>新建第一个会话</button>}</li>}</ul>}
    </li>;
  })}</ul>{!visible.length && <p className="sidebar-empty">{searching ? '没有匹配的项目或会话' : '添加项目目录，开始第一个会话。'}</p>}</nav>;
});
