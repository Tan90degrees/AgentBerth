import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationGroups,toolState,fileChange,toolCommand} from '../src/shared/acp-presentation';
import type {AcpEvent} from '../src/shared/acp';
test('parallel tool updates remain one card per call and preserve omitted fields',()=>{
  const event=(kind:AcpEvent['kind'],sequence:number,data?:Record<string,unknown>):AcpEvent=>({id:String(sequence),sequence,sessionId:'s',turnId:'turn',kind,text:'text',createdAt:'',data});
  const groups=conversationGroups([event('tool',1,{toolCallId:'read',title:'Read config',rawInput:{path:'a'},status:'pending'}),event('assistant',2),event('tool',3,{toolCallId:'write',status:'in_progress'}),event('thought',4),event('tool',5,{toolCallId:'read',title:null,status:'completed',content:[]}),event('tool',6,{toolCallId:'write',status:'failed',rawOutput:'denied'})]);
  const tools=groups.filter(group=>group[0].kind==='tool');assert.equal(tools.length,2);assert.deepEqual(tools.map(group=>toolState(group).status),['completed','failed']);assert.equal(toolState(tools[0]).title,'Read config');assert.deepEqual(toolState(tools[0]).rawInput,{path:'a'});
  assert.equal(groups.filter(group=>group[0].kind==='assistant').length,1);
});
test('file changes distinguish removed and added lines without confusing unchanged context',()=>{
  const diff=fileChange('before\nflag=false\nafter','before\nflag=true\nafter');
  assert.deepEqual(diff.lines.map(line=>line.kind),['context','remove','add','context']);assert.equal(diff.lines[1].text,'flag=false');assert.equal(diff.lines[2].text,'flag=true');assert.equal(fileChange('',Array(1000).fill('line').join('\n')).truncated,true);
});

test('file changes show accurate counts and source line numbers for new, deleted and offset content',()=>{
  const created=fileChange(null,'first\nsecond\n');assert.equal(created.added,2);assert.equal(created.removed,0);assert.deepEqual(created.lines.map(line=>[line.oldLine,line.newLine]),[[null,1],[null,2]]);
  const removed=fileChange('first\nsecond\n','');assert.equal(removed.removed,2);assert.equal(removed.added,0);
  const same=fileChange('same\n','same\n');assert.equal(same.added+same.removed,0);
  const diff=fileChange('one\ntwo\nthree\nfour\nfive\nsix\nseven','one\ntwo\nthree\nfour\nnew\nextra\nsix\nseven');assert.deepEqual(diff.lines.at(-1),{kind:'context',text:'seven',oldLine:7,newLine:8});
});
test('command presentation preserves quoted arguments and leaves unrecognized input available as JSON',()=>{
  assert.equal(toolCommand({command:'node',args:['-e','console.log("ok")']}),'node -e '+JSON.stringify('console.log("ok")'));
  assert.equal(toolCommand({path:'x'}),null);assert.equal(toolCommand({cmd:'git status --short'}),'git status --short');
});
