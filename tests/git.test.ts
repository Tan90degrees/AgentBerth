import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {GitWorkspace,parseGitStatus,gitMessage} from '../src/daemon/git';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection} from '../src/main/connection';
import type {GitOperation,GitStatus,GitResult,Project,Session,Run,State} from '../src/shared/protocol';

const execute=promisify(execFile);
async function git(cwd:string,...args:string[]){return(await execute('git',['-c','core.autocrlf=false','-c','commit.gpgsign=false','-C',cwd,...args],{encoding:'utf8',windowsHide:true})).stdout.trim();}
async function fixture(t:any){
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth Git 中文 ')),remote=path.join(dir,'remote.git'),a=path.join(dir,'a'),b=path.join(dir,'b');
  const service=new GitWorkspace();
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true,maxRetries:5});});
  await git(dir,'init','--bare','--initial-branch=main',remote);await git(dir,'clone',remote,a);
  for(const cwd of [a]){await git(cwd,'config','user.name','Fixture');await git(cwd,'config','user.email','fixture@example.invalid');}
  await writeFile(path.join(a,'base.txt'),'base\n');await git(a,'add','.');await git(a,'commit','-m','base');await git(a,'push','-u','origin','main');
  await git(dir,'clone',remote,b);await git(b,'config','user.name','Fixture');await git(b,'config','user.email','fixture@example.invalid');
  const operation=async(action:GitOperation['action'],extra:Partial<GitOperation>={})=>{const s=await service.status(a);return service.operate(a,{projectId:'fixture',action,expected:{root:s.root,branch:s.branch,head:s.head},remote:'origin',branch:s.upstreamBranch||s.branch||undefined,...extra});};
  return{dir,remote,a,b,service,operation};
}

test('porcelain v2 parses Unicode, spaces, renamed paths and conflicts without losing record boundaries',()=>{
  const zero='0'.repeat(40),one='1'.repeat(40);
  const parsed=parseGitStatus([`# branch.oid ${one}`,'# branch.head feature/topic','# branch.upstream origin/topic','# branch.ab +3 -2',`1 AM N... 100644 100644 100644 ${zero} ${one} 中文 name.txt`,`2 R. N... 100644 100644 100644 ${zero} ${one} R100 new name.txt`,'old\nname.txt',`u UU N... 100644 100644 100644 100644 ${zero} ${one} ${zero} conflict.txt`,'? untracked 🙂.txt',''].join('\0'),'/repo');
  assert.equal(parsed.branch,'feature/topic');assert.equal(parsed.ahead,3);assert.equal(parsed.behind,2);assert.equal(parsed.total,4);assert.equal(parsed.staged,2);assert.equal(parsed.modified,1);assert.equal(parsed.conflicts,1);assert.equal(parsed.untracked,1);
  assert.equal(parsed.files[1].path,'new name.txt');assert.equal(parsed.files[1].originalPath,'old\nname.txt');
  assert.ok(!gitMessage('fatal https://user:password@example.test/r?access_token=secret').includes('password'));
  assert.ok(!gitMessage('fatal https://user:password@example.test/r?access_token=secret').includes('secret'));
});

test('real repositories report branch, upstream, dirty counts, nested roots and detached/unborn states',async t=>{
  const{dir,a,service}=await fixture(t);await mkdir(path.join(a,'nested'));
  const clean=await service.status(path.join(a,'nested'));assert.equal(clean.kind,'repository');assert.equal(clean.root,await realpath(a));assert.equal(clean.branch,'main');assert.equal(clean.upstreamRemote,'origin');assert.equal(clean.upstreamBranch,'main');assert.equal(clean.total,0);
  await writeFile(path.join(a,'base.txt'),'changed\n');await writeFile(path.join(a,'空 格.txt'),'new');
  const dirty=await service.status(a);assert.equal(dirty.modified,1);assert.equal(dirty.untracked,1);
  await git(a,'checkout','--','base.txt');await rm(path.join(a,'空 格.txt'));await git(a,'checkout','--detach');assert.equal((await service.status(a)).branch,null);
  const empty=path.join(dir,'empty');await mkdir(empty);assert.equal((await service.status(empty)).kind,'not-repository');await git(empty,'init','--initial-branch=fresh');const initial=await service.status(empty);assert.equal(initial.branch,'fresh');assert.equal(initial.head,null);
});

test('fetch, fast-forward pull, pinned push, sync and first publication work with a local bare remote',async t=>{
  const{a,b,remote,service,operation}=await fixture(t);
  await writeFile(path.join(b,'remote.txt'),'remote');await git(b,'add','.');await git(b,'commit','-m','remote');await git(b,'push');
  await operation('fetch');assert.equal((await service.status(a)).behind,1);
  const pulled=await operation('pull');assert.equal(pulled.status.behind,0);assert.equal(await readFile(path.join(a,'remote.txt'),'utf8'),'remote');
  await writeFile(path.join(a,'local.txt'),'local');await git(a,'add','.');await git(a,'commit','-m','local');assert.equal((await service.status(a)).ahead,1);
  await operation('sync');assert.equal(await git(remote,'rev-parse','refs/heads/main'),await git(a,'rev-parse','HEAD'));
  await git(a,'switch','-c','feature/new');await operation('push');const published=await service.status(a);assert.equal(published.upstream,'origin/feature/new');assert.equal(published.upstreamBranch,'feature/new');
  await operation('switch',{branch:'main'});assert.equal((await service.status(a)).branch,'main');
});

test('unrelated edits survive pull/switch while overlapping edits, changed previews and divergence are protected',async t=>{
  const{a,b,remote,service,operation}=await fixture(t);
  await git(a,'branch','feature/same');
  await writeFile(path.join(a,'local-only.txt'),'keep me');await writeFile(path.join(a,'base.txt'),'local edit');
  await writeFile(path.join(b,'unrelated.txt'),'remote');await git(b,'add','.');await git(b,'commit','-m','unrelated');await git(b,'push');
  await operation('pull');await operation('sync');await operation('switch',{branch:'feature/same'});
  assert.equal(await readFile(path.join(a,'base.txt'),'utf8'),'local edit');assert.equal(await readFile(path.join(a,'local-only.txt'),'utf8'),'keep me');
  await operation('switch',{branch:'main'});
  await writeFile(path.join(b,'base.txt'),'remote edit');await git(b,'add','.');await git(b,'commit','-m','overlap');await git(b,'push');
  const before=await git(a,'rev-parse','HEAD');
  await assert.rejects(operation('pull'),/overwritten|local changes/);assert.equal(await git(a,'rev-parse','HEAD'),before);
  assert.equal(await readFile(path.join(a,'base.txt'),'utf8'),'local edit');assert.equal(await git(a,'stash','list'),'');
  await git(a,'checkout','--','base.txt');await operation('pull');
  await writeFile(path.join(a,'base.txt'),'local edit again');
  await assert.rejects(operation('switch',{branch:'feature/same'}),/overwritten|local changes/);
  assert.equal((await service.status(a)).branch,'main');assert.equal(await readFile(path.join(a,'base.txt'),'utf8'),'local edit again');
  await git(a,'checkout','--','base.txt');await rm(path.join(a,'local-only.txt'));
  const old=await service.status(a);await git(a,'switch','-c','changed');await assert.rejects(service.operate(a,{projectId:'x',action:'push',remote:'origin',expected:{root:old.root,head:old.head,branch:old.branch}}),/已变化/);await git(a,'switch','main');
  await writeFile(path.join(a,'a.txt'),'a');await git(a,'add','.');await git(a,'commit','-m','a');const local=await git(a,'rev-parse','HEAD');
  await writeFile(path.join(b,'b.txt'),'b');await git(b,'add','.');await git(b,'commit','-m','b');await git(b,'push');const theirs=await git(remote,'rev-parse','refs/heads/main');
  await assert.rejects(operation('sync'),/fast-forward/);assert.equal(await git(a,'rev-parse','HEAD'),local);assert.equal(await git(remote,'rev-parse','refs/heads/main'),theirs);
  await assert.rejects(operation('push'),/rejected|fetch first|non-fast-forward/);assert.equal(await git(remote,'rev-parse','refs/heads/main'),theirs);
});

test('RPC pull, sync and branch switching preserve a running nested project PTY and its input/output', {timeout:20000},async t=>{
  const{dir,a,b}=await fixture(t);const sub=path.join(a,'nested');await mkdir(sub);const server=new DaemonServer(path.join(dir,'data'));const c=await DaemonConnection.open(await server.listen(),()=>{});
  // Close SQLite/PTY resources before fixture cleanup on Windows.
  const shutdown=async()=>{c.close();await server.close();};
  try{
    const p=await c.rpc<Project>('createProject',{name:'Root',path:a}),nested=await c.rpc<Project>('createProject',{name:'Nested',path:sub});
    const s=await c.rpc<Session>('createSession',{projectId:nested.id,title:'Nested shell',agent:'shell',command:''});const run=await c.rpc<Run>('start',{sessionId:s.id,cols:80,rows:24});
    await writeFile(path.join(b,'remote.txt'),'live pull');await git(b,'add','.');await git(b,'commit','-m','live pull');await git(b,'push');
    const operation=async(action:GitOperation['action'],branch?:string)=>{const status=await c.rpc<GitStatus>('gitStatus',{projectId:p.id});return c.rpc<GitResult>('gitOperation',{projectId:p.id,action,remote:'origin',branch:branch||status.upstreamBranch||status.branch,expected:{root:status.root,head:status.head,branch:status.branch}});};
    await operation('fetch');await operation('pull');assert.equal(await readFile(path.join(a,'remote.txt'),'utf8'),'live pull');
    await git(a,'branch','feature/live');await operation('switch','feature/live');await operation('sync');await operation('switch','main');
    const current=(await c.rpc<State>('state')).sessions.find(value=>value.id===s.id)!;assert.equal(current.latestRun!.id,run.id);assert.equal(current.latestRun!.pid,run.pid);assert.equal(current.latestRun!.status,'running');
    await c.rpc('attach',{sessionId:s.id});await c.rpc('resize',{sessionId:s.id,runId:run.id,cols:90,rows:28});await c.rpc('input',{sessionId:s.id,runId:run.id,data:'echo LIVE_GIT_PTY_OK\r'});
    const deadline=Date.now()+5000;
    while((await c.rpc<{snapshot:string}>('attach',{sessionId:s.id})).snapshot.split('LIVE_GIT_PTY_OK').length<3){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,40));}
    const status=await c.rpc<GitStatus>('gitStatus',{projectId:p.id});await assert.rejects(c.rpc('gitOperation',{projectId:p.id,action:'push',remote:'--bad',expected:{root:status.root,head:status.head,branch:status.branch}}),/远端/);
  }finally{await shutdown();}
});

test('a Git RPC exceeding 15 seconds leaves session creation, terminal start, history links and I/O available', {timeout:45000},async t=>{
  const{dir,a}=await fixture(t),server=new DaemonServer(path.join(dir,'data')),c=await DaemonConnection.open(await server.listen(),()=>{});
  let pending:Promise<GitResult>|undefined;
  try{
    const helper=path.join(dir,'delayed-upload.cjs'),marker=path.join(dir,'started');
    const node=(await execute('node',['-p','process.execPath'],{encoding:'utf8',windowsHide:true})).stdout.trim();
    await writeFile(helper,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>{const c=require('node:child_process').spawn('git',['upload-pack',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});c.on('error',()=>process.exit(1));c.on('exit',code=>process.exit(code??1));},16000);`);
    const quote=(value:string)=>'"'+value.replaceAll('\\','/')+'"';await git(a,'config','remote.origin.uploadpack',quote(node)+' '+quote(helper));
    const p=await c.rpc<Project>('createProject',{name:'Live Git',path:a}),status=await c.rpc<GitStatus>('gitStatus',{projectId:p.id});
    pending=c.rpc<GitResult>('gitOperation',{projectId:p.id,action:'fetch',remote:'origin',expected:{root:status.root,head:status.head,branch:status.branch}});
    // Attach rejection handling immediately while performing concurrent requests.
    void pending.catch(()=>{});
    const deadline=Date.now()+8000;while(true){try{await readFile(marker);break;}catch{assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,40));}}
    const s=await c.rpc<Session>('createSession',{projectId:p.id,title:'During fetch',agent:'shell',command:''});
    const run=await c.rpc<Run>('start',{sessionId:s.id,cols:80,rows:24});await c.rpc('attach',{sessionId:s.id});await c.rpc('input',{sessionId:s.id,runId:run.id,data:'echo CONCURRENT_GIT_IO_OK\r'});
    const native=await c.rpc<Session>('createSession',{projectId:p.id,title:'History',agent:'codex',command:''});await c.rpc('linkNativeSession',{sessionId:native.id,nativeSessionId:'live-fetch-history'});await c.rpc('unlinkNativeSession',{sessionId:native.id});
    await assert.rejects(c.rpc('updateProject',{projectId:p.id,name:'Changed',path:a}),/Git/);
    const result=await pending;assert.equal(result.status.kind,'repository');
    assert.ok((await c.rpc<{snapshot:string}>('attach',{sessionId:s.id})).snapshot.includes('CONCURRENT_GIT_IO_OK'));
    assert.equal((await c.rpc<State>('state')).sessions.find(value=>value.id===s.id)!.latestRun!.pid,run.pid);
  }finally{c.close();await server.close();if(pending)await Promise.allSettled([pending]);}
});

test('slow fetches are serialized per repository and full shutdown cancels Git and its descendants', {timeout:25000},async t=>{
  const{dir,a,service}=await fixture(t);
  const helper=path.join(dir,'wait-upload.cjs'),pidFile=path.join(dir,'upload.pid');
  const node=(await execute('node',['-p','process.execPath'],{encoding:'utf8',windowsHide:true})).stdout.trim();
  await writeFile(helper,`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const quote=(value:string)=>'"'+value.replaceAll('\\','/')+'"';
  await git(a,'config','remote.origin.uploadpack',quote(node)+' '+quote(helper));
  const status=await service.status(a),request:GitOperation={projectId:'x',action:'fetch',remote:'origin',expected:{root:status.root,branch:status.branch,head:status.head}};
  const pending=service.operate(a,request);const rejected=assert.rejects(pending,/取消/);
  const deadline=Date.now()+10000;let pid=0;
  while(!pid){assert.ok(Date.now()<deadline,'Upload helper did not start');try{pid=Number(await readFile(pidFile,'utf8'));}catch{}await new Promise(resolve=>setTimeout(resolve,40));}
  await assert.rejects(service.operate(a,request),/正在进行 Git/);
  await service.close();await rejected;
  try{process.kill(pid,0);assert.ok(process.platform==='linux'&&/\) Z /.test(await readFile(`/proc/${pid}/stat`,'utf8')),'Git helper survived shutdown');}catch(error){assert.ok(['ESRCH','ENOENT'].includes((error as NodeJS.ErrnoException).code!));}
});
