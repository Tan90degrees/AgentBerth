import appIcon from '../../assets/app.png';
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { API_VERSION, DEFAULT_SETTINGS, isCustomAgent, type Agent, type AgentDefinition, type History, type Method, type Project, type Run, type Session, type Settings, type State, type TerminalConfig, type SshWindowState } from '../shared/protocol';
import { SshDock } from './SshDock';
import { OutputBadge, useTerminalActivity } from './useTerminalActivity';
import { RemoteFields } from './RemoteTerminal';
import type { RemoteConfig } from '../shared/protocol';
import { TerminalView } from './TerminalView';
import { AppearanceToggle } from './AppearanceControls';
import { ResourceBadge, ResourceMonitor } from './Resources';
import { GitBranch, GitSidebar } from './GitManager';
import type { GitDiffRequest } from '../shared/protocol';
import { HistoryPanel } from './HistoryPanel';
import { RunHistory } from './RunHistory';
import { TerminalState } from './TerminalState';
import { TerminalFields } from './TerminalFields';
import { SettingsPage } from './SettingsPage';
import { agentLabels, nextSessionTitle, statusNames, terminalNames } from './labels';
import { ContextMenu, type TreeMenuTarget, type MenuItem } from './ContextMenu';
import { Dialog } from './Dialog';
import { QuickSwitcher, type SwitchTarget } from './QuickSwitcher';
import { loadCollapsedProjects, loadSelections, loadSettingsDraft, readStored, saveStored, type SettingsDraft } from './storage';

import { matchesSession, ProjectTree, ResizableSidebar } from './WorkspaceSidebar';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
const FileBrowser = lazy(() => import('./FileBrowser'));
const GitDiffPreview = lazy(() => import('./GitDiffPreview'));
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
type Modal = 'project' | 'editProject' | 'deleteProject' | 'session' | 'editSession' | 'sshSession' | 'editSshSession' | 'deleteSession' | 'stop' | 'link' | 'restart' | 'renameSession' | 'renameProject' | null;
const normalize = (value: State): State => ({ ...value, agents: value.agents ?? [], apiVersion: value.apiVersion ?? 1, maxSshTerminals: value.maxSshTerminals ?? DEFAULT_SETTINGS.maxSshTerminals, settings: { ...structuredClone(DEFAULT_SETTINGS), ...value.settings }, sessions: value.sessions.map(session => ({ ...session, terminal: session.terminal ?? null })) });

function Icon({ kind }: { kind: 'folder' | 'terminal' | 'plus' | 'arrow' | 'history' | 'settings' | 'git' }) {
  const paths = { git: 'M6 8v8m0-4c9 0 12-2 12-5M6 4a2 2 0 1 0 0 .1M6 18a2 2 0 1 0 0 .1M18 3a2 2 0 1 0 0 .1', folder: 'M3 7V5h6l2 2h10v12H3V7Z', terminal: 'm5 7 4 4-4 4m7 0h6', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
export function App({sshWindow=false}: {sshWindow?: boolean}) {
  const [state, setState] = useState<State>({ projects: [], sessions: [], maxActiveTerminals: DEFAULT_SETTINGS.maxActiveTerminals, maxSshTerminals: DEFAULT_SETTINGS.maxSshTerminals, platform: '', settings: structuredClone(DEFAULT_SETTINGS), apiVersion: API_VERSION });
  const workspaceProjects=useMemo(()=>state.projects.filter(project=>!project.remoteWorkspace),[state.projects]);
  const [projectId, setProjectId] = useState(() => readStored('berth.project') ?? '');
  const [sessionId, setSessionId] = useState(() => readStored('berth.session') ?? '');
  const [headerCollapsed, setHeaderCollapsed] = useState(() => readStored('berth.headerCollapsed') === 'true');
  const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>readStored('berth.sidebarCollapsed')==='true');
  useEffect(()=>{if(!sshWindow)saveStored('berth.sidebarCollapsed',String(sidebarCollapsed));},[sidebarCollapsed]);
  const [sidebarView, setSidebarView] = useState<'sessions' | 'files' | 'git'>(() => readStored('berth.sidebarView') === 'git' ? 'git' : readStored('berth.sidebarView') === 'files' || readStored('berth.filesOpen') === 'true' ? 'files' : 'sessions');
  const [fileTreeHost, setFileTreeHost] = useState<HTMLDivElement | null>(null);
  const [filePreviewHost, setFilePreviewHost] = useState<HTMLDivElement | null>(null);
  const [filesActivated, setFilesActivated] = useState(false);
  const [fileTarget, setFileTarget] = useState<{ projectId: string; query: string; nonce: number } | null>(null);
  const fileTargetSequence = useRef(0);
  const consumeFileTarget = useCallback((nonce: number) => setFileTarget(current => current?.nonce === nonce ? null : current), []);
  useEffect(() => { setFileTarget(current => current?.projectId === projectId ? current : null); }, [projectId, fileTarget?.projectId]);
  const [gitPreview, setGitPreview] = useState<GitDiffRequest | null>(null);
  const openPreview = useCallback(() => { setGitPreview(null); setTab('preview'); }, []);
  const openDiff = useCallback((path: string, staged: boolean, projectPath = false) => { setPage('workspace'); setFilesActivated(true); setTab('preview'); setGitPreview({ projectId, path, staged, projectPath }); }, [projectId]);
  const openGit = (value: Project) => { setSidebarCollapsed(false);setProjectId(value.id); setSidebarView('git'); setPage('workspace'); };
  useEffect(() => { setGitPreview(null); }, [projectId]);
  const openPath = useCallback((query: string) => { setSidebarCollapsed(false);setPage('workspace'); setSidebarView('files'); setFilesActivated(true); setFileTarget({ projectId, query, nonce: ++fileTargetSequence.current }); }, [projectId]);
  const currentSessionId = useRef(sessionId); currentSessionId.current = sessionId;
  const [page, setPage] = useState<'workspace' | 'settings'>('workspace');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(loadCollapsedProjects);
  const deferredSearch = useDeferredValue(search);
  const [tab, setTab] = useState<'terminal' | 'history' | 'runs' | 'preview'>('terminal');
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [modal, setModal] = useState<Modal>(null);
  const [modalTarget, setModalTarget] = useState<{ projectId: string; sessionId?: string } | null>(null);
  const [treeMenu, setTreeMenu] = useState<TreeMenuTarget | null>(null);
  const closeTreeMenu = useCallback(() => setTreeMenu(null), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dismissedRecovery, setDismissedRecovery] = useState('');
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
  const [remote, setRemote] = useState<RemoteConfig | null>(null);
  const [sshOpen,setSshOpen]=useState(()=>sshWindow||readStored('berth.sshOpen')==='true');
  const [sshSessionId,setSshSessionId]=useState(()=>readStored('berth.sshSession')??'');
  const [sshWindowState,setSshWindowState]=useState<SshWindowState>({detached:sshWindow,sessionId:''});
  const [sshWindowReady,setSshWindowReady]=useState(false);
  const changeSshWindow=(action:'open'|'dock'|'select',id=sshSessionId)=>window.berth.sshWindow(action,id);
  const selectSsh=(id:string)=>{setSshSessionId(id);if(sshWindow)void changeSshWindow('select',id).catch(reason=>setError(String(reason)));};
  useEffect(()=>{
    let alive=true,changed=false;
    const apply=(value:SshWindowState,returned=false)=>{if(!alive)return;setSshWindowReady(true);setSshWindowState(value);if(value.sessionId||sshWindow)setSshSessionId(value.sessionId);if(returned&&!value.detached&&!sshWindow){setSshOpen(true);setPage('workspace');}};
    const off=window.berth?.onSshWindow(value=>{changed=true;apply(value,true);});
    void window.berth?.sshWindow('state').then(value=>{if(!changed)apply(value);}).catch(reason=>{if(alive){setSshWindowReady(true);setError(String(reason));}});
    return ()=>{alive=false;off?.();};
  },[]);
  const seenRemoteRuns=useRef(new Set<string>()),remoteInitialized=useRef(false);
  useEffect(()=>{if(!sshWindow)saveStored('berth.sshOpen',String(sshOpen));},[sshOpen]);
  useEffect(()=>{saveStored('berth.sshSession',sshSessionId);},[sshSessionId]);
  useEffect(()=>{
    if(loading||!sshWindowReady)return;
    const remote=state.sessions.filter(session=>session.remote);
    const running=remote.filter(session=>session.latestRun?.status==='running');
    const added=running.filter(session=>!seenRemoteRuns.current.has(session.latestRun!.id));
    const followNew=!sshWindow||remoteInitialized.current||!remote.some(session=>session.id===sshSessionId);
    remoteInitialized.current=true;seenRemoteRuns.current=new Set(running.map(session=>session.latestRun!.id));
    if(added.length&&followNew&&(!sshWindowState.detached||sshWindow)){selectSsh(added[0].id);setSshOpen(true);}
    else if(sshSessionId&&!remote.some(session=>session.id===sshSessionId))selectSsh(running[0]?.id??remote[0]?.id??'');
  },[state.sessions,loading,sshSessionId,sshWindowState.detached,sshWindowReady]);
  const [nativeId, setNativeId] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [history, setHistory] = useState<History | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsRevision, setRunsRevision] = useState(0);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [viewingRun, setViewingRun] = useState<{ sessionId: string; runId: string } | null>(null);
  const outputRunId = viewingRun?.sessionId === sessionId ? viewingRun.runId : null;
  const agentNames = useMemo(() => agentLabels(state.agents), [state.agents]);
  const project = workspaceProjects.find(item => item.id === projectId);
  const sidebarSessions = useMemo(()=>state.sessions.filter(session=>!session.remote),[state.sessions]);
  const projectSessions = useMemo(() => state.sessions.filter(item => item.projectId === projectId && !item.remote), [state.sessions, projectId]);
  const session = projectSessions.find(item => item.id === sessionId);
  const viewedTerminals = useMemo(() => page === 'workspace' ? [
    ...(!sshWindow && project && session && tab === 'terminal' && terminalVisible && connected ? [session.id] : []),
    ...(sshOpen && (!sshWindowState.detached||sshWindow) && connected ? [sshSessionId] : []),
  ] : [], [page, project?.id, session?.id, session?.latestRun?.status, tab, terminalVisible, connected, sshOpen, sshSessionId, sshWindowState.detached]);
  const unread = useTerminalActivity(state.sessions, viewedTerminals);
  const localUnread = sidebarSessions.some(value => unread.has(value.id));
  const sshUnread = state.sessions.some(value => value.remote && unread.has(value.id));
  const actionProject = state.projects.find(item => item.id === (modalTarget?.projectId ?? projectId));
  const actionSession = state.sessions.find(item => item.id === (modalTarget?.sessionId ?? sessionId));
  const actionProjectSessions = state.sessions.filter(item => item.projectId === actionProject?.id);
  const sessionDefinition = state.agents?.find(item => item.id === session?.agent);
  const canHistory = !!session && (['codex', 'claude', 'opencode'].includes(session.agent) || !!sessionDefinition?.integration || !!sessionDefinition?.plugin?.history);
  const canResume = !!session && (['codex', 'claude', 'opencode'].includes(session.agent) || !!sessionDefinition?.resumeCommand || !!sessionDefinition?.plugin?.resume);
  const recordOutput = session?.agent === 'shell';
  useEffect(() => { setViewingRun(null); if ((tab === 'runs' && !recordOutput) || (tab === 'history' && !canHistory && !canResume && !sessionDefinition?.plugin?.list)) setTab('terminal'); }, [sessionId, session?.agent, canHistory, canResume, sessionDefinition?.plugin?.list]);
  const running = useMemo(() => state.sessions.filter(active).length, [state.sessions]);
  const sshRunning = useMemo(() => state.sessions.filter(item => !!item.remote && active(item)).length, [state.sessions]);
  const windowsPty = useMemo(() => state.windowsPty, [state.windowsPty?.backend, state.windowsPty?.buildNumber]);
  const legacy = state.apiVersion < API_VERSION;
  const manageDisabled = busy || !connected || state.apiVersion < 2;
  const draftDirty = !!settingsDraft && JSON.stringify(settingsDraft.value) !== JSON.stringify(state.settings);
  const draftConflict = draftDirty && JSON.stringify(settingsDraft?.base) !== JSON.stringify(state.settings);
  const formValue = modal === 'project' || modal === 'editProject' ? JSON.stringify({ name, folder }) : ['session','editSession','sshSession','editSshSession'].includes(modal ?? '') ? JSON.stringify({ title, agent, command, terminal, startNow, remote }) : modal === 'link' ? JSON.stringify(nativeId) : modal === 'renameSession' ? JSON.stringify(title) : modal === 'renameProject' ? JSON.stringify(name) : '';
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
  useEffect(() => { if (!loading && !workspaceProjects.some(item => item.id === projectId)) setProjectId(workspaceProjects[0]?.id ?? ''); }, [workspaceProjects, projectId, loading]);
  useEffect(() => {
    if (sshWindow || loading || projectSessions.some(item => item.id === sessionId)) return;
    const saved = remembered.current[projectId];
    setSessionId(projectSessions.find(item => item.id === saved)?.id ?? projectSessions[0]?.id ?? '');
  }, [state.sessions, projectId, sessionId, loading]);
  useEffect(() => {
    if (sshWindow || loading) return;
    const valid = new Set(state.sessions.map(item => item.id));
    remembered.current = Object.fromEntries(Object.entries(remembered.current).filter(([id, selected]) => workspaceProjects.some(item => item.id === id) && valid.has(selected)));
    if (session) remembered.current[projectId] = session.id;
    saveStored('berth.selections', JSON.stringify(remembered.current));
  }, [workspaceProjects, state.sessions, projectId, sessionId, loading]);
  useEffect(() => { if(sshWindow)return;saveStored('berth.headerCollapsed', String(headerCollapsed)); }, [headerCollapsed]);
  useEffect(() => { if(sshWindow)return;saveStored('berth.sidebarView', sidebarView); saveStored('berth.filesOpen', null); if (sidebarView === 'files') setFilesActivated(true); }, [sidebarView]);
  useEffect(() => { if(sshWindow)return;saveStored('berth.project', projectId); }, [projectId]);
  useEffect(() => { if(sshWindow)return;saveStored('berth.session', sessionId); setTerminalVisible(true); setRunOutput(null); }, [sessionId]);
  useEffect(() => { if (!error || modal || page === 'settings') return; const timer = setTimeout(() => setError(''), 12000); return () => clearTimeout(timer); }, [error, modal, page]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 2500); return () => clearTimeout(timer); }, [message]);
  useEffect(() => { if (!sshWindow&&!loading) saveStored('berth.settingsDraft', draftDirty ? JSON.stringify(settingsDraft) : null); }, [settingsDraft, state.settings, loading]);
  useEffect(() => { if (!loading && settingsDraft && !draftDirty) setSettingsDraft(null); }, [settingsDraft, draftDirty, loading]);
  useEffect(() => {
    if (sshWindow || !session || !connected) return;
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
  }, [sessionId, tab, connected, session?.agent, session?.transcriptPath, session?.nativeSessionId, session?.latestRun?.status, session?.latestRun?.id, project?.path, outputRunId, runsRevision]);

  async function perform<T>(method: Method, params: Record<string, unknown>): Promise<T | undefined> {
    setBusy(true); setError(''); setMessage('');
    try { return await window.berth.rpc<T>(method, params); }
    catch (reason) { setError(String(reason)); return undefined; }
    finally { setBusy(false); }
  }
  const expandProject = useCallback((id: string) => setCollapsed(previous => previous.includes(id) ? previous.filter(item => item !== id) : previous), []);
  const selectProject = useCallback((id: string) => { setProjectId(id); setSearch(''); setFilter('all'); setPage('workspace'); setError(''); expandProject(id); }, [expandProject]);
  const selectSession = useCallback((projectId: string, sessionId: string) => { if(state.sessions.find(item=>item.id===sessionId)?.remote){selectSsh(sessionId);setSshOpen(true);setPage('workspace');return;} setProjectId(projectId); setSessionId(sessionId); setPage('workspace'); setTab('terminal'); setError(''); expandProject(projectId); }, [expandProject,state.sessions]);
  useEffect(() => {
    if (sshWindow) return;
    return window.berth.onPetSession(id => {
      const target = state.sessions.find(session => session.id === id);
      if (target) selectSession(target.projectId, id);
    });
  }, [sshWindow, state.sessions, selectSession]);
  useEffect(() => {
    if (sshWindow) return;
    return window.berth.onPetSettings(() => { saveStored('berth.settingsCategory', 'pet'); setPage('settings'); setError(''); });
  }, [sshWindow]);
  const toggleProject = useCallback((id: string) => setCollapsed(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]), []);
  useEffect(() => { if (!sshWindow&&!loading) saveStored('berth.collapsedProjects', JSON.stringify(collapsed.filter(id => workspaceProjects.some(project => project.id === id)))); }, [collapsed, workspaceProjects, loading]);
  function openModal(value: Modal, target: { projectId: string; sessionId?: string } | null = null) { setModalTarget(target); if (!quickOpen) opener.current = document.activeElement as HTMLElement | null; setError(''); setModal(value); }
  function clearFilter() { setSearch(''); setFilter('all'); }
  function newProject() { setFolder(''); setName(''); initialForm.current = JSON.stringify({ name: '', folder: '' }); openModal('project'); }
  function editProject(value = project) { if (!value) return; setFolder(value.path); setName(value.name); initialForm.current = JSON.stringify({ name: value.name, folder: value.path }); openModal('editProject', { projectId: value.id }); }
  function sessionForm(value: { title: string; agent: Agent; command: string; terminal: TerminalConfig | null; startNow: boolean; remote?: RemoteConfig | null }, editing = false, target: { projectId: string; sessionId?: string } | null = null) {
    setTitle(value.title); setAgent(value.agent); setCommand(value.command); setTerminal(value.terminal); setStartNow(value.startNow); setRemote(value.remote ?? null);
    initialForm.current = JSON.stringify({ ...value, remote: value.remote ?? null }); openModal(value.remote ? editing ? 'editSshSession' : 'sshSession' : editing ? 'editSession' : 'session', target);
  }
  function newSession(id = projectId) { sessionForm({ title: '', agent: state.settings.defaultAgent, command: state.settings.defaultAgent === 'custom' ? state.settings.defaultCommand : state.agents?.find(item => item.id === state.settings.defaultAgent)?.command ?? '', terminal: null, startNow: true }, false, { projectId: id }); }
  function newSshSession() { sessionForm({title:'', agent:'shell', command:'', terminal:null, startNow:true, remote:{host:'',directory:''}}); }
  function editSession(value = session) { if (value) sessionForm({ title: value.title, agent: value.agent, command: value.command, terminal: value.terminal, startNow: false, remote: value.remote ?? null }, true, { projectId: value.projectId, sessionId: value.id }); }
  function copySession(value = session) { if (value) sessionForm({ title: value.title.slice(0, 90) + ' · 副本', agent: value.agent, command: value.command, terminal: value.terminal, startNow: false, remote: value.remote ?? null }, false, { projectId: value.projectId }); }
  function openLink() { const value = session?.nativeSessionId ?? ''; setNativeId(value); initialForm.current = JSON.stringify(value); openModal('link'); }
  function openQuick() { opener.current = document.activeElement as HTMLElement | null; setQuickOpen(true); }
  function chooseTarget(target: SwitchTarget) {
    setQuickOpen(false);
    if (target.kind === 'action') { if (target.action === 'settings') { setPage('settings'); setError(''); } else if (target.action === 'project') newProject(); else newSession(); return; }
    if(target.sessionId)selectSession(target.projectId!,target.sessionId);else selectProject(target.projectId!);setTab('terminal');
  }
  async function copyText(text: string, label: string) { try { await window.berth.copyText(text); setMessage(label + '已复制'); } catch (reason) { setError(String(reason)); } }
  function cycleSession(previous: boolean) {
    if (!project) return;
    const visible = projectSessions.filter(item => matchesSession(item, project, deferredSearch, filter, agentNames));
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
      if(sshWindow)return;
      const current = shortcuts.current;
      if (event.isComposing || event.getModifierState('AltGraph') || current.modal || document.querySelector('[role="dialog"], [role="menu"]') || current.busy || !(event.ctrlKey || event.metaKey)) return;
      const value = event.key.toLowerCase();
      if(value==='b'&&!event.shiftKey&&!event.altKey){if((event.target as HTMLElement)?.closest?.('.terminal-surface'))return;event.preventDefault();event.stopPropagation();document.querySelector<HTMLButtonElement>('.sidebar-collapse')?.focus();setSidebarCollapsed(value=>!value);}
      else if (value === 'p' && event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (current.quickOpen) setQuickOpen(false); else current.openQuick(); }
      else if (value === 'e' && event.shiftKey && !event.altKey && current.project) { event.preventDefault(); event.stopPropagation(); setSidebarCollapsed(false);setPage('workspace'); setSidebarView(value => value === 'files' ? 'sessions' : 'files'); }
      else if (value === 'g' && event.shiftKey && !event.altKey && current.project) { event.preventDefault(); event.stopPropagation(); setSidebarCollapsed(false);setPage('workspace'); setSidebarView('git'); }
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
    event.preventDefault(); const result = await perform<Project>(modal === 'editProject' ? 'updateProject' : 'createProject', { ...(modal === 'editProject' ? { projectId: actionProject!.id } : {}), name: name.trim() || folder.split(/[\\/]/).filter(Boolean).at(-1) || '项目', path: folder });
    if (result) { if (modal === 'project') selectProject(result.id); setModal(null); }
  }
  async function submitSession(event: FormEvent) {
    event.preventDefault(); const editing = modal === 'editSession' || modal === 'editSshSession';
    const sessionTitle = title.trim() || nextSessionTitle(remote ? 'SSH' : agentNames[agent], (remote ? state.sessions.filter(item=>item.remote) : actionProjectSessions).map(item=>item.title));
    const result = await perform<Session>(editing ? 'updateSession' : remote ? 'createRemoteSession' : 'createSession', remote && !editing
      ? {title:sessionTitle, remote}
      : { ...(editing ? {sessionId:actionSession!.id} : {projectId:actionProject!.id}), title:sessionTitle, agent:remote?'shell':agent, command:remote?'':isCustomAgent(agent)?command:'', terminal:remote?null:terminal, remote });
    if (result) { if (!editing) { if(result.remote){selectSsh(result.id);setSshOpen(true);}else selectSession(result.projectId, result.id); setSearch(''); setFilter('all'); } setModal(null); if (!editing && startNow) await perform('start', { sessionId: result.id, resume: false, cols: 100, rows: 30 }); }
  }
  async function importHistory() {
    try { const target = sessionId; const file = await window.berth.chooseTranscript(); if (!file) return; const result = await perform<History>('importHistory', { sessionId: target, path: file }); if (result && currentSessionId.current === target) { setHistory(result); setTab('history'); } }
    catch (reason) { setError(String(reason)); }
  }
  async function refreshHistory() {
    const target = sessionId;
    const result = await perform<History>('refreshHistory', { sessionId: target });
    if (result && currentSessionId.current === target) setHistory(result);
  }
  async function restartBackend() {
    setBusy(true); setError(''); setMessage('');
    try { await window.berth.restartBackend(); setModal(null); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const menuItems: MenuItem[] = [];
  const menuProject = treeMenu?.kind === 'project' ? state.projects.find(item => item.id === treeMenu.id) : undefined;
  const menuSession = treeMenu?.kind === 'session' ? state.sessions.find(item => item.id === treeMenu.id) : undefined;
  const menuModal = (kind: Modal, target: { projectId: string; sessionId?: string }) => { openModal(kind, target); opener.current = treeMenu!.opener; };
  if (menuProject) {
    const value = menuProject, target = { projectId: value.id }, hasRunning = state.sessions.some(item => item.projectId === value.id && active(item));
    menuItems.push(
      { label: '新建会话', disabled: manageDisabled, action: () => { newSession(value.id); opener.current = treeMenu!.opener; } },
      { label: '重命名项目', disabled: manageDisabled, action: () => { setName(value.name); initialForm.current = JSON.stringify(value.name); menuModal('renameProject', target); } },
      { label: '编辑项目', disabled: manageDisabled, action: () => { editProject(value); opener.current = treeMenu!.opener; } },
      { label: '在文件管理器中打开', separator: true, action: () => void window.berth.openProject(value.path).catch(reason => setError(String(reason))) },
      { label: 'Git 管理', disabled: !connected || state.apiVersion < 12, action: () => { openGit(value); } },
      { label: '复制项目路径', action: () => void copyText(value.path, '项目路径') },
      { label: '删除项目', separator: true, danger: true, disabled: manageDisabled || hasRunning, hint: hasRunning ? '请先停止本项目全部终端' : undefined, action: () => menuModal('deleteProject', target) },
    );
  }
  if (menuSession) {
    const value = menuSession, target = { projectId: value.projectId, sessionId: value.id };
    const definition = state.agents?.find(item => item.id === value.agent);
    const resumable = ['codex', 'claude', 'opencode'].includes(value.agent) || !!definition?.resumeCommand || !!definition?.plugin?.resume;
    menuItems.push(
      { label: value.remote ? '新建 SSH 会话' : '新建会话', disabled: manageDisabled || (!!value.remote && state.apiVersion<24), action: () => { if(value.remote)newSshSession();else newSession(value.projectId); opener.current = treeMenu!.opener; } },
      { label: '重命名会话', disabled: manageDisabled, action: () => { setTitle(value.title); initialForm.current = JSON.stringify(value.title); menuModal('renameSession', target); } },
      { label: '编辑会话', disabled: manageDisabled, action: () => { editSession(value); opener.current = treeMenu!.opener; } },
      { label: '复制会话', disabled: manageDisabled || (!!value.remote && state.apiVersion<24), action: () => { copySession(value); opener.current = treeMenu!.opener; } },
      active(value) ? { label: '停止终端', separator: true, disabled: manageDisabled || value.latestRun?.status === 'stopping', action: () => menuModal('stop', target) }
        : { label: '启动终端', separator: true, disabled: manageDisabled, action: () => { selectSession(value.projectId, value.id); void perform('start', { sessionId: value.id, resume: false, cols: 100, rows: 30 }); } },
      ...(resumable && value.nativeSessionId && !active(value) ? [{ label: '恢复原生会话', disabled: manageDisabled, action: () => { selectSession(value.projectId, value.id); void perform('start', { sessionId: value.id, resume: true, cols: 100, rows: 30 }); } }] : []),
      { label: '删除会话', separator: true, danger: true, disabled: manageDisabled || active(value), hint: active(value) ? '请先停止此终端' : undefined, action: () => menuModal('deleteSession', target) },
    );
  }
  const closeModal = () => { setModal(null); setError(''); };
  const cancelButton = <button type="button" data-dismiss="dialog" className="subtle" disabled={busy} onClick={closeModal}>取消</button>;

  return <div className={sshWindow?"ssh-window app":"app"}>
    {!sshWindow&&<><ResourceMonitor enabled={connected && state.apiVersion >= 14} />
    <ResizableSidebar collapsed={sidebarCollapsed}>
      <button type="button" className="sidebar-collapse icon-button" aria-label={sidebarCollapsed?'展开侧栏':'收起侧栏'} aria-expanded={!sidebarCollapsed} aria-controls="sidebar-content" aria-keyshortcuts="Control+B Meta+B" title={`${sidebarCollapsed?'展开':'收起'}侧栏 · Ctrl+B（终端外）`} onClick={()=>setSidebarCollapsed(value=>!value)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d={sidebarCollapsed?'m13 9 3 3-3 3':'m16 9-3 3 3 3'}/></svg></button>
      <div className="sidebar-rail" hidden={!sidebarCollapsed}>
        <nav aria-label="侧栏快捷切换">
          <button type="button" className="icon-button" aria-label="会话" title="会话" aria-pressed={page==='workspace'&&sidebarView==='sessions'} onClick={()=>{setSidebarView('sessions');setPage('workspace');setSidebarCollapsed(false);}}><Icon kind="terminal" />{localUnread&&<span className="rail-unread" aria-label="有新输出" />}</button>
          <button type="button" className="icon-button" aria-label="文件" title="文件 · Ctrl+Shift+E" disabled={!project||state.apiVersion<16} aria-pressed={page==='workspace'&&sidebarView==='files'} onClick={()=>{setSidebarView('files');setPage('workspace');setSidebarCollapsed(false);}}><Icon kind="folder" /></button>
          <button type="button" className="icon-button" aria-label="Git" title="Git · Ctrl+Shift+G" disabled={!project} aria-pressed={page==='workspace'&&sidebarView==='git'} onClick={()=>{setSidebarView('git');setPage('workspace');setSidebarCollapsed(false);}}><Icon kind="git" /></button>
        </nav>
        <div className="sidebar-rail-bottom"><button type="button" className="icon-button" aria-label="设置" title="设置 · Ctrl+," aria-pressed={page==='settings'} onClick={()=>{setPage('settings');setError('');}}><Icon kind="settings" /></button><AppearanceToggle /></div>
      </div>
      <div id="sidebar-content" className="sidebar-content" hidden={sidebarCollapsed}>
      <div className="brand"><img className="brand-mark" src={appIcon} alt="" /><div><strong>AgentBerth</strong><small>泊栈 · 项目开发工作台</small></div></div>
      <button className="quick-link" onClick={openQuick} title="Ctrl+Shift+P">快速切换<kbd>Ctrl+Shift+P</kbd></button>
      <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图"><button role="tab" aria-label="会话" aria-selected={sidebarView === 'sessions'} onClick={() => { setSidebarView('sessions'); setPage('workspace'); }}><Icon kind="terminal" />会话{localUnread && sidebarView !== 'sessions' && <OutputBadge />}</button><button role="tab" aria-selected={sidebarView === 'files'} disabled={!project || state.apiVersion < 16} title="项目文件 · Ctrl+Shift+E" onClick={() => { setSidebarView('files'); setPage('workspace'); }}><Icon kind="folder" />文件</button><button role="tab" aria-selected={sidebarView === 'git'} disabled={!project} title="源代码管理 · Ctrl+Shift+G" onClick={() => { setSidebarView('git'); setPage('workspace'); }}><Icon kind="git" />Git</button></div>
      <div className="sidebar-panel" hidden={sidebarView !== 'sessions'}>
      <div className="sidebar-heading"><span>项目与会话</span><button className="icon-button" aria-label="添加项目" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" /></button></div>
      {workspaceProjects.length > 0 && <div className="tree-search"><input className="search" placeholder="搜索项目、会话或目录…" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索项目和会话" /><select className="session-filter" aria-label="筛选会话" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部会话</option><option value="active">运行中</option><option value="inactive">未运行</option>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{(search || filter !== 'all') && <button className="clear-filter" onClick={clearFilter}>清除筛选</button>}</div>}
      <ProjectTree unread={unread} projects={workspaceProjects} sessions={sidebarSessions} projectId={page === 'workspace' ? projectId : ''} sessionId={page === 'workspace' ? sessionId : ''} collapsed={collapsed} query={deferredSearch} filter={filter} names={agentNames} disabled={manageDisabled} onToggle={toggleProject} onProject={selectProject} onSession={selectSession} onNewSession={newSession} onMenu={setTreeMenu} />
      </div>
      <div className="sidebar-panel" hidden={sidebarView !== 'files'}>
        <div className="file-project-picker"><select aria-label="文件所属项目" value={projectId} onChange={event => { selectProject(event.target.value); setFileTarget(null); }}>{workspaceProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className="sidebar-files-host" ref={setFileTreeHost} />
      </div>
      <div className="sidebar-panel" hidden={sidebarView !== 'git'}>
        <div className="file-project-picker"><select aria-label="Git 所属项目" value={projectId} onChange={event => selectProject(event.target.value)}>{workspaceProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        {project && <GitSidebar key={`${project.id}:${project.path}`} project={project} enabled={connected && state.apiVersion >= 13} visible={sidebarView === 'git' && page === 'workspace'} supported={state.apiVersion >= 18} onDiff={openDiff} onNotice={setMessage} onError={setError} />}
      </div>
      <div className="sidebar-settings"><button className={`settings-link ${page === 'settings' ? 'selected' : ''}`} onClick={() => { setPage('settings'); setError(''); }} title="Ctrl+," aria-label="设置"><Icon kind="settings" />设置{draftDirty && <span className="draft-dot" title="有未保存的设置草稿" />}</button><AppearanceToggle /></div>
      <div className="workspace-resources"><span>工作台</span><ResourceBadge scope="workspace" full /></div>
      <div className="sidebar-bottom"><span className={`dot ${connected ? 'live' : ''}`} /><span>{connected ? '后台已连接' : '后台未连接'}</span><button className="text-button" disabled={busy} onClick={() => void window.berth?.reconnect().catch(reason => setError(String(reason)))}>重连</button></div>
      </div>
    </ResizableSidebar>
    <main className={`main ${headerCollapsed && page === 'workspace' ? 'header-collapsed' : ''}`}>
      <header className="topbar"><div><span className="eyebrow">{page === 'settings' ? 'SETTINGS' : 'WORKSPACE'}</span><span className="crumb"> / {page === 'settings' ? '应用设置' : project?.name ?? '欢迎来到泊栈'}</span></div><div className="topbar-status">{state.apiVersion>=21&&<button type="button" className={`subtle ssh-toggle${!sshWindowState.detached&&sshOpen&&page==='workspace'?' selected':''}`} aria-label="SSH 面板" aria-expanded={!sshWindowState.detached&&sshOpen&&page==='workspace'} aria-controls="ssh-workspace-dock" onClick={()=>{if(sshWindowState.detached){void changeSshWindow('open').catch(reason=>setError(String(reason)));return;}setSshOpen(previous=>page!=='workspace'||!previous);setPage('workspace');}} title={sshWindowState.detached?'SSH 已在独立窗口中，点击前往':undefined}>SSH{sshUnread&&<OutputBadge />}{(state.apiVersion>=27||sshRunning>0)&&<span className="ssh-count">{sshRunning}{state.apiVersion>=27?`/${state.maxSshTerminals}`:''}</span>}</button>}{page === 'workspace' && project && <GitBranch key={`${project.id}:${project.path}`} project={project} enabled={connected && state.apiVersion >= 13} onOpen={() => openGit(project)} />}{page === 'workspace' && project && <button className="text-button header-toggle" aria-expanded={!headerCollapsed} aria-controls="project-details" onClick={() => setHeaderCollapsed(value => !value)}>{headerCollapsed ? '展开顶部信息' : '折叠顶部信息'}</button>}<span className={`dot ${connected ? 'live' : ''}`} />{state.apiVersion>=27?`本机 ${running-sshRunning}`:`${running} 个终端后台运行`} <span className="quiet">/ {state.maxActiveTerminals}</span></div></header>
      {legacy && <div className="upgrade-notice" role="status"><span>旧版后台仍在运行。停止全部终端后更新后台，即可启用当前版本的全部功能。</span><button className="subtle" disabled={!connected || busy || running > 0} onClick={() => openModal('restart')}>更新后台</button></div>}
      {state.recovery && (state.recovery.total > 0 || state.recovery.errors.length > 0) && dismissedRecovery !== state.recovery.id && <div className="workspace-recovery" role="status" aria-label="工作区恢复状态">
        <div><strong>{state.recovery.status === 'restoring' ? '正在恢复上次退出的会话' : state.recovery.errors.length ? '部分会话未恢复' : '上次会话恢复完成'}</strong><span> · 已重新打开 {state.recovery.restored}/{state.recovery.total} · 续接 Agent 对话 {state.recovery.resumed}{state.recovery.skipped > 0 ? ` · 跳过 ${state.recovery.skipped}` : ''}</span>
        <small>Agent 续接原生对话；普通终端与 SSH 重开，旧远端任务状态需确认，不重放历史命令。</small>
        {state.recovery.errors.length > 0 && <details><summary>{state.recovery.errors.length} 个会话未恢复，可右键对应会话重新启动</summary><ul>{state.recovery.errors.map(item => <li key={item.sessionId}><strong>{item.title}</strong>：{item.message}</li>)}</ul></details>}</div>
        <button className="icon-button" type="button" aria-label="关闭恢复提示" onClick={() => setDismissedRecovery(state.recovery!.id)}>×</button>
      </div>}
      {loading ? <div className="empty-page"><div className="loader" /><h2>正在连接你的工作空间</h2></div> : <><div className="settings-host" hidden={page !== 'settings'}>{page === 'settings' && <SettingsPage projects={workspaceProjects} currentProjectId={projectId} connected={connected} apiVersion={state.apiVersion} agents={state.agents ?? []} usedAgents={state.sessions.map(item => item.agent)} onSaveAgent={(value, id) => perform<AgentDefinition>(id ? 'updateAgent' : 'createAgent', { ...value, ...(id ? { agentId: id } : {}) })} onDeleteAgent={id => perform('deleteAgent', { agentId: id })} settings={state.settings} draft={draftDirty ? settingsDraft!.value : state.settings} onChange={value => setSettingsDraft(JSON.stringify(value) === JSON.stringify(state.settings) ? null : { base: state.settings, value })} onDiscard={() => { setSettingsDraft(null); setError(''); }} conflict={draftConflict} onError={setError} error={error} platform={state.platform} busy={busy} disabled={manageDisabled || legacy} restartDisabled={busy || !connected} running={running} onSave={async (value: Settings) => { const result = await perform<Settings>('saveSettings', { ...value }); if (result !== undefined) { setSettingsDraft(null); return true; } return false; }} onRestart={() => openModal('restart')} />}</div><div className="workbench-split" hidden={page !== 'workspace'}><div className="workspace-host" hidden={!project&&sshOpen}>{!project ? <div className="empty-page welcome"><div className="welcome-symbol"><Icon kind="terminal" /></div><span className="eyebrow">YOUR PROJECTS, IN ONE PLACE</span><h1>把开发现场，留在这里。</h1><p>目录、终端和对话记录，放在同一个工作台。<br />关掉窗口，再回来继续。</p><button className="primary" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" />添加第一个项目</button><div className="welcome-features"><span><Icon kind="folder" />按目录组织</span><span><Icon kind="terminal" />多会话后台运行</span><span><Icon kind="history" />原生对话关联</span></div></div> : <>
        <section className="project-header" id="project-details" hidden={headerCollapsed}><div><span className="eyebrow">PROJECT SPACE</span><h1 title={project.name}>{project.name}</h1><code className="project-path" title={project.path}>{project.path}</code></div></section>
        <section className="workspace">
          <div className="session-content">
            <header className="session-header" data-session-id={session?.id}><div><h2>{tab === 'preview' ? '文件预览' : session?.title ?? '项目工作区'}</h2>{tab === 'preview' ? <span className="badge">项目文件</span> : session && <><span className={`badge ${active(session) ? 'live-badge' : ''}`}>{statusNames[session.latestRun?.status ?? ''] ?? '待启动'}</span><span className="agent-label">{agentNames[session.agent]}</span></>}</div>{session && active(session) && <ResourceBadge scope="session" id={session.id} runId={session.latestRun?.id} full />}</header>
            {session && tab !== 'preview' && !matchesSession(session, project, deferredSearch, filter, agentNames) && <div className="filter-notice">当前会话不在筛选结果中，终端仍可继续使用。</div>}
            <div className="tabs" role="tablist" aria-label="工作区内容"><button role="tab" aria-selected={tab === 'terminal'} className={tab === 'terminal' ? 'selected' : ''} onClick={() => setTab('terminal')}>终端</button>{session && (recordOutput || canHistory || canResume || sessionDefinition?.plugin?.list) && <button role="tab" aria-selected={tab === (recordOutput ? 'runs' : 'history')} className={tab === (recordOutput ? 'runs' : 'history') ? 'selected' : ''} onClick={() => setTab(recordOutput ? 'runs' : 'history')}>{recordOutput ? '运行记录' : '对话历史'}</button>}<button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'selected' : ''} disabled={state.apiVersion < 16} onClick={() => { setFilesActivated(true); setTab('preview'); }}>预览</button>{tab === 'terminal' && session?.latestRun?.status === 'running' && <button className="hide-terminal" onClick={() => setTerminalVisible(value => !value)}>{terminalVisible ? '收起终端' : '接回终端'}</button>}</div>
            {!session && tab === 'terminal' && <div className="empty-page"><Icon kind="terminal" /><h2>选择或创建一个会话</h2><button className="subtle" onClick={() => newSession()} disabled={manageDisabled}>新建会话</button><p>也可以从左侧“文件”浏览项目，无需启动终端。</p></div>}
            {session && <div className="terminal-panel workspace-panel" role="tabpanel" aria-label="终端" hidden={tab !== 'terminal'}>{session.latestRun?.error && <div className="launch-error" role="status"><strong>{session.latestRun?.status === 'interrupted' ? '上次运行已中断' : '启动未完成'}</strong><p>{session.latestRun.error}</p><p>右键左侧项目或会话，修改配置后重新启动。</p></div>}{connected && session.latestRun?.status !== 'running' ? <TerminalState historyAvailable={canHistory || canResume} recordOutput={recordOutput} run={session.latestRun} disabled={manageDisabled} onOutput={() => { if (session.latestRun) { setViewingRun({ sessionId, runId: session.latestRun.id }); setTab('runs'); } }} /> : connected && terminalVisible ? <TerminalView key={`${session.id}:${session.latestRun?.id}:${connectionEpoch}`} sessionId={sessionId} remoteSession={!!session.remote} inputEnabled windowsPty={windowsPty} orderedResize={state.apiVersion >= 9} binaryMouse={state.apiVersion >= 16} fontSize={state.settings.fontSize} autoFocus={page === 'workspace' && !modal && !quickOpen && !treeMenu && sidebarView !== 'git' && tab === 'terminal'} onError={setError} onOpenPath={!session.remote && state.apiVersion >= 17 ? openPath : undefined} /> : <div className="empty-page"><Icon kind="terminal" /><h2>{connected ? '终端已收起' : '后台连接已断开'}</h2><p>{connected ? '运行中的任务仍在后台继续。' : '重新连接后接回终端。'}</p><button className="subtle" onClick={() => connected ? setTerminalVisible(true) : void window.berth.reconnect().catch(reason => setError(String(reason)))}>{connected ? '接回终端' : '重新连接'}</button></div>}<footer className="terminal-footer"><span>{session.latestRun ? `${active(session) ? '运行' : '上次运行'} ${session.latestRun.id.slice(0, 8)}${active(session) && !session.remote ? ` · PID ${session.latestRun.pid ?? '—'}` : ''}` : '尚未启动'} · {session.latestRun ? session.latestRun.shell?.split(/[\\/]/).at(-1) || '历史终端' : terminalNames[(session.terminal ?? state.settings.terminal).profile]}</span><span>{session.remote ? '本机后台维持 SSH · 链路断开不保证恢复原进程' : '关窗口继续运行 · 托盘退出停止全部终端'}</span></footer></div>}
            {session && tab === 'history' && <HistoryPanel key={`${session.id}:${project.path}:${JSON.stringify(sessionDefinition?.plugin)}`} session={session} history={history} label={agentNames[session.agent]} canHistory={canHistory} canAssociate={canHistory || canResume || !!sessionDefinition?.plugin?.list} canDiscover={!!sessionDefinition?.plugin?.list || state.apiVersion >= 35 && ['codex', 'claude'].includes(session.agent) || state.apiVersion >= 38 && (session.agent === 'opencode' || !!sessionDefinition?.integration)} autoRead={!!sessionDefinition?.plugin?.history || !!session.nativeSessionId && (['claude', 'opencode'].includes(session.agent) || !!sessionDefinition?.integration)} supported={state.apiVersion >= 11} disabled={manageDisabled} onImport={importHistory} onRefresh={refreshHistory} onManual={openLink} onCopy={id => void copyText(id, '原生会话 ID')} onLink={async nativeSessionId => {
              const target = sessionId;
              const result = await perform<History>('linkNativeSession', { sessionId: target, nativeSessionId });
              if (result && currentSessionId.current === target) { setHistory(result); setMessage('原生会话已关联'); }
              return result;
            }} onUnlink={async () => {
              const target = sessionId;
              const result = await perform<History>('unlinkNativeSession', { sessionId: target });
              if (result && currentSessionId.current === target) { setHistory(result); setMessage('已解除关联，历史记录保留'); }
              return result;
            }} />}
            {session && tab === 'runs' && recordOutput && <RunHistory key={sessionId} runs={runs} outputRunId={outputRunId} output={runOutput} windowsPty={windowsPty} fontSize={state.settings.fontSize} disabled={manageDisabled || state.apiVersion < 10} onError={setError} onView={runId => { setRunOutput(null); setViewingRun(runId ? { sessionId, runId } : null); }} onDelete={async runId => {
              const selected = sessionId;
              const result = await perform(runId ? 'deleteRun' : 'clearFinishedRuns', runId ? { runId } : { sessionId: selected });
              if (result === undefined) return false;
              if (currentSessionId.current === selected) { setViewingRun(null); setRunOutput(null); setRunsRevision(value => value + 1); }
              setMessage('运行记录已删除'); return true;
            }} />}
            <div className="workspace-panel preview-panel" role="tabpanel" aria-label="预览" hidden={tab !== 'preview'} ref={setFilePreviewHost}>{gitPreview?.projectId === projectId && <Suspense fallback={<p>正在准备差异预览…</p>}><GitDiffPreview request={gitPreview} connected={connected} onChange={staged => setGitPreview(value => value ? { ...value, staged } : null)} onBack={() => setGitPreview(null)} /></Suspense>}</div>
          </div>
        </section>
      </>}</div><div id="ssh-workspace-dock" className="ssh-dock-slot" hidden={!sshOpen}>{sshWindowReady&&!sshWindowState.detached&&<SshDock onWindow={()=>changeSshWindow('open')} unread={unread} state={state} visible={sshOpen&&page==='workspace'} connected={connected} sessionId={sshSessionId} onSelect={setSshSessionId} onClose={()=>setSshOpen(false)} onMenu={setTreeMenu} onError={setError} connectionEpoch={connectionEpoch} hasLocal={!!project} />}</div></div></>}
    </main></>}
    {sshWindow&&sshWindowReady&&<SshDock unread={unread} state={state} visible connected={connected} sessionId={sshSessionId} onSelect={selectSsh} onClose={()=>void changeSshWindow('dock').catch(reason=>setError(String(reason)))} onMenu={setTreeMenu} onError={setError} connectionEpoch={connectionEpoch} hasLocal={false} detached onWindow={()=>changeSshWindow('dock')} />}
    {!sshWindow && project && state.apiVersion >= 16 && filesActivated && <Suspense fallback={null}><FileBrowser key={`${project.id}:${project.path}`} project={project} connected={connected} treeHost={fileTreeHost} previewHost={filePreviewHost} previewHidden={gitPreview?.projectId === projectId} onDiff={state.apiVersion >= 18 ? openDiff : undefined} onPreview={openPreview} navigationSupported={state.apiVersion >= 17} onTargetConsumed={consumeFileTarget} target={fileTarget?.projectId === projectId ? fileTarget : null} /></Suspense>}
    {treeMenu && menuItems.length > 0 && <ContextMenu target={treeMenu} items={menuItems} onClose={closeTreeMenu} />}
    {(modal === 'renameSession' || modal === 'renameProject') && <Dialog title={modal === 'renameSession' ? '重命名会话' : '重命名项目'} dirty={dirtyForm} busy={busy} error={error} returnFocus={opener.current} onClose={closeModal}><form onSubmit={async event => {
      event.preventDefault(); const result = modal === 'renameSession' ? await perform('renameSession', { sessionId: actionSession!.id, title }) : await perform('updateProject', { projectId: actionProject!.id, name, path: actionProject!.path });
      if (result !== undefined) setModal(null);
    }}><label>{modal === 'renameSession' ? '会话名称' : '项目名称'}<input aria-label={modal === 'renameSession' ? '会话名称' : '项目名称'} autoFocus required maxLength={100} value={modal === 'renameSession' ? title : name} onChange={event => modal === 'renameSession' ? setTitle(event.target.value) : setName(event.target.value)} /></label><footer>{cancelButton}<button className="primary" disabled={busy}>保存名称</button></footer></form></Dialog>}
    {quickOpen && <QuickSwitcher state={{...state,projects:workspaceProjects}} canCreate={!manageDisabled} hasProject={!!project} onSelect={chooseTarget} onClose={() => setQuickOpen(false)} returnFocus={opener.current} />}
    {message && <div className="toast success-toast" role="status">{message}</div>}
    {error && !modal && page !== 'settings' && <div className="toast" role="alert"><span>{error.replace(/^Error: /, '')}</span><button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    {(modal === 'project' || modal === 'editProject') && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title={modal === 'project' ? '添加项目目录' : '编辑项目'} onClose={closeModal}><form onSubmit={submitProject}><label>项目名称（可选）<input aria-label="项目名称" autoFocus maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="留空按目录自动命名" /></label><label>项目目录<div className="input-with-button"><input aria-label="项目目录" required disabled={modal === 'editProject' && actionProjectSessions.some(active)} value={folder} onChange={event => setFolder(event.target.value)} placeholder={state.platform === 'win32' ? 'D:\\Projects\\my-project' : '/home/user/projects/my-project'} /><button type="button" className="subtle" disabled={modal === 'editProject' && actionProjectSessions.some(active)} onClick={() => void selectFolder()}>选择目录</button></div></label><p className="form-hint">{modal === 'editProject' ? '运行中的项目可以修改名称。修改目录前请停止全部终端；修改后会清除原生对话关联，避免从错误目录恢复。' : '会话从这个目录启动，同一路径自动去重。'}</p><footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'project' ? '添加项目' : '保存项目'}</button></footer></form></Dialog>}
    {(modal === 'session' || modal === 'editSession') && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title={modal === 'session' ? '新建项目会话' : '编辑会话'} onClose={closeModal}><form onSubmit={submitSession}><label>会话名称（可选）<input aria-label="会话名称" autoFocus maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder={`${agentNames[agent]} 会话（留空自动命名）`} /></label><label>Agent 类型<select aria-label="Agent 类型" disabled={modal === 'editSession' && !!actionSession && active(actionSession)} value={agent} onChange={event => { const value = event.target.value; setAgent(value); setCommand(value === 'custom' ? state.settings.defaultCommand : state.agents?.find(item => item.id === value)?.command ?? ''); }}>{Object.entries(agentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{isCustomAgent(agent) && <label>启动命令<input aria-label="启动命令" required maxLength={4096} disabled={modal === 'editSession' && !!actionSession && active(actionSession)} value={command} onChange={event => setCommand(event.target.value)} placeholder="你的 Agent TUI 启动命令" /></label>}<details className="advanced-options" open={modal === 'editSession'}><summary>会话终端（默认跟随设置）</summary><TerminalFields value={terminal} onError={setError} platform={state.platform} inherit disabled={modal === 'editSession' && !!actionSession && active(actionSession)} onChange={setTerminal} /></details><p className="form-hint">工作目录：{actionProject?.path}<br />{modal === 'editSession' ? '启动配置需在停止终端后修改；更换 Agent 会清除原生对话关联。' : 'Agent 使用本机已有安装和登录状态。'}{agent === 'opencode' && <><br />启动 opencode；关联会话后使用 opencode --session ID 恢复。</>}</p>{modal === 'session' && <label className="checkbox-label"><input type="checkbox" checked={startNow} onChange={event => setStartNow(event.target.checked)} />创建后立即启动</label>}<footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'editSession' ? '保存会话' : startNow ? '创建并启动' : '创建会话'}</button></footer></form></Dialog>}
    {(modal === 'sshSession' || modal === 'editSshSession') && remote && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title={modal === 'sshSession' ? '新建 SSH 会话' : '编辑 SSH 会话'} onClose={closeModal}>
      <form onSubmit={submitSession}>
        <label>会话名称（可选）<input aria-label="会话名称" autoFocus maxLength={100} value={title} onChange={event=>setTitle(event.target.value)} placeholder="SSH 会话（留空自动命名）" /></label>
        <RemoteFields value={remote} disabled={modal === 'editSshSession' && !!actionSession && active(actionSession)} onError={setError} onChange={setRemote} />
        {modal === 'editSshSession' && <p className="form-hint">停止此 SSH 终端后可修改连接与远端目录；本机 Agent 会话不受影响。</p>}
        {modal === 'sshSession' && <label className="checkbox-label"><input type="checkbox" checked={startNow} onChange={event=>setStartNow(event.target.checked)} />创建后立即启动</label>}
        <footer>{cancelButton}<button className="primary" disabled={busy}>{modal === 'editSshSession' ? '保存会话' : startNow ? '创建并启动' : '创建会话'}</button></footer>
      </form>
    </Dialog>}
    {modal === 'deleteSession' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="删除此会话？" onClose={closeModal}><p className="stop-description">删除「{actionSession?.title}」及其运行记录、工作台日志和导入的对话副本。此操作无法撤销。<br />项目文件和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={async () => { if (await perform('deleteSession', { sessionId: actionSession!.id }) !== undefined) setModal(null); }}>确认删除会话</button></footer></Dialog>}
    {modal === 'deleteProject' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="删除此项目？" onClose={closeModal}><p className="stop-description">删除「{actionProject?.name}」的项目登记及全部 {actionProjectSessions.length} 个会话、运行记录和工作台日志。此操作无法撤销。<br />磁盘上的项目目录和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={async () => { if (await perform('deleteProject', { projectId: actionProject!.id }) !== undefined) setModal(null); }}>确认删除项目</button></footer></Dialog>}
    {modal === 'stop' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="停止此终端？" onClose={closeModal}><p className="stop-description">「{actionSession?.title}」{actionSession?.remote ? '将关闭 SSH 连接；远端任务可能继续运行，需在远端确认停止。' : '正在执行的任务会中断。'}<br />如需保留后台任务，可以收起终端或关闭窗口。</p><footer><button className="subtle" disabled={busy} onClick={closeModal}>继续运行</button><button className="danger" disabled={busy} onClick={async () => { if (await perform('stop', { sessionId: actionSession!.id }) !== undefined) setModal(null); }}>停止终端</button></footer></Dialog>}
    {modal === 'link' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="关联原生会话 ID" onClose={closeModal}><form onSubmit={async event => { event.preventDefault(); const result = await perform<History>('linkNativeSession', { sessionId, nativeSessionId: nativeId.trim() }); if (result) { setHistory(result); setModal(null); } }}><label>原生会话 ID<input aria-label="原生会话 ID" autoFocus required maxLength={128} pattern="[a-zA-Z0-9_-]+" value={nativeId} onChange={event => setNativeId(event.target.value)} /></label><p className="form-hint">请填写本机 {session ? agentNames[session.agent] : 'Agent'} 在此项目中已有的会话 ID。可在终端运行时关联，用于历史查看与下次恢复；不会切换当前 CLI。原有历史仍保留在列表中。</p><footer>{cancelButton}<button className="primary" disabled={busy}>保存关联</button></footer></form></Dialog>}
    {modal === 'restart' && <Dialog key={modal} dirty={dirtyForm} error={error} returnFocus={opener.current} busy={busy} title="更新后台服务？" onClose={closeModal}><p className="stop-description">重新启动后台，加载当前版本的功能。项目、会话、设置和运行记录会保留。<br />所有终端都需要先停止。</p><footer>{cancelButton}<button className="primary" disabled={busy || running > 0 || !connected} onClick={() => void restartBackend()}>确认更新后台</button></footer></Dialog>}
  </div>;
}
