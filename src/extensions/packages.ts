import { lstat, readFile, readdir, mkdir, copyFile, realpath, rm, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { Unzip, UnzipInflate } from 'fflate';
import { extensionManifestSchema, type ExtensionManifest } from '../shared/extensions';

export const PACKAGE_LIMITS={archiveBytes:256*1024*1024,expandedBytes:1024*1024*1024,fileBytes:256*1024*1024,files:50000} as const;
export function packagePath(root:string,relative:string):string {
  if(relative.split('/').length>33)throw new Error('插件目录过深');
  if(!relative||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(p=>p==='..'||p==='.'||!p||/[<>"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p))||path.posix.isAbsolute(relative)||relative.includes(':'))throw new Error('插件包路径无效');
  const file=path.resolve(root,...relative.split('/'));const sub=path.relative(root,file);
  if(!sub||sub.startsWith('..')||path.isAbsolute(sub))throw new Error('插件文件必须位于插件包内');return file;
}
export async function readManifest(root:string):Promise<ExtensionManifest> {
  const file=path.join(root,'agentberth.extension.json');
  let stat;
  try{stat=await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('缺少 agentberth.extension.json。DeepSeek Harness 插件不能直接通用：共享 Cordis 不等于共享宿主 API，请按 docs/CORDIS_PLUGIN_DEVELOPMENT.md 适配后导入。');throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw new Error('插件清单必须是小于 128 KiB 的普通文件');
  const manifest=extensionManifestSchema.parse(JSON.parse(await readFile(file,'utf8')));
  if(!manifest.entry.endsWith('.cjs')||manifest.desktopEntry&&!manifest.desktopEntry.endsWith('.cjs'))throw new Error('插件入口须为已打包的 .cjs 文件');
  for(const relative of [manifest.entry,...(manifest.desktopEntry?[manifest.desktopEntry]:[]),...manifest.views.map(v=>v.entry)]){
    const file=packagePath(root,relative),stat=await lstat(file),actual=await realpath(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!actual.startsWith(await realpath(root)+path.sep))throw new Error('插件入口或视图不能是链接或包外文件');
  }
  return manifest;
}
export async function stagePackage(source:string,base:string,development:boolean,limits:{archiveBytes:number;expandedBytes:number;fileBytes:number;files:number}=PACKAGE_LIMITS):Promise<{root:string;manifest:ExtensionManifest;cleanup:()=>Promise<void>}> {
  if(!path.isAbsolute(source))throw new Error('请选择插件包的完整路径');
  const sourceStat=await lstat(source);if(sourceStat.isSymbolicLink())throw new Error('插件包不能是符号链接');
  if(development){if(!sourceStat.isDirectory())throw new Error('开发模式请选择目录');const root=await realpath(source);return {root,manifest:await readManifest(root),cleanup:async()=>{}};}
  await mkdir(base,{recursive:true});const root=path.join(base,'.staging-'+randomUUID());await mkdir(root);
  const cleanup=()=>rm(root,{recursive:true,force:true});
  try {
    let bytes=0,count=0;
    const budget=(size:number)=>{if(++count>limits.files)throw new Error(`插件包文件数超过 ${limits.files} 个`);if(size>limits.fileBytes||(bytes+=size)>limits.expandedBytes)throw new Error('插件展开后超过容量限制（默认总量 1 GiB、单文件 256 MiB）');};
    if(sourceStat.isDirectory()){
      const walk=async(from:string,to:string,depth:number)=>{if(depth>32)throw new Error('插件目录过深');await mkdir(to,{recursive:true});for(const entry of await readdir(from,{withFileTypes:true})){const a=path.join(from,entry.name),b=path.join(to,entry.name);const info=await lstat(a);if(info.isSymbolicLink())throw new Error('插件包不能包含符号链接');if(info.isDirectory())await walk(a,b,depth+1);else if(info.isFile()){budget(info.size);await copyFile(a,b);}else throw new Error('插件包仅支持文件和目录');}};
      await walk(source,root,0);
    }else if(sourceStat.isFile()&&source.toLowerCase().endsWith('.zip')){
      if(sourceStat.size>limits.archiveBytes)throw new Error('插件压缩包超过容量限制（默认 256 MiB）');
      const archive=await open(source,'r');
      try{const tail=Buffer.alloc(Math.min(sourceStat.size,65557));await archive.read(tail,0,tail.length,sourceStat.size-tail.length);let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}if(end<0)throw new Error('插件 ZIP 不完整，缺少有效的目录结尾');if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw new Error('不支持分卷 ZIP 插件包');}finally{await archive.close();}
      const opened=new Set<number>(),names=new Set<string>();let failure:Error|undefined,actualBytes=0;
      const unzip=new Unzip(entry=>{
        if(failure)return;
        try{
          const relative=entry.name.replace(/\/$/,''),file=packagePath(root,relative),key=relative.toLowerCase();
          if(names.has(key))throw new Error('插件包含重复或大小写冲突的路径：'+relative);names.add(key);
          budget(entry.originalSize??0);
          if(entry.name.endsWith('/')){mkdirSync(file,{recursive:true});return;}
          mkdirSync(path.dirname(file),{recursive:true});const fd=openSync(file,'wx');opened.add(fd);let fileBytes=0;
          entry.ondata=(error,data,final)=>{
            if(failure)return;
            try{if(error)throw error;fileBytes+=data.length;actualBytes+=data.length;if(fileBytes>limits.fileBytes||actualBytes>limits.expandedBytes)throw new Error('插件实际解压数据超过容量限制');let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset);if(final){closeSync(fd);opened.delete(fd);}}catch(error){failure=error instanceof Error?error:new Error(String(error));}
          };entry.start();
        }catch(error){failure=error instanceof Error?error:new Error(String(error));}
      });
      unzip.register(UnzipInflate);
      try{for await(const chunk of createReadStream(source,{highWaterMark:64*1024})){unzip.push(new Uint8Array(chunk),false);if(failure)throw failure;}unzip.push(new Uint8Array(),true);if(failure)throw failure;if(opened.size)throw new Error('插件 ZIP 不完整');}
      finally{for(const fd of opened)closeSync(fd);}
    }else throw new Error('请选择含清单的插件目录或 ZIP 插件包');
    const manifest=await readManifest(root);return {root,manifest,cleanup};
  }catch(error){await cleanup();throw error;}
}
export async function commitPackage(staged:string,base:string,id:string):Promise<string>{const target=path.join(base,id+'-'+randomUUID());await rename(staged,target);return target;}
