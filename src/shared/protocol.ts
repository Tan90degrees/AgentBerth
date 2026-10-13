import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_ACTIVE_TERMINALS = 16;
export const agentSchema = z.enum(['shell', 'codex', 'claude', 'custom']);
export type Agent = z.infer<typeof agentSchema>;
const id = z.uuid();
const title = z.string().trim().min(1).max(100);
const size = { cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) };

export const requestSchema = z.discriminatedUnion('method', [
  z.object({ id, method: z.literal('state'), params: z.object({}).strict() }),
  z.object({ id, method: z.literal('createProject'), params: z.object({ name: title, path: z.string().min(1).max(4096) }).strict() }),
  z.object({ id, method: z.literal('createSession'), params: z.object({ projectId: id, title, agent: agentSchema, command: z.string().max(4096).default('') }).strict() }),
  z.object({ id, method: z.literal('renameSession'), params: z.object({ sessionId: id, title }).strict() }),
  z.object({ id, method: z.literal('archiveSession'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('start'), params: z.object({ sessionId: id, resume: z.boolean().default(false), ...size }).strict() }),
  z.object({ id, method: z.literal('stop'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('attach'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('detach'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('input'), params: z.object({ sessionId: id, runId: id, data: z.string().max(65536) }).strict() }),
  z.object({ id, method: z.literal('resize'), params: z.object({ sessionId: id, runId: id, ...size }).strict() }),
  z.object({ id, method: z.literal('runs'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('output'), params: z.object({ runId: id }).strict() }),
  z.object({ id, method: z.literal('importHistory'), params: z.object({ sessionId: id, path: z.string().min(1).max(4096) }).strict() }),
  z.object({ id, method: z.literal('refreshHistory'), params: z.object({ sessionId: id }).strict() }),
  z.object({ id, method: z.literal('history'), params: z.object({ sessionId: id }).strict() }),
]);
export type Request = z.infer<typeof requestSchema>;
export type Method = Request['method'];
export type RunStatus = 'running' | 'stopping' | 'exited' | 'stopped' | 'failed' | 'interrupted';
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface Run { id: string; sessionId: string; pid: number | null; status: RunStatus; startedAt: string; endedAt: string | null; exitCode: number | null; command: string; error: string | null }
export interface Session { id: string; projectId: string; title: string; agent: Agent; command: string; createdAt: string; updatedAt: string; nativeSessionId: string | null; transcriptPath: string | null; latestRun: Run | null }
export interface State { projects: Project[]; sessions: Session[]; maxActiveTerminals: number; platform: string }
export interface HistoryMessage { role: 'user' | 'assistant'; text: string; timestamp: string | null }
export interface History { messages: HistoryMessage[]; nativeSessionId: string | null; path: string | null; warnings: string[] }
export interface Attachment { run: Run | null; snapshot: string; seq: number; cols: number; rows: number }
export type ServerEvent =
  | { event: 'state'; data: State }
  | { event: 'output'; data: { sessionId: string; runId: string; seq: number; text: string } }
  | { event: 'connection'; data: { connected: boolean; error?: string } };
export interface Response { id: string; result?: unknown; error?: string }
export interface RuntimeInfo { version: number; pid: number; port: number; token: string }
export interface DesktopApi {
  rpc<T = unknown>(method: Method, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (event: ServerEvent) => void): () => void;
  chooseDirectory(): Promise<string | null>;
  chooseTranscript(): Promise<string | null>;
  openProject(path: string): Promise<void>;
  reconnect(): Promise<void>;
}
