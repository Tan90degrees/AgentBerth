import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Agent, History, Method, Project, Run, Session, State } from '../shared/protocol';
import { TerminalView, OutputView } from './TerminalView';

const agentNames: Record<Agent, string> = { shell: '普通终端', codex: 'Codex', claude: 'Claude Code', custom: '自定义 Agent' };
const statusNames: Record<string, string> = { running: '运行中', stopping: '停止中', exited: '已退出', stopped: '已停止', failed: '启动失败', interrupted: '曾中断' };
const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
type Modal = 'project' | 'session' | 'rename' | 'stop' | null;

function Icon({ kind }: { kind: 'folder' | 'terminal' | 'plus' | 'arrow' | 'history' }) {
  const paths = { folder: 'M3 7V5h6l2 2h10v12H3V7Z', terminal: 'm5 7 4 4-4 4m7 0h6', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [onClose]);
  return <div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭对话框">×</button></header>{children}</section></div>;
}

export function App() {
  const [state, setState] = useState<State>({ projects: [], sessions: [], maxActiveTerminals: 16, platform: '' });
  const [projectId, setProjectId] = useState(() => localStorage.getItem('berth.project') ?? '');
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('berth.session') ?? '');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [search, setSearch] = useState('');
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
  const [history, setHistory] = useState<History | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const project = state.projects.find(item => item.id === projectId);
  const sessions = state.sessions.filter(item => item.projectId === projectId && (!search || `${item.title} ${agentNames[item.agent]}`.toLowerCase().includes(search.toLowerCase())));
  const session = state.sessions.find(item => item.id === sessionId && item.projectId === projectId);
  const running = state.sessions.filter(active).length;

  useEffect(() => {
    if (!window.berth) { setLoading(false); setError('请通过 AgentBerth 桌面应用打开工作台'); return; }
    const off = window.berth.onEvent(event => {
      if (event.event === 'state') { setState(event.data); setLoading(false); }
      if (event.event === 'connection') { setConnected(event.data.connected); if (event.data.connected) setConnectionEpoch(n => n + 1); if (event.data.error) setError(event.data.error); }
    });
    void window.berth.rpc<State>('state').then(value => { setState(value); setConnected(true); setLoading(false); }).catch(reason => { setError(String(reason)); setLoading(false); });
    return off;
  }, []);
  useEffect(() => {
    if (!state.projects.length) return;
    if (!state.projects.some(item => item.id === projectId)) setProjectId(state.projects[0].id);
  }, [state.projects, projectId]);
  useEffect(() => {
    if (!state.sessions.some(item => item.id === sessionId && item.projectId === projectId)) setSessionId(state.sessions.find(item => item.projectId === projectId)?.id ?? '');
  }, [state.sessions, projectId, sessionId]);
  useEffect(() => { localStorage.setItem('berth.project', projectId); }, [projectId]);
  useEffect(() => { localStorage.setItem('berth.session', sessionId); setTerminalVisible(true); setRunOutput(null); }, [sessionId]);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 9000); return () => clearTimeout(timer); }, [error]);
  useEffect(() => {
    if (!sessionId || !connected) return;
    let canceled = false;
    setHistory(null); setRuns([]); setRunOutput(null);
    if (tab === 'history') void window.berth.rpc<History>('history', { sessionId }).then(value => { if (!canceled) setHistory(value); }).catch(reason => { if (!canceled) setError(String(reason)); });
    if (tab === 'runs') void window.berth.rpc<Run[]>('runs', { sessionId }).then(value => { if (!canceled) setRuns(value); }).catch(reason => { if (!canceled) setError(String(reason)); });
    return () => { canceled = true; };
  }, [sessionId, tab, connected, session?.latestRun?.status]);

  async function perform<T>(method: Method, params: Record<string, unknown>): Promise<T | undefined> {
    setBusy(true); setError('');
    try { return await window.berth.rpc<T>(method, params); }
    catch (reason) { setError(String(reason)); return undefined; }
    finally { setBusy(false); }
  }
  function newProject() { setFolder(''); setName(''); setModal('project'); }
  function newSession() { setTitle(''); setAgent('codex'); setCommand(''); setModal('session'); }
  async function selectFolder() {
    try { const value = await window.berth.chooseDirectory(); if (value) { setFolder(value); if (!name) setName(value.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目'); } }
    catch (reason) { setError(String(reason)); }
  }
  async function submitProject(event: FormEvent) {
    event.preventDefault(); const result = await perform<Project>('createProject', { name, path: folder });
    if (result) { setProjectId(result.id); setSearch(''); setModal(null); }
  }
  async function submitSession(event: FormEvent) {
    event.preventDefault(); const result = await perform<Session>('createSession', { projectId, title, agent, command });
    if (result) { setSessionId(result.id); setTab('terminal'); setSearch(''); setModal(null); await perform('start', { sessionId: result.id, resume: false, cols: 100, rows: 30 }); }
  }
  async function importHistory() {
    try {
      const file = await window.berth.chooseTranscript(); if (!file) return;
      const result = await perform<History>('importHistory', { sessionId, path: file }); if (result) { setHistory(result); setTab('history'); }
    } catch (reason) { setError(String(reason)); }
  }

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">B<span>·</span></div><div><strong>AgentBerth</strong><small>泊栈 · 项目会话工作台</small></div></div>
      <div className="sidebar-heading"><span>项目空间</span><button className="icon-button" aria-label="添加项目" onClick={newProject} disabled={!connected}><Icon kind="plus" /></button></div>
      <nav className="projects" aria-label="项目列表">{state.projects.map(item => {
        const count = state.sessions.filter(s => s.projectId === item.id && active(s)).length;
        return <button key={item.id} className={`project-item ${projectId === item.id ? 'selected' : ''}`} onClick={() => { setProjectId(item.id); setSearch(''); }} title={item.path}><Icon kind="folder" /><span>{item.name}</span>{count > 0 && <em>{count}</em>}</button>;
      })}{!state.projects.length && <p className="sidebar-empty">添加一个目录，<br />让会话有自己的泊位。</p>}</nav>
      <button className="add-project" onClick={newProject} disabled={!connected}><Icon kind="plus" /> 添加项目目录</button>
      <div className="sidebar-bottom"><span className={`dot ${connected ? 'live' : ''}`} /><span>{connected ? '后台已连接' : '后台未连接'}</span><button className="text-button" onClick={() => void window.berth?.reconnect().catch(reason => setError(String(reason)))}>重连</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">WORKSPACE</span><span className="crumb"> / {project?.name ?? '欢迎来到泊栈'}</span></div><div className="topbar-status"><span className="dot live" />{running} 个终端后台运行 <span className="quiet">/ {state.maxActiveTerminals}</span></div></header>
      {loading ? <div className="empty-page"><div className="loader" /><h2>正在连接你的工作空间</h2></div> : !project ? <div className="empty-page welcome"><div className="welcome-symbol"><Icon kind="terminal" /></div><span className="eyebrow">A BERTH FOR EVERY SESSION</span><h1>为项目留一个泊位。</h1><p>目录、终端和对话记录，放在同一个工作台。<br />关掉窗口，再回来继续。</p><button className="primary" onClick={newProject} disabled={!connected}><Icon kind="plus" />添加第一个项目</button><div className="welcome-features"><span><Icon kind="folder" /> 按目录组织</span><span><Icon kind="terminal" /> 多会话后台运行</span><span><Icon kind="history" /> 原生对话关联</span></div></div> : <>
        <section className="project-header"><div><span className="eyebrow">PROJECT SPACE</span><h1>{project.name}</h1><button className="path-button" title="在文件管理器中打开" onClick={() => void window.berth.openProject(project.path).catch(reason => setError(String(reason)))}><Icon kind="folder" />{project.path}<Icon kind="arrow" /></button></div><button className="primary" onClick={newSession} disabled={!connected}><Icon kind="plus" />新建会话</button></section>
        <section className="workspace">
          <aside className="session-sidebar"><div className="session-list-heading"><strong>项目会话</strong><span>{state.sessions.filter(s => s.projectId === projectId).length}</span></div><input className="search" placeholder="搜索会话…" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索会话" /><div className="session-list">{sessions.map(item => <button key={item.id} className={`session-item ${item.id === sessionId ? 'selected' : ''}`} onClick={() => { setSessionId(item.id); setTab('terminal'); }}><div className="session-item-top"><span className={`dot ${active(item) ? 'live' : ''}`} /><strong>{item.title}</strong></div><div className="session-item-meta"><span>{agentNames[item.agent]}</span><span>{statusNames[item.latestRun?.status ?? ''] ?? '待启动'}</span></div><small>{date(item.updatedAt)}</small>{item.nativeSessionId && <span className="history-linked">已关联对话</span>}</button>)}{!sessions.length && <div className="session-empty"><Icon kind="terminal" /><p>{search ? '没有匹配的会话' : '开始这个项目的第一个会话'}</p>{!search && <button className="text-button" onClick={newSession}>新建会话 →</button>}</div>}</div><div className="session-note">切换会话，终端持续运行。<br />停止任务请使用「停止终端」。</div></aside>
          <div className="session-content">{!session ? <div className="empty-page"><Icon kind="terminal" /><h2>选择或创建一个会话</h2></div> : <>
            <header className="session-header"><div><h2>{session.title}</h2><span className={`badge ${active(session) ? 'live-badge' : ''}`}>{statusNames[session.latestRun?.status ?? ''] ?? '待启动'}</span><span className="agent-label">{agentNames[session.agent]}</span></div><div className="session-actions"><button className="subtle" disabled={busy || !connected} onClick={() => { setTitle(session.title); setModal('rename'); }}>重命名</button>{active(session) ? <button className="danger" disabled={busy || session.latestRun?.status === 'stopping' || !connected} onClick={() => setModal('stop')}>停止终端</button> : <><button className="primary compact" disabled={busy || !connected} onClick={() => void perform('start', { sessionId, resume: false, cols: 100, rows: 30 })}>启动终端</button>{session.nativeSessionId && <button className="subtle" disabled={busy || !connected} onClick={() => void perform('start', { sessionId, resume: true, cols: 100, rows: 30 })}>恢复原生会话</button>}</>}</div></header>
            <div className="tabs" role="tablist">{(['terminal', 'history', 'runs'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'terminal' ? '终端' : value === 'history' ? '对话历史' : '运行记录'}</button>)}{tab === 'terminal' && <button className="hide-terminal" onClick={() => setTerminalVisible(value => !value)}>{terminalVisible ? '收起终端' : '接回终端'}</button>}</div>
            {tab === 'terminal' && <div className="terminal-panel">{session.latestRun?.error && <div className="inline-error">{session.latestRun.error}</div>}{connected && terminalVisible ? <TerminalView key={`${session.id}:${session.latestRun?.id}:${session.latestRun?.status}:${connectionEpoch}`} sessionId={sessionId} onError={setError} /> : <div className="empty-page"><Icon kind="terminal" /><h2>{connected ? '终端已收起' : '后台连接已断开'}</h2><p>{connected ? '运行中的任务仍在后台继续。' : '重新连接后接回终端。'}</p><button className="subtle" onClick={() => connected ? setTerminalVisible(true) : void window.berth.reconnect().catch(reason => setError(String(reason)))}>{connected ? '接回终端' : '重新连接'}</button></div>}<footer className="terminal-footer"><span>{session.latestRun ? `运行 ${session.latestRun.id.slice(0, 8)} · PID ${session.latestRun.pid ?? '—'}` : '尚未启动'}</span><span>关闭窗口后终端继续运行</span></footer></div>}
            {tab === 'history' && <div className="history-panel"><div className="panel-toolbar"><span>Agent 原生对话 · 只读文本视图</span><div><button className="subtle" disabled={busy || !connected || !session.transcriptPath} onClick={async () => { const result = await perform<History>('refreshHistory', { sessionId }); if (result) setHistory(result); }}>刷新记录</button><button className="subtle" disabled={busy || !connected || !['codex', 'claude'].includes(session.agent)} onClick={() => void importHistory()}>关联 JSONL</button></div></div>{history?.nativeSessionId && <div className="history-meta"><code>{history.nativeSessionId}</code><small title={history.path ?? ''}>{history.path}</small></div>}<div className="messages">{history?.messages.length ? history.messages.map((message, index) => <article className={`message ${message.role}`} key={index}><header><strong>{message.role === 'user' ? '你' : agentNames[session.agent]}</strong><time>{message.timestamp ? date(message.timestamp) : ''}</time></header><p>{message.text}</p></article>) : <div className="empty-page"><Icon kind="history" /><h2>把对话带回项目</h2><p>选择此目录下 Codex 或 Claude Code 的原生 JSONL 记录，<br />查看历史，并按会话 ID 再次启动。</p></div>}{history?.warnings.map(warning => <p className="history-warning" key={warning}>{warning}</p>)}</div></div>}
            {tab === 'runs' && <div className="runs-panel"><div className="panel-toolbar"><span>每次启动都有独立记录</span><button className="text-button" onClick={() => setRunOutput(null)}>返回列表</button></div>{runOutput !== null ? <OutputView text={runOutput || '保留范围内没有输出；较旧日志可能已清理。'} /> : <div className="runs-list">{runs.map(run => <button className="run-item" key={run.id} onClick={async () => { const result = await perform<string>('output', { runId: run.id }); if (result !== undefined) setRunOutput(result); }}><span><code>{run.id.slice(0, 8)}</code><small>{run.command || '交互式 Shell'}</small></span><span>{date(run.startedAt)}</span><span className="badge">{statusNames[run.status]}</span><span>退出码 {run.exitCode ?? '—'}</span><Icon kind="arrow" /></button>)}{!runs.length && <div className="empty-page"><h2>尚无运行记录</h2><p>启动终端后，会在这里保留记录。</p></div>}</div>}</div>}
          </>}</div>
        </section>
      </>}
    </main>
    {error && <div className="toast" role="alert"><span>{error.replace(/^Error: /, '')}</span><button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    {modal === 'project' && <Dialog title="添加项目目录" onClose={() => setModal(null)}><form onSubmit={submitProject}><label>项目名称<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如 OmniOCR" /></label><label>项目目录<div className="input-with-button"><input required value={folder} onChange={event => setFolder(event.target.value)} placeholder={state.platform === 'win32' ? 'D:\\Projects\\OmniOCR' : '/home/user/projects/OmniOCR'} /><button type="button" className="subtle" onClick={() => void selectFolder()}>选择目录</button></div></label><p className="form-hint">会话从这个目录启动，多个会话共享同一项目入口。</p><footer><button type="button" className="subtle" onClick={() => setModal(null)}>取消</button><button className="primary" disabled={busy}>添加项目</button></footer></form></Dialog>}
    {modal === 'session' && <Dialog title="新建项目会话" onClose={() => setModal(null)}><form onSubmit={submitSession}><label>会话名称<input autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如 修复 OCR 调度问题" /></label><label>Agent 类型<select value={agent} onChange={event => setAgent(event.target.value as Agent)}>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{agent === 'custom' && <label>启动命令<input required maxLength={4096} value={command} onChange={event => setCommand(event.target.value)} placeholder="你的 Agent TUI 启动命令" /></label>}<p className="form-hint">工作目录：{project?.path}<br />Agent 使用本机已有安装和登录状态。</p><footer><button type="button" className="subtle" onClick={() => setModal(null)}>取消</button><button className="primary" disabled={busy}>创建并启动</button></footer></form></Dialog>}
    {modal === 'rename' && <Dialog title="重命名会话" onClose={() => setModal(null)}><form onSubmit={async event => { event.preventDefault(); const result = await perform('renameSession', { sessionId, title }); if (result !== undefined) setModal(null); }}><label>会话名称<input autoFocus required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} /></label><footer><button type="button" className="subtle" onClick={() => setModal(null)}>取消</button><button className="primary" disabled={busy}>保存</button></footer></form></Dialog>}
    {modal === 'stop' && <Dialog title="停止此终端？" onClose={() => setModal(null)}><p className="stop-description">「{session?.title}」正在执行的任务会中断。<br />如需保留后台任务，可以收起终端或关闭窗口。</p><footer><button className="subtle" onClick={() => setModal(null)}>继续运行</button><button className="danger" disabled={busy} onClick={async () => { await perform('stop', { sessionId }); setModal(null); }}>停止终端</button></footer></Dialog>}
  </div>;
}
