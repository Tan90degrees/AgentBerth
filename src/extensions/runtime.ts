import { Context, Fiber, FiberState, type Plugin } from 'cordis';
import Ajv from 'ajv';
import { boundedPlugin, loadModule, shareCordis } from './modules';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, mkdir, writeFile, rename, rm, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { builtinExtensions } from './builtins';
import { commitPackage, packagePath, readManifest, stagePackage } from './packages';
import { extensionManifestSchema, resolveExtensionConfig, type ExtensionConfig, type ExtensionInfo, type ExtensionManifest, type ExtensionSnapshot } from '../shared/extensions';
import { agentDefinitionSchema } from '../shared/protocol';
import type { WorkbenchPlugin, WorkbenchPluginApi, ExtensionCommand, AgentContribution } from './sdk';

interface RecordEntry {manifest:ExtensionManifest;installed:boolean;enabled:boolean;config:ExtensionConfig;root?:string;development?:boolean}
interface Mounted {fiber:Fiber;pending:number;commands:Map<string,{description:ExtensionCommand;execute:(p:Record<string,unknown>)=>unknown;validate:ReturnType<Ajv['compile']>}>;agents:Map<string,AgentContribution>}
export interface ExtensionHost {
  mount(id:string,ctx:Context,config:ExtensionConfig):unknown|Promise<unknown>;
  beforeChange(ids:string[]):Promise<void>;
  call(method:string,params:Record<string,unknown>):Promise<unknown>;
  agentsChanged(contributions:{pluginId:string;agent:AgentContribution}[]):void;
  validateAgent?(pluginId:string,agent:AgentContribution):void;
  changed():void;
}
export class ExtensionRuntime {
  readonly context=new Context();
  private records=new Map<string,RecordEntry>();private mounted=new Map<string,Mounted>();private errors=new Map<string,string>();
  private modules=new Map<string,Plugin>();private notices=new Map<string,string>();private warnings:string[]=[];private changing=new Set<string>();
  private watchers=new Map<string,FSWatcher>();private timers=new Map<string,NodeJS.Timeout>();private generations=new Map<string,number>();private revision=0;private chain:Promise<unknown>=Promise.resolve();private closed=false;
  private ajv=new Ajv({strict:true,allErrors:true});
  readonly ready:Promise<void>;
  constructor(readonly directory:string,private host:ExtensionHost){this.ready=this.initialize();}
  private async initialize(){
    await mkdir(this.directory,{recursive:true});
    let saved:RecordEntry[]=[];
    try{const raw=JSON.parse(await readFile(path.join(this.directory,'plugins.json'),'utf8'));if(!Array.isArray(raw))throw new Error('插件配置格式无效');saved=raw;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){const backup='plugins.invalid-'+Date.now()+'.json';await copyFile(path.join(this.directory,'plugins.json'),path.join(this.directory,backup));this.warnings.push('插件配置读取失败，原文件已备份为 '+backup+'；当前使用默认配置');}}
    for(const manifest of builtinExtensions)this.records.set(manifest.id,{manifest,installed:true,enabled:true,config:{}});
    for(const value of saved){try{const manifest=extensionManifestSchema.parse(value.manifest), builtin=builtinExtensions.find(p=>p.id===manifest.id);if(!builtin&&!value.root)continue;this.records.set(manifest.id,{...value,manifest:builtin??(value.installed?await readManifest(value.root!):manifest),config:resolveExtensionConfig(builtin??manifest,value.config??{})});}catch(error){if(value?.manifest?.id)this.errors.set(value.manifest.id,String(error));}}
    await this.reconcile();this.installWatchers();
  }
  private publish(){this.revision++;this.host.agentsChanged([...this.mounted].flatMap(([pluginId,p])=>[...p.agents.values()].map(agent=>({pluginId,agent}))));this.host.changed();}
  private async persist(){const file=path.join(this.directory,'plugins.json');await writeFile(file+'.tmp',JSON.stringify([...this.records.values()],null,2),{mode:0o600});await rename(file+'.tmp',file);}
  snapshot():ExtensionSnapshot {return {apiVersion:1,revision:this.revision,plugins:[...this.records.values()].map(record=>{
    const active=this.mounted.get(record.manifest.id),failure=this.errors.get(record.manifest.id),error=failure??this.notices.get(record.manifest.id)??(record.enabled&&record.installed&&!active?'依赖尚未启用或存在循环：'+record.manifest.dependencies.filter(id=>!this.active(id)).join('、'):undefined);
    return {manifest:record.manifest,generation:this.generations.get(record.manifest.id)??0,...(active&&record.root&&record.manifest.desktopEntry?{desktop:{root:record.root,entry:packagePath(record.root,record.manifest.desktopEntry),dataDirectory:path.join(this.directory,'data',record.manifest.id)}}:{}),installed:record.installed,enabled:record.enabled,status:failure?'failed':!record.installed||!record.enabled?'disabled':active?.fiber.state===FiberState.ACTIVE?'active':'blocked',builtin:!record.root,development:!!record.development,error,config:record.config,commands:[...(active?.commands.values()??[])].map(c=>c.description),views:active?record.manifest.views:[]};
  }),warnings:this.warnings};}
  active(id:string){return !this.errors.has(id)&&this.mounted.get(id)?.fiber.state===FiberState.ACTIVE;}
  require(id:string){if(this.changing.has(id))throw new Error('插件正在更新，请稍后重试；操作尚未执行');if(!this.active(id))throw new Error(`插件“${this.records.get(id)?.manifest.name??id}”未启用，请在设置 → 插件中启用`);}
  private load(record:RecordEntry):Plugin {
    return loadModule(record.root!,packagePath(record.root!,record.manifest.entry));
  }

  private validateDependencies(id:string,manifest:ExtensionManifest){
    const visit=(current:string,stack:Set<string>)=>{if(stack.has(current))throw new Error('插件依赖存在循环：'+[...stack,current].join(' → '));const value=current===id?manifest:this.records.get(current)?.manifest;if(!value)return;for(const dep of value.dependencies)visit(dep,new Set([...stack,current]));};visit(id,new Set());
  }
  private dependents(id:string):string[]{const result=new Set([id]);let more=true;while(more){more=false;for(const r of this.records.values())if(r.manifest.dependencies.some(p=>result.has(p))&&!result.has(r.manifest.id)){result.add(r.manifest.id);more=true;}}return [...result];}
  private async dispose(ids:string[]){for(const [id,mount] of [...this.mounted].reverse())if(ids.includes(id)){await mount.fiber.dispose();this.mounted.delete(id);}}
  private async reconcile(){
    let changed=true;while(changed){changed=false;for(const [id,record] of this.records){
      if(!record.installed||!record.enabled||this.mounted.has(id)||this.errors.has(id)||record.manifest.dependencies.some(dep=>!this.active(dep)))continue;
      const commands:Mounted['commands']=new Map(),agents=new Map<string,AgentContribution>();
      const plugin:Plugin={name:id,inject:record.manifest.dependencies.map(dep=>'extension_'+dep.replaceAll(/[.-]/g,'_')),apply:async(ctx:Context)=>{
        const dataDirectory=path.join(this.directory,'data',id);await mkdir(dataDirectory,{recursive:true});
        const abort=new AbortController();ctx.effect(()=>()=>abort.abort());
        const api:WorkbenchPluginApi={id,dataDirectory,signal:abort.signal,
          command:(description,execute)=>{if(!/^[a-z][a-z0-9_]{0,63}$/.test(description.name)||commands.has(description.name))throw new Error('插件命令名无效或重复');if((description.inputSchema.properties as Record<string,unknown>|undefined)?.agentId)throw new Error('agentId 是 MCP 的调用方标识，请改用其他参数名');if(description.inputSchema.type!=='object')throw new Error('插件命令 inputSchema 须为 object');const validate=this.ajv.compile(description.inputSchema);ctx.effect(()=>{commands.set(description.name,{description,execute,validate});return()=>{commands.delete(description.name);};});},
          agent:agent=>{if(!/^[a-z][a-z0-9.-]{0,63}$/.test(agent.id)||agents.has(agent.id))throw new Error('Agent 接入 ID 无效或重复');agent={...agent,definition:agentDefinitionSchema.parse(agent.definition)};if([...agents.values()].some(value=>value.definition.name.toLocaleLowerCase()===agent.definition.name.toLocaleLowerCase()))throw new Error('同一插件的 Agent 名称不能重复');this.host.validateAgent?.(id,agent);ctx.effect(()=>{agents.set(agent.id,agent);return()=>{agents.delete(agent.id);};});},
          effect:setup=>{ctx.effect(async()=>{const dispose=await setup();return dispose??(()=>{});});},
          interval:(callback,milliseconds)=>{if(milliseconds<100||!Number.isFinite(milliseconds))throw new Error('定时器间隔至少 100 ms');ctx.effect(()=>{const timer=setInterval(()=>{try{callback();}catch(error){this.notices.set(id,'定时任务失败：'+String(error));this.publish();}},milliseconds);return()=>clearInterval(timer);});},
          call:(method,params={})=>this.host.call(method,params),
        };
        ctx.provide('berth',api);
        if(record.root){ctx.effect(()=>shareCordis(record.root!));if(!this.modules.has(id))this.modules.set(id,this.load(record));await ctx.plugin(boundedPlugin(this.modules.get(id)!,()=>abort.abort()),record.config).await();}
        else await this.host.mount(id,ctx,record.config);
        ctx.provide('extension_'+id.replaceAll(/[.-]/g,'_'),{});
      }};
      try{const fiber=this.context.isolate('berth').plugin(plugin,{});this.mounted.set(id,{fiber,commands,agents,pending:0});let timer:NodeJS.Timeout|undefined;try{await Promise.race([fiber.await(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('插件启动超过 5 秒，请检查依赖和异步初始化')),5000);})]);}finally{clearTimeout(timer);}if(fiber.state!==FiberState.ACTIVE)throw new Error(`插件 ${id} 启动失败`);this.host.agentsChanged([...this.mounted].flatMap(([pluginId,p])=>[...p.agents.values()].map(agent=>({pluginId,agent}))));this.generations.set(id,(this.generations.get(id)??0)+1);changed=true;}
      catch(error){const mount=this.mounted.get(id);await mount?.fiber.dispose();this.mounted.delete(id);this.errors.set(id,error instanceof Error?error.message:String(error));}
    }}this.publish();
  }
  private serialize<T>(action:()=>Promise<T>):Promise<T>{const task=this.chain.catch(()=>{}).then(async()=>{await this.ready;if(this.closed)throw new Error('插件宿主已关闭');return action();});this.chain=task;return task;}
  async change(action:'enable'|'disable'|'uninstall'|'reload'|'configure',id:string,config?:ExtensionConfig){return this.serialize(async()=>{
    const record=this.records.get(id);if(!record)throw new Error('插件不存在');
    if(action==='enable'&&record.root&&!record.installed)throw new Error('请重新选择插件包安装');
    const previous={...record,config:{...record.config}},previousModules=new Map(this.modules);
    const nextManifest=action==='reload'&&record.root?await readManifest(record.root):record.manifest;
    this.validateDependencies(id,nextManifest);
    const nextConfig=resolveExtensionConfig(nextManifest,action==='configure'?config??{}:record.config);
    const nextModule=action==='reload'&&record.root?this.load({...record,manifest:nextManifest}):undefined;
    const affected=this.dependents(id);for(const key of affected)this.changing.add(key);
    try {
      this.assertIdle(affected);await this.host.beforeChange(affected);
      await this.dispose(affected);for(const key of affected){this.errors.delete(key);this.notices.delete(key);}
      record.manifest=nextManifest;record.config=nextConfig;if(nextModule)this.modules.set(id,nextModule);
      if(action==='enable'){record.installed=true;record.enabled=true;}
      if(action==='disable'||action==='uninstall')record.enabled=false;
      if(action==='uninstall')record.installed=false;
      try {
        await this.reconcile();const failed=affected.find(key=>this.errors.has(key));if(failed)throw new Error(this.errors.get(failed));
        await this.persist();
      } catch(error) {
        await this.dispose(affected);this.records.set(id,previous);this.modules=previousModules;
        for(const key of affected)this.errors.delete(key);await this.reconcile();
        throw new Error('插件更新失败，已恢复旧配置与代码：'+String(error));
      }
      if(action==='uninstall'&&record.root&&!record.development)await rm(record.root,{recursive:true,force:true});
      this.installWatchers();return this.snapshot();
    } finally {for(const key of affected)this.changing.delete(key);}
  });}
  async install(source:string,development=false){return this.serialize(async()=>{
    const base=path.join(this.directory,'packages'),staged=await stagePackage(source,base,development);
    const id=staged.manifest.id,previous=this.records.get(id),previousModules=new Map(this.modules),affected=this.dependents(id);
    let root=staged.root,changed=false;
    try {
      if(builtinExtensions.some(p=>p.id===id))throw new Error('外部插件不能覆盖内置插件 ID');
      this.validateDependencies(id,staged.manifest);
      const config=resolveExtensionConfig(staged.manifest,Object.fromEntries(Object.entries(previous?.config??{}).filter(([key])=>Object.hasOwn(staged.manifest.config,key))));
      for(const key of affected)this.changing.add(key);this.assertIdle(affected);await this.host.beforeChange(affected);
      if(!development)root=await commitPackage(staged.root,base,id);
      // Reload from its final location so relative imports and assets keep working.
      const loaded=this.load({manifest:staged.manifest,root,installed:true,enabled:true,config});
      changed=true;await this.dispose(affected);for(const key of affected){this.errors.delete(key);this.notices.delete(key);}
      this.modules.set(id,loaded);this.records.set(id,{manifest:staged.manifest,installed:true,enabled:true,config,root,development});
      await this.reconcile();const failed=affected.find(key=>this.errors.has(key));if(failed)throw new Error(this.errors.get(failed));
      await this.persist();this.installWatchers();
    } catch(error) {
      if(changed){await this.dispose(affected);if(previous)this.records.set(id,previous);else this.records.delete(id);this.modules=previousModules;for(const key of affected)this.errors.delete(key);await this.reconcile();}
      if(!development&&root!==staged.root)await rm(root,{recursive:true,force:true});throw error;
    } finally {for(const key of affected)this.changing.delete(key);await staged.cleanup();}
    if(previous?.root&&!previous.development&&previous.root!==root)await rm(previous.root,{recursive:true,force:true});return this.snapshot();
  });}
  private assertIdle(ids:string[]){if(ids.some(id=>(this.mounted.get(id)?.pending??0)>0))throw new Error('插件仍有命令正在执行，完成后可重新配置、停用或卸载');}
  async call(id:string,name:string,params:Record<string,unknown>){await this.ready;this.require(id);const mounted=this.mounted.get(id)!,command=mounted.commands.get(name);if(!command)throw new Error('插件命令不存在');if(!command.validate(params))throw new Error('插件参数无效：'+this.ajv.errorsText(command.validate.errors));mounted.pending++;try{const value=await command.execute(params);if(Buffer.byteLength(JSON.stringify(value??null))>128*1024)throw new Error('插件结果超过 128 KiB，请返回摘要或分页');return value;}finally{mounted.pending--;}}
  async view(id:string,viewId:string){await this.ready;this.require(id);const record=this.records.get(id)!,view=record.manifest.views.find(v=>v.id===viewId);if(!record.root||!view)throw new Error('插件视图不存在');const file=packagePath(record.root,view.entry);if(!(await realpath(file)).startsWith(await realpath(record.root)+path.sep))throw new Error('视图不能引用包外文件');const text=await readFile(file,'utf8');if(Buffer.byteLength(text)>2*1024*1024)throw new Error('插件视图超过 2 MiB');return text;}
  private installWatchers(){for(const watcher of this.watchers.values())watcher.close();this.watchers.clear();for(const [id,record] of this.records)if(record.root&&record.development&&record.installed){try{const watcher=watch(record.root,{recursive:true},()=>{clearTimeout(this.timers.get(id));this.timers.set(id,setTimeout(()=>{this.timers.delete(id);void this.change('reload',id).catch(error=>{this.notices.set(id,String(error));this.publish();});},350));});watcher.on('error',()=>{this.notices.set(id,'开发目录监听失效，请重新加载');this.publish();});this.watchers.set(id,watcher);}catch{this.notices.set(id,'无法监听开发目录，请使用重新加载');}}}
  async close(){this.closed=true;await this.ready;for(const timer of this.timers.values())clearTimeout(timer);for(const watcher of this.watchers.values())watcher.close();await this.chain.catch(()=>{});await this.dispose([...this.mounted.keys()]);}
}
