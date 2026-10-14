import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { externalWebUrl, inputChunks, terminalDimensions, windowsPtyFor } from '../src/shared/desktop';
import { requestSchema } from '../src/shared/protocol';

test('large terminal input remains ordered, Unicode intact and below the WebSocket payload limit', () => {
  const text = '中🙂文'.repeat(15000) + '\x00\x1b\n'.repeat(3000) + '末尾';
  assert.ok(Buffer.byteLength(text) > 128 * 1024);
  const chunks = inputChunks(text);
  assert.equal(chunks.join(''), text);
  for (let index = 0; index < chunks.length; index++) {
    const request = { id: randomUUID(), method: 'input', params: { sessionId: randomUUID(), runId: randomUUID(), data: chunks[index] } };
    assert.ok(requestSchema.safeParse(request).success);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) < 128 * 1024);
    if (index + 1 < chunks.length) assert.ok(!/[\uD800-\uDBFF]$/.test(chunks[index]), 'Surrogate pair was split');
  }
  const escaped = inputChunks('\x00'.repeat(65536));
  assert.ok(escaped.every(data => Buffer.byteLength(JSON.stringify(data)) < 128 * 1024));
});

test('desktop links accept web URLs and reject executable, local and credential-bearing navigation', () => {
  assert.equal(externalWebUrl('https://example.com/path?q=你好#section'), 'https://example.com/path?q=%E4%BD%A0%E5%A5%BD#section');
  assert.equal(externalWebUrl('HTTP://EXAMPLE.COM'), 'http://example.com/');
  for (const value of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'mailto:test@example.com', 'custom-agent://run', 'https://user:password@example.com', 'https://example.com\n', 'invalid', null, 'https://example.com/' + 'a'.repeat(8192)]) assert.throws(() => externalWebUrl(value));
});

test('terminal fitting keeps the rendered grid inside daemon resize protocol bounds', () => {
  for (const [cols, rows] of [[4, 1], [500, 150], [82.9, 30.4]]) {
    const dimensions = terminalDimensions(cols, rows);
    assert.ok(requestSchema.safeParse({ id: randomUUID(), method: 'resize', params: { sessionId: randomUUID(), runId: randomUUID(), ...dimensions } }).success);
    assert.ok(dimensions.cols <= cols || dimensions.cols === 20);
    assert.ok(dimensions.rows <= rows || dimensions.rows === 5);
  }
});

test('Windows PTY compatibility preserves scrollback when ConPTY increases viewport rows', async () => {
  assert.equal(windowsPtyFor('linux', '6.8.0'), undefined);
  assert.equal(windowsPtyFor('win32', '10.0.17763')?.backend, 'winpty');
  const windowsPty = windowsPtyFor('win32', '10.0.26100');
  assert.equal(windowsPty?.backend, 'conpty');
  const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100, allowProposedApi: true, windowsPty });
  try {
    await new Promise<void>(resolve => terminal.write(Array.from({ length: 15 }, (_, n) => `line-${n}\r\n`).join(''), resolve));
    const base = terminal.buffer.active.baseY, line = terminal.buffer.active.getLine(base)?.translateToString(true);
    assert.ok(base > 0);
    terminal.resize(40, 8);
    assert.equal(terminal.buffer.active.baseY, base);
    assert.equal(terminal.buffer.active.getLine(base)?.translateToString(true), line);
  } finally { terminal.dispose(); }
});

test('Unicode widths and wrapped emoji text survive a daemon snapshot restored by the same provider', async () => {
  const source = new Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true });
  const restored = new Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true });
  try {
    for (const terminal of [source, restored]) { terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; }
    const serialize = new SerializeAddon(); source.loadAddon(serialize);
    await new Promise<void>(resolve => source.write('中🙂文', resolve));
    assert.equal(source.buffer.active.cursorX, 6);
    assert.equal(source.buffer.active.getLine(0)?.getCell(2)?.getWidth(), 2);
    await new Promise<void>(resolve => source.write('\r\n' + '中文🙂'.repeat(15), resolve));
    await new Promise<void>(resolve => restored.write(serialize.serialize({ scrollback: 100 }), resolve));
    const lines = (terminal: Terminal) => Array.from({ length: terminal.buffer.active.length }, (_, n) => {
      const line = terminal.buffer.active.getLine(n)!; return { text: line.translateToString(true), wrapped: line.isWrapped };
    });
    assert.ok(lines(source).some(line => line.wrapped));
    assert.deepEqual(lines(restored), lines(source));
    assert.equal(restored.buffer.active.cursorX, source.buffer.active.cursorX);
  } finally { source.dispose(); restored.dispose(); }
});
