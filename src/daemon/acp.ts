import { createHash,randomUUID } from 'node:crypto';
import { acpOptionChoices,acpModelOption, type AcpConfig, type AcpEvent, type AcpPermission, type AcpSnapshot,type AcpModels,type AcpTerminal } from '../shared/acp';
import type { AgentDefinition, Run, Session, ServerEvent } from '../shared/protocol';
import type { Store } from './store';
import { AcpTransport, AcpRpcError, acpCommand } from './acp-transport';
import { AcpClientTools } from './acp-client-tools';
import { reviewableSuperagentTool } from './superagent-tool-policy';
import type {AgentActivity} from '../shared/pet';
import {elicitationForm,elicitationUrl,elicitationError,type AcpElicitation,type ElicitationContent} from '../shared/acp-elicitation';
import { acpCapability, type AcpHistoryEntry, type AcpMessage, type AcpNativeSession, type acpImageChunkSchema } from '../shared/acp-workbench';
import { AcpAuthTerminal, literalAuthProgram, terminalAuthDescriptor } from './acp-auth-terminal';
import { terminalEnvironment } from './paths';
import type { spawn } from 'node-pty';
import { acpMediaBlock } from './acp-media';
import { AcpAttachments } from './acp-attachments';
import type { z } from 'zod';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import {acpCapabilityMarker,acpChunkKinds,acpId,acpPatch,acpRecord} from '../shared/acp-stream';
import {validateElicitationPatterns} from './elicitation-patterns';

type Metadata=Omit<AcpSnapshot,'events'|'before'|'hasMore'>;
interface Live {
  session:Session;run:Run;cwd:string;definition:AgentDefinition;transport:AcpTransport|null;tools:AcpClientTools;
  state:Metadata;permissions:Map<string,{value:AcpPermission;resolve:(value:unknown)=>void}>;
  elicitations:Map<string,{value:AcpElicitation;resolve:(value:unknown)=>void}>;
  stopping:boolean;cancelled:boolean;fingerprint:string;serial:Promise<unknown>;ending?:Promise<void>;
  attachments:AcpAttachments;
  draining?:boolean;
  authInProgress?:boolean;
  authTerminal?:AcpAuthTerminal;
  interactionPhase?:Metadata['phase'];
  urlInteractions:Map<string,{id:string;hostname:string}>;
  importing?: { events: { kind:AcpEvent['kind']; text:string; data?:Record<string,unknown> }[] };
  children:Map<string,{parentId:string;data:Record<string,unknown>;tools?:AcpClientTools}>;
  planIds:Set<string>;
  startupUpdates:{method:string;params:Record<string,any>}[];
  toolStates:Map<string,{turnId:string|null;data:Record<string,any>}>;
}
const bounded=(value:unknown):Record<string,unknown>|undefined=>{if(!value||typeof value!=='object'||Array.isArray(value))return;const text=JSON.stringify(value);return Buffer.byteLength(text)<=32768?JSON.parse(text):{omitted:true};};
export class AcpSessions {
  readonly live=new Map<string,Live>();private closed=false;
  private discovering=new Map<string,Promise<AcpModels>>();
  private probes=new Set<AcpTransport>();
  private deletingNative=new Set<string>();
  private nativeLists=new Map<string,{expires:number;sessions:Map<string,AcpNativeSession>;capabilities:Record<string,unknown>}>();
  constructor(private store:Store,private emit:(event:ServerEvent)=>void,private changed:()=>void,private spawnPty?:typeof spawn){}
  active(id:string){return this.live.has(id);}
  usesAgent(agentId:string){return [...this.live.values()].some(value=>value.definition.id===agentId);}
  activities(sessions:Session[],agents:AgentDefinition[]):AgentActivity[]{
    const ids=new Set(agents.filter(agent=>agent.acp).map(agent=>agent.id));
    return sessions.filter(session=>!session.remote&&session.latestRun&&ids.has(session.agent)).map(session=>{
      const state=this.live.get(session.id)?.state??this.store.acpState(session.id),phase=state.phase,connected=this.live.has(session.id);
      const status=state.error||phase==='error'?'error':connected&&phase==='permission'?'waiting':connected&&(phase==='running'||phase==='connecting')?'working':state.lastTurnStatus==='completed'?'completed':!connected&&(phase==='running'||phase==='permission'||state.lastTurnStatus==='interrupted')?'unknown':'idle';
      return {id:session.id,title:session.title,projectId:session.projectId,targetSessionId:session.id,managedSessionIds:[],kind:'acp',status,label:status==='waiting'?(state.elicitations?.length?'等待你的回答':'等待你的授权'):status==='working'?(phase==='connecting'?'正在连接 ACP':'Agent 正在执行'):status==='completed'?'本轮已完成':status==='error'?'ACP 会话异常':status==='unknown'?'上次任务已中断':'ACP 已就绪',updatedAt:Date.parse(session.latestRun!.startedAt)};
    });
  }
  targets(){return [...this.live.values()].flatMap(value=>value.transport?.pid?[{sessionId:value.session.id,projectId:value.session.projectId,runId:value.run.id,pid:value.transport.pid}]:[]);}
  private publish(value:Live){
    value.state.permissions=[...value.permissions.values()].map(item=>item.value);
    value.state.elicitations=[...value.elicitations.values()].map(({value:{schema,...request}})=>request);
    value.state.urlInteractions=[...value.urlInteractions.values()];
    this.store.saveAcpState(value.session.id,{...value.state,permissions:[],elicitations:[],urlInteractions:[],authTerminalId:undefined,authMethods:[],fingerprint:value.fingerprint,archived:this.store.acpState(value.session.id).archived===true,importPending:!!value.importing});
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
    const state:Metadata=value?{...value.state,permissions:[...value.permissions.values()].map(p=>p.value),elicitations:[...value.elicitations.values()].map(({value:{schema,...request}})=>request)}:{sessionId:id,nativeSessionId:saved.nativeSessionId??null,phase:'disconnected',turnId:null,permissions:[],elicitations:[],error:saved.error,agentInfo:saved.agentInfo,capabilities:saved.capabilities,configOptions:saved.configOptions,modes:saved.modes,authMethods:saved.authMethods,availableCommands:saved.availableCommands,lastTurnStatus:saved.lastTurnStatus,sessionInfo:saved.sessionInfo,usage:saved.usage,queue:saved.queue,queuePaused:!!saved.queue?.length,...(saved.phase==='running'||saved.phase==='permission'?{error:'上次操作因后台退出而中断；结果未知，不会自动重放'}:{})};
    return {...state,...this.store.acpEvents(id,pagination)};
  }
  async start(session:Session,definition:AgentDefinition,cwd:string,cols:number,rows:number):Promise<Run>{
    if(this.closed)throw new Error('ACP 后台正在退出');if(this.live.has(session.id))throw new Error('ACP 会话已连接');if(!definition.acp)throw new Error('此 Agent 未配置 ACP');
    const saved=this.store.acpState(session.id),fingerprint=this.fingerprint(definition,cwd);
    if(saved.fingerprint===fingerprint&&this.deletingNative.has(JSON.stringify([fingerprint,saved.nativeSessionId])))throw new Error('原生会话正在删除，请稍后连接');
    const run=this.store.createRun(session.id,'ACP',cols,rows,definition.acp.executable);
    const value:Live={session,run,cwd,definition,transport:null,tools:new AcpClientTools(cwd,view=>this.append(value,'terminal','',{...view}),session.owner?.kind==='superagent',view=>this.emit({event:'acp',data:{sessionId:session.id,terminal:view}})),children:new Map(),planIds:new Set(),startupUpdates:[],toolStates:new Map(),attachments:new AcpAttachments(),...(saved.importPending&&saved.fingerprint===fingerprint?{importing:{events:[]}}:{}),permissions:new Map(),elicitations:new Map(),urlInteractions:new Map(),stopping:false,cancelled:false,fingerprint,serial:Promise.resolve(),state:{sessionId:session.id,nativeSessionId:saved.fingerprint===fingerprint?saved.nativeSessionId??null:null,phase:'connecting',turnId:null,permissions:[],sessionInfo:saved.sessionInfo,queue:saved.queue??[],queuePaused:!!saved.queue?.length}};
    this.live.set(session.id,value);this.publish(value);this.changed();
    try{
      const transport=await AcpTransport.open(definition.acp,cwd,(method,params,signal)=>this.clientRequest(value,method,params,signal),(method,params)=>this.notification(value,method,params),error=>{void this.ended(value,error).catch(()=>{});});value.transport=transport;
      if(value.stopping||this.closed){await transport.stop();throw new Error('ACP 连接已取消');}
      if(transport.pid){this.store.setPid(run.id,transport.pid);run.pid=transport.pid;}
      const terminalAuth=!!this.spawnPty&&!session.owner&&literalAuthProgram(transport.child.spawnfile);
      const info=await transport.call('initialize',{protocolVersion:1,clientCapabilities:{auth:{terminal:terminalAuth},fs:{readTextFile:true,writeTextFile:true},terminal:session.owner?.kind!=='superagent',elicitation:{form:{},url:{}},session:{notices:{},compaction:{},configOptions:{boolean:{}}},plan:{},subagents:{}},clientInfo:{name:'agentberth',title:'AgentBerth',version:'0.21.0'}});
      if(info.protocolVersion!==1)throw new Error('Agent 未协商兼容的 ACP v1 协议');
      value.state.agentInfo=bounded(info.agentInfo);value.state.capabilities=bounded(info.agentCapabilities)??{};value.state.canLogout=acpCapability(value.state.capabilities,'auth','logout');
      value.state.authMethods=Array.isArray(info.authMethods)?info.authMethods.slice(0,20).flatMap((item:unknown)=>{
        if(!acpRecord(item)||!acpId(item.id)||typeof item.name!=='string')return [];
        const display={id:item.id,name:item.name.slice(0,250),description:typeof item.description==='string'?item.description.slice(0,1200):undefined};
        if(item.type===undefined||item.type==='agent')return [display];
        if(item.type!=='terminal'||!terminalAuth)return [];
        const descriptor=terminalAuthDescriptor(item);
        return descriptor?[{...display,...descriptor,type:'terminal' as const}]:[];
      }):[];
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
    const sessions=value.state.capabilities?.sessionCapabilities as Record<string,unknown>|undefined;
    const canResume=acpCapability(value.state.capabilities,'sessionCapabilities','resume')&&!value.importing;
    if(value.importing&&!value.state.capabilities?.loadSession)throw new Error('该 Agent 已不支持读取原生历史');
    const configured=value.session.owner?.kind==='superagent'?[]:this.store.acpMcpServers(value.definition.id);
    const mcpServers=configured.filter(server=>server.type==='stdio'||acpCapability(value.state.capabilities,'mcpCapabilities',server.type));
    if(mcpServers.length!==configured.length)this.append(value,'notice','Agent 不支持部分已配置的 MCP 传输方式');

    if(savedId&&!value.state.capabilities?.loadSession&&!canResume){
      value.state.nativeSessionId=null;this.append(value,'notice','此 Agent 未声明会话恢复能力；保留历史记录并创建新会话，不会重放旧消息。');
    }
    const nativeId=value.state.nativeSessionId;
    const managedPi = value.session.owner?.kind === 'superagent' && value.definition.acp?.executable === 'openma-pi-acp';
    if (managedPi) {
      const metadata = value.state.capabilities?._meta as { pi?: { delegation?: { readTextFile?: boolean; writeTextFile?: boolean } } } | undefined;
      const delegation = metadata?.pi?.delegation;
      if (!sessions || !Object.hasOwn(sessions, 'additionalDirectories') || !delegation?.readTextFile || !delegation?.writeTextFile) {
        throw new Error('此 Pi ACP 版本未提供工作区范围或工具委托，请升级 @openma/pi-acp 后重试');
      }
    }
    const context=await this.sessionContext(value);
    const response=await transport.call(nativeId?(canResume?'session/resume':'session/load'):'session/new',{...(nativeId?{sessionId:nativeId}:{}),cwd:value.cwd,mcpServers,...context,...(managedPi ? { additionalDirectories: [] } : {})});
    if (managedPi && response._meta?.pi?.additionalDirectoriesEnforced !== true) throw new Error('Pi ACP 未启用当前任务的工作区范围');
    if(!nativeId&&typeof response.sessionId!=='string')throw new Error('ACP session/new 未返回会话 ID');
    value.state.nativeSessionId=nativeId??response.sessionId;value.state.configOptions=Array.isArray(response.configOptions)?response.configOptions:[];value.state.modes=response.modes??value.state.modes;
    for(const {method,params} of value.startupUpdates.splice(0))this.notification(value,method,params);
    if(value.importing){
      const events=this.store.importAcpEvents(value.session.id,value.importing.events);
      value.importing=undefined;
      for(const event of events)this.emit({event:'acp',data:{sessionId:value.session.id,event}});
    }
    value.state.phase='ready';value.state.error=undefined;
    this.store.saveHistory(value.session.id,{messages:[],warnings:[],path:null,nativeSessionId:value.state.nativeSessionId});
    this.publish(value);
  }
  private async sessionContext(value:Live){
    if(value.session.owner)return {};
    const config=value.definition.acp!,capabilities=value.state.capabilities;
    const configured=config.additionalDirectories??[];
    let additionalDirectories:string[]|undefined;
    if(configured.length){
      if(!acpCapability(capabilities,'sessionCapabilities','additionalDirectories'))throw new Error('此 Agent 未声明附加工作区能力');
      const resolved=await Promise.all(configured.map(async directory=>{
        if(!path.isAbsolute(directory))throw new Error('附加工作区必须是绝对目录');
        const root=await realpath(directory);
        if(!(await stat(root)).isDirectory())throw new Error('附加工作区必须是目录');
        return root;
      }));
      additionalDirectories=[...new Set(resolved)].filter(directory=>path.relative(directory,value.cwd)!=='');
    }
    const systemPrompt=config.systemPrompt;
    if(systemPrompt){
      const session=acpRecord(capabilities?.sessionCapabilities)?capabilities.sessionCapabilities:undefined;
      const prompt=session?.systemPrompt;
      if(!acpCapabilityMarker(prompt))throw new Error('此 Agent 未声明系统提示词能力');
      if(systemPrompt.mode==='override'&&(!acpRecord(prompt)||!acpRecord(prompt.mode)||!acpCapabilityMarker(prompt.mode.override)))
        throw new Error('此 Agent 未声明覆盖默认系统提示词能力');
    }
    value.tools.setAdditionalRoots(additionalDirectories??[]);
    return {
      ...(additionalDirectories?{additionalDirectories}:{}),
      ...(systemPrompt?{systemPrompt:{mode:systemPrompt.mode,content:[{type:'text',text:systemPrompt.text}]}}:{}),
    };
  }
  async authenticate(id:string,methodId:string,terminalApproved=false){
    const value=this.require(id);
    const method=value.state.authMethods?.find(item=>item.id===methodId);
    if(value.authInProgress||value.state.phase!=='error'||!method)throw new Error('请选择 Agent 声明的登录方式');
    value.authInProgress=true;
    if(method.type==='terminal'){
      try{
        if(!terminalApproved||!this.spawnPty||value.session.owner)throw new Error('请核对 Agent 登录命令后确认');
        const config=value.definition.acp!,{file,args}=await acpCommand(config.executable,[...config.args,...(method.args??[])]);
        if(!literalAuthProgram(file)||value.stopping||this.live.get(id)!==value)throw new Error('当前 Agent 无法安全打开登录终端');
        const terminalId=randomUUID();
        const pty=this.spawnPty(file,args,{cwd:value.cwd,cols:80,rows:24,name:'xterm-256color',useConptyDll:process.platform==='win32',env:{...terminalEnvironment(file),...config.env,...method.env}});
        value.authTerminal=new AcpAuthTerminal(pty,terminalId,(sequence,output)=>{
          this.emit({event:'acp',data:{sessionId:id,authOutput:{terminalId,sequence,output}}});
        },(success,code)=>{void this.authTerminalExited(value,terminalId,success,code);});
        value.state.authTerminalId=terminalId;
        value.state.error=undefined;
        this.publish(value);
        return {terminalId};
      }catch(error){value.authInProgress=false;throw error;}
    }
    try{
      await value.transport!.call('authenticate',{methodId},0);
      await this.prepare(value);
    }catch(error){
      if(!value.stopping){value.state.phase='error';value.state.error=String(error);this.publish(value);}
      throw error;
    }finally{value.authInProgress=false;}
    return this.snapshot(id);
  }
  private async authTerminalExited(value:Live,terminalId:string,success:boolean,code:number){
    if(value.authTerminal?.id!==terminalId||value.stopping)return;
    value.authTerminal=undefined;value.state.authTerminalId=undefined;value.authInProgress=false;
    if(!success){value.state.error='登录终端已退出（'+code+'）';this.publish(value);return;}
    try{
      await this.ended(value);
      await this.start(value.session,value.definition,value.cwd,100,30);
    }catch(error){
      const state=this.store.acpState(value.session.id);
      if(!this.live.has(value.session.id))this.store.saveAcpState(value.session.id,{...state,error:String(error)});
      else if(this.live.get(value.session.id)===value){value.state.error=String(error);this.publish(value);}
    }
  }
  async authTerminal(id:string,terminalId:string,action:'read'|'write'|'resize'|'cancel',input?:string,cols?:number,rows?:number){
    const value=this.require(id),terminal=value.authTerminal;
    if(!terminal||terminal.id!==terminalId||value.session.owner)throw new Error('登录终端已结束');
    if(action==='read')return terminal.read();
    if(action==='write'&&input!==undefined)terminal.write(input);
    if(action==='resize'&&cols!==undefined&&rows!==undefined)terminal.resize(cols,rows);
    if(action==='cancel'){
      await terminal.stop();
      value.authTerminal=undefined;value.state.authTerminalId=undefined;value.authInProgress=false;
      value.state.error='已取消登录';
      this.publish(value);
    }
    return {};
  }
  async logout(id:string){
    const value=this.require(id);
    if(value.session.owner||value.state.phase!=='ready'||!value.state.canLogout||value.authInProgress)throw new Error('当前 Agent 会话无法退出登录');
    if([...this.live.values()].some(live=>live!==value&&live.definition.id===value.definition.id))throw new Error('请先断开此 Agent 的其他会话');
    value.authInProgress=true;value.state.phase='connecting';this.publish(value);
    try{
      await value.transport!.call('logout',{});
      await this.ended(value);
    }catch(error){
      if(!value.stopping&&this.live.get(id)===value){value.state.phase='ready';this.publish(value);}
      throw error;
    }finally{value.authInProgress=false;}
    return {};
  }
  async probe(config:AcpConfig,cwd:string){
    if(this.closed)throw new Error('ACP 后台正在退出');
    const transport=await AcpTransport.open(config,cwd,async()=>{throw new AcpRpcError(-32601,'探测连接不提供会话文件和终端');},()=>{},()=>{});
    this.probes.add(transport);try{if(this.closed)throw new Error('ACP 后台正在退出');return await transport.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentberth-probe',version:'0.18.0'}});}finally{this.probes.delete(transport);await transport.stop();}
  }
  options(definition:AgentDefinition,cwd:string):Promise<AcpModels>{
    if(this.closed)return Promise.reject(new Error('ACP 后台正在退出'));
    const models=(options?:AcpSnapshot['configOptions']):AcpModels=>{const option=acpModelOption(options);return {choices:option?acpOptionChoices(option):[],currentValue:typeof option?.currentValue==='string'?option.currentValue:undefined,configId:option?.id};};
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
  private fingerprint(definition:AgentDefinition,cwd:string){
    const {startupTimeoutMs:_,registryId:_id,registryVersion:_version,additionalDirectories:_directories,systemPrompt:_systemPrompt,...launchConfig}=definition.acp!;
    const binding=_id ? { registryId:_id } : launchConfig;
    return createHash('sha256').update(JSON.stringify([definition.id,binding,cwd])).digest('hex');
  }
  history():AcpHistoryEntry[]{
    const acp=new Set(this.store.agents().filter(agent=>agent.acp).map(agent=>agent.id));
    return this.store.state().sessions.filter(session=>!session.remote&&!session.owner&&acp.has(session.agent)).map(session=>{
      const state=this.store.acpState(session.id);
      return {sessionId:session.id,projectId:session.projectId,title:session.title,agentId:session.agent,worktreePath:session.worktreePath??null,
        nativeSessionId:state.nativeSessionId??null,phase:this.live.get(session.id)?.state.phase??'disconnected',
        resumable:!!state.nativeSessionId&&(state.capabilities?.loadSession===true||acpCapability(state.capabilities,'sessionCapabilities','resume')),
        archived:state.archived===true,updatedAt:session.latestRun?.startedAt};
    });
  }
  archive(id:string,archived:boolean){
    if(archived&&this.active(id))throw new Error('请先断开 Agent，再归档会话');
    this.store.saveAcpState(id,{...this.store.acpState(id),archived});
    this.changed();
    return {};
  }
  async nativeHistory(definition:AgentDefinition,cwd:string,projectId:string,worktreePath:string|null,cursor?:string,nativeId?:string,remove=false){
    if(this.closed||!definition.acp)throw new Error('请选择可用的 ACP Agent');
    const key=JSON.stringify([this.fingerprint(definition,cwd),projectId]);
    const cached=this.nativeLists.get(key);
    if(nativeId){
      const target=cached&&cached.expires>Date.now()?cached.sessions.get(nativeId):undefined;
      if(!target||!cached)throw new Error('请先刷新原生会话列表');
      if(remove)return this.deleteNativeHistory(definition,cwd,nativeId,cached);
      if(cached.capabilities.loadSession!==true)throw new Error('此 Agent 未声明读取原生历史的能力');
      const existing=this.history().find(session=>session.projectId===projectId&&session.agentId===definition.id&&session.worktreePath===worktreePath&&session.nativeSessionId===nativeId);
      if(existing)return {imported:existing.sessionId};
      const session=this.store.createSession(projectId,target.title,definition.id,definition.command,null,null,worktreePath);
      this.store.saveAcpState(session.id,{nativeSessionId:nativeId,fingerprint:this.fingerprint(definition,cwd),capabilities:cached.capabilities,importPending:true});
      this.changed();
      return {imported:session.id,created:true};
    }
    const transport=await AcpTransport.open(definition.acp,cwd,async()=>{throw new AcpRpcError(-32601,'导入历史不提供会话工具');},()=>{},()=>{});
    this.probes.add(transport);
    try{
      if(this.closed)throw new Error('ACP 后台正在退出');
      const info=await transport.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentberth-history',version:'0.23.0'}});
      const capabilities=bounded(info.agentCapabilities)??{};
      if(info.protocolVersion!==1||!acpCapability(capabilities,'sessionCapabilities','list'))throw new Error('此 Agent 未声明列出原生会话的能力');
      const result=await transport.call('session/list',{cwd,...(cursor?{cursor}:{})});
      const canonical=await realpath(cwd);
      const samePath=(left:string,right:string)=>path.relative(left,right)==='';
      const candidates=Array.isArray(result.sessions)?result.sessions.slice(0,100):[];
      const sessions=(await Promise.all(candidates.map(async(entry:any):Promise<AcpNativeSession|null>=>{
        if(typeof entry?.sessionId!=='string'||!entry.sessionId||entry.sessionId.length>500||typeof entry.cwd!=='string'||!path.isAbsolute(entry.cwd))return null;
        if(!samePath(entry.cwd,cwd)&&!samePath(entry.cwd,canonical)){
          // Windows short names and junctions may identify the same directory.
          // A reported path on another volume or network share is never opened.
          if(process.platform==='win32'&&!samePath(path.parse(entry.cwd).root,path.parse(canonical).root))return null;
          const resolved=await realpath(entry.cwd).catch(()=>null);
          if(!resolved||!samePath(resolved,canonical))return null;
        }
        return {sessionId:entry.sessionId,cwd:canonical,title:String(entry.title||entry.sessionId).slice(0,100),updatedAt:typeof entry.updatedAt==='string'?entry.updatedAt.slice(0,80):undefined};
      }))).filter((entry):entry is AcpNativeSession=>entry!==null);
      const known=cursor&&cached&&cached.expires>Date.now()?cached.sessions:new Map<string,AcpNativeSession>();
      for(const session of sessions)if(known.size<2000)known.set(session.sessionId,session);
      if(this.nativeLists.size>=24)this.nativeLists.delete(this.nativeLists.keys().next().value!);
      this.nativeLists.set(key,{expires:Date.now()+10*60_000,sessions:known,capabilities});
      return {sessions,resumable:capabilities.loadSession===true,deletable:acpCapability(capabilities,'sessionCapabilities','delete'),nextCursor:typeof result.nextCursor==='string'&&result.nextCursor.length<=1000?result.nextCursor:undefined};
    }finally{this.probes.delete(transport);await transport.stop();}
  }
  private async deleteNativeHistory(definition:AgentDefinition,cwd:string,nativeId:string,cached:{sessions:Map<string,AcpNativeSession>;capabilities:Record<string,unknown>}){
    const fingerprint=this.fingerprint(definition,cwd),key=JSON.stringify([fingerprint,nativeId]);
    if(!acpCapability(cached.capabilities,'sessionCapabilities','delete'))throw new Error('此 Agent 未声明删除原生会话的能力');
    if(this.deletingNative.has(key)||[...this.live.values()].some(live=>live.fingerprint===fingerprint&&live.state.nativeSessionId===nativeId))throw new Error('请先断开此原生会话');
    const linked=this.store.state().sessions.filter(session=>{
      if(session.agent!==definition.id||session.remote)return false;
      const state=this.store.acpState(session.id);
      return state.fingerprint===fingerprint&&state.nativeSessionId===nativeId;
    });
    if(linked.some(session=>session.owner))throw new Error('请从原任务管理托管会话');
    this.deletingNative.add(key);
    let transport:AcpTransport|undefined;
    try{
      transport=await AcpTransport.open(definition.acp!,cwd,async()=>{throw new AcpRpcError(-32601,'会话管理连接不提供工作区工具');},()=>{},()=>{});
      this.probes.add(transport);
      if(this.closed)throw new Error('ACP 后台正在退出');
      const info=await transport.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentberth-history',version:'0.23.0'}});
      if(info.protocolVersion!==1||!acpCapability(info.agentCapabilities,'sessionCapabilities','delete'))throw new Error('此 Agent 未声明删除原生会话的能力');
      try{await transport.call('session/delete',{sessionId:nativeId});}catch(error){
        if(!(error instanceof AcpRpcError)||error.code!==-32002)throw error;
      }
      cached.sessions.delete(nativeId);
      for(const session of linked){
        const state=this.store.acpState(session.id);
        this.store.saveAcpState(session.id,{...state,nativeSessionId:null,importPending:false});
        this.store.saveHistory(session.id,{messages:[],warnings:[],path:null,nativeSessionId:null});
      }
      this.changed();
      return {deleted:nativeId};
    }finally{
      this.deletingNative.delete(key);
      if(transport){this.probes.delete(transport);await transport.stop();}
    }
  }
  image(params:z.infer<typeof acpImageChunkSchema>){
    const live=this.require(params.sessionId);
    const type=params.mimeType.split('/')[0];
    if(!acpCapability(live.state.capabilities,'promptCapabilities',type))throw new Error('此 Agent 未开放该媒体输入');
    return live.attachments.add(params);
  }
  async submit(id:string,message:AcpMessage,queue:boolean){
    const previous=this.store.acpTurn(message.requestId);
    if(previous){
      if(previous.sessionId!==id)throw new Error('请求 ID 已属于另一会话');
      return {turnId:message.requestId,state:previous.state,duplicate:true};
    }
    const live=this.require(id);
    if(live.state.queue?.some(item=>item.requestId===message.requestId))return {turnId:message.requestId,state:'queued',duplicate:true};
    if(queue){
      if(live.state.phase==='connecting'||live.state.phase==='error')throw new Error('请先完成 Agent 连接');
      if((live.state.queue?.length??0)>=12)throw new Error('消息队列已满');
      live.state.queue=[...(live.state.queue??[]),message];
      this.publish(live);
      this.drain(live);
      return {turnId:message.requestId,state:'queued',duplicate:false};
    }
    if(live.state.phase!=='ready'||live.draining||live.state.queue?.length&&!live.state.queuePaused)throw new Error('当前任务未结束，可将消息加入队列');
    const prompt=await live.attachments.prompt(live.cwd,message.text,message.attachments??[],type=>acpCapability(live.state.capabilities,'promptCapabilities',type));
    if(this.require(id)!==live)throw new Error('会话连接已变化，请重新发送');
    return this.send(id,message.requestId,message.text,prompt,message.attachments);
  }
  queue(id:string,action:'remove'|'edit'|'resume',requestId?:string,text?:string){
    const live=this.live.get(id);
    const saved=this.store.acpState(id);
    const messages:AcpMessage[]=live?.state.queue??saved.queue??[];
    let next=messages;
    if(action==='resume'){
      if(!live||live.stopping||live.state.phase!=='ready')throw new Error('Agent 已就绪后才能继续队列');
      live.state.queuePaused=false;
    }else{
      const message=messages.find(item=>item.requestId===requestId);
      if(!message)throw new Error('消息已发送或已移除');
      if(action==='edit'&&!text&&!message.attachments?.length)throw new Error('请输入消息');
      next=action==='remove'?messages.filter(item=>item!==message):messages.map(item=>item===message?{...item,text:text??''}:item);
      if(action==='remove')live?.attachments.remove(message.attachments);
    }
    if(live){
      live.state.queue=next;
      this.publish(live);
      this.drain(live);
    }else this.store.saveAcpState(id,{...saved,queue:next,queuePaused:true});
    return {queue:next,queuePaused:live?.state.queuePaused??true};
  }
  private drain(live:Live){
    const message=live.state.queue?.[0];
    if(!message||live.stopping||live.draining||live.state.queuePaused||live.state.phase!=='ready')return;
    live.draining=true;
    void live.attachments.prompt(live.cwd,message.text,message.attachments??[],type=>acpCapability(live.state.capabilities,'promptCapabilities',type)).then(prompt=>{
      if(this.live.get(live.session.id)!==live||live.stopping||live.state.queuePaused||live.state.phase!=='ready'||live.state.queue?.[0]!==message)return;
      this.send(live.session.id,message.requestId,message.text,prompt,message.attachments);
      live.state.queue=live.state.queue.slice(1);
      this.publish(live);
    }).catch(error=>{
      if(!live.stopping&&live.state.queue?.[0]===message){
        live.state.queuePaused=true;
        this.append(live,'notice','队列已暂停：'+String(error),undefined,null);
        this.publish(live);
      }
    }).finally(()=>{
      live.draining=false;
      this.drain(live);
    });
  }
  terminal(id:string,terminalId:string):AcpTerminal{
    this.store.session(id);const live=this.live.get(id);if(live){
      for(const tools of [live.tools,...[...live.children.values()].flatMap(child=>child.tools?[child.tools]:[])]){
        try{return tools.terminal(terminalId);}catch{/* A released terminal is saved in the journal. */}
      }
    }
    const result=this.store.acpTerminal(id,terminalId);
    if(result)return result;
    throw new Error('终端输出不属于此会话或已超出历史保留范围');
  }
  private require(id:string){const value=this.live.get(id);if(!value||value.stopping||!value.transport)throw new Error('ACP 会话尚未连接，请启动会话');return value;}
  send(id:string,requestId:string,text:string,prompt?:Awaited<ReturnType<AcpAttachments['prompt']>>,attachments?:AcpMessage['attachments']){
    const previous=this.store.acpTurn(requestId);if(previous){if(previous.sessionId!==id)throw new Error('请求 ID 已属于另一会话');return {turnId:requestId,state:previous.state,duplicate:true};}
    const value=this.require(id);if(value.state.phase!=='ready')throw new Error('ACP 正在执行或等待授权，请先停止当前任务或完成授权');
    this.store.beginAcpTurn(id,requestId);value.state.turnId=requestId;value.state.phase='running';value.state.error=undefined;value.cancelled=false;
    this.append(value,'user',text || '已发送附件',attachments?.length?{attachments:attachments.map(attachment=>attachment.type==='file'?{type:attachment.type,path:attachment.path}:{type:attachment.type,name:attachment.name})}:undefined);
    value.attachments.remove(attachments);
    this.publish(value);
    // Ordinary prompts have no wall-clock timeout. Long tasks stay attached;
    // cancel/stop are explicit, and disconnect never resubmits the prompt.
    value.serial=value.transport!.call('session/prompt',{sessionId:value.state.nativeSessionId,prompt:prompt??[{type:'text',text}]},0).then(response=>{
      value.state.lastTurnStatus=value.cancelled||response.stopReason==='cancelled'?'cancelled':'completed';if(value.state.lastTurnStatus==='cancelled')value.state.queuePaused=!!value.state.queue?.length;this.store.finishAcpTurn(requestId,value.state.lastTurnStatus);this.append(value,'turn',value.cancelled?'已停止当前任务':({end_turn:'本轮已完成',max_tokens:'已达到 Agent 输出上限',max_turn_requests:'已达到 Agent 请求上限',refusal:'Agent 未执行此请求',cancelled:'已停止当前任务'} as Record<string,string>)[String(response.stopReason)]??'本轮已结束',{stopReason:response.stopReason??'end_turn'});
    },error=>{this.store.finishAcpTurn(requestId,'interrupted');value.state.lastTurnStatus='interrupted';value.state.queuePaused=!!value.state.queue?.length;if(!value.stopping)this.append(value,'error',String(error));value.state.error=String(error);}).finally(()=>{
      this.cancelPermissions(value);value.state.turnId=null;if(this.live.get(id)===value&&!value.stopping){value.state.phase=value.state.error?'error':'ready';this.publish(value);this.drain(value);}
    });
    return {turnId:requestId,state:'running',duplicate:false};
  }
  cancel(id:string,childSessionId?:string){
    const value=this.require(id);
    if(childSessionId){
      const child=value.children.get(childSessionId);
      if(!child||!acpRecord(child.data.capabilities)||!acpCapabilityMarker(child.data.capabilities.cancel))throw new Error('此子代理未提供停止操作');
      for(const [key,entry] of value.permissions)if(entry.value.childSessionId===childSessionId){
        value.permissions.delete(key);entry.resolve({outcome:{outcome:'cancelled'}});
      }
      for(const [key,entry] of value.elicitations)if(entry.value.childSessionId===childSessionId){
        value.elicitations.delete(key);entry.resolve({action:'cancel'});
      }
      value.transport!.notify('session/cancel',{sessionId:childSessionId});
      if(value.state.phase==='permission'){this.resumeAfterInteraction(value);this.publish(value);}
      return {cancelled:true};
    }if(!value.state.turnId)return {cancelled:false};value.cancelled=true;value.state.queuePaused=!!value.state.queue?.length;this.cancelPermissions(value);value.transport!.notify('session/cancel',{sessionId:value.state.nativeSessionId});value.state.phase='running';this.publish(value);return {cancelled:true,turnId:value.state.turnId};}
  permission(id:string,permissionId:string,optionId:string|null){
    const value=this.require(id),pending=value.permissions.get(permissionId);if(!pending)throw new Error('授权请求已结束或不属于此会话');
    if(optionId!==null&&!pending.value.options.some(item=>item.optionId===optionId))throw new Error('无效的授权选项');
    value.permissions.delete(permissionId);pending.resolve({outcome:optionId===null?{outcome:'cancelled'}:{outcome:'selected',optionId}});this.append(value,'notice',optionId===null?'已取消授权':'授权选择：'+pending.value.options.find(item=>item.optionId===optionId)!.name);this.resumeAfterInteraction(value);this.publish(value);return {};
  }
  async elicitation(id:string,requestId:string,action:'accept'|'decline'|'cancel',content?:ElicitationContent){
    if(!['accept','decline','cancel'].includes(action))throw new Error('无效的提问操作');
    const value=this.require(id),pending=value.elicitations.get(requestId);if(!pending)throw new Error('提问已结束或不属于此会话');
    if(action==='accept'&&pending.value.url&&content&&Object.keys(content).length)throw new Error('网页请求不接收表单内容');
    if(action==='accept'&&!pending.value.url){const error=elicitationError(pending.value,content??{});if(error)throw new Error(error);await validateElicitationPatterns(pending.value,content??{});}
    if(value.stopping||value.elicitations.get(requestId)!==pending)throw new Error('提问已结束，请重新核对当前请求');
    value.elicitations.delete(requestId);
    const url=pending.value.url;
    if(action==='accept'&&url){
      value.urlInteractions.set(url.elicitationId,{id:requestId,hostname:url.hostname});
      if(value.urlInteractions.size>32)value.urlInteractions.delete(value.urlInteractions.keys().next().value!);
    }
    pending.resolve({action,...(action==='accept'&&!url?{content:content??{}}:{})});
    this.append(value,'notice',action==='accept'?(url?'已打开网页':'已提交回答'):action==='decline'?'已拒绝请求':'已取消请求',{elicitationId:requestId,action});
    this.resumeAfterInteraction(value);this.publish(value);return {};
  }
  async configure(id:string,configId:string,setting:string|boolean){
    const value=this.require(id);if(value.state.phase!=='ready')throw new Error('请等待当前任务结束后切换模式或模型');
    const option=value.state.configOptions?.find(option=>option.id===configId);
    // Current agents (including OpenCode) expose mode through configOptions.
    // A standard option named "mode" must not be mistaken for the older API.
    if(option){
      if(option.type==='boolean'?typeof setting!=='boolean':!acpOptionChoices(option).some(item=>item.value===setting))throw new Error('请选择 Agent 声明的配置值');
      const response=await value.transport!.call('session/set_config_option',{sessionId:value.state.nativeSessionId,configId,value:setting,...(option.type==='boolean'?{type:'boolean'}:{})});if(Array.isArray(response.configOptions))value.state.configOptions=response.configOptions;else option.currentValue=setting;
    }else if(configId==='mode'&&typeof setting==='string'){
      if(!value.state.modes?.availableModes.some(mode=>mode.id===setting))throw new Error('Agent 未提供此会话模式');
      await value.transport!.call('session/set_mode',{sessionId:value.state.nativeSessionId,modeId:setting});value.state.modes.currentModeId=setting;
    }else throw new Error('Agent 未提供此配置项');
    this.publish(value);return this.snapshot(id);
  }
  private resumeAfterInteraction(value:Live){
    if(value.permissions.size||value.elicitations.size){value.state.phase='permission';return;}
    value.state.phase=value.interactionPhase??(value.state.turnId?'running':'ready');
    value.interactionPhase=undefined;
  }
  private awaitInteraction<T>(value:Live, map:Map<string,{value:T;resolve:(response:unknown)=>void}>, id:string, request:T, cancellation:unknown, signal:AbortSignal){
    signal.throwIfAborted();
    return new Promise(resolve=>{
      const abort=()=>{
        map.delete(id);
        resolve(cancellation);
        if(!value.stopping){
          this.resumeAfterInteraction(value);
          this.publish(value);
        }
      };
      map.set(id,{value:request,resolve:response=>{signal.removeEventListener('abort',abort);resolve(response);}});
      signal.addEventListener('abort',abort,{once:true});
      if(value.state.phase!=='permission')value.interactionPhase=value.state.phase;
      value.state.phase='permission';
      this.publish(value);
    });
  }
  private async clientRequest(value:Live,method:string,params:Record<string,any>,signal:AbortSignal){
    const child=value.children.get(params.sessionId);
    const childSessionId=child?params.sessionId as string:undefined;
    const sameSession=!!child||!!value.state.nativeSessionId&&params.sessionId===value.state.nativeSessionId;
    const activeRequest=method==='elicitation/create'&&params.sessionId===undefined&&value.transport?.hasPending(params.requestId);
    if(value.stopping||this.closed||(!sameSession&&!activeRequest))throw new AcpRpcError(-32602,'ACP 请求不属于当前会话');
    if(method==='elicitation/create'){
      let request:AcpElicitation;
      try{
        const id='question-'+randomUUID();
        if(params.mode==='url'){
          request=elicitationUrl(id,params);
          const opaqueId=request.url!.elicitationId;
          if(value.urlInteractions.has(opaqueId)||[...value.elicitations.values()].some(item=>item.value.url?.elicitationId===opaqueId))throw new Error('Agent 网页请求 ID 重复');
        }else request=elicitationForm(id,params);
      }catch(error){this.append(value,'error',String(error));throw new AcpRpcError(-32602,String(error));}
      request.childSessionId=childSessionId;
      this.append(value,'elicitation',request.url?'Agent 请求打开网页':request.message,{elicitationId:request.id,toolCallId:request.toolCallId,childSessionId,rootSessionId:value.state.nativeSessionId});
      return this.awaitInteraction(value,value.elicitations,request.id,request,{action:'cancel'},signal);
    }
    if(method==='session/request_permission'){
      if(!Array.isArray(params.options)||!params.options.length||params.options.length>20)throw new Error('ACP 授权选项无效');
      let options=params.options.map((item:any)=>{if(typeof item.optionId!=='string'||typeof item.name!=='string'||typeof item.kind!=='string')throw new Error('ACP 授权选项无效');return {optionId:item.optionId,name:item.name,kind:item.kind};});
      if (value.session.owner?.kind==='superagent') {
        if (!reviewableSuperagentTool(params.toolCall)) {
          this.append(value,'error','Superagent 已拒绝命令执行、删除或无法验证的工具授权', { policy:'superagent-tool-denied' });
          const reject=options.find((item:AcpPermission['options'][number])=>item.kind==='reject_once');
          return {outcome:reject?{outcome:'selected',optionId:reject.optionId}:{outcome:'cancelled'}};
        }
        options=options.filter((item:AcpPermission['options'][number])=>item.kind==='allow_once'||item.kind==='reject_once');
        if (!options.length) return {outcome:{outcome:'cancelled'}};
      }
      const id='permission-'+Date.now()+'-'+Math.random().toString(36).slice(2),permission:AcpPermission={id,childSessionId,title:String(params.toolCall?.title??'Agent 请求授权').slice(0,1000),options,toolCall:bounded(params.toolCall)};
      this.append(value,'permission',permission.title,{permissionId:id,childSessionId,rootSessionId:value.state.nativeSessionId});
      return this.awaitInteraction(value,value.permissions,id,permission,{outcome:{outcome:'cancelled'}},signal);
    }
    if (method.startsWith('terminal/') && value.session.owner?.kind==='superagent') {
      this.append(value,'error','Superagent 已拒绝通过宿主执行命令', { policy:'superagent-tool-denied' });
      throw new AcpRpcError(-32601,'Superagent 不提供任意命令执行，请使用受限工作区文件操作');
    }
    if(method.startsWith('fs/')||method.startsWith('terminal/')){
      if(method==='terminal/create'&&value.tools.count+[...value.children.values()].reduce((count,child)=>count+(child.tools?.count??0),0)>=16)throw new Error('此 ACP 会话的终端已达上限');
      if(!child)return value.tools.call(method,params,signal);
      // Child metadata never expands the parent workspace. Terminals have separate owners.
      child.tools??=new AcpClientTools(value.cwd,view=>this.append(value,'terminal','',{...view,childSessionId,rootSessionId:value.state.nativeSessionId}),value.session.owner?.kind==='superagent',view=>this.emit({event:'acp',data:{sessionId:value.session.id,terminal:view}}));
      if(method.startsWith('terminal/')&&method!=='terminal/create')return child.tools.call(method,params,signal);
      let childCwd:unknown=child.data.cwd,additional:unknown=child.data.additionalDirectories;
      for(let ancestor=value.children.get(child.parentId);ancestor&&(childCwd==null||additional==null);ancestor=value.children.get(ancestor.parentId)){
        childCwd??=ancestor.data.cwd;
        additional??=ancestor.data.additionalDirectories;
      }
      if(childCwd==null)childCwd=value.cwd;
      additional??=value.session.owner?[]:value.definition.acp?.additionalDirectories??[];
      if(typeof childCwd!=='string'||!path.isAbsolute(childCwd))throw new Error('子代理工作目录无效');
      const inherited=[childCwd,...(Array.isArray(additional)?additional.slice(0,16):[])];
      const roots=await Promise.all(inherited.filter((root):root is string=>typeof root==='string'&&path.isAbsolute(root)).map(async root=>{
        try{const file=await value.tools.file(root);return (await stat(file)).isDirectory()?file:null;}catch{return null;}
      }));
      // A claimed working directory is metadata until the parent workspace check passes.
      if(!roots[0])throw new Error('子代理工作目录超出已授权范围');
      return child.tools.call(method,params,signal,{cwd:roots[0],roots:roots.filter((root):root is string=>root!==null)});
    }
    throw new AcpRpcError(-32601,'未声明此 ACP 客户端能力：'+method);
  }
  private notification(value:Live,method:string,params:Record<string,any>){
    if(value.stopping)return;
    if(method==='elicitation/complete'){
      if(acpId(params.elicitationId)&&value.urlInteractions.delete(params.elicitationId)){
        this.append(value,'notice','网页操作已完成');
        this.publish(value);
      }
      return;
    }
    if(method!=='session/update'||!acpId(params.sessionId)||!acpRecord(params.update))return;
    const {update}=params,source=params.sessionId;
    const kind=update.sessionUpdate;
    if(typeof kind!=='string')return;
    const knownRoot=value.state.nativeSessionId;
    const child=value.children.get(source);
    if(knownRoot&&source!==knownRoot&&!child)return;
    const connecting=value.state.phase==='connecting'||value.interactionPhase==='connecting';
    if(!knownRoot){
      if(connecting&&value.startupUpdates.length<64)value.startupUpdates.push({method,params});
      return;
    }
    const scope={rootSessionId:knownRoot,...(child?{childSessionId:source}:{})};
    const record=(eventKind:AcpEvent['kind'],text:string,data?:Record<string,unknown>,turn?:string|null,eventScope=scope)=>{
      const metadata={...data,...eventScope};
      if(!connecting){this.append(value,eventKind,text,Object.keys(metadata).length?metadata:undefined,turn);return;}
      if(value.importing){
        for(let start=0;start<Math.max(1,text.length);start+=8192)
          value.importing.events.push({kind:eventKind,text:text.slice(start,start+8192),data:metadata});
      }
    };
    if(Object.hasOwn(acpChunkKinds,kind)){
      // The locally submitted user bubble is authoritative during a live turn.
      if(!child&&!connecting&&kind==='user_message_chunk'&&value.state.turnId)return;
      const content=update.content;
      if(!acpRecord(content))return;
      const data=acpId(update.messageId)?{messageId:update.messageId}:{};
      if(content.type==='text'&&typeof content.text==='string')record(acpChunkKinds[kind],content.text,data);
      else record(acpChunkKinds[kind],'',{...data,content:this.displayBlock(value,content)});
      return;
    }
    if(kind==='subagent_update'){
      if(!knownRoot||!acpId(update.sessionId)||update.sessionId===knownRoot)return;
      const previous=value.children.get(update.sessionId);
      if(previous&&previous.parentId!==source||!previous&&value.children.size>=64)return;
      const fields=acpPatch(update,['title','description','state','capabilities','cwd','additionalDirectories']);
      if(typeof fields.cwd==='string'&&!path.isAbsolute(fields.cwd))delete fields.cwd;
      const patch=bounded(fields);
      if(!patch||patch.omitted)return;
      value.children.set(update.sessionId,{parentId:source,data:{...previous?.data,...patch},tools:previous?.tools});
      record('subagent','子代理',{...patch,parentSessionId:source,subagentId:update.sessionId});
      return;
    }
    if(kind==='session_message'||kind==='session_message_chunk'){
      if(!acpId(update.messageId))return;
      const data={messageId:update.messageId,...acpPatch(update,['senderSessionId','recipientSessionId','senderMessageId','recipientMessageId'])};
      if(kind==='session_message_chunk')record('session-message','',{...data,block:this.displayBlock(value,update.content)});
      else record('session-message','',{...data,...(Object.hasOwn(update,'content')?{blocks:this.displayBlocks(value,update.content)}:{})});
      return;
    }
    if(kind==='compaction_update'||kind==='compaction_summary_chunk'){
      if(!acpId(update.compactionId))return;
      const data={compactionId:update.compactionId};
      if(kind==='compaction_summary_chunk')record('compaction','',{...data,block:this.displayBlock(value,update.content)});
      else record('compaction','',{...data,...acpPatch(update,['status','error']),...(Object.hasOwn(update,'summary')?{summary:this.displayBlocks(value,update.summary)}:{})});
      return;
    }
    if(kind==='plan'||kind==='plan_update'||kind==='plan_removed'){
      const plan=kind==='plan_update'?update.plan:update;
      if(!acpRecord(plan))return;
      const planId=acpId(plan.planId)?plan.planId:undefined;
      if(kind!=='plan'&&!planId)return;
      const key=JSON.stringify([source,planId]);
      if(kind==='plan_removed'&&!value.planIds.delete(key))return;
      if(kind==='plan_update'&&value.planIds.size<1024)value.planIds.add(key);
      const data=bounded(acpPatch(plan,['entries','path','type']))??{};
      if(kind==='plan_update'&&plan.type==='markdown'&&typeof plan.content==='string')record('plan',plan.content,{...data,planId,format:'markdown',revision:randomUUID()});
      else record('plan','执行计划',{...data,planId,removed:kind==='plan_removed'});
      return;
    }
    if(kind==='tool_call'||kind==='tool_call_update'){
      const id=update.toolCallId;if(!acpId(id))return;
      const key=JSON.stringify([source,id]);
      const previous=value.toolStates.get(key),merged={...previous?.data,...Object.fromEntries(Object.entries(update).filter(([,item])=>item!==null&&item!==undefined))};
      if(Array.isArray(update.content))merged.content=update.content.map(item=>acpRecord(item)&&item.type==='content'?{...item,content:this.displayBlock(value,item.content)}:item);
      let data=bounded(merged)!;
      if(data.omitted)data={toolCallId:id,title:String(merged.title??'工具调用').slice(0,500),kind:String(merged.kind??'other').slice(0,30),status:String(merged.status??'pending').slice(0,30),omitted:true,...(merged.rawInput!==undefined?{rawInput:JSON.stringify(merged.rawInput).slice(0,2048)}:{}),...(merged.rawOutput!==undefined?{rawOutput:JSON.stringify(merged.rawOutput).slice(0,2048)}:{})};
      if(data.omitted){
        const details=bounded({content:merged.content,locations:merged.locations});
        if(details&&!details.omitted)Object.assign(data,details);
      }
      const owner=previous?previous.turnId:value.state.turnId;
      value.toolStates.set(key,{turnId:owner,data});
      if(value.toolStates.size>512){const oldest=[...value.toolStates].find(([,item])=>['completed','failed'].includes(String(item.data.status)));value.toolStates.delete(oldest?.[0]??value.toolStates.keys().next().value!);}
      record('tool',String(data.title??data.status??'工具执行'),data,owner);
      return;
    }
    if(kind==='notice'){
      if(typeof update.title==='string'&&update.title.trim()&&typeof update.severity==='string'){
        this.emit({event:'acp',data:{sessionId:value.session.id,notice:{severity:update.severity.slice(0,80),title:update.title.slice(0,240),description:typeof update.description==='string'?update.description.slice(0,1000):undefined}}});
      }
      return;
    }
    if(child){
      const keys:Record<string,string[]>={
        session_info_update:['title','updatedAt'],
        current_mode_update:['currentModeId'],
        config_option_update:['configOptions'],
        available_commands_update:['availableCommands'],
        usage_update:['used','size','cost'],
      };
      if(Object.hasOwn(keys,kind)){
        const patch=bounded(acpPatch(update,keys[kind]));
        if(patch&&!patch.omitted){
          const parentScope={rootSessionId:knownRoot,...(child.parentId===knownRoot?{}:{childSessionId:child.parentId})};
          record('subagent','子代理',{subagentId:source,parentSessionId:child.parentId,[kind]:patch},undefined,parentScope);
        }
      }
      return;
    }
    if(kind==='session_info_update'){
      const patch=acpPatch(update,['title','updatedAt']);
      for(const key of Object.keys(patch)){
        if(typeof patch[key]==='string')patch[key]=(patch[key] as string).slice(0,500);
        else if(patch[key]!==null)delete patch[key];
      }
      value.state.sessionInfo={...value.state.sessionInfo,...patch};
      this.publish(value);
    }
    else if(kind==='usage_update'){
      const {used,size,cost}=update;
      if(typeof used==='number'&&Number.isFinite(used)&&used>=0&&typeof size==='number'&&Number.isFinite(size)&&size>0){
        value.state.usage={used,size,...(acpRecord(cost)&&typeof cost.amount==='number'&&Number.isFinite(cost.amount)&&cost.amount>=0&&typeof cost.currency==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(cost.currency)?{cost:{amount:cost.amount,currency:cost.currency}}:{})};
        this.publish(value);
      }
    }
    else if(kind==='config_option_update'){value.state.configOptions=Array.isArray(update.configOptions)?update.configOptions:[];this.publish(value);}
    else if(kind==='current_mode_update'&&acpId(update.currentModeId)&&value.state.modes){value.state.modes.currentModeId=update.currentModeId;this.publish(value);}
    else if(kind==='available_commands_update'){value.state.availableCommands=Array.isArray(update.availableCommands)?update.availableCommands.filter((item:any)=>item&&typeof item.name==='string'&&typeof item.description==='string').slice(0,100):[];this.publish(value);}
  }
  private displayBlock(value:Live,input:unknown){
    return acpMediaBlock(this.store,value.session.id,input);
  }
  private displayBlocks(value:Live,input:unknown){
    return Array.isArray(input)?input.slice(0,100).map(item=>this.displayBlock(value,item)).filter(Boolean):null;
  }
  private cancelPermissions(value:Live){for(const pending of value.permissions.values())pending.resolve({outcome:{outcome:'cancelled'}});value.permissions.clear();for(const pending of value.elicitations.values())pending.resolve({action:'cancel'});value.elicitations.clear();value.interactionPhase=undefined;}
  private ended(value:Live,error?:Error):Promise<void>{
    if(value.ending)return value.ending;value.stopping=true;this.cancelPermissions(value);value.urlInteractions.clear();
    const ending=(async()=>{
      if(value.state.turnId){this.store.finishAcpTurn(value.state.turnId,'interrupted');value.state.lastTurnStatus='interrupted';}
      if(error)this.append(value,'error',error.message);
      const capabilities=value.state.capabilities?.sessionCapabilities as Record<string,unknown>|undefined;
      if(!error&&value.transport&&value.state.nativeSessionId&&capabilities&&Object.hasOwn(capabilities,'close')){try{await value.transport.call('session/close',{sessionId:value.state.nativeSessionId},3000);}catch{/* Always terminate our own transport, including failed graceful closes. */}}
      const results=await Promise.allSettled([value.tools.close(),value.authTerminal?.stop(),...[...value.children.values()].map(child=>child.tools?.close()),value.transport?.stop()]);
      const failed=results.find(result=>result.status==='rejected');
      if(failed?.status==='rejected')throw failed.reason;
      await Promise.allSettled([value.serial]);
      value.state.authTerminalId=undefined;value.authTerminal=undefined;
      value.state.phase=error?'error':'disconnected';value.state.queuePaused=!!value.state.queue?.length;value.state.error=error?.message;value.state.turnId=null;
      if(this.live.get(value.session.id)===value)this.live.delete(value.session.id);this.publish(value);this.store.finish(value.run.id,error?'failed':'exited',null,error?.message??null,'',0,100,30);this.changed();
    })();
    value.ending=ending.catch(failure=>{value.ending=undefined;value.stopping=false;value.state.phase='error';value.state.error='ACP 进程清理未完成，请重试停止：'+String(failure);this.publish(value);throw failure;});return value.ending;
  }
  async stop(id:string){const value=this.live.get(id);if(!value)return;await this.ended(value);}
  async close(){this.closed=true;await Promise.all([...this.live.values()].map(value=>this.ended(value)).concat([...this.probes].map(transport=>transport.stop())));await Promise.allSettled([...this.discovering.values()]);}
}
