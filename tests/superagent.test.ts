import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection} from '../src/main/connection';
import type {AcpSnapshot} from '../src/shared/acp';
import type {State} from '../src/shared/protocol';

const execute=promisify(execFile),sourceId='example.superagent.source.local/local';
async function until(read:()=>Promise<any>,predicate:(value:any)=>boolean,ms=25000){const end=Date.now()+ms;let value;do{value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,60));}while(Date.now()<end);throw new Error('Superagent condition timed out: '+JSON.stringify(value));}
async function fixture(t:any){
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-superagent-')),root=path.join(dir,'project');await mkdir(root);await mkdir(path.join(dir,'fixture-agent'));
  const git=async(...args:string[])=>execute('git',['-c','core.autocrlf=false','-c','commit.gpgsign=false','-C',root,...args],{windowsHide:true});
  await git('init','--initial-branch=main');await git('config','user.name','Superagent fixture');await git('config','user.email','fixture@example.invalid');await writeFile(path.join(root,'base.txt'),'base');await git('add','.');await git('commit','-m','initial');
  const data=path.join(dir,'data'),server=new DaemonServer(data),connection=await DaemonConnection.open(await server.listen(),()=>{});
  t.after(async()=>{connection.close();await server.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
  const project=await connection.rpc<any>('createProject',{name:'Superagent project',path:root}),agent=await connection.rpc<any>('createAgent',{name:'Superagent fixture ACP',command:process.execPath,acp:{executable:process.execPath,args:[path.resolve('tests/fixtures/acp-agent.cjs'),path.join(dir,'fixture-agent')],env:{ELECTRON_RUN_AS_NODE:'1'}}});
  const extension=(request:any)=>connection.rpc<any>('extensions',{request}),call=(command:string,params:Record<string,unknown>={})=>extension({action:'call',id:'superagent',command,params});
  const create=(extra:any={})=>call('create',{projectId:project.id,coordinatorId:agent.id,executorId:agent.id,title:'Test task',objective:'Create result and validate it',isolated:true,...extra});
  const task=async(id:string)=>(await call('get',{id})).task;
  const worker=async(id:string)=>{const value=await task(id);return connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:value.workerSession}).catch(error=>{if(String(error).includes('会话不存在'))return {permissions:[],phase:'disconnected'} as unknown as AcpSnapshot;throw error;});};
  return {dir,root,data,server,connection,project,agent,extension,call,create,task,worker,git};
}
test('Superagent isolates ACP workers/worktrees, enforces concurrency, requests human review and leaves unrelated work running',async t=>{
  const f=await fixture(t);await f.extension({action:'configure',id:'superagent',config:{maxConcurrent:1}});
  const unrelated=await f.connection.rpc<any>('createSession',{projectId:f.project.id,agent:f.agent.id,title:'Unrelated work',command:''});await f.connection.rpc('acpSend',{sessionId:unrelated.id,requestId:randomUUID(),text:'long'});
  const first=await f.create({title:'First'}),second=await f.create({title:'Second'});
  const pending=await until(()=>f.worker(first.id),value=>value.permissions.length===1);const firstTask=await f.task(first.id);assert.equal((await f.task(second.id)).phase,'queued');assert.ok(firstTask.worktreePath);assert.notEqual(firstTask.coordinatorSession,firstTask.workerSession);
  await f.connection.rpc('acpPermission',{sessionId:firstTask.workerSession,permissionId:pending.permissions[0].id,optionId:'allow'});
  const ready=await until(()=>f.task(first.id),value=>value.phase==='needs_attention'&&value.stage==='worker');assert.match(ready.summary,/fake validated/);assert.equal(await readFile(path.join(ready.worktreePath,'result.txt'),'utf8'),'SUPERAGENT_OK');await assert.rejects(readFile(path.join(f.root,'result.txt')),/ENOENT/);assert.equal((await f.git('branch','--show-current')).stdout.trim(),'main');
  await f.call('action',{id:first.id,action:'complete'});assert.equal((await f.task(first.id)).phase,'completed');
  await until(()=>f.worker(second.id),value=>value.permissions.length===1);await f.call('action',{id:second.id,action:'cancel'});assert.equal((await f.task(second.id)).phase,'cancelled');
  const state=await f.connection.rpc<State>('state');assert.equal(state.sessions.find(session=>session.id===unrelated.id)?.latestRun?.status,'running');
});
test('custom source plugins bind project/ACP policy, deduplicate events, enforce actors and deliver only explicitly reviewed replies',async t=>{
  const f=await fixture(t);const installed=await f.extension({action:'install',path:path.resolve('examples/superagent-source-local')});assert.equal(installed.plugins.find((plugin:any)=>plugin.manifest.id==='example.superagent.source.local').status,'active',JSON.stringify(installed));
  const emit=(event:any)=>f.extension({action:'call',id:'example.superagent.source.local',command:'emit',params:{id:'event-1',threadId:'thread-1',actorId:'alice',title:'Source task',text:'Create result',...event}});
  await assert.rejects(emit({}),/尚未绑定/);
  const policy={sourceId,enabled:true,projectId:f.project.id,coordinatorId:f.agent.id,executorId:f.agent.id,allowedActors:['alice'],autoApprove:true,isolated:true};
  await assert.rejects(f.call('source_policy',{...policy,allowedActors:[]}),/授权身份/);await f.call('source_policy',policy);
  assert.equal((await emit({id:'denied',actorId:'bob'})).accepted,false);
  const accepted=await emit({}),duplicate=await emit({});assert.equal(accepted.accepted,true);assert.equal(duplicate.duplicate,true);assert.equal(accepted.ticketId,duplicate.ticketId);
  const pending=await until(()=>f.worker(accepted.ticketId),value=>value.permissions.length===1),task=await f.task(accepted.ticketId);await f.connection.rpc('acpPermission',{sessionId:task.workerSession,permissionId:pending.permissions[0].id,optionId:'allow'});await until(()=>f.task(accepted.ticketId),value=>value.phase==='needs_attention');
  await f.extension({action:'configure',id:'example.superagent.source.local',config:{loseAck:true}});
  const requestId=randomUUID(),message={id:accepted.ticketId,requestId,text:'Reviewed result: ready'};
  assert.equal((await f.call('reply',message)).state,'unknown');assert.equal((await f.call('reply',message)).state,'unknown');
  const retried=await f.call('reply',{...message,retry:true});assert.equal(retried.state,'sent');const receipts=JSON.parse(await readFile(path.join(f.data,'extensions','data','example.superagent.source.local','receipts.json'),'utf8'));assert.equal(Object.keys(receipts).length,1);
  await f.call('source_policy',{...policy,autoApprove:false,allowedActors:[]});const waiting=await emit({id:'manual'});assert.equal((await f.task(waiting.ticketId)).approved,false);assert.equal((await f.task(waiting.ticketId)).phase,'needs_attention');
  await f.extension({action:'disable',id:'example.superagent.source.local'});assert.equal((await f.call('state')).sources.length,0);assert.ok((await f.task(accepted.ticketId)).source);
});
test('stopping/reloading Superagent retains checkpoints and never replays interrupted work',async t=>{
  const f=await fixture(t),created=await f.create();await until(()=>f.worker(created.id),value=>value.permissions.length===1);const before=await f.task(created.id);
  await f.extension({action:'disable',id:'superagent'});const state=await f.connection.rpc<State>('state');assert.notEqual(state.sessions.find(session=>session.id===before.workerSession)?.latestRun?.status,'running');
  const logBefore=await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8');await f.extension({action:'enable',id:'superagent'});assert.equal((await f.task(created.id)).phase,'interrupted');await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8'),logBefore);assert.ok((await f.task(created.id)).worktreePath);
});

test('built standalone Superagent package installs as a real Cordis provider without bundled sources or MCP UI commands',async t=>{
  const f=await fixture(t);await f.extension({action:'disable',id:'superagent'});
  const result=await f.extension({action:'install',path:path.resolve('dist/superagent-plugin.zip')}),plugin=result.plugins.find((plugin:any)=>plugin.manifest.id==='superagent.custom');
  assert.equal(plugin.status,'active',JSON.stringify(plugin));assert.ok(plugin.commands.every((command:any)=>command.mcp===false));
  const state=await f.extension({action:'call',id:'superagent.custom',command:'state'});assert.deepEqual(state.sources,[]);assert.ok(state.agents.some((agent:any)=>agent.id===f.agent.id));
  const view=await f.extension({action:'view',id:'superagent.custom',view:'tasks'});assert.match(view,/信息源插件/);
});


test('a coordinator setup failure stops its owned ACP connection and remains explicitly interrupted',async t=>{
  const f=await fixture(t);
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--fail-mode']}});
  const created=await f.create(),interrupted=await until(()=>f.task(created.id),value=>value.phase==='interrupted');assert.match(interrupted.error,/mode failed/);
  const state=await f.connection.rpc<State>('state');assert.notEqual(state.sessions.find(session=>session.id===interrupted.coordinatorSession)?.latestRun?.status,'running');
  await f.extension({action:'disable',id:'superagent'});
});
