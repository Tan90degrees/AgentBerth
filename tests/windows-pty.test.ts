import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as native from 'node-pty';
import { protectWindowsPty } from '../src/daemon/windows-pty';
import type { TerminalProcess } from '../src/daemon/remote';
import { DaemonServer } from '../src/daemon/server';
import { connectDaemon, DaemonConnection } from '../src/main/connection';
import type { Project, Run, Session, State } from '../src/shared/protocol';

function fixture(deferred=false){
  const input=new EventEmitter(),output=new EventEmitter(),exits=new EventEmitter(),queue:(()=>void)[]=[],sizes:number[][]=[];
  let failure:Error|undefined;
  const agent={inSocket:input,outSocket:output,resize(cols:number,rows:number){if(failure)throw failure;sizes.push([cols,rows]);}};
  const pty={pid:1,_agent:agent,resize(cols:number,rows:number){const run=()=>agent.resize(cols,rows);if(deferred)queue.push(run);else run();},write(){},pause(){},resume(){},kill(){},onData(){return{dispose(){}};},onExit(fn:(event:{exitCode:number})=>void){exits.on('exit',fn);return{dispose(){exits.off('exit',fn);}};}} as unknown as TerminalProcess;
  return {pty,input,output,queue,sizes,exits,fail(error:Error){failure=error;}};
}

test('Windows input and output pipe faults are reported once, including before first output',()=>{
  for(const side of ['input','output'] as const){
    const f=fixture(),errors:unknown[]=[];assert.equal(protectWindowsPty(f.pty,error=>errors.push(error),'win32'),true);
    // Mirror node-pty's own read-side handler, installed after ready_datapipe.
    if(side==='output')f.output.on('error',error=>{if(f.output.listenerCount('error')<2)throw error;});
    const error=Object.assign(new Error('write EAGAIN'),{code:'EAGAIN'});
    assert.doesNotThrow(()=>f[side].emit('error',error));assert.deepEqual(errors,[error]);
    f[side].emit('error',new Error('late error'));assert.equal(errors.length,1);
    assert.throws(()=>f.pty.resize(100,30),/通道已关闭/);
  }
});

test('deferred Windows resize errors cannot escape the socket callback, synchronous errors still reject',()=>{
  for(const deferred of [false,true]){
    const f=fixture(deferred),errors:unknown[]=[];protectWindowsPty(f.pty,error=>errors.push(error),'win32');
    const error=new Error('Cannot resize a pty that has already exited');f.fail(error);
    if(deferred){f.pty.resize(100,30);assert.doesNotThrow(()=>f.queue.shift()!());}
    else assert.throws(()=>f.pty.resize(100,30),error);
    assert.deepEqual(errors,[error]);
  }
});

test('queued resizes after exit are discarded and late pipe faults remain contained',()=>{
  const f=fixture(true),errors:unknown[]=[];protectWindowsPty(f.pty,error=>errors.push(error),'win32');
  f.pty.resize(100,30);f.exits.emit('exit',{exitCode:0});f.fail(new Error('already exited'));
  assert.doesNotThrow(()=>f.queue.shift()!());assert.doesNotThrow(()=>f.input.emit('error',new Error('EPIPE')));
  assert.deepEqual(errors,[]);assert.deepEqual(f.sizes,[]);
});

test('valid Windows deferred sizes remain ordered and other terminal backends are untouched',()=>{
  const f=fixture(true);protectWindowsPty(f.pty,()=>assert.fail('unexpected failure'),'win32');
  f.pty.resize(100,30);f.pty.resize(60,20);f.queue.forEach(run=>run());assert.deepEqual(f.sizes,[[100,30],[60,20]]);
  const other=fixture();assert.equal(protectWindowsPty(other.pty,()=>{},'linux'),false);assert.equal(other.input.listenerCount('error'),0);
  assert.equal(protectWindowsPty({} as TerminalProcess,()=>{},'win32'),false);
});

test('closing a Windows PTY before its first data releases native resources without waiting for readiness',()=>{
  const f=fixture(true),events:string[]=[];
  const terminal=f.pty as TerminalProcess & {_isReady:boolean;_agent:{kill():void}};
  terminal._isReady=false;terminal._agent.kill=()=>{events.push('native cleanup');};
  terminal.kill=()=>{events.push('deferred cleanup');};
  protectWindowsPty(terminal,()=>assert.fail('cleanup fault'),'win32');
  terminal.kill();assert.deepEqual(events,['native cleanup']);
  assert.doesNotThrow(()=>f.input.emit('error',new Error('late close error')));
});

async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+15000;while(true){const value=await read();if(accept(value))return value;assert.ok(Date.now()<deadline,'PTY state did not settle');await new Promise(resolve=>setTimeout(resolve,25));}
}

test('a real Windows ConPTY pipe failure stops only its run, retains its error and keeps the daemon usable',{skip:process.platform!=='win32',timeout:45000},async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'berth-conpty-fault-')),children:native.IPty[]=[];
  const server=new DaemonServer(path.join(folder,'data'),()=>{},((...args:Parameters<typeof native.spawn>)=>{const child=native.spawn(...args);children.push(child);return child;}) as typeof native.spawn);
  const connection=await DaemonConnection.open(await server.listen(),()=>{});
  t.after(async()=>{connection.close(true);await server.close();await rm(folder,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const project=await connection.rpc<Project>('createProject',{name:'Fault fixture',path:folder});
  const broken=await connection.rpc<Session>('createSession',{projectId:project.id,title:'Broken',agent:'shell'});
  const healthy=await connection.rpc<Session>('createSession',{projectId:project.id,title:'Healthy',agent:'shell'});
  await connection.rpc('start',{sessionId:broken.id,cols:80,rows:24});
  const good=await connection.rpc<Run>('start',{sessionId:healthy.id,cols:80,rows:24});
  await connection.rpc('attach',{sessionId:healthy.id});
  const socket=(children[0] as unknown as {_agent:{inSocket:EventEmitter}})._agent.inSocket;
  // Fault injection at the real native pipe boundary; no global exception hook.
  socket.emit('error',Object.assign(new Error('write EPIPE'),{code:'EPIPE'}));
  const state=await until(()=>connection.rpc<State>('state'),state=>state.sessions.find(s=>s.id===broken.id)?.latestRun?.status==='failed');
  assert.match(state.sessions.find(s=>s.id===broken.id)!.latestRun!.error!,/EPIPE/);
  assert.equal(state.sessions.find(s=>s.id===healthy.id)!.latestRun!.pid,good.pid);
  assert.equal(state.sessions.find(s=>s.id===healthy.id)!.latestRun!.status,'running');
  const restarted=await connection.rpc<Run>('start',{sessionId:broken.id,cols:90,rows:25});
  socket.emit('error',new Error('late old pipe fault'));
  assert.equal((await connection.rpc<State>('state')).sessions.find(s=>s.id===broken.id)!.latestRun!.id,restarted.id);
  await connection.rpc('input',{sessionId:healthy.id,runId:good.id,data:'echo HEALTHY_AFTER_PIPE_FAILURE\r'});
  await until(()=>connection.rpc<{snapshot:string}>('attach',{sessionId:healthy.id}),value=>value.snapshot.includes('HEALTHY_AFTER_PIPE_FAILURE'));
});

test('unexpected daemon exceptions retain bounded error and exit evidence without suppressing failure',{timeout:15000},async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'berth-daemon-fatal-')),data=path.join(folder,'data'),script=path.join(folder,'fatal.cjs');
  await writeFile(script,`require(${JSON.stringify(path.resolve('dist/daemon.cjs'))});setTimeout(()=>{throw new Error('FIXTURE_UNCAUGHT_PTY')},1000);`);
  t.after(()=>rm(folder,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const connection=await connectDaemon(data,script,process.execPath,()=>{});t.after(()=>connection.close(true));
  const exit=await until(async()=>{try{return JSON.parse(await readFile(path.join(data,'daemon-exit.json'),'utf8'));}catch{return null;}},value=>value!==null);
  assert.equal(exit.code,1);assert.equal(exit.signal,null);assert.ok(Number.isInteger(exit.pid));
  assert.match(await readFile(path.join(data,'daemon.log'),'utf8'),/uncaughtException: Error: FIXTURE_UNCAUGHT_PTY/);
  assert.deepEqual(Object.keys(exit).sort(),['code','pid','signal','time']);
});
