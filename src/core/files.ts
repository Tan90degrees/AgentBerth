import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../daemon/server';
import type { Request } from '../shared/protocol';
import path from 'node:path';
export const methods=["projectFiles", "findProjectFiles", "previewFile"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.filesCorePort();
 server.registerCoreRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'projectFiles': {
        const project = host.store.project(request.params.projectId);
        const cwd = await host.resolveWorkspace(project.id,project.path, request.params.worktreePath);
        return host.files.list(cwd, request.params.path, request.params.offset, request.params.limit);
      }
      case 'findProjectFiles': {
        const project = host.store.project(request.params.projectId);
        const cwd = await host.resolveWorkspace(project.id,project.path, request.params.worktreePath);
        return host.files.search(cwd, request.params.query);
      }
      case 'previewFile': {
        const project = host.store.project(request.params.projectId);
        const cwd = await host.resolveWorkspace(project.id,project.path, request.params.worktreePath);
        return host.files.preview(cwd, request.params.path);
      }

 default:throw new Error('核心接口不支持此请求');
 }});
}
