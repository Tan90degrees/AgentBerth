import { DaemonRpcError, type DaemonConnection } from '../main/connection';
import { requestSchema, type State, type McpCallMetric, type RemoteCommandResult } from '../shared/protocol';
import { randomUUID } from 'node:crypto';
import { commandReply, screenReply } from './results';
import { compactReply } from './compact';
import { boundedToolText } from './result-limits';
import { instructions, guide, guideUri, ToolArgumentError, errorReply, resultHarness } from './harness';

const uuid = { type: 'string', format: 'uuid' };
const target = { alias: { type: 'string', description: 'Saved SSH connection alias; use alias OR sessionId + runId.' }, sessionId: uuid, runId: uuid };
const outputMode={type:'string',enum:['summary','page'],default:'summary',description:'Default summary keeps head/tail within 256 KiB and 4000 lines; tail budget 64 KiB. Use page only when specific details are needed, never to automatically load all output.'};
const detailOption={type:'string',enum:['compact','full'],default:'compact',description:'Compact metadata by default, preserving output and trusted harness state. Full includes legacy notices/continuations/timestamps.'};
const searchOption={type:'object',description:'Literal search over captured output, never reruns the command. Case-insensitive by default; context is merged. limit=0 returns matching-line count only. Queries are snapshots, not stream polls.',properties:{query:{type:'string',minLength:1,maxLength:256},caseSensitive:{type:'boolean',default:false},contextLines:{type:'integer',minimum:0,maximum:5,default:2},limit:{type:'integer',minimum:0,maximum:100,default:20},offset:{type:'integer',minimum:0,default:0},endCursor:{type:'integer',minimum:0,description:'Frozen end from the previous search page; use returned details for pagination.'},maxBytes:{type:'integer',minimum:4096,maximum:65536,default:16384}},required:['query'],additionalProperties:false};
const outputOptions = { detail:detailOption,search:searchOption,mode:outputMode, cursor: {type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,default:0,description:'Opaque cursor from output.nextCursor; use with the same actionId and runId.'}, maxChars: {type:'integer',minimum:256,maximum:65536,default:32768,description:'Only applies to explicit mode=page; summary always uses ssh-skill byte/line/tail limits.'} };
const schema = (properties: Record<string,unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const descriptions:Record<string,string>={
  terminal_list:'Discover saved SSH aliases and current sessions; call once when the target is unknown. Users configure servers in AgentBerth, not in tool arguments. Choose the intended alias or sessionId/runId; never guess when multiple targets match.',
  terminal_open:'Open/reuse a saved authorized SSH alias without running a command. Returns Shell/control state and harness.next. Existing user-controlled or disconnected sessions stay unchanged. Ordinary commands can use terminal_execute directly; transfers need an open connection.',
  terminal_execute:'PRIMARY tool for ordinary SSH commands. Example: {"alias":"dev-server","command":"uname -a"}. Opens/reuses the saved terminal, preserving cwd/environment. Returns status, exitCode and bounded command output together; optional search filters before returning text. Follow harness.next for running work; completed needs no extra screen/wait. Never replay unknown outcomes. Omitted output does not require draining pages. For TUI use screen/keys; human takeover blocks input. requestId is optional/generated; explicit retries retain the same ID. Requires backend API 33.',
  terminal_read_output:'Read NEW output or wait for completion using the exact harness.next arguments from a running command. Each event-driven call returns on new output/completion or timeout; never sleep or screen-poll. Default summary advances to the current end. Use search={query:"error",contextLines:2} to query cached output and count matches without rerunning. Search snapshots return immediately; terminal_wait can wait before querying. Details/mode=page are opt-in, never drain automatically. Omit actionId only to discover the latest reliable command from cursor=0. Never rerun to recover output.',
  terminal_screen:'Observe the current TUI viewport before choosing interactive keys. This is not a full ordinary-command result: use execute/read_output for logs or lists. The result has no automatic follow-up screen call. Never clear/rerun to recover scrolled rows. Read-only; never resizes or claims input.',
  terminal_keys:'Send TUI/interactive input after screen inspection. Text includes Enter by default; enter=false opts out, named keys send once. Ordinary commands should use execute. Idle POSIX submitted text is also captured as a command. Backend enforces control ownership; never retry an uncertain keypress. Follow harness.next to observe the result.',
};
export const tools = [
  { name: 'terminal_open', description: descriptions.terminal_open, inputSchema: schema({ alias: { type: 'string', minLength: 1, maxLength: 100 } }, ['alias']) },
  { name: 'terminal_list', description: descriptions.terminal_list, inputSchema: schema({}, []) },
  { name: 'terminal_create', description: 'Create and open a named SSH terminal on a saved authorized server. Reuses the same alias+title to make retries safe; different titles create parallel terminals. User only needs to save server/login information. Does not reclaim human input or reconnect an existing broken link.', inputSchema: schema({alias:{type:'string',minLength:1,maxLength:100},title:{type:'string',minLength:1,maxLength:100},directory:{type:'string',description:'Optional absolute remote directory; empty means login directory.'}},['alias','title']) },
  ...(['update','close','delete','reconnect'] as const).map(action=>({name:'terminal_'+action,description:{update:'Rename an SSH session; directory changes require a stopped session. Never changes saved server credentials.',close:'Close SSH and retain the session/history. This does not prove detached remote tasks have stopped.',delete:'Delete a stopped SSH session and its workbench records. Close it first; saved server information remains.',reconnect:'Explicitly start a NEW remote Shell after link loss. Old jobs are not restored or replayed. Cannot bypass human takeover.'}[action],inputSchema:schema({...target,...(action==='update'?{title:{type:'string',minLength:1,maxLength:100},directory:{type:'string'}}:{})},[])})),
  ...(['upload','download'] as const).map(direction=>({name:'terminal_'+direction,description:(direction==='upload'?'Upload a local file/directory to SSH.':'Download a remote file/directory to the local machine.')+' Uses SFTP on the visible saved-server SSH connection without interrupting the terminal. Paths are exact destinations, not implicit folders. Local paths must be absolute native paths; remote paths absolute POSIX. requestId is optional/generated; retain the returned UUID on explicit retry. Returns a background transfer ID; use terminal_transfer_status to wait. recursive enables directories; overwrite is false by default; explicit resume verifies the existing prefix before appending. Failed/cancelled copies may leave partial files. Requires the SSH service SFTP subsystem, no installed remote helper.',inputSchema:schema({...target,requestId:uuid,localPath:{type:'string',minLength:1,maxLength:4096},remotePath:{type:'string',minLength:1,maxLength:4096},recursive:{type:'boolean',default:false},resume:{type:'boolean',default:false},overwrite:{type:'boolean',default:false}},['localPath','remotePath'])})),
  {name:'terminal_transfer',description:'Stream a file/directory between two visible saved-server SSH connections through this machine with bounded memory, without disk staging or SSH agent forwarding. Both terminals must allow Agent control. Returns a background transfer ID; wait using terminal_transfer_status. Exact absolute POSIX sourcePath/destinationPath; opt in to recursive, resume or overwrite. requestId is optional/generated; reuse the returned ID on explicit retry, never replay unknown transfers.',inputSchema:schema({requestId:uuid,sourceAlias:{type:'string'},destinationAlias:{type:'string'},sourceSessionId:uuid,sourceRunId:uuid,destinationSessionId:uuid,destinationRunId:uuid,sourcePath:{type:'string',minLength:1,maxLength:4096},destinationPath:{type:'string',minLength:1,maxLength:4096},recursive:{type:'boolean',default:false},resume:{type:'boolean',default:false},overwrite:{type:'boolean',default:false}},['sourcePath','destinationPath'])},
  {name:'terminal_transfer_status',description:'Read transfer progress or wait up to 30 seconds for the same transfer requestId. Running transfers survive MCP timeout/disconnect; unknown outcomes are not automatically retried. Progress/results never include file contents.',inputSchema:schema({requestId:uuid,timeoutMs:{type:'integer',minimum:0,maximum:30000,default:25000}},['requestId'])},
  {name:'terminal_transfer_cancel',description:'Cancel an active transfer owned by Agent-controlled terminals. Partial files may remain; confirm their state before explicit resume. Does not close SSH or stop terminal programs.',inputSchema:schema({requestId:uuid},['requestId'])},
  { name: 'terminal_execute', description: descriptions.terminal_execute, inputSchema: schema({ ...target, detail:detailOption, search:searchOption, requestId: uuid, command: { type: 'string', minLength: 1, maxLength: 16384 }, mode:outputMode, maxChars: outputOptions.maxChars, atPrompt: { type: 'boolean', default: false, description: 'Set true only after reading the screen and confirming an idle prompt when phase is unknown (for example after human input).' }, waitMs: { type: 'integer', minimum: 0, maximum: 25000, default: 5000 } }, ['command']) },
  { name: 'terminal_keys', description: descriptions.terminal_keys, inputSchema: schema({ ...target, detail:detailOption,text: { type: 'string', maxLength: 16384 }, enter: {type:'boolean',default:true,description:'For text only. Defaults to sending text plus Enter in one operation. Set false for partial typing or TUI shortcuts.'}, key: { type: 'string', enum: ['Enter','Tab','Escape','Up','Down','Left','Right','Ctrl+C','Ctrl+D','Ctrl+Z','Backspace'] } }, []) },
  { name: 'terminal_screen', description: descriptions.terminal_screen, inputSchema: schema({...target,detail:detailOption}, []) },
  { name: 'terminal_read_output', description: descriptions.terminal_read_output, inputSchema: schema({ ...target, ...outputOptions, actionId:uuid, timeoutMs:{type:'integer',minimum:0,maximum:30000,default:25000}},[]) },
  { name: 'terminal_wait', description: 'Event-driven wait for command COMPLETION up to 30 seconds; also returns bounded command output and current Shell info. For streaming logs prefer terminal_read_output, which wakes on new output. Pass cursor=output.nextCursor to avoid repeated output. Timeout returns running; unknown is not failure and must not be replayed.', inputSchema: schema({ ...target, ...outputOptions, actionId: uuid, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 25000 } }, ['actionId']) },
  { name: 'terminal_actions', description: 'Read actual command/input/control/connection steps (newest first, 50 per page). Use before=last sequence for older steps. Does not contain Agent private reasoning or full terminal video.', inputSchema: schema({ ...target, before: { type: 'integer', minimum: 1 } }, []) },
].map(tool => ({...tool, inputSchema: {...tool.inputSchema, ...(['terminal_list','terminal_open','terminal_create','terminal_transfer_status','terminal_transfer_cancel'].includes(tool.name) ? {} : tool.name==='terminal_transfer' ? {allOf:[{anyOf:[{required:['sourceAlias']},{required:['sourceSessionId','sourceRunId']}]},{anyOf:[{required:['destinationAlias']},{required:['destinationSessionId','destinationRunId']}]}]} : { anyOf: [{required:['alias']},{required:['terminal_actions','terminal_update','terminal_close','terminal_delete','terminal_reconnect'].includes(tool.name) ? ['sessionId'] : ['sessionId','runId']}] })}})).map(tool=>({...tool,title:tool.name.replace('terminal_','SSH · '),annotations:{readOnlyHint:['terminal_list','terminal_screen','terminal_read_output','terminal_wait','terminal_actions','terminal_transfer_status'].includes(tool.name),destructiveHint:!['terminal_list','terminal_screen','terminal_read_output','terminal_wait','terminal_actions','terminal_transfer_status','terminal_open','terminal_create'].includes(tool.name),idempotentHint:['terminal_list','terminal_screen','terminal_read_output','terminal_wait','terminal_actions','terminal_transfer_status','terminal_open','terminal_create','terminal_close'].includes(tool.name),openWorldHint:true}}));

export class McpError extends Error { constructor(readonly code: number, message: string) { super(message); } }
export class TerminalMcp {
  constructor(private connection: Pick<DaemonConnection, 'rpc'>,private reportCall?:(event:McpCallMetric)=>void|Promise<unknown>) {}
  private validateOutput(method:'remoteCommand'|'remoteReadOutput'|'remoteKeys',params:Record<string,unknown>) {
    const checked=requestSchema.safeParse({id:randomUUID(),method,params});
    if(!checked.success)throw new ToolArgumentError('工具参数无效：'+checked.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; '));
    return checked.data.params;
  }
  private async outputRpc(method:'remoteCommand'|'remoteReadOutput'|'remoteKeys',params:Record<string,unknown>):Promise<unknown> {
    // Validate before transmission. Never substitute another execution path.
    const checked=this.validateOutput(method,params);
    try{return await this.connection.rpc(method,checked);}
    catch(error){
      if(error instanceof DaemonRpcError&&error.code&&error.code!=='INVALID_ARGUMENTS')throw error;
      if(String(error).includes('请求参数无效')){
        const state=await this.connection.rpc<State>('state').catch(()=>null);
        if(state&&state.apiVersion<33)throw new DaemonRpcError(`后台 API ${state.apiVersion}，此 MCP 需要 API 33。请在设置 → 后台服务更新后台，并重新连接 MCP。命令未自动重试。`,'BACKEND_UPGRADE_REQUIRED');
        throw new DaemonRpcError(`后台拒绝 ${method} 参数${state?`（API ${state.apiVersion}）`:''}：${error instanceof Error?error.message:String(error)}；命令未自动重试。`,'INVALID_ARGUMENTS');
      }
      if(method==='remoteCommand')throw new Error(`${error instanceof Error?error.message:String(error)}（requestId: ${params.requestId}；请保留此 ID，结果未知时不要使用新 ID 重发命令）`);
      throw error;
    }
  }
  async request(method:string,params:unknown):Promise<unknown> {
    if(method!=='tools/call')return this.dispatch(method,params);
    let success=false;
    try {const result:any=await this.dispatch(method,params);success=!result.isError;return result;}
    finally {const name=(params as {name?:unknown})?.name;try{void Promise.resolve(this.reportCall?.({callId:randomUUID(),tool:typeof name==='string'?name.slice(0,80)||'unknown':'unknown',success})).catch(()=>{});}catch{/* Telemetry cannot alter tool results. */}}
  }
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: string })?.protocolVersion;
      return { protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(requested ?? '') ? requested : '2025-11-25', capabilities: { tools: {}, resources:{} }, serverInfo: { name: 'agentberth-terminal', title:'AgentBerth shared SSH terminal', version: '0.14.0' }, instructions };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools };
    if (method === 'resources/list') return {resources:[{uri:guideUri,name:'remote-terminal-guide',title:'AgentBerth built-in terminal contract',mimeType:'text/markdown',description:'Optional detailed reference; normal use only needs tool descriptions and harness.next.'}]};
    if (method === 'resources/templates/list') return {resourceTemplates:[]};
    if (method === 'resources/read') {
      if((params as {uri?:unknown})?.uri!==guideUri)throw new McpError(-32602,'Unknown resource');
      return {contents:[{uri:guideUri,mimeType:'text/markdown',text:guide}]};
    }
    if (method !== 'tools/call') throw new McpError(-32601, 'Method not found');
    if (!params || typeof params !== 'object') throw new McpError(-32602, 'Invalid params');
    const { name, arguments: provided = {} } = params as { name?: string; arguments?: Record<string,unknown> };
    const args={...provided};
    if (!tools.some(tool => tool.name === name)) throw new McpError(-32602, 'Unknown tool');
    if (!provided || typeof provided !== 'object' || Array.isArray(provided)) throw new McpError(-32602, 'Invalid arguments');
    const allowed = Object.keys(tools.find(tool => tool.name === name)!.inputSchema.properties);
    const unexpected=Object.keys(args).filter(key=>!allowed.includes(key));
    let inputArgs:Record<string,unknown>={...args},dispatched=false;
    try {
      if(unexpected.length)throw new ToolArgumentError('Unexpected argument: '+unexpected.join(', '));
      const detail=args.detail??'compact';if(!['compact','full'].includes(detail as string))throw new ToolArgumentError('detail must be compact or full');delete args.detail;
      if(['terminal_execute','terminal_upload','terminal_download','terminal_transfer'].includes(name!))if(args.requestId===undefined)args.requestId=randomUUID();
      inputArgs={...args};
      // Validate ordinary command/interaction input BEFORE opening any SSH connection.
      const outputMethod=name==='terminal_execute'?'remoteCommand':name==='terminal_keys'?'remoteKeys':['terminal_wait','terminal_read_output'].includes(name!)?'remoteReadOutput':null;
      if(outputMethod){
        const {alias,...rest}=args;
        if(alias!==undefined&&(typeof alias!=='string'||!alias.trim()||args.sessionId!==undefined||args.runId!==undefined))throw new ToolArgumentError('Use a nonempty alias OR sessionId/runId');
        const params={...rest,...(alias!==undefined?{sessionId:randomUUID(),runId:randomUUID()}:{}),...(outputMethod==='remoteReadOutput'?{waitFor:name==='terminal_wait'?'completion':'output'}:{})};
        this.validateOutput(outputMethod,params);
      }
      let value: unknown;
      if (['terminal_execute','terminal_keys','terminal_screen','terminal_wait','terminal_read_output','terminal_actions','terminal_upload','terminal_download'].includes(name!) && args.alias !== undefined) {
        if (args.sessionId !== undefined || args.runId !== undefined) throw new ToolArgumentError('Use alias OR sessionId/runId');
        const { alias, ...rest } = args;
        const resolved = await this.connection.rpc<{sessionId:string;runId:string}>(name==='terminal_execute'?'remoteOpen':'remoteResolve', {alias});
        inputArgs = {...rest,sessionId:resolved.sessionId,runId:resolved.runId};
      }
      const endpoint=async(alias:unknown,sessionId:unknown,runId:unknown,file:unknown)=>{
        if(alias!==undefined){if(sessionId!==undefined||runId!==undefined)throw new ToolArgumentError('Use alias OR sessionId/runId');const resolved=await this.connection.rpc<{sessionId:string;runId:string}>('remoteResolve',{alias});return {kind:'remote',...resolved,path:file};}
        return {kind:'remote',sessionId,runId,path:file};
      };
      dispatched=true;
      switch (name) {
        case 'terminal_open': value = await this.connection.rpc('remoteOpen', args); break;
        case 'terminal_create': case 'terminal_update': case 'terminal_close': case 'terminal_delete': case 'terminal_reconnect':
          value=await this.connection.rpc('remoteManage',{...args,action:name.slice(9)});break;
        case 'terminal_upload': case 'terminal_download': {
          const remote={kind:'remote',sessionId:inputArgs.sessionId,runId:inputArgs.runId,path:args.remotePath},local={kind:'local',path:args.localPath};
          value=await this.connection.rpc('remoteTransferStart',{requestId:args.requestId,source:name==='terminal_upload'?local:remote,destination:name==='terminal_upload'?remote:local,...Object.fromEntries(['recursive','resume','overwrite'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))});break;
        }
        case 'terminal_transfer': {
          const [source,destination]=await Promise.all([endpoint(args.sourceAlias,args.sourceSessionId,args.sourceRunId,args.sourcePath),endpoint(args.destinationAlias,args.destinationSessionId,args.destinationRunId,args.destinationPath)]);
          value=await this.connection.rpc('remoteTransferStart',{requestId:args.requestId,source,destination,...Object.fromEntries(['recursive','resume','overwrite'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))});break;
        }
        case 'terminal_transfer_status':value=await this.connection.rpc('remoteTransferStatus',{...args,timeoutMs:args.timeoutMs??25000});break;
        case 'terminal_transfer_cancel':value=await this.connection.rpc('remoteTransferCancel',args);break;
        case 'terminal_list': {
          const state = await this.connection.rpc<State>('state');
          if (state.apiVersion < 21) throw new Error('请在 AgentBerth 设置中更新后台');
          const sessions = await Promise.all(state.sessions.filter(session => session.remote).map(async session => ({ sessionId: session.id, runId: session.latestRun?.id ?? null, title: session.title, project: state.projects.find(project => project.id === session.projectId)?.name, remote: session.remote, status: session.latestRun?.status ?? 'not-started', info: await this.connection.rpc('remoteInfo', { sessionId: session.id }) })));
          value = state.apiVersion >= 22 ? { connections: await this.connection.rpc('remoteAliases'), sessions } : { connections: [], sessions };
          break;
        }
        case 'terminal_execute': value = await this.outputRpc('remoteCommand', {...inputArgs,requestId:inputArgs.requestId??randomUUID()}); break;
        case 'terminal_screen': value = await this.connection.rpc('remoteScreen', inputArgs); break;
        case 'terminal_wait': case 'terminal_read_output':
          value = await this.outputRpc('remoteReadOutput', {...inputArgs,waitFor:name==='terminal_wait'?'completion':'output'}); break;
        case 'terminal_keys': value = await this.outputRpc('remoteKeys', inputArgs); break;
        case 'terminal_actions': value = await this.connection.rpc('remoteActions', {sessionId:inputArgs.sessionId, ...(inputArgs.before === undefined ? {} : {before:inputArgs.before})}); break;
      }
      if(name==='terminal_screen')value=screenReply(value as Record<string,any>);
      else if(['terminal_execute','terminal_read_output','terminal_wait','terminal_keys'].includes(name!)&&value&&typeof value==='object'&&'output' in value){
        value=commandReply(value as RemoteCommandResult,typeof args.cursor==='number'?args.cursor:0,typeof args.maxChars==='number'?args.maxChars:undefined);
      }
      const reply=resultHarness(name!,value);
      if(detail==='full')for(const next of [reply?.continuation,reply?.details,reply?.harness?.next])if(next&&['terminal_execute','terminal_read_output','terminal_wait','terminal_screen','terminal_keys'].includes(next.tool))next.arguments.detail='full';
      return { content: [{ type: 'text', text: boundedToolText(detail==='full'?reply:compactReply(reply)) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: boundedToolText(errorReply(error,{name:name!,args,target:inputArgs,dispatched})) }] }; }
  }
}
