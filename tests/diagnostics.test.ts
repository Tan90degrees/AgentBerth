import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnostics } from '../src/shared/diagnostics';
import { API_VERSION } from '../src/shared/protocol';

test('copied diagnostics include versions and status while excluding workspace content and credentials', () => {
  const info = { version: '0.8.0', platform: 'win32', arch: 'x64', osRelease: '10.0.26100', electron: '44.7.0', node: '24.21.0', packaged: true,
    token: 'SECRET_TOKEN', projectPath: 'C:/private/work', command: 'agent --key PRIVATE_KEY', sessionContent: 'private conversation' };
  const text = diagnostics(info, false, 8, 2);
  assert.match(text, /StackIsle 0.8.0/); assert.match(text, /未连接/); assert.ok(text.includes(`应用 API: ${API_VERSION}`)); assert.match(text, /运行终端: 2/);
  for (const value of [info.token, info.projectPath, info.command, info.sessionContent, 'PRIVATE_KEY']) assert.ok(!text.includes(value));
});
