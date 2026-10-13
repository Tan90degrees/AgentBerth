import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const step = text => console.log(`Smoke: ${text}`);
async function closeApplication(app) {
  if (!app) return;
  const launcherProcess = app.process();
  // A detached daemon may retain inherited pipe handles. Node's child "close"
  // event can then arrive after "exit"; wait for the actual launcher exit.
  let onExit;
  const exited = launcherProcess.exitCode !== null || launcherProcess.signalCode !== null ? Promise.resolve() : new Promise(resolve => { onExit = resolve; launcherProcess.once('exit', onExit); });
  let timer;
  try {
    await Promise.race([exited, app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron workbench did not exit within 10s')), 10000); })]);
  } finally { clearTimeout(timer); if (onExit) launcherProcess.removeListener('exit', onExit); }
}
async function forceCleanup(app) {
  if (!app) return;
  const pid = app.process().pid;
  try {
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    else app.process().kill('SIGKILL');
  } catch {}
}

const packaged = process.argv.includes('--packaged');
if (packaged && process.platform !== 'win32') throw new Error('Packaged smoke requires the Windows package built on Windows');
const executablePath = packaged ? path.resolve('release/win-unpacked/AgentBerth.exe') : undefined;
if (executablePath) await stat(executablePath);
const launchArgs = packaged ? [] : [path.resolve('.')];
if (process.platform === 'linux' && process.getuid?.() === 0) launchArgs.push('--no-sandbox');
const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-desktop-'));
await mkdir('test-results', { recursive: true });
let application;
let daemonPid;
try {
  const env = { ...process.env, AGENTBERTH_DATA_DIR: path.join(folder, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  step(`launch ${packaged ? executablePath : 'development application'}`);
  application = await electron.launch({ executablePath, args: launchArgs, env, timeout: 20000 });
  application.on('console', message => console.log(`Main: ${message.text()}`));
  step('wait for window');
  let page = await application.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(`Renderer: ${message.text()}`); });
  step('create project and session');
  await page.getByRole('button', { name: '添加第一个项目' }).waitFor();
  await page.getByRole('button', { name: '添加第一个项目' }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('AgentBerth 开发');
  await page.locator('.dialog input').nth(1).fill(folder);
  await page.getByRole('dialog').getByRole('button', { name: '添加项目', exact: true }).click();
  step('edit and search project');
  await page.getByRole('button', { name: '编辑项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('AgentBerth 易用性');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.getByRole('heading', { name: 'AgentBerth 易用性', exact: true }).waitFor();
  await page.getByLabel('搜索项目', { exact: true }).fill('不存在的项目');
  assert.equal(await page.locator('.projects .project-item').count(), 0);
  await page.getByLabel('搜索项目', { exact: true }).fill('易用性');
  await page.locator('.projects .project-item').waitFor();
  await page.getByLabel('搜索项目', { exact: true }).fill('');
  step('save shell and default Agent settings');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('默认终端', { exact: true }).selectOption(process.platform === 'win32' ? 'cmd' : 'bash');
  await page.getByLabel('默认 Agent', { exact: true }).selectOption('opencode');
  await page.getByLabel('终端字号', { exact: true }).fill('16');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  await page.locator('.projects .project-item').click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  assert.equal(await page.getByLabel('Agent 类型', { exact: true }).inputValue(), 'opencode');
  await page.getByLabel('会话名称', { exact: true }).fill('后台驻留验证');
  await page.getByLabel('Agent 类型', { exact: true }).selectOption('shell');
  await page.getByRole('button', { name: '创建并启动' }).click();
  await page.getByRole('button', { name: '停止终端', exact: true }).waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo DESKTOP_SMOKE_READY');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.berth.rpc('state'));
  const original = before.sessions[0].latestRun;
  assert.equal(original.status, 'running');
  assert.match(original.shell, process.platform === 'win32' ? /cmd\.exe$/i : /bash$/);
  assert.equal(await page.getByRole('button', { name: '删除会话', exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: '删除项目', exact: true }).isEnabled(), false);
  step('edit running session name without changing its terminal');
  await page.getByRole('button', { name: '编辑会话', exact: true }).click();
  assert.equal(await page.getByLabel('Agent 类型', { exact: true }).isEnabled(), false);
  await page.getByLabel('会话名称', { exact: true }).fill('后台驻留验证');
  await page.getByRole('button', { name: '保存会话', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  step('choose custom executable using native dialog while PTY keeps running');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('默认终端', { exact: true }).selectOption('custom');
  await application.evaluate(({ dialog }, file) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [file] }; };
  }, original.shell);
  await page.getByRole('button', { name: '选择程序', exact: true }).click();
  await page.waitForFunction(file => document.querySelector('input[aria-label="终端程序"]')?.value === file, original.shell);
  await page.getByLabel('启动参数', { exact: true }).fill(process.platform === 'win32' ? '/D' : '-i');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  await page.screenshot({ path: `test-results/${packaged ? 'packaged-settings' : 'settings'}.png` });
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).sessions[0].latestRun.pid, original.pid);
  await page.locator('.projects .project-item').click();
  await page.getByLabel('搜索会话', { exact: true }).fill('不存在');
  assert.equal(await page.locator('.session-list .session-item').count(), 0);
  await page.getByLabel('搜索会话', { exact: true }).fill('驻留');
  await page.locator('.session-list .session-item').waitFor();
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  await page.getByLabel('筛选会话', { exact: true }).selectOption('opencode');
  assert.equal(await page.locator('.session-list .session-item').count(), 0);
  await page.getByLabel('筛选会话', { exact: true }).selectOption('all');
  step('hide and reconnect terminal');
  await page.getByRole('button', { name: '收起终端' }).click();
  await page.getByRole('heading', { name: '终端已收起' }).waitFor();
  await page.getByRole('button', { name: '接回终端', exact: true }).last().click();
  await page.locator('.xterm-helper-textarea').waitFor();
  step('close and show native window');
  // Closing the native window hides it; second-instance launch can show it again.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.screenshot({ path: `test-results/${packaged ? 'packaged-workbench' : 'workbench'}.png` });
  assert.equal(errors.length, 0, errors.join('\n'));
  daemonPid = JSON.parse(await readFile(path.join(folder, 'data', 'runtime.json'), 'utf8')).pid;
  // Playwright's close exits the entire Electron main process, not just the window.
  step('exit whole workbench');
  await closeApplication(application); application = null;
  step('reopen workbench');
  application = await electron.launch({ executablePath, args: launchArgs, env, timeout: 20000 });
  page = await application.firstWindow({ timeout: 20000 });
  page.setDefaultTimeout(15000);
  await page.getByRole('heading', { name: '后台驻留验证', exact: true }).waitFor();
  const after = await page.evaluate(() => window.berth.rpc('state'));
  assert.equal(after.sessions[0].latestRun.id, original.id);
  assert.equal(after.sessions[0].latestRun.pid, original.pid);
  assert.equal(after.settings.terminal.profile, 'custom');
  assert.equal(after.settings.terminal.executable, original.shell);
  assert.equal(after.settings.defaultAgent, 'opencode');
  assert.equal(after.settings.fontSize, 16);
  const snapshot = await page.evaluate(id => window.berth.rpc('attach', { sessionId: id }), after.sessions[0].id);
  assert.match(snapshot.snapshot, /DESKTOP_SMOKE_READY/);
  step('stop terminal');
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('button', { name: '启动终端', exact: true }).waitFor();
  step('edit stopped launch configuration, start using session shell override and delete session');
  await page.getByRole('button', { name: '编辑会话', exact: true }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('编辑后的会话');
  await page.getByLabel('Agent 类型', { exact: true }).selectOption('custom');
  await page.getByLabel('启动命令', { exact: true }).fill('echo EDITED_SESSION_READY');
  await page.getByLabel('会话终端', { exact: true }).selectOption(process.platform === 'win32' ? 'powershell' : 'bash');
  await page.getByRole('button', { name: '保存会话', exact: true }).click();
  await page.getByRole('heading', { name: '编辑后的会话', exact: true }).waitFor();
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await page.getByRole('button', { name: '停止终端', exact: true }).waitFor();
  const edited = (await page.evaluate(() => window.berth.rpc('state'))).sessions[0];
  assert.equal(edited.latestRun.command, 'echo EDITED_SESSION_READY');
  assert.match(edited.latestRun.shell, process.platform === 'win32' ? /powershell\.exe$/i : /bash$/);
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('button', { name: '启动终端', exact: true }).waitFor();
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('heading', { name: '编辑后的会话', exact: true }).waitFor();
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await page.getByRole('heading', { name: '选择或创建一个会话', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).sessions.length, 0);
  step('create OpenCode without starting, link ID and import native export through IPC');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('OpenCode 会话');
  assert.equal(await page.getByLabel('Agent 类型', { exact: true }).inputValue(), 'opencode');
  await page.getByLabel('创建后立即启动', { exact: true }).uncheck();
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('heading', { name: 'OpenCode 会话', exact: true }).waitFor();
  await page.getByRole('tab', { name: '对话历史', exact: true }).click();
  await page.getByRole('button', { name: '关联会话 ID', exact: true }).click();
  await page.getByLabel('原生会话 ID', { exact: true }).fill('ses_smoke');
  await page.getByRole('button', { name: '保存关联', exact: true }).click();
  await page.getByRole('button', { name: '恢复原生会话', exact: true }).waitFor();
  const exportPath = path.join(folder, 'session.json');
  await writeFile(exportPath, JSON.stringify({ info: { id: 'ses_smoke', directory: folder }, messages: [
    { info: { role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text: 'OpenCode 原生导出验证' }] },
    { info: { role: 'assistant', time: { created: Date.now() } }, parts: [{ type: 'text', text: '对话与项目已关联' }] },
  ] }));
  await application.evaluate(({ dialog }, file) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [file] }; };
  }, exportPath);
  await page.getByRole('button', { name: '关联 JSON', exact: true }).click();
  await page.getByText('对话与项目已关联', { exact: true }).waitFor();
  await page.screenshot({ path: `test-results/${packaged ? 'packaged-opencode' : 'opencode'}.png` });
  step('update backend without losing settings or conversations');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '更新后台', exact: true }).click();
  await page.getByRole('button', { name: '确认更新后台', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const previousDaemon = daemonPid;
  daemonPid = JSON.parse(await readFile(path.join(folder, 'data', 'runtime.json'), 'utf8')).pid;
  assert.notEqual(daemonPid, previousDaemon);
  const restarted = await page.evaluate(() => window.berth.rpc('state'));
  assert.equal(restarted.settings.defaultAgent, 'opencode');
  assert.equal(restarted.sessions[0].nativeSessionId, 'ses_smoke');
  await page.locator('.projects .project-item').click();
  step('change project directory and remove registration while retaining actual files');
  const moved = path.join(folder, 'moved'); await mkdir(moved);
  await page.getByRole('button', { name: '编辑项目', exact: true }).click();
  await page.getByLabel('项目目录', { exact: true }).fill(moved);
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).sessions[0].nativeSessionId, null);
  await page.getByRole('button', { name: '删除项目', exact: true }).click();
  await page.getByRole('button', { name: '确认删除项目', exact: true }).click();
  await page.getByRole('button', { name: '添加第一个项目', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).projects.length, 0);
  await stat(exportPath); await stat(moved);
  console.log(`${packaged ? 'Packaged' : 'Desktop'} smoke passed: project/session CRUD and search, settings persistence, shell selection and override, same-PID lifecycle, OpenCode ID/export, idle backend upgrade.`);
} catch (error) {
  console.error(error);
  if (application) {
    try {
      const page = application.windows()[0];
      if (page) {
        console.error(`Window: ${page.url()}`);
        console.error((await page.locator('body').innerText({ timeout: 2000 })).slice(0, 2000));
        await page.screenshot({ path: 'test-results/smoke-failure.png', timeout: 5000 });
      }
    } catch {}
  }
  throw error;
} finally {
  if (application) { try { await closeApplication(application); } catch (error) { console.error(error.message); await forceCleanup(application); } }
  if (!daemonPid) { try { daemonPid = JSON.parse(await readFile(path.join(folder, 'data', 'runtime.json'), 'utf8')).pid; } catch {} }
  if (daemonPid) {
    try {
      if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(daemonPid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      else process.kill(daemonPid, 'SIGTERM');
    } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 600));
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
