import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { openPromise } from 'yauzl';
import type { PdfTextExtractor } from './pdf';
import type { WikiSource } from './types';

export const sourceIdPattern = /^[a-f0-9-]{36}$/;
const types: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
export const sourceMime = (name: string): string | undefined => types[path.posix.extname(name).toLowerCase()];

export function validSourcePath(name: string): boolean {
  return Buffer.byteLength(name) <= 600 && name.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 240 &&
    !/[\\\x00-\x1f\x7f<>:"|?*]|[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

export function sourceReference(id: string, name: string): string {
  return 'wiki-source:' + id + '/' + name.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

function imageSignature(bytes: Uint8Array, mime: string): boolean {
  const head = Buffer.from(bytes.subarray(0, 12));
  switch (mime) {
    case 'image/png': return head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/jpeg': return head.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6));
    case 'image/webp': return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
    default: return false;
  }
}

const zipByteBudget = 4 * 1024 ** 3;
const zipEntryBudget = 10000;

async function unpackZip(file: string, root: string, signal: AbortSignal): Promise<{ names: string[]; folders: string[] }> {
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
  const entries = new Map<string, { name: string; directory: boolean }>(), names: string[] = [];
  let total = 0;
  const register = (name: string, directory: boolean) => {
    const key = name.normalize('NFC').toLowerCase(), previous = entries.get(key);
    if (previous && (previous.name !== name || previous.directory !== directory || !directory)) throw new Error('ZIP 中存在重名或路径冲突：' + name);
    entries.set(key, { name, directory });
  };
  const explicit = new Set<string>();
  try {
    if (zip.entryCount > zipEntryBudget) throw new Error('ZIP 条目超过 10,000 个');
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const directory = entry.fileName.endsWith('/'), name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      if (!validSourcePath(name) || explicit.has(name)) throw new Error('ZIP 中存在无效或重复路径：' + name);
      explicit.add(name);
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (unixType && unixType !== (directory ? 0o040000 : 0o100000)) throw new Error('ZIP 包含链接或特殊文件：' + name);
      if ((total += entry.uncompressedSize) > zipByteBudget) throw new Error('ZIP 展开超过 4 GiB');
      for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) register(parent, true);
      register(name, directory);
      const dest = path.join(root, name);
      if (directory) { await mkdir(dest, { recursive: true, mode: 0o700 }); continue; }
      if (!sourceMime(name)) throw new Error('ZIP 中的文件类型不受支持：' + name);
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      let checksum = 0;
      const check = new Transform({ transform(chunk: Buffer, _, next) { checksum = crc32(chunk, checksum); next(null, chunk); } });
      await pipeline(await zip.openReadStreamPromise(entry), check, createWriteStream(dest, { flags: 'wx', mode: 0o600 }), { signal });
      if (checksum !== entry.crc32) throw new Error('ZIP 文件校验失败：' + name);
      names.push(name);
    }
  } finally { zip.close(); }
  return { names, folders: [...entries.values()].filter(entry => entry.directory).map(entry => entry.name).sort() };
}

export async function prepareSourceDirectory(
  root: string, file: string, filename: string, pdf: PdfTextExtractor, signal: AbortSignal, progress: (name: string) => void, supplement = '',
): Promise<Pick<WikiSource, 'directory' | 'parts' | 'text'>> {
  let names: string[], folders: string[];
  if (/\.zip$/i.test(filename)) {
    ({ names, folders } = await unpackZip(file, root, signal));
  } else {
    if (filename.includes('/') || !validSourcePath(filename) || !sourceMime(filename)) throw new Error('请选择 ZIP、Markdown、文本、PDF 或图片文件');
    await copyFile(file, path.join(root, filename));
    names = [filename]; folders = [];
  }
  if (!names.length) throw new Error('ZIP 中没有可导入的文件');
  if (supplement.trim()) {
    const occupied = new Set([...names, ...folders].map(name => name.normalize('NFC').toLowerCase()));
    let name = '补充正文.md';
    for (let i = 2; occupied.has(name); i++) name = '补充正文-' + i + '.md';
    await writeFile(path.join(root, name), supplement, { flag: 'wx', mode: 0o600, signal });
    names.unshift(name);
  }
  const parts: NonNullable<WikiSource['parts']> = [], text: string[] = [];
  let offset = 0;
  for (const name of names) {
    signal.throwIfAborted();
    progress(name);
    const filename = path.join(root, name), mime = sourceMime(name)!;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
    const { size } = await stat(filename);
    const kind = mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : 'text';
    let content = '', pages: number | undefined, ranges: NonNullable<WikiSource['parts']>[number]['ranges'];
    if (kind === 'image') {
      const stream = createReadStream(filename, { end: 11, signal });
      let prefix = Buffer.alloc(0);
      for await (const chunk of stream) prefix = Buffer.concat([prefix, chunk]);
      if (!imageSignature(prefix, mime)) throw new Error('图片格式与文件名不符：' + name);
    } else {
      const bytes = await readFile(filename, { signal });
      if (kind === 'pdf') {
        ({ text: content, pages, ranges } = await pdf(new Uint8Array(bytes)));
      } else {
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('文本文件须使用 UTF-8：' + name); }
      }
    }
    signal.throwIfAborted();
    if (content && text.length) offset += 2;
    parts.push({ id: randomUUID(), name, kind, size, hash: hash.digest('hex'), start: offset, end: offset + content.length, pages, ranges });
    if (content) { text.push(content); offset += content.length; }
  }
  return { directory: folders, parts, text: text.join('\n\n') };
}

export function directoryPage(source: WikiSource, directory = '', offset = 0, limit = 25) {
  if (!source.directory) throw new Error('此素材没有原始文件目录');
  if (directory && !source.directory.includes(directory)) throw new Error('素材目录不存在');
  const parent = directory || '.';
  const items = [
    ...source.directory.filter(name => path.posix.dirname(name) === parent).map(name => ({ name, kind: 'directory' as const })),
    ...(source.parts ?? []).filter(part => path.posix.dirname(part.name) === parent).map(({ name, kind, size, pages }) => ({ name, kind, size, pages })),
  ].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  const selected = items.slice(offset, offset + limit), next = offset + selected.length;
  return { directory, items: selected, next, total: items.length, hasMore: next < items.length };
}
