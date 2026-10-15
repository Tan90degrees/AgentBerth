import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os, { release } from 'node:os';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { resolveTerminal } from '../src/daemon/paths';
import type { Attachment, Project, Run, Session, TerminalEvent } from '../src/shared/protocol';
import { windowsPtyFor } from '../src/shared/desktop';
import { writeTerminalEvent } from '../src/shared/terminal-stream';
import { ResizeQueue } from '../src/renderer/terminal-resize';

const write = (terminal: Terminal, text = '') => new Promise<void>(resolve => terminal.write(text, resolve));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function grid(cols = 80, rows = 24, windows = false) {
  const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true, ...(windows ? { windowsPty: windowsPtyFor(process.platform, release()) } : {}) });
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'; return terminal;
}
function screen(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return { cols: terminal.cols, rows: terminal.rows, type: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
    lines: Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true)) };
}

test('size boundaries preserve normal/alternate buffers and Unicode while writes are still pending', async () => {
  for (const alternate of [false, true]) {
    const actual = grid(40, 10), expected = grid(40, 10);
    try {
      const operations: TerminalEvent[] = [
        { event: 'output', data: { sessionId: 'a', runId: 'b', seq: 1, text: (alternate ? '\x1b[?1049h' : '') + '中文🙂'.repeat(35) } },
        { event: 'resize', data: { sessionId: 'a', runId: 'b', seq: 2, cols: 70, rows: 15 } },
        { event: 'output', data: { sessionId: 'a', runId: 'b', seq: 3, text: '\x1b[2;1HNEW_SIZE\x1b[15;1H宽🙂底部' } },
        { event: 'resize', data: { sessionId: 'a', runId: 'b', seq: 4, cols: 25, rows: 8 } },
        { event: 'output', data: { sessionId: 'a', runId: 'b', seq: 5, text: '\x1b[1;1HLAST\x1b[K\x1b[8;1H底部🙂\x1b[K' } },
      ];
      for (const event of operations) writeTerminalEvent(actual, event, () => true);
      for (const event of operations) {
        if (event.event === 'output') await write(expected, event.data.text);
        else expected.resize(event.data.cols, event.data.rows);
      }
      await write(actual);
      assert.deepEqual(screen(actual), screen(expected));
    } finally { actual.dispose(); expected.dispose(); }
  }
});

test('latest resize replaces intermediate requests, including dragging back to the initial size', async () => {
  const sent: string[] = [], finish: (() => void)[] = [];
  const queue = new ResizeQueue({ cols: 80, rows: 24 }, size => { sent.push(`${size.cols}x${size.rows}`); return new Promise(resolve => finish.push(resolve)); }, error => { throw error; });
  queue.request({ cols: 100, rows: 30 }); queue.request({ cols: 120, rows: 40 }); queue.request({ cols: 80, rows: 24 });
  assert.deepEqual(sent, ['100x30']);
  finish.shift()!(); await tick(); assert.deepEqual(sent, ['100x30', '80x24']);
  finish.shift()!(); await tick(); queue.request({ cols: 80, rows: 24 }); assert.equal(sent.length, 2);
  queue.dispose(); queue.request({ cols: 150, rows: 50 }); assert.equal(sent.length, 2);
});

test('failed resizing can retry and disposal drops queued work and late errors', async () => {
  let calls = 0; const errors: unknown[] = []; let reject: (reason: Error) => void = () => {};
  const queue = new ResizeQueue({ cols: 80, rows: 24 }, async () => { calls++; if (calls === 1) throw new Error('offline'); await new Promise<void>((_, fail) => { reject = fail; }); }, error => errors.push(error));
  queue.request({ cols: 100, rows: 30 }); await tick(); assert.equal(errors.length, 1);
  queue.request({ cols: 100, rows: 30 }); queue.request({ cols: 120, rows: 40 }); assert.equal(calls, 2);
  queue.dispose(); reject(new Error('late disconnect')); await tick(); assert.equal(calls, 2); assert.equal(errors.length, 1);
  const terminal = grid(); let alive = true;
  writeTerminalEvent(terminal, { event: 'resize', data: { sessionId: 'a', runId: 'b', seq: 1, cols: 120, rows: 40 } }, () => alive);
  alive = false; await write(terminal); assert.equal(terminal.cols, 80); terminal.dispose();
});

test('real TUI output and concurrent resizes replay to the same grid as the daemon snapshot', { timeout: 25000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-resize-'));
  const server = new DaemonServer(path.join(folder, 'data'));
  const runtime = await server.listen(); const events: TerminalEvent[] = [], hiddenEvents: TerminalEvent[] = [];
  const connection = await DaemonConnection.open(runtime, event => { if (event.event === 'output' || event.event === 'resize') events.push(event); });
  const hidden = await DaemonConnection.open(runtime, event => { if (event.event === 'output' || event.event === 'resize') hiddenEvents.push(event); });
  t.after(async () => { connection.close(); hidden.close(); await server.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const script = path.join(folder, 'tui.cjs'), ready = path.join(folder, 'tui.ready');
  await writeFile(script, `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?1049h');let count=0;function draw(){const c=process.stdout.getWindowSize()[0],r=process.stdout.getWindowSize()[1];process.stdout.write('\\x1b[H\\x1b[2JFRAME_'+count+' '+c+'x'+r+'\\x1b[2;1H'+('中文🙂'.repeat(80))+'\\x1b['+r+';1HFOOT_'+count+'\\x1b[K');}process.stdout.on('resize',draw);draw();require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{draw();count++;},20);`);
  const project = await connection.rpc<Project>('createProject', { name: 'resize', path: folder });
  const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
  // Electron.exe is a Windows GUI executable; use the real console Node CLI
  // installed by the development/CI environment for this interactive fixture.
  const node = await resolveTerminal({ profile: 'custom', executable: 'node', args: [] });
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(node.file)} ${quote(script)}`;
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'TUI', agent: 'custom', command });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 80, rows: 24 });
  const initial = await connection.rpc<Attachment>('attach', { sessionId: session.id });
  const replay = grid(initial.cols, initial.rows, true); t.after(() => replay.dispose());
  await write(replay, initial.snapshot);
  const deadline = Date.now() + 10000;
  while (!existsSync(ready)) {
    const diagnostic = await connection.rpc<Attachment>('attach', { sessionId: session.id });
    assert.ok(Date.now() < deadline, 'TUI did not start: '+diagnostic.snapshot.slice(-2000));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const sizes = Array.from({ length: 12 }, (_, index) => ({ cols: index % 2 ? 100 : 45, rows: index % 3 ? 30 : 15 }));
  await Promise.all(sizes.map(size => connection.rpc('resize', { sessionId: session.id, runId: run.id, ...size })));
  let snapshot = await connection.rpc<Attachment>('attach', { sessionId: session.id });
  while (!snapshot.snapshot.includes(`${sizes.at(-1)!.cols}x${sizes.at(-1)!.rows}`)) {
    assert.ok(Date.now() < deadline, 'TUI did not observe the final PTY size: '+JSON.stringify({cols:snapshot.cols,rows:snapshot.rows,screen:snapshot.snapshot.slice(-2000)}));
    await new Promise(resolve => setTimeout(resolve, 30));
    snapshot = await connection.rpc<Attachment>('attach', { sessionId: session.id });
  }
  const delivered = events.filter(event => event.data.seq > initial.seq && event.data.seq <= snapshot.seq);
  assert.equal(delivered.filter(event => event.event === 'resize').length, sizes.length);
  assert.deepEqual(delivered.map(event => event.data.seq), [...delivered.map(event => event.data.seq)].sort((a, b) => a - b));
  assert.equal(new Set(delivered.map(event => event.data.seq)).size, delivered.length);
  for (const event of delivered) writeTerminalEvent(replay, event, () => true);
  await write(replay);
  const restored = grid(snapshot.cols, snapshot.rows, true);
  try { await write(restored, snapshot.snapshot); assert.deepEqual(screen(replay), screen(restored)); }
  finally { restored.dispose(); }
  assert.equal(snapshot.run!.pid, run.pid); assert.equal(snapshot.cols, sizes.at(-1)!.cols); assert.equal(snapshot.rows, sizes.at(-1)!.rows);
  assert.equal(hiddenEvents.length, 0, 'Unsubscribed clients received terminal events');
  await assert.rejects(connection.rpc('resize', { sessionId: session.id, runId: project.id, cols: 60, rows: 20 }), /运行实例/);
});
