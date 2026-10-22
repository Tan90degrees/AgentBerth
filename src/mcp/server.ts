import { randomUUID } from 'node:crypto';
import type { DaemonConnection } from '../main/connection';
import type { RemoteAction, State } from '../shared/protocol';

const uuid = { type: 'string', format: 'uuid' };
const target = { sessionId: uuid, runId: uuid };
const schema = (properties: Record<string,unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const tools = [
  { name: 'terminal_list', description: 'List visible persistent remote terminals. User must create/start one in AgentBerth and grant Agent control. UI and Agent share the same real terminal.', inputSchema: schema({}, []) },
  { name: 'terminal_execute', description: 'Type one single-line command into an idle Bash shell. State/cwd persist. Generate a UUID requestId and reuse that same ID on transport retries: commands are deduplicated. Never replay an unknown outcome with a new ID. Returns an action ID; use terminal_wait for long work. Does not claim control or stop work on timeout.', inputSchema: schema({ ...target, requestId: uuid, command: { type: 'string', minLength: 1, maxLength: 4096 }, waitMs: { type: 'integer', minimum: 0, maximum: 25000, default: 1000 } }, [...Object.keys(target), 'requestId', 'command']) },
  { name: 'terminal_keys', description: 'Interact with a running program using either literal text (no control characters) or a named key. Read screen before choosing keys. Ctrl+C explicitly interrupts the foreground job. Never use keys to bypass user takeover. Input is not automatically retried.', inputSchema: schema({ ...target, text: { type: 'string', maxLength: 16384 }, key: { type: 'string', enum: ['Enter','Tab','Escape','Up','Down','Left','Right','Ctrl+C','Ctrl+D','Ctrl+Z','Backspace'] } }, Object.keys(target)) },
  { name: 'terminal_screen', description: 'Read the current rendered terminal screen, cursor, size and connection/control state. For TUI use this screen, not raw ANSI output or old scrollback. Read only; never resizes terminal.', inputSchema: schema(target, Object.keys(target)) },
  { name: 'terminal_wait', description: 'Event-driven wait for a command action, up to 30 seconds per call. Timeout returns running and retains the same action; completion returns real Bash exit code. Unknown means outcome cannot be established: inspect screen/state, do not replay. No busy polling or sleeps are needed inside a wait.', inputSchema: schema({ ...target, actionId: uuid, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 25000 } }, [...Object.keys(target), 'actionId']) },
  { name: 'terminal_actions', description: 'Read actual command/input/control/connection steps (newest first, 50 per page). Use before=last sequence for older steps. Does not contain Agent private reasoning or full terminal video.', inputSchema: schema({ sessionId: uuid, before: { type: 'integer', minimum: 1 } }, ['sessionId']) },
];

export class McpError extends Error { constructor(readonly code: number, message: string) { super(message); } }
export class TerminalMcp {
  constructor(private connection: Pick<DaemonConnection, 'rpc'>) {}
  async request(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: string })?.protocolVersion;
      return { protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(requested ?? '') ? requested : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'agentberth-terminal', version: '0.1.0' }, instructions: 'Use only user-created remote sessions. User grants/revokes Agent input in AgentBerth. Always inspect screen before interactive input. Preserve requestId and actionId across retries. Wait is bounded by the client; running jobs survive timeout and disconnect. Never claim that a quiet TUI has completed.' };
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
      switch (name) {
        case 'terminal_list': {
          const state = await this.connection.rpc<State>('state');
          if (state.apiVersion < 20) throw new Error('请在 AgentBerth 设置中更新后台');
          value = await Promise.all(state.sessions.filter(session => session.remote).map(async session => ({ sessionId: session.id, runId: session.latestRun?.id ?? null, title: session.title, project: state.projects.find(project => project.id === session.projectId)?.name, remote: session.remote, status: session.latestRun?.status ?? 'not-started', info: await this.connection.rpc('remoteInfo', { sessionId: session.id }) })));
          break;
        }
        case 'terminal_execute': {
          const { waitMs = 1000, ...input } = args;
          if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 25000) throw new Error('waitMs must be 0..25000');
          const action = await this.connection.rpc<RemoteAction>('remoteExecute', input);
          value = Number(waitMs) > 0 ? await this.connection.rpc('remoteWait', { sessionId: input.sessionId, runId: input.runId, actionId: action.id, timeoutMs: waitMs }) : action;
          break;
        }
        case 'terminal_screen': value = await this.connection.rpc('remoteScreen', args); break;
        case 'terminal_wait': value = await this.connection.rpc('remoteWait', args); break;
        case 'terminal_keys': value = await this.connection.rpc('remoteKeys', args); break;
        case 'terminal_actions': value = await this.connection.rpc('remoteActions', args); break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
  }
}
