import type {SidebarMove} from './sidebar-order';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type DragEvent, type KeyboardEvent } from 'react';
import type { TreeMenuTarget } from './ContextMenu';
import type { Project, Session } from '../shared/protocol';
import { agentNames, statusNames } from './labels';
import { OutputBadge } from './useTerminalActivity';
import { ResourceBadge } from './Resources';
import { matchesQuery } from './QuickSwitcher';
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, loadSidebarWidth, readStored, saveStored } from './storage';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
export function matchesSession(session: Session, project: Project, query: string, filter: string, names = agentNames): boolean {
  return matchesQuery(`${project.name} ${project.path} ${session.title} ${session.service?'服务终端':names[session.agent] ?? '自定义 Agent'} ${session.command} ${session.remote?.host ?? ''} ${session.remote?.directory ?? ''} ${session.nativeSessionId ?? ''}`, query)
    && (filter === 'all' || (filter === 'active' ? active(session) : filter === 'inactive' ? !active(session) : session.agent === filter));
}

// Preview width in CSS once per frame. The React tree and terminal are kept
// intact while dragging; persist only when the drag ends.
export function ResizableSidebar({ children, collapsed = false, side = 'left' }: { children: ReactNode; collapsed?: boolean; side?: 'left' | 'right' }) {
  const storageKey=side==='right'?'berth.rightSidebarWidth':'berth.sidebarWidth';
  const savedWidth=()=>{const stored=Number(readStored(storageKey));return Number.isFinite(stored)&&stored>0?stored:side==='right'?DEFAULT_SIDEBAR_WIDTH:loadSidebarWidth();};
  const [width, setWidth] = useState(() => clampSidebarWidth(savedWidth(), window.innerWidth));
  const [viewport, setViewport] = useState(window.innerWidth);
  const host = useRef<HTMLElement>(null);
  const desired = useRef(savedWidth());
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const preview = useRef(width);
  const frame = useRef(0);
  const commit = (value: number) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = clampSidebarWidth(value, window.innerWidth);
    host.current?.style.setProperty('--sidebar-width', `${next}px`);
    desired.current = next; preview.current = next; setWidth(next);
    saveStored(storageKey, String(next));
  };
  useEffect(() => {
    const resized = () => { setViewport(window.innerWidth); setWidth(clampSidebarWidth(desired.current, window.innerWidth)); };
    window.addEventListener('resize', resized);
    return () => { window.removeEventListener('resize', resized); if (frame.current) cancelAnimationFrame(frame.current); document.body.classList.remove('sidebar-resizing'); };
  }, []);
  useEffect(() => {
    if (!collapsed) return;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0; drag.current = null;
    host.current?.style.setProperty('--sidebar-width', `${width}px`);
    document.body.classList.remove('sidebar-resizing');
  }, [collapsed]);
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== drag.current?.id) return;
    drag.current = null; document.body.classList.remove('sidebar-resizing'); commit(preview.current);
  };
  return <aside ref={host} className={`sidebar${side==='right'?' sidebar-right':''}${collapsed ? ' sidebar-collapsed' : ''}`} style={{ '--sidebar-width': `${width}px` } as CSSProperties}>
    {children}
    <div hidden={collapsed} className="sidebar-resizer" role="separator" aria-label={side==='right'?'调整右侧栏宽度':'调整侧栏宽度'} aria-orientation="vertical" tabIndex={0}
      aria-valuemin={216} aria-valuemax={clampSidebarWidth(480, viewport)} aria-valuenow={width}
      title="拖动调整宽度，双击恢复默认；方向键微调"
      onDoubleClick={() => commit(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const direction=side==='right'?(event.key==='ArrowLeft'?1:-1):(event.key==='ArrowRight'?1:-1);
        commit(event.key === 'Home' ? 216 : event.key === 'End' ? 480 : width + direction * (event.shiftKey ? 50 : 10));
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
        preview.current = clampSidebarWidth(current.width + (event.clientX - current.x) * (side==='right'?-1:1), window.innerWidth);
        if (!frame.current) frame.current = requestAnimationFrame(() => { host.current?.style.setProperty('--sidebar-width', `${preview.current}px`); frame.current = 0; });
      }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
  </aside>;
}

export const ProjectTree = memo(function ProjectTree({ unread, projects, sessions, projectId, sessionId, collapsed, query, filter, names = agentNames, disabled, onToggle, onProject, onSession, onNewSession, onOpenFolder, onMenu, onMove, onClearFilter }: {
  unread: ReadonlySet<string>; projects: Project[]; sessions: Session[]; projectId: string; sessionId: string; collapsed: string[]; query: string; filter: string; names?: Record<string, string>; disabled: boolean;
  onToggle: (id: string) => void; onProject: (id: string) => void; onSession: (projectId: string, sessionId: string) => void; onNewSession: (id: string) => void; onOpenFolder: (project: Project) => void; onMenu: (target: TreeMenuTarget) => void; onMove:(move:SidebarMove)=>void; onClearFilter?: () => void;
}) {
  type Entry={kind:'project'|'session';id:string;projectId?:string};
  const drag=useRef<Entry|null>(null),[drop,setDrop]=useState<(Entry&{edge:'before'|'after'})|null>(null);
  const clearDrag=()=>{drag.current=null;setDrop(null);};
  useEffect(()=>{window.addEventListener('dragend',clearDrag);window.addEventListener('drop',clearDrag);return()=>{window.removeEventListener('dragend',clearDrag);window.removeEventListener('drop',clearDrag);};},[]);
  function startDrag(event:DragEvent,entry:Entry){if(disabled){event.preventDefault();return;}drag.current=entry;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-agentberth-sidebar-entry',JSON.stringify(entry));}
  function allowed(target:Entry){const source=drag.current;return !disabled&&!!source&&source.id!==target.id&&source.kind===target.kind&&(source.kind==='project'||source.projectId===target.projectId);}
  function edgeAt(event:DragEvent){const box=event.currentTarget.getBoundingClientRect();return event.clientY<box.top+box.height/2?'before' as const:'after' as const;}
  function over(event:DragEvent,target:Entry){if(!allowed(target)){if(drag.current)event.dataTransfer.dropEffect='none';setDrop(previous=>previous?null:previous);return;}event.preventDefault();event.dataTransfer.dropEffect='move';const edge=edgeAt(event);setDrop(previous=>previous?.kind===target.kind&&previous.id===target.id&&previous.edge===edge?previous:{...target,edge});}
  function moveDrop(event:DragEvent,target:Entry){if(!allowed(target))return;event.preventDefault();event.stopPropagation();const source=drag.current!;onMove({kind:source.kind,id:source.id,targetId:target.id,projectId:source.projectId,edge:edgeAt(event)});clearDrag();}
  function keyboardMove(event:KeyboardEvent<HTMLButtonElement>,entry:Entry,neighbors:string[]){
    if(disabled||!event.altKey||event.ctrlKey||event.metaKey||!['ArrowUp','ArrowDown'].includes(event.key))return false;
    event.preventDefault();event.stopPropagation();const index=neighbors.indexOf(entry.id),targetId=neighbors[index+(event.key==='ArrowUp'?-1:1)];
    if(targetId){onMove({...entry,targetId,edge:event.key==='ArrowUp'?'before':'after'});const button=event.currentTarget;requestAnimationFrame(()=>{if(button.isConnected)button.focus();});}return true;
  }
  const marker=(entry:Entry)=>drop?.kind===entry.kind&&drop.id===entry.id?drop.edge:undefined;
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
  return <nav className="projects" aria-label="项目与会话" onDragOver={event=>{if(!drag.current)return;const box=event.currentTarget.getBoundingClientRect();if(event.clientY<box.top+28)event.currentTarget.scrollTop-=12;else if(event.clientY>box.bottom-28)event.currentTarget.scrollTop+=12;}} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDrop(null);}}><ul className="project-tree">{visible.map(({ project, all, children }) => {
    const expanded = !collapsed.includes(project.id), count = all.filter(active).length;
    return <li key={project.id} className="project-branch" data-project-id={project.id}>
      <div className={`project-row ${projectId === project.id ? 'current-project' : ''}`} data-drop-edge={marker({kind:'project',id:project.id})} onDragOver={event=>over(event,{kind:'project',id:project.id})} onDrop={event=>moveDrop(event,{kind:'project',id:project.id})} onContextMenu={event => { event.preventDefault(); menu('project', project.id, event.currentTarget.querySelector<HTMLElement>('.project-item')!, event.clientX, event.clientY); }}>
        <button className="project-toggle icon-button" aria-label={`${expanded ? '收起' : '展开'}项目 ${project.name}`} aria-expanded={expanded} aria-controls={`sessions-${project.id}`} onClick={() => onToggle(project.id)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg>
        </button>
        <button className="project-item" draggable={!disabled} onDragStart={event=>startDrag(event,{kind:'project',id:project.id})} onDragEnd={clearDrag} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={event => { if(keyboardMove(event,{kind:'project',id:project.id},visible.map(value=>value.project.id)))return; if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menu('project', project.id, event.currentTarget); } }} onClick={() => onProject(project.id)} title={`${project.path}\n拖动排序 · Alt+↑/↓${count?`\n${count} 个终端运行中`: ''}`}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3V7Z" /></svg><span>{project.name}</span>{all.some(value => unread.has(value.id) && (!expanded || !children.includes(value))) && <OutputBadge />}
        </button>
        {count > 0 && <ResourceBadge scope="project" id={project.id} />}
        <button type="button" className="tree-quick icon-button" aria-label={`在 ${project.name} 中新建会话`} title="在此项目中新建会话" disabled={disabled} onClick={() => onNewSession(project.id)}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
        <button type="button" className="tree-quick icon-button" aria-label={`在文件管理器中打开 ${project.name}`} title="在文件管理器中打开项目目录" onClick={() => onOpenFolder(project)}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3H3v10h10V9" /><path d="M9 3h4v4" /><path d="m13 3-6 6" /></svg></button>
        <button className="tree-more icon-button" aria-label={`项目操作 ${project.name}`} title="项目操作（也可右键）" onClick={event => menu('project', project.id, event.currentTarget)}>⋯</button>
      </div>
      {expanded && <ul className="session-list" id={`sessions-${project.id}`}>{children.map(session => <li key={session.id} className="session-row" data-session-id={session.id} data-drop-edge={marker({kind:'session',id:session.id})} onDragOver={event=>over(event,{kind:'session',id:session.id,projectId:project.id})} onDrop={event=>moveDrop(event,{kind:'session',id:session.id,projectId:project.id})} onContextMenu={event => { event.preventDefault(); menu('session', session.id, event.currentTarget.querySelector<HTMLElement>('.session-item')!, event.clientX, event.clientY); }}><button className={`session-item ${sessionId === session.id ? 'selected' : ''}`} aria-current={sessionId === session.id ? 'page' : undefined} draggable={!disabled} onDragStart={event=>startDrag(event,{kind:'session',id:session.id,projectId:project.id})} onDragEnd={clearDrag} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={event => { if(keyboardMove(event,{kind:'session',id:session.id,projectId:project.id},children.map(value=>value.id)))return; if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); menu('session', session.id, event.currentTarget); } }} onClick={() => onSession(project.id, session.id)} title={`${session.service?'服务终端':names[session.agent] ?? '自定义 Agent'} · ${statusNames[session.latestRun?.status ?? ''] ?? '待启动'}${session.nativeSessionId ? ' · 已关联对话' : ''}\n拖动排序 · Alt+↑/↓`}>
        <span className={`dot ${active(session) ? 'live' : ''}`} /><span className="session-title">{session.remote && <span title={`SSH · ${session.remote.host}`}>↗ </span>}{session.title}</span>{unread.has(session.id) && <OutputBadge />}{active(session)&&session.remote?<span className="session-agent" title="远端 CPU / 内存尚未采集">SSH</span>:active(session)?<ResourceBadge scope="session" id={session.id} runId={session.latestRun?.id} />:<span className="session-agent">{session.service?'服务终端':names[session.agent] ?? '自定义 Agent'}</span>}
      </button><button className="tree-more icon-button" aria-label={`会话操作 ${session.title}`} title="会话操作（也可右键）" onClick={event => menu('session', session.id, event.currentTarget)}>⋯</button></li>)}{!children.length && <li className="tree-empty">{searching ? '没有匹配的会话' : '暂无会话，点 + 新建'}</li>}</ul>}
    </li>;
  })}</ul>{!visible.length && (searching ? <div className="sidebar-empty"><span>没有匹配的项目或会话</span>{onClearFilter && <button type="button" className="subtle" onClick={onClearFilter}>清除筛选</button>}</div> : <p className="sidebar-empty">添加项目目录，开始第一个会话。</p>)}</nav>;
});
