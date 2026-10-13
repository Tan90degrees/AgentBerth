import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const execute = promisify(execFile);
type Environment = Record<string, string | undefined>;
export function environmentValue(name: string, env: Environment = process.env, platform = process.platform): string {
  return platform === 'win32' ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? '' : env[name] ?? '';
}
export function pathCandidates(file: string, env: Environment = process.env, platform = process.platform, extraPaths: string[] = []): string[] {
  const fsPath = platform === 'win32' ? path.win32 : path.posix;
  if (fsPath.isAbsolute(file)) return [file];
  const names = platform === 'win32' && !fsPath.extname(file) ? [file + '.exe', file] : [file];
  return [environmentValue('PATH', env, platform), ...extraPaths].flatMap(value => value.split(fsPath.delimiter))
    .map(value => value.trim().replace(/^"|"$/g, '')).filter(value => fsPath.isAbsolute(value))
    .flatMap(directory => names.map(name => fsPath.join(directory, name)));
}
export function powershellCandidates(env: Environment = process.env): string[] {
  const value = (name: string) => environmentValue(name, env, 'win32');
  const configured = [value('ProgramW6432'), value('ProgramFiles'), value('ProgramFiles(x86)')].filter(Boolean);
  const roots = configured.length ? configured : ['C:\\Program Files'];
  const home = value('USERPROFILE'), local = value('LOCALAPPDATA');
  return [...new Set([
    ...roots.filter(Boolean).map(root => path.win32.join(root, 'PowerShell', '7', 'pwsh.exe')),
    ...[value('SCOOP'), home && path.win32.join(home, 'scoop'), value('SCOOP_GLOBAL'), value('ProgramData') && path.win32.join(value('ProgramData'), 'scoop')]
      .filter(Boolean).map(root => path.win32.join(root, 'apps', 'pwsh', 'current', 'pwsh.exe')),
    ...(home ? [path.win32.join(home, '.dotnet', 'tools', 'pwsh.exe')] : []),
    ...(local ? [path.win32.join(local, 'Microsoft', 'WinGet', 'Links', 'pwsh.exe'), path.win32.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'), path.win32.join(local, 'Programs', 'PowerShell', '7', 'pwsh.exe')] : []),
    ...roots.filter(Boolean).map(root => path.win32.join(root, 'PowerShell', '7-preview', 'pwsh.exe')),
  ])];
}

interface WindowsLocations { paths: string[]; pwsh: string | null }
let discovering: Promise<WindowsLocations> | null = null;
async function windowsLocations(): Promise<WindowsLocations> {
  if (discovering) return discovering;
  // Read current persisted PATH, even if Explorer/the daemon inherited an old
  // environment. No profiles, installation, registry writes or user commands.
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
    $machine=[Environment]::GetEnvironmentVariable('Path','Machine')
    $user=[Environment]::GetEnvironmentVariable('Path','User')
    $env:Path=(@($env:Path,$machine,$user)|Where-Object {$_}) -join ';'
    $command=Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    @{paths=@($machine,$user);pwsh=if($command){$command.Source}else{$null}} | ConvertTo-Json -Compress`;
  const powershell = path.win32.join(environmentValue('SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  discovering = execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  }).then(({ stdout }) => {
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    return { paths: Array.isArray(result.paths) ? result.paths.filter((value: unknown): value is string => typeof value === 'string') : [], pwsh: typeof result.pwsh === 'string' && path.win32.isAbsolute(result.pwsh) && /pwsh\.exe$/i.test(result.pwsh) ? result.pwsh : null };
  }).catch(() => ({ paths: [], pwsh: null })).finally(() => { discovering = null; });
  return discovering;
}
async function firstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of new Set(candidates)) {
    try {
      // App execution aliases are reparse points. Inspect the link itself on
      // Windows instead of traversing it with stat before CreateProcess.
      const info = process.platform === 'win32' ? await lstat(candidate) : await stat(candidate);
      if (info.isDirectory() || (!info.isFile() && !info.isSymbolicLink())) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Try the next installed location. */ }
  }
  return null;
}
export async function resolveExecutable(file: string): Promise<string> {
  if (!file.trim() || /[\r\n\x00]/.test(file)) throw new Error('请指定终端可执行文件，启动参数单独填写');
  const windows = process.platform === 'win32';
  if (windows && /\.(cmd|bat|ps1)$/i.test(file)) throw new Error('终端须为 .exe 可执行文件，例如 pwsh.exe 或 cmd.exe');
  if (!path.isAbsolute(file) && /[\\/]/.test(file)) throw new Error('终端路径必须是绝对路径，或 PATH 中的程序名');
  const inherited = await firstExecutable(pathCandidates(file));
  if (inherited) return inherited;
  if (windows && !path.isAbsolute(file)) {
    if (/^pwsh(?:\.exe)?$/i.test(file)) {
      const installed = await firstExecutable(powershellCandidates());
      if (installed) return installed;
    }
    const current = await windowsLocations();
    const found = await firstExecutable(pathCandidates(file, process.env, process.platform, current.paths));
    if (found) return found;
    // Get-Command verifies native application aliases even when filesystem
    // access to their Store target is virtualized.
    if (/^pwsh(?:\.exe)?$/i.test(file) && current.pwsh) return current.pwsh;
  }
  throw new Error(`找不到终端程序 ${file}；请确认安装位置或选择完整路径`);
}
