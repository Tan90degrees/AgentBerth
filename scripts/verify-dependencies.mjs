import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { electronExecutable, electronInstallation } from './electron-runtime.mjs';

// Check under the pinned Electron runtime, not the host Node ABI. A real PTY
// also loads Windows' lazy native module and checks its bundled helpers.
const installation = electronInstallation();
const result = spawnSync(electronExecutable(installation), [fileURLToPath(new URL('./native-probe.cjs', import.meta.url)), installation.version], {
  stdio: 'inherit', timeout: 20000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
