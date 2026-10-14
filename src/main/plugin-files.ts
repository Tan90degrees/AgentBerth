import { readFile, realpath, stat, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pluginManifestSchema } from '../shared/plugin-manifest';
import type { AgentDefinitionConfig } from '../shared/protocol';

const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
export async function installPluginManifest(file: string, dataDirectory: string): Promise<AgentDefinitionConfig> {
  const canonical = await realpath(file);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 65536) throw new Error('插件说明文件须为小于 64 KiB 的 JSON');
  let parsed: unknown;
  try { parsed = JSON.parse((await readFile(canonical, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error('插件文件不是有效 JSON，请选择 agentberth-plugin.json'); }
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
    return { name: manifest.name, command: manifest.command, resumeCommand: manifest.resumeCommand, plugin: { runtime: manifest.runtime, sourceId: manifest.id, executable, args: manifest.args.map(arg => arg.replaceAll('{pluginDir}', destination)), ...manifest.capabilities } };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

export async function exportPluginKit(directory: string, resourceRoot: string): Promise<string> {
  const destination = await mkdtemp(path.join(await realpath(directory), 'agentberth-plugin-'));
  try {
    for (const name of ['agentberth-plugin.json', 'plugin.cjs']) await copyFile(path.join(resourceRoot, 'examples', 'plugin-template', name), path.join(destination, name));
    await copyFile(path.join(resourceRoot, 'docs', 'AGENT_PLUGIN_DEVELOPMENT.md'), path.join(destination, 'AGENT_PLUGIN_DEVELOPMENT.md'));
    return destination;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
export function developmentPrompt(guide: string, folder?: string): string {
  return `请为我的 Agent CLI 开发 AgentBerth 插件。先询问我要适配的 CLI、启动命令，以及原生历史／恢复的需求。${folder ? `\n开发目录：${folder}\n请先读取该目录的 AGENT_PLUGIN_DEVELOPMENT.md、agentberth-plugin.json 和 plugin.cjs，直接在此目录完成实现。` : '\n下面是完整开发指南，请按此指南输出一个可导入的插件目录。'}\n要求：用户只需导入 agentberth-plugin.json，不能要求用户找 Node 路径或手写 JSON 参数；必须提供 describe 自检与自动发现历史。不要记录 TUI 屏幕或使用终端输出冒充对话历史。不得替用户登录或执行真实 Agent 命令。完成后运行指南中的测试，说明导入文件位置。\n\n${guide}`;
}
