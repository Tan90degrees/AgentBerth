import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {DaemonConnection} from '../src/main/connection';
import {WorkspaceTargets} from '../src/main/workspace-target';
import {readWorkspaceServerToken,workspaceServerOptions} from '../src/daemon/workspace-server';
import {workspaceServerAddress, type WorkspaceDirectoryPage} from '../src/shared/workspace-server';
import type {AgentDefinition,Attachment,FilePreview,GitStatus,Project,Run,ServerEvent,Session,State} from '../src/shared/protocol';

const linux={skip:process.platform!=='linux'};

test('workspace server endpoints accept verified TLS and loopback tunnels only',()=>{
  assert.equal(workspaceServerAddress('https://server.example.com:7467/rpc'),'wss://server.example.com:7467');
  assert.equal(workspaceServerAddress('ws://127.0.0.1:17467/'),'ws://127.0.0.1:17467');
  for(const url of ['ws://server.example.com:7467','wss://server.example.com/path','wss://server.example.com?token=visible','wss://alice:secret@example.com','file:///etc/passwd']){
    assert.throws(()=>workspaceServerAddress(url));
  }
});

test('workspace target storage separates remembered credentials from session-only connections',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'berth-target-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const address='wss://server.example.com:7467',token=randomBytes(32).toString('hex'),file=path.join(root,'target.json');
  const vault={isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(value).reverse(),decryptString:(data:Buffer)=>Buffer.from(data).reverse().toString()};
  const target=new WorkspaceTargets(file,vault);
  target.select(target.endpoint(address,token),true);
  assert.ok(!(await readFile(file,'utf8')).includes(token));
  assert.ok(!JSON.stringify(target.state()).includes(token));
  const restored=new WorkspaceTargets(file,vault);restored.load();
  assert.equal(restored.active?.token,token);
  assert.throws(()=>restored.endpoint('wss://another.example.com'),/令牌/);
  restored.select(undefined);
  const local=new WorkspaceTargets(file,vault);local.load();
  assert.equal(local.active,undefined);
  assert.equal(local.endpoint(address).token,token);
  target.select(target.endpoint(address,token),false);
  const sessionOnly=new WorkspaceTargets(file,vault);sessionOnly.load();
  assert.equal(sessionOnly.active,undefined);
  assert.equal(sessionOnly.state().savedToken,false);
});

async function freePort(){
  const socket=createServer();
  socket.listen(0,'127.0.0.1');
  await once(socket,'listening');
  const address=socket.address();
  assert.ok(address&&typeof address==='object');
  await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  return address.port;
}

async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){
  const deadline=Date.now()+10_000;
  let last:unknown;
  do{
    try{const value=await read();if(accept(value))return value;last=value;}catch(error){last=error;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }while(Date.now()<deadline);
  throw new Error('Workspace server did not reach expected state', {cause:last});
}

test('Linux server starts headlessly, authenticates TLS, preserves PTYs after disconnect and reopens its data',linux,async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'berth-linux-server-')),data=path.join(root,'data'),workspace=path.join(root,'project');
  await mkdir(path.join(workspace,'child'),{recursive:true});
  await mkdir(path.join(root,'fixture'));
  await writeFile(path.join(workspace,'README.md'),'# server file');
  execFileSync('git',['init','-b','main',workspace],{stdio:'ignore'});
  const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem'),port=await freePort();
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  assert.throws(()=>workspaceServerOptions(root,{bind:'0.0.0.0'}),/必须配置 TLS/);
  const address='wss://127.0.0.1:'+port,ca=await readFile(cert,'utf8');
  const args=['--data-dir',data,'--bind','127.0.0.1','--port',String(port),'--tls-key',key,'--tls-cert',cert];
  const packaged=process.env.AGENTBERTH_TEST_SERVER;
  const executable=packaged??process.execPath;
  const cli=packaged?args:[path.resolve('dist/daemon.cjs'),'--server',...args];
  const clients=new Set<DaemonConnection>();
  let child:ReturnType<typeof spawn>|undefined,stderr='';
  async function stop(){
    for(const client of clients)client.close(true);
    clients.clear();
    if(child&&child.exitCode===null&&child.signalCode===null&&child.pid){
      const exit=once(child,'exit');child.kill('SIGTERM');
      const timeout=setTimeout(()=>child?.kill('SIGKILL'),15000);
      const [code]=await exit.finally(()=>clearTimeout(timeout));
      assert.equal(code,0,stderr);
    }
    child=undefined;
  }
  t.after(async()=>{try{await stop();}finally{await rm(root,{recursive:true,force:true,maxRetries:4});}});
  async function start(){
    stderr='';
    child=spawn(executable,cli,{stdio:['ignore','ignore','pipe']});
    child.stderr?.on('data',data=>stderr+=String(data));
    return until(async()=>{
      const token=readWorkspaceServerToken(data);
      const connection=await DaemonConnection.openWorkspace({address,ca,token},()=>{});
      clients.add(connection);return {connection,token};
    },()=>true);
  }
  const {connection,token}=await start();
  assert.equal((await stat(path.join(data,'server-token'))).mode&0o777,0o600);
  assert.equal(execFileSync(executable,[...cli,'--token'],{encoding:'utf8'}).trim(),token);
  await assert.rejects(DaemonConnection.openWorkspace({address,ca,token:'0'.repeat(64)},()=>{}),/401/);
  await assert.rejects(DaemonConnection.openWorkspace({address,token},()=>{}),/self.signed|certificate/i);
  await assert.rejects(new Promise<void>((resolve,reject)=>{
    const browser=new WebSocket(address+'/rpc',{ca,origin:'https://example.invalid',headers:{Authorization:'Bearer '+token}});
    browser.once('open',()=>{browser.close();resolve();});browser.once('error',reject);
  }),/401/);
  const directories=await connection.rpc<WorkspaceDirectoryPage>('workspaceDirectories',{path:workspace});
  assert.ok(directories.directories.some(entry=>entry.name==='child'));
  await assert.rejects(connection.rpc('shutdown'),/Linux 服务/);
  const project=await connection.rpc<Project>('createProject',{name:'Hosted',path:workspace});
  assert.equal((await connection.rpc<FilePreview>('previewFile',{projectId:project.id,path:'README.md'})).content,'# server file');
  assert.equal((await connection.rpc<GitStatus>('gitStatus',{projectId:project.id})).kind,'repository');
  const session=await connection.rpc<Session>('createSession',{projectId:project.id,title:'Hosted shell',agent:'shell'});
  const dimensions={sessionId:session.id,cols:100,rows:30};
  const run=await connection.rpc<Run>('start',dimensions);
  await connection.rpc('attach',{sessionId:session.id});
  await connection.rpc('input',{sessionId:session.id,runId:run.id,data:"sleep .3; printf 'HOSTED_%s\\n' STILL_RUNNING\r"});
  connection.close(true);
  const next=await DaemonConnection.openWorkspace({address,token,ca},()=>{});
  clients.add(next);
  await until(()=>next.rpc<Attachment>('attach',{sessionId:session.id}),view=>view.snapshot.includes('HOSTED_STILL_RUNNING'));
  assert.equal((await next.rpc<State>('state')).sessions.find(s=>s.id===session.id)?.latestRun?.status,'running');
  await next.rpc('stop',{sessionId:session.id});
  const acpEvents:ServerEvent[]=[];
  const acpClient=await DaemonConnection.openWorkspace({address,token,ca},event=>acpEvents.push(event));
  clients.add(acpClient);
  const agent=await acpClient.rpc<AgentDefinition>('createAgent',{name:'Server ACP',command:process.execPath,acp:{
    executable:process.execPath,args:[path.resolve('tests/fixtures/acp-agent.cjs'),path.join(root,'fixture')],env:{ELECTRON_RUN_AS_NODE:'1'},
  }});
  const acpSession=await acpClient.rpc<Session>('createSession',{projectId:project.id,title:'Hosted ACP',agent:agent.id});
  await acpClient.rpc('acpSend',{sessionId:acpSession.id,requestId:randomUUID(),text:'hello'});
  await until(async()=>acpEvents.filter(event=>event.event==='acp'&&event.data.sessionId===acpSession.id&&event.data.event?.kind==='assistant').length,count=>count>=2);
  await acpClient.rpc('stop',{sessionId:acpSession.id});
  await stop();
  const restarted=await start();
  assert.equal(restarted.token,token);
  assert.equal((await restarted.connection.rpc<State>('state')).projects.find(p=>p.id===project.id)?.path,workspace);
  await stop();
});
