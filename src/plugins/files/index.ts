import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../../daemon/server';
import type { Request } from '../../shared/protocol';
import path from 'node:path';
export const methods=["projectFiles", "findProjectFiles", "previewFile"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.filesPluginPort();
 server.registerExtensionRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'projectFiles': return host.files.list(host.store.project(request.params.projectId).path, request.params.path, request.params.offset, request.params.limit);
      case 'findProjectFiles': return host.files.search(host.store.project(request.params.projectId).path, request.params.query);
      case 'previewFile': return host.files.preview(host.store.project(request.params.projectId).path, request.params.path);

 default:throw new Error('插件不支持此请求');
 }});
}
