import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const step = text => console.log(`Smoke: ${text}`);
async function closeApplication(app) {
  if (!app) return;
  let timer;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron workbench did not close within 10s')), 10000); })]);
  } finally { clearTimeout(timer); }
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
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
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
  const snapshot = await page.evaluate(id => window.berth.rpc('attach', { sessionId: id }), after.sessions[0].id);
  assert.match(snapshot.snapshot, /DESKTOP_SMOKE_READY/);
  step('stop terminal');
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('button', { name: '启动终端', exact: true }).waitFor();
  console.log(`${packaged ? 'Packaged' : 'Desktop'} smoke passed: create project, start PTY, hide/reconnect, close window, exit app, reopen same PID, stop.`);
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
  if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 600));
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
