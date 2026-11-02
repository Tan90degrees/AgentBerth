import { z } from 'zod';

const line=z.string().max(4096).refine(value=>!/[\r\n\x00]/.test(value),'须为单行文本');
export const acpConfigSchema=z.object({
  executable:line.refine(value=>!!value.trim(),'请填写 ACP 启动程序'),
  args:z.array(line).max(64).default([]),
  env:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),line).default({}),
}).strict();
export type AcpConfig=z.infer<typeof acpConfigSchema>;
export interface AcpEvent {sequence:number;id:string;sessionId:string;turnId:string|null;kind:'user'|'assistant'|'thought'|'tool'|'plan'|'notice'|'error'|'permission'|'turn';text:string;data?:Record<string,unknown>;createdAt:string}
export interface AcpOption {id:string;name:string;type:string;currentValue?:string;options?:{value?:string;name?:string;group?:string;options?:{value:string;name:string}[]}[]}
export interface AcpPermission {id:string;title:string;options:{optionId:string;name:string;kind:string}[];toolCall?:Record<string,unknown>}
export interface AcpSnapshot {
  sessionId:string;nativeSessionId:string|null;phase:'disconnected'|'connecting'|'ready'|'running'|'permission'|'error';
  turnId:string|null;error?:string;agentInfo?:Record<string,unknown>;capabilities?:Record<string,unknown>;
  configOptions?:AcpOption[];modes?:{currentModeId:string;availableModes:{id:string;name:string;description?:string}[]};
  authMethods?:{id:string;name:string;description?:string}[];permissions:AcpPermission[];
  events:AcpEvent[];before:number|null;hasMore:boolean;
}
