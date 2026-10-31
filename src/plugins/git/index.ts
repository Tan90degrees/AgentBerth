import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../../daemon/server';
import type { Request } from '../../shared/protocol';
import path from 'node:path';
export const methods=["gitStatus", "gitDiff", "gitOperation"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.gitPluginPort();
 server.registerExtensionRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'gitStatus': return host.git.status(host.store.project(request.params.projectId).path);
      case 'gitDiff': return host.git.diff(host.store.project(request.params.projectId).path, request.params);
      case 'gitOperation': {
        const params = request.params, project = host.store.project(params.projectId);
        host.requireProjectAvailable(project.id);
        const status = await host.git.status(project.path);
        if (host.closing) throw new Error('后台正在退出');
        const within = (a: string,b: string) => { const relative=path.relative(a,b);return relative!== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative); };
        const affected = host.store.state().projects.filter(item => within(status.root,item.path) || within(item.path,status.root));
        for (const item of affected) host.requireProjectAvailable(item.id);
        for (const item of affected) if (host.gitBusy.has(item.id)) throw new Error('此仓库正在执行 Git 操作，请稍后重试');
        for (const item of affected) host.gitBusy.add(item.id);
        try { return await host.git.operate(project.path,params); }
        finally { for (const item of affected) host.gitBusy.delete(item.id); }
      }

 default:throw new Error('插件不支持此请求');
 }});
}
