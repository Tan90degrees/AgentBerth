import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const folder = await mkdtemp(path.join(os.tmpdir(), "berth pet's "));
const dataDirectory = path.join(folder, 'data');
const executablePath = packaged ? path.resolve('release/win-unpacked/AgentBerth.exe') : undefined;
const args = [...(packaged ? [] : [path.resolve('.')]), '--user-data-dir=' + path.join(folder, 'profile')];
if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
const env = { ...process.env, AGENTBERTH_DATA_DIR: dataDirectory }; delete env.ELECTRON_RUN_AS_NODE;
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
  assert.equal(await pet.locator('.pet-drag').count(), 0, 'No separate title/close bar above the character');
  assert.equal(await pet.locator('.pet-card-head .pet-hide').count(), 1);
  assert.deepEqual(await pet.getByLabel('桌宠展示的会话').locator('option').evaluateAll(options => options.map(option => option.value).sort()), [a.id, b.id].sort());
  await pet.waitForFunction(() => document.querySelector('.pet-character').complete && document.querySelector('.pet-character').naturalWidth === 288);
  await pet.getByLabel('桌宠展示的会话').selectOption(a.id);
  await pet.waitForFunction(id => document.querySelector('[aria-label="桌宠展示的会话"]').value === id, a.id);
  console.log('Pet smoke: real terminal hook identity');
  const runtime = await application.evaluate(() => ({ exec: process.execPath, resources: process.resourcesPath }));
  const script = packaged ? path.join(runtime.resources, 'pet', 'pet-hook.cjs') : path.resolve('dist/pet-hook.cjs');
  const quote = value => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
  // Run through the actual PTY: injected identity must reach the hook unchanged.
  const command = process.platform === 'win32' ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${quote(runtime.exec)} ${quote(script)} --event working\r` : `ELECTRON_RUN_AS_NODE=1 ${quote(runtime.exec)} ${quote(script)} --event working\r`;
  await rpc('input', { sessionId: a.id, runId: runA.id, data: command });
  await pet.waitForFunction(() => document.querySelector('.pet-state-working'));
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
  await pet.waitForFunction(id => document.querySelector('[aria-label="桌宠展示的会话"]').value === id && document.querySelector('.pet-state-waiting'), b.id);
  await pet.getByRole('button', { name: '打开当前会话', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.session-header')?.dataset.sessionId === id, b.id);
  await application.evaluate(({ BrowserWindow }) => { for (const target of BrowserWindow.getAllWindows()) if (!target.webContents.getURL().includes('view=pet')) target.hide(); });
  await hook(b, runB, 'completed');
  await pet.waitForFunction(() => document.querySelector('.pet-state-completed'));
  await pet.getByRole('button', { name: '打开当前会话', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '桌宠', exact: true }).click();
  console.log('Pet smoke: copy Agent setup tutorial with actual installation paths');
  await page.getByRole('button', { name: '复制给 Agent 自动配置', exact: true }).click();
  const guide = await page.evaluate(() => window.berth.readClipboard());
  assert.ok(guide.includes(JSON.stringify(runtime.exec)) && guide.includes(JSON.stringify(script)));
  assert.ok(guide.includes('AGENTBERTH_SESSION_ID') && guide.includes('备份') && guide.includes('去重'));
  await page.getByText('查看完整自动配置教程', { exact: true }).click();
  assert.equal((await page.locator('.pet-hook-guide pre').innerText()).trimEnd(), guide.trimEnd());
  console.log('Pet smoke: inline scale control, synchronized settings and layout');
  for (const scale of [0.5, 2, 1.5]) {
    await pet.getByLabel('桌宠大小', { exact: true }).selectOption(String(scale));
    await pet.waitForFunction(scale => Number(document.querySelector('.desktop-pet').style.zoom) === scale, scale);
    await page.waitForFunction(scale => Number(document.querySelector('[aria-label="桌宠大小"]').value) === scale, scale);
    const layout = await pet.evaluate(() => {
      const bounds = document.querySelector('.desktop-pet').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, right: bounds.right, bottom: bounds.bottom, cardBottom: document.querySelector('.pet-card').getBoundingClientRect().bottom };
    });
    assert.ok(layout.right <= layout.width + 1 && layout.bottom <= layout.height + 1 && layout.cardBottom <= layout.height + 1, JSON.stringify({ scale, ...layout }));
  }
  // The settings control changes the same persisted preference in the other window.
  await page.getByLabel('桌宠大小', { exact: true }).selectOption('1');
  await pet.waitForFunction(() => Number(document.querySelector('.desktop-pet').style.zoom) === 1);
  await pet.getByLabel('桌宠大小', { exact: true }).selectOption('1.5');
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
  await pet.getByRole('button', { name: '隐藏桌宠', exact: true }).click().catch(error => {
    // The native window can disappear before Playwright acknowledges mouse-up.
    if (!pet.isClosed() || !String(error).includes('Target page, context or browser has been closed')) throw error;
  });
  await closed;
  assert.equal((await page.evaluate(() => window.berth.pet({ action: 'state' }))).preferences.enabled, false);
  assert.equal((await rpc('state', {})).sessions.find(session => session.id === a.id).latestRun.status, 'running');
  assert.deepEqual(errors, []);
  assert.equal((await rpc('state', {})).sessions.find(session => session.id === shell.id).latestRun.status, 'running');
  await rpc('stop', { sessionId: a.id }); await rpc('stop', { sessionId: b.id }); await rpc('stop', { sessionId: shell.id });
  console.log('Pet smoke passed: independent window, actual PTY hook binding, Agent-only list, local navigation, copyable setup guide, inline size/close controls, scaling, GIF import/reset and non-destructive hide');
} catch (error) {
  await mkdir('test-results', { recursive: true });
  for (const [index, page] of (application?.windows() ?? []).entries()) await page.screenshot({ path: `test-results/pet-failure-${process.platform}-${index}.png` }).catch(() => {});
  throw error;
} finally {
  if (application) await application.close();
  await rm(folder, { recursive: true, force: true });
}
