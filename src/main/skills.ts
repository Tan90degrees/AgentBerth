import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import { skillRequestSchema, type AgentSkills, type SkillPage, type SkillRequest, type SkillItem } from '../shared/skills';

export function skillRoot(skills: AgentSkills, projectPath?: string, home = homedir()): string {
  const template = projectPath ? skills.project : skills.user;
  if (!template) throw new Error('此 Agent 插件未提供当前范围的 Skill 目录');
  const root = projectPath ? path.resolve(projectPath, template.replaceAll('\\', '/')) : /^~[\\/]/.test(template) ? path.resolve(home, template.slice(2)) : template;
  if (!path.isAbsolute(root)) throw new Error('插件提供的 Skill 目录不是绝对路径');
  return root;
}
export function skillMetadata(content: string): { name: string; description: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('SKILL.md 缺少 YAML 头部（name、description）');
  const value = load(match[1], { schema: JSON_SCHEMA });
  if (!value || typeof value !== 'object' || !('name' in value) || !('description' in value)) throw new Error('请填写 name 和 description');
  const { name, description } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error('Skill 名称须为小写字母、数字和横线，最多 64 字符');
  if (typeof description !== 'string' || !description.trim() || description.length > 4096) throw new Error('Skill description 须为 1–4096 字符文本');
  return { name, description };
}
async function exists(file: string) { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function boundedRead(file: string) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 262144) throw new Error('SKILL.md 须为不超过 256 KiB 的普通文件');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 262144) throw new Error('SKILL.md 过大');
  return text;
}
export class SkillManager {
  private pending = new Map<string, Promise<unknown>>();
  async run(root: string, input: SkillRequest): Promise<SkillPage | { content: string }> {
    const request = skillRequestSchema.parse(input);
    if (!path.isAbsolute(root)) throw new Error('Skill 目录必须是绝对路径');
    // Serialize reads and mutations of the same root, including two renderer windows.
    const prior = this.pending.get(root) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.perform(path.resolve(root), request));
    this.pending.set(root, task);
    try { return await task; } finally { if (this.pending.get(root) === task) this.pending.delete(root); }
  }
  private async target(root: string, folder: string, enabled: boolean): Promise<string> {
    const base = enabled ? root : root + '.agentberth-disabled';
    const target = path.join(base, folder);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('链接目录仅供查看，请在来源位置管理');
    if (await realpath(base) !== path.dirname(await realpath(target))) throw new Error('Skill 不在所选目录中');
    return target;
  }
  private async perform(root: string, request: SkillRequest): Promise<SkillPage | { content: string }> {
    if (request.action === 'list') return this.list(root);
    if (request.action === 'import') {
      const source = await realpath(request.source);
      if (!(await lstat(source)).isDirectory()) throw new Error('请选择含 SKILL.md 的文件夹');
      const meta = skillMetadata(await boundedRead(path.join(source, 'SKILL.md')));
      await mkdir(root, { recursive: true });
      const canonicalRoot = await realpath(root);
      if (canonicalRoot === source || canonicalRoot.startsWith(source + path.sep)) throw new Error('不能把目录导入自身或子目录');
      const destination = path.join(root, meta.name);
      if (await exists(destination) || await exists(path.join(root + '.agentberth-disabled', meta.name))) throw new Error('同名 Skill 已存在，请先检查并移除旧版本');
      const stage = path.join(path.dirname(root), '.agentberth-skill-' + randomUUID());
      let bytes = 0, files = 0;
      const copy = async (from: string, to: string, depth: number) => {
        if (depth > 12) throw new Error('Skill 目录层级过深');
        await mkdir(to, { recursive: true });
        for (const entry of await readdir(from, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const sourceFile = path.join(from, entry.name), targetFile = path.join(to, entry.name), info = await lstat(sourceFile);
          if (info.isSymbolicLink()) throw new Error('导入包不能包含符号链接，请导入实际文件');
          if (++files > 512) throw new Error('Skill 最多包含 512 个目录项');
          if (info.isDirectory()) await copy(sourceFile, targetFile, depth + 1);
          else if (info.isFile()) { bytes += info.size; if (bytes > 16 * 1024 * 1024) throw new Error('Skill 总大小不能超过 16 MiB'); await copyFile(sourceFile, targetFile); }
          else throw new Error('Skill 含不支持的文件类型');
        }
      };
      try { await copy(source, stage, 0); skillMetadata(await boundedRead(path.join(stage, 'SKILL.md'))); await rename(stage, destination); }
      finally { await rm(stage, { recursive: true, force: true }); }
    } else {
      const target = await this.target(root, request.name, request.enabled);
      if (request.action === 'read') return { content: await boundedRead(path.join(target, 'SKILL.md')) };
      if (request.action === 'toggle') {
        const base = request.enabled ? root + '.agentberth-disabled' : root;
        await mkdir(base, { recursive: true });
        const destination = path.join(base, request.name);
        if (await exists(destination)) throw new Error('目标已有同名 Skill，未覆盖');
        await rename(target, destination);
      } else if (request.action === 'remove') {
        const trash = root + '.agentberth-trash'; await mkdir(trash, { recursive: true });
        await rename(target, path.join(trash, request.name + '-' + randomUUID()));
      } else {
        const meta = skillMetadata(request.content), original = skillMetadata(await boundedRead(path.join(target, 'SKILL.md')));
        if (meta.name !== original.name) throw new Error('编辑时不能修改 Skill 名称，请另行导入');
        const temp = path.join(target, '.SKILL-' + randomUUID());
        try { await writeFile(temp, request.content, { flag: 'wx' }); await rename(temp, path.join(target, 'SKILL.md')); }
        finally { await rm(temp, { force: true }); }
      }
    }
    return this.list(root);
  }
  private async list(root: string): Promise<SkillPage> {
    const items: SkillItem[] = [], warnings: string[] = [];
    for (const [base, enabled] of [[root, true], [root + '.agentberth-disabled', false]] as const) {
      let entries;
      try { entries = await readdir(base, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('目录无法读取：' + base); continue; }
      if (entries.length > 500) warnings.push('目录过大，仅显示前 500 项');
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0, 500)) {
        if (entry.name.startsWith('.') || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const folder = path.join(base, entry.name);
        try {
          const meta = skillMetadata(await boundedRead(path.join(folder, 'SKILL.md')));
          items.push({ ...meta, folder: entry.name, enabled, path: folder, linked: entry.isSymbolicLink() });
        } catch (error) { items.push({ folder: entry.name, name: entry.name, description: '', enabled, path: folder, error: String(error).replace(/^Error: /, ''), linked: entry.isSymbolicLink() }); }
      }
    }
    return { root, items, warnings };
  }
}
