import { z } from 'zod';
import { configField } from './extensions';

// Reuse the plugin configuration vocabulary, scoped to one source in one pipeline.
export const pipelineConfigSchema = z.record(z.string().regex(/^[a-zA-Z][\w]*$/).max(100), configField.extend({required:z.boolean().optional()}).strict().refine(field=>!field.enum||field.type==='string'&&field.enum.length>0,'管道配置 enum 仅支持非空字符串选项').refine(field=>field.minimum===undefined||field.maximum===undefined||field.minimum<=field.maximum,'管道配置 minimum 不能大于 maximum')).refine(value=>Object.keys(value).length<=64,'最多支持 64 个管道配置字段');
export const pipelineConfigValuesSchema = z.record(z.string().max(100),z.union([z.string().max(8000),z.number().finite(),z.boolean()])).refine(value=>Object.keys(value).length<=64,'最多支持 64 个管道配置字段');
export type PipelineConfig = z.infer<typeof pipelineConfigValuesSchema>;
export type PipelineConfigSchema = z.infer<typeof pipelineConfigSchema>;
export interface SourcePipelineContext {pipelineId:string;pipelineName:string;config:PipelineConfig}
export const pipelineFilterSchema=z.object({
  includeKeywords:z.array(z.string().trim().min(1).max(200)).max(128).default([]),
  excludeKeywords:z.array(z.string().trim().min(1).max(200)).max(128).default([]),
  mode:z.enum(['any','all']).default('any'),caseSensitive:z.boolean().default(false),
}).strict();
export type PipelineFilter=z.infer<typeof pipelineFilterSchema>;
export function resolvePipelineConfig(schema:PipelineConfigSchema,input:PipelineConfig={}):PipelineConfig {
  const values=pipelineConfigValuesSchema.parse(input),result:PipelineConfig={};
  for(const name of Object.keys(values))if(!Object.hasOwn(schema,name))throw new Error('未知管道配置：'+name);
  for(const [name,field] of Object.entries(schema)){
    const value=Object.hasOwn(values,name)?values[name]:field.default;
    if(value===undefined){if(field.required)throw new Error('请填写管道配置：'+field.title);continue;}
    if(typeof value!==field.type||typeof value==='string'&&(value.length>8000||field.required&&!value.trim())||typeof value==='number'&&(!Number.isFinite(value)||field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum)||field.enum&&!field.enum.includes(String(value)))throw new Error('管道配置无效：'+field.title);
    result[name]=value;
  }
  return result;
}

export const sourceEventSchema=z.object({
  id:z.string().min(1).max(200),threadId:z.string().min(1).max(500),actorId:z.string().min(1).max(200),
  title:z.string().trim().min(1).max(100),text:z.string().trim().min(1).max(16000),
}).strict();
export type SuperagentSourceEvent=z.infer<typeof sourceEventSchema>;
export interface SourceReceipt {accepted:boolean;duplicate:boolean;ticketId?:string;ticketIds?:string[];deliveries?:{pipelineId:string;pipelineName:string;ticketId?:string;filtered?:boolean;error?:string}[];reason?:string}
export interface SourceReply {threadId:string;text:string;idempotencyKey:string}
export const sourceThreadsSchema=z.array(z.object({id:z.string().min(1).max(500),name:z.string().trim().min(1).max(100)}).strict()).max(256);
export interface SourceContribution {
  id:string;name:string;description?:string;
  /** Optional fields rendered and stored separately for each pipeline/source binding. */
  pipelineConfigSchema?:PipelineConfigSchema;
  /** Optional pure routing predicate. false rejects this pipeline only; never create tasks here. */
  match?:(event:SuperagentSourceEvent,context:SourcePipelineContext,signal:AbortSignal)=>Promise<boolean>|boolean;
  /** Optional discovery for a human-readable pipeline scope picker. No task execution. */
  listThreads?:(signal:AbortSignal)=>Promise<{id:string;name:string}[]>;
  /** Required for manual result delivery; must deduplicate idempotencyKey. */
  reply?:(reply:SourceReply,signal:AbortSignal)=>Promise<{receipt:string}>;
}
export interface SourceHandle {emit(event:SuperagentSourceEvent):Promise<SourceReceipt>;health(state:'ready'|'error',detail?:string):void}
export interface SourceService {
  readonly id:string;
  register(owner:string,contribution:SourceContribution,signal:AbortSignal):SourceHandle&{dispose:()=>void};
}
