import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {access} from 'node:fs/promises';
import {electronExecutable} from './electron-runtime.mjs';

let executable=process.env.AGENTBERTH_OPENCODE_TEST_EXECUTABLE;
const directory=process.env.AGENTBERTH_OPENCODE_TEST_DIRECTORY;
if(!executable&&directory){
  if(process.arch!=='x64'||!['linux','win32'].includes(process.platform))throw new Error('The pinned ACP integration CLI requires Linux/Windows x64');
  const packageName=process.platform==='win32'?'opencode-windows-x64-baseline':'opencode-linux-x64-baseline';
  executable=path.resolve(directory,'node_modules',packageName,'bin',process.platform==='win32'?'opencode.exe':'opencode');
}
if(!executable||!path.isAbsolute(executable))throw new Error('Set AGENTBERTH_OPENCODE_TEST_EXECUTABLE to an installed OpenCode executable, or provide the isolated test installation directory');
await access(executable);
await build({entryPoints:['tests/opencode-acp.test.ts'],outfile:'dist/tests/opencode-acp.test.cjs',bundle:true,platform:'node',format:'cjs',packages:'external',target:'node24'});
const result=spawnSync(electronExecutable(),['--test','--test-reporter=spec','--test-timeout=120000','dist/tests/opencode-acp.test.cjs'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AGENTBERTH_OPENCODE_TEST_EXECUTABLE:executable}});
if(result.error)throw result.error;process.exitCode=result.status??1;
