import { z } from 'zod';

export const sourceEventSchema=z.object({
  id:z.string().min(1).max(200),threadId:z.string().min(1).max(500),actorId:z.string().min(1).max(200),
  title:z.string().trim().min(1).max(100),text:z.string().trim().min(1).max(16000),
}).strict();
export type SuperagentSourceEvent=z.infer<typeof sourceEventSchema>;
export interface SourceReceipt {accepted:boolean;duplicate:boolean;ticketId?:string;ticketIds?:string[];deliveries?:{pipelineId:string;pipelineName:string;ticketId?:string;error?:string}[];reason?:string}
export interface SourceReply {threadId:string;text:string;idempotencyKey:string}
export const sourceThreadsSchema=z.array(z.object({id:z.string().min(1).max(500),name:z.string().trim().min(1).max(100)}).strict()).max(256);
export interface SourceContribution {
  id:string;name:string;description?:string;
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
