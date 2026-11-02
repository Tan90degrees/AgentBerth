import type { Context } from 'cordis';
import type { PetHooks } from '../../main/pet-hooks';
interface PetDesktopHost {
  dataDirectory:string;createHooks():PetHooks;setHooks(value:PetHooks):void;
  enabled():boolean;open():Promise<void>;publish():void;destroy():void;
}
/** Hooks, window and refresh timer all belong to this plugin's Cordis scope. */
export async function mount(ctx:Context,host:PetDesktopHost){
  await ctx.effect(async()=>{
    const hooks=host.createHooks();host.setHooks(hooks);
    try{await hooks.start();if(host.enabled())await host.open();}
    catch(error){host.destroy();await hooks.close();throw error;}
    const timer=setInterval(host.publish,30000);timer.unref();
    return async()=>{clearInterval(timer);host.destroy();await hooks.close();};
  });
}
