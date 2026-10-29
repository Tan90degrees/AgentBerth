import path from 'node:path';
import { readFileSync } from 'node:fs';
import { compareVersions } from '../shared/update-format.mjs';
import { UpdateStore } from '../main/update-files';
const directory = process.argv[2];
let entry = path.join(__dirname, 'server.cjs');
if (__dirname.endsWith(path.sep + 'dist')) entry = path.join(__dirname, 'mcp-server.cjs');
if (directory && path.isAbsolute(directory)) {
  const store = new UpdateStore(directory), state = store.read();
  const version = state.pending ? state.previous : state.active;
  if (version) try {
    const installed = JSON.parse(readFileSync(__dirname.endsWith(path.sep + 'dist') ? path.join(__dirname, '..', 'package.json') : path.join(__dirname, '..', 'app.asar', 'package.json'), 'utf8')).version;
    if (compareVersions(version, installed) <= 0) throw new Error('Installed version supersedes this bundle');
    store.verify(version, { electron: process.versions.electron!, platform: process.platform, arch: process.arch }, false); entry = path.join(store.versionRoot(version), 'mcp', 'server.cjs'); } catch { /* Keep the installed, compatible MCP implementation. */ }
}
require(entry);
