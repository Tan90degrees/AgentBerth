import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requestSchema, type RemoteCommandResult } from '../src/shared/protocol';
import { commandReply, screenReply } from '../src/mcp/results';

const fixture=():RemoteCommandResult=>({id:randomUUID(),sessionId:randomUUID(),runId:randomUUID(),sequence:1,kind:'command',label:'docker images',status:'completed',startedAt:'2026-10-23T00:00:00Z',endedAt:'2026-10-23T00:00:01Z',exitCode:0,elapsedMs:1000,info:{} as RemoteCommandResult['info'],output:{text:'image-first\nimage-last\n',format:'terminal',available:true,truncated:false,hasMore:false,nextCursor:23,earliestCursor:0}});

test('command replies distinguish whole results, pages, running output and loss with exact read continuations',()=>{
  const value=fixture(),whole=commandReply(value);assert.equal(whole.scope,'command');assert.equal(whole.allOutputInThisResponse,true);assert.equal(whole.continuation,null);
  value.output.hasMore=true;
  const page=commandReply(value,0,256);assert.equal(page.allOutputInThisResponse,false);assert.equal(page.continuation,null);assert.deepEqual(page.details,{tool:'terminal_read_output',arguments:{sessionId:value.sessionId,runId:value.runId,actionId:value.id,cursor:23,timeoutMs:0,mode:'page',maxChars:256}});assert.match(page.notice,/不要.*自动读完/);
  value.output.hasMore=false;
  const last=commandReply(value,23);assert.equal(last.allOutputInThisResponse,false);assert.match(last.notice,/不自动读取此前/);
  value.status='running';assert.equal(commandReply(value).continuation?.arguments.timeoutMs,25000);assert.equal(commandReply(value).allOutputInThisResponse,false);
  value.status='unknown';assert.equal(commandReply(value).continuation,null);assert.equal(commandReply(value).allOutputInThisResponse,false);
  value.status='completed';value.output.truncated=true;assert.equal(commandReply(value).allOutputInThisResponse,false);assert.match(commandReply(value).notice,/不能宣称结果完整/);
  value.output.available=false;assert.equal(commandReply(value).continuation,null);
});

test('viewport results never claim complete command output and recover from the beginning, not the last screen',()=>{
  const command=fixture();const screen=screenReply({text:'image-last',command});
  assert.equal(screen.continuation,null);assert.equal(screen.details?.arguments.mode,'summary');assert.equal(screen.scope,'viewport');assert.equal(screen.allOutputInThisResponse,false);assert.equal(screen.details?.arguments.actionId,command.id);assert.equal(screen.details?.arguments.cursor,0);assert.match(screen.notice,/不等于命令输出丢失/);
  const raw=screenReply({text:'partial untracked output',command:null});assert.equal(raw.continuation,null);assert.match(raw.notice,/没有可靠/);
});


test('latest-command discovery starts at zero and later cursors require an explicit command ID',()=>{
  const target={sessionId:randomUUID(),runId:randomUUID()},request=(extra:object)=>({id:randomUUID(),method:'remoteReadOutput',params:{...target,...extra}});
  assert.equal(requestSchema.safeParse(request({})).success,true);
  assert.equal(requestSchema.safeParse(request({cursor:42})).success,false);
  assert.equal(requestSchema.safeParse(request({cursor:42,actionId:randomUUID()})).success,true);
});


test('budget omission never instructs the Agent to drain every page',()=>{
  const value=fixture();value.output={...value.output,mode:'summary',omitted:true,truncated:true,cacheLost:false,totalBytes:500000,totalLines:6000};
  const result=commandReply(value);assert.equal(result.continuation,null);assert.equal(result.details?.arguments.mode,'page');assert.equal(result.allOutputInThisResponse,false);assert.match(result.notice,/不要自动读完分页/);assert.doesNotMatch(result.notice,/缓存已丢失/);
  value.status='running';const running=commandReply(value);assert.equal(running.continuation?.arguments.cursor,value.output.nextCursor);assert.equal(running.continuation?.arguments.mode,'summary');
});
