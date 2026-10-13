import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { API_VERSION, DEFAULT_SETTINGS, type Agent, type History, type Method, type Project, type Run, type Session, type Settings, type State, type TerminalConfig } from '../shared/protocol';
import { TerminalView, OutputView } from './TerminalView';
import { TerminalFields } from './TerminalFields';
import { SettingsPage } from './SettingsPage';
import { agentNames, statusNames, terminalNames } from './labels';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
type Modal = 'project' | 'editProject' | 'deleteProject' | 'session' | 'editSession' | 'deleteSession' | 'stop' | 'link' | 'restart' | null;
const normalize = (value: State): State => ({ ...value, apiVersion: value.apiVersion ?? 1, settings: value.settings ?? structuredClone(DEFAULT_SETTINGS), sessions: value.sessions.map(session => ({ ...session, terminal: session.terminal ?? null })) });

function Icon({ kind }: { kind: 'folder' | 'terminal' | 'plus' | 'arrow' | 'history' | 'settings' }) {
  const paths = { folder: 'M3 7V5h6l2 2h10v12H3V7Z', terminal: 'm5 7 4 4-4 4m7 0h6', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
function Dialog({ title, children, onClose, busy }: { title: string; children: ReactNode; onClose: () => void; busy: boolean }) {
  const host = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const isBusy = useRef(busy); isBusy.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(host.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? []);
    if (!host.current?.contains(document.activeElement)) (host.current?.querySelector<HTMLElement>('input, select, textarea') ?? focusable()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy.current) close.current();
      if (event.key !== 'Tab') return;
      const elements = focusable(); const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section ref={host} className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭对话框">×</button></header>{children}</section></div>;
}

export function App() {
  const [state, setState] = useState<State>({ projects: [], sessions: [], maxActiveTerminals: 16, platform: '', settings: structuredClone(DEFAULT_SETTINGS), apiVersion: API_VERSION });
  const [projectId, setProjectId] = useState(() => localStorage.getItem('berth.project') ?? '');
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('berth.session') ?? '');
  const [page, setPage] = useState<'workspace' | 'settings'>('workspace');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [projectSearch, setProjectSearch] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState<'terminal' | 'history' | 'runs'>('terminal');
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  const project = state.projects.find(item => item.id === projectId);
  const projectSessions = state.sessions.filter(item => item.projectId === projectId);
  const sessions = projectSessions.filter(item => (!search.trim() || `${item.title} ${agentNames[item.agent]} ${item.command} ${item.nativeSessionId ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())) && (filter === 'all' || (filter === 'active' ? active(item) : filter === 'inactive' ? !active(item) : item.agent === filter)));
  const projects = state.projects.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(projectSearch.trim().toLowerCase()));
  const session = projectSessions.find(item => item.id === sessionId);
  const running = state.sessions.filter(active).length;
  const legacy = state.apiVersion < API_VERSION;
  const manageDisabled = busy || !connected || legacy;

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
  useEffect(() => { if (!loading && !projectSessions.some(item => item.id === sessionId)) setSessionId(projectSessions[0]?.id ?? ''); }, [state.sessions, projectId, sessionId, loading]);
  useEffect(() => { localStorage.setItem('berth.project', projectId); }, [projectId]);
  useEffect(() => { localStorage.setItem('berth.session', sessionId); setTerminalVisible(true); setRunOutput(null); }, [sessionId]);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 12000); return () => clearTimeout(timer); }, [error]);
  useEffect(() => {
    if (!session || !connected) return;
    let canceled = false;
    setHistory(null); setRuns([]); setRunOutput(null);
    if (tab === 'history') void window.berth.rpc<History>('history', { sessionId }).then(value => { if (!canceled) setHistory(value); }).catch(reason => { if (!canceled) setError(String(reason)); });
    if (tab === 'runs') void window.berth.rpc<Run[]>('runs', { sessionId }).then(value => { if (!canceled) setRuns(value); }).catch(reason => { if (!canceled) setError(String(reason)); });
    return () => { canceled = true; };
  }, [sessionId, tab, connected, session?.agent, session?.transcriptPath, session?.nativeSessionId, session?.latestRun?.status]);

  async function perform<T>(method: Method, params: Record<string, unknown>): Promise<T | undefined> {
    setBusy(true); setError('');
    try { return await window.berth.rpc<T>(method, params); }
    catch (reason) { setError(String(reason)); return undefined; }
    finally { setBusy(false); }
  }
  function selectProject(id: string) { setProjectId(id); setSearch(''); setFilter('all'); setPage('workspace'); }
  function newProject() { setFolder(''); setName(''); setModal('project'); }
  function editProject() { if (!project) return; setFolder(project.path); setName(project.name); setModal('editProject'); }
  function newSession() { setTitle(''); setAgent(state.settings.defaultAgent); setCommand(''); setTerminal(null); setStartNow(true); setModal('session'); }
  function editSession() { if (!session) return; setTitle(session.title); setAgent(session.agent); setCommand(session.command); setTerminal(session.terminal); setModal('editSession'); }
  async function selectFolder() {
    try { const value = await window.berth.chooseDirectory(); if (value) { setFolder(value); if (!name) setName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目'); } }
    catch (reason) { setError(String(reason)); }
  }
  async function submitProject(event: FormEvent) {
    event.preventDefault(); const result = await perform<Project>(modal === 'editProject' ? 'updateProject' : 'createProject', { ...(modal === 'editProject' ? { projectId } : {}), name, path: folder });
    if (result) { selectProject(result.id); setProjectSearch(''); setModal(null); }
  }
  async function submitSession(event: FormEvent) {
    event.preventDefault(); const editing = modal === 'editSession';
    const result = await perform<Session>(editing ? 'updateSession' : 'createSession', { ...(editing ? { sessionId } : { projectId }), title, agent, command: agent === 'custom' ? command : '', terminal });
    if (result) { setSessionId(result.id); setTab('terminal'); setSearch(''); setFilter('all'); setModal(null); if (!editing && startNow) await perform('start', { sessionId: result.id, resume: false, cols: 100, rows: 30 }); }
  }
  async function importHistory() {
    try { const file = await window.berth.chooseTranscript(); if (!file) return; const result = await perform<History>('importHistory', { sessionId, path: file }); if (result) { setHistory(result); setTab('history'); } }
    catch (reason) { setError(String(reason)); }
  }
  async function restartBackend() {
    setBusy(true); setError('');
    try { await window.berth.restartBackend(); setModal(null); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const closeModal = () => setModal(null);
  const cancelButton = <button type="button" className="subtle" disabled={busy} onClick={closeModal}>取消</button>;

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">B<span>·</span></div><div><strong>AgentBerth</strong><small>泊栈 · 项目会话工作台</small></div></div>
      <div className="sidebar-heading"><span>项目空间</span><button className="icon-button" aria-label="添加项目" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" /></button></div>
      {state.projects.length > 0 && <input className="search project-search" placeholder="搜索项目或目录…" value={projectSearch} onChange={event => setProjectSearch(event.target.value)} aria-label="搜索项目" />}
      <nav className="projects" aria-label="项目列表">{projects.map(item => {
        const count = state.sessions.filter(s => s.projectId === item.id && active(s)).length;
        return <button key={item.id} className={`project-item ${projectId === item.id && page === 'workspace' ? 'selected' : ''}`} onClick={() => selectProject(item.id)} title={item.path}><Icon kind="folder" /><span>{item.name}</span>{count > 0 && <em>{count}</em>}</button>;
      })}{!projects.length && <p className="sidebar-empty">{projectSearch ? '没有匹配的项目' : <>添加一个目录，<br />让会话有自己的泊位。</>}</p>}</nav>
      <button className="add-project" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" />添加项目目录</button>
      <button className={`settings-link ${page === 'settings' ? 'selected' : ''}`} onClick={() => setPage('settings')}><Icon kind="settings" />设置</button>
      <div className="sidebar-bottom"><span className={`dot ${connected ? 'live' : ''}`} /><span>{connected ? '后台已连接' : '后台未连接'}</span><button className="text-button" disabled={busy} onClick={() => void window.berth?.reconnect().catch(reason => setError(String(reason)))}>重连</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">{page === 'settings' ? 'SETTINGS' : 'WORKSPACE'}</span><span className="crumb"> / {page === 'settings' ? '应用设置' : project?.name ?? '欢迎来到泊栈'}</span></div><div className="topbar-status"><span className={`dot ${connected ? 'live' : ''}`} />{running} 个终端后台运行 <span className="quiet">/ {state.maxActiveTerminals}</span></div></header>
      {legacy && <div className="upgrade-notice" role="status"><span>旧版后台仍在运行。停止全部终端后更新后台，即可使用项目管理、设置与 OpenCode。</span><button className="subtle" disabled={!connected || busy || running > 0} onClick={() => setModal('restart')}>更新后台</button></div>}
      {loading ? <div className="empty-page"><div className="loader" /><h2>正在连接你的工作空间</h2></div> : page === 'settings' ? <SettingsPage settings={state.settings} platform={state.platform} disabled={manageDisabled} restartDisabled={busy || !connected} running={running} onSave={async (value: Settings) => (await perform<Settings>('saveSettings', { ...value })) !== undefined} onRestart={() => setModal('restart')} /> : !project ? <div className="empty-page welcome"><div className="welcome-symbol"><Icon kind="terminal" /></div><span className="eyebrow">A BERTH FOR EVERY SESSION</span><h1>为项目留一个泊位。</h1><p>目录、终端和对话记录，放在同一个工作台。<br />关掉窗口，再回来继续。</p><button className="primary" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" />添加第一个项目</button><div className="welcome-features"><span><Icon kind="folder" />按目录组织</span><span><Icon kind="terminal" />多会话后台运行</span><span><Icon kind="history" />原生对话关联</span></div></div> : <>
        <section className="project-header"><div><span className="eyebrow">PROJECT SPACE</span><h1>{project.name}</h1><button className="path-button" title="在文件管理器中打开" onClick={() => void window.berth.openProject(project.path).catch(reason => setError(String(reason)))}><Icon kind="folder" />{project.path}<Icon kind="arrow" /></button></div><div className="project-actions"><button className="subtle" onClick={editProject} disabled={manageDisabled}>编辑项目</button><button className="subtle danger-text" onClick={() => setModal('deleteProject')} disabled={manageDisabled || projectSessions.some(active)} title={projectSessions.some(active) ? '先停止本项目的全部终端' : '删除项目登记及工作台记录'}>删除项目</button><button className="primary" onClick={newSession} disabled={manageDisabled}><Icon kind="plus" />新建会话</button></div></section>
        <section className="workspace">
          <aside className="session-sidebar"><div className="session-list-heading"><strong>项目会话</strong><span>{projectSessions.length}</span></div><input className="search" placeholder="搜索名称、Agent、会话 ID…" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索会话" /><select className="session-filter" aria-label="筛选会话" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部会话</option><option value="active">运行中</option><option value="inactive">未运行</option>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><div className="session-list">{sessions.map(item => <button key={item.id} className={`session-item ${item.id === sessionId ? 'selected' : ''}`} onClick={() => { setSessionId(item.id); setTab('terminal'); }}><div className="session-item-top"><span className={`dot ${active(item) ? 'live' : ''}`} /><strong>{item.title}</strong></div><div className="session-item-meta"><span>{agentNames[item.agent]}</span><span>{statusNames[item.latestRun?.status ?? ''] ?? '待启动'}</span></div><small>{date(item.updatedAt)}</small>{item.nativeSessionId && <span className="history-linked">已关联对话</span>}</button>)}{!sessions.length && <div className="session-empty"><Icon kind="terminal" /><p>{search || filter !== 'all' ? '没有匹配的会话' : '开始这个项目的第一个会话'}</p>{!search && filter === 'all' && <button className="text-button" disabled={manageDisabled} onClick={newSession}>新建会话 →</button>}</div>}</div><div className="session-note">切换会话，终端持续运行。<br />停止任务请使用「停止终端」。</div></aside>
          <div className="session-content">{!session ? <div className="empty-page"><Icon kind="terminal" /><h2>选择或创建一个会话</h2></div> : <>
            <header className="session-header"><div><h2>{session.title}</h2><span className={`badge ${active(session) ? 'live-badge' : ''}`}>{statusNames[session.latestRun?.status ?? ''] ?? '待启动'}</span><span className="agent-label">{agentNames[session.agent]}</span></div><div className="session-actions"><button className="subtle" disabled={manageDisabled} onClick={editSession}>编辑会话</button><button className="subtle danger-text" disabled={manageDisabled || active(session)} title={active(session) ? '先停止终端，再删除会话' : '删除会话和运行记录'} onClick={() => setModal('deleteSession')}>删除会话</button>{active(session) ? <button className="danger" disabled={busy || session.latestRun?.status === 'stopping' || !connected} onClick={() => setModal('stop')}>停止终端</button> : <><button className="primary compact" disabled={manageDisabled} onClick={() => void perform('start', { sessionId, resume: false, cols: 100, rows: 30 })}>启动终端</button>{session.nativeSessionId && <button className="subtle" disabled={manageDisabled} onClick={() => void perform('start', { sessionId, resume: true, cols: 100, rows: 30 })}>恢复原生会话</button>}</>}</div></header>
            <div className="tabs" role="tablist">{(['terminal', 'history', 'runs'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'terminal' ? '终端' : value === 'history' ? '对话历史' : '运行记录'}</button>)}{tab === 'terminal' && <button className="hide-terminal" onClick={() => setTerminalVisible(value => !value)}>{terminalVisible ? '收起终端' : '接回终端'}</button>}</div>
            {tab === 'terminal' && <div className="terminal-panel">{session.latestRun?.error && <div className="inline-error">{session.latestRun.error}</div>}{connected && terminalVisible ? <TerminalView key={`${session.id}:${session.latestRun?.id}:${session.latestRun?.status}:${connectionEpoch}`} sessionId={sessionId} fontSize={state.settings.fontSize} onError={setError} /> : <div className="empty-page"><Icon kind="terminal" /><h2>{connected ? '终端已收起' : '后台连接已断开'}</h2><p>{connected ? '运行中的任务仍在后台继续。' : '重新连接后接回终端。'}</p><button className="subtle" onClick={() => connected ? setTerminalVisible(true) : void window.berth.reconnect().catch(reason => setError(String(reason)))}>{connected ? '接回终端' : '重新连接'}</button></div>}<footer className="terminal-footer"><span>{session.latestRun ? `运行 ${session.latestRun.id.slice(0, 8)} · PID ${session.latestRun.pid ?? '—'}` : '尚未启动'} · {terminalNames[(session.terminal ?? state.settings.terminal).profile]}</span><span>关闭窗口后终端继续运行</span></footer></div>}
            {tab === 'history' && <div className="history-panel"><div className="panel-toolbar"><span>Agent 原生对话 · 只读文本视图</span><div><button className="subtle" disabled={manageDisabled || !session.transcriptPath} onClick={async () => { const result = await perform<History>('refreshHistory', { sessionId }); if (result) setHistory(result); }}>刷新记录</button><button className="subtle" disabled={manageDisabled || active(session) || !['codex', 'claude', 'opencode'].includes(session.agent)} onClick={() => { setNativeId(session.nativeSessionId ?? ''); setModal('link'); }}>关联会话 ID</button><button className="subtle" disabled={manageDisabled || !['codex', 'claude', 'opencode'].includes(session.agent)} onClick={() => void importHistory()}>{session.agent === 'opencode' ? '关联 JSON' : '关联 JSONL'}</button></div></div>{history?.nativeSessionId && <div className="history-meta"><code>{history.nativeSessionId}</code><small title={history.path ?? ''}>{history.path ?? '已关联原生 ID，可恢复会话；导入记录后显示文本。'}</small></div>}<div className="messages">{history?.messages.length ? history.messages.map((message, index) => <article className={`message ${message.role}`} key={index}><header><strong>{message.role === 'user' ? '你' : agentNames[session.agent]}</strong><time>{message.timestamp ? date(message.timestamp) : ''}</time></header><p>{message.text}</p></article>) : <div className="empty-page"><Icon kind="history" /><h2>把对话带回项目</h2><p>{session.agent === 'opencode' ? <>在此项目中执行 <code>opencode export 会话ID &gt; session.json</code>，<br />然后关联导出的 JSON。也可以直接关联原生会话 ID。</> : <>选择此项目的 Codex 或 Claude Code 原生 JSONL，<br />查看历史，并按会话 ID 再次启动。</>}</p></div>}{history?.warnings.map(warning => <p className="history-warning" key={warning}>{warning}</p>)}</div></div>}
            {tab === 'runs' && <div className="runs-panel"><div className="panel-toolbar"><span>每次启动都有独立记录</span><button className="text-button" onClick={() => setRunOutput(null)}>返回列表</button></div>{runOutput !== null ? <OutputView text={runOutput || '保留范围内没有输出；较旧日志可能已清理。'} /> : <div className="runs-list">{runs.map(run => <button className="run-item" key={run.id} onClick={async () => { const result = await perform<string>('output', { runId: run.id }); if (result !== undefined) setRunOutput(result); }}><span><code>{run.id.slice(0, 8)}</code><small title={run.shell}>{run.command || '交互式 Shell'}{run.shell ? ` · ${run.shell.split(/[\\/]/).at(-1)}` : ''}</small></span><span>{date(run.startedAt)}</span><span className="badge">{statusNames[run.status]}</span><span>退出码 {run.exitCode ?? '—'}</span><Icon kind="arrow" /></button>)}{!runs.length && <div className="empty-page"><h2>尚无运行记录</h2><p>启动终端后，会在这里保留记录。</p></div>}</div>}</div>}
          </>}</div>
        </section>
      </>}
    </main>
    {error && <div className="toast" role="alert"><span>{error.replace(/^Error: /, '')}</span><button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    {(modal === 'project' || modal === 'editProject') && <Dialog busy={busy} title={modal === 'project' ? '添加项目目录' : '编辑项目'} onClose={closeModal}><form onSubmit={submitProject}><label>项目名称<input aria-label="项目名称" autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如 OmniOCR" /></label><label>项目目录<div className="input-with-button"><input aria-label="项目目录" required disabled={modal === 'editProject' && projectSessions.some(active)} value={folder} onChange={event => setFolder(event.target.value)} placeholder={state.platform === 'win32' ? 'D:\\Projects\\OmniOCR' : '/home/user/projects/OmniOCR'} /><button type="button" className="subtle" disabled={modal === 'editProject' && projectSessions.some(active)} onClick={() => void selectFolder()}>选择目录</button></div></label><p className="form-hint">{modal === 'editProject' ? '运行中的项目可以修改名称。修改目录前请停止全部终端；修改后会清除原生对话关联，避免从错误目录恢复。' : '会话从这个目录启动，同一路径自动去重。'}</p><footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'project' ? '添加项目' : '保存项目'}</button></footer></form></Dialog>}
    {(modal === 'session' || modal === 'editSession') && <Dialog busy={busy} title={modal === 'session' ? '新建项目会话' : '编辑会话'} onClose={closeModal}><form onSubmit={submitSession}><label>会话名称<input aria-label="会话名称" autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如 修复 OCR 调度问题" /></label><label>Agent 类型<select aria-label="Agent 类型" disabled={modal === 'editSession' && !!session && active(session)} value={agent} onChange={event => setAgent(event.target.value as Agent)}>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{agent === 'custom' && <label>启动命令<input aria-label="启动命令" required maxLength={4096} disabled={modal === 'editSession' && !!session && active(session)} value={command} onChange={event => setCommand(event.target.value)} placeholder="你的 Agent TUI 启动命令" /></label>}<TerminalFields value={terminal} platform={state.platform} inherit disabled={modal === 'editSession' && !!session && active(session)} onChange={setTerminal} /><p className="form-hint">工作目录：{project?.path}<br />{modal === 'editSession' ? '启动配置需在停止终端后修改；更换 Agent 会清除原生对话关联。' : 'Agent 使用本机已有安装和登录状态。'}{agent === 'opencode' && <><br />启动 opencode；关联会话后使用 opencode --session ID 恢复。</>}</p>{modal === 'session' && <label className="checkbox-label"><input type="checkbox" checked={startNow} onChange={event => setStartNow(event.target.checked)} />创建后立即启动</label>}<footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'editSession' ? '保存会话' : startNow ? '创建并启动' : '创建会话'}</button></footer></form></Dialog>}
    {modal === 'deleteSession' && <Dialog busy={busy} title="删除此会话？" onClose={closeModal}><p className="stop-description">删除「{session?.title}」及其运行记录、工作台日志和导入的对话副本。此操作无法撤销。<br />项目文件和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={async () => { if (await perform('deleteSession', { sessionId }) !== undefined) setModal(null); }}>确认删除会话</button></footer></Dialog>}
    {modal === 'deleteProject' && <Dialog busy={busy} title="删除此项目？" onClose={closeModal}><p className="stop-description">删除「{project?.name}」的项目登记及全部 {projectSessions.length} 个会话、运行记录和工作台日志。此操作无法撤销。<br />磁盘上的项目目录和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={async () => { if (await perform('deleteProject', { projectId }) !== undefined) setModal(null); }}>确认删除项目</button></footer></Dialog>}
    {modal === 'stop' && <Dialog busy={busy} title="停止此终端？" onClose={closeModal}><p className="stop-description">「{session?.title}」正在执行的任务会中断。<br />如需保留后台任务，可以收起终端或关闭窗口。</p><footer><button className="subtle" disabled={busy} onClick={closeModal}>继续运行</button><button className="danger" disabled={busy} onClick={async () => { if (await perform('stop', { sessionId }) !== undefined) setModal(null); }}>停止终端</button></footer></Dialog>}
    {modal === 'link' && <Dialog busy={busy} title="关联原生会话 ID" onClose={closeModal}><form onSubmit={async event => { event.preventDefault(); const result = await perform<History>('linkNativeSession', { sessionId, nativeSessionId: nativeId.trim() }); if (result) { setHistory(result); setModal(null); } }}><label>原生会话 ID<input aria-label="原生会话 ID" autoFocus required maxLength={128} pattern="[a-zA-Z0-9_-]+" value={nativeId} onChange={event => setNativeId(event.target.value)} /></label><p className="form-hint">请填写本机 {session ? agentNames[session.agent] : 'Agent'} 在此项目中已有的会话 ID。此方式仅用于恢复会话；会覆盖已有对话关联，文本可通过导入记录重新加载。</p><footer>{cancelButton}<button className="primary" disabled={busy}>保存关联</button></footer></form></Dialog>}
    {modal === 'restart' && <Dialog busy={busy} title="更新后台服务？" onClose={closeModal}><p className="stop-description">重新启动后台，加载当前版本的功能。项目、会话、设置和运行记录会保留。<br />所有终端都需要先停止。</p><footer>{cancelButton}<button className="primary" disabled={busy || running > 0 || !connected} onClick={() => void restartBackend()}>确认更新后台</button></footer></Dialog>}
  </div>;
}
