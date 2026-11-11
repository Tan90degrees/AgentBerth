import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NotificationCenter } from '../src/renderer/NotificationCenter';
import type { Notice } from '../src/renderer/notice-queue';

test('new notifications open at the header, collapse at five seconds and retain actions in history', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://notification.test' });
  const previous = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, { window: { value: dom.window, configurable: true }, document: { value: dom.window.document, configurable: true }, navigator: { value: dom.window.navigator, configurable: true }, IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true } });
  const root = createRoot(dom.window.document.getElementById('root')!); let undone = 0;
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notices: Notice[] = [{ id: 1, text: '已删除项目', level: 'info', action: { label: '撤销', onAction: () => { undone++; } } }, { id: 2, text: '后台连接中断', level: 'error' }];
  await act(async () => root.render(React.createElement(NotificationCenter, { notices, onDismiss() {}, onClear() {}, onCopy() {} })));
  assert.ok(dom.window.document.querySelector('.notification-panel'));
  assert.equal(dom.window.document.querySelector('.toast-stack'), null);
  await act(async () => t.mock.timers.tick(4999)); assert.ok(dom.window.document.querySelector('.notification-panel'));
  await act(async () => t.mock.timers.tick(1)); assert.equal(dom.window.document.querySelector('.notification-panel'), null);
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.notification-toggle')!.click());
  assert.equal(dom.window.document.querySelectorAll('.notification-item').length, 2);
  assert.ok(dom.window.document.querySelector('.notification-item.error')!.textContent!.includes('后台连接中断'));
  const undo = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '撤销')!;
  await act(async () => undo.click()); assert.equal(undone, 1, 'collapsing must never discard the undo receipt');
});
