import { SuccessToast, type ToastAction } from './SuccessToast';
import { dismissNotice, pushNotice, type Notice } from './notice-queue';
import { WorkspaceSkeleton } from './WorkspaceSkeleton';
import {reconcileSidebarOrder,loadSidebarOrder,orderSidebarItems,completeSidebarOrder,moveSidebarItem,type SidebarMove} from './sidebar-order';
import { ExtensionsContext } from './ExtensionManager';
import { ExtensionView } from './ExtensionView';
import { extensionEnabled } from '../shared/extensions';
import appIcon from '../../assets/app.png';
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { API_VERSION, isCustomAgent, type DeletionUndo, type History, type Method, type Project, type Session, type Settings, type State, type SshWindowState } from '../shared/protocol';
import { SshDock } from './SshDock';
import { OutputBadge, useTerminalActivity } from './useTerminalActivity';
import { TerminalView } from './TerminalView';
import { AcpConversation } from './AcpConversation';
import { AppearanceToggle } from './AppearanceControls';
import { ResourceBadge, ResourceMonitor } from './Resources';
import { GitBranch, GitSidebar } from './GitManager';
import { WorktreeManager } from './WorktreeManager';
import type { GitDiffRequest } from '../shared/protocol';
import { SessionInsights } from './SessionInsights';
import { ServiceTerminal } from './ServiceTerminal';
import { TerminalState } from './TerminalState';
import { SettingsPage } from './SettingsPage';
import { PluginCenter, type PluginCenterTab } from './PluginCenter';
import { agentLabels, nextSessionTitle, statusNames, terminalNames } from './labels';
import { ContextMenu, type TreeMenuTarget, type MenuItem } from './ContextMenu';
import { ModalLayer } from './ModalLayer';
import type { Modal, ModalInitial, ModalRequest, ModalTarget, ProjectFormValues, SessionFormValues } from './modal-form';
import { QuickSwitcher, type SwitchTarget } from './QuickSwitcher';
import { PluginSettingsPopover } from './PluginSettingsPopover';
import { ShortcutsDialog } from './ShortcutsDialog';
import { loadCollapsedProjects, loadSelections, loadSettingsDraft, readStored, saveStored, type SettingsDraft } from './storage';
import { getWorkspaceState, publishWorkspaceState, useStableCallback, useWorkspaceState } from './workspace-state';

import { matchesSession, ProjectTree, ResizableSidebar } from './WorkspaceSidebar';
import { ActivityBar } from './ActivityBar';
import { handleTabKeyDown } from './tab-navigation';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');
const FileBrowser = lazy(() => import('./FileBrowser'));
const GitDiffPreview = lazy(() => import('./GitDiffPreview'));
function Icon({ kind }: { kind: 'folder' | 'terminal' | 'plus' | 'arrow' | 'history' | 'settings' | 'git' | 'plugins' }) {
  const paths = { plugins: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', git: 'M6 8v8m0-4c9 0 12-2 12-5M6 4a2 2 0 1 0 0 .1M6 18a2 2 0 1 0 0 .1M18 3a2 2 0 1 0 0 .1', folder: 'M3 7V5h6l2 2h10v12H3V7Z', terminal: 'm5 7 4 4-4 4m7 0h6', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-5-5 5 5-5 5', history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2', settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
export function App({sshWindow=false}: {sshWindow?: boolean}) {
  const state = useWorkspaceState(value => value);
  const features={workspace:true,agents:true,ssh:true,pet:extensionEnabled(state.extensions,'pet'),files:true,git:true,resources:true,appearance:true};
  const [extensionView,setExtensionView]=useState<{pluginId:string;viewId:string;taskId?:string;sessionId?:string}|null>(null);
  const selectedExtension=state.extensions?.plugins.find(p=>p.manifest.id===extensionView?.pluginId&&p.status==='active');
  useEffect(()=>{if(!features.files&&tab==='preview')setTab('terminal');if(!features.ssh)setSshOpen(false);if(!features.git)setGitPreview(null);if(!features.workspace){setPage('plugins');}if(extensionView&&!selectedExtension)setExtensionView(null);},[features.files,features.git,features.ssh,features.workspace,selectedExtension?.manifest.id]);
  const [sidebarOrder,setSidebarOrder]=useState(loadSidebarOrder);
  const workspaceProjects=useMemo(()=>orderSidebarItems(state.projects.filter(project=>!project.remoteWorkspace),sidebarOrder.projects),[state.projects,sidebarOrder.projects]);
  const [projectId, setProjectId] = useState(() => readStored('berth.project') ?? '');
  const [sessionId, setSessionId] = useState(() => readStored('berth.session') ?? '');
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>readStored('berth.sidebarCollapsed')==='true');
  useEffect(()=>{if(!sshWindow)saveStored('berth.sidebarCollapsed',String(sidebarCollapsed));},[sidebarCollapsed]);
  const [rightSidebarCollapsed,setRightSidebarCollapsed]=useState(()=>{
    const saved=readStored('berth.rightSidebarCollapsed');if(saved!==null)return saved!=='false';
    const legacy=readStored('berth.sidebarView');return !(legacy==='files'||legacy==='git'||readStored('berth.filesOpen')==='true');
  });
  const [rightSidebarView,setRightSidebarView]=useState<'files'|'git'>(()=>{
    const saved=readStored('berth.rightSidebarView');if(saved==='git'||saved==='files')return saved;
    return readStored('berth.sidebarView')==='git'?'git':'files';
  });
  useEffect(()=>{if(!sshWindow)saveStored('berth.rightSidebarCollapsed',String(rightSidebarCollapsed));},[rightSidebarCollapsed,sshWindow]);
  useEffect(()=>{if(!sshWindow)saveStored('berth.rightSidebarView',rightSidebarView);},[rightSidebarView,sshWindow]);
  const [fileTreeHost, setFileTreeHost] = useState<HTMLDivElement | null>(null);
  const [filePreviewHost, setFilePreviewHost] = useState<HTMLDivElement | null>(null);
  const [filesActivated, setFilesActivated] = useState(()=>rightSidebarView==='files'&&!rightSidebarCollapsed);
  const [fileTarget, setFileTarget] = useState<{ projectId: string; query: string; nonce: number } | null>(null);
  const fileTargetSequence = useRef(0);
  const consumeFileTarget = useCallback((nonce: number) => setFileTarget(current => current?.nonce === nonce ? null : current), []);
  useEffect(() => { setFileTarget(current => current?.projectId === projectId ? current : null); }, [projectId, fileTarget?.projectId]);
  const [gitPreview, setGitPreview] = useState<GitDiffRequest | null>(null);
  const openPreview = useCallback(() => { setExtensionView(null);setPage('workspace');setGitPreview(null);setTab('preview'); }, []);
  const openDiff = useCallback((path: string, staged: boolean, projectPath = false) => { setExtensionView(null);setPage('workspace');setFilesActivated(true);setTab('preview');setGitPreview({ projectId, worktreePath: selectedWorktreePath, path, staged, projectPath }); }, [projectId, selectedWorktreePath]);
  const openGit = (value: Project) => { setExtensionView(null);setRightSidebarView('git');setRightSidebarCollapsed(false);if (value.id !== projectId) setSelectedWorktreePath(null);setProjectId(value.id);setPage('workspace'); };
  useEffect(() => { setGitPreview(null); }, [projectId]);
  const openPath = useCallback((query: string) => { setExtensionView(null);setRightSidebarView('files');setRightSidebarCollapsed(false);setPage('workspace');setFilesActivated(true);setFileTarget({ projectId, query, nonce: ++fileTargetSequence.current }); }, [projectId]);
  const [page, setPage] = useState<'workspace' | 'settings' | 'plugins'>('workspace');
  const [pluginTab,setPluginTab] = useState<PluginCenterTab>(()=>readStored('berth.pluginTab')==='agents'?'agents':'installed');
  const [requestedPlugin,setRequestedPlugin]=useState<string|null>(null);
  // In-page plugin config: opened from an extension view's 设置 button. Plugins
  // with embedded settings views (or no config fields) keep the plugin center flow.
  const [pluginSettingsRequest,setPluginSettingsRequest]=useState<{pluginId:string;isAgent:boolean}|null>(null);
  // Global type scale: uiFontScale multiplies every --fs-* token in tokens.css.
  useEffect(()=>{const scale=state.settings.uiFontScale;document.documentElement.style.setProperty('--ui-font-scale',String(typeof scale==='number'&&scale>=0.85&&scale<=1.3?scale:1));},[state.settings.uiFontScale]);
  useEffect(()=>{if(!sshWindow)saveStored('berth.pluginTab',pluginTab);},[pluginTab,sshWindow]);
  const openPlugins = (tab?:PluginCenterTab)=>{if(tab)setPluginTab(tab);setPage('plugins');setError('');};
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState(loadCollapsedProjects);
  const [searchCollapsed,setSearchCollapsed]=useState<string[]|null>(null);
  const deferredSearch = useDeferredValue(search);
  const treeSearching=!!deferredSearch.trim()||filter!=='all';
  useEffect(()=>setSearchCollapsed(null),[deferredSearch,filter]);
  const [tab, setTab] = useState<'terminal' | 'history' | 'runs' | 'preview'>('terminal');
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [forceTerminalFocus,setForceTerminalFocus]=useState(false);
  const [modalRequest, setModalRequest] = useState<ModalRequest | null>(null);
  const modal = modalRequest?.kind ?? null;
  const modalTarget = modalRequest?.target ?? null;
  const modalToken = useRef(0);
  const [treeMenu, setTreeMenu] = useState<TreeMenuTarget | null>(null);
  const closeTreeMenu = useCallback(() => setTreeMenu(null), []);
  const [busy, setBusy] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>({});
  const [statusOpen, setStatusOpen] = useState(false);
  const [error, setError] = useState('');
  // Actionable notices (undo / retry) keep their own slot so a later plain
  // success message cannot swallow the user's only chance to reverse a delete.
  const [notices, setNotices] = useState<Notice[]>([]);
  const notify = useCallback((text: string, action?: ToastAction) => setNotices(list => pushNotice(list, text, action)), []);
  const closeNotice = useCallback((id: number) => setNotices(list => dismissNotice(list, id)), []);
  const [dismissedRecovery, setDismissedRecovery] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(loadSettingsDraft);
  const remembered = useRef(loadSelections());
  const opener = useRef<HTMLElement | null>(null);
  const [sshOpen,setSshOpen]=useState(()=>sshWindow||readStored('berth.sshOpen')==='true');
  const [sshSessionId,setSshSessionId]=useState(()=>readStored('berth.sshSession')??'');
  const [sshWindowState,setSshWindowState]=useState<SshWindowState>({detached:sshWindow,sessionId:''});
  const [sshWindowReady,setSshWindowReady]=useState(false);
  const changeSshWindow=(action:'open'|'dock'|'select',id=sshSessionId)=>window.berth.sshWindow(action,id);
  const selectSsh=(id:string)=>{setSshSessionId(id);if(sshWindow)void changeSshWindow('select',id).catch(reason=>setError(String(reason)));};
  const openSavedSsh=async(alias:string)=>{const result=await window.berth.openSshConnection(alias);selectSsh(result.sessionId);setSshOpen(true);setPage('workspace');notify('SSH 终端已打开');return result;};
  const startSsh=(id:string)=>window.berth.rpc('start',{sessionId:id,resume:false,cols:100,rows:30});
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
  const [viewingRun, setViewingRun] = useState<{ sessionId: string; runId: string } | null>(null);
  const selectedSessionRef = useRef(sessionId); selectedSessionRef.current = sessionId;
  // Bumped when a dialog links a native session or an undo restores run rows.
  const [insightsRevision, setInsightsRevision] = useState(0);
  const outputRunId = viewingRun?.sessionId === sessionId ? viewingRun.runId : null;
  const agentNames = useMemo(() => agentLabels(state.agents), [state.agents]);
  const project = workspaceProjects.find(item => item.id === projectId);
  const sidebarSessions = useMemo(()=>{const groups=new Map<string,Session[]>();for(const session of state.sessions)if(!session.remote&&!session.owner){const group=groups.get(session.projectId)??[];group.push(session);groups.set(session.projectId,group);}return [...groups].flatMap(([id,sessions])=>orderSidebarItems(sessions,sidebarOrder.sessions[id]??[]));},[state.sessions,sidebarOrder.sessions]);
  const projectSessions = useMemo(() => state.sessions.filter(item => item.projectId === projectId && !item.remote&&!item.owner), [state.sessions, projectId]);
  const session = projectSessions.find(item => item.id === sessionId);
  useEffect(() => { setSelectedWorktreePath(session?.worktreePath ?? null); }, [session?.id, session?.worktreePath]);
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
  const acpSession=!!sessionDefinition?.acp;
  const sessionAgentEnabled=!!session&&(!['codex','claude','opencode'].includes(session.agent)||extensionEnabled(state.extensions,'agent.'+session.agent))&&(!session.agent.startsWith('agent:')||!!sessionDefinition);
  const canHistory = !acpSession && sessionAgentEnabled && !!session && (['codex', 'claude', 'opencode'].includes(session.agent) || !!sessionDefinition?.integration || !!sessionDefinition?.plugin?.history);
  const canResume = !acpSession && sessionAgentEnabled && !!session && (['codex', 'claude', 'opencode'].includes(session.agent) || !!sessionDefinition?.resumeCommand || !!sessionDefinition?.plugin?.resume);
  const recordOutput = session?.agent === 'shell';
  useEffect(() => { setViewingRun(null); if ((tab === 'runs' && !recordOutput) || (tab === 'history' && !canHistory && !canResume && !sessionDefinition?.plugin?.list)) setTab('terminal'); }, [sessionId, session?.agent, canHistory, canResume, sessionDefinition?.plugin?.list]);
  const running = useMemo(() => state.sessions.filter(active).length, [state.sessions]);
  const sshRunning = useMemo(() => state.sessions.filter(item => !!item.remote && active(item)).length, [state.sessions]);
  const windowsPty = useMemo(() => state.windowsPty, [state.windowsPty?.backend, state.windowsPty?.buildNumber]);
  const manageDisabled = !connected || !features.workspace;
  const draftDirty = !!settingsDraft && JSON.stringify(settingsDraft.value) !== JSON.stringify(state.settings);
  const draftConflict = draftDirty && JSON.stringify(settingsDraft?.base) !== JSON.stringify(state.settings);

  useEffect(() => {
    if (!window.berth) { setLoading(false); setError('请通过 AgentBerth 桌面应用打开工作台'); return; }
    const off = window.berth.onEvent(event => {
      if (event.event === 'state') { publishWorkspaceState(event.data); setHasLoadedState(true); setLoading(false); }
      if (event.event === 'connection') { setConnected(event.data.connected); if (event.data.connected) { setConnectionEpoch(n => n + 1); setError(''); } if (event.data.error) setError(event.data.error); }
    });
    void window.berth.rpc<State>('state').then(value => { publishWorkspaceState(value); setConnected(true); setHasLoadedState(true); setLoading(false); setError(''); }).catch(reason => { setError(String(reason)); setLoading(false); });
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
  useEffect(() => { if(sshWindow)return;saveStored('berth.project', projectId); }, [projectId]);
  useEffect(() => { if(sshWindow)return;saveStored('berth.session', sessionId); setTerminalVisible(true); }, [sessionId]);

  useEffect(() => { if (!sshWindow&&!loading) saveStored('berth.settingsDraft', draftDirty ? JSON.stringify(settingsDraft) : null); }, [settingsDraft, state.settings, loading]);
  useEffect(() => { if (!loading && settingsDraft && !draftDirty) setSettingsDraft(null); }, [settingsDraft, draftDirty, loading]);
  async function perform<T>(method: Method, params: Record<string, unknown>, scope?: string): Promise<T | undefined> {
    if (scope) setPendingActions(previous => ({ ...previous, [scope]: true })); else setBusy(true);
    // Notices manage their own lifetime now: an undo receipt must survive a
    // subsequent unrelated RPC, and plain messages replace each other.
    setError('');
    try { return await window.berth.rpc<T>(method, params); }
    catch (reason) { setError(String(reason)); return undefined; }
    finally {
      if (scope) setPendingActions(previous => { const next = { ...previous }; delete next[scope]; return next; });
      else setBusy(false);
    }
  }
  const reorderSidebar=useCallback((move:SidebarMove)=>{
    const snapshot=getWorkspaceState();
    const current=move.kind==='project'?snapshot.projects.filter(project=>!project.remoteWorkspace).map(project=>project.id):snapshot.sessions.filter(session=>!session.remote&&!session.owner&&session.projectId===move.projectId).map(session=>session.id);
    if(!current.includes(move.id)||!current.includes(move.targetId))return;
    setSidebarOrder(previous=>{
      const saved=move.kind==='project'?previous.projects:previous.sessions[move.projectId!]??[],full=completeSidebarOrder(current,saved),next=moveSidebarItem(current,saved,move.id,move.targetId,move.edge);
      if(next.every((id,index)=>id===full[index]))return previous;
      return move.kind==='project'?{...previous,projects:next}:{...previous,sessions:{...previous.sessions,[move.projectId!]:next}};
    });
  },[]);
  useEffect(()=>{if(!sshWindow&&!loading)setSidebarOrder(previous=>reconcileSidebarOrder(previous,state.projects.filter(project=>!project.remoteWorkspace).map(project=>project.id),state.sessions.filter(session=>!session.remote&&!session.owner)));},[state.projects,state.sessions,loading,sshWindow]);
  useEffect(()=>{if(!sshWindow&&!loading)saveStored('berth.sidebarOrder',JSON.stringify(sidebarOrder));},[sidebarOrder,loading,sshWindow]);
  const expandProject = useCallback((id: string) => {setCollapsed(previous => previous.includes(id) ? previous.filter(item => item !== id) : previous);setSearchCollapsed(previous=>previous?.filter(item=>item!==id)??null);}, []);
  const selectProject = useCallback((id: string) => { setExtensionView(null); setProjectId(id); setSelectedWorktreePath(null); setSearch(''); setFilter('all'); setPage('workspace'); setError(''); expandProject(id); }, [expandProject]);
  const selectSession = useCallback((projectId: string, sessionId: string, withinFeature=false) => { const target=getWorkspaceState().sessions.find(item=>item.id===sessionId);if(target?.owner){setPage('workspace');setExtensionView(previous=>withinFeature&&previous?.pluginId===target.owner!.pluginId?{...previous,sessionId:target.id}:{pluginId:target.owner!.pluginId,viewId:'tasks',taskId:target.owner!.taskId,sessionId:target.id});return;}setExtensionView(null); setSelectedWorktreePath(target?.worktreePath ?? null); if(target?.remote){selectSsh(sessionId);setSshOpen(true);setPage('workspace');return;} setProjectId(projectId); setSessionId(sessionId); setPage('workspace'); setTab('terminal'); setError(''); expandProject(projectId); }, [expandProject]);
  useEffect(()=>{const open=(event:Event)=>{const detail=(event as CustomEvent<{pluginId:string;isAgent:boolean}>).detail;if(!detail?.pluginId)return;
    const plugin=state.extensions?.plugins.find(item=>item.manifest.id===detail.pluginId);
    // Agent-facing plugins (Superagent and its custom variants) carry source
    // development tools and embedded settings views that only the full dialog
    // can host. Keep that flow; plain config-only plugins use the light popover.
    const fullDialog=detail.isAgent||!!plugin?.manifest.dependencies.includes('agents')||!!plugin?.manifest.views.some(view=>view.location==='settings');
    const popover=plugin&&plugin.installed&&!fullDialog&&(Object.keys(plugin.manifest.config).length>0||plugin.manifest.id==='pet');
    if(popover){setPluginSettingsRequest(detail);return;}
    setPluginTab(detail.isAgent?'agents':'installed');setRequestedPlugin(detail.pluginId);setPage('plugins');setError('');};
    window.addEventListener('berth:plugin-settings',open);return()=>window.removeEventListener('berth:plugin-settings',open);},[state.extensions]);
  useEffect(()=>{const open=(event:Event)=>{const id=(event as CustomEvent<{sessionId:string;pluginId?:string}>).detail?.sessionId,target=state.sessions.find(session=>session.id===id);if(target)selectSession(target.projectId,target.id,(event as CustomEvent).detail.pluginId===target.owner?.pluginId);else setError('会话尚未创建或已删除');};window.addEventListener('berth:open-session',open);return()=>window.removeEventListener('berth:open-session',open);},[selectSession,state.sessions]);
  useEffect(() => {
    if (sshWindow) return;
    return window.berth.onPetSession(id => {
      const target = state.sessions.find(session => session.id === id);
      if (target) selectSession(target.projectId, id);
      else {const activity=state.agentActivities?.find(value=>value.id===id);if(activity?.pluginId&&activity.taskId){setPage('workspace');setExtensionView({pluginId:activity.pluginId,viewId:'tasks',taskId:activity.taskId});}}
    });
  }, [sshWindow, state.sessions,state.agentActivities, selectSession]);
  useEffect(() => {
    if (sshWindow) return;
    return window.berth.onPetSettings(() => { setPluginTab('installed'); setRequestedPlugin('pet'); setPage('plugins'); setError(''); });
  }, [sshWindow]);
  const toggleProject = useCallback((id: string) => setCollapsed(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]), []);
  useEffect(() => { if (!sshWindow&&!loading) saveStored('berth.collapsedProjects', JSON.stringify(collapsed.filter(id => workspaceProjects.some(project => project.id === id)))); }, [collapsed, workspaceProjects, loading]);
  useEffect(() => {
    if (!statusOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.('.status-summary, .status-popover')) setStatusOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [statusOpen]);
  function openModal(kind: Modal, target: ModalTarget = null, initial: ModalInitial = {}) {
    if (!quickOpen) opener.current = document.activeElement as HTMLElement | null;
    setError('');
    setModalRequest({ kind, target, initial, token: ++modalToken.current });
  }
  function clearFilter() { setSearch(''); setFilter('all'); }
  function newProject() { openModal('project', null, { project: { name: '', folder: '' } }); }
  function editProject(value = project) { if (!value) return; openModal('editProject', { projectId: value.id }, { project: { name: value.name, folder: value.path } }); }
  function openProjectFolder(value: Project) { void window.berth.openProject(value.path).catch(reason => setError(String(reason))); }
  function sessionForm(value: Partial<SessionFormValues> & Pick<SessionFormValues, 'title' | 'agent' | 'command' | 'terminal' | 'startNow'>, editing = false, target: ModalTarget = null) {
    const form: SessionFormValues = { ...value, remote: value.remote ?? null, worktreePath: value.worktreePath ?? null, service: !!value.service };
    openModal(form.remote ? editing ? 'editSshSession' : 'sshSession' : editing ? 'editSession' : 'session', target, { session: form });
  }
  function newSession(id = projectId, selectedPath: string | null = id === projectId ? selectedWorktreePath : null) { const selected=state.settings.defaultAgent;const fallback=selected==='custom'||['codex','claude','opencode'].includes(selected)&&!extensionEnabled(state.extensions,'agent.'+selected)||selected.startsWith('agent:')&&!state.agents?.some(item=>item.id===selected&&(item.acp||item.sourceId?.startsWith('ext.')));sessionForm({ title: '', agent: fallback?'shell':selected, command: state.settings.defaultAgent === 'custom' ? state.settings.defaultCommand : state.agents?.find(item => item.id === state.settings.defaultAgent)?.command ?? '', terminal: null, startNow: true, worktreePath: selectedPath }, false, { projectId: id }); }
  function newSshSession() { sessionForm({title:'', agent:'shell', command:'', terminal:null, startNow:true, remote:{host:'',directory:''}}); }
  function editSession(value = session) { if (value) sessionForm({ title: value.title, agent: value.agent, command: value.command, terminal: value.terminal, startNow: false, remote: value.remote ?? null, worktreePath: value.worktreePath ?? null, service:value.service }, true, { projectId: value.projectId, sessionId: value.id }); }
  function copySession(value = session) { if (value) sessionForm({ title: value.title.slice(0, 90) + ' · 副本', agent: value.agent, command: value.command, terminal: value.terminal, startNow: false, remote: value.remote ?? null, worktreePath: value.worktreePath ?? null, service:value.service }, false, { projectId: value.projectId }); }
  function openLink() { openModal('link', null, { value: session?.nativeSessionId ?? '' }); }
  function openQuick() { opener.current = document.activeElement as HTMLElement | null; setQuickOpen(true); }
  function openShortcuts() { if (!quickOpen) opener.current = document.activeElement as HTMLElement | null; setQuickOpen(false); setShortcutsOpen(true); }
  function chooseTarget(target: SwitchTarget) {
    setQuickOpen(false);
    if (target.kind === 'action') { if (target.action === 'settings') { setPage('settings'); setError(''); } else if (target.action === 'project') newProject(); else if (target.action === 'shortcuts') openShortcuts(); else newSession(); return; }
    if(target.sessionId)selectSession(target.projectId!,target.sessionId);else selectProject(target.projectId!);setTab('terminal');
  }
  async function copyText(text: string, label: string) { try { await window.berth.copyText(text); notify(label + '已复制'); } catch (reason) { setError(String(reason)); } }
  function cycleSession(previous: boolean) {
    if (!project) return;
    const visible = projectSessions.filter(item => matchesSession(item, project, deferredSearch, filter, agentNames));
    if (!visible.length) { notify('当前筛选下没有可切换的会话'); return; }
    const index = visible.findIndex(item => item.id === sessionId);
    const next = visible[index < 0 ? previous ? visible.length - 1 : 0 : (index + (previous ? -1 : 1) + visible.length) % visible.length];
    if (next.id !== sessionId) (document.activeElement as HTMLElement | null)?.blur();
    // The Git panel now lives beside the terminal. Keep the focus request alive
    // until xterm has attached and actually focused the newly selected PTY.
    const agent=state.agents?.find(item=>item.id===next.agent);
    setForceTerminalFocus(connected&&next.latestRun?.status==='running'&&!next.service&&!agent?.acp);
    selectSession(project.id,next.id);setTerminalVisible(true);
  }
  const shortcuts = useRef({ modal, busy, quickOpen, manageDisabled, project, page, features, newProject, newSession, openQuick, openShortcuts, cycleSession });
  shortcuts.current = { modal, busy, quickOpen, manageDisabled, project, page, features, newProject, newSession, openQuick, openShortcuts, cycleSession };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if(sshWindow)return;
      const current = shortcuts.current;
      if (event.isComposing || event.getModifierState('AltGraph') || current.modal || document.querySelector('[role="dialog"], [role="menu"]') || current.busy || !(event.ctrlKey || event.metaKey)) return;
      const value = event.key.toLowerCase();
      if(value==='b'&&!event.shiftKey&&!event.altKey){if((event.target as HTMLElement)?.closest?.('.terminal-surface'))return;event.preventDefault();event.stopPropagation();document.querySelector<HTMLButtonElement>('.activity-bar button[aria-label*="侧栏"]')?.focus();setSidebarCollapsed(value=>!value);}
      else if (value === '/' && !event.shiftKey && !event.altKey) { if ((event.target as HTMLElement)?.closest?.('.terminal-surface')) return; event.preventDefault(); event.stopPropagation(); current.openShortcuts(); }
      else if (value === 'p' && event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (current.quickOpen) setQuickOpen(false); else current.openQuick(); }
      else if (value === 'e' && event.shiftKey && !event.altKey && current.project && current.features.files) { event.preventDefault(); event.stopPropagation(); setRightSidebarView('files');setRightSidebarCollapsed(false);setFilesActivated(true);setPage('workspace'); }
      else if (value === 'g' && event.shiftKey && !event.altKey && current.project && current.features.git) { event.preventDefault(); event.stopPropagation(); setRightSidebarView('git');setRightSidebarCollapsed(false);setPage('workspace'); }
      else if (value === ',' && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); setQuickOpen(false); setPage('settings'); setError(''); }
      else if ((value === 'n' || value === 'o') && event.shiftKey && !event.altKey && !current.manageDisabled && !current.quickOpen) { event.preventDefault(); event.stopPropagation(); if (value === 'o') current.newProject(); else if (current.project) current.newSession(); else notify('请先添加一个项目'); }
      else if (value === 'tab' && !event.altKey && !current.quickOpen && current.page === 'workspace') { event.preventDefault(); event.stopPropagation(); current.cycleSession(event.shiftKey); }
    };
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true);
  }, []);
  async function submitProject(values: ProjectFormValues) {
    const result = await perform<Project>(modal === 'editProject' ? 'updateProject' : 'createProject', { ...(modal === 'editProject' ? { projectId: actionProject!.id } : {}), name: values.name.trim() || values.folder.split(/[\\/]/).filter(Boolean).at(-1) || '项目', path: values.folder });
    if (result) { if (modal === 'project') selectProject(result.id); setModalRequest(null); }
  }
  async function submitSession(values: SessionFormValues) {
    const { title, agent, command, terminal, remote, worktreePath, service, startNow } = values;
    const editing = modal === 'editSession' || modal === 'editSshSession';
    const sessionTitle = title.trim() || nextSessionTitle(remote ? 'SSH' : agentNames[agent], (remote ? state.sessions.filter(item=>item.remote) : actionProjectSessions).map(item=>item.title));
    const result = await perform<Session>(editing ? 'updateSession' : remote ? 'createRemoteSession' : 'createSession', remote && !editing
      ? {title:sessionTitle, remote}
      : { ...(editing ? {sessionId:actionSession!.id} : {projectId:actionProject!.id}), title:sessionTitle, agent:remote?'shell':agent, ...(state.apiVersion>=51?{service:!remote&&agent==='shell'&&service}:{}), command:remote?'':isCustomAgent(agent)||agent==='shell'&&service?command:'', terminal:remote?null:terminal, remote, worktreePath:remote?null:worktreePath });
    if (result) { if (!editing) { if(result.remote){selectSsh(result.id);setSshOpen(true);}else selectSession(result.projectId, result.id); setSearch(''); setFilter('all'); } setModalRequest(null); if (!editing && startNow) await perform('start', { sessionId: result.id, resume: false, cols: 100, rows: 30 }); }
  }
  async function submitRename(kind: 'renameSession' | 'renameProject', value: string) {
    const result = kind === 'renameSession'
      ? await perform('renameSession', { sessionId: actionSession!.id, title: value })
      : await perform('updateProject', { projectId: actionProject!.id, name: value, path: actionProject!.path });
    if (result !== undefined) setModalRequest(null);
  }
  async function submitLink(value: string) {
    const result = await perform<History>('linkNativeSession', { sessionId, nativeSessionId: value });
    if (result !== undefined) { setModalRequest(null); setInsightsRevision(revision => revision + 1); }
  }
  async function restartBackend() {
    setBusy(true); setError('');
    try { await window.berth.restartBackend(); setModalRequest(null); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const menuItems: MenuItem[] = [];
  const menuProject = treeMenu?.kind === 'project' ? state.projects.find(item => item.id === treeMenu.id) : undefined;
  const menuSession = treeMenu?.kind === 'session' ? state.sessions.find(item => item.id === treeMenu.id) : undefined;
  const menuModal = (kind: Modal, target: ModalTarget, initial: ModalInitial = {}) => { openModal(kind, target, initial); opener.current = treeMenu!.opener; };
  if (menuProject) {
    const value = menuProject, target = { projectId: value.id }, hasRunning = state.sessions.some(item => item.projectId === value.id && active(item));
    menuItems.push(
      { label: '新建会话', disabled: manageDisabled, action: () => { newSession(value.id); opener.current = treeMenu!.opener; } },
      { label: '重命名项目', disabled: manageDisabled, action: () => menuModal('renameProject', target, { value: value.name }) },
      { label: '编辑项目', disabled: manageDisabled, action: () => { editProject(value); opener.current = treeMenu!.opener; } },
      { label: '在文件管理器中打开', separator: true, action: () => openProjectFolder(value) },
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
      { label: '重命名会话', disabled: manageDisabled, action: () => menuModal('renameSession', target, { value: value.title }) },
      { label: '编辑会话', disabled: manageDisabled, action: () => { editSession(value); opener.current = treeMenu!.opener; } },
      { label: '复制会话', disabled: manageDisabled || (!!value.remote && state.apiVersion<24), action: () => { copySession(value); opener.current = treeMenu!.opener; } },
      ...(value.service&&active(value)?[{label:'重启服务',disabled:manageDisabled||value.latestRun?.status==='stopping',action:()=>void perform('serviceAction',{sessionId:value.id,action:'restart',cols:100,rows:30})}]:[]),
      active(value) ? { label: value.service?'停止服务':definition?.acp?'断开 Agent':'停止终端', separator: true, disabled: manageDisabled || value.latestRun?.status === 'stopping', action: () => menuModal('stop', target) }
        : { label: value.service?'启动服务':definition?.acp?'连接 Agent':'启动终端', separator: true, disabled: manageDisabled, action: () => { selectSession(value.projectId, value.id); void perform('start', { sessionId: value.id, resume: false, cols: 100, rows: 30 }, 'start:' + value.id); } },
      ...(resumable && value.nativeSessionId && !active(value) ? [{ label: '恢复原生会话', disabled: manageDisabled, action: () => { selectSession(value.projectId, value.id); void perform('start', { sessionId: value.id, resume: true, cols: 100, rows: 30 }); } }] : []),
      { label: '删除会话', separator: true, danger: true, disabled: manageDisabled || active(value), hint: active(value) ? '请先停止此终端' : undefined, action: () => menuModal('deleteSession', target) },
    );
  }
  const closeModal = () => { setModalRequest(null); setError(''); };
  // The daemon may broadcast the restored rows before the RPC reply arrives,
  // or just after it. Read the module store (not the last render) and try on
  // both paths, so the selection effect never races an outdated snapshot.
  const pendingRestore = useRef<{ projectId: string; sessionId?: string } | null>(null);
  const applyRestore = useStableCallback((target: { projectId: string; sessionId?: string }) => {
    if (loading || sshWindow) return;
    const current = getWorkspaceState();
    if (target.sessionId) {
      if (!current.sessions.some(item => item.id === target.sessionId)) return;
      pendingRestore.current = null;
      selectSession(target.projectId, target.sessionId);
    } else {
      if (!current.projects.some(item => item.id === target.projectId)) return;
      pendingRestore.current = null;
      selectProject(target.projectId);
    }
  });
  useEffect(() => {
    const target = pendingRestore.current;
    if (target) applyRestore(target);
  }, [state.sessions, state.projects, applyRestore]);

  const deletedRunViews = useRef<Record<string, string>>({});
  function handleDeleted(undo: DeletionUndo | null, label: string, previousRunId?: string | null) {
    if (!undo) { notify(`已删除「${label}」`); return; }
    if (previousRunId && undo.kind === 'runs' && undo.runIds?.includes(previousRunId)) deletedRunViews.current[undo.token] = previousRunId;
    notify(`已删除「${label}」`, { label: '撤销', onAction: () => void undoDelete(undo) });
  }
  async function undoDelete(undo: DeletionUndo) {
    setBusy(true);
    try {
      const result = await window.berth.rpc<DeletionUndo>('restoreDeleted', { token: undo.token });
      notify(`已恢复「${result.label}」`);
      if (result.kind === 'runs') {
        setInsightsRevision(value => value + 1);
        // Reopen the exact output that was open before the delete. A batch
        // clear from the list stays on the list, and undo never hijacks the
        // user's current tab. Only discard the entry after a successful restore.
        const previous = deletedRunViews.current[undo.token];
        if (previous && result.runIds?.includes(previous) && result.sessionId && selectedSessionRef.current === result.sessionId)
          setViewingRun({ sessionId: result.sessionId, runId: previous });
        delete deletedRunViews.current[undo.token];
      } else {
        const target = { projectId: result.projectId, sessionId: result.sessionId };
        pendingRestore.current = target;
        applyRestore(target);
      }
    } catch (reason) {
      const detail = String(reason).replace(/^Error:\s*/, '').replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '').trim();
      // Keep a retry affordance: a stale receipt should not strand the user.
      notify(`未能恢复「${undo.label}」：${detail}`, { label: '重试', onAction: () => void undoDelete(undo) });
    } finally { setBusy(false); }
  }
  // Local UI state (search, toasts) changes on every keystroke.
  // These bridges keep the callbacks referentially stable so memoized subtrees
  // only rerender when their own inputs change; the ref always points at the
  // latest handlers, so behavior is unchanged.
  const stableNewSession = useStableCallback(newSession);
  const stableOpenFolder = useStableCallback(openProjectFolder);
  const stableClearFilter = useStableCallback(clearFilter);
  const stableToggle = useStableCallback((id: string) => {
    if (treeSearching) setSearchCollapsed(previous => (previous ?? []).includes(id) ? (previous ?? []).filter(value => value !== id) : [...(previous ?? []), id]);
    else toggleProject(id);
  });
  // Clicking an already-selected extension icon toggles the sidebar, like the
  // collapse button. The Sessions icon carries aria-pressed (it selects a
  // view), so clicking it repeatedly must always return to the session list
  // with the sidebar open rather than collapsing it.
  const stableSelectView = useStableCallback((pluginId: string, viewId: string) => {
    if (page === 'workspace' && extensionView?.pluginId === pluginId && extensionView.viewId === viewId) { setSidebarCollapsed(value => !value); return; }
    setExtensionView({ pluginId, viewId }); setPage('workspace'); setSidebarCollapsed(false);
  });
  const stableOpenPlugins = useStableCallback(() => openPlugins());

  return <ExtensionsContext.Provider value={state.extensions}><div className={sshWindow?"ssh-window app":"app"}>
    {!sshWindow&&<><ResourceMonitor enabled={features.resources && connected && state.apiVersion >= API_VERSION} />
    <ActivityBar snapshot={state.extensions} activities={state.agentActivities} sessionUnread={localUnread} selected={page==='workspace'?extensionView:null} sessionSelected={page==='workspace'&&!extensionView} sidebarCollapsed={sidebarCollapsed} draftDirty={draftDirty} appearance={features.appearance?<AppearanceToggle/>:undefined} onSessions={()=>{setExtensionView(null);setPage('workspace');setSidebarCollapsed(false);}} onToggleSidebar={()=>setSidebarCollapsed(value=>!value)} onSelect={stableSelectView} onManage={stableOpenPlugins} onSettings={()=>{setPage('settings');setError('');}} />
    <ResizableSidebar collapsed={sidebarCollapsed} side="left">
      <div id="sidebar-content" className="sidebar-content" hidden={sidebarCollapsed}>
        <div className="brand"><img className="brand-mark" src={appIcon} alt="" /><div><strong>AgentBerth</strong><small>泊栈 · 项目开发工作台</small></div></div>
        <button className="quick-link" onClick={openQuick} title="Ctrl+Shift+P">快速切换<kbd>Ctrl+Shift+P</kbd></button>
      <div id="sidebar-panel-sessions" className="sidebar-panel" aria-label="会话管理">
      <div className="sidebar-heading"><span>项目与会话</span><div className="tree-actions"><button type="button" className="icon-button" aria-label="全部展开" title="全部展开" disabled={!workspaceProjects.length} onClick={()=>{setCollapsed([]);setSearchCollapsed([]);}}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 3 4 3 4-3M4 9l4 3 4-3"/></svg></button><button type="button" className="icon-button" aria-label="全部折叠" title="全部折叠" disabled={!workspaceProjects.length} onClick={()=>{const ids=workspaceProjects.map(project=>project.id);setCollapsed(ids);setSearchCollapsed(ids);}}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4-3 4 3M4 12l4-3 4 3"/></svg></button><button className="icon-button" aria-label="添加项目" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" /></button></div></div>
      {workspaceProjects.length > 0 && <div className="tree-search"><input className="search" placeholder="搜索项目、会话或目录…" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索项目和会话" /><select className="session-filter" aria-label="筛选会话" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部会话</option><option value="active">运行中</option><option value="inactive">未运行</option>{Object.entries(agentNames).filter(([value])=>value==='shell'||value!=='custom'&&features.agents&&(!['codex','claude','opencode'].includes(value)||extensionEnabled(state.extensions,'agent.'+value))).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{(search || filter !== 'all') && <button className="clear-filter" onClick={clearFilter}>清除筛选</button>}</div>}
      <ProjectTree unread={unread} projects={workspaceProjects} sessions={sidebarSessions} projectId={page === 'workspace' ? projectId : ''} sessionId={page === 'workspace' ? sessionId : ''} collapsed={treeSearching?(searchCollapsed??[]):collapsed} query={deferredSearch} filter={filter} names={agentNames} disabled={manageDisabled} onToggle={stableToggle} onProject={selectProject} onSession={selectSession} onNewSession={stableNewSession} onOpenFolder={stableOpenFolder} onMenu={setTreeMenu} onMove={reorderSidebar} onClearFilter={stableClearFilter} />
      </div>
        <div className="workspace-resources"><span>工作台</span><ResourceBadge scope="workspace" full /><ResourceBadge scope="application" id="deepseek-harness" /></div>
        <div className="sidebar-bottom"><span className={'dot '+(connected?'live':'')} /><span role="status">{connected ? '后台已连接' : '后台未连接'}</span><button className="text-button" disabled={busy} onClick={() => void window.berth?.reconnect().catch(reason => setError(String(reason)))}>重连</button></div>
      </div>
    </ResizableSidebar>

    <main className={extensionView&&page==='workspace'?'main extension-active':'main'}>
      {(busy || Object.keys(pendingActions).length > 0) && <div className="action-progress" role="progressbar" aria-label="正在处理" />}
      <header className="topbar workbench-header" data-session-id={page==='workspace'&&!extensionView?session?.id:undefined} aria-label="工作区信息">
        <div className="workbench-identity">{page==='workspace'&&extensionView&&selectedExtension?<h1>{selectedExtension.manifest.views.find(v=>v.id===extensionView.viewId)?.title}</h1>:page==='workspace'&&project?<><h1 className="project-name" title={project.name+'\n'+(selectedWorktreePath??project.path)}>{project.name}</h1><span className="workbench-separator" aria-hidden="true">/</span><h2 className="workbench-session-title" title={session?session.title+' · '+(session.service?'服务终端':agentNames[session.agent]):undefined}>{tab==='preview'?'文件预览':session?.title??'项目工作区'}</h2>{session&&tab!=='preview'&&<span className={`badge ${active(session)?'live-badge':''}`}>{statusNames[session.latestRun?.status??'']??'待启动'}</span>}</>:<span className="workbench-page-title">AgentBerth</span>}</div>
        <div className="topbar-status">{features.ssh&&state.apiVersion>=21&&<button type="button" className={`subtle ssh-toggle${!sshWindowState.detached&&sshOpen&&page==='workspace'?' selected':''}`} aria-label={sshRunning>0?`SSH 面板，${sshRunning} 个连接`:'SSH 面板'} aria-expanded={!sshWindowState.detached&&sshOpen&&page==='workspace'} aria-controls="ssh-workspace-dock" onClick={()=>{if(sshWindowState.detached){void changeSshWindow('open').catch(reason=>setError(String(reason)));return;}setSshOpen(previous=>page!=='workspace'||!previous);setPage('workspace');}} title={sshWindowState.detached?'SSH 已在独立窗口中，点击前往':sshRunning>0?`${sshRunning} 个 SSH 连接正在运行`:undefined}>SSH{sshUnread&&<OutputBadge />}{sshRunning>0&&<span className="ssh-count" aria-hidden="true">{sshRunning}</span>}</button>}{features.git && page === 'workspace' && !extensionView && project && <GitBranch key={`${project.id}:${project.path}:${selectedWorktreePath ?? 'main'}`} project={project} enabled={connected && state.apiVersion >= 13} worktreePath={selectedWorktreePath} onOpen={() => openGit(project)} />}<button type="button" className={`status-summary${statusOpen ? ' selected' : ''}`} aria-label={`运行状态详情 · 本机终端 ${running-sshRunning} / ${state.maxActiveTerminals}`} aria-expanded={statusOpen} onClick={() => setStatusOpen(value => !value)}><span className={`dot ${connected ? 'live' : ''}`} /><span className="status-label">本机</span><span>{state.apiVersion>=27?`${running-sshRunning} / ${state.maxActiveTerminals}`:`${running} 个终端`}</span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></button><div className="status-popover" hidden={!statusOpen} role="group" aria-label="运行状态详情"><div className="status-detail"><span>SSH 连接</span><strong>{sshRunning} / {state.maxSshTerminals}</strong></div><div className="status-detail"><span>后台服务</span><strong>{connected ? '已连接' : '未连接'}</strong></div>{page==='workspace'&&!extensionView&&session&&active(session)&&<div className="status-detail"><span>当前会话</span><ResourceBadge scope="session" id={session.id} runId={session.latestRun?.id} full/></div>}<div className="status-detail"><span>偏好与更多</span><button type="button" className="text-button" onClick={() => { setStatusOpen(false); setPage('settings'); }}>打开设置</button></div></div>{page==='workspace'&&extensionView&&<button type="button" className="icon-button" aria-label="关闭插件视图" title="关闭插件视图" onClick={()=>setExtensionView(null)}>×</button>}</div>
      </header>
      {extensionView&&selectedExtension&&page==='workspace'&&<section className="extension-page"><div className="extension-task-document" hidden={!!extensionView.sessionId}><ExtensionView key={selectedExtension.manifest.id+':'+selectedExtension.generation} plugin={selectedExtension} viewId={extensionView.viewId} initialTaskId={extensionView.taskId} suspended={!!modal||quickOpen||!!treeMenu||!!extensionView.sessionId} onError={setError}/></div>{extensionView.sessionId&&(()=>{const internal=state.sessions.find(value=>value.id===extensionView.sessionId&&value.owner?.pluginId===selectedExtension.manifest.id);return internal?<section className="extension-owned-conversation" aria-label="Superagent 内部会话"><header><button className="subtle" onClick={()=>setExtensionView(previous=>previous?{...previous,sessionId:undefined}:null)}>← 返回任务</button><strong>{internal.title}</strong></header><AcpConversation key={internal.id} session={internal} connected={connected} task={{title:internal.title,label:state.agentActivities?.find(activity=>activity.taskId===internal.owner?.taskId&&activity.pluginId===internal.owner?.pluginId)?.label??'任务内部会话',onOpen:()=>setExtensionView(previous=>previous?{...previous,sessionId:undefined}:null)}} onOpenFile={(path,line)=>{setExtensionView(null);setProjectId(internal.projectId);setSelectedWorktreePath(internal.worktreePath??null);setRightSidebarView('files');setRightSidebarCollapsed(false);setPage('workspace');setFilesActivated(true);setFileTarget({projectId:internal.projectId,query:path+(line?':'+line:''),nonce:++fileTargetSequence.current});setTab('preview');}}/></section>:<div className="empty-page">内部会话已删除<button onClick={()=>setExtensionView(previous=>previous?{...previous,sessionId:undefined}:null)}>返回任务</button></div>;})()}</section>}
      {connected&&state.apiVersion<API_VERSION&&<div className="workspace-recovery" role="status" aria-label="后台需要更新"><div><strong>后台需要更新</strong><small>当前运行的后台尚不支持新增能力。先停止正在运行的会话，再更新后台；当前架构的数据会保留。</small></div><button className="subtle" disabled={running>0||busy} onClick={()=>openModal('restart')}>更新空闲后台</button></div>}
      {state.recovery && (state.recovery.total > 0 || state.recovery.errors.length > 0) && dismissedRecovery !== state.recovery.id && <div className="workspace-recovery" role="status" aria-label="工作区恢复状态">
        <div><strong>{state.recovery.status === 'restoring' ? '正在恢复上次退出的会话' : state.recovery.errors.length ? '部分会话未恢复' : '上次会话恢复完成'}</strong><span> · 已重新打开 {state.recovery.restored}/{state.recovery.total} · 续接 Agent 对话 {state.recovery.resumed}{state.recovery.skipped > 0 ? ` · 跳过 ${state.recovery.skipped}` : ''}</span>
        <small>Agent 续接原生对话；普通终端与 SSH 重开，旧远端任务状态需确认，不重放历史命令。</small>
        {state.recovery.errors.length > 0 && <details><summary>{state.recovery.errors.length} 个会话未恢复，可打开对应会话重新启动或编辑配置</summary><ul>{state.recovery.errors.map(item => <li key={item.sessionId}><strong>{item.title}</strong>：{item.message}</li>)}</ul></details>}</div>
        <button className="icon-button" type="button" aria-label="关闭恢复提示" onClick={() => setDismissedRecovery(state.recovery!.id)}>×</button>
      </div>}
      {!hasLoadedState && error ? <div className="empty-page startup-failure" role="alert">
        <h2>无法连接工作空间</h2>
        <p>后台未能启动。若这是从旧版升级后的首次启动，请先备份数据目录；新架构不支持旧数据库原地升级。</p>
        <code>{error.replace(/^Error: /, '')}</code>
        <div className="startup-actions">
          <button type="button" className="subtle" onClick={() => void window.berth.openDataDirectory().catch(reason => setError(String(reason)))}>打开数据目录</button>
          <button type="button" className="primary" onClick={() => { setError(''); setLoading(true); void window.berth.reconnect().catch(reason => { setError(String(reason)); setLoading(false); }); }}>重试连接</button>
          <button type="button" className="subtle" onClick={() => void window.berth.quitDesktop()}>仅退出界面</button>
        </div>
        <small>仅退出界面不会强制停止仍在运行的后台任务。若要清除旧数据，务必先完整备份。</small>
      </div> : loading ? <WorkspaceSkeleton /> : <><div className="plugins-host" hidden={page !== 'plugins'}>{page === 'plugins' && <PluginCenter tab={pluginTab} onTabChange={setPluginTab} projects={workspaceProjects} currentProjectId={projectId} apiVersion={state.apiVersion} openPluginId={requestedPlugin} onOpenHandled={()=>setRequestedPlugin(null)} onError={setError}/>}</div><div className="settings-host" hidden={page !== 'settings'}>{page === 'settings' && <SettingsPage projects={workspaceProjects} currentProjectId={projectId} connected={connected} apiVersion={state.apiVersion} agents={state.agents ?? []} settings={state.settings} draft={draftDirty ? settingsDraft!.value : state.settings} onChange={value => setSettingsDraft(JSON.stringify(value) === JSON.stringify(state.settings) ? null : { base: state.settings, value })} onDiscard={() => { setSettingsDraft(null); setError(''); }} conflict={draftConflict} onError={setError} error={error} platform={state.platform} busy={busy} disabled={manageDisabled} restartDisabled={busy || !connected} running={running} onSave={async (value: Settings) => { const result = await perform<Settings>('saveSettings', { ...value }); if (result !== undefined) { setSettingsDraft(null); return true; } return false; }} onRestart={() => openModal('restart')} />}</div><div className="workbench-split" hidden={page !== 'workspace'||!!extensionView||!features.workspace}><div className="workspace-host" hidden={!project&&sshOpen}>{!project ? <div className="empty-page welcome"><div className="welcome-symbol"><Icon kind="terminal" /></div><span className="eyebrow">YOUR PROJECTS, IN ONE PLACE</span><h1>项目工作台</h1><p>集中管理项目、终端与 Agent 会话。</p><div className="welcome-actions"><button className="primary" onClick={newProject} disabled={manageDisabled}><Icon kind="plus" />添加第一个项目</button><button className="subtle" onClick={() => void window.berth.openExternal('https://github.com/Tan90degrees/AgentBerth/blob/main/README.md').catch(reason => setError(String(reason)))}>查看使用说明</button></div><ol className="welcome-steps"><li><strong>1 · 添加项目目录</strong><span>按项目组织会话、文件与 Git。</span></li><li><strong>2 · 新建并启动会话</strong><span>选择 Agent 或普通终端，可同时运行多个。</span></li><li><strong>3 · 随时切换或离开</strong><span>终端在后台继续运行，重新打开即可接回。</span></li></ol><button type="button" className="text-button welcome-shortcuts-link" onClick={openShortcuts}>查看键盘快捷键<kbd>Ctrl+/</kbd></button></div> : <>

        <section className="workspace">
          <div className="session-content">

            {session && tab !== 'preview' && !matchesSession(session, project, deferredSearch, filter, agentNames) && <div className="filter-notice">当前会话不在筛选结果中，终端仍可继续使用。</div>}
            <div className="tabs" role="tablist" aria-label="工作区内容" onKeyDown={handleTabKeyDown}>
              <button id="workspace-tab-terminal" role="tab" aria-controls="workspace-panel-terminal" aria-selected={tab === 'terminal'} tabIndex={tab === 'terminal' ? 0 : -1} className={tab === 'terminal' ? 'selected' : ''} onClick={() => setTab('terminal')}>{acpSession?'对话':'终端'}</button>
              {session && (recordOutput || canHistory || canResume || sessionDefinition?.plugin?.list) && <button id={`workspace-tab-${recordOutput ? 'runs' : 'history'}`} role="tab" aria-controls={`workspace-panel-${recordOutput ? 'runs' : 'history'}`} aria-selected={tab === (recordOutput ? 'runs' : 'history')} tabIndex={tab === (recordOutput ? 'runs' : 'history') ? 0 : -1} className={tab === (recordOutput ? 'runs' : 'history') ? 'selected' : ''} onClick={() => setTab(recordOutput ? 'runs' : 'history')}>{recordOutput ? '运行记录' : '对话历史'}</button>}
              <button id="workspace-tab-preview" role="tab" aria-controls="workspace-panel-preview" aria-selected={tab === 'preview'} tabIndex={tab === 'preview' ? 0 : -1} className={tab === 'preview' ? 'selected' : ''} disabled={!features.files || state.apiVersion < 16} onClick={() => { setFilesActivated(true); setTab('preview'); }}>预览</button>
              {tab === 'terminal' && !acpSession && session?.latestRun?.status === 'running' && <button className="hide-terminal" onClick={() => setTerminalVisible(value => !value)}>{terminalVisible ? '收起终端' : '接回终端'}</button>}
            </div>
            {!session && tab === 'terminal' && <div className="empty-page session-empty"><div className="welcome-symbol"><Icon kind="terminal" /></div><h2>选择或创建一个会话</h2><p>会话从项目目录启动，关闭窗口后仍由后台继续运行。</p><div className="empty-actions"><button className="primary" onClick={() => newSession()} disabled={manageDisabled}><Icon kind="plus" />新建会话</button><button className="subtle" onClick={openQuick}>快速切换 <kbd>Ctrl+Shift+P</kbd></button></div><ul className="welcome-steps"><li><strong>1 · 添加项目</strong><span>登记本机目录，工作台不会改动你的项目文件。</span></li><li><strong>2 · 创建会话</strong><span>选择 Agent 或普通终端，可先创建、稍后启动。</span></li><li><strong>3 · 随时接回</strong><span>切换项目或重开窗口，终端画面与进程都会接回。</span></li></ul></div>}
            {session && <div id="workspace-panel-terminal" className="terminal-panel workspace-panel" role="tabpanel" aria-labelledby="workspace-tab-terminal" hidden={tab !== 'terminal'}>{session.service?<ServiceTerminal key={session.id+':'+connectionEpoch} session={session} connected={connected} fontSize={state.settings.fontSize} windowsPty={windowsPty} onError={setError}/>:acpSession?<AcpConversation key={session.id} session={session} connected={connected} task={(()=>{const activity=state.agentActivities?.find(item=>item.kind==='superagent'&&item.managedSessionIds.includes(session.id)&&item.pluginId&&item.taskId);return activity?{title:activity.title,label:activity.label,onOpen:()=>{setPage('workspace');setExtensionView({pluginId:activity.pluginId!,viewId:'tasks',taskId:activity.taskId});}}:undefined;})()} onOpenFile={(path,line)=>openPath(path+(line?':'+line:''))}/>:<>{session.latestRun?.error && <div className="launch-error" role="alert"><strong>{session.latestRun?.status === 'interrupted' ? '上次运行已中断' : '启动未完成'}</strong><p>{session.latestRun.error}</p><p>可在下方重试启动，或编辑会话后重试。</p></div>}{connected && session.latestRun?.status !== 'running' ? <TerminalState historyAvailable={canHistory || canResume} recordOutput={recordOutput} run={session.latestRun} disabled={manageDisabled} busy={busy} onStart={() => { void perform('start', { sessionId: session.id, resume: false, cols: 100, rows: 30 }); }} onEdit={() => editSession(session)} onResume={canResume && session.nativeSessionId ? () => { void perform('start', { sessionId: session.id, resume: true, cols: 100, rows: 30 }); } : undefined} onOutput={() => { if (session.latestRun) { setViewingRun({ sessionId, runId: session.latestRun.id }); setTab('runs'); } }} /> : connected && terminalVisible ? <TerminalView key={`${session.id}:${session.latestRun?.id}:${connectionEpoch}`} sessionId={sessionId} remoteSession={!!session.remote} inputEnabled windowsPty={windowsPty} orderedResize={state.apiVersion >= 9} binaryMouse={state.apiVersion >= 16} fontSize={state.settings.fontSize} autoFocus={forceTerminalFocus || page === 'workspace' && !modal && !quickOpen && !shortcutsOpen && !treeMenu && !(rightSidebarView==='git'&&!rightSidebarCollapsed) && tab === 'terminal'} onFocusReady={forceTerminalFocus?()=>setForceTerminalFocus(false):undefined} onError={setError} onOpenPath={features.files && !session.remote && state.apiVersion >= 17 ? openPath : undefined} /> : <div className="empty-page"><Icon kind="terminal" /><h2>{connected ? '终端已收起' : '后台连接已断开'}</h2><p>{connected ? '运行中的任务仍在后台继续。' : '重新连接后接回终端。'}</p><button className="subtle" onClick={() => connected ? setTerminalVisible(true) : void window.berth.reconnect().catch(reason => setError(String(reason)))}>{connected ? '接回终端' : '重新连接'}</button></div>}<footer className="terminal-footer"><span>{session.latestRun ? `${active(session) ? '运行' : '上次运行'} ${session.latestRun.id.slice(0, 8)}${active(session) && !session.remote ? ` · PID ${session.latestRun.pid ?? '—'}` : ''}` : '尚未启动'} · {session.latestRun ? session.latestRun.shell?.split(/[\\/]/).at(-1) || '历史终端' : terminalNames[(session.terminal ?? state.settings.terminal).profile]}</span><span>{session.remote ? '本机后台维持 SSH · 链路断开不保证恢复原进程' : '关窗口继续运行 · 托盘退出停止全部终端'}</span></footer></>}</div>}
            {session && (tab === 'history' || tab === 'runs' && recordOutput) && <SessionInsights key={session.id} session={session} projectPath={project?.path ?? ''} definition={sessionDefinition} label={agentNames[session.agent]} tab={tab === 'history' ? 'history' : 'runs'} apiVersion={state.apiVersion} connected={connected} canHistory={canHistory} canResume={canResume} disabled={manageDisabled} windowsPty={windowsPty} fontSize={state.settings.fontSize} viewingRunId={outputRunId} insightsRevision={insightsRevision} onViewingRun={(runId, targetSessionId) => setViewingRun(runId ? { sessionId: targetSessionId, runId } : null)} onTabChange={setTab} onManualLink={openLink} onCopyText={copyText} onNotice={notify} onDeleted={handleDeleted} onError={setError} />}
            <div id="workspace-panel-preview" className="workspace-panel preview-panel" role="tabpanel" aria-labelledby="workspace-tab-preview" hidden={tab !== 'preview'} ref={setFilePreviewHost}>{gitPreview?.projectId === projectId && <Suspense fallback={<p>正在准备差异预览…</p>}><GitDiffPreview request={gitPreview} connected={connected} onChange={staged => setGitPreview(value => value ? { ...value, staged } : null)} onBack={() => setGitPreview(null)} /></Suspense>}</div>
          </div>
        </section>
      </>}</div><div id="ssh-workspace-dock" className="ssh-dock-slot" hidden={!features.ssh||!sshOpen}>{features.ssh&&sshWindowReady&&!sshWindowState.detached&&<SshDock onWindow={()=>changeSshWindow('open')} unread={unread} state={state} visible={sshOpen&&page==='workspace'} connected={connected} sessionId={sshSessionId} onSelect={setSshSessionId} onClose={()=>setSshOpen(false)} onMenu={setTreeMenu} onError={setError} connectionEpoch={connectionEpoch} onOpenConnection={openSavedSsh} onStart={startSsh} hasLocal={!!project} />}</div></div></>}
    </main>
    <ResizableSidebar collapsed={rightSidebarCollapsed} side="right">
      {rightSidebarCollapsed?<div className="right-sidebar-rail" aria-label="右侧工具栏">
        <button type="button" className="icon-button" aria-label="打开文件" title="文件 · Ctrl+Shift+E" disabled={!features.files||!project||state.apiVersion<16} onClick={()=>{setRightSidebarView('files');setRightSidebarCollapsed(false);setFilesActivated(true);setPage('workspace');}}><Icon kind="folder"/></button>
        <button type="button" className="icon-button" aria-label="打开 Git" title="Git · Ctrl+Shift+G" disabled={!features.git||!project} onClick={()=>{setRightSidebarView('git');setRightSidebarCollapsed(false);setPage('workspace');}}><Icon kind="git"/></button>
      </div>:<div className="right-sidebar-content">
        <header className="right-sidebar-header"><div className="right-sidebar-tabs" role="tablist" aria-label="右侧工具">
          <button type="button" role="tab" aria-selected={rightSidebarView==='files'} onClick={()=>{setRightSidebarView('files');setFilesActivated(true);}} disabled={!features.files||!project||state.apiVersion<16}><Icon kind="folder"/>文件</button>
          <button type="button" role="tab" aria-selected={rightSidebarView==='git'} onClick={()=>setRightSidebarView('git')} disabled={!features.git||!project}><Icon kind="git"/>Git</button>
        </div><button type="button" className="icon-button right-sidebar-collapse" aria-label="折叠右侧栏" title="折叠右侧栏" onClick={()=>setRightSidebarCollapsed(true)}>×</button></header>
        <div id="right-sidebar-panel-files" className="right-sidebar-panel" hidden={rightSidebarView!=='files'}>
          <div className="file-project-picker"><select aria-label="文件所属项目" value={projectId} onChange={event=>{selectProject(event.target.value);setFileTarget(null);}}>{workspaceProjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          <div className="sidebar-files-host" ref={setFileTreeHost}/>
        </div>
        <div id="right-sidebar-panel-git" className="right-sidebar-panel" hidden={rightSidebarView!=='git'}>
          <div className="file-project-picker"><select aria-label="Git 所属项目" value={projectId} onChange={event=>selectProject(event.target.value)}>{workspaceProjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          {features.git&&project&&<WorktreeManager key={project.id+':'+project.path} project={project} enabled={connected&&state.apiVersion>=43} visible={rightSidebarView==='git'&&!rightSidebarCollapsed} selectedPath={selectedWorktreePath} onSelect={setSelectedWorktreePath} onNewSession={path=>newSession(project.id,path)} onNotice={notify} onError={setError}/>}
          {features.git&&project&&<GitSidebar key={project.id+':'+project.path+':git'} project={project} enabled={connected&&state.apiVersion>=13} visible={rightSidebarView==='git'&&!rightSidebarCollapsed&&page==='workspace'} supported={state.apiVersion>=18} worktreePath={selectedWorktreePath} onDiff={openDiff} onNotice={notify} onError={setError}/>}
        </div>
      </div>}
    </ResizableSidebar>
    </>}
    {features.ssh&&sshWindow&&sshWindowReady&&<SshDock unread={unread} state={state} visible connected={connected} sessionId={sshSessionId} onSelect={selectSsh} onClose={()=>void changeSshWindow('dock').catch(reason=>setError(String(reason)))} onMenu={setTreeMenu} onError={setError} connectionEpoch={connectionEpoch} onOpenConnection={openSavedSsh} onStart={startSsh} hasLocal={false} detached onWindow={()=>changeSshWindow('dock')} />}
    {features.files && !sshWindow && project && state.apiVersion >= 16 && filesActivated && <Suspense fallback={null}><FileBrowser key={`${project.id}:${project.path}:${selectedWorktreePath ?? 'main'}`} project={project} worktreePath={selectedWorktreePath} connected={connected} treeHost={fileTreeHost} previewHost={filePreviewHost} previewHidden={gitPreview?.projectId === projectId} onDiff={features.git && state.apiVersion >= 18 ? openDiff : undefined} onPreview={openPreview} navigationSupported={state.apiVersion >= 17} onTargetConsumed={consumeFileTarget} target={fileTarget?.projectId === projectId ? fileTarget : null} /></Suspense>}
    {treeMenu && menuItems.length > 0 && <ContextMenu target={treeMenu} items={menuItems} onClose={closeTreeMenu} />}
    {quickOpen && <QuickSwitcher state={{...state,projects:workspaceProjects,sessions:state.sessions.filter(session=>!session.owner)}} canCreate={!manageDisabled} hasProject={!!project} onSelect={chooseTarget} onClose={() => setQuickOpen(false)} returnFocus={opener.current} />}
    {pluginSettingsRequest && <PluginSettingsPopover request={pluginSettingsRequest} snapshot={state.extensions} projects={workspaceProjects} currentProjectId={projectId} apiVersion={state.apiVersion} onError={setError} onClose={() => setPluginSettingsRequest(null)} />}
    {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} returnFocus={opener.current} />}
    {(notices.length > 0 || (error && !modal && hasLoadedState && page !== 'settings')) && <div className="toast-stack">
      {notices.map(item => <SuccessToast key={item.id} message={item.text} action={item.action} onDismiss={() => closeNotice(item.id)} />)}
      {error && !modal && hasLoadedState && page !== 'settings' && <div className="toast" role="alert"><span>{error.replace(/^Error: /, '')}</span><div className="toast-actions">{!connected && <button type="button" className="toast-copy" onClick={() => { setError(''); void window.berth.reconnect().catch(reason => setError(String(reason))); }}>重新连接</button>}<button type="button" className="toast-copy" onClick={() => void copyText(error, '错误信息')}>复制</button><button onClick={() => setError('')} aria-label="关闭提示">×</button></div></div>}
    </div>}
    {modalRequest && <ModalLayer key={modalRequest.token} request={modalRequest} state={state} agentNames={agentNames} features={features} actionProject={actionProject} actionSession={actionSession} actionProjectSessions={actionProjectSessions} session={session} busy={busy} error={error} connected={connected} running={running} returnFocus={opener.current} perform={perform} onError={setError} onClose={closeModal} onSubmitProject={values => void submitProject(values)} onSubmitSession={values => void submitSession(values)} onSubmitRename={(kind, value) => void submitRename(kind, value)} onSubmitLink={value => void submitLink(value)} onDeleted={handleDeleted} onRestart={() => void restartBackend()} />}
  </div></ExtensionsContext.Provider>;
}
