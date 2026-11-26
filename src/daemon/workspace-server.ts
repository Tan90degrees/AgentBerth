import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_WORKSPACE_SERVER_PORT, serverTokenPattern, type WorkspaceDirectoryPage } from '../shared/workspace-server';

export interface WorkspaceServerOptions {
  host: string;
  port: number;
  token: string;
  tls?: { key: Buffer; cert: Buffer };
}

export function readWorkspaceServerToken(dataDirectory: string, create = false): string {
  const file = path.join(dataDirectory, 'server-token');
  if (create) {
    try { writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(file);
  if (!info.isFile() || info.size !== 65 || (info.mode & 0o077) !== 0) throw new Error('server-token 必须是权限为 600 的普通文件');
  const token = readFileSync(file, 'utf8').trim();
  if (!serverTokenPattern.test(token)) throw new Error('server-token 格式无效');
  return token;
}

export function workspaceServerOptions(dataDirectory: string, options: Record<string, string | undefined>): WorkspaceServerOptions {
  const host = options.bind ?? '127.0.0.1';
  const number = options.port ?? String(DEFAULT_WORKSPACE_SERVER_PORT);
  const port = Number(number);
  if (!isIP(host) || !/^\d+$/.test(number) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('请指定有效的监听 IP 与 TCP 端口');
  const { 'tls-cert': cert, 'tls-key': key } = options;
  if (!!cert !== !!key) throw new Error('TLS 证书与私钥必须同时指定');
  if (!cert && host !== '127.0.0.1' && host !== '::1')
    throw new Error('使用非回环地址监听时必须配置 TLS 证书与私钥');
  const tls = cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
  return { host, port, tls, token: readWorkspaceServerToken(dataDirectory, true) };
}

export async function workspaceDirectories(input?: string): Promise<WorkspaceDirectoryPage> {
  const requested = input ?? homedir();
  if (!path.isAbsolute(requested)) throw new Error('请输入服务器上的绝对目录');
  const folder = await realpath(requested);
  const directories: WorkspaceDirectoryPage['directories'] = [];
  let examined = 0;
  const dir = await opendir(folder);
  for await (const entry of dir) {
    if (++examined > 10000 || directories.length >= 300) break;
    if (entry.isDirectory()) directories.push({ name: entry.name, path: path.join(folder, entry.name) });
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, directories, truncated: examined > 10000 || directories.length === 300 };
}
