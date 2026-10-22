import { randomUUID } from 'node:crypto';
import type { DaemonConnection } from '../main/connection';
import type { RemoteAction, State } from '../shared/protocol';

const uuid = { type: 'string', format: 'uuid' };
const target = { alias: { type: 'string', description: 'Saved SSH connection alias; use alias OR sessionId + runId.' }, sessionId: uuid, runId: uuid };
const schema = (properties: Record<string,unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const tools = [
  { name: 'terminal_open', description: 'Open a saved, user-authorized SSH connection by alias. Creates a visible shared terminal and grants Agent input only for the new run. Existing terminals are returned unchanged: never bypass human takeover. Does not reconnect a broken SSH link or replay work.', inputSchema: schema({ alias: { type: 'string', minLength: 1, maxLength: 100 } }, ['alias']) },
  { name: 'terminal_list', description: 'List saved SSH aliases and visible remote terminals. Open an authorized alias using terminal_open. UI and Agent share the same real terminal.', inputSchema: schema({}, []) },
  { name: 'terminal_execute', description: 'Run one single-line command in the same POSIX login Shell using only Shell builtins for completion markers. Other login Shells use keys/screen. State/cwd persist. Generate a UUID requestId and reuse that same ID on transport retries: commands are deduplicated. Never replay an unknown outcome with a new ID. Returns an action ID; use terminal_wait for long work. Does not claim control or stop work on timeout.', inputSchema: schema({ ...target, requestId: uuid, command: { type: 'string', minLength: 1, maxLength: 4096 }, atPrompt: { type: 'boolean', default: false, description: 'Set true only after reading the screen and confirming an idle prompt when phase is unknown (for example after human input).' }, waitMs: { type: 'integer', minimum: 0, maximum: 25000, default: 1000 } }, ['requestId', 'command']) },
  { name: 'terminal_keys', description: 'Interact with a running program using either literal text (no control characters) or a named key. Read screen before choosing keys. Ctrl+C explicitly interrupts the foreground job. Never use keys to bypass user takeover. Input is not automatically retried.', inputSchema: schema({ ...target, text: { type: 'string', maxLength: 16384 }, key: { type: 'string', enum: ['Enter','Tab','Escape','Up','Down','Left','Right','Ctrl+C','Ctrl+D','Ctrl+Z','Backspace'] } }, []) },
  { name: 'terminal_screen', description: 'Read the current rendered SSH terminal screen, cursor, size and connection/control state. For TUI use this screen, not raw ANSI output or old scrollback. Read only; never resizes terminal.', inputSchema: schema(target, []) },
  { name: 'terminal_wait', description: 'Event-driven wait for a command action, up to 30 seconds per call. Timeout returns running and retains the same action; completion returns the real Shell exit code. Unknown means outcome cannot be established: inspect screen/state, do not replay. No busy polling or sleeps are needed inside a wait.', inputSchema: schema({ ...target, actionId: uuid, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 25000 } }, ['actionId']) },
  { name: 'terminal_actions', description: 'Read actual command/input/control/connection steps (newest first, 50 per page). Use before=last sequence for older steps. Does not contain Agent private reasoning or full terminal video.', inputSchema: schema({ ...target, before: { type: 'integer', minimum: 1 } }, []) },
].map(tool => ({...tool, inputSchema: {...tool.inputSchema, ...(['terminal_list','terminal_open'].includes(tool.name) ? {} : { anyOf: [{required:['alias']},{required:tool.name === 'terminal_actions' ? ['sessionId'] : ['sessionId','runId']}] })}}));

export class McpError extends Error { constructor(readonly code: number, message: string) { super(message); } }
export class TerminalMcp {
  constructor(private connection: Pick<DaemonConnection, 'rpc'>) {}
  async request(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: string })?.protocolVersion;
      return { protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(requested ?? '') ? requested : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'agentberth-terminal', version: '0.14.0' }, instructions: 'Use terminal_list to discover saved connections; terminal_open(alias) opens a user-authorized connection and gives you its visible terminal. Use alias or sessionId/runId on subsequent tools. Never reclaim input after human takeover. Only the remote SSH service is required; no multiplexer/runtime/remote daemon is installed. A broken SSH link cannot restore the original Shell; reconnect is explicitly new. User grants/revokes Agent input in AgentBerth. Always inspect screen before interactive input. Preserve requestId and actionId across retries. Wait is bounded by the client; running jobs survive timeout and disconnect. Never claim that a quiet TUI has completed.' };
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
      if (name !== 'terminal_open' && name !== 'terminal_list' && args.alias !== undefined) {
        if (args.sessionId !== undefined || args.runId !== undefined) throw new Error('Use alias OR sessionId/runId');
        const { alias, ...rest } = args;
        const resolved = await this.connection.rpc<{sessionId:string;runId:string}>('remoteResolve', {alias});
        inputArgs = {...rest,...resolved};
      }
      switch (name) {
        case 'terminal_open': value = await this.connection.rpc('remoteOpen', args); break;
        case 'terminal_list': {
          const state = await this.connection.rpc<State>('state');
          if (state.apiVersion < 21) throw new Error('请在 AgentBerth 设置中更新后台');
          const sessions = await Promise.all(state.sessions.filter(session => session.remote).map(async session => ({ sessionId: session.id, runId: session.latestRun?.id ?? null, title: session.title, project: state.projects.find(project => project.id === session.projectId)?.name, remote: session.remote, status: session.latestRun?.status ?? 'not-started', info: await this.connection.rpc('remoteInfo', { sessionId: session.id }) })));
          value = state.apiVersion >= 22 ? { connections: await this.connection.rpc('remoteAliases'), sessions } : { connections: [], sessions };
          break;
        }
        case 'terminal_execute': {
          const { waitMs = 1000, ...input } = inputArgs;
          if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 25000) throw new Error('waitMs must be 0..25000');
          const action = await this.connection.rpc<RemoteAction>('remoteExecute', input);
          value = Number(waitMs) > 0 ? await this.connection.rpc('remoteWait', { sessionId: input.sessionId, runId: input.runId, actionId: action.id, timeoutMs: waitMs }) : action;
          break;
        }
        case 'terminal_screen': value = await this.connection.rpc('remoteScreen', inputArgs); break;
        case 'terminal_wait': value = await this.connection.rpc('remoteWait', inputArgs); break;
        case 'terminal_keys': value = await this.connection.rpc('remoteKeys', inputArgs); break;
        case 'terminal_actions': value = await this.connection.rpc('remoteActions', {sessionId:inputArgs.sessionId, ...(inputArgs.before === undefined ? {} : {before:inputArgs.before})}); break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
  }
}
