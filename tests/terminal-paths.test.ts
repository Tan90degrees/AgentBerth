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

test('path activation requires a fresh modifier press and cannot revive stale mouse flags after focus loss', async () => {
  // Only the DOM surface is stubbed; path hit testing uses a real xterm buffer.
  // Node's EventTarget does not remove capture listeners with the boolean overload.
  class DomTarget extends EventTarget {
    override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) { super.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options); }
    override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) { super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options); }
  }
  class Element extends DomTarget {
    className = ''; style = {}; clientWidth = 800; clientHeight = 240;
    children: Element[] = [];
    classList = { add() {}, remove() {} };
    appendChild(child: Element) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    remove() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 240 }; }
  }
  const globals = ['window', 'document', 'navigator'] as const;
  const saved = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const screen = new Element(), windowTarget = new DomTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Win32' } });
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  let dispose: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => terminal.write('src/code.ts', resolve));
    const opened: string[] = [];
    const { bindTerminalPaths } = await import('../src/renderer/terminal-paths');
    dispose = bindTerminalPaths({ cols: 80, rows: 24, buffer: terminal.buffer, element: { querySelector: () => screen }, onRender: () => ({ dispose() {} }) } as any, path => opened.push(path));
    const key = (type: string, ctrlKey: boolean) => windowTarget.dispatchEvent(Object.assign(new Event(type), { key: 'Control', ctrlKey, metaKey: false, altKey: false }));
    const click = (ctrlKey: boolean) => { for (const type of ['mousedown', 'mouseup']) screen.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: 25, clientY: 5, button: 0, ctrlKey, metaKey: false, altKey: false })); };
    click(false); click(true); assert.deepEqual(opened, []);
    key('keydown', true); click(true); assert.deepEqual(opened, ['src/code.ts']);
    windowTarget.dispatchEvent(new Event('blur'));
    click(true); assert.equal(opened.length, 1, 'stale flags from the focus click must not activate navigation');
    key('keyup', false); click(false); assert.equal(opened.length, 1);
    key('keydown', true); click(false); assert.equal(opened.length, 1, 'the mouse event must confirm the modifier is still held');
    click(true); assert.equal(opened.length, 2);
    dispose(); dispose = undefined; click(true); assert.equal(opened.length, 2);
  } finally {
    dispose?.(); terminal.dispose();
    globals.forEach((key, index) => { if (saved[index]) Object.defineProperty(globalThis, key, saved[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
});
