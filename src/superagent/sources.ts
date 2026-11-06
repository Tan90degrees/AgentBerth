import {pipelineConfigSchema,resolvePipelineConfig,type PipelineConfig,type SourcePipelineContext, sourceEventSchema,sourceThreadsSchema, type SourceContribution, type SourceHandle, type SourceReceipt, type SourceReply, type SourceService, type SuperagentSourceEvent } from '../shared/superagent-source';

export class SuperagentSources implements SourceService {
  private entries=new Map<string,{owner:string;contribution:SourceContribution;signal:AbortSignal;state:'ready'|'error';detail?:string;generation:symbol}>();
  constructor(readonly id:string,private ingest:(source:string,event:SuperagentSourceEvent)=>Promise<SourceReceipt>){}
  register(owner:string,contribution:SourceContribution,signal:AbortSignal):SourceHandle&{dispose:()=>void}{
    if(!/^[a-z][a-z0-9.-]{0,63}$/.test(contribution.id)||!contribution.name.trim()||contribution.name.length>100)throw new Error('信息源 ID 或名称无效');
    const schema=pipelineConfigSchema.parse(contribution.pipelineConfigSchema??{});
    for(const [name,field] of Object.entries(schema))if(field.default!==undefined)resolvePipelineConfig({[name]:field},{[name]:field.default});
    contribution={...contribution,pipelineConfigSchema:schema};
    const key=owner+'/'+contribution.id;if(this.entries.has(key))throw new Error('信息源已注册：'+key);if(this.entries.size>=256)throw new Error('信息源数量已达上限');
    const disposed=new AbortController();signal=AbortSignal.any([signal,disposed.signal]);
    const entry={owner,contribution,signal,state:'ready' as const,generation:Symbol(key)};this.entries.set(key,entry);
    const active=()=>{if(signal.aborted||this.entries.get(key)!==entry)throw new Error('信息源已停用，事件尚未接收');};
    return {emit:event=>{active();return this.ingest(key,sourceEventSchema.parse(event));},health:(state,detail)=>{active();this.entries.set(key,Object.assign(entry,{state,detail:detail?.slice(0,1000)}));},dispose:()=>{if(this.entries.get(key)===entry){this.entries.delete(key);disposed.abort();}}};
  }
  snapshot(){return [...this.entries].map(([id,entry])=>({id,name:entry.contribution.name,description:entry.contribution.description,owner:entry.owner,state:entry.state,detail:entry.detail,pipelineConfigSchema:entry.contribution.pipelineConfigSchema,canReply:!!entry.contribution.reply,canListThreads:!!entry.contribution.listThreads}));}
  has(id:string){return this.entries.has(id)&&!this.entries.get(id)!.signal.aborted;}
  resolveConfig(id:string,input:PipelineConfig={}){
    const entry=this.entries.get(id);if(!entry||entry.signal.aborted)throw new Error('来源插件未启用');
    return resolvePipelineConfig(entry.contribution.pipelineConfigSchema??{},input);
  }
  async matches(id:string,event:SuperagentSourceEvent,context:SourcePipelineContext){
    const entry=this.entries.get(id);if(!entry||entry.signal.aborted)throw new Error('来源插件未启用');
    const config=this.resolveConfig(id,context.config);if(!entry.contribution.match)return true;
    const signal=AbortSignal.any([entry.signal,AbortSignal.timeout(10000)]);let abort=()=>{};
    try{
      const result=await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw new Error('来源已停止');return entry.contribution.match!(structuredClone(event),structuredClone({...context,config}),signal);}),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('来源已停止或管道匹配超时'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);
      if(signal.aborted||this.entries.get(id)!==entry)throw new Error('来源已停止，管道匹配尚未完成');
      if(typeof result!=='boolean')throw new Error('信息源 match 必须返回 boolean');return result;
    }finally{signal.removeEventListener('abort',abort);}
  }
  async listThreads(id:string){
    const entry=this.entries.get(id);if(!entry||entry.signal.aborted)throw new Error('来源插件未启用');if(!entry.contribution.listThreads)return {available:false,threads:[]};
    const signal=AbortSignal.any([entry.signal,AbortSignal.timeout(10000)]);let abort:()=>void=()=>{};
    try{const values=await Promise.race([Promise.resolve().then(()=>entry.contribution.listThreads!(signal)),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('来源已停止或读取会话列表超时'));signal.addEventListener('abort',abort,{once:true});})]);const unique=new Map(sourceThreadsSchema.parse(values).map(item=>[item.id,item]));return {available:true,threads:[...unique.values()]};}finally{signal.removeEventListener('abort',abort);}
  }
  async reply(id:string,reply:SourceReply){
    const entry=this.entries.get(id);if(!entry||entry.signal.aborted||!entry.contribution.reply)throw new Error('来源插件未启用或不提供回传能力');if(!reply.text.trim()||reply.text.length>12000)throw new Error('回传消息须为 1–12000 字');
    const signal=AbortSignal.any([entry.signal,AbortSignal.timeout(30000)]);let abort:()=>void=()=>{};
    try{return await Promise.race([Promise.resolve().then(()=>entry.contribution.reply!(reply,signal)),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('来源已停止或回传超时，发送结果未知'));signal.addEventListener('abort',abort,{once:true});})]);}
    finally{signal.removeEventListener('abort',abort);}
  }
}
