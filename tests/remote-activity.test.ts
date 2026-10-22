import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RemoteActivity } from '../src/daemon/remote-activity';
import { decodeTmuxOutput, shellBootstrap, ShellMarkers, sshArguments, sshHosts } from '../src/daemon/remote';
import { Store } from '../src/daemon/store';
import { requestSchema, type Method, type RemoteAction, type RemoteInfo } from '../src/shared/protocol';
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
  assert.equal(written,'sleep 1\r');
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

test('tmux output and OSC shell markers handle escape sequences, UTF-8 and arbitrary fragmentation',()=>{
  assert.equal(decodeTmuxOutput('A\\015\\012\\134B').toString(),'A\r\n\\B');
  const id=randomUUID(),seen:unknown[]=[];const markers=new ShellMarkers(id,(...event)=>seen.push(event));
  const data=Buffer.from(`noise\x1b]777;AgentBerth;wrong;ready;0;eA==\x07\x1b]777;AgentBerth;${id};start\x07\x1b]777;AgentBerth;${id};ready;17;${Buffer.from('/项目/hello').toString('base64')}\x07`);
  for(const byte of data)markers.feed(Buffer.from([byte]));
  assert.deepEqual(seen,[['start',0,null],['ready',17,'/项目/hello']]);
});

test('real Bash integration keeps shell state and emits actual command boundaries', {skip:process.platform==='win32'},()=>{
  const id=randomUUID();const script=shellBootstrap(id,tmpdir());
  const result=spawnSync('bash',['-c',script],{input:'export AB_TEST_STATE=42\nfalse\nprintf "VALUE=%s\\n" "$AB_TEST_STATE"\nexit\n',encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/VALUE=42/);
  const seen:{kind:string;status:number;cwd:string|null}[]=[];new ShellMarkers(id,(kind,status,cwd)=>seen.push({kind,status,cwd})).feed(Buffer.from(result.stdout));
  assert.ok(seen.filter(x=>x.kind==='start').length>=3,JSON.stringify(seen));assert.ok(seen.some(x=>x.kind==='ready'&&x.status===1),JSON.stringify(seen));
});

test('host import excludes patterns and honors bounded includes; SSH arguments never invoke a local shell',t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-ssh-config-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));mkdirSync(path.join(folder,'parts'));
  writeFileSync(path.join(folder,'config'),`Host dev gpu-1 !bad *.example.com\n  HostName internal\nInclude ${path.join(folder,'parts','*')}\n`);
  writeFileSync(path.join(folder,'parts','hosts'),'Host other\nHost *\n');assert.deepEqual(sshHosts(path.join(folder,'config')),['dev','gpu-1','other']);
  const args=sshArguments('dev',"echo 'x;$(touch BAD)'",true);assert.deepEqual(args.slice(-3),['--','dev',"echo 'x;$(touch BAD)'"]);assert.ok(args.includes('StrictHostKeyChecking=yes'));
  for(const remote of [{host:'-oProxyCommand=bad',directory:'/tmp'},{host:'dev;evil',directory:'/tmp'},{host:'dev',directory:'relative'}])assert.equal(requestSchema.safeParse({id:randomUUID(),method:'createSession',params:{projectId:randomUUID(),title:'test',agent:'shell',remote}}).success,false);
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
