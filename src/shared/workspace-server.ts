export const DEFAULT_WORKSPACE_SERVER_PORT = 7467;
export const WORKSPACE_SERVER_VERSION = 1;
export const WORKSPACE_EXTENSION_PATH = '/extension-package';
export const serverTokenPattern = /^[a-f0-9]{64}$/;

export interface WorkspaceServerInfo { version: number; hostname: string; extensionUpload?: true }
export interface WorkspaceEndpoint {
  address: string;
  token: string;
  ca?: string;
}
export interface WorkspaceSshSettings {
  host: string;
  port: number;
  username: string;
  authentication: 'password' | 'key';
  keyPath?: string;
}
export interface WorkspaceSshEndpoint {
  address: string;
  ssh: WorkspaceSshSettings;
  password?: string;
  passphrase?: string;
}
export type WorkspaceConnection = WorkspaceEndpoint | WorkspaceSshEndpoint;
export interface WorkspaceSshProbe {
  id: string;
  status: 'running' | 'installed' | 'missing';
  arch: 'x64' | 'arm64';
  hostname: string;
}
export type WorkspaceProvisionProgress = 'upload' | 'install' | 'start' | 'connect';
export type WorkspaceSshAction =
  | { action:'probe'; settings:WorkspaceSshSettings; password?:string; passphrase?:string }
  | { action:'activate'; id:string; remember:boolean }
  | { action:'discard'; id:string };
export interface WorkspaceTarget {
  address?: string;
  recentAddress?: string;
  savedToken: boolean;
  hasCertificate: boolean;
  ssh?: WorkspaceSshSettings;
  savedSsh?: boolean;
}
export type WorkspaceTargetAction =
  | { action: 'state' }
  | { action: 'certificate' }
  | { action: 'local'; forget?: boolean }
  | { action: 'connect'; address: string; token?: string; ca?: string; remember: boolean };

export interface WorkspaceDirectoryPage {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

export function workspaceServerAddress(input: string): string {
  const address = input.trim();
  if (!address || address.length > 2048 || /[\x00-\x20\x7f\\]/.test(address)) throw new Error('服务器地址无效');
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('请输入完整服务器地址'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/' && url.pathname !== '/rpc'))
    throw new Error('服务器地址只能包含协议、主机和端口');
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if(url.protocol==='ws:'&&url.hostname==='localhost')url.hostname='127.0.0.1';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))
    throw new Error('服务器请使用 wss://，SSH 隧道可使用本机 ws:// 地址');
  return url.origin;
}
