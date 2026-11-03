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
import {taskQuestions} from '../src/shared/task-questions';
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


test('running task instructions persist, withdraw safely and drain FIFO without overlapping prompts or replay',async t=>{
  const f=await fixture(t),created=await f.create();const first=await until(()=>f.worker(created.id),value=>value.permissions.length===1),original=await f.task(created.id);
  const send=(text:string)=>({id:created.id,inputId:randomUUID(),action:'send',mode:'queue',text});const one=send('QUEUE_ONE: preserve compatibility'),two=send('QUEUE_TWO: add regression coverage'),withdrawn=send('WITHDRAW_ME');
  await f.call('input',one);assert.equal((await f.call('input',one)).duplicate,true);await f.call('input',two);await f.call('input',withdrawn);await f.call('input',{id:created.id,inputId:withdrawn.inputId,action:'withdraw'});
  let detail=await f.call('get',{id:created.id});assert.equal(detail.inputs.filter((input:any)=>input.state==='queued').length,2);assert.equal((await f.worker(created.id)).turnId,first.turnId,'Queueing must leave the active turn and permission intact');
  await f.connection.rpc('acpPermission',{sessionId:original.workerSession,permissionId:first.permissions[0].id,optionId:'allow'});
  const second=await until(()=>f.worker(created.id),value=>value.permissions.length===1&&value.turnId!==first.turnId);detail=await f.call('get',{id:created.id});assert.equal(detail.inputs.find((input:any)=>input.id===one.inputId).state,'sent');await assert.rejects(f.call('input',{id:created.id,inputId:one.inputId,action:'withdraw'}),/尚未发送/);
  await f.connection.rpc('acpPermission',{sessionId:original.workerSession,permissionId:second.permissions[0].id,optionId:'allow'});const third=await until(()=>f.worker(created.id),value=>value.permissions.length===1&&value.turnId!==second.turnId);
  await f.connection.rpc('acpPermission',{sessionId:original.workerSession,permissionId:third.permissions[0].id,optionId:'allow'});await until(()=>f.task(created.id),value=>value.phase==='needs_attention');
  const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),prompts=records.filter(row=>row.method==='prompt');assert.equal(prompts.filter(row=>row.text.includes('QUEUE_ONE')).length,1);assert.equal(prompts.filter(row=>row.text.includes('QUEUE_TWO')).length,1);assert.ok(!prompts.some(row=>row.text.includes('WITHDRAW_ME')));assert.ok(prompts.findIndex(row=>row.text.includes('QUEUE_ONE'))<prompts.findIndex(row=>row.text.includes('QUEUE_TWO')));assert.equal((await f.task(created.id)).workerSession,original.workerSession);
  const history=await f.call('thread',{id:created.id});assert.ok(history.messages.some((row:any)=>row.text.includes('QUEUE_ONE')));assert.ok(history.messages.some((row:any)=>row.role==='assistant'));await f.call('action',{id:created.id,action:'complete'});
});
test('interrupting a streaming worker waits for cancellation, prioritizes the interjection and retains queued work through reload',async t=>{
  const f=await fixture(t);await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--hold-worker']}});
  const created=await f.create();const live=await until(()=>f.worker(created.id),value=>value.phase==='running'&&value.events.some((event:any)=>event.text.includes('worker running'))),original=await f.task(created.id);
  const normal={id:created.id,inputId:randomUUID(),action:'send',mode:'queue',text:'NORMAL_AFTER_INTERRUPT'};await f.call('input',normal);await new Promise(resolve=>setTimeout(resolve,1200));assert.equal((await f.worker(created.id)).turnId,live.turnId);
  await f.call('input',{id:created.id,inputId:randomUUID(),action:'send',mode:'interrupt',text:'URGENT_CHANGE_SCOPE'});const resumed=await until(()=>f.worker(created.id),value=>value.permissions.length===1&&value.turnId!==live.turnId);
  const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),urgent=records.findIndex(row=>row.method==='prompt'&&row.text.includes('URGENT_CHANGE_SCOPE'));assert.ok(records.findIndex(row=>row.method==='cancel')<urgent);assert.ok(!records.some(row=>row.method==='prompt'&&row.text.includes(normal.text)));assert.equal(resumed.sessionId,original.workerSession);
  await f.extension({action:'disable',id:'superagent'});const previousLog=await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8');await f.extension({action:'enable',id:'superagent'});assert.equal((await f.task(created.id)).phase,'interrupted');assert.equal((await f.call('get',{id:created.id})).inputs.find((input:any)=>input.id===normal.inputId).state,'queued');assert.equal((await f.call('input',normal)).duplicate,true);await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8'),previousLog);
  await f.call('action',{id:created.id,action:'cancel'});assert.equal((await f.call('get',{id:created.id})).inputs.find((input:any)=>input.id===normal.inputId).state,'withdrawn');
});

test('question cards normalize plain questions, options and multiselect while bounding malformed Agent content',()=>{
  assert.deepEqual(taskQuestions('需要哪个分支？')[0].options,[]);const [question]=taskQuestions({questions:[{header:'范围',question:'选择目标',multiSelect:true,options:['A',{label:'B',description:'第二项'},null]}]});assert.equal(question.multiple,true);assert.deepEqual(question.options.map(option=>option.label),['A','B']);assert.deepEqual(taskQuestions({questions:[null,{options:[]}]}),[]);
});
test('Superagent session ownership survives plugin disable and retry, and never claims an unrelated or foreign-project session',async t=>{
  const f=await fixture(t),created=await f.create(),pending=await until(()=>f.worker(created.id),value=>value.permissions.length===1),ticket=await f.task(created.id);let state=await f.connection.rpc<State>('state');
  for(const id of [ticket.coordinatorSession,ticket.workerSession])assert.deepEqual(state.sessions.find(session=>session.id===id)?.owner,{kind:'superagent',projectId:f.project.id,pluginId:'superagent',taskId:created.id});
  const unrelated=await f.connection.rpc<any>('createSession',{projectId:f.project.id,agent:f.agent.id,title:'Superagent · user named terminal',command:''});assert.equal(unrelated.owner,undefined);
  await f.connection.rpc('acpPermission',{sessionId:ticket.workerSession,permissionId:pending.permissions[0].id,optionId:'allow'});await until(()=>f.task(created.id),value=>value.phase==='needs_attention');await f.call('action',{id:created.id,action:'retry'});await until(()=>f.worker(created.id),value=>value.permissions.length===1);await f.extension({action:'disable',id:'superagent'});
  state=await f.connection.rpc<State>('state');assert.equal(state.sessions.find(session=>session.id===ticket.workerSession)?.owner?.taskId,created.id);assert.ok(state.sessions.filter(session=>session.owner?.taskId===created.id).length>=4);assert.equal(state.sessions.find(session=>session.id===unrelated.id)?.owner,undefined);assert.ok(!state.agentActivities?.some(activity=>activity.kind==='acp'&&state.sessions.find(session=>session.id===activity.id)?.owner));
  assert.throws(()=>f.server.agentsCorePort().store.manageSessions('different-plugin',{kind:'superagent',projectId:f.project.id,taskId:randomUUID(),sessionIds:[ticket.workerSession]}),/其他任务/);
});

test('an input reserved before a failed start is marked unknown and never resent by reload',async t=>{
  const f=await fixture(t);await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--fail-mode']}});const created=await f.create(),input={id:created.id,inputId:randomUUID(),action:'send',mode:'queue',text:'Do not silently replay this instruction'};await f.call('input',input);await until(()=>f.task(created.id),value=>value.phase==='interrupted');assert.equal((await f.call('get',{id:created.id})).inputs.find((value:any)=>value.id===input.inputId).state,'unknown');await f.extension({action:'reload',id:'superagent'});assert.equal((await f.call('input',input)).state,'unknown');const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.filter(record=>record.method==='prompt').length,0);
});

test('an interjection during ACP startup replaces the pending dispatch without sending the old prompt first',async t=>{
  const f=await fixture(t);await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,args:[...f.agent.acp.args,'--slow-mode']}});const created=await f.create();
  await until(async()=>{const task=await f.task(created.id),state=await f.connection.rpc<State>('state');return {task,session:state.sessions.find(session=>session.id===task.coordinatorSession)};},value=>value.task.phase==='planning'&&value.session?.latestRun?.pid);
  await f.call('input',{id:created.id,inputId:randomUUID(),action:'send',mode:'interrupt',text:'EARLY_STEER: narrow the acceptance scope'});await until(()=>f.worker(created.id),value=>value.permissions.length===1);
  const records=(await readFile(path.join(f.dir,'fixture-agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),coordinator=records.filter(record=>record.method==='prompt'&&record.text.includes('你是 Superagent 的协调者'));assert.equal(coordinator.length,1);assert.match(coordinator[0].text,/EARLY_STEER/);await f.call('action',{id:created.id,action:'cancel'});
});
test('internal session history can be read and explicitly deleted only after its task no longer uses it',async t=>{
  const f=await fixture(t),created=await f.create();await until(()=>f.worker(created.id),value=>value.permissions.length===1);const task=await f.task(created.id),unrelated=await f.connection.rpc<any>('createSession',{projectId:f.project.id,agent:f.agent.id,title:'Personal',command:''});
  const history=await f.call('sessions',{id:created.id});assert.equal(history.total,2);assert.ok(history.sessions.some((session:any)=>session.id===task.coordinatorSession));await assert.rejects(f.call('delete_session',{id:created.id,sessionId:task.coordinatorSession}),/当前任务会话/);await assert.rejects(f.call('delete_session',{id:created.id,sessionId:unrelated.id}),/不属于此任务/);
  await f.call('action',{id:created.id,action:'cancel'});await f.call('delete_session',{id:created.id,sessionId:task.coordinatorSession});assert.equal((await f.call('sessions',{id:created.id})).total,1);assert.ok((await f.connection.rpc<State>('state')).sessions.some(session=>session.id===unrelated.id));
});

test('source inbox approval and rejection are explicit; task deletion preserves files, isolates unrelated work and keeps source deduplication',async t=>{
  const f=await fixture(t);await f.extension({action:'install',path:path.resolve('examples/superagent-source-local')});await f.call('source_policy',{sourceId,enabled:true,projectId:f.project.id,coordinatorId:f.agent.id,executorId:f.agent.id,allowedActors:[],autoApprove:false,isolated:true});
  const emit=(id:string,title:string)=>f.extension({action:'call',id:'example.superagent.source.local',command:'emit',params:{id,threadId:'inbox-thread',actorId:'alice',title,text:'Implement this request only after approval'}});
  const first=await emit('approval-a','A request'),second=await emit('approval-b','B request');assert.equal((await f.call('state')).counts.approval,2);assert.equal((await f.call('tasks',{filter:'approval'})).total,2);assert.ok(!(await f.connection.rpc<State>('state')).sessions.some(session=>session.owner));
  const alternate=await f.connection.rpc<any>('createAgent',{name:'Alternate executor',command:f.agent.command,acp:f.agent.acp});await f.call('action',{id:first.ticketId,action:'approve',executorId:alternate.id});await until(()=>f.worker(first.ticketId),value=>value.permissions.length===1);const approved=await f.task(first.ticketId);assert.equal(approved.executorId,alternate.id);assert.equal((await f.call('tasks',{filter:'active'})).total,1);assert.equal((await f.call('get',{id:approved.id})).sourceInfo.canReply,true);await assert.rejects(readFile(path.join(f.data,'extensions','data','example.superagent.source.local','receipts.json')),/ENOENT/,'Approval must not send a channel reply');
  await f.call('action',{id:second.ticketId,action:'reject'});assert.equal((await f.task(second.ticketId)).rejected,true);assert.equal((await f.call('state')).counts.approval,0);
  await f.call('delete_task',{id:second.ticketId});assert.equal((await f.call('delete_task',{id:second.ticketId})).duplicate,true);await assert.rejects(f.task(second.ticketId),/已删除/);const duplicate=await emit('approval-b','Same event again');assert.equal(duplicate.duplicate,true);assert.equal(duplicate.ticketId,second.ticketId);assert.equal((await f.call('tasks',{filter:'all'})).total,1);
  const personal=await f.connection.rpc<any>('createSession',{projectId:f.project.id,agent:f.agent.id,title:'Personal long task',command:''});await f.connection.rpc('acpSend',{sessionId:personal.id,requestId:randomUUID(),text:'long'});await writeFile(path.join(approved.worktreePath,'keep.txt'),'KEEP_WORKTREE');await assert.rejects(f.call('delete_task',{id:approved.id}),/仍在运行/);await f.call('delete_task',{id:approved.id,cancelRunning:true});
  assert.equal(await readFile(path.join(approved.worktreePath,'keep.txt'),'utf8'),'KEEP_WORKTREE');const state=await f.connection.rpc<State>('state');assert.ok(!state.sessions.some(session=>session.owner?.taskId===approved.id));assert.ok(!state.agentActivities?.some(activity=>activity.taskId===approved.id));assert.equal(state.sessions.find(session=>session.id===personal.id)?.latestRun?.status,'running');assert.equal((await f.call('state')).counts.all,0);
  await f.extension({action:'reload',id:'superagent'});assert.equal((await f.call('tasks',{filter:'all'})).total,0);assert.equal((await emit('approval-a','Old event')).duplicate,true);
});

test('named source pipelines route the same source to distinct projects, reject overlap and retain history after edits or deletion',async t=>{
  const f=await fixture(t);await f.extension({action:'install',path:path.resolve('examples/superagent-source-local')});
  const secondRoot=path.join(f.dir,'second-project');await mkdir(secondRoot);const second=await f.connection.rpc<any>('createProject',{name:'Second route',path:secondRoot});
  const save=(extra:any={})=>f.call('save_pipeline',{name:'Project A requests',sourceId,enabled:true,projectId:f.project.id,coordinatorId:f.agent.id,executorId:f.agent.id,allowedActors:[],threadIds:['project-a'],autoApprove:false,isolated:false,...extra});
  assert.deepEqual((await f.call('source_threads',{sourceId})).threads,[{id:'thread-1',name:'本地演示会话'},{id:'thread-2',name:'另一组演示会话'}]);
  const one=await save(),two=await save({name:'Project B requests',projectId:second.id,threadIds:['project-b']});assert.notEqual(one.id,two.id);
  await assert.rejects(save({name:'Overlapping route',threadIds:[]}),/范围重叠/);await assert.rejects(save({name:'Unsafe automatic admission',threadIds:['auto'],autoApprove:true}),/授权身份/);
  const emit=(id:string,threadId:string,actorId='alice')=>f.extension({action:'call',id:'example.superagent.source.local',command:'emit',params:{id,threadId,actorId,title:'Pipeline request',text:'Check source routing'}});
  const a=await emit('route-a','project-a'),b=await emit('route-b','project-b');assert.equal((await f.task(a.ticketId)).projectId,f.project.id);assert.equal((await f.task(b.ticketId)).projectId,second.id);assert.equal((await f.task(a.ticketId)).source.pipelineId,one.id);assert.equal((await f.task(b.ticketId)).source.pipelineName,'Project B requests');assert.equal((await f.task(a.ticketId)).approved,false);
  assert.equal((await emit('no-route','other')).reason,'no_matching_pipeline');assert.equal((await f.call('source_events',{})).length,3);assert.equal((await f.call('source_events',{pipelineId:one.id})).length,1);
  const before=(await f.call('state')).pipelines;assert.equal(before.length,2);assert.equal(before.find((item:any)=>item.id===one.id).received,1);assert.equal(before.find((item:any)=>item.id===one.id).lastEvent.receipt.ticketId,a.ticketId);
  await f.call('pipeline_action',{pipelineId:one.id,action:'disable'});assert.equal((await emit('paused','project-a')).reason,'no_matching_pipeline');
  await f.call('pipeline_action',{pipelineId:one.id,action:'enable'});await save({pipelineId:one.id,name:'Renamed pipeline',threadIds:['project-a']});assert.equal((await emit('route-a','project-b')).ticketId,a.ticketId,'A consumed source event cannot be rerouted or run twice');
  await f.call('pipeline_action',{pipelineId:two.id,action:'delete'});assert.equal((await f.task(b.ticketId)).projectId,second.id,'Deleting a pipeline preserves existing tasks');
  await f.extension({action:'reload',id:'superagent'});const restored=(await f.call('state')).pipelines;assert.equal(restored.length,1);assert.equal(restored[0].name,'Renamed pipeline');assert.equal((await emit('route-b','project-a')).ticketId,b.ticketId);
  await f.call('pipeline_action',{pipelineId:one.id,action:'delete'});await f.extension({action:'reload',id:'superagent'});assert.equal((await f.call('state')).pipelines.length,0,'Deleted legacy or new routes must not resurrect on reload');
  await assert.rejects(emit('not-consumed','project-a'),/尚未绑定/);
});

test('bulk task approval, rejection and deletion report partial failures and never treat ordinary or running work as pending requests',async t=>{
  const f=await fixture(t);await f.extension({action:'install',path:path.resolve('examples/superagent-source-local')});
  await f.call('source_policy',{sourceId,enabled:true,projectId:f.project.id,coordinatorId:f.agent.id,executorId:f.agent.id,allowedActors:[],autoApprove:false,isolated:false});
  const incoming=async(id:string)=>(await f.extension({action:'call',id:'example.superagent.source.local',command:'emit',params:{id,threadId:'bulk',actorId:'alice',title:id,text:'Review bulk request'}})).ticketId;
  const [one,two,three,four]=await Promise.all(['bulk-one','bulk-two','bulk-three','bulk-four'].map(incoming));
  const ordinary=await f.create({title:'Ordinary task'});await until(()=>f.worker(ordinary.id),value=>value.permissions.length===1);
  let preview=await f.call('bulk_tasks',{ids:[one,two,ordinary.id],action:'approve',preview:true});assert.equal(preview.eligible,2);assert.equal(preview.skipped,1);assert.equal((await f.task(one)).approved,false,'Preview must never start a request');
  const approved=await f.call('bulk_tasks',{ids:[one,two,ordinary.id,randomUUID()],action:'approve'});assert.equal(approved.success,2);assert.equal(approved.skipped,1);assert.equal(approved.failed,1);assert.equal((await f.task(one)).approved,true);assert.equal((await f.task(two)).approved,true);
  const rejected=await f.call('bulk_tasks',{ids:[three,four,ordinary.id],action:'reject'});assert.equal(rejected.success,2);assert.equal(rejected.skipped,1);assert.equal((await f.task(three)).rejected,true);assert.equal((await f.task(four)).rejected,true);assert.equal((await f.task(ordinary.id)).phase,'working');
  preview=await f.call('bulk_tasks',{ids:[three,four,ordinary.id],action:'delete',preview:true});assert.equal(preview.running,1);assert.equal(preview.eligible,3);
  const partial=await f.call('bulk_tasks',{ids:[three,ordinary.id],action:'delete'});assert.equal(partial.success,1);assert.equal(partial.failed,1);assert.match(partial.items.find((item:any)=>item.id===ordinary.id).reason,/明确取消/);assert.equal((await f.task(ordinary.id)).phase,'working');
  const removed=await f.call('bulk_tasks',{ids:[four,ordinary.id],action:'delete',cancelRunning:true});assert.equal(removed.success,2);await assert.rejects(f.task(ordinary.id),/已删除/);assert.equal((await f.call('bulk_tasks',{ids:[four,ordinary.id],action:'delete',cancelRunning:true})).skipped,2);
  for(const key of [one,two])await f.call('action',{id:key,action:'cancel'});
  const receipts=await readFile(path.join(f.data,'extensions','data','example.superagent.source.local','receipts.json'),'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;});assert.deepEqual(JSON.parse(receipts),{},'Batch approval/rejection/deletion never posts channel replies');
});
