import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { externalWebUrl, inputChunks, terminalDimensions, windowsPtyFor } from '../src/shared/desktop';
import { requestSchema } from '../src/shared/protocol';
import { trackMouseEncoding } from '../src/shared/terminal-modes';
import { terminalTextRows } from '../src/renderer/terminal-search';

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

test('ConPTY physical wraps reconstruct wide Unicode text without padding or added newlines', async () => {
  const terminal = new Terminal({ cols: 20, rows: 12, scrollback: 100, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
  const text = 'WRAP_' + '中文🙂'.repeat(15) + '_END';
  let physical = '', width = 0;
  for (const char of text) {
    const cells = /[中文🙂]/u.test(char) ? 2 : 1;
    if (width + cells > 20) { physical += ' '.repeat(20 - width) + '\r\n'; width = 0; }
    physical += char; width += cells;
  }
  try {
    await new Promise<void>(resolve => terminal.write(physical, resolve));
    assert.equal(terminal.buffer.active.getLine(1)?.isWrapped, false);
    assert.ok(terminalTextRows(terminal).length > 1);
    assert.equal(terminalTextRows(terminal, true)[0].text, text);
    terminal.reset();
    await new Promise<void>(resolve => terminal.write('one\r\ntwo', resolve));
    assert.deepEqual(terminalTextRows(terminal, true).filter(row => row.text).map(row => row.text), ['one', 'two']);
  } finally { terminal.dispose(); }
});


test('reattachment keeps SGR and pixel mouse reports identical, including split DEC modes and resets', async () => {
  const source = new Terminal({ cols: 160, rows: 30, allowProposedApi: true });
  const serialize = new SerializeAddon(); source.loadAddon(serialize);
  const encoding = trackMouseEncoding(source);
  const write = (terminal: Terminal, text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
  const report = (terminal: Terminal) => {
    let result = '';
    const text = terminal.onData(data => { result += data; });
    const binary = terminal.onBinary(data => { result += 'binary:' + data; });
    // Exercise xterm's real encoder without a browser mouse event.
    (terminal as unknown as { _core: { coreMouseService: { triggerMouseEvent(event: object): void } } })._core.coreMouseService.triggerMouseEvent({ col: 130, row: 4, x: 1040, y: 80, button: 0, action: 1, ctrl: false, alt: false, shift: false });
    text.dispose(); binary.dispose(); return result;
  };
  try {
    for (const mode of [1006, 1016]) {
      await write(source, '\x1b[?1000;'); await write(source, mode + 'h');
      const restored = new Terminal({ cols: 160, rows: 30, allowProposedApi: true });
      try {
        await write(restored, serialize.serialize() + encoding());
        const expected = report(source);
        assert.ok(expected.startsWith('\x1b[<0;'));
        assert.equal(report(restored), expected, 'Reconnect changed the TUI mouse wire format');
      } finally { restored.dispose(); }
      await write(source, `\x1b[?${mode}l`);
      assert.equal(encoding(), '');
      assert.ok(report(source).startsWith('binary:'));
    }
    await write(source, '\x1b]0;fake [?1006h\x07');
    assert.equal(encoding(), '', 'OSC title must not change mouse encoding');
    await write(source, '\x1b[?1006h\x1b[!p');
    assert.equal(encoding(), '\x1b[?1006h', 'DECSTR does not reset xterm mouse encoding');
    await write(source, '\x1bc');
    assert.equal(encoding(), '');
  } finally { source.dispose(); }
});
