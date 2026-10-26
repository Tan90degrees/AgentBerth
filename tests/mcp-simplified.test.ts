import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TerminalMcp, tools } from '../src/mcp/server';
import { DaemonRpcError } from '../src/main/connection';
import type { Method, RemoteCommandResult, RemoteInfo } from '../src/shared/protocol';

const sessionId=randomUUID(),runId=randomUUID(),id=randomUUID();
const info:RemoteInfo={sessionId,runId,host:'fixture',connection:'connected',owner:'agent',phase:'idle',cwd:'/tmp',error:null,commandTracking:'posix'};
const command=(status:'running'|'completed'='completed'):RemoteCommandResult=>({id,sessionId,runId,sequence:1,kind:'command',label:'fixture',startedAt:new Date().toISOString(),endedAt:null,status,exitCode:status==='completed'?0:null,elapsedMs:1,info,output:{text:'FIRST\nLAST\n',nextCursor:11,earliestCursor:0,available:true,truncated:false,hasMore:false,format:'terminal',mode:'summary'}});
const invoke=async(server:TerminalMcp,name:string,args:Record<string,unknown>={})=>{const reply:any=await server.request('tools/call',{name,arguments:args});return {reply,value:JSON.parse(reply.content[0].text)};};

test('one execution tool waits for completion, then reads the same result with no target or command bookkeeping',async()=>{
  const calls:{method:string;params:any}[]=[];
  const server=new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{calls.push({method,params});return (method==='remoteOpen'?{sessionId,runId,info}:command()) as T;}});
  const first=await invoke(server,'terminal_execute',{alias:'fixture',command:'printf FIRST; work; printf LAST'});
  assert.ok(!first.reply.isError);assert.equal(first.value.allOutputInThisResponse,true);
  assert.equal(calls[1].params.waitFor,'completion');assert.equal(calls[1].params.waitMs,25000);
  const second=await invoke(server,'terminal_execute');assert.ok(!second.reply.isError);assert.equal(second.value.id,id);assert.equal(second.value.output.text,first.value.output.text);
  assert.deepEqual(calls.at(-1)?.params.sessionId,sessionId);assert.equal(calls.at(-1)?.method,'remoteReadOutput');assert.equal(calls.at(-1)?.params.waitFor,'completion');
  assert.equal(calls.filter(call=>call.method==='remoteCommand').length,1);
  const bad=await invoke(server,'terminal_execute',{command:'repeat',actionId:id});assert.equal(bad.reply.isError,true);assert.equal(calls.length,3,'Mixed read/execute arguments must not transmit');
});

test('ordinary-command observation recovers output, explicit TUI and input return one viewport without another screen instruction',async()=>{
  const calls:string[]=[];let phase:RemoteInfo['phase']='idle',noHistory=false;
  const server=new TerminalMcp({rpc:async<T>(method:Method)=>{
    calls.push(method);
    if(method==='remoteResolve')return {sessionId,runId} as T;
    if(method==='remoteInfo')return {...info,phase} as T;
    if(method==='remoteReadOutput'){if(noHistory)throw new DaemonRpcError('no history','NO_COMMAND_OUTPUT');return command() as T;}
    if(method==='remoteKeys'){phase='unknown';return {inputKind:'interactive',info:{...info,phase}} as T;}
    return {text:'TUI five rows',cols:80,rows:5,info:{...info,phase},cursor:{x:0,y:0}} as T;
  }});
  const recovered=await invoke(server,'terminal_interact',{alias:'fixture'});assert.equal(recovered.value.scope,'command');assert.equal(recovered.value.output.text,'FIRST\nLAST\n');assert.ok(!calls.includes('remoteScreen'));
  const viewport=await invoke(server,'terminal_interact',{view:'screen'});assert.equal(viewport.value.scope,'viewport');assert.equal(viewport.value.harness.next,null);
  const input=await invoke(server,'terminal_interact',{key:'Down'});assert.ok(!input.reply.isError);assert.equal(input.value.scope,'viewport');assert.equal(input.value.harness.next,null);assert.deepEqual(calls.slice(-2),['remoteKeys','remoteScreen']);
  phase='idle';noHistory=true;const empty=await invoke(server,'terminal_interact');assert.ok(!empty.reply.isError);assert.equal(empty.value.scope,'viewport','An initial empty terminal is observable without a failing output call');
});

test('session and transfer actions share four discoverable names and all trusted next pointers use those names',async()=>{
  const calls:{method:string;params:any}[]=[];
  const server=new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{calls.push({method,params});return (method==='remoteResolve'?{sessionId,runId}:method==='remoteTransferStart'?{id:params!.requestId,status:'running',spec:params}:method==='remoteTransferStatus'?{id:params!.requestId,status:'completed',spec:{}}:{info}) as T;}});
  assert.deepEqual(tools.map(tool=>tool.name),['terminal_execute','terminal_interact','terminal_session','terminal_transfer']);
  const created=await invoke(server,'terminal_session',{action:'create',alias:'fixture',title:'parallel'});assert.ok(!created.reply.isError);assert.equal(calls[0].method,'remoteManage');assert.equal(calls[0].params.action,'create');
  const sent=await invoke(server,'terminal_transfer',{action:'upload',alias:'fixture',localPath:'/tmp/local',remotePath:'/tmp/remote'});assert.ok(!sent.reply.isError);assert.equal(sent.value.harness.next.tool,'terminal_transfer');assert.equal(sent.value.harness.next.arguments.action,'status');
  const finished=await invoke(server,sent.value.harness.next.tool,sent.value.harness.next.arguments);assert.equal(finished.value.status,'completed');assert.equal(finished.value.harness.next,null);
});

test('running results and cache/parameter errors retain identity without offering hidden tools or replay',async()=>{
  let fault:DaemonRpcError|undefined;
  const server=new TerminalMcp({rpc:async<T>(method:Method)=>{if(method==='state')return {apiVersion:34} as T;if(fault)throw fault;return command('running') as T;}});
  const running=await invoke(server,'terminal_execute',{sessionId,runId,command:'long task'});assert.equal(running.value.harness.next.tool,'terminal_execute');assert.equal(running.value.harness.next.arguments.actionId,id);assert.equal(running.value.harness.next.arguments.waitFor,'completion');assert.ok(!('command'in running.value.harness.next.arguments));
  fault=new DaemonRpcError('Invalid arguments: cursor','INVALID_ARGUMENTS');const invalid=await invoke(server,'terminal_execute',{waitMs:0});assert.equal(invalid.value.error.code,'INVALID_ARGUMENTS');assert.equal(invalid.value.error.execution,'not_started');
  fault=new DaemonRpcError('lost','OUTCOME_UNKNOWN',{sessionId,runId,actionId:id});const unknown=await invoke(server,'terminal_execute',{sessionId,runId,command:'side effect',requestId:id});assert.equal(unknown.value.harness.next.tool,'terminal_execute');assert.equal(unknown.value.harness.next.arguments.actionId,id);assert.equal(unknown.value.harness.replayAllowed,false);
});
