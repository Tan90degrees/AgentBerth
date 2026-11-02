import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,stat} from 'node:fs/promises';
import {openSync,closeSync,writeSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Zip,ZipPassThrough,zipSync,strToU8} from 'fflate';
import {stagePackage,PACKAGE_LIMITS} from '../src/extensions/packages';

const manifest=()=>strToU8(JSON.stringify({apiVersion:1,id:'example.large',name:'Large package',version:'1.0.0',entry:'index.cjs'}));
async function fixture(t:any){const dir=await mkdtemp(path.join(os.tmpdir(),'berth-large-package-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100}));return {dir,base:path.join(dir,'packages')};}
test('an actual 80 MiB plugin ZIP installs with bounded streaming extraction',async t=>{
  const {dir,base}=await fixture(t),file=path.join(dir,'large.zip'),fd=openSync(file,'w');
  try{const zip=new Zip((error,data)=>{if(error)throw error;let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset);});
    for(const [name,data] of [['agentberth.extension.json',manifest()],['index.cjs',strToU8('exports.apply=()=>{};')]] as [string,Uint8Array][]){const entry=new ZipPassThrough(name);zip.add(entry);entry.push(data,true);}
    const asset=new ZipPassThrough('assets/large.bin');zip.add(asset);const chunk=new Uint8Array(1024*1024).fill(57);for(let i=0;i<80;i++)asset.push(chunk,i===79);zip.end();
  }finally{closeSync(fd);}
  assert.ok((await stat(file)).size>80*1024*1024);const staged=await stagePackage(file,base,false);assert.equal((await stat(path.join(staged.root,'assets','large.bin'))).size,80*1024*1024);assert.equal(staged.manifest.id,'example.large');await staged.cleanup();assert.deepEqual(await readdir(base),[]);
});
test('plugin archives can contain more than 2000 bundled files',async t=>{
  const {dir,base}=await fixture(t),files:Record<string,Uint8Array>={'agentberth.extension.json':manifest(),'index.cjs':strToU8('exports.apply=()=>{}')};for(let i=0;i<2050;i++)files[`assets/${i}.txt`]=strToU8('x');const archive=path.join(dir,'many.zip');await writeFile(archive,zipSync(files));const staged=await stagePackage(archive,base,false);assert.equal((await readdir(path.join(staged.root,'assets'))).length,2050);await staged.cleanup();
});
test('expanded bytes, actual output, case collisions, traversal and truncated archives remain rejected and cleaned up',async t=>{
  const {dir,base}=await fixture(t),file=path.join(dir,'invalid.zip'),core={'agentberth.extension.json':manifest(),'index.cjs':strToU8('exports.apply=()=>{}')},limits={...PACKAGE_LIMITS,expandedBytes:3000,fileBytes:2048};
  await writeFile(file,zipSync({...core,'large.bin':new Uint8Array(4096)}));await assert.rejects(stagePackage(file,base,false,limits),/容量限制/);assert.deepEqual(await readdir(base),[]);
  const lying=Buffer.from(zipSync({...core,'large.bin':new Uint8Array(4096)},{level:0})),name=lying.indexOf(Buffer.from('large.bin'));lying.writeUInt32LE(1,name-30+22);await writeFile(file,lying);await assert.rejects(stagePackage(file,base,false,limits),/实际解压/);assert.deepEqual(await readdir(base),[]);
  for(const extra of [{'../escape':strToU8('no')},{'INDEX.cjs':strToU8('no')}] as Record<string,Uint8Array>[]){await writeFile(file,zipSync({...core,...extra}));await assert.rejects(stagePackage(file,base,false),/路径无效|大小写冲突/);assert.deepEqual(await readdir(base),[]);}
  const valid=zipSync(core);await writeFile(file,valid.subarray(0,valid.length-8));await assert.rejects(stagePackage(file,base,false),/ZIP 不完整/);assert.deepEqual(await readdir(base),[]);
});
test('a DeepSeek Harness package receives an explicit compatibility diagnostic',async t=>{
  const {dir,base}=await fixture(t),file=path.join(dir,'harness.zip');await writeFile(file,zipSync({'package.json':strToU8('{"name":"dsh-plugin"}'),'index.cjs':strToU8('exports.apply=()=>{}')}));await assert.rejects(stagePackage(file,base,false),/DeepSeek Harness 插件不能直接通用/);assert.deepEqual(await readdir(base),[]);
});
