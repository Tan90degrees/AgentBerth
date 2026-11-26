import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../daemon/server';
import type { Request } from '../shared/protocol';
import {discoverAcpAgents,readAcpRegistry,prepareAcpRegistryAgent} from '../daemon/acp-registry';
import {directory} from '../daemon/paths';
export const methods=['acpHistory','acpArchive','acpDiscover','acpMcpConfig','acpRegistry','acpRegistryPrepare','acpNativeHistory','acpSubmit','acpQueue','acpImage','acpSnapshot','acpSend','acpCancel','acpPermission','acpElicitation','acpConfigure','acpAuthenticate','acpAuthTerminal','acpLogout','acpProbe','acpOptions','acpTerminal','acpMedia'] as const;
export function mount(ctx:Context,server:DaemonServer){
  const host=server.acpCorePort();
  server.registerCoreRoutes(ctx,methods,async(request:Request,_client:Client)=>{
    if(request.method==='acpHistory')return host.acp.history();
    if(request.method==='acpRegistry')return (await readAcpRegistry()).map(({binary,...entry})=>({...entry,binary:!!binary}));
    if(request.method==='acpRegistryPrepare')return prepareAcpRegistryAgent(request.params.registryId,request.params.version,server.dataDirectory);
    if(request.method==='acpDiscover')return discoverAcpAgents();
    if(request.method==='acpMcpConfig'){
      const {agentId,servers}=request.params;
      if(!host.store.agent(agentId).acp)throw new Error('请选择可用的 ACP Agent');
      if(servers!==undefined){
        if(host.acp.usesAgent(agentId))throw new Error('请先断开使用此 Agent 的会话');
        host.store.saveAcpMcpServers(agentId,servers);
      }
      return host.store.acpMcpServers(agentId);
    }
    if(request.method==='acpNativeHistory'){
      const {agentId,projectId,worktreePath,cursor,nativeId,remove}=request.params;
      const agent=host.store.agent(agentId),project=host.store.project(projectId);
      if(!agent.acp||project.remoteWorkspace)throw new Error('请选择本机项目与 ACP Agent');
      host.requireProjectAvailable(projectId);
      const root=await directory(project.path);
      const cwd=await host.resolveWorkspace(project.id,root,worktreePath);
      host.requireProjectAvailable(projectId);
      if(host.worktreeBusy.has(projectId))throw new Error('Worktree 正在变更，请稍后重试');
      return host.acp.nativeHistory(agent,cwd,projectId,worktreePath?cwd:null,cursor,nativeId,remove);
    }
    if(request.method==='acpProbe')return host.acp.probe(request.params,server.dataDirectory);
    if(request.method==='acpOptions'){
      const agent=host.store.agent(request.params.agentId),project=host.store.project(request.params.projectId);
      if(!agent.acp||project.remoteWorkspace)throw new Error('请选择本机项目与 ACP Agent');
      return host.acp.options(agent,await directory(project.path));
    }
    if(!methods.includes(request.method as typeof methods[number])||!('sessionId' in request.params)||typeof request.params.sessionId!=='string')throw new Error('ACP 接口无效');
    const id=request.params.sessionId,session=host.store.session(id);
    if(!host.store.agents().find(agent=>agent.id===session.agent)?.acp||session.remote)throw new Error('此会话未使用 ACP Agent');
    if(session.owner&&['acpArchive','acpSubmit','acpQueue','acpImage'].includes(request.method))throw new Error('请从原任务管理托管会话');
    switch(request.method){
      case 'acpArchive':return host.acp.archive(id,request.params.archived);
      case 'acpQueue':return host.acp.queue(id,request.params.action,request.params.requestId,request.params.text);
      case 'acpImage':return host.acp.image(request.params);
      case 'acpSubmit':return host.acp.submit(id,request.params.message,request.params.queue);

      case 'acpSnapshot':return host.acp.snapshot(id,request.params);
      case 'acpMedia':return host.store.acpMedia(id,request.params.mediaId,request.params.offset);
      case 'acpTerminal':return host.acp.terminal(id,request.params.terminalId);
      case 'acpSend':{
        const previous=host.store.acpTurn(request.params.requestId);
        if(previous){if(previous.sessionId!==id)throw new Error('请求 ID 已属于另一会话');return {turnId:request.params.requestId,state:previous.state,duplicate:true};}
        await host.ensureStarted(id);return host.acp.send(id,request.params.requestId,request.params.text);
      }
      case 'acpCancel':return host.acp.cancel(id,request.params.childSessionId);
      case 'acpPermission':return host.acp.permission(id,request.params.permissionId,request.params.optionId);
      case 'acpElicitation':return host.acp.elicitation(id,request.params.requestId,request.params.action,request.params.content);
      case 'acpConfigure':return host.acp.configure(id,request.params.configId,request.params.value);
      case 'acpLogout':return host.acp.logout(id);
      case 'acpAuthenticate':return host.acp.authenticate(id,request.params.methodId,request.params.terminalApproved);
      case 'acpAuthTerminal':{
        const {terminalId,action,input,cols,rows}=request.params;
        return host.acp.authTerminal(id,terminalId,action,input,cols,rows);
      }
      default:throw new Error('ACP 接口无效');
    }
  });
}
