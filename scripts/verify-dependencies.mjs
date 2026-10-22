import { spawnSync } from 'node:child_process';
import { electronExecutable, electronInstallation } from './electron-runtime.mjs';

// Check under the pinned Electron runtime, not the host Node ABI. A real PTY
// also loads Windows' lazy native module and checks its bundled helpers.
const installation = electronInstallation();
const probe = `
  const assert = require('node:assert/strict');
  assert.equal(process.versions.electron, ${JSON.stringify(installation.version)});
  const pty = require('node-pty');
  let output = '';
  const child = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    process.platform === 'win32' ? ['/d','/c','echo AGENTBERTH_NATIVE_READY'] : ['-c','printf AGENTBERTH_NATIVE_READY'],
    { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  const timer = setTimeout(() => { child.kill(); console.error('Native PTY probe timed out'); process.exit(1); }, 10000);
  child.onData(text => { output = (output + text).slice(-4096); });
  child.onExit(({exitCode}) => {
    clearTimeout(timer);
    assert.equal(exitCode, 0);
    assert.ok(output.includes('AGENTBERTH_NATIVE_READY'), 'Native PTY returned no output');
    console.log('Verified Electron ' + process.versions.electron + ', native ABI ' + process.versions.modules + ' and PTY output');
  });
`;
const result = spawnSync(electronExecutable(installation), ['-e', probe], {
  stdio: 'inherit', timeout: 20000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
