import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestSchema, type RemoteCommandResult } from '../src/shared/protocol';
import { commandReply, screenReply } from '../src/mcp/results';

const fixture=():RemoteCommandResult=>({id:randomUUID(),sessionId:randomUUID(),runId:randomUUID(),sequence:1,kind:'command',label:'docker images',status:'completed',startedAt:'2026-10-23T00:00:00Z',endedAt:'2026-10-23T00:00:01Z',exitCode:0,elapsedMs:1000,info:{} as RemoteCommandResult['info'],output:{text:'image-first\nimage-last\n',format:'terminal',available:true,truncated:false,hasMore:false,nextCursor:23,earliestCursor:0}});

test('command replies distinguish whole results, pages, running output and loss with exact read continuations',()=>{
  const value=fixture(),whole=commandReply(value);assert.equal(whole.scope,'command');assert.equal(whole.allOutputInThisResponse,true);assert.equal(whole.continuation,null);
  value.output.hasMore=true;
  const page=commandReply(value,0,256);assert.equal(page.allOutputInThisResponse,false);assert.deepEqual(page.continuation,{tool:'terminal_read_output',arguments:{sessionId:value.sessionId,runId:value.runId,actionId:value.id,cursor:23,timeoutMs:0,maxChars:256}});assert.match(page.notice,/勿重新执行/);
  value.output.hasMore=false;
  const last=commandReply(value,23);assert.equal(last.allOutputInThisResponse,false);assert.match(last.notice,/各页合并/);
  value.status='running';assert.equal(commandReply(value).continuation?.arguments.timeoutMs,25000);assert.equal(commandReply(value).allOutputInThisResponse,false);
  value.status='unknown';assert.equal(commandReply(value).continuation,null);assert.equal(commandReply(value).allOutputInThisResponse,false);
  value.status='completed';value.output.truncated=true;assert.equal(commandReply(value).allOutputInThisResponse,false);assert.match(commandReply(value).notice,/不能宣称结果完整/);
  value.output.available=false;assert.equal(commandReply(value).continuation,null);
});

test('viewport results never claim complete command output and recover from the beginning, not the last screen',()=>{
  const command=fixture();const screen=screenReply({text:'image-last',command});
  assert.equal(screen.scope,'viewport');assert.equal(screen.allOutputInThisResponse,false);assert.equal(screen.continuation?.arguments.actionId,command.id);assert.equal(screen.continuation?.arguments.cursor,0);assert.match(screen.notice,/不等于结果丢失/);
  const raw=screenReply({text:'partial untracked output',command:null});assert.equal(raw.continuation,null);assert.match(raw.notice,/没有可可靠关联/);
});


test('latest-command discovery starts at zero and later cursors require an explicit command ID',()=>{
  const target={sessionId:randomUUID(),runId:randomUUID()},request=(extra:object)=>({id:randomUUID(),method:'remoteReadOutput',params:{...target,...extra}});
  assert.equal(requestSchema.safeParse(request({})).success,true);
  assert.equal(requestSchema.safeParse(request({cursor:42})).success,false);
  assert.equal(requestSchema.safeParse(request({cursor:42,actionId:randomUUID()})).success,true);
});
