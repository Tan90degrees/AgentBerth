import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationGroups,toolState,fileChange} from '../src/shared/acp-presentation';
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
