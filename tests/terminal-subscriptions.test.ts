import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSubscriptions } from '../src/main/terminal-subscriptions';

test('a late detach from the dock cannot remove the popup subscription', async () => {
  const calls: string[] = [];
  const subscriptions = new TerminalSubscriptions(async (method, id) => { calls.push(`${method}:${id}`); return { snapshot: 'same running terminal' }; });
  await subscriptions.attach(1, 'ssh', () => true);
  await subscriptions.attach(2, 'ssh', () => true);
  await subscriptions.detach(1, 'ssh');
  assert.equal(subscriptions.has(1, 'ssh'), false);
  assert.equal(subscriptions.has(2, 'ssh'), true);
  assert.deepEqual(calls, ['attach:ssh', 'attach:ssh']);
  await subscriptions.attach(1, 'ssh', () => true);
  await subscriptions.detach(2, 'ssh');
  assert.equal(subscriptions.has(1, 'ssh'), true);
  await subscriptions.detach(1, 'ssh');
  await subscriptions.detach(1, 'ssh');
  assert.deepEqual(calls, ['attach:ssh', 'attach:ssh', 'attach:ssh', 'detach:ssh']);
});

test('closing a renderer during attach releases its pending subscription without stopping terminals', async () => {
  let alive = true, finish!: () => void;
  const calls: string[] = [];
  const subscriptions = new TerminalSubscriptions(async (method, id) => {
    calls.push(`${method}:${id}`);
    if (method === 'attach') await new Promise<void>(resolve => { finish = resolve; });
    return null;
  });
  const pending = subscriptions.attach(2, 'ssh', () => alive);
  await new Promise(resolve => setImmediate(resolve));
  alive = false; subscriptions.release(2); finish(); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriptions.has(2, 'ssh'), false);
  assert.deepEqual(calls, ['attach:ssh', 'detach:ssh']);
  await assert.rejects(subscriptions.attach(2, 'ssh', () => false), /窗口已关闭/);
});

test('failed attaches do not leak owners or block another session and retry', async () => {
  let fail = true;
  const subscriptions = new TerminalSubscriptions(async (method, id) => {
    if (method === 'attach' && id === 'bad' && fail) throw new Error('missing session');
    return id;
  });
  const failed = subscriptions.attach(1, 'bad', () => true);
  assert.equal(await subscriptions.attach(1, 'local', () => true), 'local');
  await assert.rejects(failed, /missing session/);
  assert.equal(subscriptions.has(1, 'bad'), false);
  fail = false;
  assert.equal(await subscriptions.attach(2, 'bad', () => true), 'bad');
  subscriptions.release(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriptions.has(1, 'local'), false);
  assert.equal(subscriptions.has(2, 'bad'), true);
});
