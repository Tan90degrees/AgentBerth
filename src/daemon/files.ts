import { open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { FilePreview, ProjectFile, ProjectFilePage } from '../shared/protocol';
import { parseFileLocation, fileMatchScore } from '../shared/file-navigation';
import { GitWorkspace } from './git';

export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 10000;
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

export async function projectFilePath(root: string, input: string): Promise<{ root: string; absolute: string; relative: string }> {
  if (input.includes('\0') || path.isAbsolute(input) || path.win32.isAbsolute(input)) throw new Error('只能浏览当前项目中的相对路径');
  const relative = input.replaceAll('\\', '/');
  if (relative && relative.split('/').some(part => !part || part === '.' || part === '..' || (process.platform === 'win32' && part.includes(':')))) throw new Error('文件路径无效');
  const canonicalRoot = await realpath(root);
  const absolute = await realpath(path.resolve(canonicalRoot, relative));
  if (!inside(canonicalRoot, absolute)) throw new Error('此链接指向项目目录之外，无法在工作台中预览');
  return { root: canonicalRoot, absolute, relative };
}

export class ProjectFiles {
  private pending = 0;
  constructor(private git: GitWorkspace) {}

  private async read<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending >= 8) throw new Error('文件请求较多，请稍后重试');
    this.pending++;
    try { return await task(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('文件或目录已移动，请刷新目录树');
      if (code === 'EACCES' || code === 'EPERM') throw new Error('无法读取此文件或目录，请检查访问权限');
      throw error;
    } finally { this.pending--; }
  }

  list(root: string, input = '', offset = 0, limit = 200): Promise<ProjectFilePage> {
    return this.read(async () => {
      const target = await projectFilePath(root, input);
      const rows: Dirent[] = [];
      let truncated = false;
      for await (const entry of await opendir(target.absolute)) {
        if (rows.length === MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        rows.push(entry);
      }
      rows.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name));
      const entries: ProjectFile[] = await Promise.all(rows.slice(offset, offset + limit).map(async row => {
        const relative = [target.relative, row.name].filter(Boolean).join('/');
        let kind: ProjectFile['kind'] = row.isDirectory() ? 'directory' : row.isFile() ? 'file' : 'other';
        let unavailable = false;
        if (row.isSymbolicLink()) {
          try {
            const resolved = await projectFilePath(target.root, relative);
            const info = await stat(resolved.absolute);
            kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
          } catch { unavailable = true; }
        }
        return { name: row.name, path: relative, kind, ignored: false, symlink: row.isSymbolicLink(), ...(unavailable ? { unavailable } : {}) };
      }));
      const ignored = await this.git.ignored(path.resolve(target.root, target.relative), entries.map(entry => entry.name + (entry.kind === 'directory' ? '/' : '')));
      for (const entry of entries) entry.ignored = ignored.paths.has(entry.name);
      return { path: target.relative, entries, nextOffset: offset + limit < rows.length ? offset + limit : null, total: rows.length, truncated, gitAvailable: ignored.available, warning: ignored.warning };
    });
  }

  search(root: string, query: string): Promise<{ matches: ProjectFile[]; truncated: boolean; line?: number; column?: number }> {
    return this.read(async () => {
      const location = parseFileLocation(query);
      const canonicalRoot = await realpath(root);
      let input = location.path.replaceAll('\\', '/');
      if (path.isAbsolute(input) || path.win32.isAbsolute(input)) {
        // Resolve Windows 8.3 names and directory aliases before comparing roots.
        // Missing leaf names can still be fuzzy matched through their nearest
        // existing parent, without allowing an outside symlink into the search.
        let absolute = path.resolve(input);
        const missing: string[] = [];
        for (let depth = 0; depth < 64; depth++) {
          try { absolute = path.resolve(await realpath(absolute), ...missing); break; }
          catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            const parent = path.dirname(absolute);
            if (parent === absolute || depth === 63) throw new Error('无法定位此路径，请使用项目内的相对路径');
            missing.unshift(path.basename(absolute)); absolute = parent;
          }
        }
        if (!inside(canonicalRoot, absolute)) throw new Error('此路径位于当前项目之外，请切换到对应项目');
        input = path.relative(canonicalRoot, absolute).replaceAll('\\', '/');
      }
      input = input.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
      if (input.split('/').includes('..') || input.includes('\0')) throw new Error('只能定位当前项目中的文件');
      const { line, column } = location;
      try {
        const exact = await projectFilePath(canonicalRoot, input), info = await stat(exact.absolute);
        if (info.isFile() || info.isDirectory()) return { matches: [{ name: path.basename(input) || path.basename(root), path: input, kind: info.isDirectory() ? 'directory' : 'file', symlink: false, ignored: false }], truncated: false, line, column };
      } catch (error) { if (String(error).includes('项目目录之外')) throw error; }
      if (!input) return { matches: [], truncated: false };
      const queue = [''], matches: { entry: ProjectFile; score: number }[] = [];
      const skip = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'dist', 'release', 'build', '.next', 'target']);
      let visited = 0, truncated = false;
      const deadline = Date.now() + 1500;
      while (queue.length) {
        const directory = queue.shift()!;
        try {
          for await (const entry of await opendir(path.join(canonicalRoot, directory))) {
            if (++visited > 20000 || Date.now() > deadline) { truncated = true; break; }
            if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || skip.has(entry.name)) continue;
            const relative = [directory, entry.name].filter(Boolean).join('/');
            const score = fileMatchScore(relative, input);
            if (score >= 0) matches.push({ score, entry: { name: entry.name, path: relative, kind: entry.isDirectory() ? 'directory' : 'file', symlink: false, ignored: false } });
            if (entry.isDirectory()) queue.push(relative);
          }
        } catch { /* Unreadable subdirectories do not block navigation. */ }
        if (truncated) break;
      }
      matches.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
      return { matches: matches.slice(0, 80).map(item => item.entry), truncated: truncated || matches.length > 80, line, column };
    });
  }

  preview(root: string, input: string): Promise<FilePreview> {
    return this.read(async () => {
      const target = await projectFilePath(root, input);
      if (!(await stat(target.absolute)).isFile()) throw new Error('请选择普通文件进行预览');
      const file = await open(target.absolute, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error('请选择普通文件进行预览');
        const mime = imageTypes[path.extname(input).toLowerCase()];
        const result: FilePreview = { path: target.relative, name: path.basename(target.relative), size: info.size, modifiedAt: info.mtime.toISOString(), kind: 'binary', content: null, truncated: false };
        if (mime && info.size > MAX_IMAGE_BYTES) return { ...result, message: '图片超过 4 MB，暂不加载预览。' };
        const maximum = mime ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
        const buffer = Buffer.alloc(Math.min(info.size, maximum));
        let length = 0;
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        if (mime) return { ...result, kind: 'image', content: `data:${mime};base64,${bytes.toString('base64')}`, mime };
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
        if (encoding === 'utf-8' && bytes.includes(0)) return result;
        let truncated = info.size > bytes.length;
        let text: string;
        try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }); }
        catch { return result; }
        const lines = text.split('\n', 10001);
        if (lines.length > 10000) { text = lines.slice(0, 10000).join('\n'); truncated = true; }
        return { ...result, kind: 'text', content: text, truncated, encoding };
      } finally { await file.close(); }
    });
  }
}
