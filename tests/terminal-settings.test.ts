import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { environmentValue, pathCandidates, powershellCandidates } from '../src/daemon/executables';
import { resolveTerminal } from '../src/daemon/paths';
import { Store } from '../src/daemon/store';
import { DEFAULT_SETTINGS, settingsSchema } from '../src/shared/protocol';

test('executable lookup handles Windows PATH casing, quoted directories and user install locations', () => {
  const env = { Path: '"D:\\My Tools";relative;;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\开发', LOCALAPPDATA: 'C:\\Users\\开发\\AppData\\Local', SCOOP: 'D:\\Apps\\scoop', ProgramFiles: 'D:\\Program Files' };
  const candidates = pathCandidates('pwsh', env, 'win32', ['E:\\New PowerShell']);
  assert.equal(candidates[0], 'D:\\My Tools\\pwsh.exe');
  assert.ok(candidates.includes('E:\\New PowerShell\\pwsh.exe'));
  assert.equal(candidates.some(candidate => candidate.includes('relative')), false);
  const installed = powershellCandidates(env);
  for (const location of ['D:\\Program Files\\PowerShell\\7\\pwsh.exe', 'D:\\Apps\\scoop\\apps\\pwsh\\current\\pwsh.exe', 'C:\\Users\\开发\\.dotnet\\tools\\pwsh.exe', 'C:\\Users\\开发\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe']) assert.ok(installed.includes(location), location);
  assert.equal(environmentValue('PATH', { Path: '/wrong', PATH: '/correct' }, 'linux'), '/correct');
  assert.deepEqual(pathCandidates('pwsh', { PATH: '/bin:/usr/local/bin:relative' }, 'linux'), ['/bin/pwsh', '/usr/local/bin/pwsh']);
});

test('Windows native lookup refreshes persisted PATH when the inherited PATH is empty', { skip: process.platform !== 'win32' }, async t => {
  const previous = process.env.Path;
  t.after(() => { if (previous === undefined) delete process.env.Path; else process.env.Path = previous; });
  process.env.Path = '';
  const result = await resolveTerminal({ profile: 'custom', executable: 'cmd.exe', args: ['/D'] });
  assert.equal(path.basename(result.file).toLowerCase(), 'cmd.exe');
  assert.ok(path.isAbsolute(result.file));
});

test('PowerShell detection finds a per-user Scoop install without PATH or the standard installation', { skip: process.platform !== 'win32' }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-scoop-'));
  const directory = path.join(folder, 'scoop', 'apps', 'pwsh', 'current'); mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'pwsh.exe');
  copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), target);
  const keys = ['Path', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'SCOOP'], saved = keys.map(key => process.env[key]);
  t.after(() => { keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }); rmSync(folder, { recursive: true, force: true }); });
  process.env.Path = ''; process.env.ProgramFiles = path.join(folder, 'missing'); delete process.env.ProgramW6432; delete process.env['ProgramFiles(x86)']; process.env.SCOOP = path.join(folder, 'scoop');
  assert.equal((await resolveTerminal({ profile: 'pwsh', executable: '', args: [] })).file, target);
});

test('PowerShell profile accepts an explicit program path and keeps its shell arguments', async () => {
  const result = await resolveTerminal({ profile: 'pwsh', executable: process.execPath, args: [] });
  assert.equal(result.file, process.execPath);
  assert.deepEqual(result.args, ['-NoLogo', '-NoExit']);
});

test('default custom command persists independently and rejects empty commands without changing saved settings', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-default-command-'));
  let store = new Store(folder);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const project = store.createProject('project', folder), existing = store.createSession(project.id, 'existing', 'custom', 'echo ORIGINAL');
  const settings = { ...DEFAULT_SETTINGS, defaultAgent: 'custom' as const, defaultCommand: 'my-agent --name "带空格的参数"' };
  store.saveSettings(settings);
  assert.throws(() => store.saveSettings({ ...settings, defaultCommand: ' ' }), /默认启动命令/);
  assert.equal(settingsSchema.safeParse({ ...settings, defaultCommand: 'first\nsecond' }).success, false);
  store.close(); store = new Store(folder);
  assert.deepEqual(store.settings(), settings);
  assert.equal(store.session(existing.id).command, 'echo ORIGINAL');
});

test('0.4 settings gain an empty default command while preserving shell, font and default Agent', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-settings-migration-'));
  const seed = new Store(folder); seed.close();
  const old = { terminal: { profile: 'pwsh', executable: 'D:\\PowerShell\\pwsh.exe', args: [] }, defaultAgent: 'custom', fontSize: 19 };
  const db = new DatabaseSync(path.join(folder, 'berth.sqlite'));
  db.prepare('INSERT INTO settings(id,value) VALUES(1,?)').run(JSON.stringify(old)); db.close();
  const store = new Store(folder);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  assert.deepEqual(store.settings(), { ...old, defaultCommand: '' });
});
