import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TerminalMcp } from '../src/mcp/server';
import { DaemonRpcError } from '../src/main/connection';
import type { Method, RemoteCommandResult } from '../src/shared/protocol';

test('typed parameter rejection from an old backend yields upgrade guidance without dropping search or replaying',async()=>{
  const calls:string[]=[],server=new TerminalMcp({rpc:async<T>(method:Method)=>{calls.push(method);if(method==='state')return {apiVersion:32} as T;throw new DaemonRpcError('请求参数无效：search','INVALID_ARGUMENTS');}});
  const reply:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId:randomUUID(),runId:randomUUID(),command:'printf OK',search:{query:'error'}}});
  const value=JSON.parse(reply.content[0].text);assert.equal(value.error.code,'BACKEND_UPGRADE_REQUIRED');assert.equal(value.error.execution,'not_started');assert.deepEqual(calls,['remoteCommand','state']);
});

test('compact metadata preserves decisions and output without repeated notices or duplicated text',async()=>{
  const sessionId=randomUUID(),runId=randomUUID(),id=randomUUID();let calls=0;
  const value:RemoteCommandResult={id,sessionId,runId,sequence:1,kind:'command',label:'printf system information; '+ 'command metadata '.repeat(20),status:'completed',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),exitCode:0,elapsedMs:12,info:{sessionId,runId,host:'fixture',owner:'agent',phase:'idle',connection:'connected',cwd:'/tmp',commandTracking:'posix',error:null},output:{text:'STDOUT_SENTINEL\n',available:true,format:'terminal',mode:'summary',truncated:false,hasMore:false,nextCursor:16,earliestCursor:0}};
  const server=new TerminalMcp({rpc:async<T>(_method:Method)=>{calls++;return value as T;}});
  const invoke=async(detail?:string)=>server.request('tools/call',{name:'terminal_execute',arguments:{sessionId,runId,command:'printf OK',...(detail?{detail}:{})}}) as Promise<any>;
  const compact=await invoke(),full=await invoke('full'),c=JSON.parse(compact.content[0].text),f=JSON.parse(full.content[0].text);
  assert.deepEqual(c.output,f.output);assert.equal(c.id,f.id);assert.equal(c.status,'completed');assert.equal(c.exitCode,0);assert.equal(c.info.cwd,'/tmp');assert.equal(c.harness.next,null);assert.ok(!('notice' in c));assert.ok('notice' in f);assert.ok(compact.content[0].text.length<full.content[0].text.length);assert.equal(JSON.stringify(compact).split('STDOUT_SENTINEL').length-1,1);
  const invalid=await invoke('invalid');assert.equal(invalid.isError,true);assert.equal(calls,2);
  const nullId:any=await server.request('tools/call',{name:'terminal_execute',arguments:{alias:'fixture',requestId:null,command:'printf OK'}});assert.equal(nullId.isError,true);assert.equal(calls,2);
});
