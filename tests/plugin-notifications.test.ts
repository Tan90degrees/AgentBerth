import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { HtmlExtensionView, PluginNoticeContext } from '../src/renderer/HtmlExtensionView';
import { extensionManifestSchema, type ExtensionInfo, type PluginNotice } from '../src/shared/extensions';

test('plugin notices accept only the owning frame, validate payloads and retain host identity', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://notification.test' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  const plugin: ExtensionInfo = { manifest: extensionManifestSchema.parse({ apiVersion: 1, id: 'example.notice', name: 'Trusted plugin name', version: '1.0.0', views: [{ id: 'main', title: 'View', location: 'panel', entry: 'view.html' }] }), generation: 1, installed: true, enabled: true, status: 'active', builtin: false, development: false, isAgent: false, config: {}, commands: [], views: [] };
  const received: [string, PluginNotice][] = [];
  const render = (suffix: string) => root.render(React.createElement(PluginNoticeContext.Provider, { value: (name, notice) => received.push([name + suffix, notice]) }, React.createElement(HtmlExtensionView, { plugin, viewId: 'main', onError() {} })));
  await act(async () => render(''));
  const frame = dom.window.document.querySelector('iframe')!;
  const send = (data: unknown, source: Window | null = frame.contentWindow) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source, data }));
  await act(async () => {
    send({ kind: 'agentberth-plugin-notice', message: 'forged' }, dom.window as unknown as Window);
    send({ kind: 'agentberth-plugin-notice', message: '  ' });
    send({ kind: 'agentberth-plugin-notice', message: 'invalid', level: 'fatal' });
    send({ kind: 'agentberth-plugin-notice', message: 'x'.repeat(12001) });
  });
  assert.deepEqual(received, []);
  await act(async () => send({ kind: 'agentberth-plugin-notice', message: '  Reply sent  ', level: 'info', pluginName: 'Forged name' }));
  assert.deepEqual(received, [['Trusted plugin name', { message: 'Reply sent', level: 'info' }]]);
  await act(async () => render(' updated'));
  await act(async () => send({ kind: 'agentberth-plugin-notice', message: 'Check delivery', level: 'warning' }));
  assert.deepEqual(received.at(-1), ['Trusted plugin name updated', { message: 'Check delivery', level: 'warning' }]);
});
