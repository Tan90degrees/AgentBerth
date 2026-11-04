import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection} from '../src/main/connection';
import {resolveExecutable} from '../src/daemon/executables';
import {serviceShell} from '../src/daemon/paths';
import {Store} from '../src/daemon/store';
import type {Project,Session,Run,Attachment} from '../src/shared/protocol';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await wait(30);}throw new Error('Condition timed out');}
async function setup(t:any){
  const root=await mkdtemp(path.join(os.tmpdir(),'berth-services-')),data=path.join(root,'data'),server=new DaemonServer(data);
  const connection=await DaemonConnection.open(await server.listen(),()=>{}),project=await connection.rpc<Project>('createProject',{name:'Services',path:root});
  t.after(async()=>{connection.close();await server.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {root,data,connection,project};
}
test('service shell retains command quoting and exits instead of leaving an interactive prompt',()=>{
  const command='& "C:\\Program Files\\node.exe" "C:\\my project\\app.js"; exit 7';
  const ps=serviceShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoExit'],command);
  assert.ok(Array.isArray(ps.args));assert.ok(!ps.args.includes('-NoExit'));assert.ok(ps.args.includes('-NonInteractive'));
  assert.equal(Buffer.from(ps.args.at(-1)!,'base64').toString('utf16le'),command+'\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }');
  assert.equal(serviceShell('cmd.exe',[],'"C:\\my project\\app.cmd" "a b"').args,'/d /s /c ""C:\\my project\\app.cmd" "a b""');
  assert.deepEqual(serviceShell('/bin/bash',['-i'],'printf "%s" "a b"').args,['-c','printf "%s" "a b"']);
  assert.throws(()=>serviceShell('node',[],'run'),/请选择/);
});
test('service sessions persist, validate startup configuration and capture the actual exit code',async t=>{
  const f=await setup(t),id=randomUUID(),params={projectId:f.project.id,requestId:id,title:'Finite service',agent:'shell',service:true,command:process.platform==='win32'?'Write-Output SERVICE_COMPLETE; exit 7':'printf SERVICE_COMPLETE; exit 7'};
  const first=await f.connection.rpc<Session>('createSession',params);assert.equal(first.service,true);
  assert.equal((await f.connection.rpc<Session>('createSession',params)).id,first.id);
  await assert.rejects(f.connection.rpc('createSession',{...params,service:false}),/请求 ID/);
  await assert.rejects(f.connection.rpc('createSession',{...params,requestId:randomUUID(),command:''}),/服务/);
  await assert.rejects(f.connection.rpc('createSession',{...params,requestId:randomUUID(),agent:'codex'}),/服务/);
  const run=await f.connection.rpc<Run>('start',{sessionId:first.id,resume:false,cols:100,rows:30});
  await until(async()=>(await f.connection.rpc<Attachment>('attach',{sessionId:first.id})).run?.status==='exited');
  const ended=await f.connection.rpc<Attachment>('attach',{sessionId:first.id});assert.equal(ended.run?.exitCode,7);assert.match(await f.connection.rpc<string>('output',{runId:run.id}),/SERVICE_COMPLETE/);
  const saved=new Store(f.data);assert.equal(saved.session(first.id).service,true);assert.equal(saved.session(first.id).command,params.command);saved.close();
});
test('service output rejects typing and binary input, and restart kills the tree before launching once',async t=>{
  const f=await setup(t),node=await resolveExecutable('node'),counter=path.join(f.root,'starts.jsonl');
  const quote=(value:string)=>"'"+value.replaceAll("'",process.platform==='win32'?"''":"'\\''")+"'";
  const command=(process.platform==='win32'?'& ':'')+[node,path.resolve('tests/fixtures/service-job.cjs'),counter].map(quote).join(' ');
  const session=await f.connection.rpc<Session>('createSession',{projectId:f.project.id,title:'Long service',agent:'shell',command,service:true});
  const run=await f.connection.rpc<Run>('serviceAction',{sessionId:session.id,action:'start',cols:100,rows:30});
  await until(async()=>(await f.connection.rpc<Attachment>('attach',{sessionId:session.id})).snapshot.includes('SERVICE_READY'));
  const starts=async()=>JSON.parse((await readFile(counter,'utf8')).trim().split('\n')[0]);const initial=await starts();
  for(const binary of [false,true])await assert.rejects(f.connection.rpc('input',{sessionId:session.id,runId:run.id,data:'BAD_INPUT\r',binary}),/只读/);
  await assert.rejects(f.connection.rpc('updateSession',{sessionId:session.id,title:session.title,agent:'shell',command,service:false}),/停止/);
  await f.connection.rpc('serviceAction',{sessionId:session.id,action:'restart',cols:100,rows:30});
  await until(async()=>(await readFile(counter,'utf8')).trim().split('\n').length===2);
  await f.connection.rpc('serviceAction',{sessionId:session.id,action:'stop',cols:100,rows:30});
  await until(async()=>{try{process.kill(initial.pid,0);return false;}catch{return true;}});
  if(process.platform==='win32')assert.throws(()=>process.kill(initial.child,0));
  else {try{const stat=await readFile('/proc/'+initial.child+'/stat','utf8');assert.equal(stat.split(') ')[1][0],'Z','A killed child may await its container reaper');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  assert.equal((await f.connection.rpc<Attachment>('attach',{sessionId:session.id})).run?.status,'stopped');
  assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,2);
  await f.connection.rpc('serviceAction',{sessionId:session.id,action:'stop',cols:100,rows:30});
});
test('schema 7 upgrade preserves ordinary sessions and defaults service mode off',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'berth-services-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let store=new Store(root);const project=store.createProject('Existing',root),session=store.createSession(project.id,'Shell','shell','');store.close();
  const db=new DatabaseSync(path.join(root,'berth.sqlite'));db.exec('ALTER TABLE sessions DROP COLUMN service; PRAGMA user_version=7;');db.close();
  store=new Store(root);assert.equal(store.session(session.id).service,false);assert.equal(store.session(session.id).command,'');store.close();
});


test('Windows service shells preserve quoted paths and arguments and return native process exit codes',{skip:process.platform!=='win32'},async t=>{
  const f=await setup(t),node=await resolveExecutable('node'),script='process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exit(9)';
  for(const profile of ['powershell','cmd']){
    const values=[node,'-e',script,'a b','c&d'],command=profile==='cmd'?values.map(value=>'"'+value+'"').join(' '):'& '+values.map(value=>"'"+value.replaceAll("'","''")+"'").join(' ');
    const session=await f.connection.rpc<Session>('createSession',{projectId:f.project.id,title:profile,agent:'shell',service:true,command,terminal:{profile,executable:'',args:[]}});
    const run=await f.connection.rpc<Run>('serviceAction',{sessionId:session.id,action:'start',cols:100,rows:30});
    await until(async()=>(await f.connection.rpc<Attachment>('attach',{sessionId:session.id})).run?.status==='exited');
    assert.equal((await f.connection.rpc<Attachment>('attach',{sessionId:session.id})).run?.exitCode,9,profile);
    assert.match(await f.connection.rpc<string>('output',{runId:run.id}),/\["a b","c&d"\]/);
  }
});
