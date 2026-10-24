import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, settingsSchema, type Project, type Session, type State, type Run } from '../src/shared/protocol';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';

test('independent limits validate, persist and appear in state',t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-limits-store-'));let store=new Store(folder);
  t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
  for(const key of ['maxActiveTerminals','maxSshTerminals'] as const){
    for(const value of [0,129,1.5,'8',NaN])assert.equal(settingsSchema.safeParse({...DEFAULT_SETTINGS,[key]:value}).success,false);
    for(const value of [1,128])assert.equal(settingsSchema.safeParse({...DEFAULT_SETTINGS,[key]:value}).success,true);
  }
  const settings={...DEFAULT_SETTINGS,maxActiveTerminals:3,maxSshTerminals:7};store.saveSettings(settings);
  store.close();store=new Store(folder);
  assert.deepEqual(store.settings(),settings);assert.equal(store.state().maxActiveTerminals,3);assert.equal(store.state().maxSshTerminals,7);
  assert.throws(()=>store.saveSettings({...settings,maxSshTerminals:0}));assert.deepEqual(store.settings(),settings);
});

test('local/SSH capacity is independent, pending SSH counts once, and live limit changes preserve sessions', {timeout:45000},async t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-limits-daemon-')),daemon=new DaemonServer(path.join(folder,'data'));
  const runtime=await daemon.listen(),agent=await DaemonConnection.open(runtime,()=>{});
  const arrivals=new Map<string,()=>void>(),opening:Promise<unknown>[]=[];
  const ui=await DaemonConnection.open(runtime,event=>{if(event.event==='sshChallenge')arrivals.get(event.data.alias)?.();});
  t.after(async()=>{
    for(const session of (await ui.rpc<State>('state')).sessions.filter(s=>s.remote))await ui.rpc('stop',{sessionId:session.id}).catch(()=>{});
    await Promise.all(opening);ui.close();agent.close();await daemon.close();rmSync(folder,{recursive:true,force:true});
  });
  await ui.rpc('registerSshProvider');
  await ui.rpc('saveSettings',{...DEFAULT_SETTINGS,maxActiveTerminals:1,maxSshTerminals:2});
  for(const alias of ['capacity-a','capacity-b','capacity-c'])await ui.rpc('saveSshConnection',{config:{alias,hostname:'127.0.0.1',port:22,username:'fixture',authentication:'password',privateKeyPath:'',allowAgent:true}});
  const hold=async(alias:string)=>{
    let resolve!:()=>void;const reached=new Promise<void>(r=>resolve=r);arrivals.set(alias,resolve);
    // Credentials stay pending: no network login is attempted.
    const outcome=agent.rpc('remoteOpen',{alias}).then(value=>value,error=>error);opening.push(outcome);
    let timer:NodeJS.Timeout|undefined;
    try{await Promise.race([reached,outcome.then(value=>{throw value instanceof Error?value:new Error('Unexpected SSH connection');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSH credentials were not requested')),6000);})]);}
    finally{clearTimeout(timer);arrivals.delete(alias);}
    return (await ui.rpc<State>('state')).sessions.find(s=>s.remote?.host===alias)!;
  };
  const first=await hold('capacity-a'),second=await hold('capacity-b');
  await assert.rejects(agent.rpc('remoteOpen',{alias:'capacity-c'}),/SSH 会话已达上限 2/);
  const project=await ui.rpc<Project>('createProject',{name:'capacity',path:folder});
  const locals:Session[]=[];
  for(let i=0;i<3;i++)locals.push(await ui.rpc<Session>('createSession',{projectId:project.id,title:`local ${i}`,agent:'shell'}));
  const starts=await Promise.allSettled(locals.map(s=>ui.rpc<Run>('start',{sessionId:s.id,cols:80,rows:24})));
  assert.equal(starts.filter(x=>x.status==='fulfilled').length,1);
  for(const result of starts.filter(x=>x.status==='rejected'))assert.match(String(result.reason),/本机终端已达上限 1/);
  await ui.rpc('saveSettings',{...DEFAULT_SETTINGS,maxActiveTerminals:1,maxSshTerminals:1});
  let state=await ui.rpc<State>('state');assert.equal(state.sessions.filter(s=>s.latestRun?.status==='running'&&s.remote).length,2);
  assert.equal(state.sessions.filter(s=>s.latestRun?.status==='running'&&!s.remote).length,1);
  await assert.rejects(agent.rpc('remoteOpen',{alias:'capacity-c'}),/SSH 会话已达上限 1/);
  await ui.rpc('stop',{sessionId:first.id});
  await assert.rejects(agent.rpc('remoteOpen',{alias:'capacity-c'}),/SSH 会话已达上限 1/);
  await ui.rpc('saveSettings',{...DEFAULT_SETTINGS,maxActiveTerminals:3,maxSshTerminals:2});
  const third=await hold('capacity-c');assert.equal(third.latestRun?.status,'running');
  const winner=starts.find(x=>x.status==='fulfilled')!;
  assert.equal(winner.status,'fulfilled');
  const remaining=locals.filter(s=>s.id!==winner.value.sessionId);
  await Promise.all(remaining.map(s=>ui.rpc('start',{sessionId:s.id,cols:80,rows:24})));
  state=await ui.rpc<State>('state');assert.equal(state.maxActiveTerminals,3);assert.equal(state.maxSshTerminals,2);
  assert.equal(state.sessions.find(s=>s.id===second.id)?.latestRun?.status,'running');
  assert.equal(state.sessions.filter(s=>s.latestRun?.status==='running'&&!s.remote).length,3);
  await ui.rpc('saveSettings',{...DEFAULT_SETTINGS,maxActiveTerminals:1,maxSshTerminals:2});
  assert.equal((await ui.rpc<State>('state')).sessions.filter(s=>s.latestRun?.status==='running'&&!s.remote).length,3);
  const extra=await ui.rpc<Session>('createSession',{projectId:project.id,title:'excess',agent:'shell'});
  await assert.rejects(ui.rpc('start',{sessionId:extra.id,cols:80,rows:24}),/本机终端已达上限 1/);
});
