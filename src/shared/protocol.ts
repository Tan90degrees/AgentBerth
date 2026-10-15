import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const API_VERSION = 10;
export const MAX_ACTIVE_TERMINALS = 16;
export const builtinAgentSchema = z.enum(['shell', 'codex', 'claude', 'opencode', 'custom']);
export const agentSchema = z.union([builtinAgentSchema, z.string().regex(/^agent:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)]);
export type Agent = z.infer<typeof agentSchema>;
export const terminalProfileSchema = z.enum(['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'custom']);
const singleLine = z.string().max(4096).refine(value => !/[\r\n\x00]/.test(value), '须为单行文本');
export const terminalSchema = z.object({
  profile: terminalProfileSchema,
  executable: singleLine.default(''),
  args: z.array(singleLine).max(32).default([]),
}).strict();
export type TerminalConfig = z.infer<typeof terminalSchema>;
export const settingsSchema = z.object({
  terminal: terminalSchema,
  defaultAgent: agentSchema,
  defaultCommand: singleLine.default(''),
  fontSize: z.number().int().min(10).max(24),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = { terminal: { profile: 'auto', executable: '', args: [] }, defaultAgent: 'codex', defaultCommand: '', fontSize: 14 };
const id = z.uuid();
const title = z.string().trim().min(1).max(100);
export const agentDefinitionSchema = z.object({
  name: title,
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/).optional(),
  command: singleLine.refine(value => !!value.trim(), '请填写启动命令'),
  resumeCommand: singleLine.default('').transform(value => value.trim()).refine(value => !value.trim() || (value.includes('{sessionId}') && !/\{(?!sessionId\})/.test(value)), '恢复命令须包含 {sessionId}，且只支持此占位符'),
  plugin: z.object({ executable: singleLine.refine(value => !!value.trim(), '请填写插件程序'), args: z.array(singleLine).max(32).default([]), history: z.boolean(), resume: z.boolean(), runtime: z.enum(['node', 'executable']).optional(), sourceId: z.string().max(100).optional() }).strict().nullable().default(null),
}).strict();
export type AgentDefinitionConfig = z.infer<typeof agentDefinitionSchema>;
export interface AgentDefinition extends AgentDefinitionConfig { id: string }
export const isCustomAgent = (agent: string) => agent === 'custom' || agent.startsWith('agent:');
const size = { cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) };
const sessionConfig = { title, agent: agentSchema, command: singleLine.default(''), terminal: terminalSchema.nullable().default(null) };

export const requestSchema = z.discriminatedUnion('method', [
  z.object({ id, method: z.literal('state'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('createProject'), params: z.object({ name: title, path: z.string().min(1).max(4096) }).strict() }),
  z.object({ id, method: z.literal('updateProject'), params: z.object({ projectId: id, name: title, path: z.string().min(1).max(4096) }).strict() }),
  z.object({ id, method: z.literal('deleteProject'), params: z.object({ projectId: id }).strict() }),
  z.object({ id, method: z.literal('createSession'), params: z.object({ projectId: id, ...sessionConfig }).strict() }),
  z.object({ id, method: z.literal('updateSession'), params: z.object({ sessionId: id, ...sessionConfig }).strict() }),
  z.object({ id, method: z.literal('deleteSession'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('saveSettings'), params: settingsSchema }),
  z.object({ id, method: z.literal('createAgent'), params: agentDefinitionSchema }),
  z.object({ id, method: z.literal('updateAgent'), params: agentDefinitionSchema.extend({ agentId: agentSchema }) }),
  z.object({ id, method: z.literal('deleteAgent'), params: z.object({ agentId: agentSchema }).strict() }),
  z.object({ id, method: z.literal('probeAgentPlugin'), params: agentDefinitionSchema }),
  z.object({ id, method: z.literal('checkAgentPlugin'), params: z.object({ agentId: agentSchema }).strict() }),
  z.object({ id, method: z.literal('shutdownIdle'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('shutdown'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('linkNativeSession'), params: z.object({ sessionId: id, nativeSessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).strict() }),
  z.object({ id, method: z.literal('renameSession'), params: z.object({ sessionId: id, title }).strict() }),
  z.object({ id, method: z.literal('archiveSession'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('start'), params: z.object({ sessionId: id, resume: z.boolean().default(false), ...size }).strict() }),
  z.object({ id, method: z.literal('stop'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('attach'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('detach'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('input'), params: z.object({ sessionId: id, runId: id, data: z.string().max(65536) }).strict() }),
  z.object({ id, method: z.literal('resize'), params: z.object({ sessionId: id, runId: id, ...size }).strict() }),
  z.object({ id, method: z.literal('runs'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('deleteRun'), params: z.object({ runId: id }).strict() }),
  z.object({ id, method: z.literal('clearFinishedRuns'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('output'), params: z.object({ runId: id }).strict() }),
  z.object({ id, method: z.literal('importHistory'), params: z.object({ sessionId: id, path: z.string().min(1).max(4096) }).strict() }),
  z.object({ id, method: z.literal('refreshHistory'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('history'), params: z.object({ sessionId: id }).strict() }),
]);
export type Request = z.infer<typeof requestSchema>;
export type Method = Request['method'];
export type RunStatus = 'running' | 'stopping' | 'exited' | 'stopped' | 'failed' | 'interrupted';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Run { id: string; sessionId: string; pid: number | null; status: RunStatus; startedAt: string; endedAt: string | null; exitCode: number | null; command: string; shell: string; error: string | null; recordOutput?: number }
export interface Session { id: string; projectId: string; title: string; agent: Agent; command: string; terminal: TerminalConfig | null; createdAt: string; updatedAt: string; nativeSessionId: string | null; transcriptPath: string | null; latestRun: Run | null }
export interface WindowsPty { backend: 'conpty' | 'winpty'; buildNumber: number }
export interface State { projects: Project[]; sessions: Session[]; agents?: AgentDefinition[]; maxActiveTerminals: number; platform: string; windowsPty?: WindowsPty; settings: Settings; apiVersion: number }
export interface HistoryMessage { role: 'user' | 'assistant'; text: string; timestamp: string | null }
export interface History { messages: HistoryMessage[]; nativeSessionId: string | null; path: string | null; warnings: string[] }
export interface Attachment { run: Run | null; snapshot: string; seq: number; cols: number; rows: number }
export type TerminalEvent =
  | { event: 'output'; data: { sessionId: string; runId: string; seq: number; text: string } }
  | { event: 'resize'; data: { sessionId: string; runId: string; seq: number; cols: number; rows: number } };
export type ServerEvent =
  | { event: 'state'; data: State }
  | TerminalEvent
  | { event: 'connection'; data: { connected: boolean; error?: string } };
export interface Response { id: string; result?: unknown; error?: string }
export interface RuntimeInfo { version: number; pid: number; port: number; token: string }
export interface AppInfo { version: string; platform: string; arch: string; osRelease: string; electron: string; node: string; packaged: boolean }
export interface DesktopApi {
  appInfo(): Promise<AppInfo>;
  openDataDirectory(): Promise<void>;
  rpc<T = unknown>(method: Method, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (event: ServerEvent) => void): () => void;
  chooseDirectory(): Promise<string | null>;
  chooseTranscript(): Promise<string | null>;
  chooseExecutable(): Promise<string | null>;
  importAgentPlugin(): Promise<AgentDefinitionConfig | null>;
  exportPluginKit(): Promise<string | null>;
  pluginDevelopmentPrompt(folder?: string): Promise<string>;
  copyText(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  openExternal(url: string): Promise<void>;
  openProject(path: string): Promise<void>;
  reconnect(): Promise<void>;
  restartBackend(): Promise<void>;
}
