import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSettings, settingsCatalog } from '../src/renderer/settings-catalog';
import type { AgentDefinition } from '../src/shared/protocol';

test('core settings search cannot reveal plugin-owned settings', () => {
  const entries=settingsCatalog([{name:'Aider Dev'} as AgentDefinition],40);
  const ids=(query:string)=>filterSettings(entries,query,'all').map(entry=>entry.id);
  assert.deepEqual(ids('PWSH'),['shell']);
  assert.deepEqual(ids('字体'),['terminal-font']);
  assert.deepEqual(ids('Aider Dev'),[]);
  assert.deepEqual(ids('桌宠'),[]);
  assert.deepEqual(ids('预览'),[]);
  assert.deepEqual(ids('ssh'),[]);
  assert.deepEqual(ids('mcp'),[]);
  assert.deepEqual(ids('Agent'),[]);
  assert.deepEqual(ids('Git'),[]);
  assert.deepEqual(ids('外观'),[]);
  assert.deepEqual(ids('诊断'),['about']);
  assert.deepEqual(ids('definitely absent'),[]);
  assert.deepEqual(ids('终端 密码'),[]);
});
test('only global terminal and backend settings remain in the core catalog',()=>{
  const entries=settingsCatalog([],40);
  assert.deepEqual(filterSettings(entries,'','common').map(value=>value.id),['shell','terminal-font','local-limit']);
  assert.deepEqual(filterSettings(entries,'','terminal').map(value=>value.id),['shell','terminal-font','local-limit']);
  assert.deepEqual(filterSettings(entries,'','all').map(value=>value.id),['shell','terminal-font','local-limit','backend','about']);
  assert.equal(new Set(entries.map(value=>value.id)).size,entries.length);
  assert.ok(entries.every(entry=>!['theme','preview','pet','mcp','connections','default-agent','ssh-limit','plugins','skills'].includes(entry.id)));
});
