import { lstat, readFile, readdir, mkdir, copyFile, realpath, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { extensionManifestSchema, type ExtensionManifest } from '../shared/extensions';

const MAX_BYTES=64*1024*1024,MAX_FILES=2000;
export function packagePath(root:string,relative:string):string {
  if(!relative||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(p=>p==='..'||p==='.'||!p)||path.posix.isAbsolute(relative)||relative.includes(':'))throw new Error('插件包路径无效');
  const file=path.resolve(root,...relative.split('/'));const sub=path.relative(root,file);
  if(!sub||sub.startsWith('..')||path.isAbsolute(sub))throw new Error('插件文件必须位于插件包内');return file;
}
export async function readManifest(root:string):Promise<ExtensionManifest> {
  const file=path.join(root,'agentberth.extension.json'),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw new Error('插件清单必须是小于 128 KiB 的普通文件');
  const manifest=extensionManifestSchema.parse(JSON.parse(await readFile(file,'utf8')));
  if(!manifest.entry.endsWith('.cjs')||manifest.desktopEntry&&!manifest.desktopEntry.endsWith('.cjs'))throw new Error('插件入口须为已打包的 .cjs 文件');
  for(const relative of [manifest.entry,...(manifest.desktopEntry?[manifest.desktopEntry]:[]),...manifest.views.map(v=>v.entry)]){
    const file=packagePath(root,relative),stat=await lstat(file),actual=await realpath(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!actual.startsWith(await realpath(root)+path.sep))throw new Error('插件入口或视图不能是链接或包外文件');
  }
  return manifest;
}
export async function stagePackage(source:string,base:string,development:boolean):Promise<{root:string;manifest:ExtensionManifest;cleanup:()=>Promise<void>}> {
  if(!path.isAbsolute(source))throw new Error('请选择插件包的完整路径');
  const sourceStat=await lstat(source);if(sourceStat.isSymbolicLink())throw new Error('插件包不能是符号链接');
  if(development){if(!sourceStat.isDirectory())throw new Error('开发模式请选择目录');const root=await realpath(source);return {root,manifest:await readManifest(root),cleanup:async()=>{}};}
  await mkdir(base,{recursive:true});const root=path.join(base,'.staging-'+randomUUID());await mkdir(root);
  const cleanup=()=>rm(root,{recursive:true,force:true});
  try {
    let bytes=0,count=0;
    const budget=(size:number)=>{if(++count>MAX_FILES||(bytes+=size)>MAX_BYTES)throw new Error('插件包超过 2000 个文件或 64 MiB，请先打包依赖');};
    if(sourceStat.isDirectory()){
      const walk=async(from:string,to:string,depth:number)=>{if(depth>32)throw new Error('插件目录过深');await mkdir(to,{recursive:true});for(const entry of await readdir(from,{withFileTypes:true})){const a=path.join(from,entry.name),b=path.join(to,entry.name);const info=await lstat(a);if(info.isSymbolicLink())throw new Error('插件包不能包含符号链接');if(info.isDirectory())await walk(a,b,depth+1);else if(info.isFile()){budget(info.size);await copyFile(a,b);}else throw new Error('插件包仅支持文件和目录');}};
      await walk(source,root,0);
    }else if(sourceStat.isFile()&&source.endsWith('.zip')){
      if(sourceStat.size>MAX_BYTES)throw new Error('插件包过大');
      const files=unzipSync(await readFile(source),{filter:file=>{if(file.originalSize>MAX_BYTES)throw new Error('插件解压后过大');budget(file.originalSize);packagePath(root,file.name.replace(/\/$/,''));return true;}});
      let actualBytes=0;for(const [relative,data] of Object.entries(files)){if((actualBytes+=data.length)>MAX_BYTES)throw new Error('插件解压后过大');const file=packagePath(root,relative.replace(/\/$/,''));if(relative.endsWith('/'))await mkdir(file,{recursive:true});else{await mkdir(path.dirname(file),{recursive:true});await import('node:fs/promises').then(fs=>fs.writeFile(file,data));}}
    }else throw new Error('请选择含清单的插件目录或 ZIP 插件包');
    const manifest=await readManifest(root);return {root,manifest,cleanup};
  }catch(error){await cleanup();throw error;}
}
export async function commitPackage(staged:string,base:string,id:string):Promise<string>{const target=path.join(base,id+'-'+randomUUID());await rename(staged,target);return target;}
