import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/daemon/store';
import { readHistory, sameDirectory } from '../src/daemon/history';
import { RunLog, LOG_SEGMENT_BYTES } from '../src/daemon/logs';
import { launchCommand } from '../src/daemon/paths';
import { requestSchema } from '../src/shared/protocol';

test('projects deduplicate and sessions retain separate run history across daemon restarts', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-store-'));
  let store = new Store(folder);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = store.createProject('项目', folder);
  assert.equal(store.createProject('另一个名字', folder).id, project.id);
  const a = store.createSession(project.id, '控制算法', 'shell', '');
  const b = store.createSession(project.id, '调试', 'shell', '');
  const first = store.createRun(a.id, 'codex', 100, 30);
  store.finish(first.id, 'exited', 0, null, 'screen', 1, 100, 30);
  const second = store.createRun(a.id, 'codex', 120, 40);
  store.createRun(b.id, '', 80, 24);
  store.close();
  const recovered = store = new Store(folder);
  assert.equal(recovered.state().sessions.length, 2);
  assert.equal(recovered.runs(a.id).length, 2);
  assert.equal(recovered.run(second.id).status, 'interrupted');
  assert.equal(recovered.run(first.id).status, 'exited');
  assert.equal(recovered.savedScreen(first.id).snapshot, 'screen');
});

test('Codex JSONL associates native IDs, avoids event/response duplicates and rejects another directory', async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-history-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'rollout.jsonl');
  writeFileSync(file, [
    { type: 'session_meta', payload: { session_id: '1234-abcd', cwd: folder } },
    { type: 'event_msg', payload: { type: 'user_message', message: '修复调度' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复调度' }] } },
    { type: 'response_item', payload: { item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已修复' }] } } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n{"partial":');
  const history = await readHistory(file, 'codex', folder);
  assert.equal(history.nativeSessionId, '1234-abcd');
  assert.deepEqual(history.messages.map(item => item.text), ['修复调度', '已修复']);
  assert.ok(history.warnings.some(item => item.includes('1 行')));
  await assert.rejects(readHistory(file, 'codex', path.join(folder, 'other')), /工作目录/);
});

test('Claude native transcript preserves text and excludes tool payloads', async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-claude-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'session.jsonl');
  writeFileSync(file, [
    { sessionId: 'claude-123', cwd: folder, type: 'user', message: { role: 'user', content: '你好' } },
    { sessionId: 'claude-123', cwd: folder, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '你好，已连接' }, { type: 'tool_use', name: 'Bash', input: { command: 'secret' } }] } },
  ].map(item => JSON.stringify(item)).join('\n'));
  const history = await readHistory(file, 'claude', folder);
  assert.deepEqual(history.messages.map(item => item.text), ['你好', '你好，已连接']);
});

test('Windows directory matching is case insensitive and does not match similarly named folders', () => {
  assert.ok(sameDirectory('D:\\Projects\\OmniOCR\\', 'd:/projects/omniocr', 'win32'));
  assert.ok(!sameDirectory('D:\\Projects\\OmniOCR-copy', 'D:\\Projects\\OmniOCR', 'win32'));
});

test('native IDs cannot inject shell commands and invalid terminal dimensions are rejected', () => {
  const session: any = { agent: 'codex', nativeSessionId: 'abc; echo injected' };
  assert.throws(() => launchCommand(session, true), /有效/);
  assert.throws(() => launchCommand({ agent: 'custom', command: 'echo a\necho b' } as any, false), /单行/);
  assert.ok(!requestSchema.safeParse({ id: '123', method: 'start', params: { cols: 9999999 } }).success);
});

test('run logs rotate at a fixed disk budget and retain the newest output', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-log-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const log = new RunLog(folder, 'run');
  for (let n = 0; n < 7; n++) log.append(String(n).repeat(LOG_SEGMENT_BYTES));
  const output = log.read();
  assert.equal(output.length, 4 * LOG_SEGMENT_BYTES);
  assert.equal(output.slice(0, 2), '33');
  assert.equal(output.slice(-2), '66');
  assert.equal(statSync(path.join(folder, 'run.log')).size, LOG_SEGMENT_BYTES);
});
