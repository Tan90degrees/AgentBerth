import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { SshVault } from '../src/main/ssh-vault';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { TerminalMcp } from '../src/mcp/server';
import { sshConnectionSchema, type SshConnection, type SshConnectionConfig, type RemoteInfo, type RemoteAction } from '../src/shared/protocol';

const config = (): SshConnectionConfig => ({alias:'test-server',hostname:'127.0.0.1',port:22,username:'fixture-user',authentication:'password',privateKeyPath:'',allowAgent:true});
const temporary = () => mkdtempSync(path.join(tmpdir(),'ab-ssh-profile-'));

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
  const connections=new Set<any>(); let authAttempts=0, handshakes=0, shellChannels=0, windows=0;
  const ssh=new Server({hostKeys:[key.privateKey]}, client=>{
    connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));
    client.on('authentication',context=>{authAttempts++;if(context.method==='password'&&context.username==='fixture-user'&&context.password==='fixture-secret')context.accept();else context.reject(['password']);});
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
          if(request){channel.write(`\x1b]777;AgentBerth;${sessionId};start;${request}\x07fixture-command-output\r\n\x1b]777;AgentBerth;${sessionId};ready;${request};0;/fixture\x07$ `);}
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
  const agent=await DaemonConnection.open(runtime,()=>{});const mcp=new TerminalMcp(agent);
  t.after(async()=>{await ui.rpc('shutdown').catch(()=>{});agent.close();ui.close();await daemon.close();for(const client of connections)client.end();ssh.close();rmSync(folder,{recursive:true,force:true});});
  await ui.rpc('registerSshProvider');
  await assert.rejects(agent.rpc('registerSshProvider'),/已连接/);
  const profile=await ui.rpc<SshConnection>('saveSshConnection',{config:{...config(),port:address.port}});
  await assert.rejects(ui.rpc('saveSshConnection',{config:{...config(),port:address.port}}),/别名已存在/);
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const result:any=await mcp.request('tools/call',{name,arguments:args});
    if(result.isError)throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  assert.deepEqual((await call('terminal_list')).connections,[{alias:'test-server',allowAgent:true}]);
  rejectTrust=true;await assert.rejects(call('terminal_open',{alias:'test-server'}),/指纹/);
  rejectTrust=false;password='wrong-fixture-secret';await assert.rejects(call('terminal_open',{alias:'test-server'}),/认证失败/);
  password='fixture-secret';const target=await call('terminal_open',{alias:'test-server'});
  assert.equal(target.info.owner,'agent');assert.equal(hostConfirmations,2);assert.equal(handshakes,1);assert.equal(shellChannels,1);
  const again=await call('terminal_open',{alias:'test-server'});assert.equal(again.runId,target.runId);assert.equal(shellChannels,1);
  await assert.rejects(ui.rpc('saveSshConnection',{connectionId:profile.id,config:{...config(),port:address.port}}),/停止终端/);
  const action:RemoteAction=await call('terminal_execute',{alias:'test-server',requestId:randomUUID(),command:'printf fixture-command-output'});
  assert.equal(action.status,'completed');assert.equal(action.exitCode,0);
  assert.match((await call('terminal_screen',{alias:'test-server'})).text,/fixture-command-output/);
  await ui.rpc('attach',{sessionId:target.sessionId});
  await ui.rpc('resize',{sessionId:target.sessionId,runId:target.runId,cols:112,rows:32});
  await ui.rpc('remoteControl',{sessionId:target.sessionId,runId:target.runId,owner:'user'});
  assert.equal((await call('terminal_open',{alias:'test-server'})).info.owner,'user');
  await assert.rejects(call('terminal_keys',{alias:'test-server',key:'Enter'}),/用户控制/);
  const state=await ui.rpc<any>('state');assert.equal(state.sessions.length,1);
  const exposed=JSON.stringify({state,list:await call('terminal_list'),screen:await call('terminal_screen',{alias:'test-server'})});
  assert.ok(!exposed.includes('fixture-secret'));
  assert.ok(!readFileSync(path.join(folder,'data','berth.sqlite')).includes(Buffer.from('fixture-secret')));
  assert.ok(authAttempts>=3);
  await ui.rpc('stop',{sessionId:target.sessionId});
  assert.equal((await ui.rpc<any[]>('runs',{sessionId:target.sessionId}))[0].status,'stopped');
  const blocked=await ui.rpc<SshConnection>('saveSshConnection',{config:{...config(),alias:'manual-only',allowAgent:false,port:address.port}});
  await assert.rejects(call('terminal_open',{alias:blocked.alias}),/未允许/);
});
