import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Server } from 'ssh2';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { TerminalMcp } from '../src/mcp/server';
import { AgentMcp } from '../src/mcp/agents';
import type { Method, RemoteInfo, RemoteCommandResult, State } from '../src/shared/protocol';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const decode=(reply:any)=>{const value=JSON.parse(reply.content[0].text);assert.ok(!reply.isError,JSON.stringify(value));return value;};
const call=async(server:{request(method:string,params:unknown):Promise<any>},name:string,args:Record<string,unknown>={})=>decode(await server.request('tools/call',{name,arguments:args}));
async function fixture(t:any){
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
 const peers=new Set<any>();let shells=0;
 const ssh=new Server({hostKeys:[keys.privateKey]},peer=>{
  peers.add(peer);peer.on('error',()=>{});peer.on('close',()=>peers.delete(peer));
  peer.on('authentication',ctx=>ctx.method==='password'&&ctx.password==='fixture-secret'?ctx.accept():ctx.reject(['password']));
  peer.on('ready',()=>peer.on('session',accept=>{
   const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());
   session.on('exec',accept=>{accept().end('non-POSIX fixture');});
   session.on('shell',accept=>{shells++;const channel=accept();let token='',input='';channel.on('error',()=>{});channel.write('fixture> ');
    channel.on('data',(bytes:Buffer)=>{input+=bytes.toString();let end;while((end=input.indexOf('\r'))>=0){const command=input.slice(0,end);input=input.slice(end+1);if(command.startsWith('SET='))token=command.slice(4);channel.write('\r\nTOKEN='+token+'\r\nfixture> ');}});
   });
  }));
 });
 await new Promise<void>(resolve=>ssh.listen(0,'127.0.0.1',resolve));const address=ssh.address();assert.ok(address&&typeof address!=='string');
 const folder=mkdtempSync(path.join(tmpdir(),'berth-agents-')),daemon=new DaemonServer(path.join(folder,'data')),runtime=await daemon.listen();
 const connections:DaemonConnection[]=[];const connect=async()=>{const client=await DaemonConnection.open(runtime,()=>{});connections.push(client);return client;};
 let ui:DaemonConnection;
 ui=await DaemonConnection.open(runtime,event=>{if(event.event==='sshChallenge')void ui.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='credentials'?{secret:{password:'fixture-secret'}}:{accepted:true})});});
 t.after(async()=>{await ui.rpc('shutdown').catch(()=>{});for(const client of connections)client.close(true);ui.close(true);await daemon.close();for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>ssh.close(()=>resolve()));rmSync(folder,{recursive:true,force:true});});
 await ui.rpc('registerSshProvider');await ui.rpc('saveSshConnection',{config:{alias:'fixture',hostname:'127.0.0.1',port:address.port,username:'fixture',authentication:'password',privateKeyPath:'',allowAgent:true}});
 return {folder,runtime,ui,connect,shells:()=>shells};
}
test('separate Agents get independent SSH shells for the same alias and cannot close or delete each other’s sessions', {timeout:20000},async t=>{
 const f=await fixture(t),a=new TerminalMcp(await f.connect()),b=new TerminalMcp(await f.connect());
 const [one,two]=await Promise.all([call(a,'terminal_session',{action:'open',alias:'fixture'}),call(b,'terminal_session',{action:'open',alias:'fixture'})]);
 assert.notEqual(one.sessionId,two.sessionId);assert.notEqual(one.runId,two.runId);assert.equal(f.shells(),2);
 const settings=(await f.ui.rpc<State>('state')).settings;await f.ui.rpc('saveSettings',{...settings,maxSshTerminals:2});
 const c=new TerminalMcp(await f.connect()),limited:any=await c.request('tools/call',{name:'terminal_session',arguments:{action:'open',alias:'fixture'}});
 assert.equal(limited.isError,true);assert.equal(f.shells(),2,'Independent connections still obey the SSH quota');
 assert.equal((await call(a,'terminal_session',{action:'open',alias:'fixture'})).sessionId,one.sessionId);
 for(const action of ['close','delete','reconnect','update']){
  const reply:any=await b.request('tools/call',{name:'terminal_session',arguments:{action,sessionId:one.sessionId,runId:one.runId,...(action==='update'?{title:'foreign'}:{})}});
  assert.equal(reply.isError,true);assert.equal(JSON.parse(reply.content[0].text).error.code,'AGENT_BUSY');
 }
 await Promise.all([call(a,'terminal_interact',{text:'SET=AGENT_A'}),call(b,'terminal_interact',{text:'SET=AGENT_B'})]);
 const [screenA,screenB]=await Promise.all([call(a,'terminal_interact',{text:'GET'}),call(b,'terminal_interact',{text:'GET'})]);
 assert.match(screenA.text,/TOKEN=AGENT_A/);assert.doesNotMatch(screenA.text,/TOKEN=AGENT_B/);assert.match(screenB.text,/TOKEN=AGENT_B/);
 assert.deepEqual((await call(a,'terminal_session')).sessions.map((s:any)=>s.sessionId),[one.sessionId]);assert.deepEqual((await call(b,'terminal_session')).sessions.map((s:any)=>s.sessionId),[two.sessionId]);
 await call(b,'terminal_session',{action:'close'});await call(b,'terminal_session',{action:'delete',sessionId:two.sessionId});
 assert.equal((await f.ui.rpc<State>('state')).sessions.find(s=>s.id===one.sessionId)!.latestRun!.status,'running');
 const still=await call(a,'terminal_interact',{text:'GET'});assert.match(still.text,/TOKEN=AGENT_A/);
 await call(a,'terminal_session',{action:'dispose'});assert.equal((await f.ui.rpc<State>('state')).sessions.find(s=>s.id===one.sessionId)!.latestRun!.status,'stopped');
});

test('one bundled MCP process isolates concurrent named subagents and disposes only the chosen context', {timeout:25000},async t=>{
 const f=await fixture(t),child=spawn(process.execPath,[path.resolve('dist/mcp.cjs'),path.join(f.folder,'data')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',bytes=>stderr+=bytes.toString());let sequence=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line),p=pending.get(reply.id);if(p){clearTimeout(p.timer);pending.delete(reply.id);reply.error?p.reject(new Error(reply.error.message)):p.resolve(reply.result);}});
 t.after(()=>{for(const p of pending.values())clearTimeout(p.timer);child.kill();});
 const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error('MCP timeout: '+stderr)),10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const invoke=async(agentId:string,name:string,args:Record<string,unknown>={})=>decode(await request('tools/call',{name,arguments:{...args,agentId}}));
 const discovery=await request('tools/list',{});assert.equal(discovery.tools.length,4);assert.ok(discovery.tools.every((tool:any)=>tool.inputSchema.properties.agentId));
 const [a,b]=await Promise.all([invoke('worker-a','terminal_session',{action:'create',alias:'fixture',title:'same-name'}),invoke('worker-b','terminal_session',{action:'create',alias:'fixture',title:'same-name'})]);
 assert.notEqual(a.sessionId,b.sessionId);assert.equal(f.shells(),2);
 await Promise.all([invoke('worker-a','terminal_interact',{text:'SET=A'}),invoke('worker-b','terminal_interact',{text:'SET=B'})]);
 assert.match((await invoke('worker-a','terminal_interact',{text:'GET'})).text,/TOKEN=A/);assert.match((await invoke('worker-b','terminal_interact',{text:'GET'})).text,/TOKEN=B/);
 assert.deepEqual((await invoke('worker-a','terminal_session')).sessions.map((s:any)=>s.sessionId),[a.sessionId]);
 await invoke('worker-a','terminal_session',{action:'dispose'});
 assert.equal((await f.ui.rpc<State>('state')).sessions.find(s=>s.id===b.sessionId)!.latestRun!.status,'running');assert.match((await invoke('worker-b','terminal_interact',{text:'GET'})).text,/TOKEN=B/);
 const fresh=await invoke('worker-a','terminal_session',{action:'open',alias:'fixture'});assert.notEqual(fresh.sessionId,a.sessionId);assert.equal(f.shells(),3);
 await invoke('worker-a','terminal_session',{action:'dispose'});await invoke('worker-b','terminal_session',{action:'dispose'});
 child.stdin.end();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
});

test('disconnected Agent can continue its exact session without new authorization; human takeover remains binding', {timeout:20000},async t=>{
 const f=await fixture(t);let client=await f.connect();const a=new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>client.rpc<T>(method,params)});
 const target=await call(a,'terminal_session',{action:'open',alias:'fixture'});await call(a,'terminal_interact',{text:'SET=RETAINED'});
 client.close(true);await delay(30);client=await f.connect();
 const output=await call(a,'terminal_interact',{alias:'fixture',text:'GET'});assert.match(output.text,/TOKEN=RETAINED/);assert.equal(f.shells(),1);
 await f.ui.rpc('remoteControl',{sessionId:target.sessionId,runId:target.runId,owner:'user'});
 const denied:any=await a.request('tools/call',{name:'terminal_session',arguments:{action:'dispose'}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).error.code,'USER_CONTROLLED');
 assert.equal((await f.ui.rpc<RemoteInfo>('remoteInfo',{sessionId:target.sessionId})).owner,'user');
});

test('named contexts keep command continuations, last targets and cancellation isolated',async()=>{
 const identities=new Map<string,{sessionId:string;runId:string}>(),calls:{agentId:string;method:Method;params?:Record<string,unknown>}[]=[],disconnected:string[]=[];
 const router=new AgentMcp(agentId=>{
  const target={sessionId:randomUUID(),runId:randomUUID()};identities.set(agentId,target);
  return {disconnect(){disconnected.push(agentId);},server:new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{
   calls.push({agentId,method,params});if(method==='remoteOpen')return {...target,info:{...target}} as T;
   const info:RemoteInfo={...target,host:'fixture',connection:'connected',owner:'agent',phase:'busy',cwd:'/tmp',error:null,commandTracking:'posix'};
   return {id:params?.requestId??params?.actionId??randomUUID(),...target,kind:'command',sequence:1,label:'fixture',status:'running',startedAt:new Date().toISOString(),endedAt:null,exitCode:null,elapsedMs:1,info,output:{text:'FIRST',nextCursor:5,earliestCursor:0,available:true,truncated:false,hasMore:false,format:'terminal'}} as T;
  }})};
 });
 const [a,b]=await Promise.all([call(router,'terminal_execute',{agentId:'a',alias:'fixture',command:'long A',waitMs:0}),call(router,'terminal_execute',{agentId:'b',alias:'fixture',command:'long B',waitMs:0})]);
 assert.equal(a.harness.next.arguments.agentId,'a');assert.equal(b.harness.next.arguments.agentId,'b');
 await call(router,a.harness.next.tool,a.harness.next.arguments);await call(router,'terminal_execute',{agentId:'b',waitMs:0});
 assert.equal(calls.at(-1)!.params!.sessionId,identities.get('b')!.sessionId);assert.equal(calls.filter(c=>c.method==='remoteCommand').length,2);
 router.disconnect('a');assert.deepEqual(disconnected,['a']);
 for(const agentId of ['',123,'x'.repeat(101)]){const reply:any=await router.request('tools/call',{name:'terminal_session',arguments:{agentId}});assert.equal(reply.isError,true);}
 await assert.rejects(router.request('tools/call',{name:'terminal_session',arguments:[]}),/Invalid arguments/);
 router.close();
});

test('explicit recovery cannot claim another live Agent; a desktop terminal can still be handed to an Agent', {timeout:15000},async t=>{
 const f=await fixture(t),first=await f.connect(),second=await f.connect(),a=new TerminalMcp(first);
 const own=await call(a,'terminal_session',{action:'open',alias:'fixture'});
 assert.deepEqual(await second.rpc('remoteAgentRecover',{targets:[{sessionId:own.sessionId,runId:own.runId}]}),{recovered:[]});
 const manual:any=await f.ui.rpc('remoteOpen',{alias:'fixture',owner:'user'});
 await f.ui.rpc('remoteControl',{sessionId:manual.sessionId,runId:manual.runId,owner:'agent'});
 const b=new TerminalMcp(second);await call(b,'terminal_interact',{sessionId:manual.sessionId,runId:manual.runId,text:'SET=MANUAL_GRANT'});
 let screen=await call(b,'terminal_interact',{view:'screen'});const deadline=Date.now()+2000;
 while(!screen.text.includes('TOKEN=MANUAL_GRANT')&&Date.now()<deadline){await delay(20);screen=await call(b,'terminal_interact',{view:'screen'});}
 assert.match(screen.text,/TOKEN=MANUAL_GRANT/);
 await call(b,'terminal_session',{action:'dispose'});
 assert.equal((await f.ui.rpc<State>('state')).sessions.find(s=>s.id===manual.sessionId)!.latestRun!.status,'running','Context cleanup must not close a terminal created by the user');
 await call(a,'terminal_session',{action:'dispose'});
});

test('real sshd keeps cwd/environment and a running command independent across Agents', {skip:!process.env.AGENTBERTH_SSH_TEST_PORT,timeout:30000},async t=>{
 const folder=mkdtempSync(path.join(tmpdir(),'berth-posix-agents-')),daemon=new DaemonServer(path.join(folder,'data')),runtime=await daemon.listen();
 let ui:DaemonConnection;ui=await DaemonConnection.open(runtime,event=>{if(event.event==='sshChallenge')void ui.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='credentials'?{secret:{password:process.env.AGENTBERTH_SSH_TEST_PASSWORD!}}:{accepted:true})});});
 const clients=await Promise.all([DaemonConnection.open(runtime,()=>{}),DaemonConnection.open(runtime,()=>{})]);
 t.after(async()=>{await ui.rpc('shutdown').catch(()=>{});for(const client of clients)client.close(true);ui.close(true);await daemon.close();rmSync(folder,{recursive:true,force:true});});
 await ui.rpc('registerSshProvider');await ui.rpc('saveSshConnection',{config:{alias:'fixture',hostname:'127.0.0.1',port:Number(process.env.AGENTBERTH_SSH_TEST_PORT),username:process.env.AGENTBERTH_SSH_TEST_USERNAME!,authentication:'password',privateKeyPath:'',allowAgent:true}});
 const [a,b]=clients.map(client=>new TerminalMcp(client));
 const [one,two]=await Promise.all([call(a,'terminal_execute',{alias:'fixture',command:'export AB_PRIVATE=A; cd /tmp; printf "%s:%s\\n" "$AB_PRIVATE" "$PWD"'}),call(b,'terminal_execute',{alias:'fixture',command:'export AB_PRIVATE=B; cd /; printf "%s:%s\\n" "$AB_PRIVATE" "$PWD"'})]);
 assert.notEqual(one.sessionId,two.sessionId);assert.equal(one.output.text,'A:/tmp\r\n');assert.equal(two.output.text,'B:/\r\n');
 const waiting=await call(a,'terminal_execute',{alias:'fixture',command:'read AB_FINISH; printf "DONE=%s:%s\\n" "$AB_PRIVATE" "$PWD"',waitMs:0});assert.equal(waiting.status,'running');
 const independent=await call(b,'terminal_execute',{alias:'fixture',command:'printf "%s:%s\\n" "$AB_PRIVATE" "$PWD"'});assert.equal(independent.output.text,'B:/\r\n');
 await call(a,'terminal_interact',{text:'finish'});
 const finished=await call(a,'terminal_execute',{sessionId:waiting.sessionId,runId:waiting.runId,actionId:waiting.id,waitMs:5000});assert.equal(finished.status,'completed');assert.match(finished.output.text,/DONE=A:\/tmp/);
 await call(a,'terminal_session',{action:'dispose'});assert.equal((await call(b,'terminal_execute',{command:'printf STILL_B'})).output.text,'STILL_B');await call(b,'terminal_session',{action:'dispose'});
});
