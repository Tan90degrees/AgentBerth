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
  const call=async(name:string,args:Record<string,unknown>={})=>{const result:any=await mcp.request('tools/call',{name,arguments:{alias:'output-fixture',...(['terminal_execute','terminal_read_output','terminal_wait','terminal_screen','terminal_keys'].includes(name)?{detail:'full'}:{}),...args}});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  await mcp.request('tools/list',{}); // No copied instructions or explicit open.
  const requestId=randomUUID(),command='export AB_STATE=42; cd /tmp; printf "DIRECT=%s\\n" "$AB_STATE"; false';
  const fast:RemoteCommandResult=await call('terminal_execute',{requestId,command,waitMs:5000});
  const target={sessionId:fast.sessionId,runId:fast.runId};await ui.rpc('attach',{sessionId:target.sessionId});
  assert.equal((fast as any).harness.state,'completed');assert.equal((fast as any).harness.next,null);
  assert.equal(fast.status,'completed');assert.equal(fast.exitCode,1);assert.equal(fast.info.phase,'idle');assert.equal(fast.info.cwd,'/tmp');assert.equal(fast.output.text,'DIRECT=42\r\n');
  assert.deepEqual((await call('terminal_execute',{requestId,command})).output,fast.output,'A retry returns cached output without re-executing');
  t.diagnostic(`one-call result: backend ${fast.requestMs?.toFixed(1)} ms; command ${fast.elapsedMs} ms (loopback SSH, real PTY)`);
  // The user's OS inspection accepts alias+command only; no manually generated ID.
  const os=await call('terminal_execute',{command:'echo "===== OS RELEASE ====="; /bin/cat /etc/os-release 2>/dev/null; echo "===== KERNEL ====="; /bin/uname -a; echo "===== HOSTNAME ====="; /bin/hostname; echo "===== UPTIME ====="; /usr/bin/uptime'});
  assert.equal(os.status,'completed');assert.ok(os.output.text.includes('===== KERNEL ====='));assert.ok(!os.output.text.includes('DIRECT=42'),'Only this command output is returned');
  const delayed=await call('terminal_execute',{command:'AB_DELAY_RUNS=$((${AB_DELAY_RUNS:-0}+1)); printf \"DELAY_FIRST\\n\"; /bin/sleep 0.3; printf \"DELAY_LAST=%s\\n\" \"$AB_DELAY_RUNS\"'});
  assert.equal(delayed.status,'completed');assert.ok(delayed.output.text.includes('DELAY_LAST=1'));
  const previousAgain=await call('terminal_execute',{waitMs:0});assert.equal(previousAgain.id,delayed.id);assert.equal(previousAgain.output.text,delayed.output.text);
  const noIds:any=await mcp.request('tools/call',{name:'terminal_execute',arguments:{waitMs:0}});assert.ok(!noIds.isError);assert.equal(JSON.parse(noIds.content[0].text).output.text,delayed.output.text);
  const multiline=await call('terminal_execute',{command:'printf "LINE_ONE\\n"\nprintf\t"LINE_TWO\\n"\n'});
  assert.equal(multiline.output.text,'LINE_ONE\r\nLINE_TWO\r\n');
  const large=await call('terminal_execute',{command:'printf "%200000s\\n" X',mode:'page',waitMs:5000});
  let largePage=large,largeText=large.output.text;
  assert.equal(large.output.truncated,false);assert.equal(large.output.hasMore,true);
  while(largePage.output.hasMore){largePage=await call('terminal_read_output',{actionId:large.id,cursor:largePage.output.nextCursor,mode:'page'});assert.equal(largePage.output.truncated,false);largeText+=largePage.output.text;}
  assert.equal(largeText,' '.repeat(199999)+'X\r\n','Output exceeding the former 128K cap must remain readable independently of viewport height');
  const budgetCommand='AB_SEARCH_RUNS=$((${AB_SEARCH_RUNS:-0}+1)); printf "BUDGET_HEAD\\n"; i=0; while [ "$i" -lt 6000 ]; do printf "row-%04d test output\\n" "$i"; i=$((i+1)); done; printf "BUDGET_TAIL\\n"';
  let budget=await call('terminal_execute',{command:budgetCommand});
  if(budget.status==='running')budget=await call('terminal_wait',{actionId:budget.id,timeoutMs:5000});
  assert.equal(budget.output.mode,'summary');assert.equal(budget.output.omitted,true);assert.equal(budget.output.truncated,true);assert.equal(budget.output.cacheLost,false);assert.equal(budget.output.totalLines,6002);
  assert.ok(budget.output.text.startsWith('BUDGET_HEAD'));assert.ok(budget.output.text.endsWith('BUDGET_TAIL\r\n'));assert.ok(budget.output.text.split('\n').length<=4001);assert.equal(budget.output.hasMore,false);assert.equal(budget.continuation,null);assert.ok(budget.details);
  const matched=await call('terminal_read_output',{actionId:budget.id,search:{query:'row-3000',contextLines:2}});
  assert.equal(matched.output.search.totalMatches,1);assert.ok(matched.output.search.groups[0].text.includes('row-3000'));assert.ok(matched.output.search.groups[0].text.includes('row-2998'));assert.equal(matched.output.text,'');assert.equal(matched.harness.next,null);
  const countRows=await call('terminal_read_output',{actionId:budget.id,search:{query:'row-',limit:0}});assert.equal(countRows.output.search.totalMatches,6000);assert.deepEqual(countRows.output.search.groups,[]);
  const firstMatches=await call('terminal_read_output',{actionId:budget.id,search:{query:'row-',contextLines:0,limit:2}});assert.equal(firstMatches.output.search.returnedMatches,2);
  const moreReply:any=await mcp.request('tools/call',{name:firstMatches.details.tool,arguments:firstMatches.details.arguments});assert.ok(!moreReply.isError);const more=JSON.parse(moreReply.content[0].text);assert.ok(more.output.search.groups[0].text.includes('row-0002'));assert.equal(more.output.search.totalMatches,6000);
  const searchCount=await call('terminal_execute',{command:'printf "%s\\n" "$AB_SEARCH_RUNS"'});assert.equal(searchCount.output.text,'1\r\n');
  let filtered=await call('terminal_execute',{command:'printf "progress\\nERROR decisive failure\\ncompleted\\n"',search:{query:'error',contextLines:0}});
  if(filtered.status==='running')filtered=await call('terminal_wait',{actionId:filtered.id,search:{query:'error',contextLines:0},timeoutMs:5000});
  assert.equal(filtered.output.search.totalMatches,1);assert.equal(filtered.output.search.groups[0].text,'ERROR decisive failure');
  const noRepeat=await call('terminal_read_output',{actionId:budget.id,cursor:budget.output.nextCursor,timeoutMs:0});assert.equal(noRepeat.output.text,'');assert.equal(noRepeat.output.omitted,false);
  // Text defaults to submitting in the same tool call. Explicit false leaves it pending.
  for(const enter of [true,false]){
    const reading=await call('terminal_execute',{command:'read AB_TEXT; printf "INPUT=%s\\n" "$AB_TEXT"',waitMs:0});
    await call('terminal_keys',{text:enter?'submitted':'partial',...(enter?{}:{enter:false})});
    if(!enter){const pending=await call('terminal_read_output',{actionId:reading.id,cursor:0,timeoutMs:20});assert.equal(pending.status,'running');await call('terminal_keys',{key:'Enter'});}
    const done=await call('terminal_wait',{actionId:reading.id,timeoutMs:5000});assert.equal(done.status,'completed');assert.ok(done.output.text.includes('INPUT='+(enter?'submitted':'partial')));
  }
  const early=await call('terminal_execute',{command:'printf "EARLY_STREAM\\n"; read AB_EARLY',waitFor:'output'});
  assert.equal(early.status,'running');assert.ok(early.output.text.includes('EARLY_STREAM'));assert.ok(early.requestMs<2000,'First streaming output must not wait for the default 5-second cap');
  const busy:any=await mcp.request('tools/call',{name:'terminal_execute',arguments:{alias:'output-fixture',command:'printf SHOULD_NOT_EXECUTE'}});const blocked=JSON.parse(busy.content[0].text);assert.equal(blocked.error.code,'COMMAND_RUNNING');assert.equal(blocked.harness.next.arguments.actionId,early.id);
  await call('terminal_keys',{text:'done'});assert.equal((await call('terminal_wait',{actionId:early.id,timeoutMs:5000})).status,'completed');
  const lines=Array.from({length:200},(_,i)=>String(i)+'\r\n').join('');
  let page:RemoteCommandResult=await call('terminal_execute',{requestId:randomUUID(),command:'i=0; while [ "$i" -lt 200 ]; do printf "%s\\n" "$i"; i=$((i+1)); done',maxChars:256,mode:'page',waitMs:5000});
  assert.ok(page.output.hasMore);const actionId=page.id;let all=page.output.text;
  while(page.output.hasMore){page=await call('terminal_read_output',{actionId,cursor:page.output.nextCursor,maxChars:256,mode:'page'});all+=page.output.text;}
  assert.equal(all,lines,'Output must include lines that have scrolled out of the visible terminal');
  let stream:RemoteCommandResult=await call('terminal_execute',{requestId:randomUUID(),command:'printf "FIRST\\n"; read AB_STREAM; printf "LAST\\n"',waitMs:0});
  const streamId=stream.id;let streamed=stream.output.text,sawRunning=false,reads=0;
  while(stream.status==='running'||stream.output.hasMore){stream=await call('terminal_read_output',{actionId:streamId,cursor:stream.output.nextCursor,timeoutMs:5000});streamed+=stream.output.text;if(!sawRunning&&stream.status==='running'&&streamed.includes('FIRST')){sawRunning=true;await call('terminal_keys',{key:'Ctrl+D'});}assert.ok(++reads<10);}
  assert.equal(streamed,'FIRST\r\nLAST\r\n');assert.ok(sawRunning);assert.equal(stream.exitCode,0);
  const screen:any=await ui.rpc('remoteScreen',{sessionId:target.sessionId,runId:target.runId});assert.ok(screen.text.includes('FIRST'));assert.ok(screen.text.includes('LAST'));assert.ok(!screen.text.includes('__ab_command'));assert.ok(!screen.text.includes(']777;AgentBerth;'));
  await assert.rejects(agent.rpc('remoteReadOutput',{sessionId:target.sessionId,runId:randomUUID(),actionId:streamId}),/变化/);
  await assert.rejects(agent.rpc('remoteReadOutput',{sessionId:target.sessionId,runId:target.runId,actionId:streamId,cursor:stream.output.nextCursor+100}),/游标/);
  // Reproduce a long image-list command sent via keys, followed by reading only
  // the bottom five terminal rows. Recover all rows without any re-execution.
  await ui.rpc('resize',{sessionId:target.sessionId,runId:target.runId,cols:80,rows:5});
  const listCommand='AB_LIST_RUNS=$((${AB_LIST_RUNS:-0}+1)); i=0; while [ "$i" -lt 120 ]; do printf "image-%03d created-order-%03d\\n" "$i" "$i"; i=$((i+1)); done';
  let listed=await call('terminal_keys',{text:listCommand});assert.equal(listed.scope,'command');assert.ok(listed.id);
  if(listed.status==='running')listed=await call('terminal_wait',{actionId:listed.id,timeoutMs:5000});
  const expectedList=Array.from({length:120},(_,i)=>`image-${String(i).padStart(3,'0')} created-order-${String(i).padStart(3,'0')}\r\n`).join('');
  assert.equal(listed.output.text,expectedList);assert.equal(listed.allOutputInThisResponse,true);
  const recoveredAuto=await call('terminal_interact');assert.equal(recoveredAuto.scope,'command');assert.equal(recoveredAuto.output.text,expectedList);assert.equal(recoveredAuto.id,listed.id);
  const bottom=await call('terminal_screen');assert.equal(bottom.scope,'viewport');assert.equal(bottom.allOutputInThisResponse,false);assert.ok(bottom.scrollbackLines>0);assert.ok(!bottom.text.includes('image-000'));assert.ok(bottom.text.includes('image-119'));
  const follow=async(next:any)=>{const response:any=await mcp.request('tools/call',{name:next.tool,arguments:next.arguments});assert.ok(!response.isError,JSON.stringify(response));return JSON.parse(response.content[0].text);};
  const recovered=await follow(bottom.details);assert.equal(recovered.output.text,expectedList);assert.equal(recovered.allOutputInThisResponse,true);
  let listPage=await call('terminal_read_output',{mode:'page',maxChars:256,timeoutMs:0}),reassembled=listPage.output.text;
  assert.equal(listPage.id,listed.id);assert.ok(listPage.details);assert.equal(listPage.continuation,null);assert.equal(listPage.allOutputInThisResponse,false);
  while(listPage.details){listPage=await follow(listPage.details);reassembled+=listPage.output.text;}
  assert.equal(reassembled,expectedList);assert.equal(listPage.allOutputInThisResponse,false,'Final page alone is not the entire list');
  const count=await call('terminal_execute',{command:'printf "%s\\n" "$AB_LIST_RUNS"'});assert.equal(count.output.text,'1\r\n');
  // Partial typing and input to a running program must remain literal. Unknown
  // prompt state cannot silently reuse the previous command's output.
  const partial=await call('terminal_keys',{text:'AB_PARTIAL=literal',enter:false});assert.equal(partial.inputKind,'interactive');assert.equal((await call('terminal_screen')).command,null);
  const previous=await call('terminal_execute',{waitMs:0});assert.equal(previous.id,count.id);assert.equal(previous.output.text,'1\r\n','Untracked partial input must not hide the previous captured command result');
  await call('terminal_keys',{key:'Enter'});
  const restored=await call('terminal_execute',{command:'printf "%s\\n" "$AB_PARTIAL"',atPrompt:true});assert.equal(restored.output.text,'literal\r\n');
  const quiet=await call('terminal_execute',{requestId:randomUUID(),command:'read AB_STOP',waitMs:0});
  const waiting=call('terminal_read_output',{actionId:quiet.id,cursor:0,timeoutMs:30000});
  await call('terminal_keys',{key:'Ctrl+C'});assert.equal((await waiting).status,'unknown');
  await ui.rpc('remoteControl',{...target,owner:'user'});
  const denied:any=await mcp.request('tools/call',{name:'terminal_execute',arguments:{alias:'output-fixture',command:'printf MUST_NOT_STEAL'}});const deniedValue=JSON.parse(denied.content[0].text);assert.equal(deniedValue.error.code,'USER_CONTROLLED');assert.equal(deniedValue.harness.next,null);assert.equal((await ui.rpc<any>('remoteInfo',{sessionId:target.sessionId})).owner,'user');
  assert.equal(logins,1);assert.equal(shells,1,'All operations must use the one visible Shell');
});
