// Inspired by DeepSeek's MIT-licensed dsh-superagent-prototype domain model.
// This executor targets AgentBerth's ACP host, not DeepSeek Harness internals.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Context } from 'cordis';
import type { State, Session, GitWorktree } from '../shared/protocol';
import type { AcpSnapshot } from '../shared/acp';
import type { SuperagentSourceEvent } from '../shared/superagent-source';
import { SuperagentSources } from './sources';

type Phase='queued'|'planning'|'working'|'needs_attention'|'completed'|'cancelled'|'interrupted';
export interface Ticket {
  id:string;title:string;objective:string;projectId:string;coordinatorId:string;executorId:string;
  phase:Phase;approved:boolean;isolated:boolean;createdAt:string;updatedAt:string;
  coordinatorSession:string;workerSession:string;planTurn:string;workerTurn:string;
  worktreePath?:string;assignment?:string;summary?:string;question?:string;error?:string;stage?:'coordinator'|'worker';
  attempt:number;lastInput?:string;attention?:boolean;
  source?:{id:string;threadId:string;eventId:string;actorId:string;policyVersion:string};
}
interface SourcePolicy {enabled:boolean;projectId:string;coordinatorId:string;executorId:string;allowedActors:string[];autoApprove:boolean;isolated:boolean;version:string}
const object={type:'object',additionalProperties:false};
const string={type:'string',minLength:1,maxLength:16000};
const id={type:'string',minLength:1,maxLength:100};
function decision(text:string):Record<string,any>|null{
  const candidate=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  try{const result=JSON.parse(candidate);return result&&typeof result==='object'&&!Array.isArray(result)?result:null;}catch{return null;}
}
function fit(text:string,bytes:number){let result=text;while(Buffer.byteLength(JSON.stringify(result))>bytes)result=result.slice(0,Math.floor(result.length*.8));return result;}
export function apply(ctx:Context,config:Record<string,string|number|boolean>){
  const api=ctx.berth;mkdirSync(api.dataDirectory,{recursive:true});
  const db=new DatabaseSync(path.join(api.dataDirectory,'superagent.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS triggers(source TEXT NOT NULL,eventId TEXT NOT NULL,ticketId TEXT NOT NULL,PRIMARY KEY(source,eventId));
    CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,ticketId TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_events(source TEXT NOT NULL,eventId TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(source,eventId));
    CREATE TABLE IF NOT EXISTS source_outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  for(const row of db.prepare('SELECT id,value FROM source_outbox').all()){const value=JSON.parse(String(row.value));if(value.state==='sending')db.prepare('UPDATE source_outbox SET value=? WHERE id=?').run(JSON.stringify({...value,state:'unknown',error:'宿主退出，发送结果未知；不会自动重发'}),row.id);}
  let closed=false,ticking:Promise<void>|null=null;
  const get=(key:string):Ticket=>{const row=db.prepare('SELECT value FROM tickets WHERE id=?').get(key);if(!row)throw new Error('任务不存在');return JSON.parse(String(row.value));};
  const all=():Ticket[]=>db.prepare("SELECT value FROM tickets ORDER BY CASE WHEN json_extract(value,'$.phase') IN ('completed','cancelled') THEN 1 ELSE 0 END,rowid DESC LIMIT 200").all().map(row=>JSON.parse(String(row.value)));
  const audit=(key:string,kind:string,text:string)=>{if(!closed)db.prepare('INSERT INTO audit(ticketId,value) VALUES (?,?)').run(key,JSON.stringify({at:new Date().toISOString(),kind,text:text.slice(0,4000)}));};
  const save=(ticket:Ticket)=>{if(closed)return;ticket.updatedAt=new Date().toISOString();db.prepare('INSERT INTO tickets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id,JSON.stringify(ticket));};
  const change=(key:string,patch:Partial<Ticket>,reason:string)=>{if(closed)return;const ticket={...get(key),...patch};save(ticket);audit(key,'transition',reason);return ticket;};
  for(const ticket of all())if(['planning','working'].includes(ticket.phase))change(ticket.id,{phase:'interrupted',attention:true,error:'宿主曾退出或插件重新加载，结果需确认；不会自动重新发送任务。'},'恢复检查点：等待显式重试');
  const host=<T=any>(method:string,params:Record<string,unknown>={})=>{if(closed||api.signal.aborted)throw new Error('Superagent 已停止');return api.call(method,params) as Promise<T>;};
  const validate=async(p:any)=>{const state=await host<State>('state');if(!state.projects.some(project=>project.id===p.projectId&&!project.remoteWorkspace))throw new Error('请选择本机项目');for(const key of ['coordinatorId','executorId'])if(!state.agents?.some(agent=>agent.id===p[key]&&agent.acp))throw new Error('协调和执行 Agent 均须为已配置的 ACP 接入');return state;};
  const stopSessions=async(ticket:Ticket)=>{await Promise.all([ticket.coordinatorSession,ticket.workerSession].map(sessionId=>api.call('stop',{sessionId}).catch(error=>{if(!String(error).includes('会话不存在'))throw error;})));};
  const interrupt=async(ticket:Ticket,error:unknown,reason:string)=>{
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
    if(Number(db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE json_extract(value,'$.phase') NOT IN ('completed','cancelled')").get()!.count)>=200)throw new Error('未结束任务已达 200 个，请先处理已有任务');
    const ticket:Ticket={id:randomUUID(),title:p.title.trim().slice(0,100),objective:p.objective.trim(),projectId:p.projectId,coordinatorId:p.coordinatorId,executorId:p.executorId,isolated:p.isolated!==false,approved,phase:approved?'queued':'needs_attention',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),coordinatorSession:randomUUID(),workerSession:randomUUID(),planTurn:randomUUID(),workerTurn:randomUUID(),attempt:1,attention:!approved,...(origin?{source:origin}:{})};
    // Trigger admission and the work item become durable in one transaction.
    db.exec('BEGIN IMMEDIATE');try{save(ticket);db.prepare('INSERT INTO triggers VALUES (?,?,?)').run(source,eventId,ticket.id);audit(ticket.id,'trigger',`来源 ${source} · ${eventId} · ${approved?'用户主动发起':'等待用户批准'}`);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');const duplicate=db.prepare('SELECT ticketId FROM triggers WHERE source=? AND eventId=?').get(source,eventId);if(duplicate)return {id:String(duplicate.ticketId),duplicate:true};throw error;}
    return {id:ticket.id,duplicate:false};
  };
  const policies=():Record<string,SourcePolicy>=>Object.fromEntries(db.prepare('SELECT id,value FROM source_policies').all().map(row=>[String(row.id),JSON.parse(String(row.value))]));
  const sources=new SuperagentSources(api.id,async(source,event:SuperagentSourceEvent)=>{
    if(closed||api.signal.aborted)throw new Error('Superagent 已停止，事件尚未接收');
    const previous=db.prepare('SELECT value FROM source_events WHERE source=? AND eventId=?').get(source,event.id);
    if(previous)return {...JSON.parse(String(previous.value)).receipt,duplicate:true};
    const policy=policies()[source];if(!policy?.enabled)throw new Error('信息源尚未绑定或已停用，请在 Superagent 面板配置；插件须保留事件并用原 ID 重试');
    const metadata={source,eventId:event.id,threadId:event.threadId,actorId:event.actorId,policyVersion:policy.version,at:new Date().toISOString()};
    let receipt;
    if(policy.allowedActors.length&&!policy.allowedActors.includes(event.actorId))receipt={accepted:false,duplicate:false,reason:'actor_not_allowed'};
    else{const task=await create({...policy,title:event.title,objective:event.text},source,event.id,policy.autoApprove,{id:source,eventId:event.id,threadId:event.threadId,actorId:event.actorId,policyVersion:policy.version});receipt={accepted:true,duplicate:task.duplicate,ticketId:task.id};}
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
  const launchCoordinator=async(ticket:Ticket)=>{
    const coordinator=await session(ticket,'coordinator');if(!await guard(ticket,'planning'))return;
    if(coordinator.latestRun?.status!=='running')await host('start',{sessionId:ticket.coordinatorSession,cols:100,rows:30,resume:true});
    if(!await guard(ticket,'planning'))return;
    const setup=await host<AcpSnapshot>('acpSnapshot',{sessionId:ticket.coordinatorSession,limit:1});
    if(setup.modes?.availableModes.some(mode=>mode.id==='plan')){await host('acpConfigure',{sessionId:ticket.coordinatorSession,configId:'mode',value:'plan'});audit(ticket.id,'policy','协调者使用 Agent 声明的 plan 模式');}
    else audit(ticket.id,'policy','此 Agent 未提供 plan 模式，协调者遵循自身权限与任务指令');
    if(!await guard(ticket,'planning'))return;
    const rules=String(config.rules??'仅在请求范围内工作。不得自动推送、合并或向外部渠道发送消息。');
    if(rules.length>4000)throw new Error('Superagent 规则超过 4000 字，请缩短规则或放入项目 AGENTS.md');
    const prompt=`你是 Superagent 的协调者。原则：尽量少占用人的注意力，提供可验证的价值。先判断目标与范围，不直接开展实现。任务 ${ticket.id}，第 ${ticket.attempt} 次明确请求。\n规则：${rules}\n标题：${ticket.title}\n目标：${ticket.objective}\n${ticket.lastInput?'用户补充：'+ticket.lastInput:''}\n只输出一个 JSON 对象：{"action":"execute|ask|ignore","assignment":"给独立执行 Agent 的具体任务、约束与验收方式","reason":"简短原因","question":"必须由人回答的问题，没有则留空"}。范围不清时用 ask。不要编造已执行的步骤。`;
    audit(ticket.id,'dispatch','提交协调请求，幂等请求 ID：'+ticket.planTurn);
    await host('acpSend',{sessionId:ticket.coordinatorSession,requestId:ticket.planTurn,text:prompt});await guard(ticket,'planning');
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
    const prompt=`你是 Superagent 的独立执行器。只完成当前任务，不接管其他会话。\n任务 ${ticket.id}\n${ticket.assignment}\n${ticket.lastInput?'用户补充：'+ticket.lastInput:''}\n在当前工作目录实施并验证。不得自动推送、合并或向外部渠道发消息。不要删除工作区或历史。需要授权时使用 Agent 的标准授权请求；无法继续就解释具体阻塞。最终只输出 JSON：{"status":"ready|blocked|failed","summary":"完成内容、验证结果和限制","question":"需要用户回答的具体问题，没有则留空"}。ready 代表可交付审核，不代表用户已接受。`;
    audit(ticket.id,'dispatch','提交执行请求，幂等请求 ID：'+ticket.workerTurn);
    await host('acpSend',{sessionId:ticket.workerSession,requestId:ticket.workerTurn,text:prompt});await guard(ticket,'working');
  };
  const advance=async(ticket:Ticket)=>{
    const planning=ticket.phase==='planning',sessionId=planning?ticket.coordinatorSession:ticket.workerSession,turnId=planning?ticket.planTurn:ticket.workerTurn;
    const view=await result(sessionId,turnId);if(closed)return;
    const current=get(ticket.id);if(current.phase!==ticket.phase)return;
    if(view.snapshot.permissions.length){if(!current.attention)change(ticket.id,{attention:true,question:'Agent 正在等待授权，请打开对应会话选择。'},'需要用户授权');return;}
    if(view.snapshot.phase==='error'||view.snapshot.phase==='disconnected'){change(ticket.id,{phase:'interrupted',attention:true,error:view.snapshot.error??'ACP 连接已断开；执行结果未知，需要人工确认。'},'连接中断，不重放命令');await stopSessions(ticket);return;}
    if(!view.ended){if(current.attention)change(ticket.id,{attention:false,question:''},'授权已处理，任务继续');return;}
    const report=decision(view.text);
    if(planning){
      if(report?.action==='execute'&&typeof report.assignment==='string'&&report.assignment.trim()){
        const next=change(ticket.id,{phase:'working',stage:'worker',assignment:report.assignment.slice(0,12000),summary:String(report.reason??''),attention:false,question:''},'协调者已提供执行方案')!;
        await host('stop',{sessionId:ticket.coordinatorSession});if(closed)return;await launchWorker(next);
      }else{change(ticket.id,{phase:'needs_attention',stage:'coordinator',attention:true,summary:view.text.slice(0,20000),question:String(report?.question??'协调结果需要确认，请补充需求后继续。').slice(0,4000)},'协调决策需要人工处理');await host('stop',{sessionId:ticket.coordinatorSession});}
    }else{
      change(ticket.id,{phase:'needs_attention',stage:'worker',attention:true,summary:typeof report?.summary==='string'?report.summary.slice(0,20000):view.text.slice(0,20000),question:String(report?.question??''),error:report?.status==='failed'?'执行器报告失败':report?.status==='blocked'?'执行器报告阻塞':undefined},report?.status==='ready'?'结果已就绪，等待确认':'执行器已交接，需要人工处理');await host('stop',{sessionId:ticket.workerSession});
    }
  };
  const tick=()=>{
    if(closed||ticking)return;
    ticking=(async()=>{
      const tickets=all().reverse(),active=tickets.filter(ticket=>['planning','working'].includes(ticket.phase));
      for(const ticket of active){if(closed)return;try{await advance(ticket);}catch(error){if(!closed)await interrupt(ticket,error,'处理结果失败；等待显式重试');}}
      const occupied=all().filter(ticket=>['planning','working'].includes(ticket.phase)).length;
      for(const ticket of tickets.filter(ticket=>ticket.phase==='queued'&&ticket.approved).slice(0,Math.max(0,Number(config.maxConcurrent??2)-occupied))){
        if(closed)return;const current=get(ticket.id);if(current.phase!=='queued')continue;
        const next=change(ticket.id,{phase:'planning',stage:'coordinator',attention:false,error:undefined},'取得执行槽')!;
        try{await launchCoordinator(next);}catch(error){if(!closed)await interrupt(ticket,error,'启动协调者失败；不会自动重新发送');}
      }
    })().finally(()=>{ticking=null;});void ticking.catch(()=>{});
  };
  const props={projectId:id,coordinatorId:id,executorId:id,title:{...string,maxLength:100},objective:string,isolated:{type:'boolean'}};
  api.command({mcp:false,name:'create',description:'Create a user-requested task with selected ACP coordinator/executor; each task gets independent sessions and optionally a Git worktree.',inputSchema:{...object,properties:props,required:['projectId','coordinatorId','executorId','title','objective']}},p=>create(p));
  api.command({mcp:false,name:'state',description:'List projects, ACP agents, plugin-defined sources and recent task summaries. No credentials or full transcripts.',inputSchema:{...object,properties:{}}},async()=>{const state=await host<State>('state');return {projects:state.projects.filter(project=>!project.remoteWorkspace).map(project=>({id:project.id,name:project.name})),agents:state.agents?.filter(agent=>agent.acp).map(agent=>({id:agent.id,name:agent.name})),tasks:all().slice(0,50).map(({objective,assignment,lastInput,summary,...ticket})=>({...ticket,summary:summary?.slice(0,240),error:ticket.error?.slice(0,200),question:ticket.question?.slice(0,200)})),sources:sources.snapshot().map(source=>({...source,policy:policies()[source.id]})),maxConcurrent:Number(config.maxConcurrent??2)};});
  api.command({mcp:false,name:'source_policy',description:'Bind a registered source to a project and selected ACP agents. Auto-admission requires an explicit actor allowlist; otherwise incoming tasks wait for approval.',inputSchema:{...object,properties:{sourceId:{type:'string',minLength:1,maxLength:200},enabled:{type:'boolean'},projectId:id,coordinatorId:id,executorId:id,allowedActors:{type:'array',items:{type:'string',minLength:1,maxLength:200},maxItems:128},autoApprove:{type:'boolean'},isolated:{type:'boolean'}},required:['sourceId','enabled','projectId','coordinatorId','executorId','allowedActors','autoApprove','isolated']}},async p=>{
    if(!sources.has(String(p.sourceId)))throw new Error('信息源插件未启用');if(p.autoApprove&&!(p.allowedActors as string[]).length)throw new Error('自动准入必须配置明确的授权身份列表');await validate(p);if(closed)throw new Error('插件已停止');
    const policy:SourcePolicy={enabled:!!p.enabled,projectId:String(p.projectId),coordinatorId:String(p.coordinatorId),executorId:String(p.executorId),allowedActors:p.allowedActors as string[],autoApprove:!!p.autoApprove,isolated:!!p.isolated,version:randomUUID()};db.prepare('INSERT INTO source_policies VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(String(p.sourceId),JSON.stringify(policy));return {version:policy.version};
  });
  api.command({mcp:false,name:'source_events',description:'Read recent source admission receipts without message bodies.',inputSchema:{...object,properties:{sourceId:{type:'string',minLength:1,maxLength:200}},required:['sourceId']}},p=>db.prepare('SELECT value FROM source_events WHERE source=? ORDER BY rowid DESC LIMIT 30').all(String(p.sourceId)).map(row=>JSON.parse(String(row.value))));
  api.command({mcp:false,name:'get',description:'Read a bounded task summary and its last 20 audit entries. Use read for omitted text or open the ACP session.',inputSchema:{...object,properties:{id},required:['id']}},p=>{
    const {assignment,lastInput,...task}=get(String(p.id)),omitted:string[]=[];
    for(const field of ['objective','summary','question','error'] as const){const text=task[field];if(text){task[field]=fit(text,field==='objective'||field==='summary'?24000:4000);if(task[field]!==text){omitted.push(field);task[field]+='\n[内容已精简，可打开会话或使用 read 读取完整内容]';}}}
    const latestReply=db.prepare("SELECT value FROM source_outbox WHERE json_extract(value,'$.ticketId')=? ORDER BY rowid DESC LIMIT 1").get(task.id);
    return {task,omitted,replyDraft:latestReply?(({id,text,state})=>({id,text,state}))(JSON.parse(String(latestReply.value))):null,outbox:db.prepare("SELECT value FROM source_outbox WHERE json_extract(value,'$.ticketId')=? ORDER BY rowid DESC LIMIT 10").all(task.id).map(row=>{const {text,...receipt}=JSON.parse(String(row.value));return receipt;}),audit:db.prepare('SELECT value FROM audit WHERE ticketId=? ORDER BY sequence DESC LIMIT 20').all(String(p.id)).map(row=>{const event=JSON.parse(String(row.value));return {...event,text:fit(event.text,800)};}).reverse()};
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
  api.command({mcp:false,name:'action',description:'Explicitly approve, cancel, retry or accept a task. Retry never happens automatically after a disconnect.',inputSchema:{...object,properties:{id,action:{type:'string',enum:['approve','cancel','retry','complete']},text:{type:'string',maxLength:12000}},required:['id','action']}},async p=>{
    let ticket=get(String(p.id));const action=String(p.action);
    if(['completed','cancelled'].includes(ticket.phase))throw new Error('任务已结束，不能再次调度');
    if(action==='cancel'){change(ticket.id,{phase:'cancelled',attention:false},'用户取消任务，保留工作区与会话记录');await stopSessions(ticket);return {id:ticket.id};}
    if(action==='complete'){if(['planning','working'].includes(ticket.phase))throw new Error('请先等待执行结果或取消运行');change(ticket.id,{phase:'completed',attention:false},'用户确认交付');await stopSessions(ticket);return {id:ticket.id};}
    if(action==='approve'&&!ticket.approved){await validate(ticket);change(ticket.id,{approved:true,phase:'queued',attention:false},'用户批准外部触发');return {id:ticket.id};}
    if(action==='retry'){
      if(['planning','working'].includes(ticket.phase))throw new Error('任务仍在运行，请先取消或等待交接');
      await stopSessions(ticket);await validate(ticket);
      // A retry is a new explicit instruction. Preserve earlier turns and IDs
      // in their original sessions; no old prompt is silently replayed.
      ticket=change(ticket.id,{phase:'queued',approved:true,attention:false,error:undefined,lastInput:typeof p.text==='string'?p.text:undefined,attempt:ticket.attempt+1,coordinatorSession:randomUUID(),workerSession:randomUUID(),planTurn:randomUUID(),workerTurn:randomUUID()},'用户明确要求继续，创建新的执行尝试')!;return {id:ticket.id};
    }
    throw new Error('当前任务不支持此操作');
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
