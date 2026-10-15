import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ResourceSampler,ProcessReader,parseProcStat,type ProcessSample} from '../src/daemon/resources';

const row=(pid:number,parent:number,memoryBytes:number,cpuSeconds=1,started=1):ProcessSample=>({pid,parent,memoryBytes,cpuSeconds,started});
const targets=[{sessionId:'a',projectId:'one',runId:'run-a',pid:10},{sessionId:'b',projectId:'two',runId:'run-b',pid:20}];
test('proc stat handles parentheses in names, CPU ticks and resident pages',()=>{
 const fields=Array(22).fill('0');fields[0]='S';fields[1]='7';fields[11]='120';fields[12]='30';fields[19]='250';fields[21]='16';
 assert.deepEqual(parseProcStat('42 (agent ) worker) '+fields.join(' '),100,4096),{pid:42,parent:7,started:2.5,cpuSeconds:1.5,memoryBytes:65536});
});
test('session/project/workbench CPU and RSS include descendants, exclude unrelated processes and deduplicate app roots',async()=>{
 let time=1000;let rows=[row(100,0,1000),row(1,100,100),row(101,100,200),row(10,1,10),row(11,10,20),row(12,11,30),row(20,1,40),row(21,20,50),row(999,0,9999)];
 const sampler=new ResourceSampler(async()=>rows,()=>time,4,1);
 const first=await sampler.sample(targets,[100,101]);assert.equal(first.sessions.a.memoryBytes,60);assert.equal(first.sessions.a.cpuPercent,null);assert.equal(first.projects.two.memoryBytes,90);assert.equal(first.workspace.memoryBytes,1450);assert.equal(first.workspace.processCount,8);assert.equal(first.desktopIncluded,true);
 time+=3000;rows=rows.map(r=>({...r,cpuSeconds:r.cpuSeconds+1}));const second=await sampler.sample(targets,[100,101]);
 assert.ok(Math.abs(second.sessions.a.cpuPercent!-25)<0.001);assert.ok(Math.abs(second.projects.two.cpuPercent!-100/6)<0.001);assert.ok(Math.abs(second.workspace.cpuPercent!-200/3)<0.001);
 await sampler.close();
});
test('shared ancestry is assigned to the nearest session and aggregated once',async()=>{
 const sampler=new ResourceSampler(async()=>[row(1,0,10),row(10,1,20),row(20,10,30),row(21,20,40)],()=>1000,2,1);
 const value=await sampler.sample(targets.map(t=>({...t,projectId:'same'})));
 assert.equal(value.sessions.a.memoryBytes,20);assert.equal(value.sessions.b.memoryBytes,70);assert.equal(value.projects.same.memoryBytes,90);assert.equal(value.workspace.memoryBytes,100);await sampler.close();
});
test('reparented children retain their run owner; PID reuse and stopped/restarted sessions cannot inherit old readings',async()=>{
 let time=1000,rows=[row(1,0,1),row(10,1,10),row(11,10,20)];const sampler=new ResourceSampler(async()=>rows,()=>time,2,1);
 await sampler.sample(targets.slice(0,1));time+=3000;rows=[row(1,0,1),row(10,1,10),row(11,0,20)];assert.equal((await sampler.sample(targets.slice(0,1))).sessions.a.memoryBytes,30);
 time+=3000;rows=[row(1,0,1),row(10,1,999,0,5),row(13,10,888,0,6)];assert.equal((await sampler.sample(targets.slice(0,1))).sessions.a.memoryBytes,null);
 time+=3000;const stopped=await sampler.sample([]);assert.deepEqual(stopped.sessions,{});assert.deepEqual(stopped.projects,{});
 time+=3000;const next=await sampler.sample([{...targets[0],runId:'new-run'}]);assert.equal(next.sessions.a.memoryBytes,1887);assert.equal(next.sessions.a.runId,'new-run');await sampler.close();
});
test('coalesced/cached samples avoid duplicate process walks and failures report unavailable, never false zero',async()=>{
 let calls=0;const sampler=new ResourceSampler(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return[row(1,0,50)];},()=>1000,2,1);
 const[a,b]=await Promise.all([sampler.sample([]),sampler.sample([])]);assert.equal(a,b);assert.equal(calls,1);await sampler.sample([]);assert.equal(calls,1);await sampler.close();
 const failed=new ResourceSampler(async()=>{throw new Error('denied');});const unavailable=await failed.sample([]);assert.equal(unavailable.workspace.memoryBytes,null);assert.equal(unavailable.workspace.cpuPercent,null);assert.ok(unavailable.error);await failed.close();
});
test('a real CPU/memory child is included in the session tree and sampling shuts down cleanly', {timeout:25000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'berth-resources-')),file=path.join(dir,'worker.cjs');
 await writeFile(file,`if(process.argv[2]==='child'){global.buffer=Buffer.alloc(32*1024*1024,1);setInterval(()=>{const end=Date.now()+30;while(Date.now()<end){}},60);}else{const c=require('child_process').spawn(process.execPath,[__filename,'child'],{env:process.env,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);}`);
 const child=spawn(process.execPath,[file],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']}),reader=new ProcessReader(),sampler=new ResourceSampler(()=>reader.read());
 t.after(async()=>{await sampler.close();await reader.close();if(child.pid){if(process.platform==='win32'){try{await promisify(execFile)('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});}catch{}}else try{process.kill(-child.pid,'SIGKILL');}catch{}}await rm(dir,{recursive:true,force:true,maxRetries:5});});
 const descendant=await new Promise<number>((resolve,reject)=>{child.stdout.once('data',data=>resolve(Number(String(data).trim())));child.once('error',reject);});
 const target=[{sessionId:'real',projectId:'project',runId:'run',pid:child.pid!}];
 let value=await sampler.sample(target);const deadline=Date.now()+15000;
 while(value.sessions.real.processCount<2||value.sessions.real.memoryBytes!<32*1024*1024||value.sessions.real.cpuPercent===null){assert.ok(Date.now()<deadline,JSON.stringify(value));await new Promise(r=>setTimeout(r,2700));value=await sampler.sample(target);}
 assert.ok(descendant>0);assert.ok(value.sessions.real.cpuPercent!>0);assert.equal(value.projects.project.memoryBytes,value.sessions.real.memoryBytes);assert.ok(value.workspace.memoryBytes!>=value.sessions.real.memoryBytes!);
});
