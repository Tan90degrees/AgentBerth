import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TerminalMcp, McpError } from '../src/mcp/server';
import { DaemonRpcError } from '../src/main/connection';
import { resultHarness } from '../src/mcp/harness';
import { commandReply } from '../src/mcp/results';
import { boundedToolText, MAX_RESULT_BYTES } from '../src/mcp/result-limits';
import type { Method, RemoteCommandResult, RemoteInfo } from '../src/shared/protocol';

const sessionId=randomUUID(),runId=randomUUID();
const info:RemoteInfo={sessionId,runId,host:'fixture',connection:'connected',owner:'agent',phase:'idle',cwd:'/tmp',error:null,commandTracking:'posix'};
const result=(status:'running'|'completed'|'unknown'='completed'):RemoteCommandResult=>({id:randomUUID(),sessionId,runId,sequence:1,elapsedMs:1,kind:'command',label:'printf OK',status,startedAt:new Date().toISOString(),endedAt:status==='running'?null:new Date().toISOString(),exitCode:status==='completed'?0:null,info,output:{text:'OK\n',mode:'summary',format:'terminal',available:true,truncated:false,hasMore:false,nextCursor:3,earliestCursor:0}});
const invoke=async(server:TerminalMcp,name:string,args:Record<string,unknown>={})=>{const reply:any=await server.request('tools/call',{name,arguments:args});return {reply,value:JSON.parse(reply.content[0].text)};};

test('tool discovery alone supplies usage and annotations; the built-in guide works without a daemon',async()=>{
  let calls=0;const server=new TerminalMcp({rpc:async()=>{calls++;throw new Error('must not connect');}});
  const listed:any=await server.request('tools/list',{});
  assert.equal(listed.tools.length,4);
  const execute=listed.tools.find((x:any)=>x.name==='terminal_execute');assert.match(execute.description,/SAME tool/);assert.match(execute.description,/Opens\/reuses/);assert.equal(execute.annotations.readOnlyHint,false);
  assert.deepEqual(listed.tools.map((x:any)=>x.name),['terminal_execute','terminal_interact','terminal_session','terminal_transfer']);
  assert.ok(!listed.tools.find((x:any)=>x.name==='terminal_execute').inputSchema.required.includes('requestId'));
  const initialized:any=await server.request('initialize',{protocolVersion:'2025-11-25'});assert.ok(initialized.capabilities.resources);assert.ok(initialized.instructions.length<1800);
  const resources:any=await server.request('resources/list',{});const guide:any=await server.request('resources/read',{uri:resources.resources[0].uri});assert.match(guide.contents[0].text,/COMMAND_RUNNING/);
  await assert.rejects(server.request('resources/read',{uri:'file:///private'}),McpError);assert.equal(calls,0);
});

test('no copied prompt or initialization is needed for auto-open execute and exact incremental next calls',async()=>{
  const calls:{method:string;params:any}[]=[],value=result('running');
  const server=new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{calls.push({method,params});return (method==='remoteOpen'?{sessionId,runId,info}:method==='remoteReadOutput'?{...value,status:'completed',exitCode:0,output:{...value.output,text:'DONE\n',nextCursor:8}}:value) as T;}});
  const running=await invoke(server,'terminal_execute',{alias:'fixture',command:'printf OK'});assert.ok(!running.reply.isError);assert.deepEqual(calls.map(x=>x.method),['remoteOpen','remoteCommand']);assert.match(calls[1].params.requestId,/^[a-f0-9-]{36}$/);
  const next=running.value.harness.next;assert.equal(next.tool,'terminal_execute');assert.equal(next.arguments.actionId,value.id);assert.equal(next.arguments.cursor,3);
  const completed=await invoke(server,next.tool,next.arguments);assert.equal(completed.value.harness.state,'completed');assert.equal(completed.value.harness.next,null);assert.equal(calls.filter(x=>x.method==='remoteCommand').length,1);
  const invalid=await invoke(server,'terminal_execute',{alias:'fixture',command:'bad\u0001'});assert.equal(invalid.value.error.code,'INVALID_ARGUMENTS');assert.equal(invalid.value.error.execution,'not_started');assert.equal(calls.length,3,'Invalid input cannot open SSH or transmit commands');
});

test('typed failures prescribe safe recovery without guessing remote output or replaying commands',async()=>{
  let fault=new DaemonRpcError('arbitrary message','USER_CONTROLLED',{sessionId,runId});
  const server=new TerminalMcp({rpc:async<T>(method:Method)=>{if(method==='remoteOpen')return {sessionId,runId,info} as T;throw fault;}});
  const requestId=randomUUID(),args={alias:'fixture',requestId,command:'side effect'};
  const user=await invoke(server,'terminal_execute',args);assert.equal(user.value.error.code,'USER_CONTROLLED');assert.equal(user.value.error.execution,'not_started');assert.equal(user.value.harness.next,null);assert.match(user.value.harness.userAction,/交给 Agent/);
  const pending=randomUUID();fault=new DaemonRpcError('not a prompt','COMMAND_RUNNING',{sessionId,runId,actionId:pending});const busy=await invoke(server,'terminal_execute',args);assert.equal(busy.value.harness.next.arguments.actionId,pending);
  fault=new DaemonRpcError('anything','PROMPT_REQUIRED',{sessionId,runId});assert.equal((await invoke(server,'terminal_execute',args)).value.harness.next.tool,'terminal_interact');
  fault=new DaemonRpcError('anything','STALE_RUN',{sessionId,runId});assert.equal((await invoke(server,'terminal_execute',args)).value.harness.next.tool,'terminal_session');
  fault=new DaemonRpcError('connection lost after write','OUTCOME_UNKNOWN',{sessionId,runId,actionId:requestId});const unknown=await invoke(server,'terminal_execute',args);assert.equal(unknown.value.error.execution,'unknown');assert.equal(unknown.value.error.requestId,requestId);assert.equal(unknown.value.harness.next.tool,'terminal_execute');assert.equal(unknown.value.harness.replayAllowed,false);
});

test('transfers generate IDs, return exact waits and preserve identity on unknown outcomes',async()=>{
  let fail=false;const calls:{method:string;params:any}[]=[];
  const server=new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{calls.push({method,params});if(fail)throw new Error('transport lost');return (method==='remoteTransferStart'?{id:params!.requestId,status:'running',spec:params}:null) as T;}});
  const args={sessionId,runId,localPath:'/tmp/local',remotePath:'/tmp/remote'};const started=await invoke(server,'terminal_upload',args);assert.ok(!started.reply.isError);assert.equal(started.value.harness.next.tool,'terminal_transfer');assert.equal(started.value.harness.next.arguments.requestId,started.value.id);
  fail=true;const failed=await invoke(server,'terminal_upload',args);assert.equal(failed.value.error.execution,'unknown');assert.equal(failed.value.harness.next.arguments.requestId,calls.at(-1)!.params.requestId);
});

test('harness avoids screen loops, keeps bounded output optional and survives JSON limiting',()=>{
  assert.equal(resultHarness('terminal_screen',{info:{...info,phase:'busy'}}).harness.next,null);
  const value=result();value.output={...value.output,omitted:true,truncated:true,cacheLost:false};const completed=resultHarness('terminal_execute',commandReply(value));assert.equal(completed.harness.state,'completed');assert.equal(completed.harness.next,null);
  value.status='running';value.output.text='中'.repeat(200000);const running=resultHarness('terminal_execute',commandReply(value));const encoded=boundedToolText(running);assert.ok(Buffer.byteLength(encoded)<=MAX_RESULT_BYTES);const bounded=JSON.parse(encoded);assert.deepEqual(bounded.harness.next,running.harness.next);
  value.output.available=false;assert.equal(resultHarness('terminal_read_output',commandReply(value)).harness.next.tool,'terminal_wait','Unavailable logs must not cause an immediate output-poll loop');
});
