import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/daemon/store';
import { AgentPlugins } from '../src/daemon/plugins';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { AgentDefinition, History, NativeHistoryPage, Project, Run, Session, State, Attachment } from '../src/shared/protocol';

const query = { cursor: null, limit: 5, query: '' };
const history = (id: string, text = id): History => ({ nativeSessionId: id, path: null, messages: [{ role: 'user', text, timestamp: null }], warnings: [] });
const resources = new WeakMap<object, (() => unknown)[]>();
async function folder(t: any) { const dir = await mkdtemp(path.join(os.tmpdir(),'berth-native-')); const close: (() => unknown)[] = []; resources.set(t,close); t.after(async () => { try { for (const fn of close.reverse()) await fn(); } finally { await rm(dir,{recursive:true,force:true,maxRetries:5}); } }); return dir; }

test('history catalog keeps multiple IDs, shares only within project and Agent, paginates and searches without message payloads', async t => {
  const dir = await folder(t); const store = new Store(dir); resources.get(t)!.push(() => store.close());
  const p = store.createProject('P', dir), s = store.createSession(p.id,'A','codex',''), same = store.createSession(p.id,'B','codex','');
  for (let i=0;i<13;i++) store.saveHistory(s.id, history('native-'+String(i).padStart(2,'0'),i===7?'Find 中文%_🙂':'Body '+i));
  assert.equal(store.session(s.id).nativeSessionId,'native-12');
  const ids: string[] = []; let cursor: string | null = null;
  do { const page = store.nativeHistories(s.id,{...query,cursor}); assert.equal(page.total,13); assert.ok(page.items.every(item => !('messages' in item))); ids.push(...page.items.map(item=>item.nativeSessionId)); cursor=page.nextCursor; } while(cursor);
  assert.equal(ids.length,13); assert.equal(new Set(ids).size,13);
  assert.equal(store.nativeHistories(same.id,query).total,13);
  assert.equal(store.nativeHistories(store.createSession(p.id,'Claude','claude','').id,query).total,0);
  const p2=store.createProject('Other',path.join(dir,'other'));
  assert.equal(store.nativeHistories(store.createSession(p2.id,'Other','codex','').id,query).total,0);
  const found=store.nativeHistories(s.id,{...query,query:'%_🙂'}); assert.equal(found.items[0].nativeSessionId,'native-07');
  const first=store.nativeHistories(s.id,query);
  assert.throws(()=>store.nativeHistories(s.id,{...query,cursor:first.nextCursor,query:'changed'}),/分页/);
  store.saveHistory(s.id,{messages:[],warnings:[],nativeSessionId:null,path:null});
  assert.equal(store.nativeHistories(s.id,query).total,13); assert.equal(store.nativeHistory(same.id,'native-07')!.messages[0].text,'Find 中文%_🙂');
  store.updateProject(p.id,'P moved',path.join(dir,'moved'));
  assert.equal(store.nativeHistories(s.id,query).total,0); assert.equal(store.session(s.id).nativeSessionId,null);
});

test('running terminal permits link, switch, preview and unlink without changing run/PID; imported and saved conversations remain separate', {timeout:20000},async t=>{
  const dir=await folder(t);const server=new DaemonServer(path.join(dir,'data'));const c=await DaemonConnection.open(await server.listen(),()=>{});
  resources.get(t)!.push(async()=>{c.close();await server.close();});
  const p=await c.rpc<Project>('createProject',{name:'P',path:dir});
  const a=await c.rpc<AgentDefinition>('createAgent',{name:'Resume only',command:'echo RUNNING_LINK_READY',resumeCommand:'echo RESUME {sessionId}',plugin:null});
  const s=await c.rpc<Session>('createSession',{projectId:p.id,title:'Running',agent:a.id,command:''});
  const run=await c.rpc<Run>('start',{sessionId:s.id,cols:80,rows:24});
  await c.rpc('linkNativeSession',{sessionId:s.id,nativeSessionId:'first'});
  await c.rpc('linkNativeSession',{sessionId:s.id,nativeSessionId:'second'});
  assert.equal((await c.rpc<History>('nativeHistory',{sessionId:s.id,nativeSessionId:'first'})).nativeSessionId,'first');
  assert.equal((await c.rpc<History>('history',{sessionId:s.id})).nativeSessionId,'second');
  await c.rpc('unlinkNativeSession',{sessionId:s.id});
  const state=await c.rpc<State>('state'),live=state.sessions.find(item=>item.id===s.id)!;
  assert.equal(live.nativeSessionId,null);assert.equal(live.latestRun!.id,run.id);assert.equal(live.latestRun!.pid,run.pid);assert.equal(live.latestRun!.status,'running');
  assert.equal((await c.rpc<Attachment>('attach',{sessionId:s.id})).run!.id,run.id);
  assert.equal((await c.rpc<NativeHistoryPage>('nativeHistories',{sessionId:s.id})).total,2);
  await c.rpc('linkNativeSession',{sessionId:s.id,nativeSessionId:'first'});
  assert.equal((await c.rpc<History>('history',{sessionId:s.id})).nativeSessionId,'first');
});

test('plugin preview and paging never bind a different conversation, concurrent association is guarded and failures retain prior data', {timeout:20000},async t=>{
  const dir=await folder(t),file=path.join(dir,'plugin.cjs');
  await writeFile(file,`let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const r=JSON.parse(input);setTimeout(()=>console.log(JSON.stringify({version:1,cwd:r.projectPath,nativeSessionId:r.session.nativeSessionId,messages:[{role:'user',text:r.session.nativeSessionId}]})),200);});`);
  const server=new DaemonServer(path.join(dir,'data')),c=await DaemonConnection.open(await server.listen(),()=>{});resources.get(t)!.push(async()=>{c.close();await server.close();});
  const p=await c.rpc<Project>('createProject',{name:'P',path:dir}),a=await c.rpc<AgentDefinition>('createAgent',{name:'P',command:'echo P',resumeCommand:'',plugin:{runtime:'node',executable:file,args:[],history:true,resume:false}});
  const s=await c.rpc<Session>('createSession',{projectId:p.id,title:'S',agent:a.id,command:''});
  await c.rpc('linkNativeSession',{sessionId:s.id,nativeSessionId:'linked'});
  const pending=c.rpc<History>('nativeHistory',{sessionId:s.id,nativeSessionId:'preview'});
  await new Promise(resolve=>setTimeout(resolve,50));
  await assert.rejects(c.rpc('unlinkNativeSession',{sessionId:s.id}),/正在读取/);
  assert.equal((await pending).messages[0].text,'preview');assert.equal((await c.rpc<History>('history',{sessionId:s.id})).nativeSessionId,'linked');
  await c.rpc('linkNativeSession',{sessionId:s.id,nativeSessionId:'preview'});
  await writeFile(file,'console.log("broken");');
  await assert.rejects(c.rpc('nativeHistory',{sessionId:s.id,nativeSessionId:'preview',refresh:true}),/JSON/);
  assert.equal((await c.rpc<History>('history',{sessionId:s.id})).messages[0].text,'preview');
  await assert.rejects(c.rpc('discoverNativeHistories',{sessionId:s.id,cursor:'x'.repeat(2049)}),/参数/);
});
