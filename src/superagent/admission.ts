import type {DatabaseSync} from 'node:sqlite';
import type {SourceReceipt,SuperagentSourceEvent} from '../shared/superagent-source';
import type {pipelineStore,SourcePipeline} from './pipelines';
interface Envelope {source:string;eventId:string;threadId:string;actorId:string;at:string;event?:SuperagentSourceEvent;routes?:SourcePipeline[];receipt:SourceReceipt}
export const receiptView=({event,routes,...value}:Envelope)=>value;
/** Freeze subscribers before asynchronous admission. Each delivery has its own durable trigger. */
export function sourceAdmission(db:DatabaseSync,pipelines:ReturnType<typeof pipelineStore>,create:(policy:SourcePipeline,source:string,event:SuperagentSourceEvent)=>Promise<{id:string;duplicate:boolean}>,alive:()=>boolean){
  const pending=new Map<string,Promise<SourceReceipt>>();
  const read=(source:string,eventId:string):Envelope|undefined=>{const row=db.prepare('SELECT value FROM source_events WHERE source=? AND eventId=?').get(source,eventId);return row?JSON.parse(String(row.value)):undefined;};
  const save=(value:Envelope)=>{if(!alive())throw new Error('插件已停止，请使用原事件 ID 确认结果');db.prepare('INSERT INTO source_events VALUES (?,?,?) ON CONFLICT(source,eventId) DO UPDATE SET value=excluded.value').run(value.source,value.eventId,JSON.stringify(value));};
  async function deliver(source:string,event:SuperagentSourceEvent){
    if(!alive())throw new Error('Superagent 已停止，事件尚未接收');
    let envelope=read(source,event.id),duplicate=!!envelope;
    if(envelope&&!envelope.event)return {...envelope.receipt,duplicate:true};
    if(!envelope){const match=pipelines.match(source,event);envelope={source,eventId:event.id,threadId:event.threadId,actorId:event.actorId,at:new Date().toISOString(),event,routes:match.pipelines,receipt:{accepted:false,duplicate:false,deliveries:[],reason:match.reason}};save(envelope);}
    const deliveries=envelope.receipt.deliveries??[];
    for(const frozen of envelope.routes??[]){
      if(deliveries.some(item=>item.pipelineId===frozen.id&&item.ticketId))continue;
      const delivery={pipelineId:frozen.id,pipelineName:frozen.name} as NonNullable<SourceReceipt['deliveries']>[number];
      try{
        const current=pipelines.get(frozen.id);if(!current)throw new Error('管道已删除');
        if(!current.enabled)throw new Error('管道已停用');
        if(current.projectId!==frozen.projectId)throw new Error('管道项目已更换；请恢复原项目后重试');
        // Keep admission scope frozen, but allow repairing credentials / agent settings before retry.
        const task=await create({...current,projectId:frozen.projectId,autoApprove:frozen.autoApprove&&current.autoApprove},source,envelope.event!);delivery.ticketId=task.id;
      }catch(error){delivery.error=String(error).slice(0,500);}
      const index=deliveries.findIndex(item=>item.pipelineId===frozen.id);if(index<0)deliveries.push(delivery);else deliveries[index]=delivery;
      const ticketIds=deliveries.flatMap(item=>item.ticketId?[item.ticketId]:[]);envelope.receipt={accepted:ticketIds.length>0,duplicate,ticketId:ticketIds[0],ticketIds,deliveries,reason:deliveries.some(item=>item.error)?'delivery_failed':undefined};save(envelope);
    }
    if(deliveries.some(item=>item.error))throw new Error('部分管道接收失败；请修复接收记录中的错误，并使用原事件 ID 重试。已接收任务不会重复创建');
    delete envelope.event;delete envelope.routes;envelope.receipt.duplicate=duplicate;save(envelope);return envelope.receipt;
  }
  const emit=(source:string,event:SuperagentSourceEvent)=>{const key=JSON.stringify([source,event.id]),active=pending.get(key);if(active)return active.then(receipt=>({...receipt,duplicate:true}));const task=deliver(source,event).finally(()=>pending.delete(key));pending.set(key,task);return task;};
  return {emit,retry:(source:string,eventId:string)=>{const value=read(source,eventId);if(!value)throw new Error('接收记录不存在');return value.event?emit(source,value.event):Promise.resolve({...value.receipt,duplicate:true});}};
}
