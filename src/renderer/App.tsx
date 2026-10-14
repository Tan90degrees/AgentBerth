import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { API_VERSION, DEFAULT_SETTINGS, type Agent, type History, type Method, type Project, type Run, type Session, type Settings, type State, type TerminalConfig } from '../shared/protocol';
import { TerminalView, OutputView } from './TerminalView';
import { TerminalState } from './TerminalState';
import { TerminalFields } from './TerminalFields';
import { SettingsPage } from './SettingsPage';
import { agentNames, statusNames, terminalNames } from './labels';
import { Dialog } from './Dialog';
import { QuickSwitcher, type SwitchTarget } from './QuickSwitcher';
import { loadCollapsedProjects, loadSelections, loadSettingsDraft, readStored, saveStored, type SettingsDraft } from './storage';

import { matchesSession, ProjectTree, ResizableSidebar } from './WorkspaceSidebar';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
type Modal = 'project' | 'editProject' | 'deleteProject' | 'session' | 'editSession' | 'deleteSession' | 'stop' | 'link' | 'restart' | null;
const normalize = (value: State): State => ({ ...value, apiVersion: value.apiVersion ?? 1, settings: { ...structuredClone(DEFAULT_SETTINGS), ...value.settings }, sessions: value.sessions.map(session => ({ ...session, terminal: session.terminal ?? null })) });

function Icon({ kind }: { kind: 'folder' | 'terminal' | 'plus' | 'arrow' | 'history' | 'settings' }) {
  const paths = { folder: 'M3 7V5h6l2 2h10v12H3V7Z', terminal: 'm5 7 4 4-4 4m7 0h6', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
export function App() {
  const [state, setState] = useState<State>({ projects: [], sessions: [], maxActiveTerminals: 16, platform: '', settings: structuredClone(DEFAULT_SETTINGS), apiVersion: API_VERSION });
  const [projectId, setProjectId] = useState(() => readStored('berth.project') ?? '');
  const [sessionId, setSessionId] = useState(() => readStored('berth.session') ?? '');
  const [page, setPage] = useState<'workspace' | 'settings'>('workspace');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(loadCollapsedProjects);
  const deferredSearch = useDeferredValue(search);
  const [tab, setTab] = useState<'terminal' | 'history' | 'runs'>('terminal');
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(loadSettingsDraft);
  const remembered = useRef(loadSelections());
  const opener = useRef<HTMLElement | null>(null);
  const initialForm = useRef('');
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [agent, setAgent] = useState<Agent>('codex');
  const [command, setCommand] = useState('');
  const [terminal, setTerminal] = useState<TerminalConfig | null>(null);
  const [nativeId, setNativeId] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [history, setHistory] = useState<History | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [viewingRun, setViewingRun] = useState<{ sessionId: string; runId: string } | null>(null);
  const outputRunId = viewingRun?.sessionId === sessionId ? viewingRun.runId : null;
  const project = state.projects.find(item => item.id === projectId);
  const projectSessions = useMemo(() => state.sessions.filter(item => item.projectId === projectId), [state.sessions, projectId]);
  const session = projectSessions.find(item => item.id === sessionId);
  const running = useMemo(() => state.sessions.filter(active).length, [state.sessions]);
  const windowsPty = useMemo(() => state.windowsPty, [state.windowsPty?.backend, state.windowsPty?.buildNumber]);
  const legacy = state.apiVersion < API_VERSION;
  const manageDisabled = busy || !connected || state.apiVersion < 2;
  const draftDirty = !!settingsDraft && JSON.stringify(settingsDraft.value) !== JSON.stringify(state.settings);
  const draftConflict = draftDirty && JSON.stringify(settingsDraft?.base) !== JSON.stringify(state.settings);
  const formValue = modal === 'project' || modal === 'editProject' ? JSON.stringify({ name, folder }) : modal === 'session' || modal === 'editSession' ? JSON.stringify({ title, agent, command, terminal, startNow }) : modal === 'link' ? JSON.stringify(nativeId) : '';
  const dirtyForm = !!formValue && formValue !== initialForm.current;

  useEffect(() => {
    if (!window.berth) { setLoading(false); setError('请通过 AgentBerth 桌面应用打开工作台'); return; }
    const off = window.berth.onEvent(event => {
      if (event.event === 'state') { setState(normalize(event.data)); setLoading(false); }
      if (event.event === 'connection') { setConnected(event.data.connected); if (event.data.connected) setConnectionEpoch(n => n + 1); if (event.data.error) setError(event.data.error); }
    });
    void window.berth.rpc<State>('state').then(value => { setState(normalize(value)); setConnected(true); setLoading(false); }).catch(reason => { setError(String(reason)); setLoading(false); });
    return off;
  }, []);
  useEffect(() => { if (!loading && !state.projects.some(item => item.id === projectId)) setProjectId(state.projects[0]?.id ?? ''); }, [state.projects, projectId, loading]);
  useEffect(() => {
    if (loading || projectSessions.some(item => item.id === sessionId)) return;
    const saved = remembered.current[projectId];
    setSessionId(projectSessions.find(item => item.id === saved)?.id ?? projectSessions[0]?.id ?? '');
  }, [state.sessions, projectId, sessionId, loading]);
  useEffect(() => {
    if (loading) return;
    const valid = new Set(state.sessions.map(item => item.id));
    remembered.current = Object.fromEntries(Object.entries(remembered.current).filter(([id, selected]) => state.projects.some(item => item.id === id) && valid.has(selected)));
    if (session) remembered.current[projectId] = session.id;
    saveStored('berth.selections', JSON.stringify(remembered.current));
  }, [state.projects, state.sessions, projectId, sessionId, loading]);
  useEffect(() => { saveStored('berth.project', projectId); }, [projectId]);
  useEffect(() => { saveStored('berth.session', sessionId); setTerminalVisible(true); setRunOutput(null); }, [sessionId]);
  useEffect(() => { if (!error || modal || page === 'settings') return; const timer = setTimeout(() => setError(''), 12000); return () => clearTimeout(timer); }, [error, modal, page]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 2500); return () => clearTimeout(timer); }, [message]);
  useEffect(() => { if (!loading) saveStored('berth.settingsDraft', draftDirty ? JSON.stringify(settingsDraft) : null); }, [settingsDraft, state.settings, loading]);
  useEffect(() => { if (!loading && settingsDraft && !draftDirty) setSettingsDraft(null); }, [settingsDraft, draftDirty, loading]);
  useEffect(() => {
    if (!session || !connected) return;
    let canceled = false;
    setHistory(null); setRuns([]); setRunOutput(null);
    if (tab === 'history') void window.berth.rpc<History>('history', { sessionId }).then(value => { if (!canceled) setHistory(value); }).catch(reason => { if (!canceled) setError(String(reason)); });
    if (tab === 'runs') void window.berth.rpc<Run[]>('runs', { sessionId }).then(async value => {
      if (canceled) return;
      setRuns(value);
      if (outputRunId) {
        if (!value.some(run => run.id === outputRunId)) { setViewingRun(null); setError('运行记录已不存在'); return; }
        const text = await window.berth.rpc<string>('output', { runId: outputRunId });
        if (!canceled) setRunOutput(text);
      }
    }).catch(reason => { if (!canceled) { setError(String(reason)); setViewingRun(null); } });
    return () => { canceled = true; };
  }, [sessionId, tab, connected, session?.agent, session?.transcriptPath, session?.nativeSessionId, session?.latestRun?.status, outputRunId]);

  async function perform<T>(method: Method, params: Record<string, unknown>): Promise<T | undefined> {
    setBusy(true); setError(''); setMessage('');
    try { return await window.berth.rpc<T>(method, params); }
    catch (reason) { setError(String(reason)); return undefined; }
    finally { setBusy(false); }
  }
  const expandProject = useCallback((id: string) => setCollapsed(previous => previous.includes(id) ? previous.filter(item => item !== id) : previous), []);
  const selectProject = useCallback((id: string) => { setProjectId(id); setSearch(''); setFilter('all'); setPage('workspace'); setError(''); expandProject(id); }, [expandProject]);
  const selectSession = useCallback((projectId: string, sessionId: string) => { setProjectId(projectId); setSessionId(sessionId); setPage('workspace'); setTab('terminal'); setError(''); expandProject(projectId); }, [expandProject]);
  const toggleProject = useCallback((id: string) => setCollapsed(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]), []);
  useEffect(() => { if (!loading) saveStored('berth.collapsedProjects', JSON.stringify(collapsed.filter(id => state.projects.some(project => project.id === id)))); }, [collapsed, state.projects, loading]);
  function openModal(value: Modal) { if (!quickOpen) opener.current = document.activeElement as HTMLElement | null; setError(''); setModal(value); }
  function clearFilter() { setSearch(''); setFilter('all'); }
  function newProject() { setFolder(''); setName(''); initialForm.current = JSON.stringify({ name: '', folder: '' }); openModal('project'); }
  function editProject() { if (!project) return; setFolder(project.path); setName(project.name); initialForm.current = JSON.stringify({ name: project.name, folder: project.path }); openModal('editProject'); }
  function sessionForm(value: { title: string; agent: Agent; command: string; terminal: TerminalConfig | null; startNow: boolean }, editing = false) {
    setTitle(value.title); setAgent(value.agent); setCommand(value.command); setTerminal(value.terminal); setStartNow(value.startNow);
    initialForm.current = JSON.stringify(value); openModal(editing ? 'editSession' : 'session');
  }
  function newSession(id = projectId) { selectProject(id); sessionForm({ title: '', agent: state.settings.defaultAgent, command: state.settings.defaultAgent === 'custom' ? state.settings.defaultCommand : '', terminal: null, startNow: true }); }
  function editSession() { if (session) sessionForm({ title: session.title, agent: session.agent, command: session.command, terminal: session.terminal, startNow: false }, true); }
  function copySession() { if (session) sessionForm({ title: session.title.slice(0, 90) + ' · 副本', agent: session.agent, command: session.command, terminal: session.terminal, startNow: false }); }
  function openLink() { const value = session?.nativeSessionId ?? ''; setNativeId(value); initialForm.current = JSON.stringify(value); openModal('link'); }
  function openQuick() { opener.current = document.activeElement as HTMLElement | null; setQuickOpen(true); }
  function chooseTarget(target: SwitchTarget) {
    setQuickOpen(false);
    if (target.kind === 'action') { if (target.action === 'settings') { setPage('settings'); setError(''); } else if (target.action === 'project') newProject(); else newSession(); return; }
    selectProject(target.projectId!); if (target.sessionId) setSessionId(target.sessionId); setTab('terminal');
  }
  async function copyText(text: string, label: string) { try { await window.berth.copyText(text); setMessage(label + '已复制'); } catch (reason) { setError(String(reason)); } }
  function cycleSession(previous: boolean) {
    if (!project) return;
    const visible = projectSessions.filter(item => matchesSession(item, project, deferredSearch, filter));
    if (!visible.length) { setMessage('当前筛选下没有可切换的会话'); return; }
    const index = visible.findIndex(item => item.id === sessionId);
    const next = visible[index < 0 ? previous ? visible.length - 1 : 0 : (index + (previous ? -1 : 1) + visible.length) % visible.length];
    if (next.id !== sessionId) (document.activeElement as HTMLElement | null)?.blur();
    selectSession(project.id, next.id); setTerminalVisible(true);
    if (next.id === sessionId) document.querySelector<HTMLTextAreaElement>('[data-testid="terminal"] .xterm-helper-textarea')?.focus();
  }
  const shortcuts = useRef({ modal, busy, quickOpen, manageDisabled, project, page, newProject, newSession, openQuick, cycleSession });
  shortcuts.current = { modal, busy, quickOpen, manageDisabled, project, page, newProject, newSession, openQuick, cycleSession };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const current = shortcuts.current;
      if (event.isComposing || event.getModifierState('AltGraph') || current.modal || current.busy || !(event.ctrlKey || event.metaKey)) return;
      const value = event.key.toLowerCase();
      if (value === 'p' && event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (current.quickOpen) setQuickOpen(false); else current.openQuick(); }
      else if (value === ',' && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); setQuickOpen(false); setPage('settings'); setError(''); }
      else if ((value === 'n' || value === 'o') && event.shiftKey && !event.altKey && !current.manageDisabled && !current.quickOpen) { event.preventDefault(); event.stopPropagation(); if (value === 'o') current.newProject(); else if (current.project) current.newSession(); else setMessage('请先添加一个项目'); }
      else if (value === 'tab' && !event.altKey && !current.quickOpen && current.page === 'workspace') { event.preventDefault(); event.stopPropagation(); current.cycleSession(event.shiftKey); }
    };
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true);
  }, []);
  async function selectFolder() {
    try { const value = await window.berth.chooseDirectory(); if (value) { setFolder(value); if (!name) setName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目'); } }
    catch (reason) { setError(String(reason)); }
  }
  async function submitProject(event: FormEvent) {
    event.preventDefault(); const result = await perform<Project>(modal === 'editProject' ? 'updateProject' : 'createProject', { ...(modal === 'editProject' ? { projectId } : {}), name, path: folder });
    if (result) { selectProject(result.id); setModal(null); }
  }
  async function submitSession(event: FormEvent) {
    event.preventDefault(); const editing = modal === 'editSession';
    const result = await perform<Session>(editing ? 'updateSession' : 'createSession', { ...(editing ? { sessionId } : { projectId }), title, agent, command: agent === 'custom' ? command : '', terminal });
    if (result) { expandProject(result.projectId); setSessionId(result.id); setTab('terminal'); setSearch(''); setFilter('all'); setModal(null); if (!editing && startNow) await perform('start', { sessionId: result.id, resume: false, cols: 100, rows: 30 }); }
  }
  async function importHistory() {
    try { const file = await window.berth.chooseTranscript(); if (!file) return; const result = await perform<History>('importHistory', { sessionId, path: file }); if (result) { setHistory(result); setTab('history'); } }
    catch (reason) { setError(String(reason)); }
  }
  async function restartBackend() {
    setBusy(true); setError(''); setMessage('');
    try { await window.berth.restartBackend(); setModal(null); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const closeModal = () => { setModal(null); setError(''); };
  const cancelButton = <button type="button" data-dismiss="dialog" className="subtle" disabled={busy} onClick={closeModal}>取消</button>;

  return <div className="app">
    <ResizableSidebar>
      <div className="brand"><div className="brand-mark">B<span>·</span></div><div><strong>AgentBerth</strong><small>泊栈 · 项目会话工作台</small></div></div>
      <button className="quick-link" onClick={openQuick} title="Ctrl+Shift+P">快速切换<kbd>Ctrl+Shift+P</kbd></button>
      <div className="sidebar-heading"><span>项目与会话</span><button className="icon-button" aria-label="添加项目" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" /></button></div>
      {state.projects.length > 0 && <div className="tree-search"><input className="search" placeholder="搜索项目、会话或目录…" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索项目和会话" /><select className="session-filter" aria-label="筛选会话" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部会话</option><option value="active">运行中</option><option value="inactive">未运行</option>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{(search || filter !== 'all') && <button className="clear-filter" onClick={clearFilter}>清除筛选</button>}</div>}
      <ProjectTree projects={state.projects} sessions={state.sessions} projectId={page === 'workspace' ? projectId : ''} sessionId={page === 'workspace' ? sessionId : ''} collapsed={collapsed} query={deferredSearch} filter={filter} disabled={manageDisabled} onToggle={toggleProject} onProject={selectProject} onSession={selectSession} onNewSession={newSession} />
      <button className="add-project" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" />添加项目目录</button>
      <button className={`settings-link ${page === 'settings' ? 'selected' : ''}`} onClick={() => { setPage('settings'); setError(''); }} title="Ctrl+," aria-label="设置"><Icon kind="settings" />设置{draftDirty && <span className="draft-dot" title="有未保存的设置草稿" />}</button>
      <div className="sidebar-bottom"><span className={`dot ${connected ? 'live' : ''}`} /><span>{connected ? '后台已连接' : '后台未连接'}</span><button className="text-button" disabled={busy} onClick={() => void window.berth?.reconnect().catch(reason => setError(String(reason)))}>重连</button></div>
    </ResizableSidebar>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">{page === 'settings' ? 'SETTINGS' : 'WORKSPACE'}</span><span className="crumb"> / {page === 'settings' ? '应用设置' : project?.name ?? '欢迎来到泊栈'}</span></div><div className="topbar-status"><span className={`dot ${connected ? 'live' : ''}`} />{running} 个终端后台运行 <span className="quiet">/ {state.maxActiveTerminals}</span></div></header>
      {legacy && <div className="upgrade-notice" role="status"><span>旧版后台仍在运行。停止全部终端后更新后台，即可启用当前版本的全部功能。</span><button className="subtle" disabled={!connected || busy || running > 0} onClick={() => openModal('restart')}>更新后台</button></div>}
      {loading ? <div className="empty-page"><div className="loader" /><h2>正在连接你的工作空间</h2></div> : page === 'settings' ? <SettingsPage settings={state.settings} draft={draftDirty ? settingsDraft!.value : state.settings} onChange={value => setSettingsDraft(JSON.stringify(value) === JSON.stringify(state.settings) ? null : { base: state.settings, value })} onDiscard={() => { setSettingsDraft(null); setError(''); }} conflict={draftConflict} onError={setError} error={error} platform={state.platform} disabled={manageDisabled || legacy} restartDisabled={busy || !connected} running={running} onSave={async (value: Settings) => { const result = await perform<Settings>('saveSettings', { ...value }); if (result !== undefined) { setSettingsDraft(null); return true; } return false; }} onRestart={() => openModal('restart')} /> : !project ? <div className="empty-page welcome"><div className="welcome-symbol"><Icon kind="terminal" /></div><span className="eyebrow">A BERTH FOR EVERY SESSION</span><h1>为项目留一个泊位。</h1><p>目录、终端和对话记录，放在同一个工作台。<br />关掉窗口，再回来继续。</p><button className="primary" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" />添加第一个项目</button><div className="welcome-features"><span><Icon kind="folder" />按目录组织</span><span><Icon kind="terminal" />多会话后台运行</span><span><Icon kind="history" />原生对话关联</span></div></div> : <>
        <section className="project-header"><div><span className="eyebrow">PROJECT SPACE</span><h1>{project.name}</h1><div className="path-row"><button className="path-button" title={project.path} aria-label="在文件管理器中打开项目" onClick={() => void window.berth.openProject(project.path).catch(reason => setError(String(reason)))}><Icon kind="folder" /><span>{project.path}</span><Icon kind="arrow" /></button><button className="text-button path-copy" aria-label="复制项目路径" onClick={() => void copyText(project.path, '项目路径')}>复制路径</button></div></div><div className="project-actions"><button className="subtle" onClick={editProject} disabled={manageDisabled}>编辑项目</button><button className="subtle danger-text" onClick={() => openModal('deleteProject')} disabled={manageDisabled || projectSessions.some(active)} title={projectSessions.some(active) ? '先停止本项目的全部终端' : '删除项目登记及工作台记录'}>删除项目</button><button className="primary" onClick={() => newSession()} disabled={manageDisabled}><Icon kind="plus" />新建会话</button></div></section>
        <section className="workspace">
          <div className="session-content">{!session ? <div className="empty-page"><Icon kind="terminal" /><h2>选择或创建一个会话</h2></div> : <>
            <header className="session-header"><div><h2>{session.title}</h2><span className={`badge ${active(session) ? 'live-badge' : ''}`}>{statusNames[session.latestRun?.status ?? ''] ?? '待启动'}</span><span className="agent-label">{agentNames[session.agent]}</span></div><div className="session-actions"><button className="subtle" disabled={manageDisabled} onClick={editSession}>编辑会话</button><button className="subtle" disabled={manageDisabled} onClick={copySession}>复制会话</button><button className="subtle danger-text" disabled={manageDisabled || active(session)} title={active(session) ? '先停止终端，再删除会话' : '删除会话和运行记录'} onClick={() => openModal('deleteSession')}>删除会话</button>{active(session) ? <button className="danger" disabled={busy || session.latestRun?.status === 'stopping' || !connected} onClick={() => openModal('stop')}>停止终端</button> : <><button className="primary compact" disabled={manageDisabled} onClick={() => void perform('start', { sessionId, resume: false, cols: 100, rows: 30 })}>启动终端</button>{session.nativeSessionId && <button className="subtle" disabled={manageDisabled} onClick={() => void perform('start', { sessionId, resume: true, cols: 100, rows: 30 })}>恢复原生会话</button>}</>}</div></header>
            {!!session && !matchesSession(session, project, deferredSearch, filter) && <div className="filter-notice">当前会话不在筛选结果中，终端仍可继续使用。</div>}
            <div className="tabs" role="tablist">{(['terminal', 'history', 'runs'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'terminal' ? '终端' : value === 'history' ? '对话历史' : '运行记录'}</button>)}{tab === 'terminal' && session.latestRun?.status === 'running' && <button className="hide-terminal" onClick={() => setTerminalVisible(value => !value)}>{terminalVisible ? '收起终端' : '接回终端'}</button>}</div>
            {tab === 'terminal' && <div className="terminal-panel">{session.latestRun?.error && <div className="launch-error" role="status"><strong>{session.latestRun?.status === 'interrupted' ? '上次运行已中断' : '启动未完成'}</strong><p>{session.latestRun.error}</p><div><button className="subtle" disabled={manageDisabled} onClick={editProject}>修改项目目录</button><button className="subtle" disabled={manageDisabled} onClick={editSession}>修改启动配置</button><button className="subtle" onClick={() => { setPage('settings'); setError(''); }}>打开终端设置</button><button className="primary compact" disabled={manageDisabled} onClick={() => void perform('start', { sessionId, resume: false, cols: 100, rows: 30 })}>重新启动</button></div></div>}{connected && session.latestRun?.status !== 'running' ? <TerminalState run={session.latestRun} disabled={manageDisabled} onStart={() => void perform('start', { sessionId, resume: false, cols: 100, rows: 30 })} onOutput={() => { if (session.latestRun) { setViewingRun({ sessionId, runId: session.latestRun.id }); setTab('runs'); } }} /> : connected && terminalVisible ? <TerminalView key={`${session.id}:${session.latestRun?.id}:${connectionEpoch}`} sessionId={sessionId} windowsPty={windowsPty} fontSize={state.settings.fontSize} autoFocus={!modal && !quickOpen} onError={setError} /> : <div className="empty-page"><Icon kind="terminal" /><h2>{connected ? '终端已收起' : '后台连接已断开'}</h2><p>{connected ? '运行中的任务仍在后台继续。' : '重新连接后接回终端。'}</p><button className="subtle" onClick={() => connected ? setTerminalVisible(true) : void window.berth.reconnect().catch(reason => setError(String(reason)))}>{connected ? '接回终端' : '重新连接'}</button></div>}<footer className="terminal-footer"><span>{session.latestRun ? `${active(session) ? '运行' : '上次运行'} ${session.latestRun.id.slice(0, 8)}${active(session) ? ` · PID ${session.latestRun.pid ?? '—'}` : ''}` : '尚未启动'} · {session.latestRun ? session.latestRun.shell?.split(/[\\/]/).at(-1) || '历史终端' : terminalNames[(session.terminal ?? state.settings.terminal).profile]}</span><span>关窗口继续运行 · 托盘退出停止全部终端</span></footer></div>}
            {tab === 'history' && <div className="history-panel"><div className="panel-toolbar"><span>Agent 原生对话 · 只读文本视图</span><div><button className="subtle" disabled={manageDisabled || !session.transcriptPath} onClick={async () => { const result = await perform<History>('refreshHistory', { sessionId }); if (result) setHistory(result); }}>刷新记录</button><button className="subtle" disabled={manageDisabled || active(session) || !['codex', 'claude', 'opencode'].includes(session.agent)} onClick={openLink}>关联会话 ID</button><button className="subtle" disabled={manageDisabled || !['codex', 'claude', 'opencode'].includes(session.agent)} onClick={() => void importHistory()}>{session.agent === 'opencode' ? '关联 JSON' : '关联 JSONL'}</button></div></div>{history?.nativeSessionId && <div className="history-meta"><div className="history-id"><code>{history.nativeSessionId}</code><button className="text-button" onClick={() => void copyText(history.nativeSessionId!, '原生会话 ID')}>复制 ID</button></div><small title={history.path ?? ''}>{history.path ?? '已关联原生 ID，可恢复会话；导入记录后显示文本。'}</small></div>}<div className="messages">{history?.messages.length ? history.messages.map((message, index) => <article className={`message ${message.role}`} key={index}><header><strong>{message.role === 'user' ? '你' : agentNames[session.agent]}</strong><time>{message.timestamp ? date(message.timestamp) : ''}</time></header><p>{message.text}</p></article>) : <div className="empty-page"><Icon kind="history" /><h2>把对话带回项目</h2><p>{session.agent === 'opencode' ? <>在此项目中执行 <code>opencode export 会话ID &gt; session.json</code>，<br />然后关联导出的 JSON。也可以直接关联原生会话 ID。</> : <>选择此项目的 Codex 或 Claude Code 原生 JSONL，<br />查看历史，并按会话 ID 再次启动。</>}</p></div>}{history?.warnings.map(warning => <p className="history-warning" key={warning}>{warning}</p>)}</div></div>}
            {tab === 'runs' && <div className="runs-panel"><div className="panel-toolbar"><span>{outputRunId ? '本次运行输出 · 只读' : '每次启动都有独立记录'}</span><button className="text-button" onClick={() => setViewingRun(null)}>返回列表</button></div>{outputRunId && runOutput === null ? <div className="empty-page"><div className="loader" /><p>正在读取本次输出</p></div> : runOutput !== null ? <OutputView windowsPty={windowsPty} key={outputRunId} onError={setError} fontSize={state.settings.fontSize} text={runOutput || '保留范围内没有输出；较旧日志可能已清理。'} /> : <div className="runs-list">{runs.map(run => <button className="run-item" key={run.id} onClick={() => setViewingRun({ sessionId, runId: run.id })}><span><code>{run.id.slice(0, 8)}</code><small title={run.shell}>{run.command || '交互式 Shell'}{run.shell ? ` · ${run.shell.split(/[\\/]/).at(-1)}` : ''}</small></span><span>{date(run.startedAt)}</span><span className="badge">{statusNames[run.status]}</span><span>退出码 {run.exitCode ?? '—'}</span><Icon kind="arrow" /></button>)}{!runs.length && <div className="empty-page"><h2>尚无运行记录</h2><p>启动终端后，会在这里保留记录。</p></div>}</div>}</div>}
          </>}</div>
        </section>
      </>}
    </main>
    {quickOpen && <QuickSwitcher state={state} canCreate={!manageDisabled} hasProject={!!project} onSelect={chooseTarget} onClose={() => setQuickOpen(false)} returnFocus={opener.current} />}
    {message && <div className="toast success-toast" role="status">{message}</div>}
    {error && !modal && page !== 'settings' && <div className="toast" role="alert"><span>{error.replace(/^Error: /, '')}</span><button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    {(modal === 'project' || modal === 'editProject') && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title={modal === 'project' ? '添加项目目录' : '编辑项目'} onClose={closeModal}><form onSubmit={submitProject}><label>项目名称<input aria-label="项目名称" autoFocus required pattern=".*\S.*" title="请填写至少一个非空白字符" maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如 OmniOCR" /></label><label>项目目录<div className="input-with-button"><input aria-label="项目目录" required disabled={modal === 'editProject' && projectSessions.some(active)} value={folder} onChange={event => setFolder(event.target.value)} placeholder={state.platform === 'win32' ? 'D:\\Projects\\OmniOCR' : '/home/user/projects/OmniOCR'} /><button type="button" className="subtle" disabled={modal === 'editProject' && projectSessions.some(active)} onClick={() => void selectFolder()}>选择目录</button></div></label><p className="form-hint">{modal === 'editProject' ? '运行中的项目可以修改名称。修改目录前请停止全部终端；修改后会清除原生对话关联，避免从错误目录恢复。' : '会话从这个目录启动，同一路径自动去重。'}</p><footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'project' ? '添加项目' : '保存项目'}</button></footer></form></Dialog>}
    {(modal === 'session' || modal === 'editSession') && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title={modal === 'session' ? '新建项目会话' : '编辑会话'} onClose={closeModal}><form onSubmit={submitSession}><label>会话名称<input aria-label="会话名称" autoFocus required pattern=".*\S.*" title="请填写至少一个非空白字符" maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如 修复 OCR 调度问题" /></label><label>Agent 类型<select aria-label="Agent 类型" disabled={modal === 'editSession' && !!session && active(session)} value={agent} onChange={event => setAgent(event.target.value as Agent)}>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{agent === 'custom' && <label>启动命令<input aria-label="启动命令" required maxLength={4096} disabled={modal === 'editSession' && !!session && active(session)} value={command} onChange={event => setCommand(event.target.value)} placeholder="你的 Agent TUI 启动命令" /></label>}<TerminalFields value={terminal} onError={setError} platform={state.platform} inherit disabled={modal === 'editSession' && !!session && active(session)} onChange={setTerminal} /><p className="form-hint">工作目录：{project?.path}<br />{modal === 'editSession' ? '启动配置需在停止终端后修改；更换 Agent 会清除原生对话关联。' : 'Agent 使用本机已有安装和登录状态。'}{agent === 'opencode' && <><br />启动 opencode；关联会话后使用 opencode --session ID 恢复。</>}</p>{modal === 'session' && <label className="checkbox-label"><input type="checkbox" checked={startNow} onChange={event => setStartNow(event.target.checked)} />创建后立即启动</label>}<footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'editSession' ? '保存会话' : startNow ? '创建并启动' : '创建会话'}</button></footer></form></Dialog>}
    {modal === 'deleteSession' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="删除此会话？" onClose={closeModal}><p className="stop-description">删除「{session?.title}」及其运行记录、工作台日志和导入的对话副本。此操作无法撤销。<br />项目文件和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={async () => { if (await perform('deleteSession', { sessionId }) !== undefined) setModal(null); }}>确认删除会话</button></footer></Dialog>}
    {modal === 'deleteProject' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="删除此项目？" onClose={closeModal}><p className="stop-description">删除「{project?.name}」的项目登记及全部 {projectSessions.length} 个会话、运行记录和工作台日志。此操作无法撤销。<br />磁盘上的项目目录和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={async () => { if (await perform('deleteProject', { projectId }) !== undefined) setModal(null); }}>确认删除项目</button></footer></Dialog>}
    {modal === 'stop' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="停止此终端？" onClose={closeModal}><p className="stop-description">「{session?.title}」正在执行的任务会中断。<br />如需保留后台任务，可以收起终端或关闭窗口。</p><footer><button className="subtle" disabled={busy} onClick={closeModal}>继续运行</button><button className="danger" disabled={busy} onClick={async () => { if (await perform('stop', { sessionId }) !== undefined) setModal(null); }}>停止终端</button></footer></Dialog>}
    {modal === 'link' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="关联原生会话 ID" onClose={closeModal}><form onSubmit={async event => { event.preventDefault(); const result = await perform<History>('linkNativeSession', { sessionId, nativeSessionId: nativeId.trim() }); if (result) { setHistory(result); setModal(null); } }}><label>原生会话 ID<input aria-label="原生会话 ID" autoFocus required maxLength={128} pattern="[a-zA-Z0-9_-]+" value={nativeId} onChange={event => setNativeId(event.target.value)} /></label><p className="form-hint">请填写本机 {session ? agentNames[session.agent] : 'Agent'} 在此项目中已有的会话 ID。此方式仅用于恢复会话；会覆盖已有对话关联，文本可通过导入记录重新加载。</p><footer>{cancelButton}<button className="primary" disabled={busy}>保存关联</button></footer></form></Dialog>}
    {modal === 'restart' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="更新后台服务？" onClose={closeModal}><p className="stop-description">重新启动后台，加载当前版本的功能。项目、会话、设置和运行记录会保留。<br />所有终端都需要先停止。</p><footer>{cancelButton}<button className="primary" disabled={busy || running > 0 || !connected} onClick={() => void restartBackend()}>确认更新后台</button></footer></Dialog>}
  </div>;
}
