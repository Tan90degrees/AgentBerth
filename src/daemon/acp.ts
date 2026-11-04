import { createHash } from 'node:crypto';
import { acpOptionChoices,acpModelOption, type AcpConfig, type AcpEvent, type AcpPermission, type AcpSnapshot,type AcpModels,type AcpTerminal } from '../shared/acp';
import type { AgentDefinition, Run, Session, ServerEvent } from '../shared/protocol';
import type { Store } from './store';
import { AcpTransport, AcpRpcError } from './acp-transport';
import { AcpClientTools } from './acp-client-tools';
import type {AgentActivity} from '../shared/pet';

type Metadata=Omit<AcpSnapshot,'events'|'before'|'hasMore'>;
interface Live {
  session:Session;run:Run;cwd:string;definition:AgentDefinition;transport:AcpTransport|null;tools:AcpClientTools;
  state:Metadata;permissions:Map<string,{value:AcpPermission;resolve:(value:unknown)=>void}>;
  stopping:boolean;cancelled:boolean;fingerprint:string;serial:Promise<unknown>;ending?:Promise<void>;
  toolStates:Map<string,{turnId:string|null;data:Record<string,any>}>;
}
const bounded=(value:unknown):Record<string,unknown>|undefined=>{if(!value||typeof value!=='object'||Array.isArray(value))return;const text=JSON.stringify(value);return Buffer.byteLength(text)<=32768?JSON.parse(text):{omitted:true};};
export class AcpSessions {
  readonly live=new Map<string,Live>();private closed=false;
  private discovering=new Map<string,Promise<AcpModels>>();
  private probes=new Set<AcpTransport>();
  constructor(private store:Store,private emit:(event:ServerEvent)=>void,private changed:()=>void){}
  active(id:string){return this.live.has(id);}
  activities(sessions:Session[],agents:AgentDefinition[]):AgentActivity[]{
    const ids=new Set(agents.filter(agent=>agent.acp).map(agent=>agent.id));
    return sessions.filter(session=>!session.remote&&session.latestRun&&ids.has(session.agent)).map(session=>{
      const state=this.live.get(session.id)?.state??this.store.acpState(session.id),phase=state.phase,connected=this.live.has(session.id);
      const status=state.error||phase==='error'?'error':connected&&phase==='permission'?'waiting':connected&&(phase==='running'||phase==='connecting')?'working':state.lastTurnStatus==='completed'?'completed':!connected&&(phase==='running'||phase==='permission'||state.lastTurnStatus==='interrupted')?'unknown':'idle';
      return {id:session.id,title:session.title,projectId:session.projectId,targetSessionId:session.id,managedSessionIds:[],kind:'acp',status,label:status==='waiting'?'等待你的授权':status==='working'?(phase==='connecting'?'正在连接 ACP':'Agent 正在执行'):status==='completed'?'本轮已完成':status==='error'?'ACP 会话异常':status==='unknown'?'上次任务已中断':'ACP 已就绪',updatedAt:Date.parse(session.latestRun!.startedAt)};
    });
  }
  targets(){return [...this.live.values()].flatMap(value=>value.transport?.pid?[{sessionId:value.session.id,projectId:value.session.projectId,runId:value.run.id,pid:value.transport.pid}]:[]);}
  private publish(value:Live){
    value.state.permissions=[...value.permissions.values()].map(item=>item.value);
    this.store.saveAcpState(value.session.id,{...value.state,permissions:[],fingerprint:value.fingerprint});
    this.emit({event:'acp',data:{sessionId:value.session.id,state:{...value.state}}});
    this.changed();
  }
  private append(value:Live,kind:AcpEvent['kind'],text:string,data?:Record<string,unknown>,turnId?:string|null){
    // Bound individual events and response pages, keeping the full turn in the
    // paginated journal rather than an xterm viewport or a growing state RPC.
    const chunks=text?Array.from({length:Math.ceil(text.length/8192)},(_,i)=>text.slice(i*8192,(i+1)*8192)):[''];
    for(const chunk of chunks){const event=this.store.appendAcp(value.session.id,turnId===undefined?value.state.turnId:turnId,kind,chunk,data);this.emit({event:'acp',data:{sessionId:value.session.id,event}});}
  }
  snapshot(id:string,pagination:{before?:number;after?:number;limit?:number}={}):AcpSnapshot{
    const saved=this.store.acpState(id),value=this.live.get(id);
    const state:Metadata=value?{...value.state,permissions:[...value.permissions.values()].map(p=>p.value)}:{sessionId:id,nativeSessionId:saved.nativeSessionId??null,phase:'disconnected',turnId:null,permissions:[],error:saved.error,agentInfo:saved.agentInfo,capabilities:saved.capabilities,configOptions:saved.configOptions,modes:saved.modes,authMethods:saved.authMethods,availableCommands:saved.availableCommands,lastTurnStatus:saved.lastTurnStatus,...(saved.phase==='running'||saved.phase==='permission'?{error:'上次操作因后台退出而中断；结果未知，不会自动重放'}:{})};
    return {...state,...this.store.acpEvents(id,pagination)};
  }
  async start(session:Session,definition:AgentDefinition,cwd:string,cols:number,rows:number):Promise<Run>{
    if(this.closed)throw new Error('ACP 后台正在退出');if(this.live.has(session.id))throw new Error('ACP 会话已连接');if(!definition.acp)throw new Error('此 Agent 未配置 ACP');
    const run=this.store.createRun(session.id,'ACP',cols,rows,definition.acp.executable),saved=this.store.acpState(session.id);
    const fingerprint=createHash('sha256').update(JSON.stringify([definition.id,definition.acp,cwd])).digest('hex');
    const value:Live={session,run,cwd,definition,transport:null,tools:new AcpClientTools(cwd,view=>this.append(value,'terminal','',{...view})),toolStates:new Map(),permissions:new Map(),stopping:false,cancelled:false,fingerprint,serial:Promise.resolve(),state:{sessionId:session.id,nativeSessionId:saved.fingerprint===fingerprint?saved.nativeSessionId??null:null,phase:'connecting',turnId:null,permissions:[]}};
    this.live.set(session.id,value);this.publish(value);this.changed();
    try{
      const transport=await AcpTransport.open(definition.acp,cwd,(method,params)=>this.clientRequest(value,method,params),(method,params)=>this.notification(value,method,params),error=>{void this.ended(value,error).catch(()=>{});});value.transport=transport;
      if(value.stopping||this.closed){await transport.stop();throw new Error('ACP 连接已取消');}
      if(transport.pid){this.store.setPid(run.id,transport.pid);run.pid=transport.pid;}
      const info=await transport.call('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true},terminal:true},clientInfo:{name:'agentberth',title:'AgentBerth',version:'0.18.0'}});
      if(info.protocolVersion!==1)throw new Error('Agent 未协商兼容的 ACP v1 协议');
      value.state.agentInfo=bounded(info.agentInfo);value.state.capabilities=bounded(info.agentCapabilities)??{};value.state.authMethods=Array.isArray(info.authMethods)?info.authMethods.slice(0,20):[];
      if(saved.fingerprint&&saved.fingerprint!==fingerprint)this.append(value,'notice','Agent 或工作区配置已变化，下一条消息使用新的 ACP 会话；此前记录保留。');
      await this.prepare(value);this.changed();return run;
    }catch(error){
      // Authentication is a visible user action. Preserve the initialized
      // connection so authenticate can complete the same session setup.
      if(error instanceof AcpRpcError&&error.code===-32000&&value.state.authMethods?.length){value.state.phase='error';value.state.error=error.message;this.publish(value);return run;}
      await this.ended(value,error instanceof Error?error:new Error(String(error)));throw error;
    }
  }
  private async prepare(value:Live){
    value.state.phase='connecting';
    const transport=value.transport!,savedId=value.state.nativeSessionId;
    if(savedId&&!value.state.capabilities?.loadSession){
      value.state.nativeSessionId=null;this.append(value,'notice','此 Agent 未声明 session/load；保留历史记录并创建新会话，不会重放旧消息。');
    }
    const nativeId=value.state.nativeSessionId;
    const response=await transport.call(nativeId?'session/load':'session/new',{...(nativeId?{sessionId:nativeId}:{}),cwd:value.cwd,mcpServers:[]});
    if(!nativeId&&typeof response.sessionId!=='string')throw new Error('ACP session/new 未返回会话 ID');
    value.state.nativeSessionId=nativeId??response.sessionId;value.state.configOptions=Array.isArray(response.configOptions)?response.configOptions:[];value.state.modes=response.modes;
    value.state.phase='ready';value.state.error=undefined;
    this.store.saveHistory(value.session.id,{messages:[],warnings:[],path:null,nativeSessionId:value.state.nativeSessionId});
    this.publish(value);
  }
  async authenticate(id:string,methodId:string){
    const value=this.require(id);if(value.state.phase!=='error'||!value.state.authMethods?.some(item=>item.id===methodId))throw new Error('请选择 Agent 声明的登录方式');
    await value.transport!.call('authenticate',{methodId},60000);await this.prepare(value);return this.snapshot(id);
  }
  async probe(config:AcpConfig,cwd:string){
    const transport=await AcpTransport.open(config,cwd,async()=>{throw new AcpRpcError(-32601,'探测连接不提供会话文件和终端');},()=>{},()=>{});
    this.probes.add(transport);try{if(this.closed)throw new Error('ACP 后台正在退出');return await transport.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentberth-probe',version:'0.18.0'}});}finally{this.probes.delete(transport);await transport.stop();}
  }
  options(definition:AgentDefinition,cwd:string):Promise<AcpModels>{
    if(this.closed)return Promise.reject(new Error('ACP 后台正在退出'));
    const models=(options?:AcpSnapshot['configOptions']):AcpModels=>{const option=acpModelOption(options);return {choices:option?acpOptionChoices(option):[],currentValue:option?.currentValue,configId:option?.id};};
    const live=[...this.live.values()].find(value=>value.definition.id===definition.id&&value.cwd===cwd&&!value.stopping&&['ready','running','permission'].includes(value.state.phase));
    if(live)return Promise.resolve(models(live.state.configOptions));
    const key=JSON.stringify([definition.acp,cwd]);const existing=this.discovering.get(key);if(existing)return existing;
    const task=(async()=>{
      if(!definition.acp)throw new Error('此 Agent 未配置 ACP');
      const transport=await AcpTransport.open(definition.acp,cwd,async()=>{throw new AcpRpcError(-32601,'读取模型不提供客户端文件与命令能力');},()=>{},()=>{});
      this.probes.add(transport);try{if(this.closed)throw new Error('ACP 后台正在退出');const init=await transport.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentberth-models',version:'0.18.0'}});if(init.protocolVersion!==1)throw new Error('Agent 未协商 ACP v1');const setup=await transport.call('session/new',{cwd,mcpServers:[]});return models(setup.configOptions);}
      finally{this.probes.delete(transport);await transport.stop();}
    })().finally(()=>this.discovering.delete(key));this.discovering.set(key,task);return task;
  }
  terminal(id:string,terminalId:string):AcpTerminal{
    this.store.session(id);const live=this.live.get(id);if(live)try{return live.tools.terminal(terminalId);}catch{/* A released terminal is saved in the journal. */}
    let before:number|undefined;for(let page=0;page<26;page++){const result=this.store.acpEvents(id,{before,limit:200}),found=[...result.events].reverse().find(event=>event.kind==='terminal'&&event.data?.terminalId===terminalId);if(found)return found.data as unknown as AcpTerminal;if(!result.hasMore)break;before=result.before??undefined;}
    throw new Error('终端输出不属于此会话或已超出历史保留范围');
  }
  private require(id:string){const value=this.live.get(id);if(!value||value.stopping||!value.transport)throw new Error('ACP 会话尚未连接，请启动会话');return value;}
  send(id:string,requestId:string,text:string){
    const previous=this.store.acpTurn(requestId);if(previous){if(previous.sessionId!==id)throw new Error('请求 ID 已属于另一会话');return {turnId:requestId,state:previous.state,duplicate:true};}
    const value=this.require(id);if(value.state.phase!=='ready')throw new Error('ACP 正在执行或等待授权，请先停止当前任务或完成授权');
    this.store.beginAcpTurn(id,requestId);value.state.turnId=requestId;value.state.phase='running';value.state.error=undefined;value.cancelled=false;
    this.append(value,'user',text);this.publish(value);
    // Ordinary prompts have no wall-clock timeout. Long tasks stay attached;
    // cancel/stop are explicit, and disconnect never resubmits the prompt.
    value.serial=value.transport!.call('session/prompt',{sessionId:value.state.nativeSessionId,prompt:[{type:'text',text}]},0).then(response=>{
      value.state.lastTurnStatus=value.cancelled||response.stopReason==='cancelled'?'cancelled':'completed';this.store.finishAcpTurn(requestId,value.state.lastTurnStatus);this.append(value,'turn',value.cancelled?'已停止当前任务':({end_turn:'本轮已完成',max_tokens:'已达到 Agent 输出上限',max_turn_requests:'已达到 Agent 请求上限',refusal:'Agent 未执行此请求',cancelled:'已停止当前任务'} as Record<string,string>)[String(response.stopReason)]??'本轮已结束',{stopReason:response.stopReason??'end_turn'});
    },error=>{this.store.finishAcpTurn(requestId,'interrupted');if(!value.stopping)this.append(value,'error',String(error));value.state.error=String(error);}).finally(()=>{
      this.cancelPermissions(value);value.state.turnId=null;if(this.live.get(id)===value&&!value.stopping){value.state.phase=value.state.error?'error':'ready';this.publish(value);}
    });
    return {turnId:requestId,state:'running',duplicate:false};
  }
  cancel(id:string){const value=this.require(id);if(!value.state.turnId)return {cancelled:false};value.cancelled=true;this.cancelPermissions(value);value.transport!.notify('session/cancel',{sessionId:value.state.nativeSessionId});value.state.phase='running';this.publish(value);return {cancelled:true,turnId:value.state.turnId};}
  permission(id:string,permissionId:string,optionId:string|null){
    const value=this.require(id),pending=value.permissions.get(permissionId);if(!pending)throw new Error('授权请求已结束或不属于此会话');
    if(optionId!==null&&!pending.value.options.some(item=>item.optionId===optionId))throw new Error('无效的授权选项');
    value.permissions.delete(permissionId);pending.resolve({outcome:optionId===null?{outcome:'cancelled'}:{outcome:'selected',optionId}});this.append(value,'notice',optionId===null?'已取消授权':'授权选择：'+pending.value.options.find(item=>item.optionId===optionId)!.name);value.state.phase=value.permissions.size?'permission':'running';this.publish(value);return {};
  }
  async configure(id:string,configId:string,setting:string){
    const value=this.require(id);if(value.state.phase!=='ready')throw new Error('请等待当前任务结束后切换模式或模型');
    const option=value.state.configOptions?.find(option=>option.id===configId);
    // Current agents (including OpenCode) expose mode through configOptions.
    // A standard option named "mode" must not be mistaken for the older API.
    if(option){
      if(!acpOptionChoices(option).some(item=>item.value===setting))throw new Error('请选择 Agent 声明的配置值');
      const response=await value.transport!.call('session/set_config_option',{sessionId:value.state.nativeSessionId,configId,value:setting});if(Array.isArray(response.configOptions))value.state.configOptions=response.configOptions;else option.currentValue=setting;
    }else if(configId==='mode'){
      if(!value.state.modes?.availableModes.some(mode=>mode.id===setting))throw new Error('Agent 未提供此会话模式');
      await value.transport!.call('session/set_mode',{sessionId:value.state.nativeSessionId,modeId:setting});value.state.modes.currentModeId=setting;
    }else throw new Error('Agent 未提供此配置项');
    this.publish(value);return this.snapshot(id);
  }
  private async clientRequest(value:Live,method:string,params:Record<string,any>){
    if(value.stopping||this.closed||!value.state.nativeSessionId||params.sessionId!==value.state.nativeSessionId)throw new Error('ACP 请求不属于当前会话');
    if(method==='session/request_permission'){
      if(!Array.isArray(params.options)||!params.options.length||params.options.length>20)throw new Error('ACP 授权选项无效');
      const options=params.options.map((item:any)=>{if(typeof item.optionId!=='string'||typeof item.name!=='string'||typeof item.kind!=='string')throw new Error('ACP 授权选项无效');return {optionId:item.optionId,name:item.name,kind:item.kind};});
      const id='permission-'+Date.now()+'-'+Math.random().toString(36).slice(2),permission:AcpPermission={id,title:String(params.toolCall?.title??'Agent 请求授权').slice(0,1000),options,toolCall:bounded(params.toolCall)};
      return new Promise(resolve=>{value.permissions.set(id,{value:permission,resolve});value.state.phase='permission';this.append(value,'permission',permission.title,{permissionId:id});this.publish(value);});
    }
    if(method.startsWith('fs/')||method.startsWith('terminal/'))return value.tools.call(method,params);
    throw new AcpRpcError(-32601,'未声明此 ACP 客户端能力：'+method);
  }
  private notification(value:Live,method:string,params:Record<string,any>){
    if(value.stopping||method!=='session/update'||typeof params.sessionId!=='string'||value.state.nativeSessionId&&params.sessionId!==value.state.nativeSessionId)return;
    const update=params.update;if(!update||typeof update.sessionUpdate!=='string')return;
    const kind=update.sessionUpdate;
    // session/load may replay tools and plans as well as message chunks.
    // Keep our durable journal once; still accept current configuration state.
    if(value.state.phase==='connecting'&&['agent_message_chunk','agent_thought_chunk','user_message_chunk','tool_call','tool_call_update','plan'].includes(kind))return;
    if(['agent_message_chunk','agent_thought_chunk','user_message_chunk'].includes(kind)){
      // loadSession may replay the remote transcript. Our journal is already
      // durable; replayed notifications must not duplicate previous messages.
      if(value.state.phase==='connecting')return;
      const text=update.content?.type==='text'?String(update.content.text??''):update.content?.type==='resource_link'?String(update.content.uri??''):'[非文本内容]';
      const data=update.content?.type!=='text'?bounded({content:update.content}):undefined;
      this.append(value,kind==='agent_thought_chunk'?'thought':kind==='user_message_chunk'?'notice':'assistant',text,data?.omitted?{omitted:true,content:{type:update.content?.type??'unknown'}}:data);
    }else if(kind==='tool_call'||kind==='tool_call_update'){
      const id=typeof update.toolCallId==='string'?update.toolCallId:'';if(!id)return;
      const previous=value.toolStates.get(id),merged={...previous?.data,...Object.fromEntries(Object.entries(update).filter(([,value])=>value!==null&&value!==undefined))};
      let data=bounded(merged)!;
      if(data.omitted)data={toolCallId:id.slice(0,200),title:String(merged.title??'工具调用').slice(0,500),kind:String(merged.kind??'other').slice(0,30),status:String(merged.status??'pending').slice(0,30),omitted:true,...(merged.rawInput!==undefined?{rawInput:JSON.stringify(merged.rawInput).slice(0,2048)}:{}),...(merged.rawOutput!==undefined?{rawOutput:JSON.stringify(merged.rawOutput).slice(0,2048)}:{})};
      const owner=previous?.turnId??value.state.turnId;value.toolStates.set(id,{turnId:owner,data});
      if(value.toolStates.size>512){const oldest=[...value.toolStates].find(([,item])=>['completed','failed'].includes(String(item.data.status)));value.toolStates.delete(oldest?.[0]??value.toolStates.keys().next().value!);}
      this.append(value,'tool',String(data.title??data.status??'工具执行'),data,owner);
    }
    else if(kind==='plan')this.append(value,'plan','执行计划',bounded(update));
    else if(kind==='config_option_update'){value.state.configOptions=Array.isArray(update.configOptions)?update.configOptions:[];this.publish(value);}
    else if(kind==='current_mode_update'&&value.state.modes){value.state.modes.currentModeId=String(update.currentModeId);this.publish(value);}
    else if(kind==='available_commands_update'){value.state.availableCommands=Array.isArray(update.availableCommands)?update.availableCommands.filter((item:any)=>item&&typeof item.name==='string'&&typeof item.description==='string').slice(0,100):[];this.publish(value);}
  }
  private cancelPermissions(value:Live){for(const pending of value.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});value.permissions.clear();}
  private ended(value:Live,error?:Error):Promise<void>{
    if(value.ending)return value.ending;value.stopping=true;this.cancelPermissions(value);
    const ending=(async()=>{
      if(value.state.turnId){this.store.finishAcpTurn(value.state.turnId,'interrupted');value.state.lastTurnStatus='interrupted';}
      if(error)this.append(value,'error',error.message);
      const results=await Promise.allSettled([value.tools.close(),value.transport?.stop()]);
      const failed=results.find(result=>result.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
      await Promise.allSettled([value.serial]);
      value.state.phase=error?'error':'disconnected';value.state.error=error?.message;value.state.turnId=null;
      if(this.live.get(value.session.id)===value)this.live.delete(value.session.id);this.publish(value);this.store.finish(value.run.id,error?'failed':'exited',null,error?.message??null,'',0,100,30);this.changed();
    })();
    value.ending=ending.catch(failure=>{value.ending=undefined;value.stopping=false;value.state.phase='error';value.state.error='ACP 进程清理未完成，请重试停止：'+String(failure);this.publish(value);throw failure;});return value.ending;
  }
  async stop(id:string){const value=this.live.get(id);if(!value)return;await this.ended(value);}
  async close(){this.closed=true;await Promise.all([...this.live.values()].map(value=>this.ended(value)).concat([...this.probes].map(transport=>transport.stop())));await Promise.allSettled([...this.discovering.values()]);}
}
