import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal } from '@xterm/headless';
import { terminalPathRanges } from '../src/renderer/terminal-paths';

test('path hints map wrapped output and wide Unicode cells without changing selection', async () => {
  const terminal = new Terminal({ cols: 12, rows: 5, allowProposedApi: true });
  await new Promise<void>(resolve => terminal.write('中文 src/文件.ts:2:1', resolve));
  const links = terminalPathRanges(terminal.buffer.active, 1);
  assert.equal(links[0].text, 'src/文件.ts:2:1');
  assert.equal(links[0].start.x, 6); assert.ok(links[0].end.y > links[0].start.y);
  assert.equal(terminalPathRanges(terminal.buffer.active, links[0].end.y)[0].text, links[0].text);
  terminal.dispose();
});
