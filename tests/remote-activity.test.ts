import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RemoteActivity } from '../src/daemon/remote-activity';
import { managedCommand, RemoteTerminal, shellQuote, ShellMarkers, sshArguments, sshHosts } from '../src/daemon/remote';
import * as pty from 'node-pty';
import { Store } from '../src/daemon/store';
import { requestSchema, type Method, type RemoteAction, type RemoteInfo } from '../src/shared/protocol';
import { Terminal } from '@xterm/headless';
import { isTerminalReply } from '../src/shared/terminal-replies';
import { TerminalMcp, McpError } from '../src/mcp/server';

function setup() {
  const folder = mkdtempSync(path.join(tmpdir(), 'berth-remote-'));
  const store = new Store(folder);
  const project = store.createProject('remote',folder);
  const session = store.createSession(project.id,'SSH','shell','',null,{host:'ascend-dev',directory:'/work/项目'});
  const run = store.createRun(session.id,'',80,24,'ssh');
  const info: RemoteInfo = {sessionId:session.id,runId:run.id,host:'ascend-dev',connection:'connected',owner:'user',phase:'idle',cwd:'/work',error:null};
  const actions: RemoteAction[] = [];
  const activity = new RemoteActivity(info,store,()=>{},action=>actions.push(action));
  return {folder,store,session,run,info,actions,activity, close:()=>{store.close();rmSync(folder,{recursive:true,force:true});}};
}

test('remote control has one Agent writer; takeover revokes it immediately without stopping the job',async t=>{
  const x=setup();t.after(x.close);const a={},b={},id=randomUUID();let written='';
  assert.throws(()=>x.activity.execute(a,id,'sleep 1',text=>written+=text),/用户控制/);
  x.activity.control('agent');x.activity.execute(a,id,'sleep 1',text=>written+=text);
  assert.ok(written.includes("eval 'sleep 1'"));assert.ok(written.endsWith('\r'));
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

test('remote configuration, durable steps, pagination and crash outcomes survive reopening',t=>{
  const x=setup();let closed=false;t.after(()=>{if(!closed)x.close();});
  const client={},id=randomUUID();x.activity.control('agent');x.activity.execute(client,id,'long task',()=>{});
  for(let i=0;i<60;i++)x.activity.control('user');
  const first=x.store.remoteActions(x.session.id),second=x.store.remoteActions(x.session.id,first.at(-1)!.sequence);
  assert.equal(first.length,50);assert.equal(new Set([...first,...second].map(a=>a.id)).size,62);
  x.store.close();const next=new Store(x.folder);
  assert.equal(next.session(x.session.id).remote?.host,'ascend-dev');assert.equal(next.remoteAction(id)!.status,'unknown');
  next.deleteProject(x.session.projectId);assert.equal(next.remoteAction(id),null);next.close();rmSync(x.folder,{recursive:true,force:true});closed=true;
});

test('Shell builtin markers handle UTF-8, semicolons and arbitrary fragmentation',()=>{
  const id=randomUUID(),requestId=randomUUID(),seen:unknown[]=[];const markers=new ShellMarkers(id,(...event)=>seen.push(event));
  const data=Buffer.from(`noise\x1b]777;AgentBerth;wrong;ready;;0;x\x07\x1b]777;AgentBerth;${id};start;${requestId}\x07\x1b]777;AgentBerth;${id};ready;${requestId};17;/项目/hello;world\x07`);
  for(const byte of data)markers.feed(Buffer.from([byte]));
  assert.deepEqual(seen,[['start',0,null,requestId],['ready',17,'/项目/hello;world',requestId]]);
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
  t.after(()=>{try{child.kill();}catch{}});
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

test('MCP advertises only scoped terminal tools and delegates bounded waits without replaying commands',async()=>{
  const calls:{method:string;params:unknown}[]=[];const id=randomUUID();
  const server=new TerminalMcp({rpc:async<T>(method: Method,params?: Record<string,unknown>)=>{calls.push({method,params});return (method==='remoteExecute'?{id,status:'running'}:{status:'running'}) as T;}});
  const initialized:any=await server.request('initialize',{protocolVersion:'2025-11-25'});assert.equal(initialized.protocolVersion,'2025-11-25');
  const list:any=await server.request('tools/list',{});assert.equal(list.tools.length,6);assert.ok(!list.tools.some((tool:any)=>/control|shutdown/.test(tool.name)));
  const result:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId:randomUUID(),runId:randomUUID(),requestId:id,command:'sleep 100',waitMs:10}});
  assert.ok(!result.isError);assert.deepEqual(calls.map(c=>c.method),['remoteExecute','remoteWait']);
  await assert.rejects(server.request('tools/call',{name:'shutdown'}),McpError);
  await assert.rejects(server.request('tools/call',{name:'terminal_screen',arguments:{anything:'bad'}}),McpError);
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
