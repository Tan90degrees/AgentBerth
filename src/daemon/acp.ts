import { createHash } from 'node:crypto';
import { acpOptionChoices, type AcpConfig, type AcpEvent, type AcpPermission, type AcpSnapshot } from '../shared/acp';
import type { AgentDefinition, Run, Session, ServerEvent } from '../shared/protocol';
import type { Store } from './store';
import { AcpTransport, AcpRpcError } from './acp-transport';
import { AcpClientTools } from './acp-client-tools';

type Metadata=Omit<AcpSnapshot,'events'|'before'|'hasMore'>;
interface Live {
  session:Session;run:Run;cwd:string;definition:AgentDefinition;transport:AcpTransport|null;tools:AcpClientTools;
  state:Metadata;permissions:Map<string,{value:AcpPermission;resolve:(value:unknown)=>void}>;
  stopping:boolean;cancelled:boolean;fingerprint:string;serial:Promise<unknown>;ending?:Promise<void>;
}
const bounded=(value:unknown):Record<string,unknown>|undefined=>{if(!value||typeof value!=='object'||Array.isArray(value))return;const text=JSON.stringify(value);return Buffer.byteLength(text)<=32768?JSON.parse(text):{omitted:true};};
export class AcpSessions {
  readonly live=new Map<string,Live>();private closed=false;
  constructor(private store:Store,private emit:(event:ServerEvent)=>void,private changed:()=>void){}
  active(id:string){return this.live.has(id);}
  targets(){return [...this.live.values()].flatMap(value=>value.transport?.pid?[{sessionId:value.session.id,projectId:value.session.projectId,runId:value.run.id,pid:value.transport.pid}]:[]);}
  private publish(value:Live){
    value.state.permissions=[...value.permissions.values()].map(item=>item.value);
    this.store.saveAcpState(value.session.id,{...value.state,permissions:[],fingerprint:value.fingerprint});
    this.emit({event:'acp',data:{sessionId:value.session.id,state:{...value.state}}});
  }
  private append(value:Live,kind:AcpEvent['kind'],text:string,data?:Record<string,unknown>){
    // Bound individual events and response pages, keeping the full turn in the
    // paginated journal rather than an xterm viewport or a growing state RPC.
    const chunks=text?Array.from({length:Math.ceil(text.length/8192)},(_,i)=>text.slice(i*8192,(i+1)*8192)):[''];
    for(const chunk of chunks){const event=this.store.appendAcp(value.session.id,value.state.turnId,kind,chunk,data);this.emit({event:'acp',data:{sessionId:value.session.id,event}});}
  }
  snapshot(id:string,pagination:{before?:number;after?:number;limit?:number}={}):AcpSnapshot{
    const saved=this.store.acpState(id),value=this.live.get(id);
    const state:Metadata=value?{...value.state,permissions:[...value.permissions.values()].map(p=>p.value)}:{sessionId:id,nativeSessionId:saved.nativeSessionId??null,phase:'disconnected',turnId:null,permissions:[],error:saved.error,agentInfo:saved.agentInfo,capabilities:saved.capabilities,configOptions:saved.configOptions,modes:saved.modes,authMethods:saved.authMethods,...(saved.phase==='running'||saved.phase==='permission'?{error:'上次操作因后台退出而中断；结果未知，不会自动重放'}:{})};
    return {...state,...this.store.acpEvents(id,pagination)};
  }
  async start(session:Session,definition:AgentDefinition,cwd:string,cols:number,rows:number):Promise<Run>{
    if(this.closed)throw new Error('ACP 后台正在退出');if(this.live.has(session.id))throw new Error('ACP 会话已连接');if(!definition.acp)throw new Error('此 Agent 未配置 ACP');
    const run=this.store.createRun(session.id,'ACP',cols,rows,definition.acp.executable),saved=this.store.acpState(session.id);
    const fingerprint=createHash('sha256').update(JSON.stringify([definition.id,definition.acp,cwd])).digest('hex');
    const value:Live={session,run,cwd,definition,transport:null,tools:new AcpClientTools(cwd),permissions:new Map(),stopping:false,cancelled:false,fingerprint,serial:Promise.resolve(),state:{sessionId:session.id,nativeSessionId:saved.fingerprint===fingerprint?saved.nativeSessionId??null:null,phase:'connecting',turnId:null,permissions:[]}};
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
    try{return await transport.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentberth-probe',version:'0.18.0'}});}finally{await transport.stop();}
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
      this.store.finishAcpTurn(requestId,value.cancelled?'cancelled':'completed');this.append(value,'turn',value.cancelled?'已停止当前任务':({end_turn:'本轮已完成',max_tokens:'已达到 Agent 输出上限',max_turn_requests:'已达到 Agent 请求上限',refusal:'Agent 未执行此请求',cancelled:'已停止当前任务'} as Record<string,string>)[String(response.stopReason)]??'本轮已结束',{stopReason:response.stopReason??'end_turn'});
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
    if(['agent_message_chunk','agent_thought_chunk','user_message_chunk'].includes(kind)){
      // loadSession may replay the remote transcript. Our journal is already
      // durable; replayed notifications must not duplicate previous messages.
      if(value.state.phase==='connecting')return;
      const text=update.content?.type==='text'?String(update.content.text??''):update.content?.type==='resource_link'?String(update.content.uri??''):'[非文本内容]';
      this.append(value,kind==='agent_thought_chunk'?'thought':kind==='user_message_chunk'?'notice':'assistant',text);
    }else if(kind==='tool_call'||kind==='tool_call_update')this.append(value,'tool',String(update.title??update.status??'工具执行'),bounded(update));
    else if(kind==='plan')this.append(value,'plan','执行计划',bounded(update));
    else if(kind==='config_option_update'){value.state.configOptions=Array.isArray(update.configOptions)?update.configOptions:[];this.publish(value);}
    else if(kind==='current_mode_update'&&value.state.modes){value.state.modes.currentModeId=String(update.currentModeId);this.publish(value);}
  }
  private cancelPermissions(value:Live){for(const pending of value.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});value.permissions.clear();}
  private ended(value:Live,error?:Error):Promise<void>{
    if(value.ending)return value.ending;value.stopping=true;this.cancelPermissions(value);
    const ending=(async()=>{
      if(value.state.turnId)this.store.finishAcpTurn(value.state.turnId,'interrupted');
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
  async close(){this.closed=true;await Promise.all([...this.live.values()].map(value=>this.ended(value)));}
}
