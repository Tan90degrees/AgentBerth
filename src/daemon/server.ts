import { randomUUID } from 'node:crypto';
import { openCodeLaunch } from './opencode-launch';
import { SshTerminal } from './ssh-terminal';
import type { SshChallenge, SshSecret, TransferEndpoint } from '../shared/protocol';
import { localTransferFs, RemoteTransfers, sftpTransferFs } from './remote-transfer';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { release } from 'node:os';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, requestSchema, type Attachment, type HistoryQuery, type History, type Request, type Run, type RuntimeInfo, type ServerEvent } from '../shared/protocol';
import { Store } from './store';
import { ResourceSampler } from './resources';
import { GitWorkspace } from './git';
import { ProjectFiles } from './files';
import { AgentPlugins } from './plugins';
import { directory, launchCommand, resolveTerminal, terminalEnvironment } from './paths';
import { sameDirectory, matchesProject } from './history';
import { NativeDiscovery, unambiguousNewHistory, type NativeCandidate } from './native-discovery';
import { RunLog } from './logs';
import { readHistory } from './history';
import { terminateTree } from './processes';
import { trackMouseEncoding } from '../shared/terminal-modes';
import { RemoteTerminal, sshHosts, type TerminalProcess } from './remote';
import { RemoteActivity, remoteKeys } from './remote-activity';
import { McpCallStats } from './mcp-metrics';
import { RemoteOperationError } from '../shared/remote-errors';
import { windowsPtyFor } from '../shared/desktop';
import { restartConfiguration, shouldResume, type RestartEntry } from './recovery';
import type { WorkspaceRecovery, State } from '../shared/protocol';
import { ExtensionRuntime } from '../extensions/runtime';
import { mount as mountWorkspace } from '../plugins/workspace';
import { mount as mountSsh } from '../plugins/ssh';
import { mount as mountAgents } from '../plugins/agents';
import { mount as mountGit } from '../plugins/git';
import { mount as mountFiles } from '../plugins/files';
import { mount as mountResources } from '../plugins/resources';
import { featureForMethod } from '../extensions/builtins';
import type { Context } from 'cordis';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

interface LiveTerminal {
  run: Run; pty: TerminalProcess; remote?: { transport: RemoteTerminal | SshTerminal; activity: RemoteActivity }; terminal: Terminal; serialize: SerializeAddon; mouseEncoding: () => string;
  seq: number; committedSeq: number; queuedBytes: number; stopping: boolean; closed: boolean;
  log: RunLog | null;
  output: string[]; outputBytes: number; outputTimer: NodeJS.Timeout | null; finishing: Promise<void> | null;
}
export interface Client { id: string; disposing: boolean; subscriptions: Set<string>; activity: Map<string, string>; pending: number; abort: AbortController }

export class DaemonServer {
  private extensions:ExtensionRuntime;
  private extensionRoutes=new Map<string,(request:Request,client:Client)=>Promise<unknown>>();
  private extensionCaller=new AsyncLocalStorage<Client>();
  private extensionAgents=new Map<string,string>();
  private sshProvider: Client | null = null;
  private sshChallenges = new Map<string, { client: Client; resolve: (value: {secret?: SshSecret; accepted?: boolean}) => void; reject: (error: Error) => void }>();
  private agentOwners = new Map<string, Client>();
  private openingAliases = new Map<string, Promise<{sessionId:string;runId:string;info: import('../shared/protocol').RemoteInfo}>>();
  private store: Store;
  private transfers: RemoteTransfers;
  private plugins = new AgentPlugins();
  private agentVersions = new Map<string, number>();
  private git = new GitWorkspace();
  private files = new ProjectFiles(this.git);
  private resources = new ResourceSampler();
  private mcpStats=new McpCallStats();
  private mcpStatsTimer:NodeJS.Timeout|null=null;
  private gitBusy = new Set<string>();
  private http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  private ws = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private clients = new Map<WebSocket, Client>();
  private pendingWork = 0;
  private live = new Map<string, LiveTerminal>();
  private token = randomBytes(32).toString('hex');
  private closing = false;
  private logs: string;
  private nativeDiscovery = new NativeDiscovery();
  private agentsMounted=false;
  private nativeTracking = new Map<string, { runId: string; baseline: Set<string>; started: number; ambiguous: boolean; hookNativeId?: string }>();
  private nativeTimer: NodeJS.Timeout | null = null;
  private nativeScanning: Promise<void> | null = null;
  private historyBusy = new Set<string>();
  private historyWrites = new Set<string>();
  private starting = new Set<string>();
  private editingProjects = new Set<string>();
  private recoveryReport: WorkspaceRecovery | undefined;
  private recovering: Promise<void> | null = null;
  private recoveryPending = new Map<string, RestartEntry>();
  private restoredRuns = new Map<string, {previousRunId:string|null;runId:string}>();

  constructor(readonly dataDirectory: string, private onShutdown: () => void = () => {}, private spawnPty: typeof pty.spawn = pty.spawn, nativeDiscovery?: NativeDiscovery) {
    if (nativeDiscovery) this.nativeDiscovery = nativeDiscovery;
    this.store = new Store(dataDirectory);
    this.extensions=new ExtensionRuntime(path.join(dataDirectory,'extensions'),{
      mount:(id,ctx,config)=>this.mountExtension(id,ctx,config),
      beforeChange:async ids=>{
        const sessions=this.store.state().sessions;
        for(const session of sessions)if(this.live.has(session.id)||this.starting.has(session.id)){
          if(ids.includes('workspace')||ids.includes('ssh')&&session.remote||ids.includes('agents')&&!session.remote&&session.agent!=='shell'||ids.includes('agent.'+session.agent)||ids.some(id=>this.extensionAgents.get(session.agent)===id))throw new Error(`插件仍有运行会话“${session.title}”，请先停止该会话；其他插件无需停止`);
        }
        if(ids.includes('git')&&this.gitBusy.size)throw new Error('Git 操作正在进行，请完成后再停用插件');
        if(ids.includes('ssh')&&this.transfers.busy)throw new Error('文件传输正在进行，请完成后再停用 SSH 插件');
        if((ids.includes('agents')||ids.some(id=>id.startsWith('agent.')))&&this.historyBusy.size)throw new Error('会话历史正在读取，请完成后再停用接入插件');
      },
      call:async(method,params)=>{const caller=this.extensionCaller.getStore();if(!caller&&/^(remote|ssh|mcp)/i.test(method))throw new Error('SSH 操作必须由明确的调用会话发起');const request=requestSchema.parse({id:randomUUID(),method,params});return this.dispatch(request,caller??{id:'extension',disposing:false,subscriptions:new Set(),activity:new Map(),pending:0,abort:new AbortController()});},
      validateAgent:(pluginId,agent)=>{const sourceId='ext.'+createHash('sha256').update(pluginId+'\0'+agent.id).digest('hex').slice(0,32);if(this.store.agents().some(value=>value.sourceId!==sourceId&&value.name.toLocaleLowerCase()===agent.definition.name.toLocaleLowerCase()))throw new Error('Agent 名称已被其他接入使用：'+agent.definition.name);},
      agentsChanged:values=>{
        const names=new Set<string>();for(const {agent} of values){const name=agent.definition.name.toLocaleLowerCase();if(names.has(name))throw new Error('插件 Agent 名称重复：'+agent.definition.name);names.add(name);}
        const next=new Map<string,string>();
        for(const {pluginId,agent} of values){const hash=createHash('sha256').update(pluginId+'\0'+agent.id).digest('hex');const id=`agent:${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;const definition={...agent.definition,sourceId:'ext.'+hash.slice(0,32)},previous=this.store.agents().find(value=>value.id===id);if(JSON.stringify(previous&&(({id,...value})=>value)(previous))!==JSON.stringify(definition)){this.store.saveAgent(definition,id);this.agentVersions.set(id,this.agentVersion(id)+1);}next.set(id,pluginId);}
        this.extensionAgents=next;
      },changed:()=>this.changed(),
    });
    this.transfers=new RemoteTransfers(this.store,async endpoint=>endpoint.kind==='local'?localTransferFs():sftpTransferFs(await this.remote(endpoint.sessionId,endpoint.runId).transport.sftp()),data=>this.broadcast({event:'remoteTransfer',data}),data=>this.broadcast({event:'remoteAction',data}),endpoint=>{
      if(endpoint.kind==='local')return 'local';
      const profile=this.store.sshConnection(this.store.session(endpoint.sessionId).remote!.connectionId!);
      return `ssh:${profile.hostname.toLowerCase()}:${profile.port}:${profile.username}`;
    });
    rmSync(path.join(dataDirectory,'command-output'),{recursive:true,force:true});
    this.logs = path.join(dataDirectory, 'logs');
    mkdirSync(this.logs, { recursive: true, mode: 0o700 });
    this.http.on('upgrade', (request, socket, head) => {
      if (!this.authorized(request)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      this.ws.handleUpgrade(request, socket, head, ws => this.ws.emit('connection', ws, request));
    });
    this.ws.on('connection', socket => {
      const client: Client = { id: randomUUID(), disposing: false, subscriptions: new Set(), activity: new Map(), pending: 0, abort: new AbortController() };
      this.clients.set(socket, client);
      socket.on('error', () => socket.close());
      socket.on('close', () => { if (this.sshProvider === client) this.sshProvider = null; for (const pending of this.sshChallenges.values()) if (pending.client === client) pending.reject(new Error('请打开 AgentBerth 后重试 SSH 连接')); client.abort.abort(); for (const live of this.live.values()) live.remote?.activity.release(client); this.clients.delete(socket); });
      socket.on('message', (bytes, isBinary) => {
        if (isBinary || client.pending >= 128) { socket.close(1008, 'Invalid or excessive requests'); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
        const result = requestSchema.safeParse(parsed);
        if (!result.success) {
          const id = parsed && typeof parsed === 'object' && 'id' in parsed ? String(parsed.id) : '';
          this.send(socket, { id, errorCode:'INVALID_ARGUMENTS', error: '请求参数无效：' + result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
          return;
        }
        // Resource polling is cancelled by close() and must not block an idle restart.
        const blocksIdleShutdown = !['resources','mcpMetrics','mcpRecordCall'].includes(result.data.method);
        client.pending++;
        if (blocksIdleShutdown) this.pendingWork++;
        void this.dispatch(result.data, client).then(value => this.send(socket, { id: result.data.id, result: value }, ['shutdown','shutdownIdle'].includes(result.data.method) ? this.onShutdown : undefined)).catch(error => this.send(socket, { id: result.data.id, error: error instanceof Error ? error.message : '操作失败', ...(error instanceof RemoteOperationError?{errorCode:error.code,errorDetails:error.details}:{}) })).finally(() => {
          client.pending--;
          if (blocksIdleShutdown) this.pendingWork--;
        });
      });
    });
  }

  private authorized(request: IncomingMessage): boolean {
    if (request.url !== '/rpc' || request.headers.origin) return false;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  private send(socket: WebSocket, message: unknown, sent?: () => void): void {
    if (socket.readyState !== WebSocket.OPEN) { sent?.(); return; }
    // A slow or closed UI must never stop output consumption by the daemon.
    // Two bounded image replies can overlap; a slow UI still has a finite budget.
    if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.close(1013, 'Reconnect to restore terminal'); sent?.(); return; }
    // Full/idle shutdown must follow the actual response write, not a timer
    // that can fire while a loaded Windows runner is still sending the reply.
    socket.send(JSON.stringify(message), sent ? () => sent() : undefined);
  }
  private broadcast(event: ServerEvent): void {
    for (const [socket, client] of this.clients) {
      if ((event.event === 'output' || event.event === 'resize') && !client.subscriptions.has(event.data.sessionId)) {
        // One lightweight reminder until this client attaches again. Never
        // stream background terminal content just to light an unread label.
        if (event.event === 'output' && event.data.text && client.activity.get(event.data.sessionId) !== event.data.runId) {
          client.activity.set(event.data.sessionId, event.data.runId);
          const { sessionId, runId, seq } = event.data;
          this.send(socket, { event: 'terminalActivity', data: { sessionId, runId, seq } });
        }
        continue;
      }
      this.send(socket, event);
    }
  }
  private changed(): void {
    const state = this.snapshot(), valid = new Set(state.sessions.map(session => session.id));
    for (const id of this.agentOwners.keys()) if (!valid.has(id)) this.agentOwners.delete(id);
    for (const [id, restored] of this.restoredRuns) if (!state.sessions.some(session => session.id === id && session.latestRun?.id === restored.runId)) this.restoredRuns.delete(id);
    for (const client of this.clients.values()) for (const id of client.activity.keys()) if (!valid.has(id)) client.activity.delete(id);
    this.broadcast({ event: 'state', data: state });
  }
  private snapshot(): State { const state=this.store.state();return {...state,extensions:this.extensions?.snapshot(),agents:state.agents?.filter(a=>!a.sourceId?.startsWith('ext.')||this.extensionAgents.has(a.id)), ...(this.recoveryReport ? {recovery:this.recoveryReport} : {})}; }
  workspacePluginPort() {
    const self=this;
    return {
      attach:self.attach.bind(self),
      broadcast:self.broadcast.bind(self),
      changed:self.changed.bind(self),
      get closing(){return self.closing;},
      get editingProjects(){return self.editingProjects;},
      flushOutput:self.flushOutput.bind(self),
      get gitBusy(){return self.gitBusy;},
      get historyBusy(){return self.historyBusy;},
      get live(){return self.live;},
      get logs(){return self.logs;},
      removeLogs:self.removeLogs.bind(self),
      requireIdle:self.requireIdle.bind(self),
      requireProjectAvailable:self.requireProjectAvailable.bind(self),
      restoreWorkspace:self.restoreWorkspace.bind(self),
      start:self.start.bind(self),
      stop:self.stop.bind(self),
      get store(){return self.store;},
      terminal:self.terminal.bind(self),
      validateRemote:self.validateRemote.bind(self)
    };
  }
  sshPluginPort() {
    const self=this;
    return {
      get agentOwners(){return self.agentOwners;},
      aliasTarget:self.aliasTarget.bind(self),
      assertOwnSession:self.assertOwnSession.bind(self),
      authorizeRemote:self.authorizeRemote.bind(self),
      broadcast:self.broadcast.bind(self),
      changed:self.changed.bind(self),
      get live(){return self.live;},
      get mcpStats(){return self.mcpStats;},
      get mcpStatsTimer(){return self.mcpStatsTimer;},
      set mcpStatsTimer(value){self.mcpStatsTimer=value;},
      get openingAliases(){return self.openingAliases;},
      recoverReadTarget:self.recoverReadTarget.bind(self),
      remote:self.remote.bind(self),
      remoteProject:self.remoteProject.bind(self),
      removeLogs:self.removeLogs.bind(self),
      requireIdle:self.requireIdle.bind(self),
      get restoredRuns(){return self.restoredRuns;},
      runRemoteCommand:self.runRemoteCommand.bind(self),
      screen:self.screen.bind(self),
      get sshChallenges(){return self.sshChallenges;},
      get sshProvider(){return self.sshProvider;},
      set sshProvider(value){self.sshProvider=value;},
      start:self.start.bind(self),
      get starting(){return self.starting;},
      stop:self.stop.bind(self),
      get store(){return self.store;},
      terminal:self.terminal.bind(self),
      get transfers(){return self.transfers;},
      validateRemote:self.validateRemote.bind(self)
    };
  }
  agentsPluginPort() {
    const self=this;
    return {
      agentVersion:self.agentVersion.bind(self),
      get agentVersions(){return self.agentVersions;},
      assertAgentVersion:self.assertAgentVersion.bind(self),
      changed:self.changed.bind(self),
      get closing(){return self.closing;},
      discoverHistories:self.discoverHistories.bind(self),
      get historyBusy(){return self.historyBusy;},
      importHistory:self.importHistory.bind(self),
      integration:self.integration.bind(self),
      get live(){return self.live;},
      get nativeDiscovery(){return self.nativeDiscovery;},
      get nativeTracking(){return self.nativeTracking;},
      get plugins(){return self.plugins;},
      previewHistory:self.previewHistory.bind(self),
      requireHistoryAvailable:self.requireHistoryAvailable.bind(self),
      get store(){return self.store;}
    };
  }
  gitPluginPort() {
    const self=this;
    return {
      get closing(){return self.closing;},
      get git(){return self.git;},
      get gitBusy(){return self.gitBusy;},
      requireProjectAvailable:self.requireProjectAvailable.bind(self),
      get store(){return self.store;}
    };
  }
  filesPluginPort() {
    const self=this;
    return {
      get files(){return self.files;},
      get store(){return self.store;}
    };
  }
  resourcesPluginPort() {
    const self=this;
    return {
      get live(){return self.live;},
      get resources(){return self.resources;},
      get store(){return self.store;}
    };
  }
  registerExtensionRoutes(ctx:Context,methods:readonly string[],handler:(request:Request,client:Client)=>Promise<unknown>){for(const method of methods)ctx.effect(()=>{if(this.extensionRoutes.has(method))throw new Error('插件接口重复：'+method);this.extensionRoutes.set(method,handler);return()=>{this.extensionRoutes.delete(method);};});}
  private async mountExtension(id:string,ctx:Context,_config:Record<string,unknown>){
    const mounts:Record<string,(ctx:Context,server:DaemonServer)=>void>={workspace:mountWorkspace,ssh:mountSsh,agents:mountAgents,git:mountGit,files:mountFiles,resources:mountResources};mounts[id]?.(ctx,this);
    if(id==='resources'){this.resources=new ResourceSampler();ctx.effect(()=>()=>this.resources.close());}
    if(id==='git'){this.git=new GitWorkspace();ctx.effect(()=>()=>this.git.close());}
    if(id==='files'){const readonlyGit=new GitWorkspace();this.files=new ProjectFiles(readonlyGit);ctx.effect(()=>()=>readonlyGit.close());}
    if(id==='agents'){if(this.agentsMounted)this.nativeDiscovery=new NativeDiscovery();this.agentsMounted=true;this.plugins=new AgentPlugins();ctx.effect(()=>async()=>{if(this.nativeTimer)clearTimeout(this.nativeTimer);this.nativeTimer=null;await this.nativeScanning;this.nativeTracking.clear();await this.plugins.close();await this.nativeDiscovery.opencode.close();});}
    if(id==='ssh')ctx.effect(()=>async()=>{if(this.mcpStatsTimer)clearTimeout(this.mcpStatsTimer);this.mcpStatsTimer=null;this.sshProvider=null;for(const challenge of this.sshChallenges.values())challenge.reject(new Error('SSH 插件已停用'));this.sshChallenges.clear();await this.transfers.close();});
  }
  private recoveryConfiguration(session: import('../shared/protocol').Session): string {
    return restartConfiguration(session, this.store.project(session.projectId).path,
      session.agent.startsWith('agent:') ? this.store.agent(session.agent) : undefined,
      session.remote?.connectionId ? this.store.sshConnection(session.remote.connectionId) : undefined);
  }
  private checkpointWorkspace(): void {
    const entries = new Map(this.recoveryPending);
    for (const session of this.store.state().sessions) {
      const live = this.live.get(session.id);
      if ((!live && !this.starting.has(session.id)) || live?.closed || live?.stopping || this.agentOwners.get(session.id)?.disposing) continue;
      entries.set(session.id, {sessionId:session.id,runId:session.latestRun?.id ?? null,cols:live?.terminal.cols ?? 100,rows:live?.terminal.rows ?? 30,
        configuration:this.recoveryConfiguration(session),...(session.remote ? {remoteOwner:live?.remote?.activity.info.owner ?? 'user'} : {})});
    }
    this.store.saveRestartPlan([...entries.values()]);
  }
  private restoreWorkspace(): WorkspaceRecovery {
    if (this.recoveryReport) return this.recoveryReport;
    // Claim once, before any launch; reconnects and duplicate startup requests
    // cannot replay a partially completed restoration.
    let entries: RestartEntry[] = [], invalidPlan = false;
    try { entries = this.store.takeRestartPlan(); }
    catch (error) { invalidPlan = true; this.logError(error); }
    const report: WorkspaceRecovery = {id:randomUUID(),status:'restoring',total:entries.length,restored:0,resumed:0,skipped:0,errors:[]};
    if (invalidPlan) report.errors.push({sessionId:'',title:'恢复记录',message:'恢复记录无法读取，可手动启动会话；下次从托盘退出时会重新保存'});
    this.recoveryReport = report;
    this.recoveryPending = new Map(entries.map(entry => [entry.sessionId,entry]));
    let next = 0;
    const worker = async () => {
      while (next < entries.length && !this.closing) {
        const entry = entries[next++];
        let title = entry.sessionId;
        try {
          const session = this.store.state().sessions.find(value => value.id === entry.sessionId);
          if (!session || this.live.has(entry.sessionId) || this.starting.has(entry.sessionId)) { report.skipped++; continue; }
          title = session.title;
          if ((session.latestRun?.id ?? null) !== entry.runId || this.recoveryConfiguration(session) !== entry.configuration) { report.skipped++; continue; }
          if (session.remote?.connectionId && entry.remoteOwner === 'agent' && !this.store.sshConnection(session.remote.connectionId).allowAgent) throw new Error('服务器已关闭 Agent 授权，请检查 SSH 设置后手动连接');
          const resume = shouldResume(session, session.agent.startsWith('agent:') ? this.store.agent(session.agent) : undefined);
          await this.start(session.id, resume, entry.cols, entry.rows, session.remote ? entry.remoteOwner ?? 'user' : undefined);
          report.restored++; if (resume) report.resumed++;
        } catch (error) {
          report.errors.push({sessionId:entry.sessionId,title,message:error instanceof Error ? error.message : String(error)});
        } finally { this.recoveryPending.delete(entry.sessionId); this.changed(); }
      }
    };
    // Yield so the RPC returns immediately; SSH authentication never blocks the UI.
    this.recovering = Promise.resolve().then(async () => { await Promise.all(Array.from({length:Math.min(3,entries.length)},worker)); })
      .catch(error => this.logError(error)).finally(() => { report.status='completed';this.recovering=null;this.changed(); });
    this.changed(); return report;
  }

  async listen(): Promise<RuntimeInfo> {
    await this.extensions.ready;
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => { this.http.removeListener('error', reject); resolve(); });
    });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('无法启动本地后台服务');
    const runtime = { version: PROTOCOL_VERSION, pid: process.pid, port: address.port, token: this.token };
    writeFileSync(path.join(this.dataDirectory, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 });
    return runtime;
  }

  private terminal(sessionId: string, runId?: string): LiveTerminal {
    const live = this.live.get(sessionId);
    if (!live || live.closed) throw new RemoteOperationError('SESSION_NOT_OPEN','终端已结束，请重新启动',{sessionId});
    if (runId && live.run.id !== runId) throw new RemoteOperationError('STALE_RUN','终端运行实例已变化，请重新连接',{sessionId,runId});
    return live;
  }

  private remote(sessionId: string, runId: string) {
    const remote = this.terminal(sessionId, runId).remote;
    if (!remote) throw new Error('此会话不是远程终端');
    if (this.terminal(sessionId,runId).stopping) throw new Error('终端正在停止');
    return remote;
  }
  private challenge(profile: {id: string; alias: string; hostname: string; port: number}, kind: SshChallenge['kind'], fingerprint?: string): Promise<{secret?: SshSecret; accepted?: boolean}> {
    const provider = this.sshProvider;
    const socket = [...this.clients].find(([,client]) => client === provider)?.[0];
    if (!provider || !socket) return Promise.reject(new Error('请打开 AgentBerth，在 SSH 连接设置中输入登录信息后重试'));
    const id = randomUUID();
    return new Promise((resolve,reject) => {
      const complete = () => { clearTimeout(timer); this.sshChallenges.delete(id); };
      const timer = setTimeout(() => { complete(); reject(new Error('SSH 登录信息或主机指纹确认超时，请在 AgentBerth 中重试')); }, 40000);
      this.sshChallenges.set(id, { client: provider, resolve: value => { complete(); resolve(value); }, reject: error => { complete(); reject(error); } });
      this.send(socket, { event: 'sshChallenge', data: { id, connectionId: profile.id, alias: profile.alias, kind, fingerprint, hostname: profile.hostname, port: profile.port } });
    });
  }
  private aliasTarget(alias: string, client?: Client, human = false) {
    const profile = this.store.sshConnections().find(item => item.alias.toLowerCase() === alias.toLowerCase());
    if (!profile) throw new RemoteOperationError('ALIAS_NOT_FOUND','连接别名不存在，请先在 AgentBerth 设置中保存 SSH 连接',{alias});
    const sessions = this.store.state().sessions.filter(session => session.remote?.connectionId === profile.id && (!client || this.agentOwners.get(session.id) === client));
    if (human && !sessions.length) {
      // The desktop can recover its own unclaimed human terminal after restart;
      // Agent defaults never select any globally shared or foreign terminal.
      sessions.push(...this.store.state().sessions.filter(session => session.remote?.connectionId === profile.id && (!this.agentOwners.get(session.id) || this.agentOwners.get(session.id)!.abort.signal.aborted) && this.live.get(session.id)?.remote?.activity.info.owner === 'user'));
    }
    const active = sessions.filter(session => this.live.has(session.id));
    if (active.length > 1) throw new RemoteOperationError('ALIAS_AMBIGUOUS','当前 Agent 在此服务器有多个会话，请使用自己的 sessionId 和 runId',{alias});
    return { profile, session: active[0] ?? sessions[0] };
  }
  private recoverReadTarget(sessionId: string, client: Client): void {
    // An explicitly retained session/run can be recovered by a fresh MCP
    // process. Desktop observation must never acquire an Agent's connection.
    if(client !== this.sshProvider && this.agentOwners.get(sessionId)?.abort.signal.aborted)this.agentOwners.set(sessionId,client);
  }
  private assertOwnSession(sessionId: string, client: Client): void {
    if (client.disposing) throw new RemoteOperationError('CLEANUP_BLOCKED', '此 Agent 正在清理连接，请等待清理完成；未发送新操作', {sessionId});
    const previous = this.agentOwners.get(sessionId);
    if (previous && previous !== client && !previous.abort.signal.aborted) {
      const session = this.store.session(sessionId);
      throw new RemoteOperationError('AGENT_BUSY', '此 SSH 会话属于另一个 Agent，请基于服务器信息创建自己的连接', { sessionId, runId: session.latestRun?.id, alias: session.remote?.host });
    }
    if (previous) this.agentOwners.set(sessionId, client);
  }
  private remoteProject() {
    const folder = path.join(this.dataDirectory, 'remote-sessions');
    mkdirSync(folder, {recursive:true, mode:0o700});
    return this.store.createProject('远程连接', folder);
  }
  private authorizeRemote(endpoint:TransferEndpoint,client:Client,connected=true):void {
    if(endpoint.kind==='local')return;
    this.assertOwnSession(endpoint.sessionId,client);
    const session=this.store.session(endpoint.sessionId);
    if(!session.remote?.connectionId||!this.store.sshConnection(session.remote.connectionId).allowAgent)throw new Error('请使用已填写服务器信息并允许 Agent 使用的 SSH 连接');
    const remote=this.remote(endpoint.sessionId,endpoint.runId);
    if(connected)remote.activity.assertAgent(client);else remote.activity.assertManage(client);
  }
  private async dispatch(request: Request, client: Client): Promise<unknown> {
    if (this.closing) throw new Error('后台正在退出');
    if(request.method==='extensions'){
      const p=request.params.request;
      if(p.action==='list')return this.extensions.snapshot();
      if(p.action==='install')return this.extensions.install(p.path,p.development);
      if(p.action==='call')return this.extensionCaller.run(client,()=>this.extensions.call(p.id,p.command,p.params));
      if(p.action==='view')return this.extensions.view(p.id,p.view);
      return this.extensions.change(p.action,p.id,'config' in p?p.config:undefined);
    }
    const feature=featureForMethod(request.method);if(feature)this.extensions.require(feature);
    const extensionHandler=this.extensionRoutes.get(request.method);if(extensionHandler)return extensionHandler(request,client);
    switch (request.method) {
      case 'state': return this.snapshot();
      case 'shutdown':
        await this.stopAll(request.params.restoreOnOpen);
        return null;
      case 'shutdownIdle':
        if (this.live.size || this.starting.size) throw new Error('请先停止全部终端，再更新后台');
        if (this.historyBusy.size || this.editingProjects.size || this.pendingWork > 1) throw new Error('后台正在处理数据，请稍后重试');
        this.closing = true;
        return null;

    }
    throw new Error('对应插件未启用或接口尚未注册，请在设置 → 插件中检查');
  }

  private async runRemoteCommand(client:Client,p:Extract<Request,{method:'remoteCommand'}>['params']) {
    this.assertOwnSession(p.sessionId,client);
    const started=performance.now(),remote=this.remote(p.sessionId,p.runId);
    remote.activity.execute(client,p.requestId,p.command,text=>remote.transport.writeManaged(p.requestId,p.command,text),p.atPrompt);
    const first=await remote.activity.readOutput(p.requestId,0,p.maxChars,p.waitMs,p.waitFor??'completion',client.abort.signal,p.mode);
    // Explicit streaming mode may coalesce the first chunk; ordinary commands
    // wait for their completion marker instead of returning at first output.
    if(p.waitFor==='output'&&first.status==='running'&&first.output.text&&!client.abort.signal.aborted){
      const remaining=Math.max(0,p.waitMs-(performance.now()-started));
      if(remaining)await remote.activity.wait(p.requestId,Math.min(75,remaining),client.abort.signal);
    }
    return {...remote.activity.result(p.requestId,0,p.maxChars,p.mode,p.search),requestMs:performance.now()-started};
  }

  private agentVersion(id: string): number { return this.agentVersions.get(id) ?? 0; }
  private integration(session: import('../shared/protocol').Session) { return session.agent.startsWith('agent:') ? this.store.agent(session.agent).integration ?? session.agent : session.agent; }
  private async integratedHistory(session: import('../shared/protocol').Session, file: string | null): Promise<History> {
    const project = this.store.project(session.projectId).path;
    if (session.agent.startsWith('agent:') && this.store.agent(session.agent).plugin?.history) return this.plugins.history(this.store.agent(session.agent), session, project, file);
    const provider = this.integration(session);
    if (!file && provider === 'opencode' && session.nativeSessionId) return this.nativeDiscovery.opencode.history(session.nativeSessionId, project);
    if (!file && provider === 'claude' && session.nativeSessionId) file = (await this.nativeDiscovery.list('claude', project)).find(item => item.nativeSessionId === session.nativeSessionId)?.path ?? null;
    if (!file) throw new Error('请先关联原生记录文件');
    return readHistory(file, provider, project);
  }
  private assertAgentVersion(id: string, version: number): void {
    if (this.agentVersion(id) !== version) throw new Error('Agent 插件已更新，请重新读取或重试');
  }

  private async importHistory(sessionId: string, file: string | null): Promise<unknown> {
    this.reserveHistory(sessionId);
    this.historyWrites.add(sessionId);
    try {
      const session = this.store.session(sessionId);
      const version = this.agentVersion(session.agent);
      const history = await this.integratedHistory(session, file);
      if (this.closing) throw new Error('后台正在退出');
      this.assertAgentVersion(session.agent, version);
      if (this.nativeTracking.get(sessionId)?.hookNativeId !== history.nativeSessionId) this.nativeTracking.delete(sessionId);
      this.store.saveHistory(sessionId, history); this.changed(); return history;
    } finally { this.historyBusy.delete(sessionId); this.historyWrites.delete(sessionId); }
  }

  private requireHistoryAvailable(sessionId: string): void {
    this.requireProjectAvailable(this.store.session(sessionId).projectId);
    if (this.starting.has(sessionId)) throw new Error('终端正在启动，请稍后修改原生会话关联');
    if (this.historyBusy.has(sessionId)) throw new Error('此会话正在读取对话记录，请稍后重试');
  }
  private reserveHistory(sessionId: string): void {
    this.requireHistoryAvailable(sessionId);
    if (this.historyBusy.size >= 2) throw new Error('正在读取其他对话记录，请稍后重试');
    this.historyBusy.add(sessionId);
  }
  private async discoverHistories(sessionId: string, pagination: HistoryQuery) {
    this.requireHistoryAvailable(sessionId);
    const session = this.store.session(sessionId);
    if (['codex', 'claude', 'opencode'].includes(this.integration(session)) && !(session.agent.startsWith('agent:') && this.store.agent(session.agent).plugin?.list)) {
      this.reserveHistory(sessionId);
      try {
        const version = this.agentVersion(session.agent);
        const items = await this.nativeDiscovery.list(this.integration(session), this.store.project(session.projectId).path);
        if (this.closing) throw new Error('后台正在退出');
        this.assertAgentVersion(session.agent, version);
        const query = pagination.query.toLowerCase();
        const filtered = items.filter(item => `${item.nativeSessionId} ${item.title}`.toLowerCase().includes(query));
        const offset = pagination.cursor ? Number(pagination.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('分页已失效，请刷新');
        const page = filtered.slice(offset, offset + pagination.limit);
        for (const item of page) if (!this.store.nativeHistory(sessionId, item.nativeSessionId)) this.store.saveHistoryEntry(sessionId, { messages: [], warnings: [], path: item.path, nativeSessionId: item.nativeSessionId });
        return { items: page, nextCursor: offset + page.length < filtered.length ? String(offset + page.length) : null, warnings: [] };
      } finally { this.historyBusy.delete(sessionId); }
    }
    if (!session.agent.startsWith('agent:') || !this.store.agent(session.agent).plugin?.list) return { items: [], nextCursor: null, warnings: ['此类型未提供会话发现；可导入多个原生记录文件或手动关联 ID'] };
    this.reserveHistory(sessionId);
    try {
      const version = this.agentVersion(session.agent);
      const result = await this.plugins.list(this.store.agent(session.agent), session, this.store.project(session.projectId).path, pagination);
      if (this.closing) throw new Error('后台正在退出');
      this.assertAgentVersion(session.agent, version);
      return result;
    } finally { this.historyBusy.delete(sessionId); }
  }
  private async previewHistory(sessionId: string, nativeSessionId: string, refresh: boolean): Promise<History> {
    this.requireHistoryAvailable(sessionId);
    const cached = this.store.nativeHistory(sessionId, nativeSessionId);
    if (cached && !refresh && (cached.messages.length || !cached.path && !['claude', 'opencode'].includes(this.integration(this.store.session(sessionId))))) return cached;
    const session = this.store.session(sessionId);
    const agent = session.agent.startsWith('agent:') ? this.store.agent(session.agent) : null;
    if (!agent && !cached?.path && !['claude', 'opencode'].includes(this.integration(session))) throw new Error('此记录尚未导入，请先选择原生记录文件');
    this.reserveHistory(sessionId);
    try {
      const version = this.agentVersion(session.agent);
      const history = agent && !agent.integration && !agent.plugin?.history ? { messages: [], warnings: ['此类型仅提供会话列表，没有文本读取能力'], path: null, nativeSessionId } : await this.integratedHistory({ ...session, nativeSessionId }, cached?.path ?? null);
      if (history.nativeSessionId !== nativeSessionId) throw new Error('插件返回的会话 ID 与选中会话不一致');
      if (this.closing) throw new Error('后台正在退出');
      this.assertAgentVersion(session.agent, version);
      this.store.saveHistoryEntry(sessionId, history);
      return history;
    } finally { this.historyBusy.delete(sessionId); }
  }

  private async start(sessionId: string, resume: boolean, cols: number, rows: number, remoteOwner?: 'user'|'agent'): Promise<Run> {
    const session = this.store.session(sessionId);
    this.extensions.require('workspace');
    if(session.remote)this.extensions.require('ssh');else if(session.agent!=='shell'){this.extensions.require('agents');if(['codex','claude','opencode'].includes(session.agent))this.extensions.require('agent.'+session.agent);const owner=this.extensionAgents.get(session.agent);if(owner)this.extensions.require(owner);else if(session.agent.startsWith('agent:')&&this.store.agent(session.agent).sourceId?.startsWith('ext.'))throw new Error('此 Agent 的接入插件未启用');}
    this.requireProjectAvailable(session.projectId);
    if (this.live.has(sessionId) || this.starting.has(sessionId)) throw new Error('此会话的终端已在运行或正在启动');
    if (this.historyWrites.has(sessionId)) throw new Error('会话正在关联对话记录，请稍后启动');
    const ssh=!!session.remote,settings=this.store.settings(),limit=ssh?settings.maxSshTerminals:settings.maxActiveTerminals;
    // A connecting SSH is in both maps. Reserve each session exactly once and
    // keep local/SSH capacity independent, including concurrent starts.
    const reserved=new Set([...this.live.keys(),...this.starting]);
    const count=[...reserved].filter(id=>!this.live.get(id)?.closed&&!!this.store.session(id).remote===ssh).length;
    if(count>=limit)throw new Error(`${ssh?'SSH 会话':'本机终端'}已达上限 ${limit}，请在设置中调整或停止一个${ssh?' SSH 会话':'本机终端'}`);
    this.starting.add(sessionId);
    try { return await this.spawn(sessionId, resume, cols, rows, remoteOwner); }
    finally { this.starting.delete(sessionId); }
  }

  private validateRemote(config: { remote: unknown; agent: string; command: string }): void {
    if (config.remote && typeof config.remote === 'object' && 'connectionId' in config.remote && typeof config.remote.connectionId === 'string') this.store.sshConnection(config.remote.connectionId);
    if (config.remote && (config.agent !== 'shell' || config.command.trim())) throw new Error('远程会话请选择默认终端；Agent 通过 MCP 操作此终端');
  }
  private async spawn(sessionId: string, resume: boolean, cols: number, rows: number, remoteOwner?: 'user'|'agent'): Promise<Run> {
    const session = this.store.session(sessionId);
    const projectPath = this.store.project(session.projectId).path;
    const version = this.agentVersion(session.agent);
    let command = resume && session.agent.startsWith('agent:')
      ? await this.plugins.resume(this.store.agent(session.agent), session, projectPath)
      : launchCommand(session, resume);
    if (this.integration(session) === 'opencode') command = await openCodeLaunch(command, projectPath);
    const config = session.terminal ?? this.store.settings().terminal;
    let cwd: string;
    let selected: { file: string; args: string[] };
    try {
      cwd = await directory(this.store.project(session.projectId).path);
      selected = session.remote?.connectionId ? { file: 'SSH', args: [] } : await resolveTerminal(session.remote ? { profile: 'custom', executable: 'ssh', args: [] } : config);
    } catch (error) {
      if (!this.closing) {
        const failed = this.store.createRun(sessionId, command, cols, rows, config.profile === 'custom' ? config.executable : '');
        this.store.finish(failed.id, 'failed', null, error instanceof Error ? error.message : String(error), '', 0, cols, rows); this.changed();
      }
      throw error;
    }
    if (this.closing) throw new Error('后台无法再启动终端');
    if (this.agentOwners.get(sessionId)?.disposing) throw new Error('SSH 连接已取消，Agent 正在清理自己的连接');
    if (resume && session.agent.startsWith('agent:')) this.assertAgentVersion(session.agent, version);
    const provider = this.integration(session);
    const trackNative = !resume && !session.remote && (['codex', 'claude', 'opencode'].includes(provider) || session.agent.startsWith('agent:') && !!this.store.agent(session.agent).plugin?.list);
    let baseline: NativeCandidate[] | null = [];
    // OpenCode hooks carry the exact native ID. Do not start another OpenCode
    // process or poll its database just to launch an existing TUI.
    if (trackNative && provider !== 'opencode') { try { baseline = await this.nativeCandidates(sessionId); } catch (error) { baseline = null; this.logError(error); } }
    const run = this.store.createRun(sessionId, command, cols, rows, selected.file, remoteOwner !== undefined);
    const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true, windowsPty: session.remote ? undefined : windowsPtyFor(process.platform, release()) });
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    const mouseEncoding = trackMouseEncoding(terminal);
    let child: TerminalProcess;
    let remote: LiveTerminal['remote'];
    try {
      if (session.remote) {
        const activity = new RemoteActivity({ sessionId, runId: run.id, host: session.remote.host, connection: 'connecting', owner: remoteOwner ?? 'user', phase: 'unknown', cwd: null, error: null }, this.store, data => this.broadcast({ event: 'remote', data }), data => this.broadcast({ event: 'remoteAction', data }), path.join(this.dataDirectory,'command-output',run.id));
        const profile = session.remote.connectionId ? this.store.sshConnection(session.remote.connectionId) : null;
        const transport = profile ? new SshTerminal(profile, sessionId, session.remote.directory, cols, rows, {
          credentials: async () => (await this.challenge(profile,'credentials')).secret ?? {},
          verify: async fingerprint => {
            const trusted = this.store.sshFingerprint(profile.id);
            if (trusted === fingerprint) return true;
            if (trusted) throw new Error('SSH 主机指纹已改变，请删除并重新创建连接以重新确认服务器身份');
            const accepted = (await this.challenge(profile,'hostKey',fingerprint)).accepted === true;
            if (accepted) this.store.trustSshFingerprint(profile.id,fingerprint);
            return accepted;
          },
        }, update => activity.change(update), (kind,status,cwd,requestId) => activity.marker(kind,status,cwd,requestId))
          : new RemoteTerminal(session.remote, sessionId, cols, rows, update => activity.change(update), (kind,status,cwd,requestId) => activity.marker(kind,status,cwd,requestId), selected.file);
        remote = { transport, activity }; child = transport;
      } else child = this.spawnPty(selected.file, selected.args, { cwd, cols, rows, name: 'xterm-256color', env: { ...terminalEnvironment(selected.file), AGENTBERTH_DATA_DIR: this.dataDirectory, AGENTBERTH_SESSION_ID: sessionId, AGENTBERTH_RUN_ID: run.id, AGENTBERTH_AGENT: provider, AGENTBERTH_NATIVE_SESSION_ID: resume ? session.nativeSessionId ?? '' : '' } });
    }
    catch (error) {
      terminal.dispose();
      this.store.finish(run.id, 'failed', null, String(error), '', 0, cols, rows); this.changed(); throw error;
    }
    this.store.setPid(run.id, child.pid);
    const live: LiveTerminal = { run: this.store.run(run.id), pty: child, remote, terminal, serialize, mouseEncoding, seq: 0, committedSeq: 0, queuedBytes: 0, stopping: false, closed: false, finishing: null, log: run.recordOutput ? new RunLog(this.logs, run.id) : null, output: [], outputBytes: 0, outputTimer: null };
    if (remote) terminal.onData(data => { try { remote.transport.write(data); } catch { /* Reconnect redraw will negotiate again. */ } });
    this.live.set(sessionId, live);
    if (remote && remoteOwner === 'agent') {
      // Allow the resumed MCP to reclaim its exact connection while SSH is
      // authenticating; never overwrite a client that has already reclaimed it.
      const abort = new AbortController(); abort.abort();
      this.agentOwners.set(sessionId,{id:randomUUID(),disposing:false,subscriptions:new Set(),activity:new Map(),pending:0,abort});
      this.restoredRuns.set(sessionId,{previousRunId:this.recoveryPending.get(sessionId)?.runId ?? null,runId:run.id});
    }
    // Fresh TUI launches never inherit an old recovery ID, even without discovery support.
    if (!resume && !session.remote && session.agent !== 'shell') this.store.saveHistory(sessionId, { messages: [], warnings: [], path: null, nativeSessionId: null });
    if (trackNative) {
      const peers = [...this.nativeTracking.keys()].filter(id => { const peer = this.store.session(id); return peer.projectId === session.projectId && this.integration(peer) === provider; });
      peers.forEach(id => { this.nativeTracking.get(id)!.ambiguous = true; });
      this.nativeTracking.set(sessionId, { runId: run.id, baseline: new Set((baseline ?? []).map(item => item.nativeSessionId)), started: Date.now(), ambiguous: provider === 'opencode' || peers.length > 0 || baseline === null });
      this.scheduleNativeScan();
    } else if (resume && !session.remote && ['claude', 'opencode'].includes(provider)) {
      // Resume keeps the selected ID; a later /new can still announce its exact
      // replacement. Manual association/unlink during this run deletes tracking.
      this.nativeTracking.set(sessionId, { runId: run.id, baseline: new Set(), started: Date.now(), ambiguous: true, hookNativeId: session.nativeSessionId ?? undefined });
    }
    this.changed(); // Make connection startup visible and cancellable in the sidebar.
    this.pruneLogs();
    child.onData(text => {
      if (live.closed) return;
      live.remote?.activity.capture(text);
      const bytes = Buffer.byteLength(text);
      live.queuedBytes += bytes;
      if (live.queuedBytes > 1024 * 1024) child.pause();
      live.output.push(text); live.outputBytes += bytes;
      if (live.outputBytes >= 64 * 1024) this.flushOutput(live);
      else live.outputTimer ??= setTimeout(() => this.flushOutput(live), 16);
    });
    let connectedRun = false, startupExit: number | null = null;
    child.onExit(({ exitCode }) => { if (remote && !connectedRun) { startupExit = exitCode; return; } void this.finish(sessionId, live, exitCode); });
    if (remote) {
      try { await remote.transport.connect(); this.store.setPid(run.id, child.pid); live.run = this.store.run(run.id); }
      catch (error) {
        remote.transport.kill(); remote.activity.finish();
        if (live.stopping || live.closed) { await this.finish(sessionId,live,null); throw new Error('SSH 连接已取消'); }
        this.live.delete(sessionId); terminal.dispose();
        this.store.finish(run.id, 'failed', null, String(error), '', 0, cols, rows); this.changed(); throw error;
      }
    } else if (command) child.write(`${command}\r`);
    connectedRun = true;
    if (startupExit !== null) await this.finish(sessionId, live, startupExit);
    this.changed();
    return live.run;
  }

  private async nativeCandidates(sessionId: string): Promise<NativeCandidate[] | null> {
    const session = this.store.session(sessionId), project = this.store.project(session.projectId).path;
    if (!session.agent.startsWith('agent:') || !this.store.agent(session.agent).plugin?.list) return this.nativeDiscovery.list(this.integration(session), project);
    const version = this.agentVersion(session.agent);
    const page = await this.plugins.list(this.store.agent(session.agent), session, project, { cursor: null, limit: 50, query: '' });
    this.assertAgentVersion(session.agent, version);
    // Incomplete discovery cannot establish a safe before/after baseline.
    if (page.nextCursor || page.warnings.length) return null;
    return page.items.map(item => ({ ...item, modified: item.updatedAt ? Date.parse(item.updatedAt) : 0 }));
  }
  private scheduleNativeScan(): void {
    if (this.nativeTimer || this.closing || ![...this.nativeTracking.values()].some(item => !item.ambiguous)) return;
    this.nativeTimer = setTimeout(() => {
      this.nativeTimer = null;
      this.nativeScanning = (async () => { for (const id of this.nativeTracking.keys()) await this.scanNativeHistory(id); })().catch(error => this.logError(error)).finally(() => { this.nativeScanning = null; this.scheduleNativeScan(); });
    }, 2000);
    this.nativeTimer.unref();
  }
  private async scanNativeHistory(sessionId: string): Promise<void> {
    const tracking = this.nativeTracking.get(sessionId);
    if (!tracking || tracking.ambiguous || this.historyBusy.has(sessionId) || this.historyWrites.has(sessionId)) return;
    try {
      const session = this.store.session(sessionId);
      if (session.latestRun?.id !== tracking.runId || session.nativeSessionId) { this.nativeTracking.delete(sessionId); return; }
      const items = await this.nativeCandidates(sessionId);
      if (!items) return;
      const claimed = new Set(this.store.state().sessions.filter(item => item.id !== sessionId && item.projectId === session.projectId && this.integration(item) === this.integration(session)).flatMap(item => item.nativeSessionId ? [item.nativeSessionId] : []));
      const candidate = unambiguousNewHistory(items, tracking.baseline, tracking.started, claimed);
      if (!candidate) return;
      // Recheck after I/O so manual association, unlink, or a new run wins.
      const current = this.store.session(sessionId);
      if (this.nativeTracking.get(sessionId) !== tracking || current.latestRun?.id !== tracking.runId || current.nativeSessionId || this.historyBusy.has(sessionId)) return;
      this.store.saveHistory(sessionId, { messages: [], warnings: [], path: candidate.path, nativeSessionId: candidate.nativeSessionId });
      if (this.integration(session) === 'claude') { tracking.ambiguous = true; tracking.hookNativeId = candidate.nativeSessionId; }
      else this.nativeTracking.delete(sessionId);
      this.changed();
    } catch (error) { this.logError(error); }
  }

  private requireProjectAvailable(id: string): void {
    this.store.project(id);
    if (this.editingProjects.has(id)) throw new Error('项目正在更新，请稍后重试');
  }
  private requireIdle(id: string): void {
    if (this.live.has(id) || this.starting.has(id)) throw new Error('请先停止终端，再编辑启动配置或删除');
    if (this.historyBusy.has(id)) throw new Error('会话正在读取对话记录，请稍后重试');
  }
  private removeLogs(runIds: string[]): void {
    for (const id of runIds) for (const suffix of ['', '.1', '.2', '.3']) {
      try { rmSync(path.join(this.logs, `${id}.log${suffix}`), { force: true }); } catch (error) { this.logError(error); }
    }
  }

  private async screen(live: LiveTerminal, serialize = true): Promise<{ snapshot: string; seq: number; cols: number; rows: number }> {
    this.flushOutput(live);
    // This callback follows all prior writes. seq and the screen describe the same point in time.
    return new Promise(resolve => live.terminal.write('', () => resolve({ snapshot: serialize ? (live.serialize.serialize({ scrollback: 200 }) + live.mouseEncoding()) : '', seq: live.committedSeq, cols: live.terminal.cols, rows: live.terminal.rows })));
  }
  private flushOutput(live: LiveTerminal): void {
    if (live.outputTimer) clearTimeout(live.outputTimer);
    live.outputTimer = null;
    if (!live.output.length) return;
    const text = live.output.join(''), bytes = live.outputBytes, seq = ++live.seq;
    live.output = []; live.outputBytes = 0;
    try { live.log?.append(text); } catch (error) { this.logError(error); }
    live.terminal.write(text, () => {
      live.committedSeq = seq; live.queuedBytes -= bytes;
      if (live.queuedBytes < 512 * 1024 && !live.closed) live.pty.resume();
      this.broadcast({ event: 'output', data: { sessionId: live.run.sessionId, runId: live.run.id, seq, text } });
    });
  }
  private async attach(sessionId: string): Promise<Attachment> {
    const session = this.store.session(sessionId);
    const live = this.live.get(sessionId);
    if (live) return { run: this.store.run(live.run.id), ...await this.screen(live) };
    if (session.latestRun) return { run: session.latestRun, ...this.store.savedScreen(session.latestRun.id) };
    return { run: null, snapshot: '', seq: 0, cols: 100, rows: 30 };
  }
  private finish(sessionId: string, live: LiveTerminal, exitCode: number | null): Promise<void> {
    if (live.finishing) return live.finishing;
    live.closed = true;
    // Publish one completion promise before cleanup can trigger another exit.
    live.finishing = Promise.resolve().then(async () => {
      live.remote?.activity.finish();
      if (this.nativeTracking.has(sessionId)) {
        if (this.nativeScanning) await this.nativeScanning;
        await this.scanNativeHistory(sessionId);
        if (this.nativeTracking.get(sessionId) && !this.nativeTracking.get(sessionId)!.ambiguous && !this.closing) {
          await new Promise(resolve => setTimeout(resolve, 150));
          await this.scanNativeHistory(sessionId);
        }
        this.nativeTracking.delete(sessionId);
      }
      const session = this.store.session(sessionId);
      if (!session.remote && session.nativeSessionId && !this.historyBusy.has(sessionId)) {
        try {
          const version = this.agentVersion(session.agent);
          const history = !this.closing && (session.transcriptPath || this.integration(session) === 'opencode' || session.agent.startsWith('agent:') && this.store.agent(session.agent).plugin?.history) ? await this.integratedHistory(session, session.transcriptPath) : null;
          this.assertAgentVersion(session.agent, version);
          if (history && history.nativeSessionId === session.nativeSessionId && this.store.session(sessionId).nativeSessionId === session.nativeSessionId && !this.historyBusy.has(sessionId)) this.store.saveHistory(sessionId, history);
        } catch (error) { this.logError(error); } // Keep a valid recovery ID if the transcript cannot be read.
      }
      // Dispose ConPTY's output worker as well as the terminated process.
      if (process.platform === 'win32') {
        try { live.pty.kill(); } catch (error) { this.logError(error); }
      }
      const screen = await this.screen(live, !!live.run.recordOutput);
      this.store.finish(live.run.id, live.stopping ? 'stopped' : 'exited', exitCode, null, screen.snapshot, screen.seq, screen.cols, screen.rows);
      if (this.live.get(sessionId) === live) this.live.delete(sessionId);
      live.terminal.dispose();
      this.changed();
    });
    return live.finishing;
  }
  private async stop(sessionId: string): Promise<void> {
    this.store.session(sessionId);
    const live = this.live.get(sessionId);
    if (!live || live.closed || live.stopping) return;
    live.stopping = true; this.store.stopping(live.run.id); this.changed();
    try {
      await this.transfers.stopSession(sessionId);
      if (live.remote) { await live.remote.transport.stop(); await this.finish(sessionId,live,null); }
      else {
        await terminateTree(live.pty as pty.IPty, () => this.live.get(sessionId) === live && !live.closed);
        // Tree termination includes an actual PID-exit check. ConPTY may not
        // deliver onExit when stopped before its first output; do not leave a
        // confirmed-dead process in "stopping" waiting for that notification.
        if (process.platform === 'win32') await this.finish(sessionId, live, null);
      }
      // Remote stop emits exit synchronously; await the queued screen flush
      // and durable status update before acknowledging that stop completed.
      if (live.finishing) await live.finishing;
    }
    catch (error) {
      this.logError(error);
      if (!live.closed) { live.stopping = false; this.store.running(live.run.id); this.changed(); throw new Error('停止终端失败，请重试'); }
    }
  }
  private pruneLogs(): void {
    const active = new Set([...this.live.values()].map(item => item.run.id));
    const files = readdirSync(this.logs).filter(name => /^[a-f0-9-]+\.log(?:\.[123])?$/.test(name)).map(name => ({ name, ...statSync(path.join(this.logs, name)) })).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= 128 * 1024 * 1024) break;
      if (active.has(file.name.split('.log')[0])) continue;
      rmSync(path.join(this.logs, file.name), { force: true }); total -= file.size;
    }
  }
  private logError(error: unknown): void {
    try { const log = new RunLog(this.dataDirectory, 'daemon'); log.append(`${new Date().toISOString()} ${String(error)}\n`); } catch { /* Disk failure must not throw from PTY callbacks. */ }
  }
  private async stopAll(restoreOnOpen = false): Promise<void> {
    this.closing = true;
    try {
      if (restoreOnOpen) this.checkpointWorkspace();
      // Drain in-flight SSH startup before closing the local channels.
      const startupDeadline = Date.now() + 45000;
      while (this.starting.size && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (this.starting.size) throw new Error('远端连接尚未完成，请稍后再次退出；后台保留以便确认清理');
      if (this.recovering) await this.recovering;
      await this.resources.close();
      await this.transfers.close();
      await this.git.close();
      const results = await Promise.allSettled([...this.live.keys()].map(sessionId => this.stop(sessionId)));
      for (const result of results) if (result.status === 'rejected') this.logError(result.reason);
      await this.plugins.close();
      await this.nativeDiscovery.opencode.close();
      const deadline = Date.now() + 5000;
      while (this.live.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (this.live.size) throw new Error('部分终端尚未停止，请重试退出；后台已保留以便继续清理');
    } catch (error) { this.closing = false; throw error; }
  }
  async close(): Promise<void> {
    if (this.nativeTimer) clearTimeout(this.nativeTimer);
    this.nativeTimer = null;
    if(this.mcpStatsTimer)clearTimeout(this.mcpStatsTimer);this.mcpStatsTimer=null;
    await this.stopAll();
    await this.extensions.close();
    await new Promise<void>(resolve => {
      // Keep the shutdown reply and close frame ordered on the wire. Immediate
      // terminate() can reset a socket before its peer reads the final reply.
      for (const socket of this.clients.keys()) socket.close(1000, 'Backend stopped');
      const deadline=setTimeout(()=>{for(const socket of this.clients.keys())socket.terminate();},1000);
      this.ws.close(()=>{clearTimeout(deadline);resolve();});
    });
    await new Promise<void>(resolve => this.http.close(() => resolve()));
    rmSync(path.join(this.dataDirectory, 'runtime.json'), { force: true });
    this.store.close();
  }
}
