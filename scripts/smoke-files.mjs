import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile), packaged = process.argv.includes('--packaged');
if (packaged && process.platform !== 'win32') throw new Error('Packaged file smoke requires Windows');
const folder = await mkdtemp(path.join(os.tmpdir(), 'berth-file-smoke-'));
const root = path.join(folder, 'project'), second = path.join(folder, 'second');
await mkdir(root); await mkdir(second); await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'docs')); await mkdir(path.join(root, 'cache'));
const code = 'export const greeting: string = "文件预览🙂";\nconsole.log(greeting);\n';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNw2NDwHwAFFAJwhVSspQAAAABJRU5ErkJggg==', 'base64');
const markdown = '# 文件预览示例\n\n中文 **说明**。\n\n| 项目 | 状态 |\n| --- | --- |\n| 预览 | 可用 |\n\n- [x] 目录树\n\n```ts\nexport const ready = true;\n```\n\n[下一篇](docs/指南.md)\n\n![本地图片](pixel.png)\n\n<script>window.FILE_PREVIEW_SCRIPT_RAN=true</script>\n\n[危险链接](javascript:alert(1))\n';
await Promise.all([
  writeFile(path.join(root, '.gitignore'), 'cache/\n*.log\n!keep.log\n'),
  writeFile(path.join(root, 'README.md'), markdown), writeFile(path.join(root, 'src', 'code.ts'), code),
  writeFile(path.join(root, 'docs', '指南.md'), '# 本地链接已打开\n\n[返回](../README.md)\n'),
  writeFile(path.join(root, 'trace.log'), 'ignored'), writeFile(path.join(root, 'tracked.log'), 'tracked'), writeFile(path.join(root, 'keep.log'), 'visible'),
  writeFile(path.join(root, 'cache', 'data.txt'), 'ignored cache'), writeFile(path.join(root, 'pixel.png'), png),
  writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 255, 1, 0])), writeFile(path.join(root, 'empty.txt'), ''),
  writeFile(path.join(second, 'README.md'), '# 第二个项目\n\nSECOND_PROJECT_ONLY\n'),
  ...Array.from({ length: 205 }, (_, n) => writeFile(path.join(root, `z-page-${String(n).padStart(3, '0')}.txt`), String(n))),
]);
const git = async (...args) => execute('git', ['-c', 'commit.gpgsign=false', '-C', root, ...args], { windowsHide: true });
await git('init', '--initial-branch=main'); await git('config', 'user.name', 'File Smoke'); await git('config', 'user.email', 'smoke@example.invalid');
await git('add', '.gitignore', 'README.md', 'src/code.ts'); await git('add', '-f', 'tracked.log'); await git('commit', '-m', 'fixture');
await mkdir('test-results', { recursive: true });
let application, daemonPid;
const step = message => console.log(`File smoke: ${message}`);
async function closeApplication(app) {
  if (!app) return;
  const process = app.process(); let onExit, timer;
  const exited = process.exitCode !== null || process.signalCode !== null ? Promise.resolve() : new Promise(resolve => { onExit = resolve; process.once('exit', onExit); });
  try { await Promise.race([exited, app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('File smoke application did not exit')), 20000); })]); }
  finally { clearTimeout(timer); if (onExit) process.removeListener('exit', onExit); }
}
try {
  step('launch and keep a real terminal running throughout file navigation');
  const args = [...(packaged ? [] : [path.resolve('.')]), '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + path.join(folder, 'profile')];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  const env = { ...process.env, AGENTBERTH_DATA_DIR: path.join(folder, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: packaged ? path.resolve('release/win-unpacked/StackIsle.exe') : undefined, args, env, timeout: 20000 });
  const page = await application.firstWindow(); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.getByRole('button', { name: '添加第一个项目' }).waitFor();
  const project = await page.evaluate(root => window.berth.rpc('createProject', { name: '文件工作台', path: root }), root);
  const session = await page.evaluate(projectId => window.berth.rpc('createSession', { projectId, title: '保持运行的终端', agent: 'shell' }), project.id);
  const run = await page.evaluate(sessionId => window.berth.rpc('start', { sessionId, cols: 90, rows: 30 }), session.id);
  await page.locator('.terminal-mount .xterm').waitFor();
  daemonPid = JSON.parse(await readFile(path.join(folder, 'data', 'runtime.json'), 'utf8')).pid;
  const liveRun = async () => (await page.evaluate(id => window.berth.rpc('state').then(state => state.sessions.find(session => session.id === id).latestRun), session.id));
  const entry = name => page.getByRole('treeitem', { name, exact: true });
  await page.evaluate(() => { window.originalTerminal = document.querySelector('.terminal-mount .xterm'); });
  const sideTabs = page.getByRole('tablist', { name: '侧栏视图' }), mainTabs = page.getByRole('tablist', { name: '工作区内容' });
  await sideTabs.getByRole('tab', { name: '文件', exact: true }).click();
  await entry('README.md').waitFor();
  step('native Git gray state, tracked exceptions, pagination and ignored-folder expansion');
  assert.match(await entry('trace.log').getAttribute('class'), /ignored/);
  assert.doesNotMatch(await entry('tracked.log').getAttribute('class'), /ignored/);
  assert.doesNotMatch(await entry('keep.log').getAttribute('class'), /ignored/);
  await entry('cache').click(); assert.match(await entry('data.txt').getAttribute('class'), /ignored/);
  await page.getByRole('button', { name: '隐藏忽略项', exact: true }).click();
  assert.equal(await entry('trace.log').count(), 0); assert.equal(await entry('cache').count(), 0);
  await page.getByRole('button', { name: '显示忽略项', exact: true }).click();
  await page.getByRole('button', { name: /加载更多/ }).click(); await entry('z-page-204.txt').waitFor();
  step('render Markdown tables, task lists, highlighted fences and local images without running HTML');
  await entry('README.md').click();
  await page.getByRole('heading', { name: '文件预览示例', exact: true }).waitFor();
  assert.equal(await page.locator('.markdown-document table').count(), 1);
  await page.locator('.markdown-document .hljs-keyword').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.markdown-document img')?.naturalWidth === 1);
  assert.equal(await page.evaluate(() => window.FILE_PREVIEW_SCRIPT_RAN), undefined);
  assert.equal(await page.locator('.markdown-document script,.markdown-document iframe,[href^="javascript:"]').count(), 0);
  const modes = page.getByRole('group', { name: 'Markdown 预览方式' });
  await modes.getByRole('button', { name: '源码', exact: true }).click();
  await page.locator('.source-code .hljs-section').first().waitFor();
  assert.ok((await page.getByLabel('文件源码', { exact: true }).innerText()).includes('# 文件预览示例'));
  await modes.getByRole('button', { name: '渲染', exact: true }).click();
  await page.locator('.markdown-document').getByRole('link', { name: '下一篇', exact: true }).click();
  await page.getByRole('heading', { name: '本地链接已打开', exact: true }).waitFor();
  await page.locator('.markdown-document').getByRole('link', { name: '返回', exact: true }).click();
  await page.getByRole('heading', { name: '文件预览示例', exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: `test-results/${packaged ? 'packaged-' : ''}files-markdown-dark.png` });
  step('highlight code in a Worker, copy content and refresh external changes');
  await entry('src').click(); await entry('code.ts').click();
  await page.locator('.source-code .hljs-keyword').first().waitFor();
  assert.equal(await page.locator('.source-code code').getAttribute('data-language'), 'typescript');
  await page.getByRole('button', { name: '复制内容', exact: true }).click();
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), code);
  await writeFile(path.join(root, 'src', 'code.ts'), code + '// EXTERNAL_CHANGE_READY\n');
  await page.getByRole('button', { name: '刷新文件预览', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.source-code')?.textContent.includes('EXTERNAL_CHANGE_READY'));
  const resizer = page.getByRole('separator', { name: '调整侧栏宽度', exact: true });
  const before = await page.locator('.sidebar').boundingBox(); await resizer.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(width => document.querySelector('.sidebar').getBoundingClientRect().width > width, before.width);
  await page.keyboard.press('ArrowLeft');
  step('main tabs retain the same terminal DOM and selected file');
  await mainTabs.getByRole('tab', { name: '终端', exact: true }).click();
  assert.equal(await page.evaluate(() => window.originalTerminal === document.querySelector('.terminal-mount .xterm')), true);
  await sideTabs.getByRole('tab', { name: '会话', exact: true }).click();
  await mainTabs.getByRole('tab', { name: '预览', exact: true }).click();
  await page.getByLabel('文件源码', { exact: true }).waitFor();
  assert.equal(await entry('code.ts').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.originalTerminal === document.querySelector('.terminal-mount .xterm')), true);
  await page.screenshot({ animations: 'disabled', path: `test-results/${packaged ? 'packaged-' : ''}files-code-dark.png` });
  await page.getByRole('button', { name: '切换为浅色模式' }).click();
  const gray = await entry('trace.log').evaluate(element => getComputedStyle(element).color);
  const normal = await entry('tracked.log').evaluate(element => getComputedStyle(element).color); assert.notEqual(gray, normal);
  await page.screenshot({ animations: 'disabled', path: `test-results/${packaged ? 'packaged-' : ''}files-code-light.png` });
  await page.getByRole('button', { name: '切换为深色模式' }).click();
  step('fuzzy path picker handles multiple matches, folder reveal and line-column navigation');
  await page.getByRole('button', { name: '查找文件或目录…' }).click();
  let picker = page.getByRole('dialog', { name: '定位文件或目录', exact: true });
  await picker.getByLabel('文件路径或模糊名称').fill('zpage');
  await picker.getByRole('option').first().waitFor();
  assert.ok(await picker.getByRole('option').count() > 1);
  await picker.getByLabel('文件路径或模糊名称').fill('src/code.ts:2:1');
  await picker.getByRole('option', { name: /src\/code.ts/ }).waitFor();
  await picker.getByLabel('文件路径或模糊名称').press('Enter');
  await page.waitForFunction(() => document.querySelector('.source-preview')?.dataset.location === '2:1');
  await page.getByRole('button', { name: '查找文件或目录…' }).click();
  picker = page.getByRole('dialog', { name: '定位文件或目录', exact: true });
  await picker.getByLabel('文件路径或模糊名称').fill('docs');
  await picker.getByRole('option', { name: /docs/ }).waitFor();
  await picker.getByLabel('文件路径或模糊名称').press('Enter');
  await entry('指南.md').waitFor();
  step('Ctrl-click a real terminal path opens the existing preview without restarting the PTY');
  await mainTabs.getByRole('tab', { name: '终端', exact: true }).click();
  const printPath = `node -e "process.stdout.write(String.fromCharCode(27)+'[2J'+String.fromCharCode(27)+'[Hsrc/code.ts:2:1');setInterval(()=>{},1000)"`;
  await page.evaluate(({ id, runId, command }) => window.berth.rpc('input', { sessionId: id, runId, data: command + '\r' }), { id: session.id, runId: run.id, command: printPath });
  await page.waitForTimeout(700);
  const screen = page.locator('[data-testid="terminal"] .xterm-screen');
  const box = await screen.boundingBox();
  const cols = await page.locator('.terminal-mount').getAttribute('data-cols');
  const rows = await page.locator('.terminal-mount').getAttribute('data-rows');
  await page.keyboard.down('Control');
  await page.mouse.move(box.x + box.width / Number(cols) * 4, box.y + box.height / Number(rows) / 2);
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / Number(cols) * 4, box.y + box.height / Number(rows) / 2);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('[aria-label="工作区内容"] [aria-selected="true"]')?.textContent === '预览');
  await page.getByLabel('文件源码', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.originalTerminal === document.querySelector('.terminal-mount .xterm')), true);
  await page.evaluate(({ id, runId }) => window.berth.rpc('input', { sessionId: id, runId, data: '\x03' }), { id: session.id, runId: run.id });
  step('image, empty and binary previews; project changes cannot retain another project file');
  await entry('pixel.png').click(); await page.waitForFunction(() => document.querySelector('.image-preview img')?.naturalWidth === 1);
  await entry('binary.bin').click(); await page.getByText('无法直接预览', { exact: true }).waitFor();
  await entry('empty.txt').click(); await page.getByLabel('文件源码', { exact: true }).waitFor();
  const other = await page.evaluate(root => window.berth.rpc('createProject', { name: '另一个文件项目', path: root }), second);
  await page.getByLabel('文件所属项目', { exact: true }).selectOption(other.id);
  await page.getByText('选择文件预览', { exact: true }).waitFor(); await entry('README.md').click();
  await page.getByRole('heading', { name: '第二个项目', exact: true }).waitFor();
  await page.getByLabel('文件所属项目', { exact: true }).selectOption(project.id);
  await page.getByText('选择文件预览', { exact: true }).waitFor();
  const current = await liveRun(); assert.equal(current.id, run.id); assert.equal(current.pid, run.pid); assert.equal(current.status, 'running');
  await mainTabs.getByRole('tab', { name: '终端', exact: true }).click();
  await sideTabs.getByRole('tab', { name: '会话', exact: true }).click();
  assert.equal(await page.locator('.file-browser').count(), 0); await page.locator('.terminal-mount .xterm').waitFor();
  assert.equal((await liveRun()).pid, run.pid);
  await page.evaluate(id => window.berth.rpc('deleteProject', { projectId: id }), other.id);
  assert.deepEqual(errors, []);
  step('all file preview checks passed');
} catch (error) {
  if (application) {
    const windows = application.windows();
    if (windows[0]) { await windows[0].screenshot({ path: `test-results/${packaged ? 'packaged-' : ''}files-failed.png` }).catch(() => {}); console.error((await windows[0].locator('body').innerText().catch(() => '')).slice(-10000)); }
  }
  throw error;
} finally {
  try { await closeApplication(application); }
  finally {
    if (daemonPid) { try { process.kill(daemonPid, 0); process.kill(daemonPid, 'SIGTERM'); } catch {} }
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}
