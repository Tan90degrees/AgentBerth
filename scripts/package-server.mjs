import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('服务器包需在 Linux x64 或 arm64 上构建');
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版');

const root=process.cwd();
const manifest=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const staging=mkdtempSync(path.join(tmpdir(),'agentberth-server-'));
const packageRoot=path.join(staging,'agentberth-server');
const name='AgentBerth-Server-'+manifest.version+'-linux-'+process.arch+'.tar.gz';
const output=path.join(root,'release',name);

try {
  for(const directory of ['dist','bin'])mkdirSync(path.join(packageRoot,directory),{recursive:true});
  writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({
    name:manifest.name,version:manifest.version,private:true,engines:manifest.engines,license:manifest.license,dependencies:manifest.dependencies,
  },null,2)+'\n');
  copyFileSync('package-lock.json',path.join(packageRoot,'package-lock.json'));
  copyFileSync('server/agentberth-server',path.join(packageRoot,'bin/agentberth-server'));
  chmodSync(path.join(packageRoot,'bin/agentberth-server'),0o755);
  copyFileSync('server/agentberth-server.service',path.join(packageRoot,'agentberth-server.service'));
  copyFileSync('docs/server.md',path.join(packageRoot,'README.md'));
  copyFileSync('LICENSE',path.join(packageRoot,'LICENSE'));
  await build({entryPoints:['src/daemon/index.ts'],outfile:path.join(packageRoot,'dist/daemon.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',packages:'external'});
  await build({entryPoints:['src/mcp/index.ts'],outfile:path.join(packageRoot,'dist/mcp.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['bufferutil','utf-8-validate']});
  execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--prefer-offline','--no-audit','--no-fund'],{cwd:packageRoot,stdio:'inherit'});
  execFileSync('npm',['rebuild','node-pty'],{cwd:packageRoot,stdio:'inherit'});
  mkdirSync(path.dirname(output),{recursive:true});
  execFileSync('tar',['-C',staging,'-czf',output,'agentberth-server'],{stdio:'inherit'});
  const digest=createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(output+'.sha256',digest+'  '+name+'\n');
  console.log(output);
} finally {
  rmSync(staging,{recursive:true,force:true});
}
