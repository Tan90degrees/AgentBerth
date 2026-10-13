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
  step('keyboard switcher keeps PTY focus and copies configuration without launching');
  await page.keyboard.press('Control+Shift+P');
  await page.getByRole('dialog', { name: '快速切换', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '搜索项目、会话和操作', exact: true }).fill('后台驻留');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.getByRole('button', { name: '复制项目路径', exact: true }).click();
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), before.projects[0].path);
  await page.getByRole('button', { name: '复制会话', exact: true }).click();
  assert.equal(await page.getByLabel('创建后立即启动', { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel('Agent 类型', { exact: true }).inputValue(), 'shell');
  await page.getByLabel('会话名称', { exact: true }).fill('切换测试会话');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('heading', { name: '切换测试会话', exact: true }).waitFor();
  const copied = (await page.evaluate(() => window.berth.rpc('state'))).sessions.find(item => item.title === '切换测试会话');
  assert.equal(copied.latestRun, null); assert.equal(copied.nativeSessionId, null);
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).sessions.find(item => item.id === before.sessions[0].id).latestRun.pid, original.pid);
  step('dirty form stays intact after Escape, cancel and repeated keyboard navigation');
  await page.keyboard.press('Control+Shift+N');
  await page.getByLabel('会话名称', { exact: true }).fill('保留表单内容');
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: '放弃未保存的修改？', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByLabel('会话名称', { exact: true }).inputValue(), '保留表单内容');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  step('remember last selected session separately for each project');
  const otherFolder = path.join(folder, 'other-project'); await mkdir(otherFolder);
  await page.keyboard.press('Control+Shift+O');
  await page.getByLabel('项目名称', { exact: true }).fill('切换测试项目');
  await page.getByLabel('项目目录', { exact: true }).fill(otherFolder);
  await page.getByRole('dialog').getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByRole('heading', { name: '切换测试项目', exact: true }).waitFor();
  await page.keyboard.press('Control+Shift+N');
  await page.getByLabel('会话名称', { exact: true }).fill('辅助项目会话');
  await page.getByLabel('Agent 类型', { exact: true }).selectOption('shell');
  await page.getByLabel('创建后立即启动', { exact: true }).uncheck();
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('heading', { name: '辅助项目会话', exact: true }).waitFor();
  await page.locator('.projects .project-item').filter({ hasText: 'AgentBerth 易用性' }).click();
  await page.getByRole('heading', { name: '切换测试会话', exact: true }).waitFor();
  await page.locator('.session-list .session-item').filter({ hasText: '后台驻留验证' }).click();
  await page.locator('.projects .project-item').filter({ hasText: '切换测试项目' }).click();
  await page.getByRole('heading', { name: '辅助项目会话', exact: true }).waitFor();
  await page.locator('.projects .project-item').filter({ hasText: 'AgentBerth 易用性' }).click();
  await page.getByRole('heading', { name: '后台驻留验证', exact: true }).waitFor();
  await page.locator('.session-list .session-item').filter({ hasText: '切换测试会话' }).click();
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await page.getByRole('heading', { name: '后台驻留验证', exact: true }).waitFor();
  await page.getByRole('button', { name: '快速切换', exact: false }).click();
  await page.getByRole('combobox', { name: '搜索项目、会话和操作', exact: true }).fill('切换测试项目');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '辅助项目会话', exact: true }).waitFor();
  await page.getByRole('button', { name: '删除项目', exact: true }).click();
  await page.getByRole('button', { name: '确认删除项目', exact: true }).click();
  await page.getByRole('heading', { name: '后台驻留验证', exact: true }).waitFor();
  step('edit running session name without changing its terminal');
  await page.getByRole('button', { name: '编辑会话', exact: true }).click();
  assert.equal(await page.getByLabel('Agent 类型', { exact: true }).isEnabled(), false);
  await page.getByLabel('会话名称', { exact: true }).fill('后台驻留验证');
  await page.getByRole('button', { name: '保存会话', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  step('changing defaults preserves actual running shell identity');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('默认终端', { exact: true }).selectOption(process.platform === 'win32' ? 'powershell' : 'auto');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  await page.locator('.projects .project-item').click();
  assert.ok((await page.locator('.terminal-footer').innerText()).includes(path.basename(original.shell)));
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).sessions[0].latestRun.pid, original.pid);
  step('choose custom executable using native dialog while PTY keeps running');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('默认终端', { exact: true }).selectOption('custom');
  await application.evaluate(({ dialog }) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; throw new Error('模拟文件选择失败'); };
  });
  await page.getByRole('button', { name: '选择程序', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟文件选择失败' }).waitFor();
  assert.equal(await page.getByLabel('默认终端', { exact: true }).inputValue(), 'custom');
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
  step('unsaved settings survive page navigation and remain unapplied');
  await page.keyboard.press('Control+,');
  await page.getByLabel('终端字号', { exact: true }).fill('19');
  await page.locator('.projects .project-item').click();
  await page.keyboard.press('Control+,');
  assert.equal(await page.getByLabel('终端字号', { exact: true }).inputValue(), '19');
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).settings.fontSize, 16);
  await page.locator('.projects .project-item').click();
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
  step('unsaved settings survive workbench restart and can be discarded');
  await page.keyboard.press('Control+,');
  assert.equal(await page.getByLabel('终端字号', { exact: true }).inputValue(), '19');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  assert.equal(await page.getByLabel('终端字号', { exact: true }).inputValue(), '16');
  await page.locator('.projects .project-item').click();
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
  await page.getByLabel('会话终端', { exact: true }).selectOption('custom');
  await page.getByLabel('终端程序', { exact: true }).fill(path.join(folder, process.platform === 'win32' ? 'missing-shell.exe' : 'missing-shell'));
  await page.getByRole('button', { name: '保存会话', exact: true }).click();
  await page.getByRole('heading', { name: '编辑后的会话', exact: true }).waitFor();
  step('failed launch stays visible, keeps a run record and offers a working retry');
  await page.getByRole('button', { name: '启动终端', exact: true }).click();
  await page.locator('.launch-error').filter({ hasText: '找不到终端程序' }).waitFor();
  assert.equal((await page.evaluate(() => window.berth.rpc('state'))).sessions[0].latestRun.status, 'failed');
  await page.getByRole('button', { name: '修改启动配置', exact: true }).click();
  await page.getByLabel('会话终端', { exact: true }).selectOption(process.platform === 'win32' ? 'powershell' : 'bash');
  await page.getByRole('button', { name: '保存会话', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '重新启动', exact: true }).click();
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
  await page.getByRole('button', { name: '复制 ID', exact: true }).click();
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'ses_smoke');
  step('copy linked Agent configuration without duplicating its native identity or process');
  await page.getByRole('button', { name: '复制会话', exact: true }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('OpenCode 配置副本');
  assert.equal(await page.getByLabel('创建后立即启动', { exact: true }).isChecked(), false);
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('heading', { name: 'OpenCode 配置副本', exact: true }).waitFor();
  const nativeCopy = (await page.evaluate(() => window.berth.rpc('state'))).sessions.find(item => item.title === 'OpenCode 配置副本');
  assert.equal(nativeCopy.nativeSessionId, null); assert.equal(nativeCopy.transcriptPath, null); assert.equal(nativeCopy.latestRun, null);
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await page.getByRole('heading', { name: 'OpenCode 会话', exact: true }).waitFor();
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
  console.log(`${packaged ? 'Packaged' : 'Desktop'} smoke passed: project/session CRUD, keyboard switcher and focus, remembered selections, config copy, draft and dirty-form protection, native clipboard/picker errors, same-PID lifecycle, OpenCode history, idle backend upgrade.`);
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
