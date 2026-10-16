import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installAgentFile } from '../main/plugin-files';
import { AgentPlugins } from '../daemon/plugins';
import { agentDefinitionSchema, nativeSessionIdSchema, type AgentDefinition, type Session } from '../shared/protocol';

export const usage = `用法：node check-plugin.cjs <Agent 配置或脚本> [--project <测试项目>] [--session <原生 ID>] [--file <历史文件>] [--query <搜索词>]
不指定项目时只检查配置和 describe。指定项目后检查声明的 list/history/resume；恢复命令只校验、不执行。
请使用包含至少两条会话的测试项目。分页最多检查 100 条；未执行的能力会明确提示。`;

export async function checkPlugin(args: string[], report: (line: string) => void = console.log): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { report(usage); return; }
  const [file, ...rest] = args;
  if (!file || file.startsWith('--')) throw new Error(usage);
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!['--project', '--session', '--file', '--query'].includes(flag) || !value || value.startsWith('--') || flag in options) throw new Error('参数无效或重复：' + flag + '\n' + usage);
    options[flag] = value;
  }
  if (['--session', '--file', '--query'].some(flag => flag in options) && !options['--project']) throw new Error('检查历史、恢复或搜索时请提供 --project 测试项目');
  if (options['--session']) nativeSessionIdSchema.parse(options['--session']);
  const query = options['--query']?.trim() ?? '';
  if (query.length > 100) throw new Error('搜索词不能超过 100 字符');
  const project = options['--project'] ? await realpath(path.resolve(options['--project'])) : null;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'berth-plugin-check-'));
  const plugins = new AgentPlugins();
  let checks = 0, skipped = 0;
  const pass = (message: string) => { checks++; report('通过：' + message); };
  const skip = (message: string) => { skipped++; report('未检查：' + message); };
  try {
    const config = agentDefinitionSchema.parse(await installAgentFile(path.resolve(file), temporary, plugins));
    const agent: AgentDefinition = { id: 'agent:' + randomUUID(), ...config };
    if (!agent.plugin) {
      pass('JSON 启动配置与恢复模板');
      report('配置检查完成（无插件接口）。');
      return;
    }
    await plugins.check(agent);
    pass('describe、稳定 ID 和声明能力');
    if (!project) {
      if (agent.plugin.list || agent.plugin.history || agent.plugin.resume) skip('list/history/resume；添加 --project 测试项目后检查实际记录');
    } else {
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), projectId: randomUUID(), title: 'Plugin check', agent: agent.id, command: agent.command, nativeSessionId: options['--session'] ?? null, terminal: null, createdAt: now, updatedAt: now, transcriptPath: null, latestRun: null };
      const ids = new Set<string>();
      if (agent.plugin.list) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let firstPage: string[] = [];
        for (let page = 1; ; page++) {
          const result = await plugins.list(agent, session, project, { cursor, limit: 5, query });
          if (page === 1) firstPage = result.items.map(item => item.nativeSessionId);
          for (const item of result.items) {
            if (ids.has(item.nativeSessionId)) throw new Error('list 跨页重复会话 ID，请按稳定排序生成游标');
            ids.add(item.nativeSessionId);
          }
          if (!result.nextCursor) { pass(`list 项目、分页与 ID 去重（${page} 页，${ids.size} 条）`); break; }
          if (cursors.has(result.nextCursor)) throw new Error('list 游标循环，请让下一页游标持续向前推进');
          if (page >= 20) throw new Error('list 检查超过 100 条，请缩小测试项目或使用 --query');
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        if (ids.size) {
          const linked = { ...session, nativeSessionId: session.nativeSessionId ? null : [...ids][0] };
          const result = await plugins.list(agent, linked, project, { cursor: null, limit: 5, query });
          if (JSON.stringify(result.items.map(item => item.nativeSessionId)) !== JSON.stringify(firstPage)) throw new Error('list 随当前关联 ID 改变，请列出项目全部会话，不要只返回当前关联的一条');
          pass('list 在关联/未关联时保持完整会话列表');
        }
        if (ids.size < 2) skip('多会话隔离；测试项目至少需要两条匹配记录');
      }
      // An explicit ID is checked as well as two discovered IDs, never just the linked one.
      const targets = [...new Set([...(options['--session'] ? [options['--session']] : []), ...[...ids].slice(0, 2)])];
      if (agent.plugin.history) {
        if (options['--file']) {
          await plugins.history(agent, session, project, path.resolve(options['--file']));
          pass('指定文件的 history 结构、项目和文本限制');
        }
        for (const id of targets) {
          await plugins.history(agent, { ...session, nativeSessionId: id }, project, null);
          pass('history 按选中 ID 读取、项目和文本限制');
        }
        if (!targets.length && !options['--file']) skip('history；提供 --session、--file，或让 list 返回测试记录');
      }
      if (agent.plugin.resume || agent.resumeCommand) {
        for (const id of targets) {
          await plugins.resume(agent, { ...session, nativeSessionId: id }, project);
          pass('resume 返回合法单行命令（未执行）');
        }
        if (!targets.length) skip('resume；提供 --session 或让 list 返回测试记录');
      }
    }
    report(`检查完成：${checks} 项通过，${skipped} 项未检查。此工具不验证真实 CLI 兼容性、界面或热更新，请继续完成开发指南中的验收。`);
  } finally {
    await plugins.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}
