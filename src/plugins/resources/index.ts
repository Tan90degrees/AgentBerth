import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../../daemon/server';
import type { Request } from '../../shared/protocol';

export const methods=["resources"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.resourcesPluginPort();
 server.registerExtensionRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'resources': return host.resources.sample([...host.live.entries()].filter(([,live])=>!live.closed && !live.remote).map(([sessionId,live])=>({sessionId,projectId:host.store.session(sessionId).projectId,runId:live.run.id,pid:live.pty.pid})),request.params.appPids);

 default:throw new Error('插件不支持此请求');
 }});
}
