import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { FilePreview, Project, ProjectFile, ProjectFilePage } from '../shared/protocol';
import { readStored, saveStored } from './storage';

const Preview = lazy(() => import('./FilePreview'));
type Directory = { page?: ProjectFilePage; loading: boolean; error?: string };
function EntryIcon({ directory, expanded }: { directory: boolean; expanded?: boolean }) {
  return <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d={directory ? expanded ? 'M2 7V4h6l2 2h8v2M2 8h17l-3 8H3L2 8Z' : 'M2 6V4h6l2 2h8v10H2V6Z' : 'M5 2h7l4 4v12H5V2Zm7 0v5h4'} /></svg>;
}
export default memo(function FileBrowser({ project, connected, onClose }: { project: Project; connected: boolean; onClose: () => void }) {
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const directoriesRef = useRef(directories); directoriesRef.current = directories;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const [showIgnored, setShowIgnored] = useState(() => readStored('berth.showIgnoredFiles') !== 'false');
  const [markdown, setMarkdown] = useState(() => readStored('berth.markdownPreview') !== 'source');
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const [file, setFile] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const alive = useRef(true);
  const sequence = useRef(new Map<string, number>());
  const previewSequence = useRef(0);
  const previewTail = useRef(Promise.resolve());
  const host = useRef<HTMLElement>(null);
  const tree = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const savedWidth = Number(readStored('berth.filesWidth'));
  const desiredWidth = useRef(Number.isFinite(savedWidth) && savedWidth >= 280 && savedWidth <= 2000 ? savedWidth : 620);
  const [width, setWidth] = useState(desiredWidth.current);
  const frame = useRef(0);
  const pendingWidth = useRef(width);
  const clampWidth = (value: number) => Math.min(Math.max(280, (host.current?.parentElement?.clientWidth ?? 900) - 280), Math.max(280, value));
  const commitWidth = (value: number) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = clampWidth(value);
    desiredWidth.current = next; setWidth(next); host.current?.style.setProperty('--files-width', `${next}px`);
    saveStored('berth.filesWidth', String(next));
  };
  const loadDirectory = useCallback(async (path: string, offset = 0) => {
    const token = (sequence.current.get(path) ?? 0) + 1;
    sequence.current.set(path, token);
    setDirectories(previous => ({ ...previous, [path]: { ...previous[path], loading: true, error: undefined } }));
    try {
      const result = await window.berth.rpc<ProjectFilePage>('projectFiles', { projectId: project.id, path, offset });
      if (!alive.current || sequence.current.get(path) !== token) return;
      setDirectories(previous => {
        const entries = offset ? [...(previous[path]?.page?.entries ?? []), ...result.entries] : result.entries;
        return { ...previous, [path]: { loading: false, page: { ...result, entries: [...new Map(entries.map(entry => [entry.path, entry])).values()] } } };
      });
    } catch (reason) {
      if (alive.current && sequence.current.get(path) === token) setDirectories(previous => ({ ...previous, [path]: { loading: false, error: String(reason).replace(/^Error: /, '') } }));
    }
  }, [project.id]);
  const openFile = useCallback(async (path: string, anchor = '') => {
    if (selectedRef.current === path && anchor) {
      host.current?.querySelector<HTMLElement>(`.markdown-document [id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    const token = ++previewSequence.current;
    const same = selectedRef.current === path;
    selectedRef.current = path; setSelected(path); setError(''); setLoading(true);
    if (!same) setFile(null);
    const previous = previewTail.current;
    let release!: () => void;
    previewTail.current = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (!alive.current || token !== previewSequence.current) return;
      const result = await window.berth.rpc<FilePreview>('previewFile', { projectId: project.id, path });
      if (!alive.current || token !== previewSequence.current) return;
      setFile(result);
      if (anchor) requestAnimationFrame(() => host.current?.querySelector<HTMLElement>(`.markdown-document [id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' }));
    } catch (reason) {
      if (alive.current && token === previewSequence.current) { setFile(null); setError(String(reason).replace(/^Error: /, '')); }
    } finally { release(); if (alive.current && token === previewSequence.current) setLoading(false); }
  }, [project.id]);
  const navigateFile = useCallback((path: string, anchor?: string) => { void openFile(path, anchor); }, [openFile]);
  const refresh = useCallback(async () => {
    if (refreshingRef.current || !connected) return;
    refreshingRef.current = true; setRefreshing(true);
    const paths = ['', ...expandedRef.current].filter(path => !path || path.split('/').slice(0, -1).every((_, index, parts) => expandedRef.current.has(parts.slice(0, index + 1).join('/'))));
    let index = 0;
    const tasks = Array.from({ length: 2 }, async () => { while (index < paths.length && alive.current) await loadDirectory(paths[index++]); });
    if (selectedRef.current) tasks.push(openFile(selectedRef.current));
    try { await Promise.all(tasks); }
    finally { refreshingRef.current = false; if (alive.current) setRefreshing(false); }
  }, [connected, loadDirectory, openFile]);
  useEffect(() => {
    alive.current = true;
    if (connected) void loadDirectory('');
    return () => { alive.current = false; previewSequence.current++; sequence.current.forEach((value, key) => sequence.current.set(key, value + 1)); if (frame.current) cancelAnimationFrame(frame.current); document.body.classList.remove('files-resizing'); };
  }, [loadDirectory, connected]);
  useEffect(() => {
    const focus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  useEffect(() => { const resize = () => setWidth(clampWidth(desiredWidth.current)); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  function toggle(entry: ProjectFile) {
    if (expanded.has(entry.path)) setExpanded(previous => { const next = new Set(previous); next.delete(entry.path); return next; });
    else {
      setExpanded(previous => new Set(previous).add(entry.path));
      if (!directories[entry.path]?.loading) void loadDirectory(entry.path);
    }
  }
  function treeKeys(event: KeyboardEvent<HTMLElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!row) return;
    const rows = [...tree.current!.querySelectorAll<HTMLElement>('[role="treeitem"]:not(:disabled)')];
    const index = rows.indexOf(row), path = row.dataset.filePath ?? '';
    let target: HTMLElement | undefined;
    if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') target = rows[Math.max(index - 1, 0)];
    else if (event.key === 'Home') target = rows[0];
    else if (event.key === 'End') target = rows.at(-1);
    else if (event.key === 'ArrowRight') { if (row.getAttribute('aria-expanded') === 'false') row.click(); else if (row.getAttribute('aria-expanded') === 'true') target = rows[index + 1]; }
    else if (event.key === 'ArrowLeft') {
      if (row.getAttribute('aria-expanded') === 'true') row.click();
      else target = rows.find(item => item.dataset.filePath === path.split('/').slice(0, -1).join('/'));
    } else return;
    event.preventDefault(); event.stopPropagation(); target?.focus();
  }
  function renderDirectory(path: string, depth: number): React.ReactNode {
    const directory = directories[path];
    if (!directory || directory.loading && !directory.page) return <li className="file-tree-message" role="none">正在读取…</li>;
    if (directory.error) return <li className="file-tree-message" role="none"><span role="alert">{directory.error}</span><button onClick={() => void loadDirectory(path)} disabled={!connected}>重试</button></li>;
    const page = directory.page;
    if (!page) return null;
    const entries = page.entries.filter(entry => showIgnored || !entry.ignored);
    return <>{entries.map(entry => <li key={entry.path} role="none"><button role="treeitem" aria-level={depth + 1} aria-selected={selected === entry.path} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} disabled={entry.kind === 'other' || entry.unavailable || !connected} data-file-path={entry.path} className={`file-tree-row ${entry.ignored ? 'ignored' : ''} ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 13 }} title={`${entry.path}${entry.ignored ? '\nGit 已忽略' : ''}${entry.symlink ? entry.unavailable ? '\n链接不可访问或指向项目之外' : '\n符号链接' : ''}`} onClick={() => entry.kind === 'directory' ? toggle(entry) : void openFile(entry.path)}>
      <span className="file-chevron" aria-hidden="true">{entry.kind === 'directory' ? expanded.has(entry.path) ? '⌄' : '›' : ''}</span><EntryIcon directory={entry.kind === 'directory'} expanded={expanded.has(entry.path)} /><span className="file-name">{entry.name}</span>{entry.symlink && <span className="file-link-mark" aria-hidden="true">↗</span>}
    </button>{entry.kind === 'directory' && expanded.has(entry.path) && <ul role="group">{renderDirectory(entry.path, depth + 1)}</ul>}</li>)}{!entries.length && <li className="file-tree-message" role="none">{page.entries.length ? '当前内容均已忽略' : '空目录'}</li>}{page.nextOffset !== null && <li role="none"><button className="file-load-more" disabled={directory.loading || !connected} onClick={() => void loadDirectory(path, page.nextOffset!)}>{directory.loading ? '正在加载…' : `加载更多（${page.total - page.entries.length}）`}</button></li>}{page.truncated && <li className="file-tree-message" role="none">目录过大，仅展示前 {page.total} 项</li>}</>;
  }
  const finishDrag = (event: PointerEvent) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null; document.body.classList.remove('files-resizing'); commitWidth(pendingWidth.current);
  };
  return <aside id="project-file-browser" ref={host} className="file-browser" aria-label={`项目文件 ${project.name}`} style={{ '--files-width': `${width}px` } as CSSProperties}>
    <div className="files-resizer" role="separator" aria-label="调整文件面板宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={Math.max(280, host.current?.parentElement?.clientWidth ?? 900)} aria-valuenow={width} tabIndex={0} title="拖动调整文件面板，双击恢复默认"
      onDoubleClick={() => commitWidth(620)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); commitWidth(event.key === 'Home' ? 280 : event.key === 'End' ? 10000 : width + (event.key === 'ArrowLeft' ? 20 : -20)); }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const width = host.current!.getBoundingClientRect().width; drag.current = { id: event.pointerId, x: event.clientX, width }; pendingWidth.current = width; document.body.classList.add('files-resizing'); }}
      onPointerMove={event => { const start = drag.current; if (!start || start.id !== event.pointerId) return; pendingWidth.current = clampWidth(start.width + start.x - event.clientX); if (!frame.current) frame.current = requestAnimationFrame(() => { host.current?.style.setProperty('--files-width', `${pendingWidth.current}px`); frame.current = 0; }); }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag} />
    <header className="file-browser-header"><strong>文件</strong><span title={project.path}>{project.name}</span><button aria-label="刷新目录树" title="刷新展开的目录和当前文件" disabled={!connected || refreshing} onClick={() => void refresh()}>{refreshing ? '…' : '↻'}</button><button aria-label="收起全部目录" title="收起全部目录" onClick={() => setExpanded(new Set())}>⊟</button><button aria-label="关闭文件面板" title="关闭文件面板" onClick={onClose}>×</button></header>
    <div className="file-browser-body"><div className="file-navigation"><div className="file-tree-options"><button aria-pressed={showIgnored} title="Git 忽略的文件和目录以灰色显示" onClick={() => setShowIgnored(previous => { saveStored('berth.showIgnoredFiles', String(!previous)); return !previous; })}>{showIgnored ? '隐藏忽略项' : '显示忽略项'}</button><span>目录树</span></div>{directories['']?.page?.warning && <p className="file-tree-warning" role="status">{directories[''].page.warning}</p>}<nav ref={tree} className="file-tree" aria-label="项目目录树" onKeyDown={treeKeys}><ul role="tree" aria-label={project.name}>{renderDirectory('', 0)}</ul></nav><p className="file-tree-legend">{connected ? '按需展开 · 灰色表示 Git 忽略' : '后台已断开'}</p></div>
      <section className="file-preview-pane" aria-label="文件预览" aria-busy={loading}>
        {error && <div className="file-preview-error" role="alert"><p>{error}</p>{selected && <button disabled={!connected} onClick={() => void openFile(selected)}>重试</button>}</div>}
        {file ? <Suspense fallback={<div className="file-preview-empty">正在准备预览…</div>}><Preview file={file} projectId={project.id} markdown={markdown} onMarkdown={value => { setMarkdown(value); saveStored('berth.markdownPreview', value ? 'rendered' : 'source'); }} onNavigate={navigateFile} onRefresh={() => void openFile(selected)} onError={setError} /></Suspense> : !error && <div className="file-preview-empty"><EntryIcon directory={false} /><strong>{loading ? '正在读取文件…' : '选择文件预览'}</strong><p>代码高亮、图片和 Markdown，<br />直接在当前工作台查看。</p></div>}
      </section>
    </div>
  </aside>;
});
