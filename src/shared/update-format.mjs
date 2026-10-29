export const UPDATE_SCHEMA = 1;
export const UPDATE_BOOTSTRAP = 1;
export const RELEASE_REPOSITORY = 'Tan90degrees/AgentBerth';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest`;
export function stableVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.split('.').some(n => !Number.isSafeInteger(Number(n)))) throw new Error('更新版本号无效');
  return value;
}
export function compareVersions(a, b) {
  const left = stableVersion(a).split('.').map(Number), right = stableVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export const updateNames = version => ({ bundle: `AgentBerth-${stableVersion(version)}-windows-x64-update.zip`, manifest: `AgentBerth-${version}-windows-x64-update.json` });
export function updatePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.startsWith('/') || /[\x00-\x1f<>:"|?*]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('更新包包含无效路径');
  return value;
}
export function parseUpdateManifest(value) {
  const m = value;
  if (!m || typeof m !== 'object' || m.schema !== UPDATE_SCHEMA || m.bootstrap !== UPDATE_BOOTSTRAP || m.platform !== 'win32' || m.arch !== 'x64' || m.protocol !== 1) throw new Error('不支持此更新包格式，请使用完整安装包');
  stableVersion(m.version); stableVersion(m.electron);
  if (!Number.isSafeInteger(m.minimumBackendApi) || m.minimumBackendApi < 1 || !m.bundle || m.bundle.name !== updateNames(m.version).bundle || !Number.isSafeInteger(m.bundle.size) || m.bundle.size < 1 || m.bundle.size > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(m.bundle.sha256)) throw new Error('更新包元数据无效');
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 20000) throw new Error('更新包文件清单无效');
  const seen = new Set(); let size = 0;
  for (const f of m.files) {
    updatePath(f.path); const key = f.path.toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('更新包文件清单无效');
    seen.add(key); size += f.size;
  }
  if (size > 4 * 1024 ** 3 || !seen.has('app.asar') || !seen.has('mcp/server.cjs')) throw new Error('更新包不完整或过大');
  return m;
}
export function releaseAsset(release, name) {
  const version = stableVersion(String(release?.tag_name ?? '').replace(/^v/, ''));
  if (release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error('仅支持已发布的稳定版本');
  const items = release.assets.filter(a => a.name === name);
  const prefix = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/`;
  if (items.length !== 1 || items[0].state !== 'uploaded' || typeof items[0].browser_download_url !== 'string' || items[0].browser_download_url !== prefix + name || !Number.isSafeInteger(items[0].size) || items[0].size < 1) throw new Error('版本尚未提供完整的软件内更新包');
  return items[0];
}
