import { z } from 'zod';
import { acpMcpServersSchema, type AcpMessage, type AcpUsage } from './acp-workbench';

const line=z.string().max(4096).refine(value=>!/[\r\n\x00]/.test(value),'须为单行文本');
export const ACP_STARTUP_TIMEOUT_MS=180000;
export const ACP_MAX_STARTUP_TIMEOUT_MS=600000;
export const acpConfigSchema=z.object({
  executable:line.refine(value=>!!value.trim(),'请填写 ACP 启动程序'),
  startupTimeoutMs:z.number().int().min(5000).max(ACP_MAX_STARTUP_TIMEOUT_MS).optional(),
  args:z.array(line).max(64).default([]),
  mcpServers:acpMcpServersSchema.optional(),
  additionalDirectories:z.array(line).max(16).optional(),
  systemPrompt:z.object({mode:z.enum(['append','override']),text:z.string().trim().min(1).max(12000)}).strict().optional(),
  registryId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/).optional(),
  registryVersion:z.string().max(80).optional(),
  env:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),line).default({}),
}).strict();
export type AcpConfig=z.infer<typeof acpConfigSchema>;
export interface AcpEvent {sequence:number;id:string;sessionId:string;turnId:string|null;kind:'user'|'assistant'|'thought'|'tool'|'plan'|'notice'|'error'|'permission'|'elicitation'|'turn'|'terminal'|'subagent'|'session-message'|'compaction';text:string;data?:Record<string,unknown>;createdAt:string}
export interface AcpOption {id:string;name:string;type:string;category?:string;currentValue?:string|boolean;options?:{value?:string;name?:string;group?:string;options?:{value:string;name:string}[]}[]}
export interface AcpPermission {id:string;childSessionId?:string;title:string;options:{optionId:string;name:string;kind:string}[];toolCall?:Record<string,unknown>}
export interface AcpNotice {severity:string;title:string;description?:string}
export interface AcpSessionInfo {title?:string|null;updatedAt?:string|null}
export interface AcpSnapshot {
  sessionId:string;nativeSessionId:string|null;phase:'disconnected'|'connecting'|'ready'|'running'|'permission'|'error';
  turnId:string|null;error?:string;agentInfo?:Record<string,unknown>;capabilities?:Record<string,unknown>;
  workspaceFileText?:true;
  configOptions?:AcpOption[];modes?:{currentModeId:string;availableModes:{id:string;name:string;description?:string}[]};
  authMethods?:{id:string;name:string;description?:string;type?:'terminal';args?:string[];env?:Record<string,string>}[];authTerminalId?:string;permissions:AcpPermission[];elicitations?:import('./acp-elicitation').AcpElicitation[];
  availableCommands?:{name:string;description:string;input?:{hint:string}}[];
  sessionInfo?:AcpSessionInfo; canLogout?:boolean; urlInteractions?:{id:string;hostname:string}[];
  usage?:AcpUsage; queue?:AcpMessage[]; queuePaused?:boolean;
  lastTurnStatus?:'completed'|'cancelled'|'interrupted';
  events:AcpEvent[];before:number|null;hasMore:boolean;
}
export function acpModelOption(options?:AcpOption[]){return options?.find(option=>option.category==='model')??options?.find(option=>option.id==='model');}
export interface AcpModels {choices:{value:string;name:string}[];currentValue?:string;configId?:string}
export interface AcpTerminal {terminalId:string;output:string;truncated:boolean;released?:boolean;exitStatus?:{exitCode?:number;signal?:string}}

/** ACP select options may contain named groups. Use actual declared values. */
export function acpOptionChoices(option:AcpOption):{value:string;name:string}[]{
  return (option.options??[]).flatMap(item=>item.options??(item.value!==undefined?[{value:item.value,name:item.name??item.value}]:[]));
}
