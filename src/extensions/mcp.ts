import { createHash } from 'node:crypto';
import type { State } from '../shared/protocol';
import { extensionEnabled } from '../shared/extensions';

export const extensionToolName=(id:string,command:string)=>'extension_'+createHash('sha256').update(id).digest('hex').slice(0,12)+'_'+command;
/** One stable MCP endpoint; enabled plugins own its live tool catalog. */
export class ExtensionMcp {
  constructor(private base:{request(method:string,params?:unknown):Promise<unknown>},private rpc:(method:string,params?:Record<string,unknown>)=>Promise<unknown>){}
  async request(method:string,params?:unknown):Promise<any>{
    if(method==='initialize'){
      const base=await this.base.request(method,params) as Record<string,any>;let state:State|undefined;
      try{state=await this.rpc('state') as State;}catch{/* Discovery remains available while the desktop is offline. */}
      const guide='Tools belong to enabled AgentBerth Cordis plugins. Refresh tools/list on list_changed. Plugin errors never trigger automatic command replay. Keep an optional agentId stable for each independent subagent.';
      return {...base,serverInfo:{name:base.serverInfo?.name??'agentberth-terminal',title:'AgentBerth plugin workbench',version:'0.17.0'},capabilities:{...base.capabilities,tools:{...base.capabilities?.tools,listChanged:true}},instructions:(extensionEnabled(state?.extensions,'ssh')?String(base.instructions??'')+'\n\n':'')+guide};
    }
    if(!['tools/list','tools/call','resources/list','resources/read'].includes(method))return this.base.request(method,params);
    let state:State;
    try{state=await this.rpc('state') as State;}catch{return this.base.request(method,params);}
    if(!state.extensions)return this.base.request(method,params);
    const plugins=state.extensions.plugins.filter(p=>p.status==='active');
    const tools=plugins.flatMap(p=>p.commands.map(command=>({name:extensionToolName(p.manifest.id,command.name),description:`${p.manifest.name}: ${command.description}`,inputSchema:{...command.inputSchema,properties:{...(command.inputSchema.properties as Record<string,unknown>??{}),agentId:{type:'string',description:'Stable subagent identity; use your own value for independent SSH ownership.'}}},pluginId:p.manifest.id,command:command.name})));
    if(method==='tools/list'){
      const base=extensionEnabled(state.extensions,'ssh')?await this.base.request(method,params) as {tools:unknown[]}:{tools:[]};
      return {tools:[...base.tools,...tools.map(({pluginId,command,...tool})=>tool)]};
    }
    if(method==='resources/list'&&!extensionEnabled(state.extensions,'ssh'))return {resources:[]};
    if(method==='resources/read'&&!extensionEnabled(state.extensions,'ssh'))throw new Error('SSH 与 MCP 插件未启用');
    const p=params as {name?:string;arguments?:Record<string,unknown>};
    const tool=tools.find(t=>t.name===p?.name);
    if(tool){try{const result=await this.rpc('extensions',{request:{action:'call',id:tool.pluginId,command:tool.command,params:p.arguments??{}}});return {content:[{type:'text',text:JSON.stringify(result??null)}]};}catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:String(error),execution:'not_replayed'})}]};}}
    if(!extensionEnabled(state.extensions,'ssh'))return {isError:true,content:[{type:'text',text:JSON.stringify({error:'对应插件未启用；请刷新工具列表或在 AgentBerth 设置 → 插件中启用。',execution:'not_started'})}]};
    return this.base.request(method,params);
  }
}
