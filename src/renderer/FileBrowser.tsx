import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from './Dialog';
import { createPortal } from 'react-dom';
import type { FilePreview, Project, ProjectFile, ProjectFilePage } from '../shared/protocol';
import { readStored, saveStored } from './storage';

const Preview = lazy(() => import('./FilePreview'));
type Directory = { page?: ProjectFilePage; loading: boolean; error?: string };
function EntryIcon({ directory, expanded }: { directory: boolean; expanded?: boolean }) {
  return <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d={directory ? expanded ? 'M2 7V4h6l2 2h8v2M2 8h17l-3 8H3L2 8Z' : 'M2 6V4h6l2 2h8v10H2V6Z' : 'M5 2h7l4 4v12H5V2Zm7 0v5h4'} /></svg>;
}
export default memo(function FileBrowser({ project, connected, treeHost, previewHost, onPreview, target }: { project: Project; connected: boolean; treeHost: HTMLElement | null; previewHost: HTMLElement | null; onPreview: () => void; target: { query: string; nonce: number } | null }) {
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ matches: ProjectFile[]; truncated: boolean; line?: number; column?: number } | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);
  const searchToken = useRef(0);
  const searchOpener = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ path: string; line: number; column: number; nonce: number } | null>(null);

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
      return result;
    } catch (reason) {
      if (alive.current && sequence.current.get(path) === token) setDirectories(previous => ({ ...previous, [path]: { loading: false, error: String(reason).replace(/^Error: /, '') } }));
    }
  }, [project.id]);
  const openFile = useCallback(async (path: string, anchor = '', activate = true) => {
    if (activate) onPreview();
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
  }, [project.id, onPreview]);
  const navigateFile = useCallback((path: string, anchor?: string) => { void openFile(path, anchor); }, [openFile]);
  const refresh = useCallback(async () => {
    if (refreshingRef.current || !connected) return;
    refreshingRef.current = true; setRefreshing(true);
    const paths = ['', ...expandedRef.current].filter(path => !path || path.split('/').slice(0, -1).every((_, index, parts) => expandedRef.current.has(parts.slice(0, index + 1).join('/'))));
    let index = 0;
    const tasks = Array.from({ length: 2 }, async () => { while (index < paths.length && alive.current) await loadDirectory(paths[index++]); });
    if (selectedRef.current) tasks.push(openFile(selectedRef.current, '', false));
    try { await Promise.all(tasks); }
    finally { refreshingRef.current = false; if (alive.current) setRefreshing(false); }
  }, [connected, loadDirectory, openFile]);
  useEffect(() => {
    alive.current = true;
    if (connected) void loadDirectory('');
    return () => { alive.current = false; previewSequence.current++; sequence.current.forEach((value, key) => sequence.current.set(key, value + 1)); };
  }, [loadDirectory, connected]);
  useEffect(() => {
    const focus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);
  const reveal = useCallback(async (entry: ProjectFile, line?: number, column?: number) => {
    setSearchOpen(false); setShowIgnored(true);
    const parts = entry.path.split('/');
    const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    if (entry.kind === 'directory' && entry.path) parents.push(entry.path);
    setExpanded(previous => new Set([...previous, ...parents]));
    // Only two directory reads at once, including paged parents.
    let rootPage = await loadDirectory('');
    while (rootPage?.nextOffset !== null && rootPage?.nextOffset !== undefined && !rootPage.entries.some(item => item.name === parts[0])) rootPage = await loadDirectory('', rootPage.nextOffset);
    let index = 0;
    await Promise.all(Array.from({ length: 2 }, async () => { while (index < parents.length && alive.current) {
      const parent = parents[index++], child = parts[parent.split('/').length];
      let page = await loadDirectory(parent);
      while (alive.current && page?.nextOffset !== null && page?.nextOffset !== undefined && child && !page.entries.some(item => item.name === child)) page = await loadDirectory(parent, page.nextOffset);
    } }));
    if (!alive.current) return;
    if (entry.kind === 'file') { setPosition(line ? { path: entry.path, line, column: column ?? 1, nonce: Date.now() } : null); if (line) setMarkdown(false); await openFile(entry.path); }
    else { setSelected(entry.path); }
    requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(entry.path)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [loadDirectory, openFile]);
  useEffect(() => {
    if (!target) return;
    searchOpener.current = document.activeElement as HTMLElement | null;
    setQuery(target.query); setSearchOpen(true); setMatchIndex(0); setSearchError(''); setMatches(null);
  }, [target]);
  useEffect(() => {
    if (!searchOpen) return;
    const token = ++searchToken.current;
    setSearching(true); setSearchError(''); setMatches(null); setMatchIndex(0);
    const timer = setTimeout(() => {
      if (!query.trim()) { setSearching(false); return; }
      void window.berth.rpc<{ matches: ProjectFile[]; truncated: boolean; line?: number; column?: number }>('findProjectFiles', { projectId: project.id, query }).then(result => {
        if (!alive.current || token !== searchToken.current) return;
        setMatches(result); setSearching(false);
        if (result.matches.length === 1 && !result.truncated && query === target?.query) void reveal(result.matches[0], result.line, result.column);
      }).catch(reason => { if (alive.current && token === searchToken.current) { setSearchError(String(reason)); setSearching(false); } });
    }, 180);
    return () => { clearTimeout(timer); searchToken.current++; };
  }, [query, searchOpen, project.id, reveal, target]);
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
    return <>
    {searchOpen && <Dialog title="定位文件或目录" onClose={() => setSearchOpen(false)} returnFocus={searchOpener.current} error={searchError}><input autoFocus aria-label="文件路径或模糊名称" value={query} placeholder="输入路径、文件名或缩写，可带 :行:列" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      const items = matches?.matches ?? [];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMatchIndex(index => Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
      if (event.key === 'Enter' && items[matchIndex]) { event.preventDefault(); void reveal(items[matchIndex], matches?.line, matches?.column); }
    }} /><div className="file-match-list" role="listbox" aria-label="匹配的文件和目录">{matches?.matches.map((entry, index) => <button key={entry.path} role="option" aria-selected={matchIndex === index} className={matchIndex === index ? 'selected' : ''} onMouseEnter={() => setMatchIndex(index)} onClick={() => void reveal(entry, matches.line, matches.column)}><EntryIcon directory={entry.kind === 'directory'} /><span>{entry.path || project.name}</span><small>{entry.kind === 'directory' ? '目录' : '文件'}</small></button>)}</div><p className="form-hint" role="status">{searching ? '正在查找…' : matches ? matches.matches.length ? `${matches.matches.length} 个匹配 · ↑↓ 选择 · Enter 打开${matches.truncated ? ' · 结果较多，请补充路径缩小范围' : ''}` : '未找到匹配，可修改路径后重试' : '在当前项目中查找；支持完整路径、相对路径和模糊缩写。'}</p></Dialog>}
{entries.map(entry => <li key={entry.path} role="none"><button role="treeitem" aria-level={depth + 1} aria-selected={selected === entry.path} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} disabled={entry.kind === 'other' || entry.unavailable || !connected} data-file-path={entry.path} className={`file-tree-row ${entry.ignored ? 'ignored' : ''} ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 13 }} title={`${entry.path}${entry.ignored ? '\nGit 已忽略' : ''}${entry.symlink ? entry.unavailable ? '\n链接不可访问或指向项目之外' : '\n符号链接' : ''}`} onClick={() => { if (entry.kind === 'directory') toggle(entry); else { setPosition(null); void openFile(entry.path); } }}>
      <span className="file-chevron" aria-hidden="true">{entry.kind === 'directory' ? expanded.has(entry.path) ? '⌄' : '›' : ''}</span><EntryIcon directory={entry.kind === 'directory'} expanded={expanded.has(entry.path)} /><span className="file-name">{entry.name}</span>{entry.symlink && <span className="file-link-mark" aria-hidden="true">↗</span>}
    </button>{entry.kind === 'directory' && expanded.has(entry.path) && <ul role="group">{renderDirectory(entry.path, depth + 1)}</ul>}</li>)}{!entries.length && <li className="file-tree-message" role="none">{page.entries.length ? '当前内容均已忽略' : '空目录'}</li>}{page.nextOffset !== null && <li role="none"><button className="file-load-more" disabled={directory.loading || !connected} onClick={() => void loadDirectory(path, page.nextOffset!)}>{directory.loading ? '正在加载…' : `加载更多（${page.total - page.entries.length}）`}</button></li>}{page.truncated && <li className="file-tree-message" role="none">目录过大，仅展示前 {page.total} 项</li>}</>;
  }
  return <>
    {treeHost && createPortal(<div className="file-navigation">
      <button className="file-find-button" title="模糊查找文件或目录" onClick={() => { searchOpener.current = document.activeElement as HTMLElement; setQuery(''); setSearchOpen(true); }}>查找文件或目录…<kbd>路径</kbd></button>
      <div className="file-tree-options"><button aria-pressed={showIgnored} title="Git 忽略的文件和目录以灰色显示" onClick={() => setShowIgnored(previous => { saveStored('berth.showIgnoredFiles', String(!previous)); return !previous; })}>{showIgnored ? '隐藏忽略项' : '显示忽略项'}</button><div><button aria-label="刷新目录树" title="刷新展开的目录和当前文件" disabled={!connected || refreshing} onClick={() => void refresh()}>{refreshing ? '…' : '↻'}</button><button aria-label="收起全部目录" title="收起全部目录" onClick={() => setExpanded(new Set())}>⊟</button></div></div>
      {directories['']?.page?.warning && <p className="file-tree-warning" role="status">{directories[''].page.warning}</p>}
      <nav ref={tree} className="file-tree" aria-label="项目目录树"><ul role="tree" aria-label={project.name} onKeyDown={treeKeys}>{renderDirectory('', 0)}</ul></nav>
      <p className="file-tree-legend">{connected ? '灰色表示 Git 忽略 · 单击文件预览' : '后台已断开'}</p>
    </div>, treeHost)}
    {previewHost && createPortal(<section ref={host} className="file-preview-pane" aria-label="文件预览" aria-busy={loading}>
      {error && <div className="file-preview-error" role="alert"><p>{error}</p>{selected && <button disabled={!connected} onClick={() => void openFile(selected)}>重试</button>}</div>}
      {file ? <Suspense fallback={<div className="file-preview-empty">正在准备预览…</div>}><Preview position={position} file={file} projectId={project.id} markdown={markdown} onMarkdown={value => { setMarkdown(value); saveStored('berth.markdownPreview', value ? 'rendered' : 'source'); }} onNavigate={navigateFile} onRefresh={() => void openFile(selected)} onError={setError} /></Suspense> : !error && <div className="file-preview-empty"><EntryIcon directory={false} /><strong>{loading ? '正在读取文件…' : '选择文件预览'}</strong><p>从左侧“文件”选择文档或代码，<br />在这里查看源码、图片和 Markdown。</p></div>}
    </section>, previewHost)}
  </>;
});
