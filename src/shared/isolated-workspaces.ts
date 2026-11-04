export const DEFAULT_COPY_EXCLUDES=['.git','node_modules','.venv','venv','__pycache__','.cache','.next','.turbo','dist','build','coverage'];
export interface CopyOptions {excludes:string[];maxBytes:number;skipLinks:boolean}
export interface CopyEntry {hash:string;size:number;mode:number}
export interface CopyManifest {version:1;id:string;projectId:string;projectPath:string;name:string;owner:string;createdAt:string;options:CopyOptions;files:Record<string,CopyEntry>}
export interface CopyChange {path:string;kind:'added'|'modified'|'deleted'|'blocked';conflict:boolean;reason?:string;before:CopyEntry|null;after:CopyEntry|null}
export interface CopyJob {id:string;workspaceId:string;action:string;state:'running'|'completed'|'cancelled'|'failed';files:number;bytes:number;totalFiles?:number;totalBytes?:number;result?:any;error?:string}
