import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalRenderer } from '../src/renderer/terminal-renderer';

function fixture(fail = false) {
  const host = { dataset: {} } as HTMLElement;
  let loss: (() => void) | null = null, disposed = 0, subscriptions = 0, fits = 0, refreshes = 0;
  const terminal = { rows: 24, options: { lineHeight: 1.25 }, loadAddon() { if (fail) throw new Error('WebGL unavailable'); }, refresh() { refreshes++; } } as unknown as Terminal;
  const addon = { activate() {}, dispose() { disposed++; }, onContextLoss(fn: () => void) { loss = fn; return { dispose() { subscriptions++; loss = null; } }; } };
  const cleanup = attachTerminalRenderer(terminal, host, () => fits++, () => addon);
  return { host, terminal, cleanup, lose: () => loss?.(), counts: () => ({ disposed, subscriptions, fits, refreshes }) };
}
test('accelerated renderer retains row spacing and releases context on unmount', () => {
  const f = fixture(); assert.equal(f.host.dataset.renderer, 'webgl'); assert.equal(f.terminal.options.lineHeight, 1.25);
  assert.equal(f.counts().fits, 0); f.cleanup(); f.lose();
  assert.equal(f.host.dataset.renderer, undefined); assert.deepEqual(f.counts(), { disposed: 1, subscriptions: 1, fits: 0, refreshes: 0 });
});
test('unsupported WebGL falls back to compact DOM glyphs and refits the existing terminal', () => {
  const f = fixture(true); assert.equal(f.host.dataset.renderer, 'dom'); assert.equal(f.terminal.options.lineHeight, 1);
  assert.deepEqual(f.counts(), { disposed: 1, subscriptions: 1, fits: 1, refreshes: 1 });
  f.cleanup(); assert.equal(f.counts().disposed, 1);
});
test('context loss preserves the terminal and falls back once without retrying graphics', () => {
  const f = fixture(); const terminal = f.terminal; f.lose(); f.lose();
  assert.equal(f.terminal, terminal); assert.equal(f.host.dataset.renderer, 'dom');
  assert.deepEqual(f.counts(), { disposed: 1, subscriptions: 1, fits: 1, refreshes: 1 }); f.cleanup();
});
test('failure to create a WebGL addon still leaves a working DOM terminal', () => {
  const host = { dataset: {} } as HTMLElement; let fits = 0;
  const terminal = { rows: 10, options: { lineHeight: 1.25 }, refresh() {} } as unknown as Terminal;
  const cleanup = attachTerminalRenderer(terminal, host, () => fits++, () => { throw new Error('No graphics context'); });
  assert.equal(host.dataset.renderer, 'dom'); assert.equal(terminal.options.lineHeight, 1); assert.equal(fits, 1); cleanup();
});
