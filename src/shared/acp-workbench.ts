import { z } from 'zod';

export const ACP_WORKBENCH_API_VERSION = 68;
export const ACP_STREAM_API_VERSION = 69;
export const ACP_MEDIA_LIMIT = 2 * 1024 * 1024;
const uuid = z.string().uuid();
const relativePath = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f]/.test(value));

export const acpAttachmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: relativePath, text: z.string().min(1).max(4000).optional(), embed: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('image'), id: uuid, name: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('audio'), id: uuid, name: z.string().min(1).max(200) }).strict(),
]);
export type AcpAttachment = z.infer<typeof acpAttachmentSchema>;

export const acpMessageSchema = z.object({
  requestId: uuid,
  text: z.string().trim().max(40000),
  attachments: z.array(acpAttachmentSchema).max(8).optional(),
}).strict().refine(value => !!value.text || !!value.attachments?.length, '请填写消息或添加附件')
  // Validate the encoded size before Electron forwards it to the daemon.
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 124 * 1024, '消息与引用片段合计过长，请减少片段或分条发送');
export type AcpMessage = z.infer<typeof acpMessageSchema>;

export const acpImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const acpAudioTypes = ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'] as const;
export const acpMediaTypes = [...acpImageTypes, ...acpAudioTypes] as const;
export const acpImageChunkSchema = z.object({
  sessionId: uuid, imageId: uuid, mimeType: z.enum(acpMediaTypes),
  offset: z.number().int().min(0).max(ACP_MEDIA_LIMIT),
  data: z.string().min(4).max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  last: z.boolean(),
}).strict();

const header = z.object({ name: z.string().min(1).max(100).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/), value: z.string().max(4096).refine(value => !/[\r\n\0]/.test(value)) }).strict();
export const acpMcpServerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), name: z.string().trim().min(1).max(80), command: z.string().trim().min(1).max(512).refine(value => !/[\r\n\0]/.test(value)), args: z.array(z.string().max(1024).refine(value => !/[\r\n\0]/.test(value))).max(24).default([]), env: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(4096).refine(value => !/[\r\n\0]/.test(value)) }).strict()).max(8).default([]) }).strict(),
  z.object({ type: z.enum(['http','sse']), name: z.string().trim().min(1).max(80), url: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)); }
    catch { return false; }
  }, '外部 MCP 服务需使用 HTTPS'), headers: z.array(header).max(8).default([]) }).strict(),
]);
export const acpMcpServersSchema = z.array(acpMcpServerSchema).max(8).refine(servers => JSON.stringify(servers).length<=16000, 'MCP 配置过长').refine(servers => new Set(servers.map(server => server.name)).size === servers.length, 'MCP 服务名称重复');
export type AcpMcpServer = z.infer<typeof acpMcpServerSchema>;

export interface AcpUsage { used: number; size: number; cost?: { amount: number; currency: string } }
export interface AcpHistoryEntry {
  sessionId: string; projectId: string; title: string; agentId: string; worktreePath: string | null;
  nativeSessionId: string | null; phase: string; resumable: boolean; archived: boolean; updatedAt?: string;
}
export interface AcpNativeSession { sessionId: string; title: string; cwd: string; updatedAt?: string }

export function acpCapability(capabilities: Record<string,unknown>|undefined, group: string, name: string): boolean {
  const value = (capabilities?.[group] as Record<string,unknown>|undefined)?.[name];
  return value === true || !!value && typeof value === 'object' && !Array.isArray(value);
}
