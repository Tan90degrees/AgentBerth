import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportPluginKit } from '../src/main/plugin-files';

const execute = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'berth 检查 '));
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5 }));
  const kit = await exportPluginKit(folder, path.resolve('.'));
  const project = path.join(folder, '测试项目');
  await mkdir(path.join(project, 'agent-sessions'), { recursive: true });
  for (let index = 0; index < 12; index++) await writeFile(path.join(project, 'agent-sessions', index + '.json'), JSON.stringify({ cwd: project, nativeSessionId: 'native-' + index, title: '中文记录 ' + index, messages: [{ role: 'user', text: '中文🙂' }] }));
  const run = (...args: string[]) => execute(process.execPath, [path.join(kit, 'check-plugin.cjs'), ...args], { cwd: folder, timeout: 20000, maxBuffer: 128 * 1024, windowsHide: true });
  return { kit, project, run };
}

test('exported standalone checker validates real multi-page history with no node_modules and never executes resume commands', { timeout: 25000 }, async t => {
  const { kit, project, run } = await fixture(t);
  const script = path.join(kit, 'plugin.cjs');
  // A valid command with a visible side effect would create this file if accidentally executed.
  const marker = path.join(project, 'RESUME_MUST_NOT_RUN');
  await writeFile(script, (await readFile(script, 'utf8')).replace("command:'my-agent'", "command:" + JSON.stringify(`echo MUST_NOT_RUN > "${marker}"`)));
  const result = await run(script, '--project', project, '--session', 'native-0');
  assert.match(result.stdout, /3 页，12 条/);
  assert.match(result.stdout, /关联\/未关联时保持完整/);
  assert.match(result.stdout, /0 项未检查/);
  assert.equal((result.stdout.match(/history 按选中 ID/g) ?? []).length >= 2, true);
  assert.match(result.stdout, /未执行/);
  await assert.rejects(readFile(marker), /ENOENT/);
  assert.equal(JSON.parse(await readFile(path.join(project, 'agent-sessions', '0.json'), 'utf8')).messages[0].text, '中文🙂');
  const search = await run(script, '--project', project, '--query', '中文记录 1');
  assert.match(search.stdout, /3 条/);
});

test('checker rejects duplicate pages and lists filtered to only the current association', { timeout: 25000 }, async t => {
  const { kit, project, run } = await fixture(t);
  const script = path.join(kit, 'plugin.cjs');
  const original = await readFile(script, 'utf8');
  await writeFile(script, original.replace('const page = items.slice(offset,offset+limit), last = page.at(-1);', 'const page = items.slice(0,limit), last = items[Math.min(items.length-1,offset+limit-1)];'));
  await assert.rejects(run(script, '--project', project), (error: any) => { assert.match(error.stderr, /跨页重复会话 ID/); return true; });
  await writeFile(script, original.replace('const all = await catalog(request.projectPath);', 'const all = await catalog(request.projectPath);if(request.session.nativeSessionId)all.items=all.items.filter(item=>item.nativeSessionId===request.session.nativeSessionId);'));
  await assert.rejects(run(script, '--project', project), (error: any) => { assert.match(error.stderr, /list 随当前关联 ID 改变/); return true; });
});

test('checker rejects history ignoring the selected ID and manifest/describe identity mismatch', { timeout: 25000 }, async t => {
  const { kit, project, run } = await fixture(t);
  const script = path.join(kit, 'plugin.cjs');
  const original = await readFile(script, 'utf8');
  await writeFile(script, original.replace('nativeSessionId:data.nativeSessionId,path:file,messages', "nativeSessionId:'wrong-id',path:file,messages"));
  await assert.rejects(run(script, '--project', project), (error: any) => { assert.match(error.stderr, /会话 ID 与已关联会话不一致/); return true; });
  await writeFile(script, original.replace("id:'my-agent'", "id:'different-agent'"));
  await assert.rejects(run(path.join(kit, 'agentberth-plugin.json')), (error: any) => { assert.match(error.stderr, /ID 与配置不一致/); return true; });
});

test('checker gives explicit partial results and validates arguments before running plugin code', { timeout: 25000 }, async t => {
  const { kit, run } = await fixture(t);
  const script = path.join(kit, 'plugin.cjs');
  assert.match((await run('--help')).stdout, /用法/);
  assert.match((await run(path.join(kit, 'agent.json'))).stdout, /无插件接口/);
  assert.match((await run(script)).stdout, /未检查：list\/history\/resume/);
  await writeFile(script, 'throw new Error("PLUGIN_SHOULD_NOT_RUN");');
  await assert.rejects(run(script, '--unknown', 'value'), (error: any) => { assert.match(error.stderr, /参数无效/); assert.doesNotMatch(error.stderr, /PLUGIN_SHOULD_NOT_RUN/); return true; });
});
