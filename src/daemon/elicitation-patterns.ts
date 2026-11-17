import {Worker} from 'node:worker_threads';
import type {AcpElicitation,ElicitationContent} from '../shared/acp-elicitation';

// Agent-supplied patterns run outside the daemon/UI with a bounded lifetime.
export async function validateElicitationPatterns(request:AcpElicitation,content:ElicitationContent){
  const checks=request.fields.filter(field=>field.pattern&&typeof content[field.key]==='string').map(field=>({pattern:field.pattern,value:content[field.key],title:field.title}));
  if(!checks.length)return;
  await new Promise<void>((resolve,reject)=>{
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');try{for(const item of workerData)if(!new RegExp(item.pattern,'u').test(item.value))throw Error(item.title+'：回答格式不符合要求');parentPort.postMessage({ok:true});}catch(error){parentPort.postMessage({error:String(error)});}`,{eval:true,workerData:checks,resourceLimits:{maxOldGenerationSizeMb:32}});
    let settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve();};
    const timer=setTimeout(()=>finish(new Error('Agent 提问的格式校验超时，请让 Agent 简化约束')),1000);
    worker.once('message',message=>finish(message.ok?undefined:new Error(message.error)));
    worker.once('error',finish);worker.once('exit',code=>{if(!settled)finish(new Error('提问格式校验未完成：'+code));});
  });
}
