import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Project, Session, Run, RemoteInfo, RemoteAction } from '../src/shared/protocol';

const host = process.env.AGENTBERTH_SSH_TEST_HOST;
const wait = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check:()=>Promise<boolean>, timeout=12000) { const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await wait(50);}throw new Error('Remote condition timed out'); }

test('SSH-only remote shares a live terminal, survives MCP detach, and exposes reconnect as a new Shell', {skip:!host,timeout:60000},async t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-real-ssh-'));
  const server=new DaemonServer(path.join(folder,'data'));const runtime=await server.listen();
  const ui=await DaemonConnection.open(runtime,()=>{});let agent=await DaemonConnection.open(runtime,()=>{});
  let session:Session|undefined;
  t.after(async()=>{if(session)await ui.rpc('stop',{sessionId:session.id}).catch(()=>{});agent.close();ui.close();await server.close();rmSync(folder,{recursive:true,force:true});});
  const project=await ui.rpc<Project>('createProject',{name:'SSH',path:folder});
  session=await ui.rpc<Session>('createSession',{projectId:project.id,title:'remote',agent:'shell',remote:{host,directory:'/tmp'}});
  const sessionId=session.id;const run=await ui.rpc<Run>('start',{sessionId,cols:80,rows:24});const target={sessionId,runId:run.id};
  await ui.rpc('attach',{sessionId});
  await eventually(async()=>{const info=await ui.rpc<RemoteInfo>('remoteInfo',{sessionId});return info.connection==='connected'&&info.phase==='idle';});
  await ui.rpc('remoteControl',{...target,owner:'agent'});
  await assert.rejects(ui.rpc('input',{...target,data:'echo COLLISION\r'}),/接管/);
  async function execute(command:string,timeoutMs=5000) { const action=await agent.rpc<RemoteAction>('remoteExecute',{...target,requestId:randomUUID(),command});return agent.rpc<RemoteAction>('remoteWait',{...target,actionId:action.id,timeoutMs}); }
  assert.equal((await execute('export AB_REMOTE_VALUE=42; cd /')).exitCode,0);
  assert.equal((await execute('printf "REMOTE_VALUE=%s\\n" "$AB_REMOTE_VALUE"; pwd')).exitCode,0);
  await eventually(async()=>{const screen=await ui.rpc<{text:string}>('remoteScreen',target);return screen.text.includes('REMOTE_VALUE=42');});
  assert.equal((await ui.rpc<RemoteInfo>('remoteInfo',{sessionId})).cwd,'/');
  assert.equal((await execute('false')).exitCode,1);
  // A task may outlive its wait request and the MCP client, while the desktop remains attached.
  const requestId=randomUUID();const command='/bin/sleep 1; printf "LONG_TASK_DONE\\n"';
  const action=await agent.rpc<RemoteAction>('remoteExecute',{...target,requestId,command});
  assert.equal((await agent.rpc<RemoteAction>('remoteWait',{...target,actionId:action.id,timeoutMs:5})).status,'running');
  await ui.rpc('remoteControl',{...target,owner:'user'});
  await assert.rejects(agent.rpc('remoteKeys',{...target,key:'Ctrl+C'}),/用户控制/);
  assert.equal((await agent.rpc<RemoteAction>('remoteWait',{...target,actionId:action.id,timeoutMs:5000})).status,'completed');
  await ui.rpc('remoteControl',{...target,owner:'agent'});
  assert.equal((await agent.rpc<RemoteAction>('remoteExecute',{...target,requestId,command})).id,action.id);
  // Exit 255 is conservatively treated as lost SSH, not command success or restored execution.
  const lost=await agent.rpc<RemoteAction>('remoteExecute',{...target,requestId:randomUUID(),command:'exit 255'});
  await eventually(async()=>(await ui.rpc<RemoteInfo>('remoteInfo',{sessionId})).connection==='disconnected');
  assert.equal((await agent.rpc<RemoteAction>('remoteWait',{...target,actionId:lost.id,timeoutMs:0})).status,'unknown');
  await ui.rpc('remoteReconnect',target);
  await eventually(async()=>{const info=await ui.rpc<RemoteInfo>('remoteInfo',{sessionId});return info.connection==='connected'&&info.phase==='idle';});
  assert.equal((await ui.rpc<RemoteInfo>('remoteInfo',{sessionId})).owner,'user');
  await ui.rpc('remoteControl',{...target,owner:'agent'});
  assert.equal((await execute('test "${AB_REMOTE_VALUE-unset}" = unset && test "$PWD" = /tmp')).exitCode,0);
  // The old request remains unknown and is never executed again in the new Shell.
  assert.equal((await agent.rpc<RemoteAction>('remoteExecute',{...target,requestId:lost.id,command:'exit 255'})).status,'unknown');
  await ui.rpc('resize',{...target,cols:110,rows:35});
  assert.equal((await agent.rpc<{cols:number}>('remoteScreen',target)).cols,110);
  const long=await agent.rpc<RemoteAction>('remoteExecute',{...target,requestId:randomUUID(),command:'/bin/sleep 2; echo SURVIVED_AGENT_EXIT'});
  agent.close();await wait(50);agent=await DaemonConnection.open(runtime,()=>{});
  await eventually(async()=>(await ui.rpc<RemoteInfo>('remoteInfo',{sessionId})).owner==='user');
  assert.equal((await agent.rpc<RemoteAction>('remoteWait',{...target,actionId:long.id,timeoutMs:5000})).status,'completed');
  await ui.rpc('stop',{sessionId});
  await eventually(async()=>{try{await ui.rpc('remoteScreen',target);return false;}catch{return true;}});
  assert.equal((await ui.rpc<Run[]>('runs',{sessionId}))[0].status,'stopped');
});

test('bundled MCP stdio initializes, exposes scoped tools and shuts down cleanly', {timeout:10000},async()=>{
  const child=spawn(process.execPath,[path.resolve('dist/mcp.cjs'),path.resolve('nonexistent-mcp-profile')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes.toString());child.stderr.on('data',bytes=>stderr+=bytes.toString());
  const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');
  await eventually(async()=>stdout.trim().split('\n').length>=2,5000);child.stdin.end();
  assert.equal(await closed,0,stderr);const messages=stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(messages.find(message=>message.id===1).result.serverInfo.name,'agentberth-terminal');assert.equal(messages.find(message=>message.id===2).result.tools.length,6);
});
