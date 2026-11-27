import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceSshEndpoint, WorkspaceSshSettings } from '../shared/workspace-server';

export const workspaceSshSettings = z.object({
  host: z.string().trim().min(1).max(253).transform(host=>host.replace(/^\[([^\]]+)\]$/,'$1').toLowerCase())
    .refine(host=>isIP(host)!==0||/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host),'请输入 SSH 主机名或 IP'),
  port:z.number().int().min(1).max(65535),
  username:z.string().trim().min(1).max(128).refine(value=>!/[\x00-\x20\x7f]/.test(value),'请输入 SSH 用户名'),
  authentication:z.enum(['password','key']),
  keyPath:z.string().min(1).max(4096).refine(value=>path.isAbsolute(value)&&!/[\r\n\0]/.test(value)).optional(),
}).strict();

export const sshWorkspaceSecrets=z.object({
  password:z.string().max(4096).optional(),
  passphrase:z.string().max(4096).optional(),
}).strict();

export function sshWorkspaceAddress(settings:WorkspaceSshSettings){
  const host=settings.host.includes(':')?'['+settings.host+']':settings.host;
  return 'ssh://'+host+':'+settings.port+'/'+encodeURIComponent(settings.username);
}

export function sshWorkspaceEndpoint(settings:WorkspaceSshSettings,password?:string,passphrase?:string):WorkspaceSshEndpoint{
  const ssh=workspaceSshSettings.parse(settings);
  const secret=sshWorkspaceSecrets.parse({password,passphrase});
  if(ssh.authentication==='password'&&!secret.password)throw new Error('请输入 SSH 密码');
  if(ssh.authentication==='key'&&!ssh.keyPath)throw new Error('请选择 SSH 私钥');
  return {address:sshWorkspaceAddress(ssh),ssh,
    ...(ssh.authentication==='password'?{password:secret.password}:{passphrase:secret.passphrase})};
}
