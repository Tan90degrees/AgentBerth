import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../../daemon/server';
import type { Request } from '../../shared/protocol';
import path from 'node:path';
import { resolveTerminal } from '../../daemon/paths';
import { directory } from '../../daemon/paths';
import { sameDirectory } from '../../daemon/history';
import { RunLog } from '../../daemon/logs';
export const methods=["restoreWorkspace", "createProject", "updateProject", "deleteProject", "createSession", "updateSession", "deleteSession", "saveSettings", "renameSession", "archiveSession", "start", "stop", "attach", "detach", "input", "resize", "runs", "deleteRun", "clearFinishedRuns", "output"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.workspacePluginPort();
 server.registerExtensionRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'restoreWorkspace': return host.restoreWorkspace();
      case 'createProject': {
        const canonical = await directory(request.params.path);
        if (host.closing) throw new Error('后台正在退出');
        const project = host.store.createProject(request.params.name, canonical); host.changed(); return project;
      }
      case 'updateProject': {
        const { projectId, name } = request.params;
        host.requireProjectAvailable(projectId);
        if (host.gitBusy.has(projectId)) throw new Error('Git 操作期间请等待完成后再修改项目');
        host.editingProjects.add(projectId);
        try {
          const previous = host.store.project(projectId);
          const canonical = await directory(request.params.path);
          if (host.closing) throw new Error('后台正在退出');
          if (!sameDirectory(previous.path, canonical)) for (const id of host.store.projectSessionIds(projectId)) host.requireIdle(id);
          const project = host.store.updateProject(projectId, name, canonical); host.changed(); return project;
        } finally { host.editingProjects.delete(projectId); }
      }
      case 'deleteProject': {
        const id = request.params.projectId;
        host.requireProjectAvailable(id);
        if (host.gitBusy.has(id)) throw new Error('Git 操作期间请等待完成后再删除项目');
        for (const sessionId of host.store.projectSessionIds(id)) host.requireIdle(sessionId);
        host.removeLogs(host.store.deleteProject(id)); host.changed(); return null;
      }
      case 'createSession': {
        host.requireProjectAvailable(request.params.projectId);
        if (request.params.agent === 'custom' && (!request.params.command.trim() || /[\r\n\x00]/.test(request.params.command))) throw new Error('请填写单行启动命令');
        host.validateRemote(request.params);
        const session = host.store.createSession(request.params.projectId, request.params.title, request.params.agent, request.params.command, request.params.terminal, request.params.remote);
        host.changed(); return session;
      }
      case 'updateSession': {
        const { sessionId, title, agent, command, terminal, remote } = request.params;
        const previous = host.store.session(sessionId);
        host.requireProjectAvailable(previous.projectId);
        if (host.historyBusy.has(sessionId)) throw new Error('会话正在读取对话记录，请稍后编辑');
        host.validateRemote(request.params);
        const launchChanged = JSON.stringify(remote) !== JSON.stringify(previous.remote ?? null) || agent !== previous.agent || command !== previous.command || JSON.stringify(terminal) !== JSON.stringify(previous.terminal);
        if (launchChanged) host.requireIdle(sessionId);
        if (agent === 'custom' && !command.trim()) throw new Error('请填写单行启动命令');
        const session = host.store.updateSession(sessionId, title, agent, command, terminal, remote); host.changed(); return session;
      }
      case 'deleteSession': {
        const id = request.params.sessionId;
        host.requireProjectAvailable(host.store.session(id).projectId); host.requireIdle(id);
        host.removeLogs(host.store.deleteSession(id)); host.changed(); return null;
      }
      case 'saveSettings': {
        await resolveTerminal(request.params.terminal);
        if (host.closing) throw new Error('后台正在退出');
        const settings = host.store.saveSettings(request.params); host.changed(); return settings;
      }
      case 'renameSession': host.store.rename(request.params.sessionId, request.params.title); host.changed(); return null;
      case 'archiveSession':
        host.requireIdle(request.params.sessionId);
        host.store.archive(request.params.sessionId); host.changed(); return null;
      case 'start': return host.start(request.params.sessionId, request.params.resume, request.params.cols, request.params.rows);
      case 'stop': await host.stop(request.params.sessionId); return null;
      case 'attach': client.activity.delete(request.params.sessionId); client.subscriptions.add(request.params.sessionId); return host.attach(request.params.sessionId);
      case 'detach': client.activity.delete(request.params.sessionId); client.subscriptions.delete(request.params.sessionId); return null;
      case 'input': {
        if (!client.subscriptions.has(request.params.sessionId)) throw new Error('请先连接终端');
        const live = host.terminal(request.params.sessionId, request.params.runId);
        if (live.remote?.activity.info.owner === 'agent') throw new Error('Agent 正在操作，请先点击“接管”');
        const { data, binary } = request.params;
        live.remote?.activity.input(data);
        live.pty.write(binary ? Buffer.from(data, 'latin1') : data); return null;
      }
      case 'resize': {
        if (!client.subscriptions.has(request.params.sessionId)) throw new Error('请先连接终端');
        const live = host.terminal(request.params.sessionId, request.params.runId);
        const { cols, rows } = request.params;
        host.flushOutput(live);
        // Reserve the sequence now, before later output is queued. Resize the
        // PTY and headless grid between writes, then send the same boundary to
        // every attached renderer before any new-size output is delivered.
        const seq = ++live.seq;
        return new Promise<null>((resolve, reject) => live.terminal.write('', () => {
          if (live.closed) { reject(new Error('终端已结束，请重新启动')); return; }
          try {
            live.pty.resize(cols, rows); live.terminal.resize(cols, rows);
            live.committedSeq = seq;
            host.broadcast({ event: 'resize', data: { sessionId: live.run.sessionId, runId: live.run.id, seq, cols, rows } });
            resolve(null);
          } catch (error) { reject(error); }
        }));
      }
      case 'runs': return host.store.session(request.params.sessionId).agent === 'shell' ? host.store.runs(request.params.sessionId).filter(run => run.recordOutput) : [];
      case 'deleteRun': {
        const run = host.store.run(request.params.runId);
        host.requireProjectAvailable(host.store.session(run.sessionId).projectId);
        if (host.live.get(run.sessionId)?.run.id === run.id) throw new Error('请先停止终端，再删除运行记录');
        host.store.deleteRun(run.id); host.removeLogs([run.id]); host.changed(); return null;
      }
      case 'clearFinishedRuns': {
        const id = request.params.sessionId;
        host.requireProjectAvailable(host.store.session(id).projectId);
        host.removeLogs(host.store.clearFinishedRuns(id)); host.changed(); return null;
      }
      case 'output': {
        const run = host.store.run(request.params.runId), live = host.live.get(run.sessionId);
        if (!run.recordOutput || host.store.session(run.sessionId).agent !== 'shell') throw new Error('仅普通终端保留运行输出；Agent 请使用原生对话历史');
        if (live?.run.id === run.id) host.flushOutput(live);
        return new RunLog(host.logs, request.params.runId).read();
      }

 default:throw new Error('插件不支持此请求');
 }});
}
