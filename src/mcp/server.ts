import type { DaemonConnection } from '../main/connection';
import type { State } from '../shared/protocol';

const uuid = { type: 'string', format: 'uuid' };
const target = { alias: { type: 'string', description: 'Saved SSH connection alias; use alias OR sessionId + runId.' }, sessionId: uuid, runId: uuid };
const outputOptions = { cursor: {type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,default:0,description:'Opaque cursor from output.nextCursor; use with the same actionId and runId.'}, maxChars: {type:'integer',minimum:256,maximum:32768,default:16384} };
const schema = (properties: Record<string,unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const tools = [
  { name: 'terminal_open', description: 'Open a saved, user-authorized SSH connection by alias. Creates a visible shared terminal and grants Agent input only for the new run. Existing terminals are returned unchanged: never bypass human takeover. Does not reconnect a broken SSH link or replay work.', inputSchema: schema({ alias: { type: 'string', minLength: 1, maxLength: 100 } }, ['alias']) },
  { name: 'terminal_list', description: 'List saved SSH aliases and visible remote terminals. Open an authorized alias using terminal_open. UI and Agent share the same real terminal.', inputSchema: schema({}, []) },
  { name: 'terminal_create', description: 'Create and open a named SSH terminal on a saved authorized server. Reuses the same alias+title to make retries safe; different titles create parallel terminals. User only needs to save server/login information. Does not reclaim human input or reconnect an existing broken link.', inputSchema: schema({alias:{type:'string',minLength:1,maxLength:100},title:{type:'string',minLength:1,maxLength:100},directory:{type:'string',description:'Optional absolute remote directory; empty means login directory.'}},['alias','title']) },
  ...(['update','close','delete','reconnect'] as const).map(action=>({name:'terminal_'+action,description:{update:'Rename an SSH session; directory changes require a stopped session. Never changes saved server credentials.',close:'Close SSH and retain the session/history. This does not prove detached remote tasks have stopped.',delete:'Delete a stopped SSH session and its workbench records. Close it first; saved server information remains.',reconnect:'Explicitly start a NEW remote Shell after link loss. Old jobs are not restored or replayed. Cannot bypass human takeover.'}[action],inputSchema:schema({...target,...(action==='update'?{title:{type:'string',minLength:1,maxLength:100},directory:{type:'string'}}:{})},[])})),
  ...(['upload','download'] as const).map(direction=>({name:'terminal_'+direction,description:(direction==='upload'?'Upload a local file/directory to SSH.':'Download a remote file/directory to the local machine.')+' Uses SFTP on the visible saved-server SSH connection without interrupting the terminal. Paths are exact destinations, not implicit folders. Local paths must be absolute native paths; remote paths absolute POSIX. UUID requestId deduplicates transfers; retain it on retry. Returns a background transfer ID; use terminal_transfer_status to wait. recursive enables directories; overwrite is false by default; explicit resume verifies the existing prefix before appending. Failed/cancelled copies may leave partial files. Requires the SSH service SFTP subsystem, no installed remote helper.',inputSchema:schema({...target,requestId:uuid,localPath:{type:'string',minLength:1,maxLength:4096},remotePath:{type:'string',minLength:1,maxLength:4096},recursive:{type:'boolean',default:false},resume:{type:'boolean',default:false},overwrite:{type:'boolean',default:false}},['requestId','localPath','remotePath'])})),
  {name:'terminal_transfer',description:'Stream a file/directory between two visible saved-server SSH connections through this machine with bounded memory, without disk staging or SSH agent forwarding. Both terminals must allow Agent control. Returns a background transfer ID; wait using terminal_transfer_status. Exact absolute POSIX sourcePath/destinationPath; opt in to recursive, resume or overwrite. Same requestId never repeats a transfer.',inputSchema:schema({requestId:uuid,sourceAlias:{type:'string'},destinationAlias:{type:'string'},sourceSessionId:uuid,sourceRunId:uuid,destinationSessionId:uuid,destinationRunId:uuid,sourcePath:{type:'string',minLength:1,maxLength:4096},destinationPath:{type:'string',minLength:1,maxLength:4096},recursive:{type:'boolean',default:false},resume:{type:'boolean',default:false},overwrite:{type:'boolean',default:false}},['requestId','sourcePath','destinationPath'])},
  {name:'terminal_transfer_status',description:'Read transfer progress or wait up to 30 seconds for the same transfer requestId. Running transfers survive MCP timeout/disconnect; unknown outcomes are not automatically retried. Progress/results never include file contents.',inputSchema:schema({requestId:uuid,timeoutMs:{type:'integer',minimum:0,maximum:30000,default:25000}},['requestId'])},
  {name:'terminal_transfer_cancel',description:'Cancel an active transfer owned by Agent-controlled terminals. Partial files may remain; confirm their state before explicit resume. Does not close SSH or stop terminal programs.',inputSchema:schema({requestId:uuid},['requestId'])},
  { name: 'terminal_execute', description: 'Run one single-line command in the same POSIX login Shell using only Shell builtins for completion markers. Other login Shells use keys/screen. State/cwd persist. Generate a UUID requestId and reuse that same ID on transport retries: commands are deduplicated. Never replay an unknown outcome with a new ID. Returns status, exitCode, current Shell info and this command output together in one call; do not separately wait/read-screen for a completed result. Output is bounded merged terminal text, not separate stdout/stderr. Use terminal_read_output(actionId=id,cursor=output.nextCursor) for running work or remaining output.hasMore. Does not claim control or stop work on timeout. Requires backend API 26.', inputSchema: schema({ ...target, requestId: uuid, command: { type: 'string', minLength: 1, maxLength: 4096 }, maxChars: outputOptions.maxChars, atPrompt: { type: 'boolean', default: false, description: 'Set true only after reading the screen and confirming an idle prompt when phase is unknown (for example after human input).' }, waitMs: { type: 'integer', minimum: 0, maximum: 25000, default: 1000 } }, ['requestId', 'command']) },
  { name: 'terminal_keys', description: 'Interact with a running program using either literal text (no control characters) or a named key. Read screen before choosing keys. Ctrl+C explicitly interrupts the foreground job. Never use keys to bypass user takeover. Input is not automatically retried.', inputSchema: schema({ ...target, text: { type: 'string', maxLength: 16384 }, key: { type: 'string', enum: ['Enter','Tab','Escape','Up','Down','Left','Right','Ctrl+C','Ctrl+D','Ctrl+Z','Backspace'] } }, []) },
  { name: 'terminal_screen', description: 'Read the current rendered SSH terminal screen, cursor, size and connection/control state. For TUI use this screen, not raw ANSI output or old scrollback. Read only; never resizes terminal.', inputSchema: schema(target, []) },
  { name: 'terminal_read_output', description: 'Wait for NEW output or completion from the same running command. Returns immediately on new text, completion, buffer loss or timeout (up to 30 seconds). Pass actionId=id and cursor=output.nextCursor from the previous result. Read output.hasMore pages before waiting again. Bounded merged terminal text may contain ANSI; for interactive TUI use terminal_screen. Truncated/available=false explicitly signal buffer loss; never repeat a command to retrieve output. No sleep or tight screen polling. Requires backend API 26.', inputSchema: schema({ ...target, ...outputOptions, actionId:uuid, timeoutMs:{type:'integer',minimum:0,maximum:30000,default:25000}},['actionId']) },
  { name: 'terminal_wait', description: 'Event-driven wait for command COMPLETION up to 30 seconds; also returns bounded command output and current Shell info. For streaming logs prefer terminal_read_output, which wakes on new output. Pass cursor=output.nextCursor to avoid repeated output. Timeout returns running; unknown is not failure and must not be replayed.', inputSchema: schema({ ...target, ...outputOptions, actionId: uuid, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 25000 } }, ['actionId']) },
  { name: 'terminal_actions', description: 'Read actual command/input/control/connection steps (newest first, 50 per page). Use before=last sequence for older steps. Does not contain Agent private reasoning or full terminal video.', inputSchema: schema({ ...target, before: { type: 'integer', minimum: 1 } }, []) },
].map(tool => ({...tool, inputSchema: {...tool.inputSchema, ...(['terminal_list','terminal_open','terminal_create','terminal_transfer_status','terminal_transfer_cancel'].includes(tool.name) ? {} : tool.name==='terminal_transfer' ? {allOf:[{anyOf:[{required:['sourceAlias']},{required:['sourceSessionId','sourceRunId']}]},{anyOf:[{required:['destinationAlias']},{required:['destinationSessionId','destinationRunId']}]}]} : { anyOf: [{required:['alias']},{required:['terminal_actions','terminal_update','terminal_close','terminal_delete','terminal_reconnect'].includes(tool.name) ? ['sessionId'] : ['sessionId','runId']}] })}}));

export class McpError extends Error { constructor(readonly code: number, message: string) { super(message); } }
export class TerminalMcp {
  constructor(private connection: Pick<DaemonConnection, 'rpc'>) {}
  private async outputRpc(method:'remoteCommand'|'remoteReadOutput',params:Record<string,unknown>):Promise<unknown> {
    try{return await this.connection.rpc(method,params);}
    catch(error){
      if(String(error).includes('请求参数无效'))throw new Error('请检查工具参数，并确认已在 AgentBerth 设置中更新后台至 API 26、重新连接 MCP；命令不会自动改用其他方式重试');
      throw error;
    }
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: string })?.protocolVersion;
      return { protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(requested ?? '') ? requested : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'agentberth-terminal', version: '0.14.0' }, instructions: 'User supplies server/login information once. Use terminal_list to discover saved servers; terminal_open(alias) opens a user-authorized connection and gives you its visible terminal. You manage session create/update/close/delete/reconnect through terminal_create/update/close/delete/reconnect. File uploads/downloads/server transfers use terminal_upload/download/transfer over SFTP with progress and bounded waits through terminal_transfer_status; partial files require explicit resume and never automatic replay. Use alias or sessionId/runId on subsequent tools. Never reclaim input after human takeover. Only the remote SSH service is required; no multiplexer/runtime/remote daemon is installed. A broken SSH link cannot restore the original Shell; reconnect is explicitly new. User grants/revokes Agent input in AgentBerth. For ordinary commands when info.phase=idle, call terminal_execute directly: it returns output and status together. Do not read-screen/wait again for completed commands. For long/streaming commands use terminal_read_output with the returned id and output.nextCursor; each call wakes on new output or completion. Drain output.hasMore, honor truncated/available=false and never replay to recover output. terminal_wait waits for completion and includes output too. Use terminal_screen for interactive TUI, not routine log polling. Always inspect screen before interactive input. Preserve requestId and actionId across retries. Wait is bounded by the client; running jobs survive timeout and disconnect. Never claim that a quiet TUI has completed.' };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools };
    if (method !== 'tools/call') throw new McpError(-32601, 'Method not found');
    if (!params || typeof params !== 'object') throw new McpError(-32602, 'Invalid params');
    const { name, arguments: args = {} } = params as { name?: string; arguments?: Record<string,unknown> };
    if (!tools.some(tool => tool.name === name)) throw new McpError(-32602, 'Unknown tool');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new McpError(-32602, 'Invalid arguments');
    const allowed = Object.keys(tools.find(tool => tool.name === name)!.inputSchema.properties);
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new McpError(-32602, 'Unexpected argument');
    try {
      let value: unknown;
      let inputArgs = { ...args };
      if (['terminal_execute','terminal_keys','terminal_screen','terminal_wait','terminal_read_output','terminal_actions','terminal_upload','terminal_download'].includes(name!) && args.alias !== undefined) {
        if (args.sessionId !== undefined || args.runId !== undefined) throw new Error('Use alias OR sessionId/runId');
        const { alias, ...rest } = args;
        const resolved = await this.connection.rpc<{sessionId:string;runId:string}>('remoteResolve', {alias});
        inputArgs = {...rest,...resolved};
      }
      const endpoint=async(alias:unknown,sessionId:unknown,runId:unknown,file:unknown)=>{
        if(alias!==undefined){if(sessionId!==undefined||runId!==undefined)throw new Error('Use alias OR sessionId/runId');const resolved=await this.connection.rpc<{sessionId:string;runId:string}>('remoteResolve',{alias});return {kind:'remote',...resolved,path:file};}
        return {kind:'remote',sessionId,runId,path:file};
      };
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
        case 'terminal_execute': value = await this.outputRpc('remoteCommand', inputArgs); break;
        case 'terminal_screen': value = await this.connection.rpc('remoteScreen', inputArgs); break;
        case 'terminal_wait': case 'terminal_read_output':
          value = await this.outputRpc('remoteReadOutput', {...inputArgs,waitFor:name==='terminal_wait'?'completion':'output'}); break;
        case 'terminal_keys': value = await this.connection.rpc('remoteKeys', inputArgs); break;
        case 'terminal_actions': value = await this.connection.rpc('remoteActions', {sessionId:inputArgs.sessionId, ...(inputArgs.before === undefined ? {} : {before:inputArgs.before})}); break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
  }
}
