import type {AcpEvent} from './acp';

/** Tool updates can be interleaved with text and other parallel tools. */
export function conversationGroups(events:AcpEvent[]):AcpEvent[][]{
  const groups:AcpEvent[][]=[],tools=new Map<string,AcpEvent[]>(),plans=new Map<string,AcpEvent[]>();
  for(const event of events){
    if(event.kind==='tool'&&typeof event.data?.toolCallId==='string'){
      const key=event.turnId+'/'+event.data.toolCallId,existing=tools.get(key);
      if(existing)existing.push(event);else{const group=[event];groups.push(group);tools.set(key,group);}continue;
    }
    if(event.kind==='plan'){const key=event.turnId??event.id,existing=plans.get(key);if(existing)existing.push(event);else{const group=[event];groups.push(group);plans.set(key,group);}continue;}
    const last=groups.at(-1),previous=last?.at(-1);
    if(previous&&previous.turnId===event.turnId&&previous.kind===event.kind&&['assistant','thought'].includes(event.kind)&&!previous.data?.content&&!event.data?.content)last!.push(event);else groups.push([event]);
  }
  return groups;
}
export function toolState(events:AcpEvent[]):Record<string,any>{
  const result:Record<string,any>={};for(const event of events)for(const [key,value]of Object.entries(event.data??{}))if(value!==undefined&&value!==null)result[key]=value;
  return result;
}
export function fileChange(oldText:string|null|undefined,newText:string,limit=400){
  const before=(oldText??'').split('\n'),after=newText.split('\n');let prefix=0,suffix=0;
  while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const lines=[...before.slice(Math.max(0,prefix-3),prefix).map(text=>({kind:'context',text})),...before.slice(prefix,before.length-suffix).map(text=>({kind:'remove',text})),...after.slice(prefix,after.length-suffix).map(text=>({kind:'add',text})),...after.slice(after.length-suffix,after.length-suffix+3).map(text=>({kind:'context',text}))];
  return {lines:lines.slice(0,limit),truncated:lines.length>limit};
}
