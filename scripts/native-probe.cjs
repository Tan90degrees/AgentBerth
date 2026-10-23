const assert = require('node:assert/strict');

assert.equal(process.versions.electron, process.argv[2]);
const pty = require('node-pty');
let output = '';
const child = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  process.platform === 'win32' ? ['/d', '/c', 'echo AGENTBERTH_NATIVE_READY'] : ['-c', 'printf AGENTBERTH_NATIVE_READY'],
  { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
const timer = setTimeout(() => {
  try { child.kill(); } finally { console.error('Native PTY probe timed out'); process.exit(1); }
}, 10000);
child.onData(text => { output = (output + text).slice(-4096); });
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  assert.equal(exitCode, 0);
  assert.ok(output.includes('AGENTBERTH_NATIVE_READY'), 'Native PTY returned no output');
  // ConPTY's output worker can keep Electron alive after the command exits.
  // This isolated probe has finished all checks; dispose the worker, flush its
  // result and explicitly exit rather than waiting on native event-loop handles.
  if (process.platform === 'win32') { try { child.kill(); } catch {} }
  process.stdout.write(`Verified Electron ${process.versions.electron}, native ABI ${process.versions.modules} and PTY output\n`, () => process.exit(0));
});
