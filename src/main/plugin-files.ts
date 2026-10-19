import { readFile, realpath, stat, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { agentConfigFileSchema, pluginManifestSchema } from '../shared/plugin-manifest';
import { AgentPlugins } from '../daemon/plugins';
import type { AgentDefinitionConfig } from '../shared/protocol';

const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
export async function installPluginManifest(file: string, dataDirectory: string): Promise<AgentDefinitionConfig> {
  const canonical = await realpath(file);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 65536) throw new Error('Agent 配置须为小于 64 KiB 的 JSON');
  let parsed: unknown;
  try { parsed = JSON.parse((await readFile(canonical, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error('Agent 配置不是有效 JSON，请重新选择配置文件'); }
  const config = agentConfigFileSchema.safeParse(parsed);
  if (config.success) return { sourceId: config.data.id, name: config.data.name, command: config.data.command, resumeCommand: config.data.resumeCommand, plugin: null };
  const result = pluginManifestSchema.safeParse(parsed);
  if (!result.success) throw new Error('插件说明格式不正确，请让开发 Agent 按开发指南检查 schemaVersion、启动命令、入口文件和能力声明');
  const manifest = result.data;
  const root = path.dirname(canonical);
  const files = [...new Set([manifest.entry, ...manifest.files])];
  const sources: { relative: string; source: string; size: number }[] = [];
  let total = 0;
  for (const relative of files) {
    let source: string;
    try { source = await realpath(path.resolve(root, relative.replaceAll('\\', '/'))); }
    catch { throw new Error(`插件缺少资源文件 ${relative}，请重新导入完整插件目录中的清单`); }
    if (!within(root, source)) throw new Error('插件文件不能指向插件目录外');
    const meta = await stat(source);
    if (!meta.isFile() || meta.size > 16 * 1024 * 1024) throw new Error('插件资源须为不超过 16 MiB 的文件');
    total += meta.size;
    if (total > 32 * 1024 * 1024) throw new Error('插件资源合计不能超过 32 MiB');
    sources.push({ relative, source, size: meta.size });
  }
  const pluginDirectory = path.join(dataDirectory, 'plugins');
  await mkdir(pluginDirectory, { recursive: true });
  const destination = path.join(await realpath(pluginDirectory), randomUUID());
  try {
    await mkdir(destination, { recursive: true });
    for (const item of sources) {
      const target = path.join(destination, item.relative.replaceAll('\\', '/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(item.source, target, constants.COPYFILE_EXCL);
      if ((await stat(target)).size !== item.size) throw new Error('插件文件在导入期间发生变化，请重新导入');
    }
    const executable = path.join(destination, manifest.entry.replaceAll('\\', '/'));
    return { sourceId: manifest.id, name: manifest.name, command: manifest.command, resumeCommand: manifest.resumeCommand, plugin: { runtime: manifest.runtime, sourceId: manifest.id, executable, args: manifest.args.map(arg => arg.replaceAll('{pluginDir}', destination)), ...manifest.capabilities } };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

export async function installAgentFile(file: string, dataDirectory: string, runner?: AgentPlugins): Promise<AgentDefinitionConfig> {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') return installPluginManifest(file, dataDirectory);
  if (!['.cjs', '.mjs', '.js'].includes(extension)) throw new Error('请选择 Agent 的 JSON 配置或 JS/CJS/MJS 脚本');
  const canonical = await realpath(file);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Agent 脚本须为不超过 16 MiB 的文件');
  const directory = path.join(dataDirectory, 'plugins');
  await mkdir(directory, { recursive: true });
  const destination = path.join(await realpath(directory), randomUUID());
  const plugins = runner ?? new AgentPlugins();
  try {
    await mkdir(destination);
    const executable = path.join(destination, 'agent' + extension);
    await copyFile(canonical, executable, constants.COPYFILE_EXCL);
    if ((await stat(executable)).size !== info.size) throw new Error('Agent 文件在导入期间发生变化，请重新导入');
    const plugin = { runtime: 'node' as const, executable, args: [], history: false, resume: false };
    const description = await plugins.describe({ id: 'agent:' + randomUUID(), name: 'Agent', command: 'agent', resumeCommand: '', plugin });
    if (!description.id || !description.command) throw new Error('脚本须在 describe 中提供 id、name、command 和 capabilities，请让开发 Agent 按指南补齐后重新导入');
    return { sourceId: description.id, name: description.name, command: description.command, resumeCommand: description.resumeCommand ?? '', plugin: { ...plugin, sourceId: description.id, ...description.capabilities } };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  finally { if (!runner) await plugins.close(); }
}

export async function exportPluginKit(directory: string, resourceRoot: string, checkerFile = path.join(resourceRoot, 'dist', 'check-plugin.cjs')): Promise<string> {
  const destination = await mkdtemp(path.join(await realpath(directory), 'agentberth-plugin-'));
  try {
    for (const name of ['agent.json', 'agentberth-plugin.json', 'plugin.cjs']) await copyFile(path.join(resourceRoot, 'examples', 'plugin-template', name), path.join(destination, name));
    await copyFile(path.join(resourceRoot, 'docs', 'AGENT_PLUGIN_DEVELOPMENT.md'), path.join(destination, 'AGENT_PLUGIN_DEVELOPMENT.md'));
    await copyFile(checkerFile, path.join(destination, 'check-plugin.cjs'));
    return destination;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
export function developmentPrompt(guide: string, folder?: string): string {
  return `请为我的 Agent CLI 制作 StackIsle 可导入文件。先询问我要适配的 CLI、启动命令，以及原生历史／恢复的需求。${folder ? `\n开发目录：${folder}\n请先读取该目录的 AGENT_PLUGIN_DEVELOPMENT.md 和模板，直接在此目录完成实现。交付前使用同目录 check-plugin.cjs 检查协议，并用含多条会话的测试项目检查分页、按 ID 读取和恢复格式；工具不需要 npm install。` : '\n下面是完整开发指南，请按此指南交付一个可导入的文件。'}\n要求：仅启动时交付 JSON 配置；需要历史／恢复时优先交付单个自描述脚本，describe 提供 id、name、command 和 capabilities。用户只需导入配置文件或脚本、设置名称、保存，不能要求启用扩展、找 Node 路径或手写参数；有额外资源时才使用清单目录。需要多会话历史时实现可选 list，按项目分页、搜索；不得按当前关联 ID 把列表过滤成一条，history 必须按选中 ID 读取。实现并测试预览、运行中关联和解除关联。只实现实际需要的能力。不要记录 TUI 屏幕或使用终端输出冒充对话历史。不得替用户登录或执行真实 Agent 命令。完成后运行指南中的测试，明确未检查的能力，说明导入文件位置。\n\n${guide}`;
}
