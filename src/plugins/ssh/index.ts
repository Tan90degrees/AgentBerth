import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../../daemon/server';
import type { Request } from '../../shared/protocol';
import path from 'node:path';
import { RemoteOperationError } from '../../shared/remote-errors';
import { remoteKeys } from '../../daemon/remote-activity';
import { sshHosts } from '../../daemon/remote';
import { directory } from '../../daemon/paths';
import { randomUUID } from 'node:crypto';
export const methods=["sshConnections", "registerSshProvider", "sshChallengeReply", "saveSshConnection", "deleteSshConnection", "mcpMetrics", "mcpRecordCall", "remoteAliases", "remoteAgentRecover", "remoteAgentClose", "remoteAgentSessions", "remoteResolve", "remoteOpen", "sshHosts", "remoteManage", "remoteTransferStart", "remoteTransferStatus", "remoteTransferCancel", "remoteTransfers", "createRemoteSession", "remoteInfo", "remoteActions", "remoteControl", "remoteReconnect", "remoteExecute", "remoteCommand", "remoteReadOutput", "remoteKeys", "remoteWait", "remoteScreen"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.sshPluginPort();
 server.registerExtensionRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'sshConnections': return host.store.sshConnections();
      case 'registerSshProvider': {
        if (host.sshProvider && host.sshProvider !== client) throw new Error('SSH 登录提供端已连接');
        host.sshProvider = client; return null;
      }
      case 'sshChallengeReply': {
        const pending = host.sshChallenges.get(request.params.challengeId);
        if (!pending || pending.client !== client) throw new Error('登录请求已过期');
        pending.resolve(request.params); return null;
      }
      case 'saveSshConnection': {
        if (request.params.connectionId) for (const session of host.store.state().sessions) if (session.remote?.connectionId === request.params.connectionId) host.requireIdle(session.id);
        const profile = host.store.saveSshConnection(request.params.config, request.params.connectionId); host.changed(); return profile;
      }
      case 'deleteSshConnection': host.store.deleteSshConnection(request.params.connectionId); return null;
      case 'mcpMetrics': return host.mcpStats.snapshot();
      case 'mcpRecordCall': {
        host.mcpStats.record(request.params);
        if(!host.mcpStatsTimer)host.mcpStatsTimer=setTimeout(()=>{host.mcpStatsTimer=null;host.broadcast({event:'mcpMetrics',data:host.mcpStats.snapshot()});},150);
        return null;
      }
      case 'remoteAliases': return host.store.sshConnections().map(profile => ({ alias: profile.alias, allowAgent: profile.allowAgent }));
      case 'remoteAgentRecover': {
        if (client === host.sshProvider) return {recovered:[]};
        const recovered: string[] = [];
        for (const target of request.params.targets) {
          const owner = host.agentOwners.get(target.sessionId), live = host.live.get(target.sessionId);
          const restored = host.restoredRuns.get(target.sessionId);
          if (owner?.abort.signal.aborted && live && (live.run.id === target.runId || restored?.runId === live.run.id && restored.previousRunId === target.runId)) { host.agentOwners.set(target.sessionId, client); recovered.push(target.sessionId); }
        }
        return { recovered };
      }
      case 'remoteAgentClose': {
        if(client.disposing)throw new Error('Agent 上下文正在清理，请等待完成');
        const sessions = host.store.state().sessions.filter(session => host.agentOwners.get(session.id) === client);
        for (const session of sessions) {
          const activity=host.live.get(session.id)?.remote?.activity;
          if(activity&&(!host.starting.has(session.id)||activity.controlChosen))activity.assertManage(client);
          const work = host.store.unresolvedRemoteAction(session.id);
          if (work && (work.status === 'running' || request.params.deleteHistory)) throw new RemoteOperationError('CLEANUP_BLOCKED', '此上下文仍有运行中或结果不明的任务；继续查询原任务，完成或明确取消后再清理。不要为了清理重放命令。', { sessionId: session.id, runId: work.runId, ...(work.kind === 'transfer' ? { transferId: work.id } : { actionId: work.id }) });
        }
        client.disposing = true;
        try {
          const opening = [...host.openingAliases].filter(([key]) => key.startsWith(client.id + ':')).map(([,promise]) => promise);
          await Promise.all(sessions.map(session => host.stop(session.id)));
          await Promise.allSettled(opening);
          const closed = sessions.map(session => session.id), deleted: string[] = [];
          if (request.params.deleteHistory) for (const session of sessions) {
            if (host.live.has(session.id) || host.starting.has(session.id)) continue;
            host.removeLogs(host.store.deleteSession(session.id)); deleted.push(session.id);
          }
          host.changed();
          return { closed, deleted, retained: closed.filter(id => !deleted.includes(id)) };
        } finally { client.disposing = false; }
      }
      case 'remoteAgentSessions': {
        const state = host.store.state();
        return { connections: host.store.sshConnections().map(profile => ({ alias: profile.alias, allowAgent: profile.allowAgent })), sessions: state.sessions.filter(session => host.agentOwners.get(session.id) === client).map(session => ({ sessionId: session.id, runId: session.latestRun?.id ?? null, title: session.title, project: state.projects.find(project => project.id === session.projectId)?.name, remote: session.remote, status: session.latestRun?.status ?? 'not-started', info: host.live.get(session.id)?.remote?.activity.info ?? null })) };
      }
      case 'remoteResolve': {
        const {session} = host.aliasTarget(request.params.alias, client);
        if (!session) throw new RemoteOperationError('SESSION_NOT_OPEN','此连接尚未打开，请先调用 terminal_open',{alias:request.params.alias});
        const live = host.terminal(session.id);
        return { sessionId: session.id, runId: live.run.id };
      }
      case 'remoteOpen': {
        if(client.disposing)throw new Error('Agent 上下文正在清理，请等待完成');
        const {profile, session: previous} = host.aliasTarget(request.params.alias, client, request.params.owner === 'user');
        if (request.params.owner === 'agent' && !profile.allowAgent) throw new Error('此连接未允许 Agent 打开，请在 SSH 设置中修改');
        const key = `${client.id}:${profile.id}:${previous?.title ?? profile.alias}`;
        const pending = host.openingAliases.get(key);
        if (pending) return pending;
        if (previous && host.live.has(previous.id)) {
          const live = host.terminal(previous.id);
          return { sessionId: previous.id, runId: live.run.id, info: live.remote!.activity.info };
        }
        const opening = (async () => {
          const project = previous ? null : host.remoteProject();
          const session = previous ?? host.store.createSession(project!.id, profile.alias, 'shell', '', null, { connectionId: profile.id, host: profile.alias, directory: '' });
          if(request.params.owner === 'agent') host.agentOwners.set(session.id, client);
          const run = await host.start(session.id, false, 100, 30);
          const activity = host.remote(session.id,run.id).activity;
          const info = activity.controlChosen ? {...activity.info} : activity.control(request.params.owner);
          if (request.params.owner === 'agent') host.remote(session.id,run.id).activity.assertManage(client);
          if (client.abort.signal.aborted) host.remote(session.id,run.id).activity.release(client);
          host.changed(); return { sessionId: session.id, runId: run.id, info };
        })();
        host.openingAliases.set(key, opening);
        try { return await opening; }
        finally { if (host.openingAliases.get(key) === opening) host.openingAliases.delete(key); }
      }
      case 'sshHosts': return sshHosts();
      case 'remoteManage': {
        const params=request.params;
        if(params.action==='create'){
          if(client.disposing)throw new Error('Agent 上下文正在清理，请等待完成');
          const profile=host.store.sshConnections().find(item=>item.alias.toLowerCase()===params.alias!.toLowerCase());
          if(!profile)throw new Error('服务器别名不存在，请先填写服务器信息');
          if(!profile.allowAgent)throw new Error('此服务器未允许 Agent 打开');
          const title=params.title??profile.alias;
          const key=`${client.id}:${profile.id}:${title}`;
          const previous=host.store.state().sessions.find(item=>item.remote?.connectionId===profile.id&&item.title===title&&host.agentOwners.get(item.id)===client);
          if(previous&&(previous.remote?.directory??'')!==(params.directory??''))throw new Error('同名 SSH 会话使用不同目录，请选择不同会话名称或停止后编辑');
          const pending=host.openingAliases.get(key);if(pending)return pending;
          const opening=(async()=>{
            const session=previous??host.store.createSession(host.remoteProject().id,title,'shell','',null,{connectionId:profile.id,host:profile.alias,directory:params.directory??''});
            host.agentOwners.set(session.id,client);
            const existing=host.live.get(session.id);if(existing)return {sessionId:session.id,runId:existing.run.id,info:existing.remote!.activity.info};
            const run=await host.start(session.id,false,100,30),activity=host.remote(session.id,run.id).activity;
            const info=activity.controlChosen?{...activity.info}:activity.control('agent');
            host.remote(session.id,run.id).activity.assertManage(client);
            if(client.abort.signal.aborted)host.remote(session.id,run.id).activity.release(client);
            host.changed();return {sessionId:session.id,runId:run.id,info};
          })();
          host.openingAliases.set(key,opening);try{return await opening;}finally{host.openingAliases.delete(key);}
        }
        const session=params.alias?host.aliasTarget(params.alias,client).session:host.store.session(params.sessionId!);
        if(!session)throw new RemoteOperationError('SESSION_NOT_OPEN','当前 Agent 尚未创建此服务器的会话',{alias:params.alias});
        host.assertOwnSession(session.id,client);
        if(!session.remote?.connectionId||!host.store.sshConnection(session.remote.connectionId).allowAgent)throw new Error('此 SSH 会话未允许 Agent 管理');
        const live=host.live.get(session.id);
        if(params.runId&&session.latestRun?.id!==params.runId)throw new Error('终端运行实例已变化，请重新读取会话列表');
        if(live){if(params.sessionId&&!params.runId)throw new Error('管理运行中的会话请同时提供 runId');live.remote!.activity.assertManage(client);}
        if(params.action==='close'){await host.stop(session.id);return host.store.session(session.id);}
        if(params.action==='delete'){
          host.requireIdle(session.id);host.removeLogs(host.store.deleteSession(session.id));host.changed();return {deleted:true,sessionId:session.id};
        }
        if(params.action==='reconnect'){
          if(!live)throw new Error('SSH 会话已停止，请调用 terminal_open');
          await live.remote!.transport.reconnect();live.remote!.activity.assertManage(client);host.changed();
          return {sessionId:session.id,runId:live.run.id,info:live.remote!.activity.info};
        }
        if(params.title===undefined&&params.directory===undefined)throw new Error('请提供会话名称或远端目录');
        const remote={...session.remote,directory:params.directory??session.remote.directory};
        if(remote.directory!==session.remote.directory)host.requireIdle(session.id);
        const updated=host.store.updateSession(session.id,params.title??session.title,'shell','',null,remote);host.changed();return updated;
      }
      case 'remoteTransferStart': {
        for(const endpoint of [request.params.source,request.params.destination])host.authorizeRemote(endpoint,client);
        const {source,destination}=request.params;
        if(source.kind==='remote'&&destination.kind==='remote'&&path.posix.normalize(source.path)===path.posix.normalize(destination.path)){
          const a=host.store.sshConnection(host.store.session(source.sessionId).remote!.connectionId!),b=host.store.sshConnection(host.store.session(destination.sessionId).remote!.connectionId!);
          if(a.hostname.toLowerCase()===b.hostname.toLowerCase()&&a.port===b.port&&a.username===b.username)throw new Error('同一服务器的源路径和目标路径相同');
        }
        return host.transfers.start(request.params);
      }
      case 'remoteTransferStatus': return host.transfers.wait(request.params.requestId,request.params.timeoutMs,client.abort.signal);
      case 'remoteTransferCancel': {
        const transfer=host.transfers.get(request.params.requestId);
        if(transfer.status!=='running')return transfer;
        if(request.params.owner==='agent')for(const endpoint of [transfer.spec.source,transfer.spec.destination])host.authorizeRemote(endpoint,client,false);
        return host.transfers.cancel(request.params.requestId);
      }
      case 'remoteTransfers': host.store.session(request.params.sessionId);return host.transfers.list(request.params.sessionId);
      case 'createRemoteSession': {
        host.validateRemote({...request.params, agent:'shell', command:''});
        const session = host.store.createSession(host.remoteProject().id, request.params.title, 'shell', '', null, request.params.remote);
        host.changed(); return session;
      }
      case 'remoteInfo': return host.live.get(request.params.sessionId)?.remote?.activity.info ?? null;
      case 'remoteActions': return host.store.remoteActions(request.params.sessionId, request.params.before);
      case 'remoteControl': return host.remote(request.params.sessionId, request.params.runId).activity.control(request.params.owner);
      case 'remoteReconnect': { const live=host.terminal(request.params.sessionId,request.params.runId); await host.remote(request.params.sessionId,request.params.runId).transport.reconnect(); host.store.setPid(live.run.id,live.pty.pid);live.run=host.store.run(live.run.id);host.changed();return null; }
      case 'remoteExecute': {
        host.assertOwnSession(request.params.sessionId,client);
        const remote = host.remote(request.params.sessionId, request.params.runId);
        return remote.activity.execute(client, request.params.requestId, request.params.command, text => remote.transport.writeManaged(request.params.requestId,request.params.command,text), request.params.atPrompt);
      }
      case 'remoteCommand': return host.runRemoteCommand(client,request.params);
      case 'remoteReadOutput': {
        const started=performance.now(),p=request.params,remote=host.remote(p.sessionId,p.runId);
        host.recoverReadTarget(p.sessionId,client);
        const actionId=p.actionId??remote.activity.latestOutputCommand()?.id;
        if(!actionId)throw new RemoteOperationError('NO_COMMAND_OUTPUT','当前没有已捕获的命令结果；普通命令使用 terminal_execute，交互程序使用 terminal_interact。不要重跑此前结果未知的输入。',{sessionId:p.sessionId,runId:p.runId});
        if(p.search&&p.waitFor==='completion')await remote.activity.wait(actionId,p.timeoutMs,client.abort.signal);
        const value=p.search?remote.activity.result(actionId,p.cursor,p.maxChars,p.mode,p.search):await remote.activity.readOutput(actionId,p.cursor,p.maxChars,p.timeoutMs,p.waitFor,client.abort.signal,p.mode);
        return {...value,requestMs:performance.now()-started};
      }
      case 'remoteKeys': {
        host.assertOwnSession(request.params.sessionId,client);
        const remote = host.remote(request.params.sessionId, request.params.runId), { key, text, enter } = request.params;
        if(text!==undefined&&enter&&text.trim()&&remote.activity.info.phase==='idle'&&remote.activity.info.commandTracking==='posix'){
          return host.runRemoteCommand(client,{sessionId:request.params.sessionId,runId:request.params.runId,command:text,requestId:randomUUID(),atPrompt:false,waitMs:5000,waitFor:'completion',maxChars:32768,mode:'summary'});
        }
        remote.activity.keys(client, key ? remoteKeys[key] : text! + (enter ? '\r' : ''), key ? `按键 ${key}` : `输入文本（${text!.length} 字符${enter?'，回车':''}）`, data => remote.transport.write(data)); return {inputKind:'interactive',info:{...remote.activity.info}};
      }
      case 'remoteWait': {
        const remote=host.remote(request.params.sessionId,request.params.runId);host.recoverReadTarget(request.params.sessionId,client);
        return remote.activity.wait(request.params.actionId,request.params.timeoutMs,client.abort.signal);
      }
      case 'remoteScreen': {
        const live = host.terminal(request.params.sessionId, request.params.runId);
        if (!live.remote) throw new Error('此会话不是远程终端');
        host.recoverReadTarget(request.params.sessionId,client);
        const screen = await host.screen(live,false);
        const buffer = live.terminal.buffer.active, lines: string[] = [];
        for (let row = buffer.baseY; row < buffer.baseY + live.terminal.rows; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
        const command=live.remote.activity.latestCommand();
        return { scope:'viewport', scrollbackLines:buffer.baseY, command:command?{id:command.id,status:command.status,sessionId:command.sessionId,runId:command.runId}:null, seq: screen.seq, cols: screen.cols, rows: screen.rows, text: lines.join('\n'), cursor: { x: buffer.cursorX, y: buffer.cursorY }, info: live.remote.activity.info };
      }

 default:throw new Error('插件不支持此请求');
 }});
}
