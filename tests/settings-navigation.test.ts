import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSettings, settingsCatalog } from '../src/renderer/settings-catalog';
import type { AgentDefinition } from '../src/shared/protocol';

test('settings search covers Chinese labels, English terms and imported Agent names', () => {
  const entries = settingsCatalog([{name:'Aider Dev'} as AgentDefinition],28);
  const ids = (query: string) => filterSettings(entries,query,'all').map(entry=>entry.id);
  assert.deepEqual(ids('  PWSH  '),['shell']);
  assert.deepEqual(ids('ssh 上限'),['ssh-limit']);
  assert.deepEqual(ids('预览 字体'),['preview']);
  assert.ok(ids('font').includes('preview')); assert.ok(ids('font').includes('terminal-font'));
  assert.ok(ids('AIDER dev').includes('agent-integrations')); assert.ok(ids('AIDER dev').includes('default-agent'));
  assert.deepEqual(ids('复制 诊断'),['about']);
  assert.ok(ids('自定义agent').includes('agent-integrations'));
  assert.ok(!ids('自定义agent').includes('agent-types'));
  assert.deepEqual(ids('终端 密码'),[]); // All terms must match the same setting entry.
  assert.deepEqual(ids('诊断'),['about']);
  assert.deepEqual(ids('definitely absent'),[]);
  assert.deepEqual(filterSettings(entries,'pwsh','ssh'),[]);
});

test('common/category filters keep management separate and capability-gated settings searchable only when available', () => {
  const entries=settingsCatalog([],28);
  assert.deepEqual(filterSettings(entries,'','common').map(value=>value.id),['theme','shell','terminal-font','local-limit','default-agent','ssh-limit']);
  assert.deepEqual(filterSettings(entries,'','terminal').map(value=>value.id),['shell','terminal-font','local-limit']);
  assert.deepEqual(filterSettings(entries,'','agents').map(value=>value.id),['default-agent','skills','agent-integrations']);
  assert.deepEqual(filterSettings(entries,'','ssh').map(value=>value.id),['ssh-limit','connections']);
  assert.ok(!settingsCatalog([],20).some(value=>['connections','mcp'].includes(value.id)));
  assert.ok(settingsCatalog([],21).some(value=>value.id==='mcp'));
  assert.equal(new Set(entries.map(value=>value.id)).size,entries.length);
});
