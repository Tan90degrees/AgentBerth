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
export function toolCommand(input:unknown):string|null{
  if(typeof input==='string')return input;
  if(!input||typeof input!=='object')return null;
  const value=input as Record<string,unknown>;
  const command=typeof value.command==='string'?value.command:typeof value.cmd==='string'?value.cmd:null;
  if(!command)return null;
  return command+(Array.isArray(value.args)?' '+value.args.map(arg=>typeof arg==='string'&&!/^[\w./:=+-]+$/.test(arg)?JSON.stringify(arg):String(arg)).join(' '):'');
}
export function fileChange(oldText:string|null|undefined,newText:string,limit=400){
  const split=(text:string)=>text?text.replace(/\n$/,'').split('\n'):[];
  const before=split(oldText??''),after=split(newText);let prefix=0,suffix=0;
  while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const context=(oldIndex:number,newIndex:number)=>({kind:'context',text:before[oldIndex],oldLine:oldIndex+1,newLine:newIndex+1});
  const lines=[...before.slice(Math.max(0,prefix-3),prefix).map((_,index)=>context(Math.max(0,prefix-3)+index,Math.max(0,prefix-3)+index)),...before.slice(prefix,before.length-suffix).map((text,index)=>({kind:'remove',text,oldLine:prefix+index+1,newLine:null})),...after.slice(prefix,after.length-suffix).map((text,index)=>({kind:'add',text,oldLine:null,newLine:prefix+index+1})),...before.slice(before.length-suffix,before.length-suffix+3).map((_,index)=>context(before.length-suffix+index,after.length-suffix+index))];
  return {lines:lines.slice(0,limit),truncated:lines.length>limit,added:after.length-prefix-suffix,removed:before.length-prefix-suffix};
}
