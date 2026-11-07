import type {Context} from 'cordis';
import {z} from 'zod';
import {HarnessService} from './service';

const request=z.object({action:z.enum(['status','start','stop','restart'])}).strict();
export function mountHarness(ctx:Context,config:Record<string,unknown>,onPidChange:(pid:number|null)=>void=()=>{}){
  const service=HarnessService.fromConfig(config,onPidChange);
  ctx.berth.effect(()=>()=>service.dispose());
  ctx.berth.command({name:'web',mcp:false,description:'管理原生 Harness Web 服务',inputSchema:{type:'object',properties:{action:{type:'string',enum:['status','start','stop','restart']}},required:['action'],additionalProperties:false}},async input=>{
    const value=request.parse(input);if(value.action==='status')return service.snapshot();
    return service.control(value.action,value.action==='stop'?undefined:{id:null,path:ctx.berth.dataDirectory});
  });
}
