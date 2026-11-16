import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NotificationCenter } from '../src/renderer/NotificationCenter';
import { recoveryNotice, useWorkspaceNotices } from '../src/renderer/useWorkspaceNotices';
import { dismissNotice, pushNotice, type Notice } from '../src/renderer/notice-queue';
import type { ToastAction } from '../src/renderer/SuccessToast';
import type { WorkspaceRecovery } from '../src/shared/protocol';

const completed: WorkspaceRecovery = { id: 'restore-one', status: 'completed', total: 6, restored: 6, resumed: 4, skipped: 0, errors: [] };

test('recovery summaries retain real counts, skipped items and every failure', () => {
  assert.deepEqual(recoveryNotice(completed), { text: '上次会话恢复完成 · 已重新打开 6/6 · 续接 Agent 对话 4', level: 'info' });
  const partial = recoveryNotice({ ...completed, restored: 4, skipped: 1, errors: [{ sessionId: 'a', title: '会话甲', message: '程序不可用' }, { sessionId: 'b', title: '会话乙', message: '连接失败' }] })!;
  assert.equal(partial.level, 'warning');
  for (const text of ['4/6', '跳过 1', '会话甲：程序不可用', '会话乙：连接失败']) assert.ok(partial.text.includes(text), text);
  assert.equal(recoveryNotice({ ...completed, total: 0 }), null);
});

function setup(t: import('node:test').TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://recovery.test' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const root = createRoot(dom.window.document.getElementById('root')!), selected: string[] = [];
  let updates = 0;
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  function Host({ recovery, connected = true, apiVersion = 61 }: { recovery?: WorkspaceRecovery; connected?: boolean; apiVersion?: number }) {
    const [notices, setNotices] = useState<Notice[]>([]);
    const notify = useCallback((text: string, action?: ToastAction, level?: Notice['level']) => setNotices(items => pushNotice(items, text, action, level)), []);
    useWorkspaceNotices({ recovery, connected, apiVersion, expectedApi: 61, notify, inspectFailure: id => selected.push(id), updateBackend: () => { updates++; } });
    return React.createElement(NotificationCenter, { notices, onDismiss: id => setNotices(items => dismissNotice(items, id)), onClear: () => setNotices([]), onCopy() {} });
  }
  const render = (props: React.ComponentProps<typeof Host>) => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Host, props))));
  const toggle = () => dom.window.document.querySelector<HTMLButtonElement>('.notification-toggle')!;
  return { dom, render, toggle, selected, updates: () => updates };
}

test('restore completion uses notification history, collapses at five seconds and survives snapshot/reconnect duplication', async t => {
  const { dom, render, toggle } = setup(t);
  await render({ recovery: completed });
  assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 1);
  assert.match(dom.window.document.querySelector('.notification-item')!.textContent!, /重新打开 6\/6.*续接 Agent 对话 4/);
  await act(async () => t.mock.timers.tick(5000)); assert.equal(dom.window.document.querySelector('.notification-panel'), null);
  await render({ recovery: { ...completed } }); await render({ recovery: completed, connected: false }); await render({ recovery: completed });
  assert.equal(dom.window.document.querySelector('.notification-panel'), null, 'identical recovery must not reopen the popup');
  await act(async () => toggle().click()); assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 1);
  const clear = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '清空')!;
  await act(async () => clear.click()); await render({ recovery: { ...completed } });
  await act(async () => toggle().click()); assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 0, 'cleared history is not recreated by polling');
});

test('recovery progress is announced once per phase and failure navigation keeps the full report', async t => {
  const { dom, render, selected } = setup(t);
  await render({ recovery: { ...completed, status: 'restoring', restored: 0, resumed: 0 } });
  await render({ recovery: { ...completed, status: 'restoring', restored: 3, resumed: 2 } });
  assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 1);
  const failed = { ...completed, restored: 5, errors: [{ sessionId: 'failed-session', title: '待恢复会话', message: '连接失败' }] };
  await render({ recovery: failed }); assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 2);
  const view = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '查看会话')!;
  await act(async () => view.click()); assert.deepEqual(selected, ['failed-session']);
  assert.ok(dom.window.document.querySelector('.notification-item.warning')!.textContent!.includes('连接失败'));
});

test('backend update notices wait for connection and announce each version only once', async t => {
  const { dom, render, updates } = setup(t);
  await render({ apiVersion: 60, connected: false }); assert.equal(dom.window.document.querySelector('.notification-panel'), null);
  await render({ apiVersion: 60 }); await render({ apiVersion: 60 });
  assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 1);
  const update = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '更新后台')!;
  await act(async () => update.click()); assert.equal(updates(), 1);
  assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 1);
});
