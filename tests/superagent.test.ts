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
import {decision} from '../src/superagent/plugin';

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


test('cancelling during ACP initialization remains cancelled and never starts a late worker',async t=>{
  const f=await fixture(t);
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--slow-mode']}});
  const created=await f.create();
  await until(async()=>{const task=await f.task(created.id),state=await f.connection.rpc<State>('state');return {task,run:state.sessions.find(session=>session.id===task.coordinatorSession)?.latestRun};},value=>value.task.phase==='planning'&&value.run?.pid);
  await f.call('action',{id:created.id,action:'cancel'});await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal((await f.task(created.id)).phase,'cancelled');const state=await f.connection.rpc<State>('state');assert.ok(state.sessions.every(session=>session.latestRun?.status!=='running'));const final=await f.task(created.id);assert.ok(!state.sessions.some(session=>session.id===final.workerSession));
});

test('Superagent selects plan through a current ACP mode config option',async t=>{
  const f=await fixture(t);await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--config-modes']}});
  const created=await f.create();await until(()=>f.worker(created.id),value=>value.permissions.length===1);
  const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(records.some(record=>record.method==='config'&&record.configId==='mode'&&record.value==='plan'));
  const detail=await f.call('get',{id:created.id});assert.ok(detail.audit.some((event:any)=>event.kind==='policy'&&event.text.includes('plan')));await f.call('action',{id:created.id,action:'cancel'});
});

test('Superagent applies separate role models, publishes task states and restores saved model choices',async t=>{
  const f=await fixture(t);await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--named-model']}});
  const models=await f.call('models',{projectId:f.project.id,acpId:f.agent.id});assert.equal(models.configId,'provider-model');
  const created=await f.create({coordinatorModel:'small',executorModel:'large'});const pending=await until(()=>f.worker(created.id),value=>value.permissions.length===1),ticket=await f.task(created.id);
  assert.equal(ticket.coordinatorModel,'small');assert.equal(ticket.executorModel,'large');
  const coordinator=await f.connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:ticket.coordinatorSession});assert.equal(coordinator.configOptions?.find(option=>option.id==='provider-model')?.currentValue,'small');assert.equal(pending.configOptions?.find((option:any)=>option.id==='provider-model')?.currentValue,'large');
  await until(()=>f.connection.rpc<State>('state'),value=>value.agentActivities?.some((activity:any)=>activity.taskId===ticket.id&&activity.status==='waiting'));
  await f.call('action',{id:ticket.id,action:'cancel'});await f.extension({action:'reload',id:'superagent'});const restored=await f.task(ticket.id);assert.equal(restored.coordinatorModel,'small');assert.equal(restored.executorModel,'large');
  await f.extension({action:'disable',id:'superagent'});assert.ok(!(await f.connection.rpc<State>('state')).agentActivities?.some(activity=>activity.kind==='superagent'));
});
test('an unavailable selected model interrupts before a prompt instead of silently using another model',async t=>{
  const f=await fixture(t),created=await f.create({coordinatorModel:'removed-model'});const task=await until(()=>f.task(created.id),value=>value.phase==='interrupted');assert.match(task.error,/未提供已选择的模型/);
  const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.filter(record=>record.method==='prompt').length,0);
  await f.call('action',{id:task.id,action:'complete'});assert.equal((await f.connection.rpc<State>('state')).agentActivities?.find(activity=>activity.taskId===task.id)?.status,'completed','Confirming a task must override a previous execution error in the companion');
});

test('coordinator reports accept surrounding prose, fences and quoted braces without inventing decisions',()=>{
  const expected={action:'ask',question:'选择 {x} 还是 "y"？'};assert.deepEqual(decision('分析完成。\n```json\n'+JSON.stringify(expected)+'\n```\n结束。'),expected);
  assert.equal(decision('仅包含 { 无效文本'),null);assert.equal(decision('{"example":true}'),null);
});
test('answering a coordinator question continues its own session, updates the pet, deduplicates submission and keeps worker followups in the worker',async t=>{
  const f=await fixture(t),created=await f.create({objective:'ask-human: clarify the acceptance conditions'});
  const asked=await until(()=>f.task(created.id),value=>value.phase==='needs_attention');assert.equal(asked.waitingFor,'answer');assert.match(asked.question,/验收条件/);
  let state=await f.connection.rpc<State>('state');assert.equal(state.agentActivities?.find(activity=>activity.taskId===asked.id)?.label,'等待你的回答');
  await assert.rejects(f.call('action',{id:asked.id,action:'continue',text:'   '}),/填写回答/);
  const request={id:asked.id,action:'continue',text:'验收条件是 result.txt 的内容为 SUPERAGENT_OK',requestId:randomUUID()};await f.call('action',request);assert.equal((await f.call('action',request)).duplicate,true);
  const resumed=await f.task(asked.id);assert.equal(resumed.coordinatorSession,asked.coordinatorSession);assert.notEqual(resumed.planTurn,asked.planTurn);assert.equal(resumed.question,'');
  const pending=await until(()=>f.worker(asked.id),value=>value.permissions.length===1),executing=await f.task(asked.id);
  await until(()=>f.connection.rpc<State>('state'),value=>value.agentActivities?.find((item:any)=>item.taskId===asked.id)?.label==='等待会话授权');
  await f.connection.rpc('acpPermission',{sessionId:executing.workerSession,permissionId:pending.permissions[0].id,optionId:'allow'});
  const ready=await until(()=>f.task(asked.id),value=>value.phase==='needs_attention'&&value.stage==='worker');assert.equal(ready.waitingFor,'review');
  state=await f.connection.rpc<State>('state');assert.equal(state.agentActivities?.find(activity=>activity.taskId===asked.id)?.label,'等待验收');
  const previousWorker=ready.workerSession;await f.call('action',{id:ready.id,action:'continue',text:'再验证一次文件内容',requestId:randomUUID()});
  const again=await until(()=>f.worker(asked.id),value=>value.permissions.length===1);assert.equal((await f.task(asked.id)).workerSession,previousWorker);assert.equal((await f.task(asked.id)).coordinatorSession,asked.coordinatorSession);
  const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const prompts=records.filter(record=>record.method==='prompt');assert.equal(prompts.filter(record=>record.text.includes('你是 Superagent 的协调者')).length,2);assert.equal(prompts.filter(record=>record.text.includes('你是 Superagent 的独立执行器')).length,2);assert.ok(prompts[1].text.includes('此前问题：请选择验收条件'));assert.ok(prompts[1].text.includes(request.text));
  await f.connection.rpc('acpPermission',{sessionId:previousWorker,permissionId:again.permissions[0].id,optionId:'allow'});await until(()=>f.task(asked.id),value=>value.phase==='needs_attention');await f.call('action',{id:asked.id,action:'complete'});
});
test('a coordinator JSON decision surrounded by prose dispatches the worker instead of getting stuck awaiting confirmation',async t=>{
  const f=await fixture(t),created=await f.create({objective:'prose-report: create result'});await until(()=>f.worker(created.id),value=>value.permissions.length===1);assert.equal((await f.task(created.id)).stage,'worker');await f.call('action',{id:created.id,action:'cancel'});
});
