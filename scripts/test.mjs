import { build } from 'esbuild';
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { electronExecutable } from './electron-runtime.mjs';
import { buildBackend } from './build.mjs';

let electron;
try { electron = electronExecutable(); }
catch (error) { console.error(error.message); process.exit(1); }
await buildBackend();
const available=globSync('tests/*.test.ts').map(file=>file.replaceAll('\\','/')),requested=process.argv.slice(2).map(file=>file.replaceAll('\\','/'));
if(requested.some(file=>!available.includes(file)))throw new Error('Specify existing tests/*.test.ts files');
const tests = requested.length?requested:available;
await build({ entryPoints: tests, outdir: 'dist/tests', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', target: 'node24' });
await build({ entryPoints: ['tests/fixtures/launcher.ts'], outfile: 'dist/tests/launcher.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external', target: 'node24' });
const result = spawnSync(electron, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=120000', ...tests.map(file=>'dist/tests/'+file.slice('tests/'.length).replace(/\.ts$/,'.cjs'))], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status ?? 1);
