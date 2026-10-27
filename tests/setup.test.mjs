import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { electronExecutable, installationEnvironment } from '../scripts/electron-runtime.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'berth-setup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'dist'));
  // A runtime check must never load the dependency entry point / its downloader.
  writeFileSync(path.join(directory, 'index.js'), 'throw new Error("implicit download was triggered")');
  return { directory, version: '44.7.0' };
}

test('runtime preflight resolves an installed executable without importing Electron', t => {
  const installation = fixture(t);
  writeFileSync(path.join(installation.directory, 'path.txt'), 'electron.exe');
  writeFileSync(path.join(installation.directory, 'dist/version'), 'v44.7.0\n');
  const executable = path.join(installation.directory, 'dist/electron.exe');
  writeFileSync(executable, 'fixture');
  assert.equal(electronExecutable(installation, {}, 'win32'), executable);
});

test('missing or partial binary and stale version produce repair instructions without downloading', t => {
  const installation = fixture(t);
  const check = () => electronExecutable(installation, {}, 'win32');
  assert.throws(check, /npm run setup/);
  assert.ok(!existsSync(path.join(installation.directory, 'path.txt')));
  writeFileSync(path.join(installation.directory, 'dist/version'), installation.version);
  assert.throws(check, /npm run setup/);
  writeFileSync(path.join(installation.directory, 'dist/electron.exe'), 'fixture');
  writeFileSync(path.join(installation.directory, 'dist/version'), '43.0.0');
  assert.throws(check, /npm run setup/);
});

test('explicit Electron dist override works on Windows and macOS without path.txt', t => {
  const installation = fixture(t);
  const override = path.join(installation.directory, 'override');
  mkdirSync(path.join(override, 'Electron.app/Contents/MacOS'), { recursive: true });
  writeFileSync(path.join(override, 'electron.exe'), 'fixture');
  writeFileSync(path.join(override, 'Electron.app/Contents/MacOS/Electron'), 'fixture');
  const env = { ELECTRON_OVERRIDE_DIST_PATH: override };
  assert.equal(electronExecutable(installation, env, 'win32'), path.join(override, 'electron.exe'));
  assert.equal(electronExecutable(installation, env, 'darwin'), path.join(override, 'Electron.app/Contents/MacOS/Electron'));
});

test('npm proxy options reach Fetch installer with Node environment proxy support', () => {
  const source = { npm_config_proxy: 'http://127.0.0.1:7890', npm_config_https_proxy: 'http://127.0.0.1:7891', NO_PROXY: 'localhost,127.0.0.1' };
  const env = installationEnvironment(source);
  assert.equal(env.HTTP_PROXY, source.npm_config_proxy);
  assert.equal(env.HTTPS_PROXY, source.npm_config_https_proxy);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.NO_PROXY, source.NO_PROXY);
  assert.equal(source.NODE_USE_ENV_PROXY, undefined);
});

test('explicit proxy choices, mirror and disabled Node proxy flag remain intact', () => {
  const source = { https_proxy: 'http://127.0.0.1:8000', HTTPS_PROXY: 'http://127.0.0.1:8001', NODE_USE_ENV_PROXY: '0', ELECTRON_MIRROR: 'https://example.com/electron/', ELECTRON_CUSTOM_DIR: '{{ version }}' };
  const env = installationEnvironment(source);
  assert.equal(env.https_proxy, source.https_proxy);
  assert.equal(env.HTTPS_PROXY, source.HTTPS_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, '0');
  assert.equal(env.ELECTRON_MIRROR, source.ELECTRON_MIRROR);
  assert.equal(env.ELECTRON_CUSTOM_DIR, source.ELECTRON_CUSTOM_DIR);
  assert.deepEqual(installationEnvironment({}), {});
});

function setupFixture(t) {
  const installation = fixture(t);
  const project = path.join(installation.directory, 'project');
  const directory = path.join(project, 'node_modules/electron');
  const rebuild = path.join(project, 'node_modules/@electron/rebuild');
  mkdirSync(path.join(project, 'scripts'), { recursive: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(path.join(rebuild, 'lib'), { recursive: true });
  for (const name of ['setup.mjs', 'electron-runtime.mjs']) {
    copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(project, 'scripts', name));
  }
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: installation.version }));
  writeFileSync(path.join(directory, 'install.js'), `
    const fs = require('node:fs'); const path = require('node:path');
    fs.appendFileSync(process.env.SETUP_TRACE, 'install\\n');
    if (process.env.SETUP_FAIL === '1') { console.error('fetch failed'); process.exit(1); }
    fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
    const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
    fs.writeFileSync(path.join(__dirname, 'dist', executable), 'fixture');
    fs.writeFileSync(path.join(__dirname, 'dist/version'), '44.7.0');
    fs.writeFileSync(path.join(__dirname, 'path.txt'), executable);
  `);
  writeFileSync(path.join(rebuild, 'package.json'), JSON.stringify({ main: 'lib/main.js' }));
  writeFileSync(path.join(rebuild, 'lib/main.js'), '');
  writeFileSync(path.join(rebuild, 'lib/cli.js'), `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['-f', '-w', 'node-pty', '-v', '44.7.0']);
    require('node:fs').appendFileSync(process.env.SETUP_TRACE, 'rebuild\\n');
  `);
  const trace = path.join(project, 'trace.txt');
  const run = fail => {
    const env = { ...process.env, SETUP_TRACE: trace, SETUP_FAIL: fail ? '1' : '0' };
    delete env.ELECTRON_OVERRIDE_DIST_PATH;
    delete env.ELECTRON_RUN_AS_NODE;
    return spawnSync(process.execPath, [path.join(project, 'scripts/setup.mjs')], { cwd: project, env, encoding: 'utf8', timeout: 10000 });
  };
  return { directory, trace, run };
}

test('setup stops after installer failure, preserves dependencies and shows Windows recovery commands', t => {
  const { directory, trace, run } = setupFixture(t);
  const result = run(true);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(trace, 'utf8'), 'install\n');
  assert.ok(existsSync(path.join(directory, 'package.json')));
  assert.match(result.stderr, /ELECTRON_MIRROR/);
  assert.match(result.stderr, /HTTPS_PROXY/);
  assert.match(result.stderr, /npm run setup/);
});

test('setup installs before rebuilding for pinned ABI and skips the installer on subsequent runs', t => {
  const { trace, run } = setupFixture(t);
  const first = run(false);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(trace, 'utf8'), 'install\nrebuild\n');
  const second = run(false);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(trace, 'utf8'), 'install\nrebuild\nrebuild\n');
});

function nativeProbeFixture(t) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-native-probe-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const preload = path.join(folder, 'native.cjs');
  writeFileSync(preload, `
    Object.defineProperty(process.versions, 'electron', { value: '44.7.0' });
    const Module = require('node:module'), load = Module._load;
    Module._load = function(name, ...args) {
      if (name !== 'node-pty') return load.call(this, name, ...args);
      return { spawn() {
        // Model a native worker that remains live after onExit, even after kill.
        setInterval(() => {}, 1000);
        return {
          kill() {},
          onData(callback) { setImmediate(() => callback(process.env.PROBE_CASE === 'output' ? 'wrong output' : 'AGENTBERTH_NATIVE_READY')); },
          onExit(callback) { setTimeout(() => callback({ exitCode: process.env.PROBE_CASE === 'exit' ? 1 : 0 }), 20); },
        };
      } };
    };
  `);
  return (value = '', version = '44.7.0') => spawnSync(process.execPath,
    ['--require', preload, path.resolve('scripts/native-probe.cjs'), version],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PROBE_CASE: value } });
}

test('native dependency probe flushes success and exits despite a lingering ConPTY worker', t => {
  const result = nativeProbeFixture(t)();
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified Electron 44\.7\.0, native ABI \d+ and PTY output\n/);
});

test('native dependency probe still rejects wrong Electron versions, missing output and failed commands', t => {
  const run = nativeProbeFixture(t);
  for (const [value, version] of [['output', '44.7.0'], ['exit', '44.7.0'], ['', '44.7.1']]) {
    const result = run(value, version);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /Verified Electron/);
  }
});
