import { sourceEventSchema, type SourceContribution, type SourceHandle, type SourceReceipt, type SourceReply, type SourceService, type SuperagentSourceEvent } from '../shared/superagent-source';

export class SuperagentSources implements SourceService {
  private entries=new Map<string,{owner:string;contribution:SourceContribution;signal:AbortSignal;state:'ready'|'error';detail?:string;generation:symbol}>();
  constructor(readonly id:string,private ingest:(source:string,event:SuperagentSourceEvent)=>Promise<SourceReceipt>){}
  register(owner:string,contribution:SourceContribution,signal:AbortSignal):SourceHandle&{dispose:()=>void}{
    if(!/^[a-z][a-z0-9.-]{0,63}$/.test(contribution.id)||!contribution.name.trim()||contribution.name.length>100)throw new Error('信息源 ID 或名称无效');
    const key=owner+'/'+contribution.id;if(this.entries.has(key))throw new Error('信息源已注册：'+key);if(this.entries.size>=256)throw new Error('信息源数量已达上限');
    const entry={owner,contribution,signal,state:'ready' as const,generation:Symbol(key)};this.entries.set(key,entry);
    const active=()=>{if(signal.aborted||this.entries.get(key)!==entry)throw new Error('信息源已停用，事件尚未接收');};
    return {emit:event=>{active();return this.ingest(key,sourceEventSchema.parse(event));},health:(state,detail)=>{active();this.entries.set(key,Object.assign(entry,{state,detail:detail?.slice(0,1000)}));},dispose:()=>{if(this.entries.get(key)===entry)this.entries.delete(key);}};
  }
  snapshot(){return [...this.entries].map(([id,entry])=>({id,name:entry.contribution.name,description:entry.contribution.description,owner:entry.owner,state:entry.state,detail:entry.detail,canReply:!!entry.contribution.reply}));}
  has(id:string){return this.entries.has(id)&&!this.entries.get(id)!.signal.aborted;}
  async reply(id:string,reply:SourceReply){
    const entry=this.entries.get(id);if(!entry||entry.signal.aborted||!entry.contribution.reply)throw new Error('来源插件未启用或不提供回传能力');if(!reply.text.trim()||reply.text.length>12000)throw new Error('回传消息须为 1–12000 字');
    const signal=AbortSignal.any([entry.signal,AbortSignal.timeout(30000)]);let abort:()=>void=()=>{};
    try{return await Promise.race([Promise.resolve().then(()=>entry.contribution.reply!(reply,signal)),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('来源已停止或回传超时，发送结果未知'));signal.addEventListener('abort',abort,{once:true});})]);}
    finally{signal.removeEventListener('abort',abort);}
  }
}
