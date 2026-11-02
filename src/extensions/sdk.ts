import type { Context } from 'cordis';
import type { AgentDefinitionConfig } from '../shared/protocol';
import type { SourceContribution, SourceHandle, SourceService } from '../shared/superagent-source';

export interface ExtensionCommand {mcp?:boolean;name:string;description:string;inputSchema:Record<string,unknown>}
export interface AgentContribution {id:string;definition:AgentDefinitionConfig}
export interface WorkbenchPluginApi {
  readonly id:string;
  readonly dataDirectory:string;
  readonly signal:AbortSignal;
  command(command:ExtensionCommand,execute:(params:Record<string,unknown>)=>unknown|Promise<unknown>):void;
  agent(contribution:AgentContribution):void;
  /** Declare the Superagent provider in manifest.dependencies. No source is bundled by the host. */
  source(contribution:SourceContribution):SourceHandle;
  /** Every resource belongs to the Cordis fiber; return its cleanup function. */
  effect(setup:()=>void|(()=>void|Promise<void>)|Promise<()=>void|Promise<void>>):void;
  interval(callback:()=>void,milliseconds:number):void;
  /** Calls the owning feature's registered host service, never a second Agent. */
  call(method:string,params?:Record<string,unknown>):Promise<unknown>;
}
export interface DesktopPluginApi {id:string;dataDirectory:string;call(method:string,params?:Record<string,unknown>):Promise<unknown>}
declare module 'cordis' {interface Context {berth:WorkbenchPluginApi;desktop:DesktopPluginApi;superagentSources:SourceService}}
export interface WorkbenchPlugin {apply(ctx:Context,config:Record<string,string|number|boolean>):unknown|Promise<unknown>}
