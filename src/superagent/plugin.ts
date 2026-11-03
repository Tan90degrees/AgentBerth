// Inspired by DeepSeek's MIT-licensed dsh-superagent-prototype domain model.
// This executor targets AgentBerth's ACP host, not DeepSeek Harness internals.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Context } from 'cordis';
import type { State, Session, GitWorktree } from '../shared/protocol';
import { acpOptionChoices,acpModelOption, type AcpSnapshot,type AcpModels } from '../shared/acp';
import type { SuperagentSourceEvent } from '../shared/superagent-source';
import {taskQuestions,type TaskQuestion} from '../shared/task-questions';
import { SuperagentSources } from './sources';
import {pipelineStore,type SourcePolicy,type SourcePipeline} from './pipelines';

type Phase='queued'|'planning'|'working'|'needs_attention'|'completed'|'cancelled'|'interrupted';
export interface Ticket {
  id:string;title:string;objective:string;projectId:string;coordinatorId:string;executorId:string;coordinatorModel?:string;executorModel?:string;
  phase:Phase;approved:boolean;isolated:boolean;createdAt:string;updatedAt:string;
  coordinatorSession:string;workerSession:string;planTurn:string;workerTurn:string;
  worktreePath?:string;assignment?:string;summary?:string;question?:string;error?:string;stage?:'coordinator'|'worker';
  deletedAt?:string;rejected?:boolean;questions?:TaskQuestion[];activeInputId?:string;
  attempt:number;lastInput?:string;attention?:boolean;waitingFor?:'answer'|'permission'|'review'|'format';continuing?:boolean;lastQuestion?:string;lastAction?:{id:string;action:string;text:string};
  source?:{id:string;threadId:string;eventId:string;actorId:string;policyVersion:string;pipelineId?:string;pipelineName?:string};
}
interface TaskInput {id:string;ticketId:string;text:string;mode:'queue'|'interrupt';state:'queued'|'dispatching'|'sent'|'withdrawn'|'unknown';createdAt:string;sentAt?:string}
interface TaskMessage {id:string;role:'user'|'assistant';text:string;at:string;stage?:'coordinator'|'worker';inputId?:string}
const object={type:'object',additionalProperties:false};
const string={type:'string',minLength:1,maxLength:16000};
const id={type:'string',minLength:1,maxLength:100};
export function decision(text:string):Record<string,any>|null{
  // ACP Agents often wrap the final report in prose or a Markdown fence.
  // Scan complete JSON objects, respecting quoted braces and escape sequences.
  let start=-1,depth=0,quoted=false,escaped=false,report:Record<string,any>|null=null;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(start<0){if(char==='{'){start=i;depth=1;}continue;}
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&!--depth){
      try{const value=JSON.parse(text.slice(start,i+1));if(value&&typeof value==='object'&&!Array.isArray(value)&&(typeof value.action==='string'||typeof value.status==='string'))report=value;}catch{}
      start=-1;
    }
  }
  return report;
}
export function taskWait(ticket:Pick<Ticket,'waitingFor'|'stage'|'question'|'approved'>){
  return ticket.waitingFor??(!ticket.approved?'review':ticket.question?'answer':ticket.stage==='worker'?'review':'format');
}
function fit(text:string,bytes:number){let result=text;while(Buffer.byteLength(JSON.stringify(result))>bytes)result=result.slice(0,Math.floor(result.length*.8));return result;}
export function apply(ctx:Context,config:Record<string,string|number|boolean>){
  const api=ctx.berth;mkdirSync(api.dataDirectory,{recursive:true});
  const db=new DatabaseSync(path.join(api.dataDirectory,'superagent.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tickets_state ON tickets(json_extract(value,'$.deletedAt'),json_extract(value,'$.phase'),json_extract(value,'$.approved'));
    CREATE TABLE IF NOT EXISTS triggers(source TEXT NOT NULL,eventId TEXT NOT NULL,ticketId TEXT NOT NULL,PRIMARY KEY(source,eventId));
    CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,ticketId TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_events(source TEXT NOT NULL,eventId TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(source,eventId));
    CREATE TABLE IF NOT EXISTS source_outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_inputs(id TEXT PRIMARY KEY,ticketId TEXT NOT NULL,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_inputs_ticket ON task_inputs(ticketId);
    CREATE TABLE IF NOT EXISTS task_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,ticketId TEXT NOT NULL,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_messages_ticket ON task_messages(ticketId,sequence);`);
  for(const row of db.prepare('SELECT id,value FROM source_outbox').all()){const value=JSON.parse(String(row.value));if(value.state==='sending')db.prepare('UPDATE source_outbox SET value=? WHERE id=?').run(JSON.stringify({...value,state:'unknown',error:'宿主退出，发送结果未知；不会自动重发'}),row.id);}
  let closed=false,ticking:Promise<void>|null=null;const acting=new Set<string>();
  const get=(key:string,includeDeleted=false):Ticket=>{const row=db.prepare('SELECT value FROM tickets WHERE id=?').get(key);if(!row)throw new Error('任务不存在');const task=JSON.parse(String(row.value)) as Ticket;if(task.deletedAt&&!includeDeleted)throw new Error('任务已删除');return task;};
  const all=():Ticket[]=>db.prepare("SELECT value FROM tickets WHERE json_extract(value,'$.deletedAt') IS NULL ORDER BY CASE WHEN json_extract(value,'$.phase') IN ('completed','cancelled') THEN 1 ELSE 0 END,rowid DESC LIMIT 200").all().map(row=>JSON.parse(String(row.value)));
  const audit=(key:string,kind:string,text:string)=>{if(!closed)db.prepare('INSERT INTO audit(ticketId,value) VALUES (?,?)').run(key,JSON.stringify({at:new Date().toISOString(),kind,text:text.slice(0,4000)}));};
  const save=(ticket:Ticket)=>{if(closed)return;ticket.updatedAt=new Date().toISOString();db.prepare('INSERT INTO tickets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id,JSON.stringify(ticket));};
  const inputs=(key:string):TaskInput[]=>db.prepare('SELECT value FROM task_inputs WHERE ticketId=? ORDER BY rowid').all(key).map(row=>JSON.parse(String(row.value)));
  const pendingInput=(key:string)=>inputs(key).filter(input=>input.state==='queued').sort((a,b)=>Number(a.mode!=='interrupt')-Number(b.mode!=='interrupt'))[0];
  const saveInput=(input:TaskInput)=>db.prepare('INSERT INTO task_inputs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(input.id,input.ticketId,JSON.stringify(input));
  const message=(key:string,value:Omit<TaskMessage,'id'|'at'>)=>db.prepare('INSERT INTO task_messages(ticketId,value) VALUES (?,?)').run(key,JSON.stringify({...value,id:randomUUID(),at:new Date().toISOString()}));
  const thread=(key:string,before=Number.MAX_SAFE_INTEGER)=>{const rows=db.prepare('SELECT sequence,value FROM task_messages WHERE ticketId=? AND sequence<? ORDER BY sequence DESC LIMIT 13').all(key,before),hasMore=rows.length>12;return {hasMore,messages:rows.slice(0,12).reverse().map(row=>{const value=JSON.parse(String(row.value)) as TaskMessage,text=fit(value.text,1500);return {...value,sequence:Number(row.sequence),text,omitted:text!==value.text};})};};
  const ownership=(ticket:Ticket)=>api.manageSessions({kind:'superagent',projectId:ticket.projectId,taskId:ticket.id,sessionIds:[ticket.coordinatorSession,ticket.workerSession]});
  for(const row of db.prepare("SELECT value FROM tickets WHERE json_extract(value,'$.deletedAt') IS NULL").all())ownership(JSON.parse(String(row.value)));
  const activity=(ticket:Ticket)=>{
    ownership(ticket);
    const waiting=ticket.phase==='needs_attention'?taskWait(ticket):ticket.attention?'permission':null;
    const label=ticket.phase==='completed'?'任务已完成':ticket.phase==='cancelled'?'任务已取消':ticket.phase==='interrupted'?'任务已中断，等待确认':waiting==='permission'?'等待会话授权':waiting==='answer'?'等待你的回答':waiting==='format'?'协调结果需要确认':waiting==='review'?(ticket.stage==='worker'?'等待验收':'等待批准'):ticket.phase==='planning'?'协调中':ticket.phase==='working'?'执行中':'任务排队中';
    api.activity({id:ticket.id,title:('Superagent · '+ticket.title).slice(0,100),projectId:ticket.projectId,kind:'superagent',targetSessionId:ticket.stage==='worker'?ticket.workerSession:ticket.coordinatorSession,managedSessionIds:[ticket.coordinatorSession,ticket.workerSession],status:ticket.phase==='completed'?'completed':ticket.phase==='cancelled'?'idle':ticket.phase==='interrupted'?'unknown':waiting?'waiting':ticket.error?'error':['planning','working'].includes(ticket.phase)?'working':'idle',label,updatedAt:Date.parse(ticket.updatedAt)});
  };
  const change=(key:string,patch:Partial<Ticket>,reason:string)=>{if(closed)return;const ticket={...get(key),...patch};save(ticket);audit(key,'transition',reason);activity(ticket);return ticket;};
  for(const input of db.prepare("SELECT value FROM task_inputs WHERE json_extract(value,'$.state')='dispatching'").all()){const value=JSON.parse(String(input.value)) as TaskInput;saveInput({...value,state:'unknown'});}
  for(const ticket of all())if(['planning','working'].includes(ticket.phase)||ticket.activeInputId&&ticket.phase==='queued')change(ticket.id,{phase:'interrupted',attention:true,error:'宿主曾退出或插件重新加载，结果需确认；不会自动重新发送任务。'},'恢复检查点：等待显式重试');
  for(const ticket of all())activity(ticket);
  const host=<T=any>(method:string,params:Record<string,unknown>={})=>{if(closed||api.signal.aborted)throw new Error('Superagent 已停止');return api.call(method,params) as Promise<T>;};
  const validate=async(p:any)=>{const state=await host<State>('state');if(!state.projects.some(project=>project.id===p.projectId&&!project.remoteWorkspace))throw new Error('请选择本机项目');for(const key of ['coordinatorId','executorId'])if(!state.agents?.some(agent=>agent.id===p[key]&&agent.acp))throw new Error('协调和执行 Agent 均须为已配置的 ACP 接入');return state;};
  const stopSessions=async(ticket:Ticket)=>{await Promise.all([ticket.coordinatorSession,ticket.workerSession].map(sessionId=>api.call('stop',{sessionId}).catch(error=>{if(!String(error).includes('会话不存在'))throw error;})));};
  const interrupt=async(ticket:Ticket,error:unknown,reason:string)=>{
    if(ticket.activeInputId){const input=inputs(ticket.id).find(input=>input.id===ticket.activeInputId);if(input?.state==='dispatching')saveInput({...input,state:'unknown'});}
    let detail=String(error);
    try{await stopSessions(ticket);}catch(cleanup){detail+='；连接清理尚未完成，请从会话重试停止：'+String(cleanup);}
    if(!closed){const current=get(ticket.id);if(current.attempt===ticket.attempt&&['planning','working'].includes(current.phase))change(ticket.id,{phase:'interrupted',attention:true,error:detail.slice(0,4000)},reason);}
  };
  const guard=async(ticket:Ticket,phase:Phase)=>{
    const current=closed?null:get(ticket.id);
    if(current?.attempt===ticket.attempt&&current.phase===phase)return true;
    await stopSessions(ticket);return false;
  };
  const create=async(p:any,source:string='desktop',eventId:string=randomUUID(),approved=true,origin?:Ticket['source'])=>{
    const previous=db.prepare('SELECT ticketId FROM triggers WHERE source=? AND eventId=?').get(source,eventId);if(previous)return {id:String(previous.ticketId),duplicate:true};
    await validate(p);if(closed)throw new Error('插件已停止');
    if(Number(db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE json_extract(value,'$.deletedAt') IS NULL AND json_extract(value,'$.phase') NOT IN ('completed','cancelled')").get()!.count)>=200)throw new Error('未结束任务已达 200 个，请先处理已有任务');
    const ticket:Ticket={id:randomUUID(),title:p.title.trim().slice(0,100),objective:p.objective.trim(),projectId:p.projectId,coordinatorId:p.coordinatorId,executorId:p.executorId,...(p.coordinatorModel?{coordinatorModel:p.coordinatorModel}:{}),...(p.executorModel?{executorModel:p.executorModel}:{}),isolated:p.isolated!==false,approved,phase:approved?'queued':'needs_attention',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),coordinatorSession:randomUUID(),workerSession:randomUUID(),planTurn:randomUUID(),workerTurn:randomUUID(),attempt:1,attention:!approved,...(origin?{source:origin}:{})};
    // Trigger admission and the work item become durable in one transaction.
    db.exec('BEGIN IMMEDIATE');try{save(ticket);message(ticket.id,{role:'user',text:ticket.objective});db.prepare('INSERT INTO triggers VALUES (?,?,?)').run(source,eventId,ticket.id);audit(ticket.id,'trigger',`来源 ${source} · ${eventId} · ${approved?'用户主动发起':'等待用户批准'}`);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');const duplicate=db.prepare('SELECT ticketId FROM triggers WHERE source=? AND eventId=?').get(source,eventId);if(duplicate)return {id:String(duplicate.ticketId),duplicate:true};throw error;}
    activity(ticket);
    return {id:ticket.id,duplicate:false};
  };
  const pipelines=pipelineStore(db);
  const sources=new SuperagentSources(api.id,async(source,event:SuperagentSourceEvent)=>{
    if(closed||api.signal.aborted)throw new Error('Superagent 已停止，事件尚未接收');
    const previous=db.prepare('SELECT value FROM source_events WHERE source=? AND eventId=?').get(source,event.id);
    if(previous)return {...JSON.parse(String(previous.value)).receipt,duplicate:true};
    const {pipeline:policy,candidate,reason}=pipelines.match(source,event);const observed=policy??candidate;
    const metadata={source,eventId:event.id,threadId:event.threadId,actorId:event.actorId,pipelineId:observed?.id,pipelineName:observed?.name,policyVersion:observed?.version,at:new Date().toISOString()};
    let receipt;
    if(!policy)receipt={accepted:false,duplicate:false,reason};
    else{const task=await create({...policy,title:event.title,objective:event.text},source,event.id,policy.autoApprove,{id:source,eventId:event.id,threadId:event.threadId,actorId:event.actorId,policyVersion:policy.version,pipelineId:policy.id,pipelineName:policy.name});receipt={accepted:true,duplicate:task.duplicate,ticketId:task.id};}
    if(closed)throw new Error('插件已停止，请使用原事件 ID 确认接收结果');
    db.prepare('INSERT INTO source_events VALUES (?,?,?) ON CONFLICT(source,eventId) DO NOTHING').run(source,event.id,JSON.stringify({...metadata,receipt}));return receipt;
  });
  ctx.provide('superagentSources',sources);
  const session=async(ticket:Ticket,role:'coordinator'|'worker',worktreePath?:string)=>{
    const requestId=role==='coordinator'?ticket.coordinatorSession:ticket.workerSession;
    return host<Session>('createSession',{requestId,projectId:ticket.projectId,title:`Superagent · ${role==='coordinator'?'协调':'执行'} · ${ticket.title}`.slice(0,100),agent:role==='coordinator'?ticket.coordinatorId:ticket.executorId,command:'',worktreePath:worktreePath??null});
  };
  const result=async(sessionId:string,turnId:string):Promise<{snapshot:AcpSnapshot;text:string;ended:boolean}>=>{
    let after=0,text='',snapshot:AcpSnapshot;let pages=0;
    do{snapshot=await host<AcpSnapshot>('acpSnapshot',{sessionId,after,limit:200});for(const event of snapshot.events){after=Math.max(after,event.sequence);if(event.turnId===turnId&&event.kind==='assistant')text+=event.text;}if(text.length>64000)throw new Error('Agent 决策输出过长，请在会话中缩短结果后显式重试');if(++pages>25)throw new Error('会话日志过多，请在会话中确认任务结果');}while(snapshot.hasMore);
    return {snapshot,text,ended:snapshot.turnId!==turnId&&snapshot.phase!=='running'&&snapshot.phase!=='permission'&&snapshot.phase!=='connecting'};
  };
  const applyModel=async(ticket:Ticket,role:'coordinator'|'worker')=>{
    const model=role==='coordinator'?ticket.coordinatorModel:ticket.executorModel;if(!model)return;
    const sessionId=role==='coordinator'?ticket.coordinatorSession:ticket.workerSession;
    const snapshot=await host<AcpSnapshot>('acpSnapshot',{sessionId,limit:1}),option=acpModelOption(snapshot.configOptions);
    if(!option||!acpOptionChoices(option).some(choice=>choice.value===model))throw new Error((role==='coordinator'?'协调':'执行')+' Agent 未提供已选择的模型 '+model+'；请更新模型配置，不会自动替换模型或发送任务');
    await host('acpConfigure',{sessionId,configId:option.id,value:model});audit(ticket.id,'model',(role==='coordinator'?'协调':'执行')+'模型：'+model);
  };
  const launchCoordinator=async(ticket:Ticket)=>{
    const coordinator=await session(ticket,'coordinator');if(!await guard(ticket,'planning'))return;
    if(coordinator.latestRun?.status!=='running')await host('start',{sessionId:ticket.coordinatorSession,cols:100,rows:30,resume:true});
    if(!await guard(ticket,'planning'))return;
    const setup=await host<AcpSnapshot>('acpSnapshot',{sessionId:ticket.coordinatorSession,limit:1});
    const planOption=setup.configOptions?.find(option=>(option.category==='mode'||option.id==='mode')&&acpOptionChoices(option).some(choice=>choice.value==='plan'));
    if(planOption||setup.modes?.availableModes.some(mode=>mode.id==='plan')){await host('acpConfigure',{sessionId:ticket.coordinatorSession,configId:planOption?.id??'mode',value:'plan'});audit(ticket.id,'policy','协调者使用 Agent 声明的 plan 模式');}
    else audit(ticket.id,'policy','此 Agent 未提供 plan 模式，协调者遵循自身权限与任务指令');
    await applyModel(ticket,'coordinator');
    if(!await guard(ticket,'planning'))return;
    const rules=String(config.rules??'仅在请求范围内工作。不得自动推送、合并或向外部渠道发送消息。');
    if(rules.length>4000)throw new Error('Superagent 规则超过 4000 字，请缩短规则或放入项目 AGENTS.md');
    const prompt=`你是 Superagent 的协调者。原则：尽量少占用人的注意力，提供可验证的价值。先判断目标与范围，不直接开展实现。任务 ${ticket.id}，第 ${ticket.attempt} 次明确请求。\n规则：${rules}\n标题：${ticket.title}\n目标：${ticket.objective}\n${ticket.lastInput?'用户回答 / 新指令：'+ticket.lastInput:''}\n${ticket.continuing?'这是同一任务的继续。此前结果：'+(ticket.summary??'')+'\n此前问题：'+(ticket.lastQuestion??'')+'\n请结合本次回答继续，不要重复提出已回答的问题。':''}\n需要选择时可增加 questions 数组，每项含 question、header、options（label、description）、multiple。只输出一个 JSON 对象：{"action":"execute|ask|ignore","assignment":"给独立执行 Agent 的具体任务、约束与验收方式","reason":"简短原因","question":"必须由人回答的问题，没有则留空"}。范围不清时用 ask。不要编造已执行的步骤。`;
    if(!ticket.activeInputId&&pendingInput(ticket.id)?.mode==='interrupt'&&queueNext(get(ticket.id)))return;
    audit(ticket.id,'dispatch','提交协调请求，幂等请求 ID：'+ticket.planTurn);
    await host('acpSend',{sessionId:ticket.coordinatorSession,requestId:ticket.planTurn,text:prompt});submitted(ticket);if(pendingInput(ticket.id)?.mode==='interrupt')await host('acpCancel',{sessionId:ticket.coordinatorSession});await guard(ticket,'planning');
  };
  const launchWorker=async(ticket:Ticket)=>{
    if(!await guard(ticket,'working'))return;
    let worktreePath=ticket.worktreePath;
    if(ticket.isolated&&!worktreePath){
      const branch='superagent/'+ticket.id,trees=await host<GitWorktree[]>('gitWorktrees',{projectId:ticket.projectId});
      if(!await guard(ticket,'working'))return;
      const existing=trees.find(tree=>tree.branch===branch);
      const tree=existing??await host<GitWorktree>('gitCreateWorktree',{projectId:ticket.projectId,branch,createBranch:true});worktreePath=tree.workingPath;
      change(ticket.id,{worktreePath},'已准备任务独立工作区：'+worktreePath);
    }
    if(!await guard(ticket,'working'))return;
    ticket=get(ticket.id);await session(ticket,'worker',worktreePath);if(!await guard(ticket,'working'))return;
    await host('start',{sessionId:ticket.workerSession,cols:100,rows:30,resume:true});if(!await guard(ticket,'working'))return;
    await applyModel(ticket,'worker');if(!await guard(ticket,'working'))return;
    const prompt=`你是 Superagent 的独立执行器。只完成当前任务，不接管其他会话。\n任务 ${ticket.id}\n${ticket.assignment}\n${ticket.lastInput?'用户回答 / 新指令：'+ticket.lastInput:''}\n${ticket.continuing?'这是同一任务的继续。此前结果：'+(ticket.summary??'')+'\n此前问题：'+(ticket.lastQuestion??'')+'\n请结合本次回答继续，不要重复提出已回答的问题。':''}\n在当前工作目录实施并验证。不得自动推送、合并或向外部渠道发消息。不要删除工作区或历史。需要授权时使用 Agent 的标准授权请求；无法继续就解释具体阻塞。需要用户选择时可增加 questions 数组（question、header、options、multiple）。最终只输出 JSON：{"status":"ready|blocked|failed","summary":"完成内容、验证结果和限制","question":"需要用户回答的具体问题，没有则留空"}。ready 代表可交付审核，不代表用户已接受。`;
    if(!ticket.activeInputId&&pendingInput(ticket.id)?.mode==='interrupt'&&queueNext(get(ticket.id)))return;
    audit(ticket.id,'dispatch','提交执行请求，幂等请求 ID：'+ticket.workerTurn);
    await host('acpSend',{sessionId:ticket.workerSession,requestId:ticket.workerTurn,text:prompt});submitted(ticket);if(pendingInput(ticket.id)?.mode==='interrupt')await host('acpCancel',{sessionId:ticket.workerSession});await guard(ticket,'working');
  };
  const queueNext=(ticket:Ticket,summary=ticket.summary??'',question=ticket.question??'')=>{
    if(acting.has(ticket.id))return false;const input=pendingInput(ticket.id);if(!input)return false;
    db.exec('BEGIN IMMEDIATE');let next:Ticket;try{
      saveInput({...input,state:'dispatching'});
      next={...get(ticket.id),phase:'queued',continuing:!!ticket.stage,activeInputId:input.id,lastInput:input.text,lastQuestion:question,summary,question:'',attention:false,waitingFor:undefined,questions:undefined,error:undefined,attempt:ticket.attempt+1,...(ticket.stage==='worker'?{workerTurn:randomUUID()}:{planTurn:randomUUID()})};save(next);audit(ticket.id,'input','开始发送补充指令');db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}activity(next!);return true;
  };
  const submitted=(ticket:Ticket)=>{if(!ticket.activeInputId)return;const input=inputs(ticket.id).find(input=>input.id===ticket.activeInputId);if(input?.state==='dispatching')saveInput({...input,state:'sent',sentAt:new Date().toISOString()});if(get(ticket.id).attempt===ticket.attempt)change(ticket.id,{activeInputId:undefined},'补充指令已送达 Agent');};
  const advance=async(ticket:Ticket)=>{
    const planning=ticket.phase==='planning',sessionId=planning?ticket.coordinatorSession:ticket.workerSession,turnId=planning?ticket.planTurn:ticket.workerTurn;
    const view=await result(sessionId,turnId);if(closed)return;
    const current=get(ticket.id);if(current.phase!==ticket.phase||current.attempt!==ticket.attempt||acting.has(ticket.id))return;
    if(view.snapshot.permissions.length){if(!current.attention)change(ticket.id,{attention:true,waitingFor:'permission',question:'Agent 正在等待授权，请打开对应会话选择。'},'需要用户授权');return;}
    if(view.snapshot.phase==='error'||view.snapshot.phase==='disconnected'){change(ticket.id,{phase:'interrupted',attention:true,error:view.snapshot.error??'ACP 连接已断开；执行结果未知，需要人工确认。'},'连接中断，不重放命令');await stopSessions(ticket);return;}
    if(!view.ended){if(current.attention)change(ticket.id,{attention:false,waitingFor:undefined,question:''},'授权已处理，任务继续');return;}
    const report=decision(view.text);
    const summary=typeof report?.summary==='string'?report.summary:typeof report?.reason==='string'?report.reason:view.text;
    if(summary.trim())message(ticket.id,{role:'assistant',text:summary.slice(0,20000),stage:planning?'coordinator':'worker'});
    if(queueNext(current,summary.slice(0,20000),typeof report?.question==='string'?report.question.slice(0,4000):'')){await host('stop',{sessionId});return;}
    if(view.snapshot.lastTurnStatus==='cancelled'){change(ticket.id,{phase:'needs_attention',attention:true,waitingFor:'answer',summary:summary.slice(0,20000),question:'本轮已停止。可以补充下一步指令后继续。'},'本轮已停止，等待新指令');await host('stop',{sessionId});return;}

    if(planning){
      if(report?.action==='execute'&&typeof report.assignment==='string'&&report.assignment.trim()){
        const next=change(ticket.id,{phase:'working',stage:'worker',assignment:report.assignment.slice(0,12000),summary:String(report.reason??''),attention:false,waitingFor:undefined,questions:undefined,continuing:false,question:''},'协调者已提供执行方案')!;
        await host('stop',{sessionId:ticket.coordinatorSession});if(closed)return;await launchWorker(next);
      }else{change(ticket.id,{phase:'needs_attention',stage:'coordinator',attention:true,summary:typeof report?.reason==='string'?report.reason.slice(0,20000):view.text.slice(0,20000),waitingFor:report?.action==='ask'?'answer':'format',questions:report?.action==='ask'?taskQuestions(report.questions??report.question):undefined,question:typeof report?.question==='string'&&report.question.trim()?report.question.slice(0,4000):taskQuestions(report?.questions??report?.question).map(item=>item.question).join('\n')||(report?.action==='ignore'?'协调者建议暂不执行。你可以补充要求继续，或确认结束任务。':'协调结果未包含有效的执行方案。请在下方补充要求并继续，或打开协调记录核对。')},'协调决策需要人工处理');await host('stop',{sessionId:ticket.coordinatorSession});}
    }else{
      change(ticket.id,{phase:'needs_attention',stage:'worker',attention:true,summary:typeof report?.summary==='string'?report.summary.slice(0,20000):view.text.slice(0,20000),question:typeof report?.question==='string'?report.question.slice(0,4000):taskQuestions(report?.questions??report?.question).map(item=>item.question).join('\n').slice(0,4000),questions:taskQuestions(report?.questions??report?.question),waitingFor:report?.status==='ready'?'review':'answer',error:report?.status==='failed'?'执行器报告失败':report?.status==='blocked'?'执行器报告阻塞':undefined},report?.status==='ready'?'结果已就绪，等待确认':'执行器已交接，需要人工处理');await host('stop',{sessionId:ticket.workerSession});
    }
  };
  const tick=()=>{
    if(closed||ticking)return;
    ticking=(async()=>{
      for(const ticket of all())if(ticket.phase==='needs_attention'&&ticket.approved&&pendingInput(ticket.id))queueNext(ticket);
      const tickets=all().reverse(),active=tickets.filter(ticket=>['planning','working'].includes(ticket.phase));
      for(const ticket of active){if(closed)return;try{await advance(ticket);}catch(error){if(!closed)await interrupt(ticket,error,'处理结果失败；等待显式重试');}}
      const occupied=all().filter(ticket=>['planning','working'].includes(ticket.phase)).length;
      for(const ticket of tickets.filter(ticket=>ticket.phase==='queued'&&ticket.approved).slice(0,Math.max(0,Number(config.maxConcurrent??2)-occupied))){
        if(closed)return;let current=get(ticket.id);if(current.phase!=='queued'||acting.has(ticket.id))continue;if(!current.lastInput&&pendingInput(current.id)){queueNext(current);current=get(ticket.id);}
        const worker=current.continuing&&current.stage==='worker';
        const next=change(ticket.id,{phase:worker?'working':'planning',stage:worker?'worker':'coordinator',attention:false,waitingFor:undefined,error:undefined},'取得执行槽')!;
        try{if(worker)await launchWorker(next);else await launchCoordinator(next);}catch(error){if(!closed)await interrupt(next,error,'启动当前阶段失败；不会自动重新发送');}
      }
    })().finally(()=>{ticking=null;});void ticking.catch(()=>{});
  };
  const model={type:'string',minLength:1,maxLength:1000};
  const props={projectId:id,coordinatorId:id,executorId:id,coordinatorModel:model,executorModel:model,title:{...string,maxLength:100},objective:string,isolated:{type:'boolean'}};
  api.command({mcp:false,name:'models',description:'Read model choices declared by an ACP Agent; uses a matching live session or a temporary empty session without sending prompts.',inputSchema:{...object,properties:{projectId:id,acpId:id},required:['projectId','acpId']}},p=>host<AcpModels>('acpOptions',{agentId:p.acpId,projectId:p.projectId}));
  api.command({mcp:false,name:'create',description:'Create a user-requested task with selected ACP coordinator/executor; each task gets independent sessions and optionally a Git worktree.',inputSchema:{...object,properties:props,required:['projectId','coordinatorId','executorId','title','objective']}},p=>create(p));
  const present=({objective,assignment,lastInput,lastAction,lastQuestion,activeInputId,questions,...ticket}:Ticket)=>({...ticket,preview:objective.slice(0,160),pendingInputs:inputs(ticket.id).filter(input=>input.state==='queued').length,summary:ticket.summary?.slice(0,240),error:ticket.error?.slice(0,200),question:ticket.question?.slice(0,200)});
  const taskCounts=()=>{const rows=db.prepare("SELECT json_extract(value,'$.phase') AS phase,json_extract(value,'$.approved') AS approved,json_extract(value,'$.attention') AS attention,COUNT(*) AS count FROM tickets WHERE json_extract(value,'$.deletedAt') IS NULL GROUP BY phase,approved,attention").all();return rows.reduce<{all:number;approval:number;active:number;ended:number;attention:number}>((counts,row)=>{const count=Number(row.count);counts.all+=count;if(row.phase==='needs_attention'&&!row.approved)counts.approval+=count;if(['queued','planning','working'].includes(String(row.phase)))counts.active+=count;if(['completed','cancelled'].includes(String(row.phase)))counts.ended+=count;if(['needs_attention','interrupted'].includes(String(row.phase))||row.attention&&['planning','working'].includes(String(row.phase)))counts.attention+=count;return counts;},{all:0,approval:0,active:0,ended:0,attention:0});};
  api.command({mcp:false,name:'state',description:'List projects, ACP agents, source settings and task counts.',inputSchema:{...object,properties:{}}},async()=>{const state=await host<State>('state');return {projects:state.projects.filter(project=>!project.remoteWorkspace).map(project=>({id:project.id,name:project.name})),agents:state.agents?.filter(agent=>agent.acp).map(agent=>({id:agent.id,name:agent.name})),tasks:all().slice(0,50).map(present),counts:taskCounts(),sources:sources.snapshot().map(source=>({...source,policy:pipelines.list().find(item=>item.sourceId===source.id)})),pipelines:pipelines.list().map(item=>({...item,received:Number(db.prepare("SELECT COUNT(*) AS n FROM source_events WHERE json_extract(value,'$.pipelineId')=? AND json_extract(value,'$.receipt.accepted')=1").get(item.id)!.n),lastEvent:(()=>{const row=db.prepare("SELECT value FROM source_events WHERE json_extract(value,'$.pipelineId')=? ORDER BY rowid DESC LIMIT 1").get(item.id);return row?JSON.parse(String(row.value)):null;})()})),maxConcurrent:Number(config.maxConcurrent??2)};});
  api.command({mcp:false,name:'tasks',description:'Search and page visible tasks, including pending approvals and older finished tasks.',inputSchema:{...object,properties:{filter:{type:'string',enum:['all','approval','active','attention','ended']},query:{type:'string',maxLength:200},offset:{type:'integer',minimum:0}},required:[]}},p=>{
    const filters={all:'1',attention:"json_extract(value,'$.phase') IN ('needs_attention','interrupted') OR json_extract(value,'$.attention')=1",approval:"json_extract(value,'$.phase')='needs_attention' AND json_extract(value,'$.approved')=0",active:"json_extract(value,'$.phase') IN ('queued','planning','working')",ended:"json_extract(value,'$.phase') IN ('completed','cancelled')"},where="json_extract(value,'$.deletedAt') IS NULL AND ("+filters[(p.filter??'all') as keyof typeof filters]+") AND instr(lower(json_extract(value,'$.title')),lower(?))>0",query=String(p.query??'');
    const rows=db.prepare('SELECT value FROM tickets WHERE '+where+" ORDER BY CASE WHEN json_extract(value,'$.phase') IN ('completed','cancelled') THEN 1 ELSE 0 END,rowid DESC LIMIT 50 OFFSET ?").all(query,Number(p.offset??0));return {tasks:rows.map(row=>present(JSON.parse(String(row.value)))),total:Number(db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE '+where).get(query)!.count)};
  });
  api.command({mcp:false,name:'source_policy',description:'Bind a registered source to a project and selected ACP agents. Auto-admission requires an explicit actor allowlist; otherwise incoming tasks wait for approval.',inputSchema:{...object,properties:{sourceId:{type:'string',minLength:1,maxLength:200},enabled:{type:'boolean'},projectId:id,coordinatorId:id,executorId:id,coordinatorModel:model,executorModel:model,allowedActors:{type:'array',items:{type:'string',minLength:1,maxLength:200},maxItems:128},autoApprove:{type:'boolean'},isolated:{type:'boolean'}},required:['sourceId','enabled','projectId','coordinatorId','executorId','allowedActors','autoApprove','isolated']}},async p=>{
    if(!sources.has(String(p.sourceId)))throw new Error('信息源插件未启用');if(p.autoApprove&&!(p.allowedActors as string[]).length)throw new Error('自动准入必须配置明确的授权身份列表');await validate(p);if(closed)throw new Error('插件已停止');
    const policy:SourcePolicy={enabled:!!p.enabled,projectId:String(p.projectId),coordinatorId:String(p.coordinatorId),executorId:String(p.executorId),...(p.coordinatorModel?{coordinatorModel:String(p.coordinatorModel)}:{}),...(p.executorModel?{executorModel:String(p.executorModel)}:{}),allowedActors:p.allowedActors as string[],autoApprove:!!p.autoApprove,isolated:!!p.isolated,version:randomUUID()};const key='legacy:'+p.sourceId,previous=pipelines.get(key),now=new Date().toISOString();pipelines.save({...policy,id:key,name:previous?.name??'已有来源管道',sourceId:String(p.sourceId),threadIds:previous?.threadIds??[],createdAt:previous?.createdAt??now,updatedAt:now});return {version:policy.version};
  });
  const pipelineId={type:'string',minLength:1,maxLength:256};
  const pipelineProps={pipelineId,expectedVersion:id,name:{type:'string',minLength:1,maxLength:100},sourceId:{type:'string',minLength:1,maxLength:200},enabled:{type:'boolean'},projectId:id,coordinatorId:id,executorId:id,coordinatorModel:model,executorModel:model,threadIds:{type:'array',items:{type:'string',minLength:1,maxLength:500},maxItems:128},allowedActors:{type:'array',items:{type:'string',minLength:1,maxLength:200},maxItems:128},autoApprove:{type:'boolean'},isolated:{type:'boolean'}};
  api.command({mcp:false,name:'save_pipeline',description:'Create or edit one named source-to-project pipeline; overlapping enabled routes are rejected.',inputSchema:{...object,properties:pipelineProps,required:['name','sourceId','enabled','projectId','coordinatorId','executorId','allowedActors','threadIds','autoApprove','isolated']}},async p=>{
    const previous=p.pipelineId?pipelines.get(String(p.pipelineId)):undefined;if(p.pipelineId&&!previous)throw new Error('管道不存在，请刷新列表');if(p.expectedVersion&&previous?.version!==p.expectedVersion)throw new Error('管道已在其他窗口修改，请取消编辑后重新打开');
    if(!String(p.name).trim())throw new Error('请填写管道名称');if(p.autoApprove&&!(p.allowedActors as string[]).length)throw new Error('自动准入必须配置明确的授权身份列表');
    if(p.enabled){if(!sources.has(String(p.sourceId)))throw new Error('来源插件未启用，请启用插件后再启用管道');await validate(p);}
    if(closed)throw new Error('插件已停止');if(!previous&&pipelines.list().length>=256)throw new Error('管道数量已达 256 个，请先清理已有配置');const now=new Date().toISOString(),pipeline:SourcePipeline={id:previous?.id??randomUUID(),name:String(p.name).trim(),sourceId:String(p.sourceId),enabled:!!p.enabled,projectId:String(p.projectId),coordinatorId:String(p.coordinatorId),executorId:String(p.executorId),...(p.coordinatorModel?{coordinatorModel:String(p.coordinatorModel)}:{}),...(p.executorModel?{executorModel:String(p.executorModel)}:{}),allowedActors:[...new Set(p.allowedActors as string[])],threadIds:[...new Set(p.threadIds as string[])],autoApprove:!!p.autoApprove,isolated:!!p.isolated,version:randomUUID(),createdAt:previous?.createdAt??now,updatedAt:now};
    if(previous&&pipelines.get(previous.id)?.version!==previous.version)throw new Error('管道已变更，请刷新后重新编辑');pipelines.save(pipeline);return {id:pipeline.id,version:pipeline.version};
  });
  api.command({mcp:false,name:'pipeline_action',description:'Explicitly enable, disable or delete a saved pipeline. Existing tasks and event deduplication are preserved.',inputSchema:{...object,properties:{pipelineId,action:{type:'string',enum:['enable','disable','delete']}},required:['pipelineId','action']}},async p=>{
    const pipeline=pipelines.get(String(p.pipelineId));if(!pipeline)throw new Error('管道不存在，请刷新列表');
    if(p.action==='delete'){pipelines.delete(pipeline.id);return {deleted:true};}
    if(p.action==='enable'){if(!sources.has(pipeline.sourceId))throw new Error('来源插件未启用');await validate(pipeline);}
    if(closed)throw new Error('插件已停止');pipelines.save({...pipeline,enabled:p.action==='enable',version:randomUUID(),updatedAt:new Date().toISOString()});return {enabled:p.action==='enable'};
  });
  api.command({mcp:false,name:'source_threads',description:'Read source-provided conversation names for pipeline routing without creating a task.',inputSchema:{...object,properties:{sourceId:{type:'string',minLength:1,maxLength:200}},required:['sourceId']}},p=>sources.listThreads(String(p.sourceId)));
  api.command({mcp:false,name:'source_events',description:'Read recent source admission receipts without message bodies.',inputSchema:{...object,properties:{sourceId:{type:'string',minLength:1,maxLength:200},pipelineId},required:[]}},p=>db.prepare("SELECT value FROM source_events WHERE (?='' OR source=?) AND (?='' OR json_extract(value,'$.pipelineId')=?) ORDER BY rowid DESC LIMIT 30").all(String(p.sourceId??''),String(p.sourceId??''),String(p.pipelineId??''),String(p.pipelineId??'')).map(row=>JSON.parse(String(row.value))));
  api.command({mcp:false,name:'get',description:'Read a bounded task summary and its last 20 audit entries. Use read for omitted text or open the ACP session.',inputSchema:{...object,properties:{id},required:['id']}},async p=>{
    const state=await host<State>('state');
    const {assignment,lastInput,lastAction,lastQuestion,activeInputId,...task}=get(String(p.id)),omitted:string[]=[];
    for(const field of ['objective','summary','question','error'] as const){const text=task[field];if(text){task[field]=fit(text,field==='objective'||field==='summary'?8000:4000);if(task[field]!==text){omitted.push(field);task[field]+='\n[内容已精简，可打开会话或使用 read 读取完整内容]';}}}
    if(task.questions&&Buffer.byteLength(JSON.stringify(task.questions))>12000){task.questions=undefined;task.question='问题选项较长，请打开协调会话核对完整内容，再在下方回答。';omitted.push('questions');}
    const latestReply=db.prepare("SELECT value FROM source_outbox WHERE json_extract(value,'$.ticketId')=? ORDER BY rowid DESC LIMIT 1").get(task.id);
    let live:{text:string;tool:string}|null=null,execution:{phase:string;permissions:number;lastEventAt?:string;events:{id:string;sequence:number;kind:string;text:string;status?:string;at:string}[];hasEarlier:boolean;error?:string}|null=null;
    const sessionId=task.stage==='worker'?task.workerSession:task.coordinatorSession;
    if(state.sessions.some(session=>session.id===sessionId))try{
      const view=await host<AcpSnapshot>('acpSnapshot',{sessionId,limit:40}),events=new Map<string,{id:string;sequence:number;kind:string;text:string;status?:string;at:string}>();
      for(const event of view.events){if(!['tool','permission','notice','error','turn','plan'].includes(event.kind))continue;const key=event.kind==='tool'?String(event.data?.toolCallId??event.id):event.id;events.set(key,{id:key,sequence:event.sequence,kind:event.kind,text:fit(event.text,600),...(event.kind==='tool'?{status:String(event.data?.status??'pending')}:{}),at:event.createdAt});}
      execution={phase:view.phase,permissions:view.permissions.length,lastEventAt:view.events.at(-1)?.createdAt,events:[...events.values()].sort((a,b)=>a.sequence-b.sequence).slice(-8),hasEarlier:view.hasMore||events.size>8,error:view.error?.slice(0,300)};
      if(['planning','working'].includes(task.phase)){const raw=view.events.filter(event=>event.turnId===view.turnId&&event.kind==='assistant').map(event=>event.text).join(''),report=decision(raw);live={text:fit(typeof report?.summary==='string'?report.summary:typeof report?.reason==='string'?report.reason:/^(?:\s*\{|\s*```json)/.test(raw)?'':raw,4000),tool:view.events.filter(event=>event.turnId===view.turnId&&event.kind==='tool').at(-1)?.text.slice(0,160)??''};}
    }catch(error){execution={phase:'error',permissions:0,events:[],hasEarlier:false,error:String(error).slice(0,300)};}
    const ownedSessions=state.sessions.filter(session=>session.owner?.pluginId===api.id&&session.owner.taskId===task.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    const sourceInfo=task.source?sources.snapshot().find(source=>source.id===task.source!.id):undefined;
    return {task,omitted,live,execution,sourceInfo:task.source?{name:sourceInfo?.name??task.source.id,canReply:sourceInfo?.canReply??false,available:!!sourceInfo}:null,ownedSessions:ownedSessions.slice(0,20).map(session=>({id:session.id,title:session.title,status:session.latestRun?.status??'idle',current:session.id===task.coordinatorSession||session.id===task.workerSession})),ownedSessionCount:ownedSessions.length,thread:thread(task.id),inputs:[...new Map([...inputs(task.id).filter(input=>['queued','dispatching'].includes(input.state)),...inputs(task.id).filter(input=>input.state==='unknown').slice(-10),...inputs(task.id).slice(-30)].map(input=>[input.id,input])).values()].map(input=>({...input,text:fit(input.text,400),omitted:fit(input.text,400)!==input.text})),sessions:{coordinator:state.sessions.some(session=>session.id===task.coordinatorSession),worker:state.sessions.some(session=>session.id===task.workerSession)},replyDraft:latestReply?(({id,text,state})=>({id,text,state}))(JSON.parse(String(latestReply.value))):null,outbox:db.prepare("SELECT value FROM source_outbox WHERE json_extract(value,'$.ticketId')=? ORDER BY rowid DESC LIMIT 10").all(task.id).map(row=>{const {text,...receipt}=JSON.parse(String(row.value));return receipt;}),audit:db.prepare('SELECT value FROM audit WHERE ticketId=? ORDER BY sequence DESC LIMIT 20').all(String(p.id)).map(row=>{const event=JSON.parse(String(row.value));return {...event,text:fit(event.text,400)};}).reverse()};
  });
  const deleteTask=async(p:Record<string,unknown>)=>{
    const ticket=get(String(p.id),true);if(ticket.deletedAt)return {deleted:true,duplicate:true};if(acting.has(ticket.id))throw new Error('任务操作正在提交，请稍候');acting.add(ticket.id);
    try{const state=await host<State>('state'),owned=state.sessions.filter(session=>session.owner?.pluginId===api.id&&session.owner.taskId===ticket.id),running=['planning','working'].includes(ticket.phase)||owned.some(session=>['running','stopping'].includes(session.latestRun?.status??''));if(running&&!p.cancelRunning)throw new Error('任务仍在运行，请明确取消后删除');if(db.prepare("SELECT id FROM source_outbox WHERE json_extract(value,'$.ticketId')=? AND json_extract(value,'$.state')='sending' LIMIT 1").get(ticket.id))throw new Error('回复正在发送，请等待结果后删除');
      change(ticket.id,{phase:'cancelled',attention:false},'用户删除任务');await stopSessions(ticket);if(ticking)await ticking;
      for(const session of owned){await host('stop',{sessionId:session.id});await host('deleteSession',{sessionId:session.id});}
      const tombstone:Ticket={...get(ticket.id),deletedAt:new Date().toISOString(),title:'已删除任务',objective:'',summary:undefined,question:undefined,assignment:undefined,lastInput:undefined,lastAction:undefined,lastQuestion:undefined,questions:undefined,error:undefined,activeInputId:undefined};
      db.exec('BEGIN IMMEDIATE');try{save(tombstone);db.prepare('DELETE FROM task_inputs WHERE ticketId=?').run(ticket.id);db.prepare('DELETE FROM task_messages WHERE ticketId=?').run(ticket.id);db.prepare('DELETE FROM audit WHERE ticketId=?').run(ticket.id);db.prepare("DELETE FROM source_outbox WHERE json_extract(value,'$.ticketId')=?").run(ticket.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}api.removeActivity(ticket.id);return {deleted:true};
    }finally{acting.delete(ticket.id);}
  };
  api.command({mcp:false,name:'delete_task',description:'Explicitly delete a task and its local conversations. Keep worktree files and source deduplication tombstones; never send a channel message.',inputSchema:{...object,properties:{id,cancelRunning:{type:'boolean'}},required:['id']}},deleteTask);
  api.command({mcp:false,name:'sessions',description:"Read this task's private session history.",inputSchema:{...object,properties:{id,offset:{type:'integer',minimum:0}},required:['id']}},async p=>{get(String(p.id));const state=await host<State>('state'),all=state.sessions.filter(session=>session.owner?.pluginId===api.id&&session.owner.taskId===p.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),offset=Number(p.offset??0);return {sessions:all.slice(offset,offset+20).map(session=>({id:session.id,title:session.title,status:session.latestRun?.status??'idle'})),total:all.length};});
  api.command({mcp:false,name:'delete_session',description:'Explicitly delete a stopped internal session record owned by this task; active task sessions cannot be removed.',inputSchema:{...object,properties:{id,sessionId:id},required:['id','sessionId']}},async p=>{const task=get(String(p.id)),state=await host<State>('state'),session=state.sessions.find(session=>session.id===p.sessionId);if(!session||session.owner?.pluginId!==api.id||session.owner.taskId!==task.id)throw new Error('会话不属于此任务');if(['running','stopping'].includes(session.latestRun?.status??'')||!['completed','cancelled'].includes(task.phase)&&[task.coordinatorSession,task.workerSession].includes(session.id))throw new Error('当前任务会话不能删除，请先完成或取消任务');await host('deleteSession',{sessionId:session.id});return {deleted:true};});
  api.command({mcp:false,name:'thread',description:'Read paged task conversation messages.',inputSchema:{...object,properties:{id,before:{type:'integer',minimum:1}},required:['id']}},p=>{get(String(p.id));return thread(String(p.id),p.before===undefined?undefined:Number(p.before));});
  api.command({mcp:false,name:'message',description:'Read one saved conversation message.',inputSchema:{...object,properties:{id,sequence:{type:'integer',minimum:1}},required:['id','sequence']}},p=>{get(String(p.id));const row=db.prepare('SELECT value FROM task_messages WHERE ticketId=? AND sequence=?').get(String(p.id),Number(p.sequence));if(!row)throw new Error('消息不存在');return JSON.parse(String(row.value));});
  api.command({mcp:false,name:'input',description:'Queue a task instruction, request an interruption, withdraw an unsent instruction or read its full text. Never sends overlapping ACP prompts.',inputSchema:{...object,properties:{id,inputId:id,action:{type:'string',enum:['send','withdraw','read']},mode:{type:'string',enum:['queue','interrupt']},text:{type:'string',maxLength:12000}},required:['id','inputId','action']}},async p=>{
    const ticket=get(String(p.id)),inputId=String(p.inputId),previous=db.prepare('SELECT value FROM task_inputs WHERE id=?').get(inputId),existing=previous?JSON.parse(String(previous.value)) as TaskInput:undefined;
    if(existing&&existing.ticketId!==ticket.id)throw new Error('指令 ID 属于另一任务');
    if(p.action==='read'){if(!existing)throw new Error('指令不存在');return existing;}
    if(p.action==='withdraw'){if(!existing||existing.state!=='queued')throw new Error('只能撤回尚未发送的指令');saveInput({...existing,state:'withdrawn'});audit(ticket.id,'input','用户撤回待发送指令');return {id:inputId,state:'withdrawn'};}
    const text=String(p.text??'').trim(),mode=p.mode==='interrupt'?'interrupt':'queue';if(!text)throw new Error('请填写补充指令');
    if(existing){if(existing.text!==text||existing.mode!==mode)throw new Error('指令 ID 已用于其他内容');return {id:inputId,state:existing.state,duplicate:true};}
    if(['completed','cancelled'].includes(ticket.phase))throw new Error('任务已结束');if(!ticket.approved)throw new Error('请先批准任务');
    if(inputs(ticket.id).filter(input=>['queued','dispatching'].includes(input.state)).length>=20)throw new Error('待发送指令最多 20 条，请等待处理或撤回部分指令');
    const input:TaskInput={id:inputId,ticketId:ticket.id,text,mode,state:'queued',createdAt:new Date().toISOString()};
    db.exec('BEGIN IMMEDIATE');try{saveInput(input);message(ticket.id,{role:'user',text,inputId});audit(ticket.id,'input',mode==='interrupt'?'用户要求停止本轮并插话':'用户补充指令已排队');db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    let note='已排队，将在本轮结束后发送';if(mode==='interrupt'&&['planning','working'].includes(ticket.phase))try{await host('acpCancel',{sessionId:ticket.stage==='worker'?ticket.workerSession:ticket.coordinatorSession});note='已请求停止本轮，确认结束后优先插话';}catch{note='已保存到队列，当前连接暂时无法停止；不会重复发送';}
    return {id:inputId,state:'queued',note};
  });
  api.command({mcp:false,name:'reply',description:'Send exactly the user-reviewed text through the task source plugin. Persist intent first; an unknown send is never retried automatically. Retry is explicit and uses the original idempotency key.',inputSchema:{...object,properties:{id,requestId:{type:'string',minLength:1,maxLength:100},text:{type:'string',minLength:1,maxLength:12000},retry:{type:'boolean'}},required:['id','requestId','text']}},async p=>{
    const task=get(String(p.id));if(!task.source)throw new Error('手工任务没有外部回复渠道');
    let value:any;const previous=db.prepare('SELECT value FROM source_outbox WHERE id=?').get(String(p.requestId));
    if(previous){value=JSON.parse(String(previous.value));if(value.ticketId!==task.id||value.text!==p.text)throw new Error('回传请求 ID 已用于其他消息');if(value.state==='sent'||value.state==='sending'||!p.retry)return {id:value.id,state:value.state,receipt:value.receipt,error:value.error};}
    else value={id:String(p.requestId),ticketId:task.id,source:task.source.id,threadId:task.source.threadId,text:String(p.text),state:'sending',at:new Date().toISOString()};
    value.state='sending';db.prepare('INSERT INTO source_outbox VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id,JSON.stringify(value));
    try{const receipt=await sources.reply(value.source,{threadId:value.threadId,text:value.text,idempotencyKey:value.id});if(!receipt||typeof receipt.receipt!=='string'||!receipt.receipt.length)throw new Error('来源未返回有效回执');value.state='sent';value.receipt=receipt.receipt.slice(0,2000);audit(task.id,'reply','用户确认的消息已回传，回执：'+value.receipt);}
    catch(error){value.state='unknown';value.error='发送结果未知，请先在来源侧核对：'+String(error).slice(0,1000);audit(task.id,'reply','回传结果未知，不自动重试');}
    if(!closed)db.prepare('UPDATE source_outbox SET value=? WHERE id=?').run(JSON.stringify(value),value.id);return {id:value.id,state:value.state,receipt:value.receipt,error:value.error};
  });
  api.command({mcp:false,name:'read',description:'Read a page of saved task text without rerunning an Agent.',inputSchema:{...object,properties:{id,field:{type:'string',enum:['objective','assignment','summary','lastInput']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:16000}},required:['id','field']}},p=>{const value=get(String(p.id))[p.field as 'objective']??'',offset=Number(p.offset??0),text=fit(value.slice(offset,offset+Number(p.limit??8000)),24000);return {text,totalChars:value.length,nextOffset:offset+text.length<value.length?offset+text.length:null};});
  const taskAction=async(p:Record<string,unknown>)=>{
    let ticket=get(String(p.id));const action=String(p.action),text=String(p.text??'').trim(),requestId=typeof p.requestId==='string'?p.requestId:undefined;
    if(requestId&&ticket.lastAction?.id===requestId){if(ticket.lastAction.action!==action||ticket.lastAction.text!==text)throw new Error('操作 ID 已用于其他指令');return {id:ticket.id,duplicate:true};}
    if(acting.has(ticket.id))throw new Error('此任务的操作正在提交，请稍候');acting.add(ticket.id);try{
    if(['completed','cancelled'].includes(ticket.phase))throw new Error('任务已结束，不能再次调度');
    if(action==='cancel'){for(const input of inputs(ticket.id))if(['queued','dispatching'].includes(input.state))saveInput({...input,state:input.state==='queued'?'withdrawn':'unknown'});change(ticket.id,{phase:'cancelled',attention:false},'用户取消任务，保留工作区与会话记录');await stopSessions(ticket);return {id:ticket.id};}
    if(action==='complete'){if(inputs(ticket.id).some(input=>['queued','dispatching'].includes(input.state)))throw new Error('还有待发送指令，请先处理或撤回');if(['planning','working'].includes(ticket.phase))throw new Error('请先等待执行结果或取消运行');change(ticket.id,{phase:'completed',attention:false},'用户确认交付');await stopSessions(ticket);return {id:ticket.id};}
    if(action==='approve'&&!ticket.approved){const updated={...ticket,projectId:String(p.projectId??ticket.projectId),coordinatorId:String(p.coordinatorId??ticket.coordinatorId),executorId:String(p.executorId??ticket.executorId)};await validate(updated);const changed=updated.projectId!==ticket.projectId||updated.coordinatorId!==ticket.coordinatorId||updated.executorId!==ticket.executorId;change(ticket.id,{projectId:updated.projectId,coordinatorId:updated.coordinatorId,executorId:updated.executorId,coordinatorModel:updated.coordinatorId===ticket.coordinatorId?ticket.coordinatorModel:undefined,executorModel:updated.executorId===ticket.executorId?ticket.executorModel:undefined,...(changed?{coordinatorSession:randomUUID(),workerSession:randomUUID()}:{}),approved:true,rejected:false,phase:'queued',attention:false,question:''},'用户批准请求，开始处理');return {id:ticket.id};}
    if(action==='reject'&&!ticket.approved){change(ticket.id,{phase:'cancelled',rejected:true,attention:false,question:''},'用户拒绝来源请求，未启动 Agent，未发送渠道回复');return {id:ticket.id};}
    if(action==='continue'){
      if(pendingInput(ticket.id))throw new Error('已有待发送指令，请等待处理或撤回后继续');
      if(ticket.phase!=='needs_attention'||!ticket.approved)throw new Error('请在任务等待回答或验收时继续；中断任务请显式重试');
      if(!text)throw new Error('请填写回答或下一步指令');
      await stopSessions(ticket);await validate(ticket);
      message(ticket.id,{role:'user',text});
      // Continue the same role/native conversation. The fresh request ID sends
      // only the new instruction; the prior turn is never replayed.
      change(ticket.id,{phase:'queued',attention:false,waitingFor:undefined,error:undefined,continuing:true,lastInput:text,lastQuestion:ticket.question,question:'',questions:undefined,attempt:ticket.attempt+1,...(ticket.stage==='worker'?{workerTurn:randomUUID()}:{planTurn:randomUUID()}),...(requestId?{lastAction:{id:requestId,action,text}}:{})},'用户回答并继续当前阶段');return {id:ticket.id};
    }
    if(action==='retry'){
      if(['planning','working'].includes(ticket.phase))throw new Error('任务仍在运行，请先取消或等待交接');
      await stopSessions(ticket);await validate(ticket);
      // A retry is a new explicit instruction. Preserve earlier turns and IDs
      // in their original sessions; no old prompt is silently replayed.
      ticket=change(ticket.id,{phase:'queued',stage:'coordinator',activeInputId:undefined,continuing:false,question:'',questions:undefined,waitingFor:undefined,approved:true,attention:false,error:undefined,lastInput:typeof p.text==='string'?p.text:undefined,attempt:ticket.attempt+1,coordinatorSession:randomUUID(),workerSession:randomUUID(),planTurn:randomUUID(),workerTurn:randomUUID()},'用户明确要求继续，创建新的执行尝试')!;return {id:ticket.id};
    }
    throw new Error('当前任务不支持此操作');
    }finally{acting.delete(ticket.id);}
  };
  api.command({mcp:false,name:'action',description:'Answer and continue the current task stage, or explicitly approve, cancel, restart coordination or accept a task. Retry never happens automatically after a disconnect.',inputSchema:{...object,properties:{id,action:{type:'string',enum:['approve','reject','cancel','continue','retry','complete']},text:{type:'string',maxLength:12000},requestId:id,projectId:id,coordinatorId:id,executorId:id},required:['id','action']}},taskAction);
  api.command({mcp:false,name:'bulk_tasks',description:'Preview or explicitly approve, reject or delete up to 50 selected tasks. Each task returns its own result; one failure never hides others.',inputSchema:{...object,properties:{ids:{type:'array',items:id,minItems:1,maxItems:50,uniqueItems:true},action:{type:'string',enum:['approve','reject','delete']},preview:{type:'boolean'},cancelRunning:{type:'boolean'}},required:['ids','action']}},async p=>{
    const state=await host<State>('state'),items:{id:string;title:string;status:'eligible'|'success'|'skipped'|'error';running:boolean;reason?:string}[]=[];
    for(const key of p.ids as string[]){
      let title=key,running=false;
      try{const ticket=get(key,true);title=ticket.title;
        if(ticket.deletedAt){items.push({id:key,title,status:'skipped',running:false,reason:'任务已删除'});continue;}
        if(p.action!=='delete'&&(ticket.approved||['completed','cancelled'].includes(ticket.phase))){items.push({id:key,title,status:'skipped',running:false,reason:'仅待批准的请求可以批准或拒绝'});continue;}
        running=['planning','working'].includes(ticket.phase)||state.sessions.some(session=>session.owner?.pluginId===api.id&&session.owner.taskId===key&&['running','stopping'].includes(session.latestRun?.status??''));
        if(p.preview){items.push({id:key,title,status:'eligible',running});continue;}
        if(p.action==='delete')await deleteTask({id:key,cancelRunning:p.cancelRunning===true});else await taskAction({id:key,action:p.action});
        items.push({id:key,title,status:'success',running});
      }catch(error){items.push({id:key,title,status:'error',running,reason:String(error).slice(0,500)});}
    }
    return {action:p.action,items,eligible:items.filter(item=>item.status==='eligible').length,success:items.filter(item=>item.status==='success').length,skipped:items.filter(item=>item.status==='skipped').length,failed:items.filter(item=>item.status==='error').length,running:items.filter(item=>item.running).length};
  });
  api.interval(tick,1000);
  api.effect(()=>async()=>{
    closed=true;const owned=all(),active=owned.filter(ticket=>['planning','working'].includes(ticket.phase));
    // Persist interruption before stopping anything; restart never replays a
    // half-acknowledged turn, and no worktree or journal is deleted.
    for(const ticket of active){ticket.phase='interrupted';ticket.attention=true;ticket.error='插件已停止，请确认结果后选择继续';db.prepare('UPDATE tickets SET value=? WHERE id=?').run(JSON.stringify(ticket),ticket.id);}
    await Promise.allSettled(owned.map(stopSessions));if(ticking)await ticking.catch(()=>{});db.close();
  });
}
