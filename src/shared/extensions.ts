import { z } from 'zod';

export const extensionId = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(100);
export const configField = z.object({type:z.enum(['string','number','boolean']),title:z.string().min(1).max(100),description:z.string().max(500).optional(),default:z.union([z.string(),z.number(),z.boolean()]).optional(),minimum:z.number().optional(),maximum:z.number().optional(),enum:z.array(z.string()).max(100).optional()}).strict();
export const extensionManifestSchema=z.object({
  apiVersion:z.literal(1),id:extensionId,name:z.string().min(1).max(100),version:z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),description:z.string().max(1000).default(''),kind:z.enum(['feature','agent']).default('feature'),
  entry:z.string().min(1).max(500).default('index.cjs'),desktopEntry:z.string().min(1).max(500).optional(),dependencies:z.array(extensionId).max(32).default([]),
  config:z.record(z.string().regex(/^[a-zA-Z][\w]*$/),configField).default({}),
  views:z.array(z.object({id:extensionId,title:z.string().min(1).max(100),location:z.enum(['sidebar','panel','settings']),entry:z.string().min(1).max(500)}).strict()).max(20).default([]),
}).strict();
export type ExtensionManifest=z.infer<typeof extensionManifestSchema>;
export type ExtensionConfig=Record<string,string|number|boolean>;
export interface ExtensionInfo {manifest:ExtensionManifest;generation:number;desktop?:{root:string;entry:string;dataDirectory:string};desktopError?:string;installed:boolean;enabled:boolean;status:'disabled'|'active'|'blocked'|'failed';builtin:boolean;development:boolean;isAgent:boolean;error?:string;config:ExtensionConfig;commands:{name:string;description:string;inputSchema:Record<string,unknown>}[];views:ExtensionManifest['views'];}
export interface ExtensionSnapshot {apiVersion:1;plugins:ExtensionInfo[];revision:number;warnings?:string[];}
export const extensionRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('list')}).strict(),
  z.object({action:z.literal('install'),path:z.string().min(1).max(4096),development:z.boolean().default(false)}).strict(),
  z.object({action:z.enum(['enable','disable','uninstall','reload']),id:extensionId}).strict(),
  z.object({action:z.literal('configure'),id:extensionId,config:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()]))}).strict(),
  z.object({action:z.literal('call'),id:extensionId,command:z.string().min(1).max(100),params:z.record(z.string(),z.unknown()).default({})}).strict(),
  z.object({action:z.literal('view'),id:extensionId,view:extensionId}).strict(),
]);
export type ExtensionRequest=z.infer<typeof extensionRequestSchema>;
export function extensionEnabled(snapshot:ExtensionSnapshot|undefined,id:string):boolean {return !snapshot||snapshot.plugins.some(p=>p.manifest.id===id&&p.status==='active');}
export function resolveExtensionConfig(manifest:ExtensionManifest,input:ExtensionConfig):ExtensionConfig {
  const result:ExtensionConfig={};
  for(const name of Object.keys(input))if(!Object.hasOwn(manifest.config,name))throw new Error(`未知插件配置：${name}`);
  for(const [name,field] of Object.entries(manifest.config)){
    const value=input[name]??field.default;if(value===undefined)continue;
    if(typeof value!==field.type||typeof value==='number'&&(!Number.isFinite(value)||field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum)||field.enum&&!field.enum.includes(String(value)))throw new Error(`插件配置无效：${field.title}`);
    result[name]=value;
  }
  return result;
}
