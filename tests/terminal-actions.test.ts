import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { externalWebUrl, inputChunks, terminalDimensions } from '../src/shared/desktop';
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
