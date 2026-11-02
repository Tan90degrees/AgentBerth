import type { Context } from 'cordis';
import type { DaemonServer, Client } from '../daemon/server';
import type { Request } from '../shared/protocol';
import path from 'node:path';
export const methods=["gitStatus","gitWorktrees","gitCreateWorktree","gitRemoveWorktree","gitDiff","gitOperation"] as const;
export function mount(ctx:Context,server:DaemonServer){
 const host=server.gitCorePort();
 server.registerCoreRoutes(ctx,methods,async(request:Request,client:Client)=>{switch(request.method){
      case 'gitStatus': {
        const project=host.store.project(request.params.projectId);
        const cwd=await host.git.resolveWorktree(project.path,request.params.worktreePath);
        return host.git.status(cwd);
      }
      case 'gitWorktrees': {
        const project=host.store.project(request.params.projectId);
        return (await host.git.worktrees(project.path)).map(worktree=>({...worktree,sessionCount:host.store.sessionIdsUnderPath(worktree.path).length}));
      }
      case 'gitCreateWorktree': {
        const project=host.store.project(request.params.projectId);
        host.requireProjectAvailable(project.id);
        if(host.gitBusy.has(project.id))throw new Error('此项目正在执行 Git 操作，请稍后重试');
        host.gitBusy.add(project.id);
        try {
          const created=await host.git.createWorktree(project.path,request.params.branch,request.params.createBranch,request.params.baseRef);
          host.changed();return created;
        } finally {host.gitBusy.delete(project.id);}
      }
      case 'gitRemoveWorktree': {
        const project=host.store.project(request.params.projectId);
        host.requireProjectAvailable(project.id);
        if(host.gitBusy.has(project.id))throw new Error('此项目正在执行 Git 操作，请稍后重试');
        const worktree=(await host.git.worktrees(project.path)).find(item=>(process.platform==='win32'?item.path.toLowerCase():item.path)===(process.platform==='win32'?path.resolve(request.params.path).toLowerCase():path.resolve(request.params.path)));
        if(!worktree)throw new Error('Worktree 不属于当前项目，或已经被删除');
        if(worktree.main)throw new Error('主工作区不能删除');
        const sessionIds=host.store.sessionIdsUnderPath(worktree.path);
        if(sessionIds.length&&!request.params.deleteSessions)throw new Error(`此 Worktree 还有 ${sessionIds.length} 个会话；确认删除关联会话后才能移除`);
        for(const sessionId of sessionIds)host.requireIdle(sessionId);
        host.gitBusy.add(project.id);
        try {
          await host.git.removeWorktree(project.path,worktree.path);
          if(sessionIds.length)host.removeLogs(host.store.deleteSessions(sessionIds));
          host.changed();return null;
        } finally {host.gitBusy.delete(project.id);}
      }
      case 'gitDiff': {
        const project=host.store.project(request.params.projectId);
        const cwd=await host.git.resolveWorktree(project.path,request.params.worktreePath);
        return host.git.diff(cwd,request.params);
      }
      case 'gitOperation': {
        const params=request.params,project=host.store.project(params.projectId);
        host.requireProjectAvailable(project.id);
        const cwd=await host.git.resolveWorktree(project.path,params.worktreePath);
        const status=await host.git.status(cwd);
        if(host.closing)throw new Error('后台正在退出');
        if(host.gitBusy.has(project.id))throw new Error('此项目正在执行 Git 操作，请稍后重试');
        host.gitBusy.add(project.id);
        try{return await host.git.operate(cwd,params);}
        finally{host.gitBusy.delete(project.id);}
      }
      default:throw new Error('核心接口不支持此请求');
 }});
}
