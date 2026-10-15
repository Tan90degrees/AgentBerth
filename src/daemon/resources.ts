import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import type { ResourceSnapshot, ResourceUsage } from '../shared/protocol';

const execute=promisify(execFile);
export interface ProcessSample {pid:number;parent:number;started:number;cpuSeconds:number;memoryBytes:number}
export interface ResourceTarget {sessionId:string;projectId:string;runId:string;pid:number}
export const zeroUsage=():ResourceUsage=>({cpuPercent:0,memoryBytes:0,processCount:0,partial:false});
export function parseProcStat(text:string,ticks:number,pageSize:number):ProcessSample {
  const end=text.lastIndexOf(') '),pid=Number(text.slice(0,text.indexOf(' '))),fields=text.slice(end+2).trim().split(/\s+/);
  if(end<0||fields.length<22)throw new Error('Invalid process stat');
  return {pid,parent:Number(fields[1]),started:Number(fields[19])/ticks,cpuSeconds:(Number(fields[11])+Number(fields[12]))/ticks,memoryBytes:Math.max(0,Number(fields[21]))*pageSize};
}
const valid=(r:ProcessSample)=>Number.isSafeInteger(r.pid)&&r.pid>0&&Number.isSafeInteger(r.parent)&&r.parent>=0&&[r.started,r.cpuSeconds,r.memoryBytes].every(v=>Number.isFinite(v)&&v>=0);
const key=(r:ProcessSample)=>`${r.pid}:${r.started}`;

// One warm PowerShell process handles foreground samples. It exits after 20 s idle.
// Query only numeric process metadata, never command lines or environment variables.
const windowsScript=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);while($null -ne [Console]::ReadLine()){try{$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime -ErrorAction Stop | ForEach-Object {if($null -ne $_.CreationDate){[pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToFileTimeUtc()/10000000;cpuSeconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000;memoryBytes=[double]$_.WorkingSetSize}}});[Console]::WriteLine((@{rows=$rows}|ConvertTo-Json -Compress -Depth 4))}catch{[Console]::WriteLine('{"error":"Windows process sampling failed"}')}}`;
export class ProcessReader {
  private child:ChildProcessWithoutNullStreams|null=null;
  private waiting:{resolve:(rows:ProcessSample[])=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
  private idle:NodeJS.Timeout|undefined;
  private output='';private closed=false;private exits=new Set<Promise<void>>();private abort=new AbortController();
  private units:Promise<[number,number]>|undefined;private namespace:Promise<string|null>|undefined;
  async read():Promise<ProcessSample[]>{
    if(this.closed)throw new Error('资源采样已停止');
    if(process.platform==='win32')return this.windows();
    if(process.platform==='linux'){
      this.units??=Promise.all(['CLK_TCK','PAGESIZE'].map(unit=>execute('getconf',[unit],{timeout:3000,signal:this.abort.signal}).then(r=>{const n=Number(r.stdout.trim());if(!Number.isFinite(n)||n<=0)throw new Error('Invalid system units');return n;}))) as Promise<[number,number]>;
      this.namespace??=readFile('/proc/self/stat','utf8').then(async text=>Number(text.slice(0,text.indexOf(' ')))===process.pid?null:readlink('/proc/self/ns/pid'));
      const [ticks,pageSize]=await this.units,namespace=await this.namespace,names=(await readdir('/proc')).filter(n=>/^\d+$/.test(n)),rows:ProcessSample[]=[],localPids=new Map<number,number>();
      let index=0;await Promise.all(Array.from({length:16},async()=>{while(index<names.length){const name=names[index++];try{
        const row=parseProcStat(await readFile(`/proc/${name}/stat`,'utf8'),ticks,pageSize);
        if(namespace){const [status,ns]=await Promise.all([readFile(`/proc/${name}/status`,'utf8'),readlink(`/proc/${name}/ns/pid`)]);if(ns!==namespace)continue;const pids=/^NSpid:\s+([\d\s]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);if(!pids?.length)continue;localPids.set(row.pid,pids.at(-1)!);}
        if(valid(row))rows.push(row);
      }catch{/* Processes can exit between enumeration and read. */}}}));
      return namespace?[...new Map(rows.map(r=>{const pid=localPids.get(r.pid)!;return[pid,{...r,pid,parent:localPids.get(r.parent)??0}];})).values()]:rows;
    }
    const {stdout}=await execute('ps',['-axo','pid=,ppid=,lstart=,time=,rss='],{timeout:8000,signal:this.abort.signal,maxBuffer:8*1024*1024,env:{...process.env,LC_ALL:'C'}});
    return stdout.trim().split('\n').flatMap(line=>{const f=line.trim().split(/\s+/),time=f[7]??'';const parts=time.split('-'),days=parts.length>1?Number(parts.shift()):0;let cpuSeconds=0;for(const part of parts[0].split(':').map(Number))cpuSeconds=cpuSeconds*60+part;cpuSeconds+=days*86400;const row={pid:Number(f[0]),parent:Number(f[1]),started:Date.parse(f.slice(2,7).join(' '))/1000,cpuSeconds,memoryBytes:Number(f[8])*1024};return valid(row)?[row]:[];});
  }
  private windows():Promise<ProcessSample[]>{
    if(this.waiting)return Promise.reject(new Error('资源采样正在进行'));
    clearTimeout(this.idle);
    if(!this.child){
      const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',windowsScript],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;this.output='';const exit=new Promise<void>(resolve=>child.once('close',()=>resolve()));this.exits.add(exit);void exit.finally(()=>this.exits.delete(exit));
      child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{if(this.child!==child)return;this.output+=chunk;if(this.output.length>8*1024*1024){this.fail(new Error('资源采样数据过多'));return;}let end;while((end=this.output.indexOf('\n'))>=0){const line=this.output.slice(0,end).trim();this.output=this.output.slice(end+1);if(!line)continue;const pending=this.waiting;if(!pending)continue;try{const value=JSON.parse(line);if(!Array.isArray(value.rows))throw new Error('进程信息暂时不可用');this.waiting=null;clearTimeout(pending.timer);pending.resolve(value.rows.filter(valid));}catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}}});
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      child.on('error',()=>{if(this.child===child)this.fail(new Error('无法启动系统资源采样'));});child.on('close',()=>{if(this.child===child){this.child=null;this.fail(new Error('系统资源采样已退出'));}});
    }
    return new Promise((resolve,reject)=>{this.waiting={resolve,reject,timer:setTimeout(()=>this.fail(new Error('资源采样超时')),8000)};this.child!.stdin.write('sample\n');this.idle=setTimeout(()=>this.release(),20000);this.idle.unref();});
  }
  private fail(error:Error){const pending=this.waiting;this.waiting=null;if(pending){clearTimeout(pending.timer);pending.reject(error);}this.release();}
  private release(){const child=this.child;this.child=null;clearTimeout(this.idle);if(child){child.stdin.end();child.kill();}}
  async close(){this.closed=true;this.abort.abort();this.fail(new Error('资源采样已停止'));await Promise.allSettled([...this.exits]);}
}

export class ResourceSampler {
  private reader=new ProcessReader();private previous=new Map<number,ProcessSample>();private owners=new Map<string,{sessionId:string;runId:string}>();
  private roots=new Map<string,string>();private previousTime=0;private cached:ResourceSnapshot|null=null;private signature='';private pending:Promise<ResourceSnapshot>|null=null;private closed=false;
  constructor(private read=()=>this.reader.read(),private clock=()=>performance.now(),private logicalCpus=Math.max(1,cpus().length),private workspacePid=process.pid){}
  sample(targets:ResourceTarget[],appPids:number[]=[]):Promise<ResourceSnapshot>{
    const signature=JSON.stringify([targets,appPids]);
    if(this.cached&&signature===this.signature&&this.clock()-this.previousTime<2500)return Promise.resolve(this.cached);
    if(this.pending)return this.pending;
    this.pending=this.collect(targets,appPids).finally(()=>{this.pending=null;});this.signature=signature;return this.pending;
  }
  private async collect(targets:ResourceTarget[],appPids:number[]):Promise<ResourceSnapshot>{
    try{
      const rows=(await this.read()).filter(valid);if(this.closed)throw new Error('资源采样已停止');
      const now=this.clock(),elapsed=(now-this.previousTime)/1000,table=new Map(rows.map(r=>[r.pid,r]));
      if(!table.has(this.workspacePid))throw new Error('自身进程不可读');
      const rootTargets=new Map<number,ResourceTarget>();const nextRoots=new Map<string,string>();
      for(const t of targets){const r=table.get(t.pid),identity=`${t.sessionId}:${t.runId}`,old=this.roots.get(identity);if(r&&(!old||old===key(r))){rootTargets.set(t.pid,t);nextRoots.set(identity,key(r));}else if(old)nextRoots.set(identity,old);}
      const aliveTargets=new Map(targets.map(t=>[t.sessionId,t])),owned=new Map<string,Set<number>>(),nextOwners=new Map<string,{sessionId:string;runId:string}>();
      const workspace=new Set<number>(),workspaceRoots=new Set([this.workspacePid,...appPids]);
      for(const row of rows){
        let cursor:ProcessSample|undefined=row,target:ResourceTarget|undefined;const visited=new Set<number>();
        while(cursor&&!visited.has(cursor.pid)){visited.add(cursor.pid);if(workspaceRoots.has(cursor.pid))workspace.add(row.pid);target??=rootTargets.get(cursor.pid);const parent=table.get(cursor.parent);cursor=parent&&parent.started<=cursor.started?parent:undefined;}
        if(!target){const old=this.owners.get(key(row)),candidate=old&&aliveTargets.get(old.sessionId);if(candidate?.runId===old?.runId)target=candidate;}
        if(target){const set=owned.get(target.sessionId)??new Set<number>();set.add(row.pid);owned.set(target.sessionId,set);nextOwners.set(key(row),{sessionId:target.sessionId,runId:target.runId});workspace.add(row.pid);}
      }
      const usage=(pids:Set<number>):ResourceUsage=>{
        let memoryBytes=0,cpuPercent=0,known=0;
        for(const pid of pids){const row=table.get(pid)!;memoryBytes+=row.memoryBytes;const before=this.previous.get(pid);if(elapsed>0&&before&&key(before)===key(row)&&row.cpuSeconds>=before.cpuSeconds){known++;cpuPercent+=(row.cpuSeconds-before.cpuSeconds)/elapsed/this.logicalCpus*100;}}
        return {memoryBytes,cpuPercent:pids.size&&!known?null:Math.min(100,Math.max(0,cpuPercent)),processCount:pids.size,partial:false};
      };
      const sessions:ResourceSnapshot['sessions']={},projects:ResourceSnapshot['projects']={},projectPids=new Map<string,Set<number>>();
      for(const target of targets){const pids=owned.get(target.sessionId)??new Set<number>();sessions[target.sessionId]={runId:target.runId,...(pids.size?usage(pids):{cpuPercent:null,memoryBytes:null,processCount:0,partial:true})};const all=projectPids.get(target.projectId)??new Set<number>();for(const pid of pids)all.add(pid);projectPids.set(target.projectId,all);}
      for(const [id,pids] of projectPids){projects[id]=usage(pids);projects[id].partial=targets.some(t=>t.projectId===id&&sessions[t.sessionId].partial);if(!pids.size&&projects[id].partial){projects[id].memoryBytes=null;projects[id].cpuPercent=null;}}
      const workspaceUsage=usage(workspace);
      this.previous=table;this.previousTime=now;this.owners=nextOwners;this.roots=nextRoots;
      return this.cached={sampledAt:new Date().toISOString(),cpuCount:this.logicalCpus,sessions,projects,workspace:workspaceUsage,desktopIncluded:appPids.length>0};
    }catch{return {sampledAt:new Date().toISOString(),cpuCount:this.logicalCpus,sessions:{},projects:{},workspace:{cpuPercent:null,memoryBytes:null,processCount:0,partial:true},desktopIncluded:appPids.length>0,error:'资源信息暂不可用，稍后自动重试'};}
  }
  async close(){this.closed=true;await this.reader.close();if(this.pending)await this.pending;}
}
