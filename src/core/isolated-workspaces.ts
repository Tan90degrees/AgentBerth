import type {Context} from 'cordis';
import type {DaemonServer,Client} from '../daemon/server';
import type {Request} from '../shared/protocol';
export function mount(ctx:Context,server:DaemonServer){
 const host=server.isolatedCorePort();
 server.registerCoreRoutes(ctx,['isolatedWorkspace'],async(request:Request,_client:Client)=>{
  if(request.method!=='isolatedWorkspace')throw new Error('接口无效');const p=request.params;
  if(p.action==='job')return host.copies.job(p.jobId!);
  if(p.action==='cancel')return host.copies.cancel(p.jobId!);
  if(p.action==='list')return host.copies.list();
  const key=p.workspaceId!;let project;try{project=host.store.project(p.projectId!);}catch(error){if(p.action!=='delete')throw error;const copy=(await host.copies.list()).find(copy=>copy.id===key&&copy.projectId===p.projectId);if(!copy)throw error;project={id:copy.projectId,path:copy.projectPath,name:copy.name};}
  if(['create','reset','apply','delete'].includes(p.action))for(const session of host.store.state().sessions)if(session.worktreePath?.includes(key))host.requireIdle(session.id);
  if(p.action==='delete')return host.copies.remove(key,project.id,project.path);
  const status=await host.copies.status(key,project.id,project.path);
  switch(p.action){
   case 'status':return status;
   case 'scan':return host.copies.scan(key,project.id,project.path,p.options);
   case 'create':case 'reset':return host.copies.create(key,project.id,project.path,p.name??project.name,p.token!,p.skipLinks,p.action==='reset',p.owner);
   case 'changes':{const value=await host.copies.changes(key,project.id,project.path);return {...value,changes:value.changes.slice(p.offset,p.offset+p.limit),total:value.changes.length,conflicts:value.changes.filter(item=>item.conflict).length};}
   case 'preview':return host.copies.preview(key,project.id,project.path,p.path!);
   case 'apply':return host.copies.apply(key,project.id,project.path,p.changes!);
   case 'export':{const value=await host.copies.changes(key,project.id,project.path);return host.copies.export(key,project.id,project.path,value.changes);}
  }
 });
}
