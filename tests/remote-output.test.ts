import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Server } from 'ssh2';
import * as pty from 'node-pty';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { TerminalMcp } from '../src/mcp/server';
import type { RemoteCommandResult } from '../src/shared/protocol';

test('one SSH login and real POSIX Shell return command output directly, page scrollback and stream before completion', {skip:process.platform==='win32',timeout:45000},async t=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const clients=new Set<any>(),children=new Set<pty.IPty>();let logins=0,shells=0;
  const env={...process.env,PATH:'/nonexistent-agentberth',SHELL:'/bin/sh',ENV:'/dev/null',HISTFILE:'/dev/null',PS1:'fixture> ',PS2:'> '};
  // An actual SSH handshake/channel around an actual PTY, without privileged sshd.
  const ssh=new Server({hostKeys:[keys.privateKey]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>ctx.method==='password'&&ctx.password==='fixture-secret'?ctx.accept():ctx.reject(['password']));
    client.on('ready',()=>{logins++;client.on('session',accept=>{
      const session=accept();let cols=80,rows=24,child:pty.IPty|undefined;
      session.on('pty',(accept,_reject,info)=>{cols=info.cols;rows=info.rows;accept?.();});
      session.on('window-change',(accept,_reject,info)=>{child?.resize(info.cols,info.rows);accept?.();});
      session.on('exec',(accept,_reject,info)=>{
        const channel=accept();channel.on('error',()=>{});
        if(info.command.startsWith('case x')){const result=spawnSync('/bin/sh',['-c',info.command],{env,encoding:'utf8'});channel.end(result.stdout);return;}
        shells++;child=pty.spawn('/bin/sh',['-c',info.command],{cols,rows,name:'xterm-256color',env});children.add(child);
        const process=child;
        channel.on('data',(bytes:Buffer)=>process.write(bytes.toString('utf8')));
        process.onData(text=>{if(!channel.destroyed)channel.write(text);});
        process.onExit(({exitCode})=>{children.delete(process);if(!channel.destroyed){channel.exit(exitCode);channel.end();}});
        channel.on('close',()=>{try{process.kill('SIGKILL');}catch{}});
      });
    });});
  });
  await new Promise<void>(resolve=>ssh.listen(0,'127.0.0.1',resolve));const address=ssh.address();assert.ok(address&&typeof address!=='string');
  const folder=mkdtempSync(path.join(tmpdir(),'ab-output-integration-')),daemon=new DaemonServer(path.join(folder,'data')),runtime=await daemon.listen();
  const agent=await DaemonConnection.open(runtime,()=>{});
  let ui:DaemonConnection;
  ui=await DaemonConnection.open(runtime,event=>{if(event.event==='sshChallenge')void ui.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='credentials'?{secret:{password:'fixture-secret'}}:{accepted:true})});});
  t.after(async()=>{await ui.rpc('shutdown').catch(()=>{});agent.close();ui.close();await daemon.close();for(const child of children)try{child.kill('SIGKILL');}catch{}for(const client of clients)client.end();await new Promise<void>(resolve=>ssh.close(()=>resolve()));rmSync(folder,{recursive:true,force:true});});
  await ui.rpc('registerSshProvider');
  await ui.rpc('saveSshConnection',{config:{alias:'output-fixture',hostname:'127.0.0.1',port:address.port,username:'fixture',authentication:'password',privateKeyPath:'',allowAgent:true}});
  const mcp=new TerminalMcp(agent);
  const call=async(name:string,args:Record<string,unknown>={})=>{const result:any=await mcp.request('tools/call',{name,arguments:{alias:'output-fixture',...args}});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const target=await call('terminal_open');await ui.rpc('attach',{sessionId:target.sessionId});
  const requestId=randomUUID(),command='export AB_STATE=42; cd /tmp; printf "DIRECT=%s\\n" "$AB_STATE"; false';
  const fast:RemoteCommandResult=await call('terminal_execute',{requestId,command,waitMs:5000});
  assert.equal(fast.status,'completed');assert.equal(fast.exitCode,1);assert.equal(fast.info.phase,'idle');assert.equal(fast.info.cwd,'/tmp');assert.equal(fast.output.text,'DIRECT=42\r\n');
  assert.deepEqual((await call('terminal_execute',{requestId,command})).output,fast.output,'A retry returns cached output without re-executing');
  t.diagnostic(`one-call result: backend ${fast.requestMs?.toFixed(1)} ms; command ${fast.elapsedMs} ms (loopback SSH, real PTY)`);
  const lines=Array.from({length:200},(_,i)=>String(i)+'\r\n').join('');
  let page:RemoteCommandResult=await call('terminal_execute',{requestId:randomUUID(),command:'i=0; while [ "$i" -lt 200 ]; do printf "%s\\n" "$i"; i=$((i+1)); done',maxChars:256,waitMs:5000});
  assert.ok(page.output.hasMore);const actionId=page.id;let all=page.output.text;
  while(page.output.hasMore){page=await call('terminal_read_output',{actionId,cursor:page.output.nextCursor,maxChars:256});all+=page.output.text;}
  assert.equal(all,lines,'Output must include lines that have scrolled out of the visible terminal');
  let stream:RemoteCommandResult=await call('terminal_execute',{requestId:randomUUID(),command:'printf "FIRST\\n"; read AB_STREAM; printf "LAST\\n"',waitMs:0});
  const streamId=stream.id;let streamed=stream.output.text,sawRunning=false,reads=0;
  while(stream.status==='running'||stream.output.hasMore){stream=await call('terminal_read_output',{actionId:streamId,cursor:stream.output.nextCursor,timeoutMs:5000});streamed+=stream.output.text;if(!sawRunning&&stream.status==='running'&&streamed.includes('FIRST')){sawRunning=true;await call('terminal_keys',{key:'Ctrl+D'});}assert.ok(++reads<10);}
  assert.equal(streamed,'FIRST\r\nLAST\r\n');assert.ok(sawRunning);assert.equal(stream.exitCode,0);
  const screen:any=await ui.rpc('remoteScreen',{sessionId:target.sessionId,runId:target.runId});assert.ok(screen.text.includes('FIRST'));assert.ok(screen.text.includes('LAST'));assert.ok(!screen.text.includes('__ab_command'));assert.ok(!screen.text.includes(']777;AgentBerth;'));
  await assert.rejects(agent.rpc('remoteReadOutput',{sessionId:target.sessionId,runId:randomUUID(),actionId:streamId}),/变化/);
  await assert.rejects(agent.rpc('remoteReadOutput',{sessionId:target.sessionId,runId:target.runId,actionId:streamId,cursor:stream.output.nextCursor+100}),/游标/);
  const quiet=await call('terminal_execute',{requestId:randomUUID(),command:'read AB_STOP',waitMs:0});
  const waiting=call('terminal_read_output',{actionId:quiet.id,cursor:0,timeoutMs:30000});
  await call('terminal_keys',{key:'Ctrl+C'});assert.equal((await waiting).status,'unknown');
  assert.equal(logins,1);assert.equal(shells,1,'All operations must use the one visible Shell');
});
