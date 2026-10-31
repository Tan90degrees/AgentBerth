import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../../daemon/server';
import type { Request } from '../../shared/protocol';
import path from 'node:path';
import { statSync } from 'node:fs';
import { resolveTerminal } from '../../daemon/paths';
import { matchesProject } from '../../daemon/history';
export const methods=["createAgent", "updateAgent", "probeAgentPlugin", "checkAgentPlugin", "deleteAgent", "linkNativeSession", "unlinkNativeSession", "nativeSessionDetected", "nativeHistories", "discoverNativeHistories", "nativeHistory", "history", "importHistory", "refreshHistory"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.agentsPluginPort();
 server.registerExtensionRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'createAgent':
      case 'updateAgent': {
        const { params } = request;
        const { agentId, ...config } = 'agentId' in params ? params : { ...params, agentId: undefined };
        const previous = agentId ? host.store.agent(agentId) : null;
        if(previous?.sourceId?.startsWith('ext.'))throw new Error('此 Agent 由 Cordis 插件管理，请在设置 → 插件中修改');
        if(config.sourceId?.startsWith('ext.'))throw new Error('ext. 是 Cordis 插件保留的来源 ID');
        const version = agentId ? host.agentVersion(agentId) : 0;
        const identity = previous?.sourceId ?? previous?.plugin?.sourceId;
        if (identity && identity !== (config.sourceId ?? config.plugin?.sourceId)) throw new Error('插件 ID 与当前类型不一致，请导入同一类型的更新文件');
        if (config.plugin) {
          if (!path.isAbsolute(config.plugin.executable)) throw new Error('插件程序须使用完整路径');
          if (config.plugin.runtime === 'node') { if (!statSync(config.plugin.executable).isFile()) throw new Error('插件入口文件不存在'); }
          else await resolveTerminal({ profile: 'custom', executable: config.plugin.executable, args: config.plugin.args });
          if (previous && JSON.stringify(previous.plugin) !== JSON.stringify(config.plugin)) await host.plugins.check({ id: agentId!, ...config });
        }
        if (host.closing) throw new Error('后台正在退出');
        if (agentId) { host.store.agent(agentId); host.assertAgentVersion(agentId, version); }
        const agent = host.store.saveAgent(config, agentId);
        host.agentVersions.set(agent.id, version + 1);
        host.changed(); return agent;
      }
      case 'probeAgentPlugin': return host.plugins.check({ id: 'preview', ...request.params });
      case 'checkAgentPlugin': return host.plugins.check(host.store.agent(request.params.agentId));
      case 'deleteAgent': if(host.store.agent(request.params.agentId).sourceId?.startsWith('ext.'))throw new Error('请在设置 → 插件中卸载接入插件');host.store.deleteAgent(request.params.agentId); host.agentVersions.delete(request.params.agentId); host.changed(); return null;
      case 'linkNativeSession': {
        const session = host.store.session(request.params.sessionId);
        host.requireHistoryAvailable(session.id);
        if (!['codex', 'claude', 'opencode'].includes(host.integration(session)) && !(session.agent.startsWith('agent:') && (host.store.agent(session.agent).resumeCommand || host.store.agent(session.agent).plugin?.resume || host.store.agent(session.agent).plugin?.history || host.store.agent(session.agent).plugin?.list))) throw new Error('当前 Agent 不支持原生会话恢复');
        const history = host.store.nativeHistory(session.id, request.params.nativeSessionId) ?? { messages: [], warnings: ['仅关联原生会话 ID；导入记录后可查看对话文本'], path: null, nativeSessionId: request.params.nativeSessionId };
        host.nativeTracking.delete(session.id);
        host.store.saveHistory(session.id, history); host.changed(); return history;
      }
      case 'unlinkNativeSession': {
        const id = request.params.sessionId; host.requireHistoryAvailable(id);
        host.nativeTracking.delete(id);
        const history = { messages: [], warnings: [], path: null, nativeSessionId: null };
        host.store.saveHistory(id, history); host.changed(); return history;
      }
      case 'nativeSessionDetected': {
        const p = request.params, session = host.store.session(p.sessionId), tracking = host.nativeTracking.get(session.id);
        const version = host.agentVersion(session.agent);
        if (host.integration(session) !== p.provider || session.remote || session.latestRun?.id !== p.runId || !host.live.has(session.id) || host.live.get(session.id)?.closed || tracking?.runId !== p.runId || session.nativeSessionId && session.nativeSessionId !== tracking.hookNativeId || host.historyBusy.has(session.id) || !await matchesProject(p.cwd, host.store.project(session.projectId).path)) return { linked: false };
        if (session.nativeSessionId === p.nativeSessionId) return { linked: true };
        const transcript = p.provider === 'claude' ? (await host.nativeDiscovery.list('claude', host.store.project(session.projectId).path)).find(item => item.nativeSessionId === p.nativeSessionId)?.path : null;
        if (p.provider === 'claude' && !transcript) return { linked: false };
        // Recheck after path I/O: manual association/unlink always wins.
        if (host.nativeTracking.get(session.id) !== tracking || host.store.session(session.id).nativeSessionId !== session.nativeSessionId || host.agentVersion(session.agent) !== version) return { linked: false };
        host.store.saveHistory(session.id, { messages: [], warnings: [], path: transcript ?? null, nativeSessionId: p.nativeSessionId });
        tracking.ambiguous = true; tracking.hookNativeId = p.nativeSessionId; host.changed(); return { linked: true };
      }
      case 'nativeHistories': return host.store.nativeHistories(request.params.sessionId, request.params);
      case 'discoverNativeHistories': return host.discoverHistories(request.params.sessionId, request.params);
      case 'nativeHistory': return host.previewHistory(request.params.sessionId, request.params.nativeSessionId, request.params.refresh);
      case 'history': return host.store.history(request.params.sessionId);
      case 'importHistory': return host.importHistory(request.params.sessionId, request.params.path);
      case 'refreshHistory': {
        const session = host.store.session(request.params.sessionId);
        if (!session.transcriptPath && !(['claude', 'opencode'].includes(host.integration(session)) && session.nativeSessionId) && !(session.agent.startsWith('agent:') && host.store.agent(session.agent).plugin?.history)) throw new Error('请先关联原生对话记录');
        return host.importHistory(request.params.sessionId, session.transcriptPath);
      }
 default:throw new Error('插件不支持此请求');
 }});
}
