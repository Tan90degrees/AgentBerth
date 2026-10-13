import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function electronInstallation() {
  // Resolving package.json does not import electron/index.js or trigger a download.
  const directory = path.dirname(require.resolve('electron/package.json'));
  return { directory, version: JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).version };
}

export function electronExecutable({ directory, version } = electronInstallation(), env = process.env, platform = process.platform) {
  const fallback = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  let relativePath = fallback;
  try { relativePath = readFileSync(path.join(directory, 'path.txt'), 'utf8').trim() || fallback; } catch {}
  const dist = env.ELECTRON_OVERRIDE_DIST_PATH || path.join(directory, 'dist');
  const executable = path.join(dist, relativePath);
  let matches = Boolean(env.ELECTRON_OVERRIDE_DIST_PATH);
  if (!matches) {
    try { matches = readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '') === version; } catch {}
  }
  if (!matches || !existsSync(executable)) {
    throw new Error(`Electron ${version} 的本机二进制未安装完整。请先运行 npm run setup。\n配置镜像或代理的 PowerShell 示例见 README.md 的“Electron 下载失败”。`);
  }
  return executable;
}

export function installationEnvironment(source = process.env) {
  const env = { ...source };
  // npm's proxy options do not automatically apply to Node's Fetch downloader.
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || env.npm_config_https_proxy || env.npm_config_proxy;
  const httpProxy = env.http_proxy || env.HTTP_PROXY || env.npm_config_proxy;
  if (httpsProxy && !env.HTTPS_PROXY) env.HTTPS_PROXY = httpsProxy;
  if (httpProxy && !env.HTTP_PROXY) env.HTTP_PROXY = httpProxy;
  if ((httpsProxy || httpProxy) && env.NODE_USE_ENV_PROXY === undefined) env.NODE_USE_ENV_PROXY = '1';
  return env;
}

export function printDownloadHelp() {
  console.error(`\nElectron 二进制下载失败；npm registry 与 Electron 下载地址是独立配置。
Windows PowerShell：任选一种方式，然后重新执行 npm run setup。

镜像：
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_CUSTOM_DIR = "{{ version }}"

已有 HTTP 代理（7890 请替换成实际端口）：
  $env:HTTPS_PROXY = "http://127.0.0.1:7890"
  $env:HTTP_PROXY = $env:HTTPS_PROXY
  $env:NODE_USE_ENV_PROXY = "1"

配置只作用于当前终端。无需删除整个 node_modules；详见 README.md。`);
}
