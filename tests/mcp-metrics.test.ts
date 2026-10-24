import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { McpCallStats } from '../src/daemon/mcp-metrics';
import { TerminalMcp } from '../src/mcp/server';
import type { McpCallMetric,Method } from '../src/shared/protocol';
import type { McpMetrics } from '../src/shared/protocol';

test('actual backend reports aggregated MCP events without creating terminals or counting internal RPC',async t=>{
  const folder=mkdtempSync(path.join(tmpdir(),'ab-mcp-stats-')),daemon=new DaemonServer(folder),runtime=await daemon.listen();
  let resolve!:()=>void;const updated=new Promise<void>(done=>resolve=done);
  const timeout=setTimeout(()=>resolve(),3000);
  const ui=await DaemonConnection.open(runtime,event=>{if(event.event==='mcpMetrics'&&event.data.total===2)resolve();}),agent=await DaemonConnection.open(runtime,()=>{});
  t.after(async()=>{clearTimeout(timeout);ui.close();agent.close();await daemon.close();rmSync(folder,{recursive:true,force:true});});
  const metrics:McpCallMetric[]=[],mcp=new TerminalMcp(agent,event=>{metrics.push(event);return agent.rpc('mcpRecordCall',event as unknown as Record<string,unknown>);});
  await mcp.request('tools/list',{});await mcp.request('tools/call',{name:'terminal_list'});
  await mcp.request('tools/call',{name:'terminal_execute',arguments:{alias:'fixture',command:'bad\x01'}});
  await updated;
  const snapshot=await ui.rpc<McpMetrics>('mcpMetrics');assert.equal(snapshot.total,2);assert.equal(snapshot.failed,1);assert.equal(snapshot.successRate,.5);
  await agent.rpc('mcpRecordCall',metrics[0] as unknown as Record<string,unknown>);assert.equal((await ui.rpc<McpMetrics>('mcpMetrics')).total,2);
  assert.equal((await ui.rpc<any>('state')).sessions.length,0);
});

test('per-backend metrics count tool calls and failures, deduplicate reports and expose no arguments',()=>{
  const stats=new McpCallStats();assert.equal(stats.snapshot().successRate,null);
  const event={callId:randomUUID(),tool:'terminal_execute',success:true};stats.record(event);stats.record(event);stats.record({...event,callId:randomUUID(),success:false});stats.record({...event,callId:randomUUID(),tool:'terminal_list'});
  const value=stats.snapshot();assert.equal(value.total,3);assert.equal(value.succeeded,2);assert.equal(value.failed,1);assert.equal(value.successRate,2/3);assert.deepEqual(Object.keys(value.tools[0]).sort(),['failed','succeeded','tool','total']);
  value.tools[0].total=100;assert.equal(stats.snapshot().tools[0].total,2,'Snapshots cannot mutate counters');
});

test('MCP reporting does not block results, counts nonzero command exit as tool success, and isolates telemetry failure',async()=>{
  const events:McpCallMetric[]=[],sessionId=randomUUID(),runId=randomUUID();let fail=false;
  const server=new TerminalMcp({rpc:async<T>(_method:Method)=>{if(fail)throw new Error('transport error');return {id:randomUUID(),status:'completed',exitCode:7} as T;}},event=>{events.push(event);return new Promise(()=>{});});
  await server.request('tools/list',{});assert.equal(events.length,0,'Protocol discovery is not a tool call');
  const success:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId,runId,command:'false'}});assert.ok(!success.isError);assert.equal(events[0].success,true);
  fail=true;const failure:any=await server.request('tools/call',{name:'terminal_execute',arguments:{sessionId,runId,command:'false'}});assert.equal(failure.isError,true);assert.equal(events[1].success,false);assert.notEqual(events[0].callId,events[1].callId);
  assert.ok(!('command' in events[0]));
  const broken=new TerminalMcp({rpc:async<T>()=>null as T},()=>{throw new Error('metric sink failed');});assert.ok(!(await broken.request('tools/call',{name:'terminal_close',arguments:{sessionId}}) as any).isError);
});
