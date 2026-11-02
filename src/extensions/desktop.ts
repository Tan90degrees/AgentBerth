import { Context, type Fiber } from 'cordis';
import type { ExtensionSnapshot } from '../shared/extensions';
import { boundedPlugin, loadModule, shareCordis } from './modules';

/** Electron-only resources mirror the authoritative daemon plugin lifecycle. */
export class DesktopExtensions {
  private context=new Context();private mounted=new Map<string,Fiber>();private signatures=new Map<string,string>();private chain:Promise<void>=Promise.resolve();
  private failures=new Map<string,{signature:string;error:string}>();
  diagnostics(){return Object.fromEntries([...this.failures].map(([id,value])=>[id,value.error]));}
  constructor(private features:Record<string,(ctx:Context)=>void|Promise<void>>,private error:(error:unknown)=>void=console.error,private call:(method:string,params?:Record<string,unknown>)=>Promise<unknown>=async()=>{throw new Error('后台未连接');}){}
  update(snapshot:ExtensionSnapshot|undefined){
    const active=new Set(snapshot?snapshot.plugins.filter(p=>p.status==='active').map(p=>p.manifest.id):Object.keys(this.features));
    this.chain=this.chain.catch(this.error).then(async()=>{
      const entries=new Map(snapshot?.plugins.map(p=>[p.manifest.id,p]));
      for(const [id,failure] of this.failures)if(!active.has(id)||failure.signature!==JSON.stringify([entries.get(id)?.generation,entries.get(id)?.config,entries.get(id)?.desktop]))this.failures.delete(id);
      for(const [id,fiber] of [...this.mounted].reverse())if(!active.has(id)||this.signatures.get(id)!==JSON.stringify([entries.get(id)?.generation,entries.get(id)?.config,entries.get(id)?.desktop])){await fiber.dispose();this.mounted.delete(id);}
      const implementations={...this.features};
      for(const record of entries.values())if(record.desktop){const {entry,root,dataDirectory}=record.desktop;implementations[record.manifest.id]=async ctx=>{ctx.effect(()=>shareCordis(root));const value=loadModule(root,entry);ctx.provide('desktop',{id:record.manifest.id,dataDirectory,call:this.call});await ctx.plugin(boundedPlugin(value),record.config).await();};}
      const failures:unknown[]=[];
      for(const [id,apply] of Object.entries(implementations))if(active.has(id)&&!this.mounted.has(id)&&!this.failures.has(id)){const fiber=this.context.isolate('desktop').plugin({name:'desktop-'+id,apply});this.mounted.set(id,fiber);const signature=JSON.stringify([entries.get(id)?.generation,entries.get(id)?.config,entries.get(id)?.desktop]);this.signatures.set(id,signature);try{await fiber.await();}catch(error){await fiber.dispose();this.mounted.delete(id);this.failures.set(id,{signature,error:String(error)});failures.push(new Error(`桌面插件 ${id}：${String(error)}`));}}
      if(failures.length)throw new AggregateError(failures,'桌面插件加载失败');
    });return this.chain;
  }
  async close(){await this.chain.catch(this.error);for(const fiber of [...this.mounted.values()].reverse())await fiber.dispose();this.mounted.clear();}
}
