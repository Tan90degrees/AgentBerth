import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { isConstructor, symbols, type Plugin, type Context } from 'cordis';

const hostRequire=createRequire(__filename);
/** Plugin directories live outside app.asar/node_modules. Resolve only the
 * shared Cordis singleton from the host; all other dependencies remain bundled. */
export function shareCordis(root:string):()=>void {
  const prefix=pathToFileURL(path.resolve(root)+path.sep).href,entry=hostRequire.resolve('cordis');
  const hook=registerHooks({resolve(specifier,context,next){
    if(specifier==='cordis'&&context.parentURL?.startsWith(prefix))return next(entry,context);
    return next(specifier,context);
  }});
  return()=>hook.deregister();
}
export function loadModule(root:string,entry:string){
  const require=createRequire(entry),dispose=shareCordis(root);
  try{for(const key of Object.keys(require.cache))if(key.startsWith(root+path.sep))delete require.cache[key];const loaded=require(entry),value=loaded.default??loaded;if(typeof value!=='function'&&typeof value?.apply!=='function')throw new Error('Cordis 插件须导出函数或 apply(ctx, config)');return value;}
  finally{dispose();}
}
export function clearModules(root:string){for(const key of Object.keys(hostRequire.cache))if(key.startsWith(root+path.sep))delete hostRequire.cache[key];}

/** Settle an async apply before disposal: Cordis correctly waits for apply to
 * finish, so an outer Promise.race alone would leave disposal waiting forever. */
export function boundedPlugin(plugin:Plugin,onTimeout:()=>void=()=>{}):Plugin {
  const callback=typeof plugin==='function'?plugin:plugin.apply;
  return {name:plugin.name,inject:plugin.inject,Config:plugin.Config,apply:(ctx:Context,config:any)=>{
    let value:any;
    if(isConstructor(callback)){const instance:any=new callback(ctx,config);for(const hook of instance?.[symbols.initHooks]??[])hook();value=instance?.[symbols.init]?.();}
    else value=callback(ctx,config);
    if(!value||typeof value.then!=='function')return value;
    let timer:NodeJS.Timeout;
    return Promise.race([value,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new Error('插件启动超过 5 秒，请检查异步初始化'));},5000);})]).finally(()=>clearTimeout(timer));
  }};
}
