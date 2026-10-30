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

interface LiveTerminal {
  run: Run; pty: TerminalProcess; remote?: { transport: RemoteTerminal | SshTerminal; activity: RemoteActivity }; terminal: Terminal; serialize: SerializeAddon; mouseEncoding: () => string;
  seq: number; committedSeq: number; queuedBytes: number; stopping: boolean; closed: boolean;
  log: RunLog | null;
  output: string[]; outputBytes: number; outputTimer: NodeJS.Timeout | null; finishing: Promise<void> | null;
}
interface Client { id: string; disposing: boolean; subscriptions: Set<string>; activity: Map<string, string>; pending: number; abort: AbortController }

export class DaemonServer {
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
  private nativeTracking = new Map<string, { runId: string; baseline: Set<string>; started: number; ambiguous: boolean; hookNativeId?: string }>();
  private nativeTimer: NodeJS.Timeout | null = null;
  private nativeScanning: Promise<void> | null = null;
  private historyBusy = new Set<string>();
  private historyWrites = new Set<string>();
  private starting = new Set<string>();
  private editingProjects = new Set<string>();

  constructor(readonly dataDirectory: string, private onShutdown: () => void = () => {}, private spawnPty: typeof pty.spawn = pty.spawn, nativeDiscovery?: NativeDiscovery) {
    if (nativeDiscovery) this.nativeDiscovery = nativeDiscovery;
    this.store = new Store(dataDirectory);
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
        void this.dispatch(result.data, client).then(value => this.send(socket, { id: result.data.id, result: value })).catch(error => this.send(socket, { id: result.data.id, error: error instanceof Error ? error.message : '操作失败', ...(error instanceof RemoteOperationError?{errorCode:error.code,errorDetails:error.details}:{}) })).finally(() => {
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
  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // A slow or closed UI must never stop output consumption by the daemon.
    // Two bounded image replies can overlap; a slow UI still has a finite budget.
    if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.close(1013, 'Reconnect to restore terminal'); return; }
    socket.send(JSON.stringify(message));
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
    const state = this.store.state(), valid = new Set(state.sessions.map(session => session.id));
    for (const id of this.agentOwners.keys()) if (!valid.has(id)) this.agentOwners.delete(id);
    for (const client of this.clients.values()) for (const id of client.activity.keys()) if (!valid.has(id)) client.activity.delete(id);
    this.broadcast({ event: 'state', data: state });
  }

  async listen(): Promise<RuntimeInfo> {
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
    switch (request.method) {
      case 'sshConnections': return this.store.sshConnections();
      case 'registerSshProvider': {
        if (this.sshProvider && this.sshProvider !== client) throw new Error('SSH 登录提供端已连接');
        this.sshProvider = client; return null;
      }
      case 'sshChallengeReply': {
        const pending = this.sshChallenges.get(request.params.challengeId);
        if (!pending || pending.client !== client) throw new Error('登录请求已过期');
        pending.resolve(request.params); return null;
      }
      case 'saveSshConnection': {
        if (request.params.connectionId) for (const session of this.store.state().sessions) if (session.remote?.connectionId === request.params.connectionId) this.requireIdle(session.id);
        const profile = this.store.saveSshConnection(request.params.config, request.params.connectionId); this.changed(); return profile;
      }
      case 'deleteSshConnection': this.store.deleteSshConnection(request.params.connectionId); return null;
      case 'mcpMetrics': return this.mcpStats.snapshot();
      case 'mcpRecordCall': {
        this.mcpStats.record(request.params);
        if(!this.mcpStatsTimer)this.mcpStatsTimer=setTimeout(()=>{this.mcpStatsTimer=null;this.broadcast({event:'mcpMetrics',data:this.mcpStats.snapshot()});},150);
        return null;
      }
      case 'remoteAliases': return this.store.sshConnections().map(profile => ({ alias: profile.alias, allowAgent: profile.allowAgent }));
      case 'remoteAgentRecover': {
        const recovered: string[] = [];
        for (const target of request.params.targets) {
          const owner = this.agentOwners.get(target.sessionId), live = this.live.get(target.sessionId);
          if (owner?.abort.signal.aborted && live?.run.id === target.runId) { this.agentOwners.set(target.sessionId, client); recovered.push(target.sessionId); }
        }
        return { recovered };
      }
      case 'remoteAgentClose': {
        if(client.disposing)throw new Error('Agent 上下文正在清理，请等待完成');
        const sessions = this.store.state().sessions.filter(session => this.agentOwners.get(session.id) === client);
        for (const session of sessions) {
          const activity=this.live.get(session.id)?.remote?.activity;
          if(activity&&(!this.starting.has(session.id)||activity.controlChosen))activity.assertManage(client);
          const work = this.store.unresolvedRemoteAction(session.id);
          if (work && (work.status === 'running' || request.params.deleteHistory)) throw new RemoteOperationError('CLEANUP_BLOCKED', '此上下文仍有运行中或结果不明的任务；继续查询原任务，完成或明确取消后再清理。不要为了清理重放命令。', { sessionId: session.id, runId: work.runId, ...(work.kind === 'transfer' ? { transferId: work.id } : { actionId: work.id }) });
        }
        client.disposing = true;
        try {
          const opening = [...this.openingAliases].filter(([key]) => key.startsWith(client.id + ':')).map(([,promise]) => promise);
          await Promise.all(sessions.map(session => this.stop(session.id)));
          await Promise.allSettled(opening);
          const closed = sessions.map(session => session.id), deleted: string[] = [];
          if (request.params.deleteHistory) for (const session of sessions) {
            if (this.live.has(session.id) || this.starting.has(session.id)) continue;
            this.removeLogs(this.store.deleteSession(session.id)); deleted.push(session.id);
          }
          this.changed();
          return { closed, deleted, retained: closed.filter(id => !deleted.includes(id)) };
        } finally { client.disposing = false; }
      }
      case 'remoteAgentSessions': {
        const state = this.store.state();
        return { connections: this.store.sshConnections().map(profile => ({ alias: profile.alias, allowAgent: profile.allowAgent })), sessions: state.sessions.filter(session => this.agentOwners.get(session.id) === client).map(session => ({ sessionId: session.id, runId: session.latestRun?.id ?? null, title: session.title, project: state.projects.find(project => project.id === session.projectId)?.name, remote: session.remote, status: session.latestRun?.status ?? 'not-started', info: this.live.get(session.id)?.remote?.activity.info ?? null })) };
      }
      case 'remoteResolve': {
        const {session} = this.aliasTarget(request.params.alias, client);
        if (!session) throw new RemoteOperationError('SESSION_NOT_OPEN','此连接尚未打开，请先调用 terminal_open',{alias:request.params.alias});
        const live = this.terminal(session.id);
        return { sessionId: session.id, runId: live.run.id };
      }
      case 'remoteOpen': {
        if(client.disposing)throw new Error('Agent 上下文正在清理，请等待完成');
        const {profile, session: previous} = this.aliasTarget(request.params.alias, client, request.params.owner === 'user');
        if (request.params.owner === 'agent' && !profile.allowAgent) throw new Error('此连接未允许 Agent 打开，请在 SSH 设置中修改');
        const key = `${client.id}:${profile.id}:${previous?.title ?? profile.alias}`;
        const pending = this.openingAliases.get(key);
        if (pending) return pending;
        if (previous && this.live.has(previous.id)) {
          const live = this.terminal(previous.id);
          return { sessionId: previous.id, runId: live.run.id, info: live.remote!.activity.info };
        }
        const opening = (async () => {
          const project = previous ? null : this.remoteProject();
          const session = previous ?? this.store.createSession(project!.id, profile.alias, 'shell', '', null, { connectionId: profile.id, host: profile.alias, directory: '' });
          if(request.params.owner === 'agent') this.agentOwners.set(session.id, client);
          const run = await this.start(session.id, false, 100, 30);
          const activity = this.remote(session.id,run.id).activity;
          const info = activity.controlChosen ? {...activity.info} : activity.control(request.params.owner);
          if (request.params.owner === 'agent') this.remote(session.id,run.id).activity.assertManage(client);
          if (client.abort.signal.aborted) this.remote(session.id,run.id).activity.release(client);
          this.changed(); return { sessionId: session.id, runId: run.id, info };
        })();
        this.openingAliases.set(key, opening);
        try { return await opening; }
        finally { if (this.openingAliases.get(key) === opening) this.openingAliases.delete(key); }
      }
      case 'sshHosts': return sshHosts();
      case 'remoteManage': {
        const params=request.params;
        if(params.action==='create'){
          if(client.disposing)throw new Error('Agent 上下文正在清理，请等待完成');
          const profile=this.store.sshConnections().find(item=>item.alias.toLowerCase()===params.alias!.toLowerCase());
          if(!profile)throw new Error('服务器别名不存在，请先填写服务器信息');
          if(!profile.allowAgent)throw new Error('此服务器未允许 Agent 打开');
          const title=params.title??profile.alias;
          const key=`${client.id}:${profile.id}:${title}`;
          const previous=this.store.state().sessions.find(item=>item.remote?.connectionId===profile.id&&item.title===title&&this.agentOwners.get(item.id)===client);
          if(previous&&(previous.remote?.directory??'')!==(params.directory??''))throw new Error('同名 SSH 会话使用不同目录，请选择不同会话名称或停止后编辑');
          const pending=this.openingAliases.get(key);if(pending)return pending;
          const opening=(async()=>{
            const session=previous??this.store.createSession(this.remoteProject().id,title,'shell','',null,{connectionId:profile.id,host:profile.alias,directory:params.directory??''});
            this.agentOwners.set(session.id,client);
            const existing=this.live.get(session.id);if(existing)return {sessionId:session.id,runId:existing.run.id,info:existing.remote!.activity.info};
            const run=await this.start(session.id,false,100,30),activity=this.remote(session.id,run.id).activity;
            const info=activity.controlChosen?{...activity.info}:activity.control('agent');
            this.remote(session.id,run.id).activity.assertManage(client);
            if(client.abort.signal.aborted)this.remote(session.id,run.id).activity.release(client);
            this.changed();return {sessionId:session.id,runId:run.id,info};
          })();
          this.openingAliases.set(key,opening);try{return await opening;}finally{this.openingAliases.delete(key);}
        }
        const session=params.alias?this.aliasTarget(params.alias,client).session:this.store.session(params.sessionId!);
        if(!session)throw new RemoteOperationError('SESSION_NOT_OPEN','当前 Agent 尚未创建此服务器的会话',{alias:params.alias});
        this.assertOwnSession(session.id,client);
        if(!session.remote?.connectionId||!this.store.sshConnection(session.remote.connectionId).allowAgent)throw new Error('此 SSH 会话未允许 Agent 管理');
        const live=this.live.get(session.id);
        if(params.runId&&session.latestRun?.id!==params.runId)throw new Error('终端运行实例已变化，请重新读取会话列表');
        if(live){if(params.sessionId&&!params.runId)throw new Error('管理运行中的会话请同时提供 runId');live.remote!.activity.assertManage(client);}
        if(params.action==='close'){await this.stop(session.id);return this.store.session(session.id);}
        if(params.action==='delete'){
          this.requireIdle(session.id);this.removeLogs(this.store.deleteSession(session.id));this.changed();return {deleted:true,sessionId:session.id};
        }
        if(params.action==='reconnect'){
          if(!live)throw new Error('SSH 会话已停止，请调用 terminal_open');
          await live.remote!.transport.reconnect();live.remote!.activity.assertManage(client);this.changed();
          return {sessionId:session.id,runId:live.run.id,info:live.remote!.activity.info};
        }
        if(params.title===undefined&&params.directory===undefined)throw new Error('请提供会话名称或远端目录');
        const remote={...session.remote,directory:params.directory??session.remote.directory};
        if(remote.directory!==session.remote.directory)this.requireIdle(session.id);
        const updated=this.store.updateSession(session.id,params.title??session.title,'shell','',null,remote);this.changed();return updated;
      }
      case 'remoteTransferStart': {
        for(const endpoint of [request.params.source,request.params.destination])this.authorizeRemote(endpoint,client);
        const {source,destination}=request.params;
        if(source.kind==='remote'&&destination.kind==='remote'&&path.posix.normalize(source.path)===path.posix.normalize(destination.path)){
          const a=this.store.sshConnection(this.store.session(source.sessionId).remote!.connectionId!),b=this.store.sshConnection(this.store.session(destination.sessionId).remote!.connectionId!);
          if(a.hostname.toLowerCase()===b.hostname.toLowerCase()&&a.port===b.port&&a.username===b.username)throw new Error('同一服务器的源路径和目标路径相同');
        }
        return this.transfers.start(request.params);
      }
      case 'remoteTransferStatus': return this.transfers.wait(request.params.requestId,request.params.timeoutMs,client.abort.signal);
      case 'remoteTransferCancel': {
        const transfer=this.transfers.get(request.params.requestId);
        if(transfer.status!=='running')return transfer;
        if(request.params.owner==='agent')for(const endpoint of [transfer.spec.source,transfer.spec.destination])this.authorizeRemote(endpoint,client,false);
        return this.transfers.cancel(request.params.requestId);
      }
      case 'remoteTransfers': this.store.session(request.params.sessionId);return this.transfers.list(request.params.sessionId);
      case 'createRemoteSession': {
        this.validateRemote({...request.params, agent:'shell', command:''});
        const session = this.store.createSession(this.remoteProject().id, request.params.title, 'shell', '', null, request.params.remote);
        this.changed(); return session;
      }
      case 'remoteInfo': return this.live.get(request.params.sessionId)?.remote?.activity.info ?? null;
      case 'remoteActions': return this.store.remoteActions(request.params.sessionId, request.params.before);
      case 'remoteControl': return this.remote(request.params.sessionId, request.params.runId).activity.control(request.params.owner);
      case 'remoteReconnect': { const live=this.terminal(request.params.sessionId,request.params.runId); await this.remote(request.params.sessionId,request.params.runId).transport.reconnect(); this.store.setPid(live.run.id,live.pty.pid);live.run=this.store.run(live.run.id);this.changed();return null; }
      case 'remoteExecute': {
        this.assertOwnSession(request.params.sessionId,client);
        const remote = this.remote(request.params.sessionId, request.params.runId);
        return remote.activity.execute(client, request.params.requestId, request.params.command, text => remote.transport.writeManaged(request.params.requestId,request.params.command,text), request.params.atPrompt);
      }
      case 'remoteCommand': return this.runRemoteCommand(client,request.params);
      case 'remoteReadOutput': {
        const started=performance.now(),p=request.params,remote=this.remote(p.sessionId,p.runId);
        this.recoverReadTarget(p.sessionId,client);
        const actionId=p.actionId??remote.activity.latestOutputCommand()?.id;
        if(!actionId)throw new RemoteOperationError('NO_COMMAND_OUTPUT','当前没有已捕获的命令结果；普通命令使用 terminal_execute，交互程序使用 terminal_interact。不要重跑此前结果未知的输入。',{sessionId:p.sessionId,runId:p.runId});
        if(p.search&&p.waitFor==='completion')await remote.activity.wait(actionId,p.timeoutMs,client.abort.signal);
        const value=p.search?remote.activity.result(actionId,p.cursor,p.maxChars,p.mode,p.search):await remote.activity.readOutput(actionId,p.cursor,p.maxChars,p.timeoutMs,p.waitFor,client.abort.signal,p.mode);
        return {...value,requestMs:performance.now()-started};
      }
      case 'remoteKeys': {
        this.assertOwnSession(request.params.sessionId,client);
        const remote = this.remote(request.params.sessionId, request.params.runId), { key, text, enter } = request.params;
        if(text!==undefined&&enter&&text.trim()&&remote.activity.info.phase==='idle'&&remote.activity.info.commandTracking==='posix'){
          return this.runRemoteCommand(client,{sessionId:request.params.sessionId,runId:request.params.runId,command:text,requestId:randomUUID(),atPrompt:false,waitMs:5000,waitFor:'completion',maxChars:32768,mode:'summary'});
        }
        remote.activity.keys(client, key ? remoteKeys[key] : text! + (enter ? '\r' : ''), key ? `按键 ${key}` : `输入文本（${text!.length} 字符${enter?'，回车':''}）`, data => remote.transport.write(data)); return {inputKind:'interactive',info:{...remote.activity.info}};
      }
      case 'remoteWait': {
        const remote=this.remote(request.params.sessionId,request.params.runId);this.recoverReadTarget(request.params.sessionId,client);
        return remote.activity.wait(request.params.actionId,request.params.timeoutMs,client.abort.signal);
      }
      case 'remoteScreen': {
        const live = this.terminal(request.params.sessionId, request.params.runId);
        if (!live.remote) throw new Error('此会话不是远程终端');
        this.recoverReadTarget(request.params.sessionId,client);
        const screen = await this.screen(live,false);
        const buffer = live.terminal.buffer.active, lines: string[] = [];
        for (let row = buffer.baseY; row < buffer.baseY + live.terminal.rows; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
        const command=live.remote.activity.latestCommand();
        return { scope:'viewport', scrollbackLines:buffer.baseY, command:command?{id:command.id,status:command.status,sessionId:command.sessionId,runId:command.runId}:null, seq: screen.seq, cols: screen.cols, rows: screen.rows, text: lines.join('\n'), cursor: { x: buffer.cursorX, y: buffer.cursorY }, info: live.remote.activity.info };
      }
      case 'state': return this.store.state();
      case 'resources': return this.resources.sample([...this.live.entries()].filter(([,live])=>!live.closed && !live.remote).map(([sessionId,live])=>({sessionId,projectId:this.store.session(sessionId).projectId,runId:live.run.id,pid:live.pty.pid})),request.params.appPids);
      case 'gitStatus': return this.git.status(this.store.project(request.params.projectId).path);
      case 'gitDiff': return this.git.diff(this.store.project(request.params.projectId).path, request.params);
      case 'projectFiles': return this.files.list(this.store.project(request.params.projectId).path, request.params.path, request.params.offset, request.params.limit);
      case 'findProjectFiles': return this.files.search(this.store.project(request.params.projectId).path, request.params.query);
      case 'previewFile': return this.files.preview(this.store.project(request.params.projectId).path, request.params.path);
      case 'gitOperation': {
        const params = request.params, project = this.store.project(params.projectId);
        this.requireProjectAvailable(project.id);
        const status = await this.git.status(project.path);
        if (this.closing) throw new Error('后台正在退出');
        const within = (a: string,b: string) => { const relative=path.relative(a,b);return relative!== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative); };
        const affected = this.store.state().projects.filter(item => within(status.root,item.path) || within(item.path,status.root));
        for (const item of affected) this.requireProjectAvailable(item.id);
        for (const item of affected) if (this.gitBusy.has(item.id)) throw new Error('此仓库正在执行 Git 操作，请稍后重试');
        for (const item of affected) this.gitBusy.add(item.id);
        try { return await this.git.operate(project.path,params); }
        finally { for (const item of affected) this.gitBusy.delete(item.id); }
      }
      case 'shutdown':
        await this.stopAll();
        setTimeout(this.onShutdown, 50); // Acknowledge cleanup before closing the authenticated connection.
        return null;
      case 'shutdownIdle':
        if (this.live.size || this.starting.size) throw new Error('请先停止全部终端，再更新后台');
        if (this.historyBusy.size || this.editingProjects.size || this.pendingWork > 1) throw new Error('后台正在处理数据，请稍后重试');
        this.closing = true;
        setTimeout(this.onShutdown, 50);
        return null;
      case 'createProject': {
        const canonical = await directory(request.params.path);
        if (this.closing) throw new Error('后台正在退出');
        const project = this.store.createProject(request.params.name, canonical); this.changed(); return project;
      }
      case 'updateProject': {
        const { projectId, name } = request.params;
        this.requireProjectAvailable(projectId);
        if (this.gitBusy.has(projectId)) throw new Error('Git 操作期间请等待完成后再修改项目');
        this.editingProjects.add(projectId);
        try {
          const previous = this.store.project(projectId);
          const canonical = await directory(request.params.path);
          if (this.closing) throw new Error('后台正在退出');
          if (!sameDirectory(previous.path, canonical)) for (const id of this.store.projectSessionIds(projectId)) this.requireIdle(id);
          const project = this.store.updateProject(projectId, name, canonical); this.changed(); return project;
        } finally { this.editingProjects.delete(projectId); }
      }
      case 'deleteProject': {
        const id = request.params.projectId;
        this.requireProjectAvailable(id);
        if (this.gitBusy.has(id)) throw new Error('Git 操作期间请等待完成后再删除项目');
        for (const sessionId of this.store.projectSessionIds(id)) this.requireIdle(sessionId);
        this.removeLogs(this.store.deleteProject(id)); this.changed(); return null;
      }
      case 'createSession': {
        this.requireProjectAvailable(request.params.projectId);
        if (request.params.agent === 'custom' && (!request.params.command.trim() || /[\r\n\x00]/.test(request.params.command))) throw new Error('请填写单行启动命令');
        this.validateRemote(request.params);
        const session = this.store.createSession(request.params.projectId, request.params.title, request.params.agent, request.params.command, request.params.terminal, request.params.remote);
        this.changed(); return session;
      }
      case 'updateSession': {
        const { sessionId, title, agent, command, terminal, remote } = request.params;
        const previous = this.store.session(sessionId);
        this.requireProjectAvailable(previous.projectId);
        if (this.historyBusy.has(sessionId)) throw new Error('会话正在读取对话记录，请稍后编辑');
        this.validateRemote(request.params);
        const launchChanged = JSON.stringify(remote) !== JSON.stringify(previous.remote ?? null) || agent !== previous.agent || command !== previous.command || JSON.stringify(terminal) !== JSON.stringify(previous.terminal);
        if (launchChanged) this.requireIdle(sessionId);
        if (agent === 'custom' && !command.trim()) throw new Error('请填写单行启动命令');
        const session = this.store.updateSession(sessionId, title, agent, command, terminal, remote); this.changed(); return session;
      }
      case 'deleteSession': {
        const id = request.params.sessionId;
        this.requireProjectAvailable(this.store.session(id).projectId); this.requireIdle(id);
        this.removeLogs(this.store.deleteSession(id)); this.changed(); return null;
      }
      case 'saveSettings': {
        await resolveTerminal(request.params.terminal);
        if (this.closing) throw new Error('后台正在退出');
        const settings = this.store.saveSettings(request.params); this.changed(); return settings;
      }
      case 'createAgent':
      case 'updateAgent': {
        const { params } = request;
        const { agentId, ...config } = 'agentId' in params ? params : { ...params, agentId: undefined };
        const previous = agentId ? this.store.agent(agentId) : null;
        const version = agentId ? this.agentVersion(agentId) : 0;
        const identity = previous?.sourceId ?? previous?.plugin?.sourceId;
        if (identity && identity !== (config.sourceId ?? config.plugin?.sourceId)) throw new Error('插件 ID 与当前类型不一致，请导入同一类型的更新文件');
        if (config.plugin) {
          if (!path.isAbsolute(config.plugin.executable)) throw new Error('插件程序须使用完整路径');
          if (config.plugin.runtime === 'node') { if (!statSync(config.plugin.executable).isFile()) throw new Error('插件入口文件不存在'); }
          else await resolveTerminal({ profile: 'custom', executable: config.plugin.executable, args: config.plugin.args });
          if (previous && JSON.stringify(previous.plugin) !== JSON.stringify(config.plugin)) await this.plugins.check({ id: agentId!, ...config });
        }
        if (this.closing) throw new Error('后台正在退出');
        if (agentId) { this.store.agent(agentId); this.assertAgentVersion(agentId, version); }
        const agent = this.store.saveAgent(config, agentId);
        this.agentVersions.set(agent.id, version + 1);
        this.changed(); return agent;
      }
      case 'probeAgentPlugin': return this.plugins.check({ id: 'preview', ...request.params });
      case 'checkAgentPlugin': return this.plugins.check(this.store.agent(request.params.agentId));
      case 'deleteAgent': this.store.deleteAgent(request.params.agentId); this.agentVersions.delete(request.params.agentId); this.changed(); return null;
      case 'linkNativeSession': {
        const session = this.store.session(request.params.sessionId);
        this.requireHistoryAvailable(session.id);
        if (!['codex', 'claude', 'opencode'].includes(this.integration(session)) && !(session.agent.startsWith('agent:') && (this.store.agent(session.agent).resumeCommand || this.store.agent(session.agent).plugin?.resume || this.store.agent(session.agent).plugin?.history || this.store.agent(session.agent).plugin?.list))) throw new Error('当前 Agent 不支持原生会话恢复');
        const history = this.store.nativeHistory(session.id, request.params.nativeSessionId) ?? { messages: [], warnings: ['仅关联原生会话 ID；导入记录后可查看对话文本'], path: null, nativeSessionId: request.params.nativeSessionId };
        this.nativeTracking.delete(session.id);
        this.store.saveHistory(session.id, history); this.changed(); return history;
      }
      case 'unlinkNativeSession': {
        const id = request.params.sessionId; this.requireHistoryAvailable(id);
        this.nativeTracking.delete(id);
        const history = { messages: [], warnings: [], path: null, nativeSessionId: null };
        this.store.saveHistory(id, history); this.changed(); return history;
      }
      case 'nativeSessionDetected': {
        const p = request.params, session = this.store.session(p.sessionId), tracking = this.nativeTracking.get(session.id);
        const version = this.agentVersion(session.agent);
        if (this.integration(session) !== p.provider || session.remote || session.latestRun?.id !== p.runId || !this.live.has(session.id) || this.live.get(session.id)?.closed || tracking?.runId !== p.runId || session.nativeSessionId && session.nativeSessionId !== tracking.hookNativeId || this.historyBusy.has(session.id) || !await matchesProject(p.cwd, this.store.project(session.projectId).path)) return { linked: false };
        if (session.nativeSessionId === p.nativeSessionId) return { linked: true };
        const transcript = p.provider === 'claude' ? (await this.nativeDiscovery.list('claude', this.store.project(session.projectId).path)).find(item => item.nativeSessionId === p.nativeSessionId)?.path : null;
        if (p.provider === 'claude' && !transcript) return { linked: false };
        // Recheck after path I/O: manual association/unlink always wins.
        if (this.nativeTracking.get(session.id) !== tracking || this.store.session(session.id).nativeSessionId !== session.nativeSessionId || this.agentVersion(session.agent) !== version) return { linked: false };
        this.store.saveHistory(session.id, { messages: [], warnings: [], path: transcript ?? null, nativeSessionId: p.nativeSessionId });
        tracking.ambiguous = true; tracking.hookNativeId = p.nativeSessionId; this.changed(); return { linked: true };
      }
      case 'nativeHistories': return this.store.nativeHistories(request.params.sessionId, request.params);
      case 'discoverNativeHistories': return this.discoverHistories(request.params.sessionId, request.params);
      case 'nativeHistory': return this.previewHistory(request.params.sessionId, request.params.nativeSessionId, request.params.refresh);
      case 'renameSession': this.store.rename(request.params.sessionId, request.params.title); this.changed(); return null;
      case 'archiveSession':
        this.requireIdle(request.params.sessionId);
        this.store.archive(request.params.sessionId); this.changed(); return null;
      case 'start': return this.start(request.params.sessionId, request.params.resume, request.params.cols, request.params.rows);
      case 'stop': await this.stop(request.params.sessionId); return null;
      case 'attach': client.activity.delete(request.params.sessionId); client.subscriptions.add(request.params.sessionId); return this.attach(request.params.sessionId);
      case 'detach': client.activity.delete(request.params.sessionId); client.subscriptions.delete(request.params.sessionId); return null;
      case 'input': {
        if (!client.subscriptions.has(request.params.sessionId)) throw new Error('请先连接终端');
        const live = this.terminal(request.params.sessionId, request.params.runId);
        if (live.remote?.activity.info.owner === 'agent') throw new Error('Agent 正在操作，请先点击“接管”');
        const { data, binary } = request.params;
        live.remote?.activity.input(data);
        live.pty.write(binary ? Buffer.from(data, 'latin1') : data); return null;
      }
      case 'resize': {
        if (!client.subscriptions.has(request.params.sessionId)) throw new Error('请先连接终端');
        const live = this.terminal(request.params.sessionId, request.params.runId);
        const { cols, rows } = request.params;
        this.flushOutput(live);
        // Reserve the sequence now, before later output is queued. Resize the
        // PTY and headless grid between writes, then send the same boundary to
        // every attached renderer before any new-size output is delivered.
        const seq = ++live.seq;
        return new Promise<null>((resolve, reject) => live.terminal.write('', () => {
          if (live.closed) { reject(new Error('终端已结束，请重新启动')); return; }
          try {
            live.pty.resize(cols, rows); live.terminal.resize(cols, rows);
            live.committedSeq = seq;
            this.broadcast({ event: 'resize', data: { sessionId: live.run.sessionId, runId: live.run.id, seq, cols, rows } });
            resolve(null);
          } catch (error) { reject(error); }
        }));
      }
      case 'runs': return this.store.session(request.params.sessionId).agent === 'shell' ? this.store.runs(request.params.sessionId).filter(run => run.recordOutput) : [];
      case 'deleteRun': {
        const run = this.store.run(request.params.runId);
        this.requireProjectAvailable(this.store.session(run.sessionId).projectId);
        if (this.live.get(run.sessionId)?.run.id === run.id) throw new Error('请先停止终端，再删除运行记录');
        this.store.deleteRun(run.id); this.removeLogs([run.id]); this.changed(); return null;
      }
      case 'clearFinishedRuns': {
        const id = request.params.sessionId;
        this.requireProjectAvailable(this.store.session(id).projectId);
        this.removeLogs(this.store.clearFinishedRuns(id)); this.changed(); return null;
      }
      case 'output': {
        const run = this.store.run(request.params.runId), live = this.live.get(run.sessionId);
        if (!run.recordOutput || this.store.session(run.sessionId).agent !== 'shell') throw new Error('仅普通终端保留运行输出；Agent 请使用原生对话历史');
        if (live?.run.id === run.id) this.flushOutput(live);
        return new RunLog(this.logs, request.params.runId).read();
      }
      case 'history': return this.store.history(request.params.sessionId);
      case 'importHistory': return this.importHistory(request.params.sessionId, request.params.path);
      case 'refreshHistory': {
        const session = this.store.session(request.params.sessionId);
        if (!session.transcriptPath && !(['claude', 'opencode'].includes(this.integration(session)) && session.nativeSessionId) && !(session.agent.startsWith('agent:') && this.store.agent(session.agent).plugin?.history)) throw new Error('请先关联原生对话记录');
        return this.importHistory(request.params.sessionId, session.transcriptPath);
      }
    }
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

  private async start(sessionId: string, resume: boolean, cols: number, rows: number): Promise<Run> {
    const session = this.store.session(sessionId);
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
    try { return await this.spawn(sessionId, resume, cols, rows); }
    finally { this.starting.delete(sessionId); }
  }

  private validateRemote(config: { remote: unknown; agent: string; command: string }): void {
    if (config.remote && typeof config.remote === 'object' && 'connectionId' in config.remote && typeof config.remote.connectionId === 'string') this.store.sshConnection(config.remote.connectionId);
    if (config.remote && (config.agent !== 'shell' || config.command.trim())) throw new Error('远程会话请选择默认终端；Agent 通过 MCP 操作此终端');
  }
  private async spawn(sessionId: string, resume: boolean, cols: number, rows: number): Promise<Run> {
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
    const run = this.store.createRun(sessionId, command, cols, rows, selected.file);
    const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true, windowsPty: session.remote ? undefined : windowsPtyFor(process.platform, release()) });
    terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    const mouseEncoding = trackMouseEncoding(terminal);
    let child: TerminalProcess;
    let remote: LiveTerminal['remote'];
    try {
      if (session.remote) {
        const activity = new RemoteActivity({ sessionId, runId: run.id, host: session.remote.host, connection: 'connecting', owner: 'user', phase: 'unknown', cwd: null, error: null }, this.store, data => this.broadcast({ event: 'remote', data }), data => this.broadcast({ event: 'remoteAction', data }), path.join(this.dataDirectory,'command-output',run.id));
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
  private async stopAll(): Promise<void> {
    this.closing = true;
    try {
      // Drain in-flight SSH startup before closing the local channels.
      const startupDeadline = Date.now() + 45000;
      while (this.starting.size && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (this.starting.size) throw new Error('远端连接尚未完成，请稍后再次退出；后台保留以便确认清理');
      await this.resources.close();
      await this.transfers.close();
      await this.git.close();
      await this.plugins.close();
      await this.nativeDiscovery.opencode.close();
      const results = await Promise.allSettled([...this.live.keys()].map(sessionId => this.stop(sessionId)));
      for (const result of results) if (result.status === 'rejected') this.logError(result.reason);
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
    for (const socket of this.clients.keys()) socket.terminate();
    await new Promise<void>(resolve => this.ws.close(() => resolve()));
    await new Promise<void>(resolve => this.http.close(() => resolve()));
    rmSync(path.join(this.dataDirectory, 'runtime.json'), { force: true });
    this.store.close();
  }
}
