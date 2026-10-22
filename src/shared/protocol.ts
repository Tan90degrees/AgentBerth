import { z } from 'zod';
import type { AppearanceMode } from './appearance';

export const PROTOCOL_VERSION = 1;
export const API_VERSION = 22;
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
  plugin: z.object({ executable: singleLine.refine(value => !!value.trim(), '请填写插件程序'), args: z.array(singleLine).max(32).default([]), history: z.boolean(), resume: z.boolean(), list: z.boolean().optional(), runtime: z.enum(['node', 'executable']).optional(), sourceId: z.string().max(100).optional() }).strict().nullable().default(null),
}).strict();
export type AgentDefinitionConfig = z.infer<typeof agentDefinitionSchema>;
export interface AgentDefinition extends AgentDefinitionConfig { id: string }
export const isCustomAgent = (agent: string) => agent === 'custom' || agent.startsWith('agent:');
const size = { cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) };
export const sshConnectionSchema = z.object({
  alias: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/, '别名只能包含字母、数字、点、横线和下划线'),
  hostname: z.string().trim().min(1).max(254).refine(value => !/[\s\x00-\x1f]/.test(value), '请输入主机名或 IP'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(256).refine(value => !/[\x00-\x1f]/.test(value)),
  authentication: z.enum(['password', 'key', 'agent']),
  privateKeyPath: singleLine.default(''),
  allowAgent: z.boolean().default(true),
}).strict().refine(value => value.authentication !== 'key' || !!value.privateKeyPath.trim(), '请选择私钥文件');
export type SshConnectionConfig = z.infer<typeof sshConnectionSchema>;
export interface SshConnection extends SshConnectionConfig { id: string }
export const sshSecretSchema = z.object({ password: z.string().max(16384).optional(), passphrase: z.string().max(16384).optional() }).strict();
export type SshSecret = z.infer<typeof sshSecretSchema>;
export interface SshChallenge { id: string; connectionId: string; alias: string; kind: 'credentials' | 'hostKey'; fingerprint?: string; hostname?: string; port?: number }
export const remoteSchema = z.object({
  connectionId: z.uuid().optional(),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/, '请选择 SSH 主机别名'),
  directory: z.string().max(4096).refine(value => (!value || value.startsWith('/')) && !/[\r\n\x00]/.test(value), '请填写远端绝对目录或留空使用登录目录').default(''),
}).strict();
export type RemoteConfig = z.infer<typeof remoteSchema>;
const remoteTarget = { sessionId: id, runId: id };
export const remoteKeySchema = z.enum(['Enter', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Ctrl+C', 'Ctrl+D', 'Ctrl+Z', 'Backspace']);
export type RemoteKey = z.infer<typeof remoteKeySchema>;
const sessionConfig = { title, agent: agentSchema, command: singleLine.default(''), terminal: terminalSchema.nullable().default(null), remote: remoteSchema.nullable().default(null) };
export const nativeSessionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const historyQuerySchema = z.object({ cursor: z.string().max(2048).nullable().default(null), limit: z.number().int().min(1).max(50).default(10), query: z.string().trim().max(100).default('') }).strict();
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export const gitOperationSchema = z.object({
  projectId: id, action: z.enum(['fetch', 'pull', 'push', 'sync', 'switch', 'switchRemote', 'stage', 'unstage', 'commit']),
  expected: z.object({ root: z.string().min(1).max(4096), branch: z.string().max(1024).nullable(), head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable() }).strict(),
  remote: z.string().min(1).max(256).optional(), branch: z.string().min(1).max(1024).optional(),
  remoteRef: z.string().min(1).max(2048).optional(), remoteHead: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), localBranch: z.string().min(1).max(1024).optional(),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(500).optional(),
  message: z.string().trim().min(1).max(8000).optional(),
}).strict();
export type GitOperation = z.infer<typeof gitOperationSchema>;
export const gitDiffSchema = z.object({ projectId: id, path: z.string().min(1).max(4096), staged: z.boolean().default(false), projectPath: z.boolean().default(false) }).strict();
export type GitDiffRequest = z.infer<typeof gitDiffSchema>;

export const requestSchema = z.discriminatedUnion('method', [
  z.object({ id, method: z.literal('sshConnections'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('saveSshConnection'), params: z.object({ connectionId: id.optional(), config: sshConnectionSchema }).strict() }),
  z.object({ id, method: z.literal('deleteSshConnection'), params: z.object({ connectionId: id }).strict() }),
  z.object({ id, method: z.literal('registerSshProvider'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('sshChallengeReply'), params: z.object({ challengeId: id, secret: sshSecretSchema.optional(), accepted: z.boolean().optional() }).strict() }),
  z.object({ id, method: z.literal('remoteAliases'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('remoteOpen'), params: z.object({ alias: z.string().min(1).max(100) }).strict() }),
  z.object({ id, method: z.literal('remoteResolve'), params: z.object({ alias: z.string().min(1).max(100) }).strict() }),
  z.object({ id, method: z.literal('sshHosts'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('remoteInfo'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('remoteActions'), params: z.object({ sessionId: id, before: z.number().int().positive().optional() }).strict() }),
  z.object({ id, method: z.literal('remoteControl'), params: z.object({ ...remoteTarget, owner: z.enum(['user', 'agent']) }).strict() }),
  z.object({ id, method: z.literal('remoteReconnect'), params: z.object(remoteTarget).strict() }),
  z.object({ id, method: z.literal('remoteExecute'), params: z.object({ ...remoteTarget, command: singleLine.refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value)), requestId: id, atPrompt: z.boolean().default(false) }).strict() }),
  z.object({ id, method: z.literal('remoteKeys'), params: z.object({ ...remoteTarget, text: z.string().max(16384).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(), key: remoteKeySchema.optional() }).strict().refine(value => (value.text !== undefined) !== (value.key !== undefined), '请选择文本或按键') }),
  z.object({ id, method: z.literal('remoteWait'), params: z.object({ ...remoteTarget, actionId: id, timeoutMs: z.number().int().min(0).max(30000).default(25000) }).strict() }),
  z.object({ id, method: z.literal('remoteScreen'), params: z.object(remoteTarget).strict() }),
  z.object({ id, method: z.literal('state'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('resources'), params: z.object({ appPids: z.array(z.number().int().positive()).max(128).default([]) }).strict() }),
  z.object({ id, method: z.literal('gitStatus'), params: z.object({ projectId: id }).strict() }),
  z.object({ id, method: z.literal('gitOperation'), params: gitOperationSchema }),
  z.object({ id, method: z.literal('gitDiff'), params: gitDiffSchema }),
  z.object({ id, method: z.literal('projectFiles'), params: z.object({ projectId: id, path: z.string().max(4096).default(''), offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(300).default(200) }).strict() }),
  z.object({ id, method: z.literal('findProjectFiles'), params: z.object({ projectId: id, query: z.string().trim().min(1).max(4096) }).strict() }),
  z.object({ id, method: z.literal('previewFile'), params: z.object({ projectId: id, path: z.string().min(1).max(4096) }).strict() }),
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
  z.object({ id, method: z.literal('linkNativeSession'), params: z.object({ sessionId: id, nativeSessionId: nativeSessionIdSchema }).strict() }),
  z.object({ id, method: z.literal('unlinkNativeSession'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('nativeHistories'), params: historyQuerySchema.extend({ sessionId: id }) }),
  z.object({ id, method: z.literal('discoverNativeHistories'), params: historyQuerySchema.extend({ sessionId: id }) }),
  z.object({ id, method: z.literal('nativeHistory'), params: z.object({ sessionId: id, nativeSessionId: nativeSessionIdSchema, refresh: z.boolean().default(false) }).strict() }),
  z.object({ id, method: z.literal('renameSession'), params: z.object({ sessionId: id, title }).strict() }),
  z.object({ id, method: z.literal('archiveSession'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('start'), params: z.object({ sessionId: id, resume: z.boolean().default(false), ...size }).strict() }),
  z.object({ id, method: z.literal('stop'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('attach'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('detach'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('input'), params: z.object({ sessionId: id, runId: id, data: z.string().max(65536), binary: z.boolean().optional() }).strict() }),
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
export interface ProjectFile { name: string; path: string; kind: 'directory' | 'file' | 'other'; ignored: boolean; symlink: boolean; unavailable?: boolean }
export interface ProjectFilePage { path: string; entries: ProjectFile[]; nextOffset: number | null; total: number; truncated: boolean; gitAvailable: boolean; warning?: string }
export interface FilePreview { path: string; name: string; size: number; modifiedAt: string; kind: 'text' | 'image' | 'binary'; content: string | null; truncated: boolean; encoding?: string; mime?: string; message?: string }
export interface ResourceUsage {cpuPercent:number|null;memoryBytes:number|null;processCount:number;partial:boolean}
export interface ResourceSnapshot {sampledAt:string;cpuCount:number;sessions:Record<string,ResourceUsage&{runId:string}>;projects:Record<string,ResourceUsage>;workspace:ResourceUsage;desktopIncluded:boolean;error?:string}
export interface GitFile { path: string; originalPath?: string; index: string; worktree: string; conflict: boolean }
export interface GitRemoteBranch { ref: string; remote: string; branch: string; head: string; localBranches: string[] }
export interface GitStatus {
  kind: 'repository' | 'not-repository' | 'unavailable'; message?: string; busy: boolean;
  root: string; commonDirectory: string; branch: string | null; head: string | null; upstream: string | null;
  upstreamRemote: string | null; upstreamBranch: string | null; ahead: number; behind: number;
  staged: number; modified: number; untracked: number; conflicts: number; total: number; files: GitFile[];
  remoteBranches?: GitRemoteBranch[]; remoteBranchesTruncated?: boolean;
  branches: string[]; remotes: string[]; operation: string | null; fetchedAt: string | null;
}
export interface GitResult { status: GitStatus; message: string; output: string }
export interface GitDiff { path: string; staged: boolean; patch: string; binary: boolean; truncated: boolean; message?: string }
export interface Run { id: string; sessionId: string; pid: number | null; status: RunStatus; startedAt: string; endedAt: string | null; exitCode: number | null; command: string; shell: string; error: string | null; recordOutput?: number }
export interface Session { remote?: RemoteConfig | null; id: string; projectId: string; title: string; agent: Agent; command: string; terminal: TerminalConfig | null; createdAt: string; updatedAt: string; nativeSessionId: string | null; transcriptPath: string | null; latestRun: Run | null }
export interface WindowsPty { backend: 'conpty' | 'winpty'; buildNumber: number }
export interface State { projects: Project[]; sessions: Session[]; agents?: AgentDefinition[]; maxActiveTerminals: number; platform: string; windowsPty?: WindowsPty; settings: Settings; apiVersion: number }
export interface HistoryMessage { role: 'user' | 'assistant'; text: string; timestamp: string | null }
export interface History { messages: HistoryMessage[]; nativeSessionId: string | null; path: string | null; warnings: string[] }
export interface NativeHistoryItem { nativeSessionId: string; title: string; updatedAt: string | null; path: string | null }
export interface NativeHistoryPage { items: NativeHistoryItem[]; nextCursor: string | null; total?: number; warnings: string[] }
export interface Attachment { run: Run | null; snapshot: string; seq: number; cols: number; rows: number }
export type TerminalEvent =
  | { event: 'output'; data: { sessionId: string; runId: string; seq: number; text: string } }
  | { event: 'resize'; data: { sessionId: string; runId: string; seq: number; cols: number; rows: number } };
export interface RemoteInfo { commandTracking?: 'posix' | 'none'; sessionId: string; runId: string; host: string; connection: 'connecting' | 'connected' | 'disconnected'; owner: 'user' | 'agent'; phase: 'unknown' | 'idle' | 'busy'; cwd: string | null; error: string | null }
export interface RemoteAction { sequence: number; id: string; sessionId: string; runId: string; kind: 'command' | 'input' | 'control' | 'connection'; label: string; status: 'running' | 'completed' | 'unknown'; startedAt: string; endedAt: string | null; exitCode: number | null }
export type ServerEvent =
  | { event: 'sshChallenge'; data: SshChallenge }
  | { event: 'remote'; data: RemoteInfo }
  | { event: 'remoteAction'; data: RemoteAction }
  | { event: 'state'; data: State }
  | TerminalEvent
  | { event: 'connection'; data: { connected: boolean; error?: string } };
export interface Response { id: string; result?: unknown; error?: string }
export interface RuntimeInfo { version: number; pid: number; port: number; token: string }
export interface AppInfo { version: string; platform: string; arch: string; osRelease: string; electron: string; node: string; packaged: boolean }
export interface DesktopApi {
  saveSshConnection(config: SshConnectionConfig, connectionId?: string, secret?: SshSecret, remember?: boolean): Promise<SshConnection>;
  deleteSshConnection(connectionId: string): Promise<void>;
  chooseSshKey(): Promise<string | null>;
  appInfo(): Promise<AppInfo>;
  mcpConfig(): Promise<string>;
  setAppearance(mode: AppearanceMode): Promise<void>;
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
