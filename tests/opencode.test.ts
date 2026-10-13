import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHistory } from '../src/daemon/history';
import { launchCommand } from '../src/daemon/paths';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import type { Attachment, History, Project, Run, Session, State } from '../src/shared/protocol';

const exported = (directory: string) => ({ info: { id: 'ses_export_demo', directory }, messages: [
  { info: { role: 'user', time: { created: 1700000000000 } }, parts: [{ type: 'text', text: '排查易用性' }] },
  { info: { role: 'assistant', time: { created: 1700000001000 } }, parts: [{ type: 'text', text: '已补齐设置' }, { type: 'tool', text: '不显示工具内容' }, { type: 'reasoning', text: '不显示推理' }] },
] });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>) { for (let n = 0; n < 100; n++) { if (await check()) return; await wait(60); } throw new Error('Condition did not become true'); }

test('OpenCode exports import UTF-8 and PowerShell UTF-16LE text, validate project/ID and omit tools', async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-opencode-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'session.json');
  for (const encoding of ['utf8', 'utf16le'] as const) {
    writeFileSync(file, '\uFEFF' + JSON.stringify(exported(folder)), encoding);
    const history = await readHistory(file, 'opencode', folder);
    assert.deepEqual(history.messages.map(message => message.text), ['排查易用性', '已补齐设置']);
    assert.equal(history.messages[0].timestamp, '2023-11-14T22:13:20.000Z');
    assert.equal(history.nativeSessionId, 'ses_export_demo');
    await assert.rejects(readHistory(file, 'opencode', path.join(folder, 'other')), /工作目录/);
  }
  writeFileSync(file, JSON.stringify({ ...exported(folder), info: { id: 'ses_x; echo bad', directory: folder } }));
  await assert.rejects(readHistory(file, 'opencode', folder), /有效/);
  assert.throws(() => launchCommand({ agent: 'opencode', nativeSessionId: 'x; echo bad' } as Session, true), /有效/);
  writeFileSync(file, '{partial');
  await assert.rejects(readHistory(file, 'opencode', folder), /有效 JSON/);
});

test('OpenCode launches and resumes through the real shell with exact session arguments', { timeout: 20000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-opencode-cli-'));
  const bin = path.join(folder, 'bin'); mkdirSync(bin);
  const windows = process.platform === 'win32';
  writeFileSync(path.join(bin, windows ? 'opencode.cmd' : 'opencode'), windows ? '@echo off\r\necho OPENCODE_STUB_READY %*\r\n' : '#!/bin/sh\necho "OPENCODE_STUB_READY $*"\n', { mode: 0o755 });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const originalPath = process.env[pathKey]; process.env[pathKey] = bin + path.delimiter + originalPath;
  const server = new DaemonServer(path.join(folder, 'data'));
  const connection = await DaemonConnection.open(await server.listen(), () => {});
  t.after(async () => { connection.close(); await server.close(); process.env[pathKey] = originalPath; rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); });
  const project = await connection.rpc<Project>('createProject', { name: 'opencode project', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'opencode chat', agent: 'opencode' });
  assert.equal(launchCommand(session, false), 'opencode');
  const first = await connection.rpc<Run>('start', { sessionId: session.id, cols: 120, rows: 30 });
  await eventually(async () => (await connection.rpc<Attachment>('attach', { sessionId: session.id })).snapshot.includes('OPENCODE_STUB_READY'));
  await connection.rpc('stop', { sessionId: session.id });
  await eventually(async () => (await connection.rpc<State>('state')).sessions[0].latestRun?.status === 'stopped');
  const file = path.join(folder, 'session.json'); const source = JSON.stringify(exported(folder)); writeFileSync(file, source);
  const history = await connection.rpc<History>('importHistory', { sessionId: session.id, path: file });
  assert.equal(history.nativeSessionId, 'ses_export_demo');
  const resumed = await connection.rpc<Run>('start', { sessionId: session.id, resume: true, cols: 120, rows: 30 });
  assert.equal(resumed.command, 'opencode --session ses_export_demo'); assert.notEqual(resumed.id, first.id);
  await eventually(async () => (await connection.rpc<Attachment>('attach', { sessionId: session.id })).snapshot.includes('OPENCODE_STUB_READY --session ses_export_demo'));
  assert.equal(readFileSync(file, 'utf8'), source);
});
