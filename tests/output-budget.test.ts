import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedText, OUTPUT_PREVIEW_BYTES, OUTPUT_PREVIEW_LINES, OUTPUT_TAIL_BYTES } from '../src/shared/bounded-text';
import { boundedToolText, MAX_RESULT_BYTES } from '../src/mcp/result-limits';
import { CommandOutput } from '../src/daemon/remote-output';

test('defaults match ssh-skill and byte limits retain the head and diagnostic tail',()=>{
  assert.equal(OUTPUT_PREVIEW_BYTES,256*1024);assert.equal(OUTPUT_PREVIEW_LINES,4000);assert.equal(OUTPUT_TAIL_BYTES,64*1024);assert.equal(MAX_RESULT_BYTES,256*1024);
  const collector=new BoundedText(32,10,12);collector.append('head\n'+'middle\n'.repeat(10)+'TAIL-END\n');
  const value=collector.preview();assert.ok(value.omitted);assert.ok(value.text.startsWith('head'));assert.ok(value.text.includes('TAIL-END'));assert.ok(value.returnedBytes<=32);assert.equal(value.totalLines,12);
});

test('line caps preserve first/last lines without inserting synthetic output or splitting Unicode',()=>{
  const collector=new BoundedText(100,2,20);collector.append('first\nsecond\nthird\nlast\n');assert.equal(collector.preview().text,'first\nlast\n');assert.equal(collector.preview().totalLines,4);
  const unicode=new BoundedText(7,10,4);unicode.append('甲乙丙丁');assert.ok(!unicode.preview().text.includes('�'));assert.ok(unicode.preview().returnedBytes<=7);
  const contiguous=new BoundedText(20,10,4);contiguous.append('a'.repeat(15)+'中');assert.equal(contiguous.preview().text,'a'.repeat(15)+'中','A non-truncated UTF-8 scalar spanning head/tail is preserved');
  const both=new BoundedText(40,10,10);for(let i=0;i<100;i++)both.append('line-'+i+'\n');assert.ok(both.preview().returnedBytes<=40);assert.ok(both.preview().text.endsWith('line-99\n'));
});

test('summary skips omitted content without replaying it on the next streaming read; pages are opt-in',()=>{
  const buffer=new CommandOutput();buffer.append('FIRST\n'+'middle\n'.repeat(5000)+'LAST\n');
  const summary=buffer.summary();assert.ok(summary.omitted);assert.equal(summary.cacheLost,false);assert.ok(summary.text.startsWith('FIRST'));assert.ok(summary.text.endsWith('LAST\n'));assert.equal(summary.hasMore,false);assert.equal(summary.totalLines,5002);
  buffer.append('NEW\n');const incremental=buffer.summary(summary.nextCursor);assert.equal(incremental.text,'NEW\n');assert.equal(incremental.totalLines,1);assert.equal(incremental.omitted,false);
  assert.ok(buffer.read(0,65536).text.includes('middle\nmiddle\n'),'Explicit pages still contain locally cached details');
});

test('JSON result caps account for escapes, metadata, arrays and repeated text while preserving command identity',()=>{
  const id='9b6a65a8-7739-457f-92aa-f90a6444add6';
  const body={scope:'command',id,sessionId:id,runId:id,status:'completed',exitCode:7,allOutputInThisResponse:true,fromCursor:0,output:{text:'HEAD\n'+'中文😀\u0001'.repeat(50000)+'\nDIAGNOSTIC_TAIL',totalBytes:600000},info:{label:'x'.repeat(300000)},continuation:null};
  const text=boundedToolText(body),value=JSON.parse(text);assert.ok(Buffer.byteLength(text)<=MAX_RESULT_BYTES);assert.equal(value.id,id);assert.equal(value.status,'completed');assert.equal(value.exitCode,7);assert.equal(value.allOutputInThisResponse,false);assert.ok(value.resultLimit.truncated);assert.ok(value.output.text.startsWith('HEAD'));assert.ok(value.output.text.endsWith('DIAGNOSTIC_TAIL'));assert.equal(value.continuation,null);
  const many=JSON.parse(boundedToolText(Array.from({length:1000},(_,i)=>({index:i,text:'x'.repeat(1000)}))));assert.ok(many.resultLimit.truncated);assert.equal(many.data[0].index,0);assert.equal(many.data.at(-1).index,999);
  const small={text:'short 中文',status:'completed'};assert.deepEqual(JSON.parse(boundedToolText(small)),small);
  const continuation={tool:'terminal_read_output',arguments:{sessionId:id,runId:id,actionId:id,cursor:900000,mode:'summary',timeoutMs:25000}};
  const running=JSON.parse(boundedToolText({...body,status:'running',fromCursor:123,continuation}));
  assert.deepEqual(running.continuation,continuation,'JSON limiting must not stop waiting for new streaming output');
  assert.equal(running.details.arguments.cursor,123,'Opt-in detail recovery starts at the clipped range, not after it');
  assert.equal(running.details.arguments.mode,'page');assert.equal(running.details.arguments.maxChars,4096);
});
