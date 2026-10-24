import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RemoteActivity } from '../src/daemon/remote-activity';
import { managedCommand, ManagedOutput, RemoteTerminal, shellQuote, ShellMarkers, sshArguments, sshHosts } from '../src/daemon/remote';
import * as pty from 'node-pty';
import { Store } from '../src/daemon/store';
import { requestSchema, type Method, type RemoteAction, type RemoteInfo } from '../src/shared/protocol';
import { Terminal } from '@xterm/headless';
import { isTerminalReply } from '../src/shared/terminal-replies';
import { TerminalMcp, McpError } from '../src/mcp/server';
import { CommandOutput } from '../src/daemon/remote-output';

function setup() {
  const folder = mkdtempSync(path.join(tmpdir(), 'berth-remote-'));
  const store = new Store(folder);
  const project = store.createProject('remote',folder);
  const session = store.createSession(project.id,'SSH','shell','',null,{host:'dev-server',directory:'/work/项目'});
  const run = store.createRun(session.id,'',80,24,'ssh');
  const info: RemoteInfo = {sessionId:session.id,runId:run.id,host:'dev-server',connection:'connected',owner:'user',phase:'idle',cwd:'/work',error:null};
  const actions: RemoteAction[] = [];
  const activity = new RemoteActivity(info,store,()=>{},action=>actions.push(action));
  return {folder,store,session,run,info,actions,activity, close:()=>{store.close();rmSync(folder,{recursive:true,force:true});}};
}

test('remote control has one Agent writer; takeover revokes it immediately without stopping the job',async t=>{
  const x=setup();t.after(x.close);const a={},b={},id=randomUUID();let written='';
  assert.throws(()=>x.activity.execute(a,id,'sleep 1',text=>written+=text),/用户控制/);
  x.activity.control('agent');x.activity.execute(a,id,'sleep 1',text=>written+=text);
  assert.ok(written.includes(`start;${id}`));assert.ok(written.endsWith('\r'));
  assert.throws(()=>x.activity.keys(b,'x','text',()=>{}),/另一个 Agent/);
  x.activity.marker('start',0,null);x.activity.control('user');
  assert.throws(()=>x.activity.keys(a,'\x03','Ctrl+C',()=>{}),/用户控制/);
  const wait=x.activity.wait(id,1000);x.activity.marker('ready',7,'/work/项目');
  assert.equal((await wait).exitCode,7);assert.equal(x.info.cwd,'/work/项目');
});

test('long commands survive wait timeouts; request IDs deduplicate and disconnect never invents an exit code',async t=>{
  const x=setup();t.after(x.close);const client={},id=randomUUID();let writes=0;
  x.activity.control('agent');x.activity.execute(client,id,'sleep 100',()=>writes++);
  assert.equal((await x.activity.wait(id,5)).status,'running');
  x.activity.execute(client,id,'sleep 100',()=>writes++);assert.equal(writes,1);
  assert.throws(()=>x.activity.execute(client,id,'different',()=>{}),/requestId/);
  x.activity.change({connection:'disconnected'});assert.equal((await x.activity.wait(id,0)).status,'unknown');assert.equal(x.store.remoteAction(id)!.exitCode,null);
  x.activity.change({connection:'connected'});x.activity.marker('ready',0,'/work');
  assert.equal(x.store.remoteAction(id)!.status,'unknown');x.activity.execute(client,id,'sleep 100',()=>writes++);assert.equal(writes,1);
});

test('unstarted commands are not completed by a stale prompt; wait cancellation releases listeners',async t=>{
  const x=setup();t.after(x.close);const client={},id=randomUUID();x.activity.control('agent');x.activity.execute(client,id,'echo 1',()=>{});
  x.activity.marker('ready',0,'/work');assert.equal(x.store.remoteAction(id)!.status,'running');
  const controller=new AbortController();const wait=x.activity.wait(id,1000,controller.signal);controller.abort();
  assert.equal((await wait).status,'running');assert.equal(x.activity.events.listenerCount('change'),0);
  x.activity.release(client);assert.equal(x.info.owner,'user');
});

test('raw input requires prompt confirmation; other login Shells use screen and keys',t=>{
  const x=setup();t.after(x.close);const client={};x.activity.control('agent');
  x.activity.keys(client,'x','text',()=>{});assert.equal(x.info.phase,'unknown');
  assert.throws(()=>x.activity.execute(client,randomUUID(),'echo ready',()=>{}),/提示符/);
  const id=randomUUID();x.activity.execute(client,id,'echo ready',()=>{},true);
  x.activity.marker('start',0,null,randomUUID());x.activity.marker('ready',0,'/wrong',randomUUID());
  assert.equal(x.store.remoteAction(id)!.status,'running');
  x.activity.marker('start',0,null,id);x.activity.marker('ready',3,'/right',id);
  assert.equal(x.store.remoteAction(id)!.exitCode,3);assert.equal(x.info.cwd,'/right');
  x.activity.change({commandTracking:'none'});
  assert.throws(()=>x.activity.execute(client,randomUUID(),'echo wrong',()=>{},true),/读屏和按键/);
  let input='';x.activity.keys(client,'echo raw','text',value=>input=value);assert.equal(input,'echo raw');
});

test('human interruption clears a pending command without inventing completion or replaying stale markers',t=>{
  const x=setup();t.after(x.close);const client={},id=randomUUID();x.activity.control('agent');
  x.activity.execute(client,id,'long task',()=>{});x.activity.marker('start',0,null,id);
  x.activity.control('user');x.activity.input('\x03');
  assert.equal(x.store.remoteAction(id)!.status,'unknown');assert.equal(x.info.phase,'unknown');
  x.activity.control('agent');const next=randomUUID();
  x.activity.execute(client,next,'echo next',()=>{},true);
  x.activity.marker('ready',0,'/old',id);assert.equal(x.store.remoteAction(next)!.status,'running');
  x.activity.marker('start',0,null,next);x.activity.marker('ready',0,'/next',next);
  assert.equal(x.store.remoteAction(next)!.status,'completed');assert.equal(x.info.cwd,'/next');
});

test('remote configuration, durable steps, pagination and crash outcomes survive reopening',t=>{
  const x=setup();let closed=false;t.after(()=>{if(!closed)x.close();});
  const client={},id=randomUUID();x.activity.control('agent');x.activity.execute(client,id,'long task',()=>{});
  for(let i=0;i<60;i++)x.activity.control('user');
  const first=x.store.remoteActions(x.session.id),second=x.store.remoteActions(x.session.id,first.at(-1)!.sequence);
  assert.equal(first.length,50);assert.equal(new Set([...first,...second].map(a=>a.id)).size,62);
  x.store.close();const next=new Store(x.folder);
  assert.equal(next.session(x.session.id).remote?.host,'dev-server');assert.equal(next.remoteAction(id)!.status,'unknown');
  next.deleteProject(x.session.projectId);assert.equal(next.remoteAction(id),null);next.close();rmSync(x.folder,{recursive:true,force:true});closed=true;
});

test('Shell builtin markers handle UTF-8, semicolons and arbitrary fragmentation',()=>{
  const id=randomUUID(),requestId=randomUUID(),seen:unknown[]=[];const markers=new ShellMarkers(id,(...event)=>seen.push(event));
  const data=Buffer.from(`noise\x1b]777;AgentBerth;wrong;ready;;0;x\x07\x1b]777;AgentBerth;${id};start;${requestId}\x07\x1b]777;AgentBerth;${id};ready;${requestId};17;/项目/hello;world\x07`);
  for(const byte of data)markers.feed(Buffer.from([byte]));
  assert.deepEqual(seen,[['start',0,null,requestId],['ready',17,'/项目/hello;world',requestId]]);
});

test('managed command echo becomes the original command across fragmented UTF-8, wrapping and Readline controls',()=>{
  const id=randomUUID(),request=randomUUID(),command=`printf '%s\\n' ${shellQuote("quotes ' 中😀 ".repeat(40))}`,wire=managedCommand(id,request,command);
  let output='';const seen:unknown[]=[];
  const display=new ManagedOutput(id,text=>output+=text,(...event)=>seen.push(event));
  display.begin(request,command,wire);
  const echo=wire.replaceAll('\\\r','\\\r\n\x1b[?2004l\r\x1b[?2004h> ').replace(/\r$/, '\r\n\x1b[?2004l\r');
  const realOutput='\x1b[31mREAL 中😀\x1b[0m\r\nprintf wrapper-like __ab_status must stay\r\n';
  const text=`prompt> ${echo}\x1b]777;AgentBerth;${id};start;${request}\x07${realOutput}\x1b]777;AgentBerth;${id};ready;${request};7;/tmp/中\x07prompt> `;
  for(const byte of Buffer.from(text))display.feed(Buffer.from([byte]));
  display.end();
  assert.ok(output.startsWith('prompt> '));assert.ok(output.includes(command+'\r\n'));
  assert.ok(output.includes(realOutput));assert.ok(output.endsWith('prompt> '));
  assert.ok(!output.includes(`AgentBerth;${id}`));assert.ok(!output.includes('; __ab_status=$?;'));
  assert.ok(output.includes('\x1b[?2004l'),'Terminal mode transitions must survive echo replacement');
  assert.deepEqual(seen,[['start',0,null,request],['ready',7,'/tmp/中',request]]);
});

test('continuation prompts interleaved inside echoed input cannot corrupt Unicode commands',()=>{
  const id=randomUUID(),request=randomUUID(),command=`printf '%s\\n' ${shellQuote("中😀'\\\n".repeat(150))}`,wire=managedCommand(id,request,command);
  assert.match(wire,/^[\x00-\x7f]*$/);
  let output='';const display=new ManagedOutput(id,text=>output+=text,()=>{});
  display.begin(request,command,wire);
  // dash writes PS2 while the kernel is still echoing subsequent input. It may
  // land at any byte, not just at the physical continuation-line boundary.
  const echo=wire.replaceAll('\r','\r\n').replace(/[^]{137}/g,chunk=>chunk+'> ');
  display.feed(Buffer.from(echo+`\x1b]777;AgentBerth;${id};start;${request}\x07REAL 中😀\r\n`));
  display.end();
  assert.equal(output,command+'\r\nREAL 中😀\r\n');
});

test('echo filtering preserves background output, no-echo terminals and wrapper-like real program output',()=>{
  const id=randomUUID(),request=randomUUID(),command='printf REAL',wire=managedCommand(id,request,command);
  let output='';const display=new ManagedOutput(id,text=>output+=text,()=>{});
  display.begin(request,command,wire);
  display.feed(Buffer.from(`BACKGROUND before\r\n${wire.replaceAll('\r','\r\n')}BACKGROUND after\r\n\x1b]777;AgentBerth;${id};start;${request}\x07`));
  assert.ok(output.includes('BACKGROUND before\r\n'));assert.ok(output.includes('BACKGROUND after\r\n'));
  assert.ok(output.includes(command+'\r\n'));assert.ok(!output.includes('; __ab_status=$?;'));
  display.feed(Buffer.from(wire));assert.ok(output.endsWith(wire),'Do not filter program output after command start');
  output='';display.begin(request,command,wire);
  display.feed(Buffer.from(`prompt> \x1b]777;AgentBerth;${id};start;${request}\x07REAL\r\n`));
  assert.equal(output,`prompt> ${command}\r\nREAL\r\n`);
  output='';display.begin(request,command,wire);
  const interleaved=wire.slice(0,100)+'BACKGROUND INTERLEAVED\r\n'+wire.slice(100);
  display.feed(Buffer.from(interleaved+`\x1b]777;AgentBerth;${id};start;${request}\x07`));
  assert.equal(output,interleaved,'An unrecognized echo must fail open without losing background logs');
  display.end();
});

test('cancelled and oversized submissions flush safely; malformed or partial markers retain data',()=>{
  const id=randomUUID(),request=randomUUID(),wire=managedCommand(id,request,'false');let output='';
  const display=new ManagedOutput(id,text=>output+=text,()=>{});
  display.begin(request,'false',wire);display.feed(Buffer.from('PARTIAL INPUT'));display.cancel();assert.equal(output,'PARTIAL INPUT');
  output='';display.begin(request,'false',wire);const large='x'.repeat(513*1024);display.feed(Buffer.from(large));assert.equal(output,large);
  display.feed(Buffer.from(`\x1b]777;AgentBerth;${id};malformed\x07tail\x1b]777;AgentBerth;${id};rea`));display.end();
  assert.ok(output.endsWith(`\x1b]777;AgentBerth;${id};malformed\x07tail\x1b]777;AgentBerth;${id};rea`));
});

for(const shell of ['/bin/sh','/bin/bash'])test(`real ${shell} PTY displays original commands and output without bookkeeping`,{skip:process.platform==='win32',timeout:15000},async t=>{
  const id=randomUUID(),request=randomUUID(),payload="😀'中 ".repeat(150),command=`AB_VALUE=${shellQuote(payload)}; cd /tmp; printf '%s\\n' "$AB_VALUE"; false`;
  const child=pty.spawn(shell,shell.endsWith('bash')?['--noprofile','--norc','-i']:['-i'],{cols:50,rows:24,env:{...process.env,PATH:'/nonexistent-agentberth',SHELL:shell,PS1:'FIXTURE> ',PS2:'> ',PROMPT_COMMAND:'',ENV:'/dev/null',HISTFILE:'/dev/null'}});
  t.after(()=>{try{child.kill('SIGKILL');}catch{}});
  let output='',sent=false;
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('No completion from clean-echo PTY')),12000);
    const display=new ManagedOutput(id,text=>output+=text,(kind,status,cwd,actionId)=>{
      if(kind==='ready'&&actionId===request){clearTimeout(timer);try{assert.equal(status,1);assert.equal(cwd,'/tmp');resolve();}catch(error){reject(error);}}
    });
    t.after(()=>{clearTimeout(timer);display.end();});
    child.onData(text=>{display.feed(Buffer.from(text));if(!sent&&output.includes('FIXTURE> ')){sent=true;const wire=managedCommand(id,request,command);display.begin(request,command,wire);child.write(wire);}});
    child.onExit(()=>{clearTimeout(timer);reject(new Error('Shell exited before completion'));});
  });
  assert.ok(output.includes(command+'\r\n'),JSON.stringify(output));assert.ok(output.includes(payload),JSON.stringify(output));
  assert.ok(!output.includes(`AgentBerth;${id}`));assert.ok(!output.includes('; __ab_status=$?;'));
});

test('POSIX builtins track commands and keep state with no remote programs in PATH', {skip:process.platform==='win32'},()=>{
  const id=randomUUID(),commandIds=[randomUUID(),randomUUID(),randomUUID()];
  const input=[managedCommand(id,commandIds[0],'export AB_TEST_STATE=42; cd /'),managedCommand(id,commandIds[1],'false'),managedCommand(id,commandIds[2],'printf "VALUE=%s\\n" "$AB_TEST_STATE"')].join('').replaceAll('\r','\n')+'exit\n';
  const result=spawnSync('/bin/sh',['-i'],{input,encoding:'utf8',timeout:5000,env:{...process.env,PATH:'/nonexistent-agentberth',SHELL:'/bin/sh'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/VALUE=42/);
  const seen:{kind:string;status:number;cwd:string|null;requestId:string}[]=[];new ShellMarkers(id,(kind,status,cwd,requestId)=>seen.push({kind,status,cwd,requestId})).feed(Buffer.from(result.stdout));
  assert.equal(seen.filter(x=>x.kind==='start').length,3);assert.ok(seen.some(x=>x.kind==='ready'&&x.status===1&&x.requestId===commandIds[1]));assert.ok(seen.some(x=>x.cwd==='/'));
});

test('long Unicode commands survive canonical PTY line limits without extra programs', {skip:process.platform==='win32',timeout:10000},async t=>{
  const id=randomUUID(),requestId=randomUUID(),payload="😀'中".repeat(500);
  const command=`AB_LONG=${shellQuote(payload)}; printf '%s\\n' "$AB_LONG"`;
  assert.ok(command.length<=4096);
  const input=managedCommand(id,requestId,command);
  for(const line of input.split('\r'))assert.ok(Buffer.byteLength(line)<4096);
  const child=pty.spawn('/bin/sh',['-i'],{cols:80,rows:24,env:{...process.env,PATH:'/nonexistent-agentberth',SHELL:'/bin/sh'}});
  t.after(()=>{try{child.kill('SIGKILL');}catch{}});
  let output='',sent=false;
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('No completion marker from long PTY command')),8000);
    const markers=new ShellMarkers(id,(kind,status,_cwd,actionId)=>{
      if(kind==='ready'&&actionId===requestId){clearTimeout(timer);try{assert.equal(status,0);resolve();}catch(error){reject(error);}}
    });
    child.onData(text=>{output+=text;markers.feed(Buffer.from(text));if(!sent){sent=true;child.write(input);}});
    child.onExit(()=>{clearTimeout(timer);reject(new Error('Shell exited before completion'));});
  });
  assert.ok(output.includes(payload));
});

test('non-POSIX SSH login falls back to a raw PTY and closes its local process', {skip:process.platform==='win32',timeout:10000},async t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-raw-ssh-')),executable=path.join(folder,'ssh-fixture');
  // A local transport double rejects the POSIX probe and exposes a raw terminal.
  writeFileSync(executable,'#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = -tt ]; then exec /bin/sh -i; fi; done\nexit 2\n',{mode:0o700});
  let info:Partial<RemoteInfo>={},output='';
  const remote=new RemoteTerminal({host:'fixture',directory:''},randomUUID(),80,24,change=>Object.assign(info,change),()=>{},executable);
  t.after(async()=>{await remote.stop().catch(()=>remote.kill());rmSync(folder,{recursive:true,force:true});});
  remote.onData(text=>output+=text);await remote.connect();
  assert.equal(info.connection,'connected');assert.equal(info.commandTracking,'none');assert.equal(info.phase,'unknown');
  const pid=remote.pid;assert.ok(pid>0);
  const received=new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Raw Shell input not received')),2000);remote.onData(()=>{if(output.includes('\r\nRAW_SHELL_OK\r\n')){clearTimeout(timeout);resolve();}});});
  remote.write("printf 'RAW_%s\\n' SHELL_OK\r");await received;
  await remote.stop();assert.equal(info.connection,'disconnected');assert.equal(remote.pid,0);
  assert.throws(()=>process.kill(pid,0));
});

test('host import excludes patterns and honors bounded includes; SSH arguments never invoke a local shell',t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-ssh-config-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));mkdirSync(path.join(folder,'parts'));
  writeFileSync(path.join(folder,'config'),`Host dev gpu-1 !bad *.example.com\n  HostName internal\nInclude ${path.join(folder,'parts','*')}\n`);
  writeFileSync(path.join(folder,'parts','hosts'),'Host other\nHost *\n');assert.deepEqual(sshHosts(path.join(folder,'config')),['dev','gpu-1','other']);
  const args=sshArguments('dev',"echo 'x;$(touch BAD)'",true);assert.deepEqual(args.slice(-3),['--','dev',"echo 'x;$(touch BAD)'"]);assert.ok(args.includes('StrictHostKeyChecking=yes'));
  for(const remote of [{host:'-oProxyCommand=bad',directory:'/tmp'},{host:'dev;evil',directory:'/tmp'},{host:'dev',directory:'relative'}])assert.equal(requestSchema.safeParse({id:randomUUID(),method:'createSession',params:{projectId:randomUUID(),title:'test',agent:'shell',remote}}).success,false);
  assert.ok(requestSchema.safeParse({id:randomUUID(),method:'createSession',params:{projectId:randomUUID(),title:'test',agent:'shell',remote:{host:'dev'}}}).success);
});

test('MCP executes with output in one daemon request and exposes incremental waits without replay',async()=>{
  const calls:{method:string;params:unknown}[]=[];const id=randomUUID();
  const server=new TerminalMcp({rpc:async<T>(method: Method,params?: Record<string,unknown>)=>{calls.push({method,params});return (method==='state'?{apiVersion:25}:{id,status:'running'}) as T;}});
  const initialized:any=await server.request('initialize',{protocolVersion:'2025-11-25'});assert.equal(initialized.protocolVersion,'2025-11-25');
  const list:any=await server.request('tools/list',{});assert.equal(list.tools.length,18);assert.ok(!list.tools.some((tool:any)=>/control|shutdown/.test(tool.name)));
  const result:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId:randomUUID(),runId:randomUUID(),requestId:id,command:'sleep 100',waitMs:10}});
  assert.ok(!result.isError);assert.deepEqual(calls.map(c=>c.method),['remoteCommand']);
  assert.equal((calls[0].params as any).waitMs,10);
  await server.request('tools/call',{name:'terminal_read_output',arguments:{sessionId:randomUUID(),runId:randomUUID(),actionId:id,cursor:123}});
  assert.equal(calls[1].method,'remoteReadOutput');assert.equal((calls[1].params as any).cursor,123);assert.equal((calls[1].params as any).waitFor,'output');
  await server.request('tools/call',{name:'terminal_wait',arguments:{sessionId:randomUUID(),runId:randomUUID(),actionId:id,cursor:456}});
  assert.equal((calls[2].params as any).waitFor,'completion');assert.equal((calls[2].params as any).cursor,456);
  await assert.rejects(server.request('tools/call',{name:'shutdown'}),McpError);
  const invalid:any=await server.request('tools/call',{name:'terminal_screen',arguments:{anything:'bad'}});assert.equal(invalid.isError,true);assert.equal(JSON.parse(invalid.content[0].text).error.code,'INVALID_ARGUMENTS');
});

test('command output streams exclude wrappers/prompts, wake on data, and preserve completion-only waits',async t=>{
  const x=setup();t.after(x.close);const id=randomUUID(),client={};x.activity.control('agent');
  x.activity.execute(client,id,'printf streamed',()=>{});x.activity.capture('echoed wrapper');
  x.activity.marker('start',0,null,id);
  const first=x.activity.readOutput(id,0,256,30000,'output');assert.equal(x.activity.events.listenerCount('output'),1);
  x.activity.capture('FIRST 中😀\r\n');
  const page=await first;assert.equal(page.status,'running');assert.equal(page.output.text,'FIRST 中😀\r\n');assert.equal(x.activity.events.listenerCount('output'),0);
  let completed=false;
  const final=x.activity.readOutput(id,page.output.nextCursor,256,30000,'completion').then(value=>{completed=true;return value;});
  x.activity.capture('SECOND\r\n');await Promise.resolve();assert.equal(completed,false);
  x.activity.marker('ready',7,'/work/changed',id);x.activity.capture('prompt> ');
  const done=await final;assert.equal(done.status,'completed');assert.equal(done.exitCode,7);assert.equal(done.info.cwd,'/work/changed');assert.equal(done.output.text,'SECOND\r\n');
  assert.equal(x.activity.result(id).output.text,'FIRST 中😀\r\nSECOND\r\n');
  assert.equal(x.activity.events.listenerCount('change'),0);assert.equal(x.activity.events.listenerCount('output'),0);
});

test('completion waits remain event-driven when command output storage is unavailable',async t=>{
  const x=setup();t.after(x.close);const outputDirectory=path.join(x.folder,'not-a-directory');writeFileSync(outputDirectory,'fixture');
  const activity=new RemoteActivity(x.info,x.store,()=>{},()=>{},outputDirectory),id=randomUUID();activity.control('agent');activity.execute({},id,'quiet task',()=>{});activity.marker('start',0,null,id);
  assert.equal((await activity.readOutput(id,0,256,1000,'output')).output.available,false);
  let settled=false;const completion=activity.readOutput(id,0,256,1000,'completion').then(value=>{settled=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'A completion wait must not return immediately because logs are missing');
  activity.marker('ready',0,'/work',id);assert.equal((await completion).status,'completed');assert.equal(activity.events.listenerCount('change'),0);
});

test('an older backend gets upgrade guidance without a fallback execution or replay',async()=>{
  const calls:string[]=[];
  const server=new TerminalMcp({rpc:async<T>(method:Method)=>{calls.push(method);if(method==='state')return {apiVersion:25} as T;throw new Error('请求参数无效');}});
  const result:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId:randomUUID(),runId:randomUUID(),requestId:randomUUID(),command:'once'}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/API 25.*API 33/);assert.deepEqual(calls,['remoteCommand','state']);
});

test('incremental waits cancel without stopping commands; quiet tasks and interruptions never imply success',async t=>{
  const x=setup();t.after(x.close);const id=randomUUID(),client={};x.activity.control('agent');x.activity.execute(client,id,'quiet task',()=>{});x.activity.marker('start',0,null,id);
  const abort=new AbortController(),waiting=x.activity.readOutput(id,0,256,30000,'output',abort.signal);abort.abort();
  assert.equal((await waiting).status,'running');assert.equal(x.activity.events.listenerCount('output'),0);
  assert.equal((await x.activity.readOutput(id,0,256,1,'output')).status,'running');
  x.activity.control('user');x.activity.capture('PARTIAL');
  assert.equal((await x.activity.readOutput(id,0,256,0,'output')).output.text,'PARTIAL','Read-only output remains available after takeover');
  const ended=x.activity.readOutput(id,7,256,30000,'output');x.activity.input('\x03');
  assert.equal((await ended).status,'unknown');assert.equal(x.activity.result(id).exitCode,null);
  assert.throws(()=>x.activity.result(randomUUID()),/不属于/);
});

test('bounded output pages Unicode without overlap and explicitly reports buffer eviction',t=>{
  const buffer=new CommandOutput(10);buffer.append('OLD');buffer.append('中😀1234567');
  const first=buffer.read(0,2);assert.equal(first.truncated,true);assert.equal(first.text,'中');
  const second=buffer.read(first.nextCursor,2);assert.equal(second.text,'😀');assert.equal(second.truncated,false);
  const last=buffer.read(second.nextCursor,10);assert.equal(last.text,'1234567');assert.equal(last.hasMore,false);
  assert.throws(()=>buffer.read(last.nextCursor+1,10),/游标/);
  const x=setup();t.after(x.close);const client={},ids:string[]=[];let writes=0;x.activity.control('agent');
  for(let i=0;i<9;i++){const id=randomUUID();ids.push(id);x.activity.execute(client,id,'once',()=>writes++);x.activity.marker('start',0,null,id);x.activity.capture(String(i));x.activity.marker('ready',0,'/work',id);}
  assert.equal(x.activity.result(ids[0]).output.available,false);assert.equal(x.activity.result(ids[0]).output.truncated,true);
  x.activity.execute(client,ids[0],'once',()=>writes++);assert.equal(writes,9,'Evicted output must never cause replay');
  assert.equal(x.activity.result(ids.at(-1)!).output.text,'8');
});


test('request deduplication outlives the visible timeline retention limit',t=>{
  const x=setup();t.after(x.close);const client={},id=randomUUID();let writes=0;
  x.activity.control('agent');x.activity.execute(client,id,'echo one',()=>writes++);x.activity.marker('start',0,null);x.activity.marker('ready',0,'/tmp');
  for(let i=0;i<1010;i++)x.activity.control('agent');
  x.activity.execute(client,id,'echo one',()=>writes++);assert.equal(writes,1);assert.equal(x.store.remoteAction(id)!.status,'completed');
});

test('remote viewer suppresses terminal protocol replies while the daemon answers them without a UI',async()=>{
  const terminal=new Terminal({cols:80,rows:24,allowProposedApi:true});const replies:string[]=[];terminal.onData(data=>replies.push(data));
  await new Promise<void>(resolve=>terminal.write('\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n',resolve));
  assert.ok(replies.length>=5);for(const reply of replies)assert.ok(isTerminalReply(reply),JSON.stringify(reply));
  for(const data of ['echo hacked\r','\x1b[A','\r','\x03','\x1b[0necho bad\r'])assert.equal(isTerminalReply(data),false);
  terminal.dispose();
});


test('MCP accepts minimal execute, validates UUID fields before sending and never masks invalid input as an upgrade',async()=>{
  const calls:{method:string;params:any}[]=[];
  const server=new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{calls.push({method,params});return (method==='remoteOpen'?{sessionId:'f165a277-fbfa-4363-9c80-f2840d756b47',runId:'c4955082-2c98-49ae-b493-195693763fb9'}:{id:params?.requestId}) as T;}});
  const command='echo "===== OS RELEASE ====="; cat /etc/os-release 2>/dev/null; echo "===== KERNEL ====="; uname -a; echo "===== HOSTNAME ====="; hostname; echo "===== UPTIME ====="; uptime';
  const result:any=await server.request('tools/call',{name:'terminal_execute',arguments:{alias:'dev-server',command}});
  assert.ok(!result.isError);assert.deepEqual(calls.map(c=>c.method),['remoteOpen','remoteCommand']);assert.match(calls[1].params.requestId,/^[a-f0-9-]{36}$/);assert.equal(calls[1].params.command,command);assert.equal(calls[1].params.waitMs,5000);assert.equal(calls[1].params.maxChars,32768);
  const invalid:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId:randomUUID(),runId:randomUUID(),requestId:'not-a-uuid',command:'uname -a'}});
  assert.ok(invalid.isError);assert.match(invalid.content[0].text,/params.requestId/);assert.doesNotMatch(invalid.content[0].text,/更新后台/);assert.equal(calls.length,2);
  const keys=(await server.request('tools/list',{}) as any).tools.find((tool:any)=>tool.name==='terminal_keys');assert.equal(keys.inputSchema.properties.enter.default,true);
  for(const args of [{text:'yes'},{text:'partial',enter:false},{key:'Enter'},{key:'Tab'}]){
    const response:any=await server.request('tools/call',{name:'terminal_keys',arguments:{sessionId:randomUUID(),runId:randomUUID(),...args}});assert.ok(!response.isError);assert.equal(calls.at(-1)!.params.enter,'enter' in args?false:true);
  }
});

test('multiline scripts accept tabs and trailing newlines, rejecting terminal controls without transmission',()=>{
  for(const command of ['uname -a\n','printf "first\\n"\nprintf "second\\n"','printf\tOK']){
    const request=requestSchema.safeParse({id:randomUUID(),method:'remoteCommand',params:{sessionId:randomUUID(),runId:randomUUID(),requestId:randomUUID(),command}});assert.ok(request.success,command);
  }
  for(const command of ['\x1b[2J','\x03','\x00','   '])assert.equal(requestSchema.safeParse({id:randomUUID(),method:'remoteCommand',params:{sessionId:randomUUID(),runId:randomUUID(),requestId:randomUUID(),command}}).success,false);
});

test('disk output cache wraps with exact cursors and Unicode and cleans files on disposal',t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-output-ring-'));
  const memory=new CommandOutput(31),disk=new CommandOutput(31,path.join(folder,'ring.bin'));
  t.after(()=>{disk.dispose();rmSync(folder,{recursive:true,force:true,maxRetries:5});});
  for(const text of ['abc😀中','1234567890123456789012345678901234567890','😀','tail','\r\n','😀'.repeat(30)]){
    memory.append(text);disk.append(text);
    let cursor=0;
    for(let n=0;n<20;n++){const expected=memory.read(cursor,4),actual=disk.read(cursor,4);assert.deepEqual(actual,expected);cursor=actual.nextCursor;if(!actual.hasMore)break;assert.ok(n<19);}
  }
});


test('latest command discovery refuses to associate untracked input with an old result',t=>{
  const x=setup();t.after(x.close);const client={},id=randomUUID();x.activity.control('agent');
  assert.equal(x.activity.latestCommand(),null);
  x.activity.execute(client,id,'printf one',()=>{});assert.equal(x.activity.latestCommand()?.id,id);
  x.activity.marker('start',0,null,id);x.activity.capture('one');x.activity.marker('ready',0,'/work',id);
  assert.equal(x.activity.latestCommand()?.id,id);
  x.activity.keys(client,'partial','partial input',()=>{});assert.equal(x.activity.latestCommand(),null);
  assert.equal(x.activity.result(id).output.text,'one','Explicit historical IDs remain readable');
});
