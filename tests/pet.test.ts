import { petHookConfiguration } from '../src/main/pet-config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PetState, gifData } from '../src/main/pet-state';
import { PetHooks } from '../src/main/pet-hooks';
import { hookStatus, petRequestSchema } from '../src/shared/pet';
import type { State, Session } from '../src/shared/protocol';

function fixture(t: import('node:test').TestContext) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "berth pet's ")); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const session = (title: string): Session => ({ id: randomUUID(), title, projectId: 'p', agent: 'custom', command: '', terminal: null, createdAt: '', updatedAt: '', nativeSessionId: null, transcriptPath: null, latestRun: { id: randomUUID(), sessionId: '', pid: 1, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, command: '', shell: '', error: null } });
  const a = session('A'), b = session('B');
  const state = { projects: [{ id: 'p', name: 'Project' }], sessions: [a, b] } as State;
  const pet = new PetState(path.join(folder, 'pet')); pet.update(state); pet.connection(true);
  return { folder, state, pet, a, b };
}

test('pet hooks isolate sessions/runs, highlight waiting and invalidate old launches', t => {
  const { pet, a, b, state } = fixture(t);
  const event = { sessionId: a.id, runId: a.latestRun!.id, status: 'working' as const };
  assert.equal(pet.accept({ ...event, runId: randomUUID() }), false);
  assert.equal(pet.accept({ ...event, sessionId: randomUUID() }), false);
  assert.equal(pet.accept(event, 1000), true);
  assert.equal(pet.snapshot(1001).sessions[0].status, 'working');
  assert.equal(pet.snapshot(1001).sessions[1].hooked, false);
  pet.accept({ sessionId: b.id, runId: b.latestRun!.id, status: 'waiting' });
  assert.equal(pet.preferences.selectedSessionId, b.id);
  pet.save({ ...pet.preferences, autoSwitch: false, selectedSessionId: a.id });
  pet.accept({ sessionId: b.id, runId: b.latestRun!.id, status: 'error' });
  assert.equal(pet.preferences.selectedSessionId, a.id);
  assert.equal(pet.snapshot(601001).sessions[0].status, 'unknown');
  a.latestRun!.id = randomUUID(); pet.update(state);
  assert.equal(pet.snapshot().sessions[0].hooked, false);
  assert.equal(pet.accept(event), false);
  a.latestRun!.status = 'stopped'; pet.update(state);
  assert.equal(pet.accept({ ...event, runId: a.latestRun!.id }), false);
  pet.connection(false);
  assert.ok(pet.snapshot().sessions.every(session => session.status === 'unknown'));
});

test('pet preferences and copied GIF survive reload; same-name replacement changes revision', t => {
  const { pet, folder } = fixture(t);
  pet.save({ ...pet.preferences, enabled: true, scale: 1.25 });
  const bytes = readFileSync('tests/fixtures/pet-working.gif');
  pet.importImage('working', bytes, 'my-pet.gif');
  const first = pet.snapshot().imageVersion;
  pet.importImage('working', bytes, 'my-pet.gif');
  assert.ok(pet.snapshot().imageVersion > first);
  const loaded = new PetState(path.join(folder, 'pet')); loaded.loadImages(['working']);
  assert.equal(loaded.preferences.enabled, true); assert.equal(loaded.preferences.scale, 1.25);
  assert.equal(loaded.image('working'), gifData(bytes));
  assert.ok(loaded.snapshot().images.working);
  loaded.resetImage('working'); assert.equal(loaded.image('working'), null);
  assert.throws(() => gifData(Buffer.from('not an image')));
  const huge = Buffer.from(bytes); huge.writeUInt16LE(2049, 6); assert.throws(() => gifData(huge));
  assert.throws(() => pet.save({ ...pet.preferences, scale: 9 }));
  assert.equal(petRequestSchema.safeParse({ action: 'image', status: '../secret' }).success, false);
});

test('hook mapping uses lifecycle signals, not screen output or child-agent Stop', () => {
  assert.equal(hookStatus('UserPromptSubmit'), 'working');
  assert.equal(hookStatus('PreToolUse'), 'working');
  assert.equal(hookStatus('PostToolUse'), 'working');
  assert.equal(hookStatus('PermissionRequest'), 'waiting');
  assert.equal(hookStatus('Notification', 'permission_prompt'), 'waiting');
  assert.equal(hookStatus('Notification', 'auth_success'), null);
  assert.equal(hookStatus('Stop'), 'completed');
  assert.equal(hookStatus('SubagentStop'), null);
  assert.equal(hookStatus('StopFailure'), 'error');
  assert.equal(hookStatus('SessionEnd'), 'idle');
});

test('hook endpoint is authenticated, bounded, local and refuses stale/foreign event targets', async t => {
  const { folder, pet, a } = fixture(t), hooks = new PetHooks(folder, event => pet.accept(event));
  await hooks.start(); t.after(() => hooks.close());
  const descriptor = JSON.parse(readFileSync(path.join(folder, 'pet-hook.json'), 'utf8'));
  const url = `http://127.0.0.1:${descriptor.port}/hook`, headers = { Authorization: 'Bearer ' + descriptor.token };
  const event = { sessionId: a.id, runId: a.latestRun!.id, status: 'completed' };
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(event) })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify(event) })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...event, runId: randomUUID() }) })).status, 409);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(event) })).status, 200);
  assert.equal(pet.snapshot().sessions[0].status, 'completed');
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...event, command: 'forbidden' }) })).status, 400);
});

test('bundled hook reads Agent stdin without forwarding prompts and fails open when app is absent', async t => {
  const { folder, pet, a } = fixture(t), hooks = new PetHooks(folder, event => pet.accept(event));
  await hooks.start(); t.after(() => hooks.close());
  const invoke = (payload: unknown, extra: string[] = [], extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('dist/pet-hook.cjs'), ...extra], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTBERTH_DATA_DIR: folder, AGENTBERTH_SESSION_ID: a.id, AGENTBERTH_RUN_ID: a.latestRun!.id, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.once('error', reject); child.once('close', code => resolve({ code, output })); child.stdin.end(JSON.stringify(payload));
  });
  assert.deepEqual(await invoke({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_SENTINEL' }, [], { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' }), { code: 0, output: '' });
  assert.equal(pet.snapshot().sessions[0].status, 'working');
  assert.deepEqual(await invoke({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), { code: 0, output: '' });
  assert.equal(pet.snapshot().sessions[0].status, 'waiting');
  await hooks.close();
  assert.deepEqual(await invoke({ hook_event_name: 'Stop' }), { code: 0, output: '' });
});


test('generated Claude hook runs through the selected native shell with spaces and apostrophes in paths', async t => {
  const { folder, pet, a } = fixture(t), hooks = new PetHooks(folder, event => pet.accept(event));
  await hooks.start(); t.after(() => hooks.close());
  const config = petHookConfiguration(process.execPath, path.resolve('dist/pet-hook.cjs'), folder);
  const hook = config.hooks.UserPromptSubmit[0].hooks[0];
  const shell = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', hook.command] : ['-c', hook.command];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(shell, args, { env: { ...process.env, AGENTBERTH_SESSION_ID: a.id, AGENTBERTH_RUN_ID: a.latestRun!.id }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => stderr += bytes); child.stdout.resume();
    child.on('error', reject); child.on('close', code => { if (code === 0 && !stderr) resolve(); else reject(new Error(stderr || String(code))); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE' }));
  });
  assert.equal(pet.snapshot().sessions[0].status, 'working');
  const quoted = petHookConfiguration("/some path/it's/electron", "/some path/it's/hook.cjs", "/some path/it's/data", 'linux');
  assert.ok(quoted.hooks.Stop[0].hooks[0].command.includes("'\\''"));
  const windows = petHookConfiguration("C:\\User's App\\AgentBerth.exe", 'hook.cjs', 'data', 'win32');
  assert.equal(windows.hooks.Stop[0].hooks[0].shell, 'powershell');
  assert.ok(windows.hooks.Stop[0].hooks[0].command.includes("User''s App"));
});


test('SSH command phases are shown without implying remote Agent hooks or changing ownership', t => {
  const { pet, a, state } = fixture(t);
  const info = { sessionId: a.id, runId: a.latestRun!.id, host: 'example', connection: 'connected' as const, owner: 'agent' as const, phase: 'busy' as const, cwd: null, error: null };
  pet.remote(info);
  assert.equal(pet.snapshot().sessions[0].status, 'working');
  assert.equal(pet.snapshot().sessions[0].hooked, false);
  assert.equal(pet.snapshot().sessions[0].label, 'SSH 命令执行中');
  pet.remote({ ...info, phase: 'idle' });
  assert.equal(pet.snapshot().sessions[0].status, 'completed');
  assert.equal(info.owner, 'agent');
  a.latestRun!.id = randomUUID(); pet.update(state);
  assert.equal(pet.snapshot().sessions[0].status, 'idle');
});
