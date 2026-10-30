import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskLifecycle } from '../src/mcp/lifecycle';
import { TerminalMcp } from '../src/mcp/server';
import { AgentMcp } from '../src/mcp/agents';
import type { Method } from '../src/shared/protocol';

test('task lifecycle retains every unfinished/unknown command and transfer across completed sibling commands', () => {
 const life=new TaskLifecycle(),a=randomUUID(),b=randomUUID(),transfer=randomUUID(),sessionId=randomUUID();
 const command=(id:string,status:string)=>({id,sessionId,status,output:{text:'data'}});
 life.observe('terminal_execute',command(a,'running'));life.observe('terminal_execute',command(b,'completed'));
 assert.equal(life.hint().state,'retain_for_pending_work');assert.equal(life.hint().onTaskComplete,null);
 life.observe('terminal_transfer',{id:transfer,sessionId,spec:{},status:'running'});
 life.observe('terminal_read_output',command(a,'completed'));assert.equal(life.hint().onTaskComplete,null);
 life.observe('terminal_transfer_status',{id:transfer,sessionId,spec:{},status:'unknown'});assert.equal(life.hint().state,'retain_for_pending_work');
 life.observe('terminal_transfer_status',{id:transfer,sessionId,spec:{},status:'completed'});
 assert.deepEqual(life.hint().onTaskComplete,{tool:'terminal_session',arguments:{action:'dispose'}});
 life.failure('OUTCOME_UNKNOWN',{requestId:a,sessionId});assert.equal(life.hint().onTaskComplete,null);
 life.observe('terminal_read_output',command(a,'completed'));assert.equal(life.hint().state,'cleanup_before_final');
 life.observe('terminal_dispose',{closed:[sessionId],deleted:[sessionId]});assert.equal(life.hint(true).state,'released');
});

test('harness exposes an executable context-scoped finalizer without auto-dispatching cleanup; retention is explicit', async () => {
 const calls:{method:Method;params?:Record<string,unknown>}[]=[],sessionId=randomUUID(),runId=randomUUID();
 const agent=new AgentMcp(()=>({disconnect(){},server:new TerminalMcp({rpc:async<T>(method:Method,params?:Record<string,unknown>)=>{
  calls.push({method,params});if(method==='remoteAgentClose')return {closed:[sessionId],deleted:params?.deleteHistory?[sessionId]:[],retained:params?.deleteHistory?[]:[sessionId]} as T;
  return {sessionId,runId,info:{sessionId,runId,phase:'idle',owner:'agent',connection:'connected',commandTracking:'posix'}} as T;
 }})}));
 const invoke=async(args:Record<string,unknown>)=>{const reply=await agent.request('tools/call',{name:'terminal_session',arguments:args});assert.ok(!reply.isError);return JSON.parse(reply.content[0].text);};
 const opened=await invoke({agentId:'task-a',action:'open',alias:'fixture'});
 assert.deepEqual(calls.map(c=>c.method),['remoteOpen']);
 const next=opened.harness.lifecycle.onTaskComplete;assert.deepEqual(next,{tool:'terminal_session',arguments:{action:'dispose',agentId:'task-a'}});
 const disposed=await invoke(next.arguments);assert.equal(calls.at(-1)!.params!.deleteHistory,true);assert.equal(disposed.harness.lifecycle.state,'released');
 await invoke({agentId:'task-b',action:'open',alias:'fixture'});await invoke({agentId:'task-b',action:'dispose',keepHistory:true});assert.equal(calls.at(-1)!.params!.deleteHistory,false);
 agent.close();
});
