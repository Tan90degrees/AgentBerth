import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../daemon/server';
import type { Request } from '../shared/protocol';
export const methods=['acpSnapshot','acpSend','acpCancel','acpPermission','acpConfigure','acpAuthenticate','acpProbe'] as const;
export function mount(ctx:Context,server:DaemonServer){
  const host=server.acpCorePort();
  server.registerCoreRoutes(ctx,methods,async(request:Request,_client:Client)=>{
    if(request.method==='acpProbe')return host.acp.probe(request.params,server.dataDirectory);
    if(!methods.includes(request.method as typeof methods[number])||!('sessionId' in request.params)||typeof request.params.sessionId!=='string')throw new Error('ACP 接口无效');
    const id=request.params.sessionId,session=host.store.session(id);
    if(!host.store.agents().find(agent=>agent.id===session.agent)?.acp||session.remote)throw new Error('此会话未使用 ACP Agent');
    switch(request.method){
      case 'acpSnapshot':return host.acp.snapshot(id,request.params);
      case 'acpSend':{
        const previous=host.store.acpTurn(request.params.requestId);
        if(previous){if(previous.sessionId!==id)throw new Error('请求 ID 已属于另一会话');return {turnId:request.params.requestId,state:previous.state,duplicate:true};}
        if(!host.acp.active(id))await host.start(id,true,100,30);return host.acp.send(id,request.params.requestId,request.params.text);
      }
      case 'acpCancel':return host.acp.cancel(id);
      case 'acpPermission':return host.acp.permission(id,request.params.permissionId,request.params.optionId);
      case 'acpConfigure':return host.acp.configure(id,request.params.configId,request.params.value);
      case 'acpAuthenticate':return host.acp.authenticate(id,request.params.methodId);
      default:throw new Error('ACP 接口无效');
    }
  });
}
