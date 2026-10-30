import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const folder = await mkdtemp(path.join(os.tmpdir(), "berth pet's "));
const dataDirectory = path.join(folder, 'data');
const executablePath = packaged ? path.resolve('release/win-unpacked/AgentBerth.exe') : undefined;
const args = [...(packaged ? [] : [path.resolve('.')]), '--user-data-dir=' + path.join(folder, 'profile')];
if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
const fixtureBin = path.join(folder, 'bin'); await mkdir(fixtureBin);
const exported = JSON.stringify({ info: { id: 'smoke-native', directory: folder }, messages: [] });
await writeFile(path.join(fixtureBin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode'), process.platform === 'win32'
  ? '@echo off\r\nif "%~1"=="--version" (echo 1.14.33) else (echo ' + exported + ')\r\n'
  : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.14.33; else printf \'%s\\n\' \'' + exported.replaceAll("'", "'\\''") + "'; fi\n", { mode: 0o755 });
const env = { ...process.env, PATH: fixtureBin + path.delimiter + process.env.PATH, AGENTBERTH_DATA_DIR: dataDirectory, CLAUDE_CONFIG_DIR: path.join(folder, 'claude-home'), XDG_CONFIG_HOME: path.join(folder, 'config-home') }; delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await electron.launch({ executablePath, args, env, timeout: 20000 });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.berth);
  const rpc = (method, params) => page.evaluate(({ method, params }) => window.berth.rpc(method, params), { method, params });
  await rpc('state', {});
  const project = await rpc('createProject', { name: 'Pet test', path: folder });
  const shell = await rpc('createSession', { projectId: project.id, title: 'Ordinary terminal', agent: 'shell', command: '' });
  await rpc('start', { sessionId: shell.id, cols: 80, rows: 24 });
  // Seed a failed remote locally without making a network connection.
  const profile = await page.evaluate(privateKeyPath => window.berth.saveSshConnection({ alias: 'pet-filter-fixture', hostname: '127.0.0.1', port: 22, username: 'fixture', authentication: 'key', privateKeyPath, allowAgent: false }, undefined, {}, false), path.join(folder, 'missing-fixture-key'));
  const remote = await rpc('createRemoteSession', { title: 'Excluded SSH', remote: { host: profile.alias, connectionId: profile.id, directory: '' } });
  await assert.rejects(rpc('start', { sessionId: remote.id, cols: 80, rows: 24 }), /无法读取私钥/);
  const create = title => rpc('createSession', { projectId: project.id, title, agent: 'custom', command: 'echo Agent-fixture-ready' });
  const a = await create('Agent A'), b = await create('Agent B');
  const runA = await rpc('start', { sessionId: a.id, cols: 80, rows: 24 });
  const runB = await rpc('start', { sessionId: b.id, cols: 80, rows: 24 });
  console.log('Pet smoke: open settings/window');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '桌宠', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.pet-animation .pet-character')].length === 6 && [...document.querySelectorAll('.pet-animation .pet-character')].every(image => image.src.endsWith('.png') && image.complete && image.naturalWidth === 288 && image.naturalHeight === 240));
  await page.locator('.pet-animation .pet-character').first().hover();
  await page.waitForFunction(() => document.querySelector('.pet-animation .pet-character')?.src.endsWith('.webp'));
  await page.getByRole('heading', { name: '桌宠', exact: true }).first().hover();
  await page.waitForFunction(() => document.querySelector('.pet-animation .pet-character')?.src.endsWith('.png'));
  const petReady = application.waitForEvent('window');
  await page.getByLabel('显示桌宠', { exact: true }).check();
  const pet = await petReady; pet.setDefaultTimeout(15000); pet.on('pageerror', error => errors.push(error.message));
  await pet.emulateMedia({ reducedMotion: 'no-preference' });
  await pet.locator('.desktop-pet').waitFor();
  assert.equal(await pet.locator('.pet-card, .pet-drag, select').count(), 0, 'Only the character should be visible');
  const initialPet = await pet.evaluate(() => window.berth.pet({ action: 'state' }));
  assert.deepEqual(initialPet.sessions.map(session => session.sessionId).sort(), [a.id, b.id].sort());
  // Native menus are outside the renderer. Capture the real Menu object at its
  // popup boundary and invoke its actual handlers without opening an OS modal.
  await application.evaluate(({ Menu }) => { Menu.prototype.popup = function () { globalThis.petSmokeMenu = this; }; });
  const openMenu = async () => {
    await application.evaluate(() => { globalThis.petSmokeMenu = null; });
    await pet.locator('.pet-stage').click({ button: 'right' });
    await pet.evaluate(() => window.berth.pet({ action: 'state' }));
    assert.equal(await application.evaluate(() => !!globalThis.petSmokeMenu), true, 'Right click must open the native context menu');
  };
  const chooseMenu = async (label, child) => {
    await openMenu();
    await application.evaluate(({ BrowserWindow }, { label, child }) => {
      let item = globalThis.petSmokeMenu.items.find(item => item.label === label);
      if (child !== undefined) item = item?.submenu?.items.find(item => item.label === child || item.id === child);
      if (!item || !item.enabled) throw new Error('Menu item unavailable: ' + label + '/' + child);
      if (item.type === 'checkbox') item.checked = !item.checked;
      item.click(item, BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet')), {});
    }, { label, child });
  };
  await openMenu();
  assert.deepEqual(await application.evaluate(() => globalThis.petSmokeMenu.items.find(item => item.label === '切换 Agent 会话').submenu.items.map(item => item.id).sort()), [a.id, b.id].sort());
  console.log('Pet smoke: popup focus keeps the companion visible without stealing input');
  await application.evaluate(async ({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'));
    const bounds = target.getBounds();
    globalThis.petSmokePopup = new BrowserWindow({ ...bounds, title: 'Popup focus fixture', show: false });
    await globalThis.petSmokePopup.loadURL('data:text/html,<input autofocus value="popup keeps keyboard focus">');
    target.focus();
    globalThis.petSmokePopup.show(); globalThis.petSmokePopup.focus();
  });
  // CI's bare Xvfb has no window manager to deliver native activation changes.
  // Playwright also emulates renderer focus, so use native focus on Windows/macOS.
  if (process.platform === 'linux') await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet')).emit('blur'));
  else assert.equal(await application.evaluate(async ({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!target.isFocused() && globalThis.petSmokePopup.isFocused()) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }), true, 'Popup must retain native keyboard focus');
  await pet.waitForFunction(() => document.visibilityState === 'visible' && !!document.querySelector('.pet-character')?.complete);
  const popupState = await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'));
    return { visible: target.isVisible(), top: target.isAlwaysOnTop(), throttled: target.webContents.getBackgroundThrottling() };
  });
  assert.deepEqual(popupState, { visible: true, top: true, throttled: false });
  await chooseMenu('保持置顶');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet')).isAlwaysOnTop()), false);
  await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'));
    target.emit('blur');
    if (target.isAlwaysOnTop()) throw new Error('Blur must preserve disabled stacking');
    globalThis.petSmokePopup.destroy(); delete globalThis.petSmokePopup;
  });
  await chooseMenu('保持置顶');
  await pet.waitForFunction(() => document.querySelector('.pet-character').complete && document.querySelector('.pet-character').naturalWidth === 288);
  await chooseMenu('切换 Agent 会话', a.id);
  await pet.waitForFunction(id => document.querySelector('.desktop-pet').dataset.sessionId === id, a.id);
  console.log('Pet smoke: drag the character without a separate drag region');
  const dragOrigin = await application.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet')).getBounds();
    globalThis.petOriginalCursor = screen.getCursorScreenPoint;
    globalThis.petSmokeCursor = { x: bounds.x + 60, y: bounds.y + 60 };
    screen.getCursorScreenPoint = () => globalThis.petSmokeCursor;
    return bounds;
  });
  await pet.mouse.move(60, 60); await pet.mouse.down();
  await pet.evaluate(() => window.berth.pet({ action: 'state' }));
  await application.evaluate(() => { globalThis.petSmokeCursor.x -= 30; globalThis.petSmokeCursor.y -= 30; });
  await pet.mouse.move(80, 80);
  const moved = await application.evaluate(async ({ BrowserWindow }, origin) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('view=pet'));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const bounds = target.getBounds(); if (bounds.x === origin.x - 30 && bounds.y === origin.y - 30) return true; await new Promise(resolve => setTimeout(resolve, 20)); }
    return false;
  }, dragOrigin);
  await pet.mouse.up();
  await application.evaluate(({ screen }) => { screen.getCursorScreenPoint = globalThis.petOriginalCursor; });
  assert.equal(moved, true, 'Dragging the image must move the native window');
  assert.equal(await pet.locator('.pet-stage').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  console.log('Pet smoke: real terminal hook identity');
  const runtime = await application.evaluate(() => ({ exec: process.execPath, resources: process.resourcesPath }));
  const script = packaged ? path.join(runtime.resources, 'pet', 'pet-hook.cjs') : path.resolve('dist/pet-hook.cjs');
  const quote = value => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
  // Run through the actual PTY: injected identity must reach the hook unchanged.
  const command = process.platform === 'win32' ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(runtime.exec)} ${quote(script)} --event working\r` : `ELECTRON_RUN_AS_NODE=1 ${quote(runtime.exec)} ${quote(script)} --event working\r`;
  await rpc('attach', { sessionId: a.id });
  await rpc('input', { sessionId: a.id, runId: runA.id, data: command });
  await pet.waitForFunction(() => document.querySelector('.pet-state-working'));
  await rpc('detach', { sessionId: a.id });
  await pet.emulateMedia({ reducedMotion: 'reduce' });
  await pet.waitForFunction(() => document.querySelector('.pet-character').src.endsWith('.png'));
  assert.equal(await pet.locator('.pet-character').isVisible(), true);
  await pet.emulateMedia({ reducedMotion: 'no-preference' });
  await pet.waitForFunction(() => document.querySelector('.pet-character').src.endsWith('.webp'));
  const descriptor = JSON.parse(await readFile(path.join(dataDirectory, 'pet-hook.json'), 'utf8'));
  const hook = async (session, run, status) => {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/hook`, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token }, body: JSON.stringify({ sessionId: session.id, runId: run.id, status }) });
    assert.equal(response.status, 200);
  };
  console.log('Pet smoke: waiting switches session, jump and hidden workbench');
  await hook(b, runB, 'waiting');
  await pet.waitForFunction(id => document.querySelector('.desktop-pet').dataset.sessionId === id && document.querySelector('.pet-state-waiting'), b.id);
  await chooseMenu('打开当前会话');
  await page.waitForFunction(id => document.querySelector('.session-header')?.dataset.sessionId === id, b.id);
  await application.evaluate(({ BrowserWindow }) => { for (const target of BrowserWindow.getAllWindows()) if (!target.webContents.getURL().includes('view=pet')) target.hide(); });
  await hook(b, runB, 'completed');
  await pet.waitForFunction(() => document.querySelector('.pet-state-completed'));
  await chooseMenu('打开当前会话');
  await chooseMenu('桌宠设置…');
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '桌宠', exact: true }).waitFor();
  console.log('Pet smoke: copy Agent setup tutorial with actual installation paths');
  await page.getByRole('button', { name: '复制给 Agent 自动配置', exact: true }).click();
  const guide = await page.evaluate(() => window.berth.readClipboard());
  assert.ok(guide.includes(JSON.stringify(runtime.exec)) && guide.includes(JSON.stringify(script)));
  assert.ok(guide.includes('AGENTBERTH_SESSION_ID') && guide.includes('备份') && guide.includes('去重'));
  await chooseMenu('复制 hook 自动配置教程');
  assert.equal(await page.evaluate(() => window.berth.readClipboard()), guide);
  await page.getByText('查看完整自动配置教程', { exact: true }).click();
  assert.equal((await page.locator('.pet-hook-guide pre').innerText()).trimEnd(), guide.trimEnd());
  console.log('Pet smoke: install/update both provider adapters, preserve hooks and expose OpenCode MCP');
  await mkdir(path.join(folder, '.claude'), { recursive: true });
  await writeFile(path.join(folder, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  await page.getByLabel('桌宠适配范围', { exact: true }).selectOption(project.id);
  await page.getByRole('button', { name: '安装/更新适配', exact: true }).click();
  await page.getByRole('status', { name: '适配安装结果', exact: true }).filter({ hasText: '适配已安装；' }).waitFor();
  const merged = JSON.parse(await readFile(path.join(folder, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(merged.permissions, { allow: ['Read'] }); assert.equal(merged.hooks.Stop.length, 1);
  await page.getByLabel('桌宠适配 Agent', { exact: true }).selectOption('opencode');
  await page.getByRole('button', { name: '安装/更新适配', exact: true }).click();
  await page.getByRole('status', { name: '适配安装结果', exact: true }).filter({ hasText: '适配已安装；' }).waitFor();
  const installedPlugin = path.join(folder, '.opencode', 'plugins', 'agentberth-pet.js');
  assert.match(await readFile(installedPlugin, 'utf8'), /OpenCode major: 1/);
  await page.evaluate(projectId => window.berth.pet({ action: 'installHook', provider: 'opencode', projectId, opencodeVersion: '2' }), project.id);
  assert.match(await readFile(installedPlugin, 'utf8'), /OpenCode major: 2/);
  const openCodeMcp = JSON.parse(await page.evaluate(() => window.berth.mcpConfig('opencode')));
  assert.equal(openCodeMcp.mcp.agentberth.type, 'local'); assert.equal(openCodeMcp.mcp.agentberth.environment.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(!openCodeMcp.mcpServers);
  const integrated = await rpc('createAgent', { name: 'OpenCode fixture', integration: 'opencode', command: 'opencode', resumeCommand: 'opencode --session {sessionId}' });
  const skills = await page.evaluate(location => window.berth.skills({ action: 'list', location }), { agentId: integrated.id, projectId: project.id });
  assert.equal(skills.root, path.join(project.path, '.opencode', 'skills'));
  const oc = await rpc('createSession', { projectId: project.id, title: 'OpenCode fixture', agent: integrated.id });
  const ocRun = await rpc('start', { sessionId: oc.id, cols: 80, rows: 24 }); assert.match(ocRun.command, /--standalone/);
  const detected = await fetch(`http://127.0.0.1:${descriptor.port}/hook`, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token }, body: JSON.stringify({ sessionId: oc.id, runId: ocRun.id, provider: 'opencode', nativeSessionId: 'smoke-native', cwd: folder, status: 'waiting' }) });
  assert.equal(detected.status, 200);
  await pet.waitForFunction(id => document.querySelector('.desktop-pet').dataset.sessionId === id && document.querySelector('.pet-state-waiting'), oc.id);
  await page.waitForFunction(async id => (await window.berth.rpc('state', {})).sessions.find(session => session.id === id)?.nativeSessionId === 'smoke-native', oc.id);
  await rpc('stop', { sessionId: oc.id }); await chooseMenu('切换 Agent 会话', b.id);
  console.log('Pet smoke: context-menu scale control, synchronized settings and image-only layout');
  for (const scale of [0.5, 2, 1.5]) {
    await chooseMenu('桌宠大小', Math.round(scale * 100) + '%');
    await pet.waitForFunction(scale => Number(document.querySelector('.desktop-pet').style.zoom) === scale, scale);
    await page.waitForFunction(scale => Number(document.querySelector('[aria-label="桌宠大小"]').value) === scale, scale);
    const layout = await pet.evaluate(() => {
      const bounds = document.querySelector('.desktop-pet').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, right: bounds.right, bottom: bounds.bottom, imageBottom: document.querySelector('.pet-character').getBoundingClientRect().bottom };
    });
    assert.ok(layout.right <= layout.width + 1 && layout.bottom <= layout.height + 1 && layout.imageBottom <= layout.height + 1, JSON.stringify({ scale, ...layout }));
  }
  // The settings control changes the same persisted preference in the other window.
  await page.getByLabel('桌宠大小', { exact: true }).selectOption('1');
  await pet.waitForFunction(() => Number(document.querySelector('.desktop-pet').style.zoom) === 1);
  await chooseMenu('桌宠大小', '150%');
  await pet.waitForFunction(() => Number(document.querySelector('.desktop-pet').style.zoom) === 1.5);
  console.log('Pet smoke: GIF import/reset');
  const image = path.resolve('tests/fixtures/pet-completed.gif');
  await application.evaluate(({ dialog }, image) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] }); }, image);
  const animation = page.locator('.pet-animation').filter({ has: page.getByText('已完成', { exact: true }) });
  await animation.getByRole('button', { name: '导入 GIF', exact: true }).click();
  await pet.waitForFunction(() => document.querySelector('.pet-character').src.startsWith('data:image/gif;base64,'));
  await mkdir('test-results', { recursive: true });
  await pet.screenshot({ path: `test-results/desktop-pet-${process.platform}${packaged ? '-packaged' : ''}.png` });
  await page.screenshot({ path: `test-results/pet-settings-${process.platform}${packaged ? '-packaged' : ''}.png` });
  await animation.getByRole('button', { name: '恢复默认', exact: true }).click();
  await pet.waitForFunction(() => !document.querySelector('.pet-character').src.startsWith('data:'));
  const closed = pet.waitForEvent('close');
  await chooseMenu('隐藏桌宠');
  await closed;
  assert.equal((await page.evaluate(() => window.berth.pet({ action: 'state' }))).preferences.enabled, false);
  assert.equal((await rpc('state', {})).sessions.find(session => session.id === a.id).latestRun.status, 'running');
  assert.deepEqual(errors, []);
  assert.equal((await rpc('state', {})).sessions.find(session => session.id === shell.id).latestRun.status, 'running');
  await rpc('stop', { sessionId: a.id }); await rpc('stop', { sessionId: b.id }); await rpc('stop', { sessionId: shell.id });
  console.log('Pet smoke passed: independent window, actual PTY hook binding, Agent-only list, local navigation, copyable setup guide, image dragging and native context-menu operations, scaling, GIF import/reset and non-destructive hide');
} catch (error) {
  await mkdir('test-results', { recursive: true });
  for (const [index, page] of (application?.windows() ?? []).entries()) await page.screenshot({ path: `test-results/pet-failure-${process.platform}-${index}.png` }).catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await rm(folder, { recursive: true, force: true });
}
