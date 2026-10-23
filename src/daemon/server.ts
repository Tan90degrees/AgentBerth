import { randomUUID } from 'node:crypto';
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
import { sameDirectory } from './history';
import { RunLog } from './logs';
import { readHistory } from './history';
import { terminateTree } from './processes';
import { trackMouseEncoding } from '../shared/terminal-modes';
import { RemoteTerminal, sshHosts, type TerminalProcess } from './remote';
import { RemoteActivity, remoteKeys } from './remote-activity';
import { windowsPtyFor } from '../shared/desktop';

interface LiveTerminal {
  run: Run; pty: TerminalProcess; remote?: { transport: RemoteTerminal | SshTerminal; activity: RemoteActivity }; terminal: Terminal; serialize: SerializeAddon; mouseEncoding: () => string;
  seq: number; committedSeq: number; queuedBytes: number; stopping: boolean; closed: boolean;
  log: RunLog | null;
  output: string[]; outputBytes: number; outputTimer: NodeJS.Timeout | null; finishing: Promise<void> | null;
}
interface Client { subscriptions: Set<string>; activity: Map<string, string>; pending: number; abort: AbortController }

export class DaemonServer {
  private sshProvider: Client | null = null;
  private sshChallenges = new Map<string, { client: Client; resolve: (value: {secret?: SshSecret; accepted?: boolean}) => void; reject: (error: Error) => void }>();
  private openingAliases = new Map<string, Promise<{sessionId:string;runId:string;info: import('../shared/protocol').RemoteInfo}>>();
  private store: Store;
  private transfers: RemoteTransfers;
  private plugins = new AgentPlugins();
  private agentVersions = new Map<string, number>();
  private git = new GitWorkspace();
  private files = new ProjectFiles(this.git);
  private resources = new ResourceSampler();
  private gitBusy = new Set<string>();
  private http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  private ws = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private clients = new Map<WebSocket, Client>();
  private pendingWork = 0;
  private live = new Map<string, LiveTerminal>();
  private token = randomBytes(32).toString('hex');
  private closing = false;
  private logs: string;
  private historyBusy = new Set<string>();
  private historyWrites = new Set<string>();
  private starting = new Set<string>();
  private editingProjects = new Set<string>();

  constructor(readonly dataDirectory: string, private onShutdown: () => void = () => {}, private spawnPty: typeof pty.spawn = pty.spawn) {
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
      const client: Client = { subscriptions: new Set(), activity: new Map(), pending: 0, abort: new AbortController() };
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
          this.send(socket, { id, error: '请求参数无效：' + result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
          return;
        }
        // Resource polling is cancelled by close() and must not block an idle restart.
        const blocksIdleShutdown = result.data.method !== 'resources';
        client.pending++;
        if (blocksIdleShutdown) this.pendingWork++;
        void this.dispatch(result.data, client).then(value => this.send(socket, { id: result.data.id, result: value })).catch(error => this.send(socket, { id: result.data.id, error: error instanceof Error ? error.message : '操作失败' })).finally(() => {
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
    if (!live || live.closed) throw new Error('终端已结束，请重新启动');
    if (runId && live.run.id !== runId) throw new Error('终端运行实例已变化，请重新连接');
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
  private aliasTarget(alias: string) {
    const profile = this.store.sshConnections().find(item => item.alias.toLowerCase() === alias.toLowerCase());
    if (!profile) throw new Error('连接别名不存在，请先在 AgentBerth 设置中保存 SSH 连接');
    const sessions = this.store.state().sessions.filter(session => session.remote?.connectionId === profile.id);
    const active = sessions.filter(session => this.live.has(session.id));
    if (active.length > 1) throw new Error('此别名有多个运行会话，请从 terminal_list 选择 sessionId 和 runId');
    return { profile, session: active[0] ?? sessions[0] };
  }
  private remoteProject() {
    const folder = path.join(this.dataDirectory, 'remote-sessions');
    mkdirSync(folder, {recursive:true, mode:0o700});
    return this.store.createProject('远程连接', folder);
  }
  private authorizeRemote(endpoint:TransferEndpoint,client:Client,connected=true):void {
    if(endpoint.kind==='local')return;
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
      case 'remoteAliases': return this.store.sshConnections().map(profile => ({ alias: profile.alias, allowAgent: profile.allowAgent }));
      case 'remoteResolve': {
        const {session} = this.aliasTarget(request.params.alias);
        if (!session) throw new Error('此连接尚未打开，请先调用 terminal_open');
        const live = this.terminal(session.id);
        return { sessionId: session.id, runId: live.run.id };
      }
      case 'remoteOpen': {
        const {profile, session: previous} = this.aliasTarget(request.params.alias);
        if (request.params.owner === 'agent' && !profile.allowAgent) throw new Error('此连接未允许 Agent 打开，请在 SSH 设置中修改');
        const pending = this.openingAliases.get(profile.id);
        if (pending) return pending;
        if (previous && this.live.has(previous.id)) {
          const live = this.terminal(previous.id);
          return { sessionId: previous.id, runId: live.run.id, info: live.remote!.activity.info };
        }
        const opening = (async () => {
          const project = previous ? null : this.remoteProject();
          const session = previous ?? this.store.createSession(project!.id, profile.alias, 'shell', '', null, { connectionId: profile.id, host: profile.alias, directory: '' });
          const run = await this.start(session.id, false, 100, 30);
          const info = this.remote(session.id,run.id).activity.control(request.params.owner);
          this.changed(); return { sessionId: session.id, runId: run.id, info };
        })();
        this.openingAliases.set(profile.id, opening);
        try { return await opening; }
        finally { if (this.openingAliases.get(profile.id) === opening) this.openingAliases.delete(profile.id); }
      }
      case 'sshHosts': return sshHosts();
      case 'remoteManage': {
        const params=request.params;
        if(params.action==='create'){
          const profile=this.store.sshConnections().find(item=>item.alias.toLowerCase()===params.alias!.toLowerCase());
          if(!profile)throw new Error('服务器别名不存在，请先填写服务器信息');
          if(!profile.allowAgent)throw new Error('此服务器未允许 Agent 打开');
          const key=`${profile.id}:${params.title}`;
          const pending=this.openingAliases.get(key);if(pending)return pending;
          const previous=this.store.state().sessions.find(item=>item.remote?.connectionId===profile.id&&item.title===params.title);
          if(previous&&(previous.remote?.directory??'')!==(params.directory??''))throw new Error('同名 SSH 会话使用不同目录，请选择不同会话名称或停止后编辑');
          const opening=(async()=>{
            const session=previous??this.store.createSession(this.remoteProject().id,params.title!,'shell','',null,{connectionId:profile.id,host:profile.alias,directory:params.directory??''});
            const existing=this.live.get(session.id);if(existing)return {sessionId:session.id,runId:existing.run.id,info:existing.remote!.activity.info};
            const run=await this.start(session.id,false,100,30),info=this.remote(session.id,run.id).activity.control('agent');
            this.changed();return {sessionId:session.id,runId:run.id,info};
          })();
          this.openingAliases.set(key,opening);try{return await opening;}finally{this.openingAliases.delete(key);}
        }
        let session;
        if(params.alias){
          const {profile}=this.aliasTarget(params.alias);
          const matches=this.store.state().sessions.filter(item=>item.remote?.connectionId===profile.id);
          if(matches.length!==1)throw new Error('此别名没有唯一会话，请从 terminal_list 选择 sessionId 和 runId');
          session=matches[0];
        }else session=this.store.session(params.sessionId!);
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
          await live.remote!.transport.reconnect();live.remote!.activity.assertManage(client);live.remote!.activity.control('agent');this.changed();
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
        const remote = this.remote(request.params.sessionId, request.params.runId);
        return remote.activity.execute(client, request.params.requestId, request.params.command, text => remote.transport.writeManaged(request.params.requestId,request.params.command,text), request.params.atPrompt);
      }
      case 'remoteCommand': {
        const started=performance.now(),p=request.params,remote=this.remote(p.sessionId,p.runId);
        remote.activity.execute(client,p.requestId,p.command,text=>remote.transport.writeManaged(p.requestId,p.command,text),p.atPrompt);
        const first=await remote.activity.readOutput(p.requestId,0,p.maxChars,p.waitMs,'output',client.abort.signal);
        // Let short commands deliver their exit marker in the same call, while
        // streaming jobs return their first output without waiting the full cap.
        if(first.status==='running'&&first.output.text&&!client.abort.signal.aborted){
          const remaining=Math.max(0,p.waitMs-(performance.now()-started));
          if(remaining)await remote.activity.wait(p.requestId,Math.min(75,remaining),client.abort.signal);
        }
        return {...remote.activity.result(p.requestId,0,p.maxChars),requestMs:performance.now()-started};
      }
      case 'remoteReadOutput': {
        const started=performance.now(),p=request.params,remote=this.remote(p.sessionId,p.runId);
        const value=await remote.activity.readOutput(p.actionId,p.cursor,p.maxChars,p.timeoutMs,p.waitFor,client.abort.signal);
        return {...value,requestMs:performance.now()-started};
      }
      case 'remoteKeys': {
        const remote = this.remote(request.params.sessionId, request.params.runId), { key, text, enter } = request.params;
        remote.activity.keys(client, key ? remoteKeys[key] : text! + (enter ? '\r' : ''), key ? `按键 ${key}` : `输入文本（${text!.length} 字符${enter?'，回车':''}）`, data => remote.transport.write(data)); return null;
      }
      case 'remoteWait': return this.remote(request.params.sessionId, request.params.runId).activity.wait(request.params.actionId, request.params.timeoutMs, client.abort.signal);
      case 'remoteScreen': {
        const live = this.terminal(request.params.sessionId, request.params.runId);
        if (!live.remote) throw new Error('此会话不是远程终端');
        const screen = await this.screen(live,false);
        const buffer = live.terminal.buffer.active, lines: string[] = [];
        for (let row = buffer.baseY; row < buffer.baseY + live.terminal.rows; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
        return { seq: screen.seq, cols: screen.cols, rows: screen.rows, text: lines.join('\n'), cursor: { x: buffer.cursorX, y: buffer.cursorY }, info: live.remote.activity.info };
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
        if (!['codex', 'claude', 'opencode'].includes(session.agent) && !(session.agent.startsWith('agent:') && (this.store.agent(session.agent).resumeCommand || this.store.agent(session.agent).plugin?.resume || this.store.agent(session.agent).plugin?.history || this.store.agent(session.agent).plugin?.list))) throw new Error('当前 Agent 不支持原生会话恢复');
        const history = this.store.nativeHistory(session.id, request.params.nativeSessionId) ?? { messages: [], warnings: ['仅关联原生会话 ID；导入记录后可查看对话文本'], path: null, nativeSessionId: request.params.nativeSessionId };
        this.store.saveHistory(session.id, history); this.changed(); return history;
      }
      case 'unlinkNativeSession': {
        const id = request.params.sessionId; this.requireHistoryAvailable(id);
        const history = { messages: [], warnings: [], path: null, nativeSessionId: null };
        this.store.saveHistory(id, history); this.changed(); return history;
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
        if (!session.transcriptPath && !(session.agent.startsWith('agent:') && this.store.agent(session.agent).plugin?.history)) throw new Error('请先关联原生对话记录');
        return this.importHistory(request.params.sessionId, session.transcriptPath);
      }
    }
  }

  private agentVersion(id: string): number { return this.agentVersions.get(id) ?? 0; }
  private assertAgentVersion(id: string, version: number): void {
    if (this.agentVersion(id) !== version) throw new Error('Agent 插件已更新，请重新读取或重试');
  }

  private async importHistory(sessionId: string, file: string | null): Promise<unknown> {
    this.reserveHistory(sessionId);
    this.historyWrites.add(sessionId);
    try {
      const session = this.store.session(sessionId);
      const projectPath = this.store.project(session.projectId).path;
      const version = this.agentVersion(session.agent);
      const history = session.agent.startsWith('agent:')
        ? await this.plugins.history(this.store.agent(session.agent), session, projectPath, file)
        : await readHistory(file!, session.agent, projectPath);
      if (this.closing) throw new Error('后台正在退出');
      this.assertAgentVersion(session.agent, version);
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
    if (cached && !refresh) return cached;
    const session = this.store.session(sessionId);
    const agent = session.agent.startsWith('agent:') ? this.store.agent(session.agent) : null;
    if (!agent && !cached?.path) throw new Error('此记录尚未导入，请先选择原生记录文件');
    this.reserveHistory(sessionId);
    try {
      const version = this.agentVersion(session.agent);
      const history = !agent ? await readHistory(cached!.path!, session.agent, this.store.project(session.projectId).path) : agent.plugin?.history
        ? await this.plugins.history(agent, { ...session, nativeSessionId, transcriptPath: cached?.path ?? null }, this.store.project(session.projectId).path, cached?.path ?? null)
        : { messages: [], warnings: ['此类型仅提供会话列表，没有文本读取能力'], path: null, nativeSessionId };
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
    const command = resume && session.agent.startsWith('agent:')
      ? await this.plugins.resume(this.store.agent(session.agent), session, projectPath)
      : launchCommand(session, resume);
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
    if (resume && session.agent.startsWith('agent:')) this.assertAgentVersion(session.agent, version);
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
      } else child = this.spawnPty(selected.file, selected.args, { cwd, cols, rows, name: 'xterm-256color', env: terminalEnvironment(selected.file) });
    }
    catch (error) {
      terminal.dispose();
      this.store.finish(run.id, 'failed', null, String(error), '', 0, cols, rows); this.changed(); throw error;
    }
    this.store.setPid(run.id, child.pid);
    const live: LiveTerminal = { run: this.store.run(run.id), pty: child, remote, terminal, serialize, mouseEncoding, seq: 0, committedSeq: 0, queuedBytes: 0, stopping: false, closed: false, finishing: null, log: run.recordOutput ? new RunLog(this.logs, run.id) : null, output: [], outputBytes: 0, outputTimer: null };
    if (remote) terminal.onData(data => { try { remote.transport.write(data); } catch { /* Reconnect redraw will negotiate again. */ } });
    this.live.set(sessionId, live);
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
        // taskkill confirms termination of the Windows tree. ConPTY may not
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
      const results = await Promise.allSettled([...this.live.keys()].map(sessionId => this.stop(sessionId)));
      for (const result of results) if (result.status === 'rejected') this.logError(result.reason);
      const deadline = Date.now() + 5000;
      while (this.live.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (this.live.size) throw new Error('部分终端尚未停止，请重试退出；后台已保留以便继续清理');
    } catch (error) { this.closing = false; throw error; }
  }
  async close(): Promise<void> {
    await this.stopAll();
    for (const socket of this.clients.keys()) socket.terminate();
    await new Promise<void>(resolve => this.ws.close(() => resolve()));
    await new Promise<void>(resolve => this.http.close(() => resolve()));
    rmSync(path.join(this.dataDirectory, 'runtime.json'), { force: true });
    this.store.close();
  }
}
