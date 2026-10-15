import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { DEFAULT_SETTINGS, type AgentDefinition, type AgentDefinitionConfig, type History, type NativeHistoryPage, type Project, type Session, type State } from '../src/shared/protocol';

async function adapter(folder: string, label: string, gate?: { method: string; ready: string; release: string }, valid = true): Promise<AgentDefinitionConfig> {
  const file = path.join(folder, label + '.cjs');
  await writeFile(file, `const fs=require('node:fs');let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const r=JSON.parse(text);const send=()=>{const value=r.method==='describe'?{version:1,id:'hot-agent',name:'Adapter',command:'echo ${label}',capabilities:{history:${valid},resume:true,list:true}}:r.method==='list'?{version:1,items:[{cwd:r.projectPath,nativeSessionId:'native-hot',title:'${label}'}],nextCursor:null}:r.method==='resume'?{version:1,command:'echo ${label}'}:{version:1,cwd:r.projectPath,nativeSessionId:r.session.nativeSessionId||'native-hot',messages:[{role:'assistant',text:'${label}'}]};console.log(JSON.stringify(value));};const gate=${JSON.stringify(gate ?? null)};if(gate&&r.method===gate.method){fs.writeFileSync(gate.ready,'ready');const timer=setInterval(()=>{if(fs.existsSync(gate.release)){clearInterval(timer);send();}},25);}else send();});`);
  return { sourceId: 'hot-agent', name: 'User name', command: 'echo ' + label, resumeCommand: '', plugin: { runtime: 'node', sourceId: 'hot-agent', executable: file, args: [], history: true, resume: true, list: true } };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-hot-'));
  const server = new DaemonServer(path.join(folder, 'data'));
  const c = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { c.close(); await server.close(); await rm(folder, {recursive:true,force:true,maxRetries:5}); });
  const project = await c.rpc<Project>('createProject', {name:'Project',path:folder});
  await c.rpc('saveSettings', {...DEFAULT_SETTINGS,terminal:{profile:process.platform==='win32'?'cmd':'bash',executable:'',args:[]}});
  return {folder,c,project};
}
async function waitFile(file: string) { const deadline=Date.now()+8000;while(true){try{await access(file);return;}catch{assert.ok(Date.now()<deadline,'Plugin did not start');await new Promise(r=>setTimeout(r,30));}} }

test('live Agent hot update validates before activation, preserves PID/identity/history and applies new capabilities to subsequent calls', {timeout:25000}, async t => {
  const {folder,c,project}=await fixture(t);
  const original=await adapter(folder,'old');const agent=await c.rpc<AgentDefinition>('createAgent',original);
  const session=await c.rpc<Session>('createSession',{projectId:project.id,title:'Live',agent:agent.id,command:''});
  await c.rpc('refreshHistory',{sessionId:session.id});await c.rpc('start',{sessionId:session.id,cols:80,rows:24});
  const run=(await c.rpc<State>('state')).sessions[0].latestRun!;
  const invalid=await adapter(folder,'invalid',undefined,false);
  await assert.rejects(c.rpc('updateAgent',{agentId:agent.id,...invalid}),/声明不一致/);
  await assert.rejects(c.rpc('updateAgent',{agentId:agent.id,...original,sourceId:'wrong-agent'}),/ID/);
  assert.equal((await c.rpc<State>('state')).agents![0].plugin!.executable,original.plugin!.executable);
  assert.equal((await c.rpc<History>('history',{sessionId:session.id})).messages[0].text,'old');
  const next=await adapter(folder,'new');await c.rpc('updateAgent',{agentId:agent.id,...next});
  const state=await c.rpc<State>('state');const retained=state.sessions.find(x=>x.id===session.id)!;
  assert.equal(retained.latestRun!.pid,run.pid);assert.equal(retained.latestRun!.id,run.id);assert.equal(retained.latestRun!.status,'running');
  assert.equal(retained.command,original.command);assert.equal(retained.nativeSessionId,'native-hot');assert.equal(state.agents![0].id,agent.id);assert.equal(state.agents![0].name,'User name');
  assert.equal((await c.rpc<History>('refreshHistory',{sessionId:session.id})).messages[0].text,'new');
  assert.equal((await c.rpc<NativeHistoryPage>('discoverNativeHistories',{sessionId:session.id,cursor:null,limit:5,query:''})).items[0].title,'new');
  const fresh=await c.rpc<Session>('createSession',{projectId:project.id,title:'New',agent:agent.id,command:''});assert.equal(fresh.command,next.command);
  await c.rpc('attach',{sessionId:session.id});await c.rpc('input',{sessionId:session.id,runId:run.id,data:'echo HOT_INPUT_OK\r'});
});

test('superseded plugin history, previews, discovery and resume cannot commit or launch after a hot update', {timeout:45000}, async t => {
  const {folder,c,project}=await fixture(t);
  for(const method of ['history','preview','list','resume']){
    const ready=path.join(folder,method+'.ready'),release=path.join(folder,method+'.release');
    const old=await adapter(folder,'old-'+method,{method:method==='preview'?'history':method,ready,release});
    const agent=await c.rpc<AgentDefinition>('createAgent',{...old,name:method});
    const session=await c.rpc<Session>('createSession',{projectId:project.id,title:method,agent:agent.id,command:''});
    await c.rpc('linkNativeSession',{sessionId:session.id,nativeSessionId:'native-hot'});
    const pending=method==='resume'?c.rpc('start',{sessionId:session.id,resume:true,cols:80,rows:24}):method==='list'?c.rpc('discoverNativeHistories',{sessionId:session.id,cursor:null,limit:5,query:''}):method==='preview'?c.rpc('nativeHistory',{sessionId:session.id,nativeSessionId:'native-hot',refresh:true}):c.rpc('refreshHistory',{sessionId:session.id});
    const rejected=assert.rejects(pending,/插件已更新/);
    await waitFile(ready);
    const next=await adapter(folder,'new-'+method);await c.rpc('updateAgent',{agentId:agent.id,...next,name:method});
    await writeFile(release,'release');await rejected;
    assert.equal((await c.rpc<History>('history',{sessionId:session.id})).messages.length,0);
    assert.equal((await c.rpc<State>('state')).sessions.find(x=>x.id===session.id)!.latestRun,null);
  }
});
