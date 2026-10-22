import { build } from 'esbuild';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { electronExecutable } from './electron-runtime.mjs';
import { buildBackend } from './build.mjs';

let electron;
try { electron = electronExecutable(); }
catch (error) { console.error(error.message); process.exit(1); }
await buildBackend();
const tests = globSync('tests/*.test.ts');
await build({ entryPoints: tests, outdir: 'dist/tests', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', target: 'node24' });
await build({ entryPoints: ['tests/fixtures/launcher.ts'], outfile: 'dist/tests/launcher.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external', target: 'node24' });
const result = spawnSync(electron, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=120000', ...globSync('dist/tests/*.test.cjs')], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status ?? 1);
