import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const packed=process.argv[2];
if(packed){
  process.env.AGENTBERTH_TEST_SERVER=path.resolve(packed,'bin','agentberth-server');
}else{
  await build({entryPoints:['src/daemon/index.ts'],outfile:'dist/daemon.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',packages:'external'});
}
await build({entryPoints:['tests/workspace-server.test.ts'],outfile:'dist/tests/workspace-server.test.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',packages:'external'});
const result=spawnSync(process.execPath,['--test','--test-timeout=90000','dist/tests/workspace-server.test.cjs'],{stdio:'inherit'});
process.exitCode=result.status??1;
