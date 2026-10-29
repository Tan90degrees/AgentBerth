import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { SshTerminal } from '../src/daemon/ssh-terminal';
import { SshVault } from '../src/main/ssh-vault';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { TerminalMcp } from '../src/mcp/server';
import { sshConnectionSchema, type SshConnection, type SshConnectionConfig, type RemoteInfo, type RemoteAction, type Session, type State, type Project } from '../src/shared/protocol';

const config = (): SshConnectionConfig => ({alias:'test-server',hostname:'127.0.0.1',port:22,username:'fixture-user',authentication:'password',privateKeyPath:'',allowAgent:true});
const temporary = () => mkdtempSync(path.join(tmpdir(),'ab-ssh-profile-'));

test('SSH sessions can be created and managed without a local project', async t => {
  const folder=temporary(), daemon=new DaemonServer(path.join(folder,'data'));
  const ui=await DaemonConnection.open(await daemon.listen(),()=>{});
  t.after(async()=>{ui.close();await daemon.close();rmSync(folder,{recursive:true,force:true});});
  assert.equal((await ui.rpc<State>('state')).projects.length,0);
  await assert.rejects(ui.rpc('createRemoteSession',{title:'Invalid',remote:{connectionId:randomUUID(),host:'missing',directory:''}}));
  assert.equal((await ui.rpc<State>('state')).projects.length,0,'Validation must not create an empty workspace');
  const remote={host:'fixture-server',directory:'/tmp'};
  const first=await ui.rpc<Session>('createRemoteSession',{title:'SSH A',remote});
  const second=await ui.rpc<Session>('createRemoteSession',{title:'SSH B',remote});
  assert.equal(first.projectId,second.projectId);
  assert.equal(first.agent,'shell');assert.equal(first.terminal,null);assert.equal(first.latestRun,null);
  assert.deepEqual(first.remote,remote);
  const managed=(await ui.rpc<State>('state')).projects;
  assert.equal(managed.length,1);assert.equal(managed[0].remoteWorkspace,true);
  const local=await ui.rpc<Project>('createProject',{name:'Local project',path:folder});
  const localSession=await ui.rpc<Session>('createSession',{projectId:local.id,title:'Local session',agent:'shell'});
  assert.notEqual(first.projectId,localSession.projectId);
  await ui.rpc('deleteProject',{projectId:local.id});
  await ui.rpc('updateSession',{sessionId:first.id,title:'SSH renamed',agent:'shell',remote:{...remote,directory:'/var/tmp'}});
  const state=await ui.rpc<State>('state');
  assert.equal(state.sessions.length,2);assert.equal(state.sessions.find(item=>item.id===first.id)?.remote?.directory,'/var/tmp');
  await ui.rpc('deleteSession',{sessionId:first.id});await ui.rpc('deleteSession',{sessionId:second.id});
  assert.equal((await ui.rpc<State>('state')).sessions.length,0);
});

test('SSH password vault keeps memory-only secrets off disk and refuses plaintext fallback', () => {
  const folder=temporary();
  try {
    const file=path.join(folder,'secrets.json');
    const encryption={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text',encryptString:()=>{throw new Error('must not encrypt');},decryptString:()=>{throw new Error('must not decrypt');}};
    const vault=new SshVault(file,encryption), id=randomUUID();
    vault.save(id,{password:'fixture-secret'},false);
    assert.equal(vault.get(id).password,'fixture-secret');
    assert.equal(readFileSync(file,'utf8'),'{}');
    assert.deepEqual(new SshVault(file,encryption).get(id),{});
    assert.throws(()=>vault.save(id,{password:'fixture-secret'},true),/安全凭据存储/);
    assert.equal(readFileSync(file,'utf8'),'{}');
    vault.delete(id); assert.deepEqual(vault.get(id),{});
    assert.equal(sshConnectionSchema.safeParse({...config(),password:'fixture-secret'}).success,false);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('password SSH + alias MCP opens one visible session, verifies host keys, respects takeover and hides credentials', {timeout:20000}, async t => {
  // An actual SSH protocol handshake, password auth and PTY channel, on both CI platforms.
  const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const connections=new Set<any>(); let authAttempts=0, handshakes=0, shellChannels=0, windows=0, commands=0;
  let holdAuthentication=false, authHeld: (()=>void) | undefined;
  const ssh=new Server({hostKeys:[key.privateKey]}, client=>{
    connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));
    client.on('authentication',context=>{authAttempts++;if(holdAuthentication){authHeld?.();return;}if(context.method==='password'&&context.username==='fixture-user'&&context.password==='fixture-secret')context.accept();else context.reject(['password']);});
    client.on('ready',()=>{handshakes++;client.on('session',accept=>{
      const session=accept();session.on('pty',accept=>{accept?.();});session.on('window-change',accept=>{windows++;accept?.();});
      session.on('exec',(accept,_reject,info)=>{
        const channel=accept();
        if(info.command.startsWith('case x')) {channel.end('AgentBerth_POSIX');return;}
        shellChannels++;
        const sessionId=/AgentBerth;([^;]+);ready/.exec(info.command)![1];
        channel.write(`\x1b]777;AgentBerth;${sessionId};ready;;0;/fixture\x07$ `);
        let input='';channel.on('data',(bytes:Buffer)=>{
          input+=bytes.toString();
          if(!input.includes('\r'))return;
          const request=/start;([a-f0-9-]+)/.exec(input)?.[1];
          if(request){commands++;channel.write(`\x1b]777;AgentBerth;${sessionId};start;${request}\x07fixture-command-output\r\n\x1b]777;AgentBerth;${sessionId};ready;${request};0;/fixture\x07$ `);}
          input='';
        });
      });
    });});
  });
  await new Promise<void>(resolve=>ssh.listen(0,'127.0.0.1',resolve));
  const address=ssh.address();assert.ok(address&&typeof address!=='string');
  const folder=temporary(), daemon=new DaemonServer(path.join(folder,'data')), runtime=await daemon.listen();
  let ui:DaemonConnection;let password='fixture-secret', hostConfirmations=0, rejectTrust=false;
  ui=await DaemonConnection.open(runtime,event=>{
    if(event.event==='sshChallenge') {
      if(event.data.kind==='hostKey'){hostConfirmations++;assert.match(event.data.fingerprint!,/^SHA256:/);}
      void ui.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='credentials'?{secret:{password}}:{accepted:!rejectTrust})});
    }
  });
  let onAgentClosed=()=>{};
  const openAgent=()=>DaemonConnection.open(runtime,event=>{if(event.event==='connection'&&!event.data.connected)onAgentClosed();});
  let agent=await openAgent(),mcp=new TerminalMcp(agent);let knownTarget:{sessionId:string;runId:string}|undefined;let competitor:DaemonConnection|undefined;
  const reconnectMcp=async()=>{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('MCP socket did not close')),3000);onAgentClosed=()=>{clearTimeout(timer);resolve();};agent.close();});
    await ui.rpc('state');agent=await openAgent();mcp=new TerminalMcp(agent);if(knownTarget)await agent.rpc('remoteAgentRecover',{targets:[knownTarget]});
  };
  t.after(async()=>{await ui.rpc('shutdown').catch(()=>{});competitor?.close();agent.close();ui.close();await daemon.close();for(const client of connections)client.end();ssh.close();rmSync(folder,{recursive:true,force:true});});
  await ui.rpc('registerSshProvider');
  await assert.rejects(agent.rpc('registerSshProvider'),/已连接/);
  const profile=await ui.rpc<SshConnection>('saveSshConnection',{config:{...config(),port:address.port}});
  await assert.rejects(ui.rpc('saveSshConnection',{config:{...config(),port:address.port}}),/别名已存在/);
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const result:any=await mcp.request('tools/call',{name,arguments:args});
    if(result.isError)throw new Error(JSON.parse(result.content[0].text).error.message);
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual((await call('terminal_list')).connections,[{alias:'test-server',allowAgent:true}]);
  rejectTrust=true;await assert.rejects(call('terminal_open',{alias:'test-server'}),/指纹/);
  rejectTrust=false;password='wrong-fixture-secret';await assert.rejects(call('terminal_open',{alias:'test-server'}),/认证失败/);
  password='fixture-secret';const opened=await Promise.all(Array.from({length:4},()=>call('terminal_open',{alias:'test-server'})));const target=opened[0];knownTarget={sessionId:target.sessionId,runId:target.runId};
  assert.equal(new Set(opened.map(value=>value.runId)).size,1,'Repeated opens share one in-flight SSH connection');
  assert.equal(target.info.owner,'agent');assert.equal(hostConfirmations,2);assert.equal(handshakes,1);assert.equal(shellChannels,1);
  const again=await call('terminal_open',{alias:'test-server'});assert.equal(again.runId,target.runId);assert.equal(shellChannels,1);
  await assert.rejects(ui.rpc('saveSshConnection',{connectionId:profile.id,config:{...config(),port:address.port}}),/停止终端/);
  const action:RemoteAction=await call('terminal_execute',{alias:'test-server',requestId:randomUUID(),command:'printf fixture-command-output'});
  assert.equal(action.status,'completed');assert.equal(action.exitCode,0);
  const fast:any=action;assert.equal(fast.output.text,'fixture-command-output\r\n');assert.equal(fast.output.hasMore,false);assert.equal(fast.info.phase,'idle');assert.ok(fast.requestMs>=0);
  const drained=await call('terminal_read_output',{alias:'test-server',actionId:action.id,cursor:fast.output.nextCursor,timeoutMs:0});
  assert.equal(drained.output.text,'');assert.equal(drained.status,'completed');
  competitor=await DaemonConnection.open(runtime,()=>{});
  await assert.rejects(competitor.rpc('remoteExecute',{sessionId:target.sessionId,runId:target.runId,requestId:randomUUID(),command:'printf BLOCKED'}),/另一个 Agent/);
  const controlsBefore=(await ui.rpc<RemoteAction[]>('remoteActions',{sessionId:target.sessionId})).filter(item=>item.kind==='control').length;
  await reconnectMcp();
  assert.equal((await ui.rpc<RemoteInfo>('remoteInfo',{sessionId:target.sessionId})).owner,'agent');
  assert.equal((await call('terminal_execute',{alias:'test-server',requestId:action.id,command:'printf fixture-command-output'})).id,action.id);
  assert.equal(commands,1,'MCP reconnection must recover the prior result without executing again');
  await call('terminal_execute',{alias:'test-server',command:'printf NEXT_COMMAND'});assert.equal(commands,2);
  assert.equal((await ui.rpc<RemoteAction[]>('remoteActions',{sessionId:target.sessionId})).filter(item=>item.kind==='control').length,controlsBefore);
  for(const connection of connections)connection.end();
  const disconnectDeadline=Date.now()+3000;
  while((await ui.rpc<RemoteInfo>('remoteInfo',{sessionId:target.sessionId})).connection!=='disconnected'){
    if(Date.now()>disconnectDeadline)throw new Error('SSH did not disconnect');await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await ui.rpc<RemoteInfo>('remoteInfo',{sessionId:target.sessionId})).owner,'agent');
  assert.equal((await call('terminal_reconnect',{alias:'test-server'})).info.owner,'agent');
  await assert.rejects(competitor.rpc('remoteExecute',{sessionId:target.sessionId,runId:target.runId,requestId:randomUUID(),command:'printf BLOCKED'}),/另一个 Agent/);
  const afterReconnect=await call('terminal_execute',{alias:'test-server',command:'printf AFTER_SSH_RECONNECT'});assert.equal(afterReconnect.status,'completed');
  assert.match((await call('terminal_screen',{alias:'test-server'})).text,/fixture-command-output/);
  await ui.rpc('attach',{sessionId:target.sessionId});
  await ui.rpc('resize',{sessionId:target.sessionId,runId:target.runId,cols:112,rows:32});
  await ui.rpc('remoteControl',{sessionId:target.sessionId,runId:target.runId,owner:'user'});
  await reconnectMcp();
  assert.equal((await call('terminal_open',{alias:'test-server'})).info.owner,'user');
  await assert.rejects(call('terminal_keys',{alias:'test-server',key:'Enter'}),/用户控制/);
  await assert.rejects(call('terminal_keys',{alias:'test-server',text:'printf SHOULD_NOT_RUN'}),/用户控制/);
  assert.equal((await call('terminal_read_output',{alias:'test-server',timeoutMs:0})).id,afterReconnect.id,'Read-only recovery stays available during human takeover');
  const state=await ui.rpc<any>('state');assert.equal(state.sessions.length,1);assert.equal(state.projects.find((project:any)=>project.id===state.sessions[0].projectId).remoteWorkspace,true);
  const exposed=JSON.stringify({state,list:await call('terminal_list'),screen:await call('terminal_screen',{alias:'test-server'})});
  assert.ok(!exposed.includes('fixture-secret'));
  assert.ok(!readFileSync(path.join(folder,'data','berth.sqlite')).includes(Buffer.from('fixture-secret')));
  assert.ok(authAttempts>=3);
  await ui.rpc('stop',{sessionId:target.sessionId});
  assert.equal((await ui.rpc<any[]>('runs',{sessionId:target.sessionId}))[0].status,'stopped');
  // Stop during a real unfinished SSH handshake, then start the same alias again.
  holdAuthentication=true;
  const held=new Promise<void>(resolve=>{authHeld=resolve;});
  const opening=call('terminal_open',{alias:'test-server'});
  const cancelled=assert.rejects(opening,/取消/);
  let heldTimer: NodeJS.Timeout | undefined;
  try { await Promise.race([held,new Promise<never>((_resolve,reject)=>{heldTimer=setTimeout(()=>reject(new Error('SSH auth was not reached')),3000);})]); }
  finally {clearTimeout(heldTimer);}
  await ui.rpc('stop',{sessionId:target.sessionId}); await cancelled;
  assert.equal((await ui.rpc<any[]>('runs',{sessionId:target.sessionId}))[0].status,'stopped');
  holdAuthentication=false;
  const restarted=await call('terminal_open',{alias:'test-server'});
  assert.notEqual(restarted.runId,target.runId);
  await ui.rpc('stop',{sessionId:restarted.sessionId});
  const blocked=await ui.rpc<SshConnection>('saveSshConnection',{config:{...config(),alias:'manual-only',allowAgent:false,port:address.port}});
  await assert.rejects(call('terminal_open',{alias:blocked.alias}),/未允许/);
  const manual=await ui.rpc<{sessionId:string;runId:string;info:RemoteInfo}>('remoteOpen',{alias:blocked.alias,owner:'user'});assert.equal(manual.info.owner,'user');
  await assert.rejects(call('terminal_open',{alias:blocked.alias}),/未允许/);
  await ui.rpc('stop',{sessionId:manual.sessionId});
});

test('stopping SSH startup cancels a pending credential request immediately', async () => {
  let supply!: (secret: {password: string}) => void;
  const credentials = new Promise<{password:string}>(resolve => {supply=resolve;});
  const transport = new SshTerminal({...config(),id:randomUUID()},randomUUID(),'',80,24,{credentials:()=>credentials,verify:async()=>true},()=>{},()=>{});
  const connecting = transport.connect().then(()=>null,error=>error);
  transport.kill();
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([connecting,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),300);})]);
  clearTimeout(timer);supply({password:'fixture-secret'});await connecting;
  assert.ok(result instanceof Error, 'Stop must release startup without waiting for a password or timeout');
  assert.match(result.message,/取消|关闭|停止/);
});
