import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Server } from 'ssh2';
import { DaemonServer } from '../src/daemon/server';
import { connectDaemon, shutdownDaemon, DaemonConnection } from '../src/main/connection';
import { Store } from '../src/daemon/store';
import { restartConfiguration, shouldResume } from '../src/daemon/recovery';
import { DEFAULT_SETTINGS, type State, type Project, type Session, type Run, type AgentDefinition } from '../src/shared/protocol';

const wait = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
async function completed(connection:DaemonConnection):Promise<State> {
  const deadline=Date.now()+15000;
  while(true){const state=await connection.rpc<State>('state');if(state.recovery?.status==='completed')return state;assert.ok(Date.now()<deadline,'Recovery did not finish');await wait(30);}
}

test('explicit full quit checkpoints running sessions; reopen resumes final native ID once without replaying terminal input', {timeout:35000}, async t => {
  const folder=mkdtempSync(path.join(tmpdir(),'berth-reopen-')),data=path.join(folder,'data');
  const connections:DaemonConnection[]=[];
  const connect=async()=>{const c=await connectDaemon(data,path.resolve('dist/daemon.cjs'),process.execPath,()=>{});connections.push(c);return c;};
  t.after(async()=>{await shutdownDaemon(data).catch(()=>{});for(const c of connections)c.close(true);rmSync(folder,{recursive:true,force:true,maxRetries:5});});
  let phase='initial startup';
  try {
  let c=await connect();
  await c.rpc('saveSettings',{...DEFAULT_SETTINGS,terminal:{profile:process.platform==='win32'?'cmd':'bash',executable:'',args:[]}});
  const project=await c.rpc<Project>('createProject',{name:'Fixture',path:folder});
  const profile=await c.rpc<AgentDefinition>('createAgent',{name:'Resumable fixture',command:'echo INITIAL_START',resumeCommand:'echo RESUMED_{sessionId}',plugin:null});
  const agent=await c.rpc<Session>('createSession',{projectId:project.id,title:'Agent',agent:profile.id});
  const shell=await c.rpc<Session>('createSession',{projectId:project.id,title:'Shell',agent:'shell'});
  const stopped=await c.rpc<Session>('createSession',{projectId:project.id,title:'Stopped',agent:'shell'});
  phase='start and stop fixture terminals';
  const [agentRun,shellRun]=await Promise.all([agent,shell].map(s=>c.rpc<Run>('start',{sessionId:s.id,cols:82,rows:26})));
  await c.rpc('start',{sessionId:stopped.id,cols:80,rows:24});await c.rpc('stop',{sessionId:stopped.id});
  await c.rpc('linkNativeSession',{sessionId:agent.id,nativeSessionId:'late_native_id'});
  await c.rpc('attach',{sessionId:shell.id});
  const marker=path.join(folder,'input-count.txt');
  // This is historical user input, not a saved startup command.
  await c.rpc('input',{sessionId:shell.id,runId:shellRun.id,data:`echo USER_INPUT_ONCE >> "${marker}"\r`});
  const deadline=Date.now()+5000;while(true){try{if(readFileSync(marker,'utf8').includes('USER_INPUT_ONCE'))break;}catch{}assert.ok(Date.now()<deadline);await wait(30);}
  phase='checkpoint and full quit';
  await shutdownDaemon(data,true);c.close(true);
  // Native identity discovered during shutdown wins over anything in the checkpoint.
  const store=new Store(data);store.saveHistory(agent.id,{nativeSessionId:'final_native_id',path:null,messages:[],warnings:[]});store.close();
  phase='reopen and restore';
  c=await connect();
  await Promise.all([c.rpc('restoreWorkspace'),c.rpc('restoreWorkspace')]);
  const state=await completed(c);assert.equal(state.recovery!.restored,2,JSON.stringify(state.recovery));assert.equal(state.recovery!.resumed,1);assert.deepEqual(state.recovery!.errors,[]);
  const restored=state.sessions.find(s=>s.id===agent.id)!;
  assert.notEqual(restored.latestRun!.id,agentRun.id);assert.equal(restored.latestRun!.command,'echo RESUMED_final_native_id');assert.equal(restored.nativeSessionId,'final_native_id');
  assert.equal(state.sessions.find(s=>s.id===shell.id)!.latestRun!.status,'running');assert.notEqual(state.sessions.find(s=>s.id===shell.id)!.latestRun!.id,shellRun.id);
  assert.equal(state.sessions.find(s=>s.id===stopped.id)!.latestRun!.status,'stopped');
  await c.rpc('restoreWorkspace');assert.equal((await c.rpc<Run[]>('runs',{sessionId:shell.id})).length,2);
  assert.equal((await c.rpc<State>('state')).sessions.find(session=>session.id===agent.id)!.latestRun!.id,restored.latestRun!.id);
  assert.equal(readFileSync(marker,'utf8').trim(),'USER_INPUT_ONCE');
  phase='ordinary shutdown and empty restart';
  await shutdownDaemon(data);c.close(true);c=await connect();await c.rpc('restoreWorkspace');assert.equal((await completed(c)).recovery!.total,0,'Non-tray shutdown does not queue a restart');
  } catch(error) { throw new Error(`Workspace recovery failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`,{cause:error}); }
});

test('restore plan is consumed atomically; native association changes are allowed but launch configuration changes are detected', () => {
  const folder=mkdtempSync(path.join(tmpdir(),'berth-plan-'));let store=new Store(folder);
  try {
    const project=store.createProject('Fixture',folder),session=store.createSession(project.id,'Agent','shell','');
    const configuration=restartConfiguration(session,folder);
    store.saveRestartPlan([{sessionId:session.id,runId:null,configuration,cols:80,rows:24}]);store.close();store=new Store(folder);
    assert.equal(store.takeRestartPlan().length,1);assert.deepEqual(store.takeRestartPlan(),[]);
    assert.equal(restartConfiguration({...session,nativeSessionId:'final-id',updatedAt:'later'},folder),configuration);
    assert.notEqual(restartConfiguration({...session,command:'changed'},folder),configuration);
    assert.equal(shouldResume({...session,agent:'claude',nativeSessionId:'native-id'}),true);
    assert.equal(shouldResume({...session,agent:'opencode',nativeSessionId:'native-id'}),true);
    assert.equal(shouldResume({...session,nativeSessionId:'native-id'}),false);
    assert.throws(()=>shouldResume({...session,agent:'custom',nativeSessionId:'native-id'}),/未配置恢复命令/);
  } finally {store.close();rmSync(folder,{recursive:true,force:true,maxRetries:5});}
});

test('restoration skips changed registrations and isolates a missing executable from healthy sessions', {timeout:20000}, async t => {
 const folder=mkdtempSync(path.join(tmpdir(),'berth-recovery-errors-')),data=path.join(folder,'data');let daemon=new DaemonServer(data);
 const clients:DaemonConnection[]=[];t.after(async()=>{for(const client of clients)client.close(true);await daemon.close();rmSync(folder,{recursive:true,force:true,maxRetries:5});});
 let client=await DaemonConnection.open(await daemon.listen(),()=>{});clients.push(client);
 await client.rpc('saveSettings',{...DEFAULT_SETTINGS,terminal:{profile:process.platform==='win32'?'cmd':'bash',executable:'',args:[]}});
 const project=await client.rpc<Project>('createProject',{name:'Fixture',path:folder});
 const create=async(title:string)=>client.rpc<Session>('createSession',{projectId:project.id,title,agent:'shell'});
 const good=await create('healthy'),bad=await create('missing-shell'),edited=await create('edited');
 await Promise.all([good,bad,edited].map(session=>client.rpc('start',{sessionId:session.id,cols:80,rows:24})));
 await client.rpc('shutdown',{restoreOnOpen:true});client.close(true);await daemon.close();
 const store=new Store(data),entries=store.takeRestartPlan();
 const missing={...store.session(bad.id),terminal:{profile:'custom' as const,executable:path.join(folder,'missing-shell'),args:[]}};
 store.updateSession(bad.id,bad.title,'shell','',missing.terminal,null);
 // Model an executable removed after quit, with unchanged registered settings.
 entries.find(entry=>entry.sessionId===bad.id)!.configuration=restartConfiguration(store.session(bad.id),store.project(project.id).path);
 store.updateSession(edited.id,edited.title,'shell','',{profile:'bash',executable:'',args:[]},null);
 store.saveRestartPlan(entries);store.close();
 daemon=new DaemonServer(data);client=await DaemonConnection.open(await daemon.listen(),()=>{});clients.push(client);
 await client.rpc('restoreWorkspace');const state=await completed(client);
 assert.equal(state.recovery!.restored,1);assert.equal(state.recovery!.skipped,1);assert.equal(state.recovery!.errors.length,1);assert.equal(state.recovery!.errors[0].sessionId,bad.id);
 assert.equal(state.sessions.find(session=>session.id===good.id)!.latestRun!.status,'running');assert.equal(state.sessions.find(session=>session.id===bad.id)!.latestRun!.status,'failed');
});

test('SSH restart restores the same session IDs and control grants, retains unknown results and never replays user input', {timeout:25000}, async t => {
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}),peers=new Set<any>(),received:string[]=[],held:any[]=[];let hold=false;
 const ssh=new Server({hostKeys:[keys.privateKey]},peer=>{
  peers.add(peer);peer.on('error',()=>{});peer.on('close',()=>peers.delete(peer));
  peer.on('authentication',ctx=>{if(ctx.method!=='password'||ctx.password!=='fixture-secret'){ctx.reject(['password']);return;}if(hold)held.push(ctx);else ctx.accept();});
  peer.on('ready',()=>peer.on('session',accept=>{const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());session.on('exec',accept=>accept().end('non-POSIX fixture'));session.on('shell',accept=>{const channel=accept();channel.on('error',()=>{});channel.on('data',(bytes:Buffer)=>received.push(bytes.toString()));channel.write('fixture> ');});}));
 });
 await new Promise<void>(resolve=>ssh.listen(0,'127.0.0.1',resolve));const address=ssh.address();assert.ok(address&&typeof address!=='string');
 const folder=mkdtempSync(path.join(tmpdir(),'berth-ssh-recovery-')),data=path.join(folder,'data');let daemon=new DaemonServer(data);const clients:DaemonConnection[]=[];
 t.after(async()=>{for(const client of clients)client.close(true);await daemon.close();for(const peer of peers)peer.end();await new Promise<void>(resolve=>ssh.close(()=>resolve()));rmSync(folder,{recursive:true,force:true,maxRetries:5});});
 const provider=async()=>{let c:DaemonConnection;c=await DaemonConnection.open(await daemon.listen(),event=>{if(event.event==='sshChallenge')void c.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='credentials'?{secret:{password:'fixture-secret'}}:{accepted:true})});});clients.push(c);await c.rpc('registerSshProvider');return c;};
 let ui=await provider();await ui.rpc('saveSshConnection',{config:{alias:'fixture',hostname:'127.0.0.1',port:address.port,username:'fixture',authentication:'password',privateKeyPath:'',allowAgent:true}});
 const agent=await DaemonConnection.open(JSON.parse(readFileSync(path.join(data,'runtime.json'),'utf8')),()=>{});clients.push(agent);
 const automated:any=await agent.rpc('remoteOpen',{alias:'fixture',owner:'agent'}),manual:any=await ui.rpc('remoteOpen',{alias:'fixture',owner:'user'});
 await agent.rpc('remoteKeys',{sessionId:automated.sessionId,runId:automated.runId,text:'USER_INPUT_TAG',enter:true});
 const deadline=Date.now()+3000;while(!received.join('').includes('USER_INPUT_TAG')){assert.ok(Date.now()<deadline);await wait(20);}
 const unknownId=randomUUID();(daemon as any).store.saveRemoteAction({id:unknownId,sessionId:automated.sessionId,runId:automated.runId,kind:'command',label:'previous unknown task',status:'unknown',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),exitCode:null});
 await ui.rpc('shutdown',{restoreOnOpen:true});await daemon.close();
 daemon=new DaemonServer(data);ui=await provider();hold=true;await ui.rpc('restoreWorkspace');
 const readyDeadline=Date.now()+3000;
 while((await ui.rpc<State>('state')).sessions.find(session=>session.id===automated.sessionId)!.latestRun!.id===automated.runId){assert.ok(Date.now()<readyDeadline);await wait(20);}
 const recovered=await DaemonConnection.open(JSON.parse(readFileSync(path.join(data,'runtime.json'),'utf8')),()=>{});clients.push(recovered);
 assert.deepEqual(await recovered.rpc('remoteAgentRecover',{targets:[{sessionId:automated.sessionId,runId:automated.runId}]}),{recovered:[automated.sessionId]},'MCP can reclaim identity before SSH authentication completes');
 hold=false;for(const ctx of held.splice(0))ctx.accept();
 const state=await completed(ui);assert.equal(state.recovery!.restored,2);assert.deepEqual(state.recovery!.errors,[]);
 for(const [target,owner] of [[automated,'agent'],[manual,'user']] as const){const current=state.sessions.find(session=>session.id===target.sessionId)!;assert.notEqual(current.latestRun!.id,target.runId);assert.equal((await ui.rpc<any>('remoteInfo',{sessionId:current.id})).owner,owner);}
 assert.equal(received.join('').split('USER_INPUT_TAG').length-1,1);
 assert.equal((daemon as any).store.unresolvedRemoteAction(automated.sessionId).id,unknownId);
  const own=await recovered.rpc<any>('remoteAgentSessions');assert.deepEqual(own.sessions.map((session:any)=>session.sessionId),[automated.sessionId]);
  await assert.rejects(recovered.rpc('remoteScreen',{sessionId:automated.sessionId,runId:automated.runId}),/运行实例已变化/,'Old run IDs must remain stale instead of replaying input');
});
