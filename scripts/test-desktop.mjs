import { spawnSync } from 'node:child_process';

let failed = false;
for (const script of ['scripts/smoke.mjs', 'scripts/smoke-files.mjs', 'scripts/smoke-pet.mjs']) {
  const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  if (result.error) console.error(result.error);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
