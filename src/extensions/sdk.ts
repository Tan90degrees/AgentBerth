import type { Context } from 'cordis';
import type { AgentDefinitionConfig } from '../shared/protocol';

export interface ExtensionCommand {name:string;description:string;inputSchema:Record<string,unknown>}
export interface AgentContribution {id:string;definition:AgentDefinitionConfig;/** Adopt legacy agent identity when importing the same source; preserve sessions. */legacySourceId?:string}
export interface WorkbenchPluginApi {
  readonly id:string;
  readonly dataDirectory:string;
  readonly signal:AbortSignal;
  command(command:ExtensionCommand,execute:(params:Record<string,unknown>)=>unknown|Promise<unknown>):void;
  agent(contribution:AgentContribution):void;
  /** Every resource belongs to the Cordis fiber; return its cleanup function. */
  effect(setup:()=>void|(()=>void|Promise<void>)|Promise<()=>void|Promise<void>>):void;
  interval(callback:()=>void,milliseconds:number):void;
  /** Calls the owning feature's registered host service, never a second Agent. */
  call(method:string,params?:Record<string,unknown>):Promise<unknown>;
}
export interface DesktopPluginApi {id:string;dataDirectory:string;call(method:string,params?:Record<string,unknown>):Promise<unknown>}
declare module 'cordis' {interface Context {berth:WorkbenchPluginApi;desktop:DesktopPluginApi}}
export interface WorkbenchPlugin {apply(ctx:Context,config:Record<string,string|number|boolean>):unknown|Promise<unknown>}
