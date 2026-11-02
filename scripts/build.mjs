import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { zipSync } from 'fflate';
const require=createRequire(import.meta.url);

async function buildSuperagent(){
  const directory='dist/superagent';await mkdir(directory,{recursive:true});
  await build({entryPoints:['src/superagent/index.ts'],outfile:directory+'/index.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',external:['cordis','electron']});
  delete require.cache[require.resolve('../'+directory+'/index.cjs')];
  const {superagentView,superagentManifest}=require('../'+directory+'/index.cjs');
  const manifest={...superagentManifest,id:'superagent.custom',name:'Superagent（独立插件）',entry:'index.cjs',views:superagentManifest.views.map(view=>({...view,entry:'view.html'}))};
  await writeFile(directory+'/agentberth.extension.json',JSON.stringify(manifest,null,2)+'\n');
  await writeFile(directory+'/view.html',superagentView);
  await copyFile('docs/SUPERAGENT_PLUGIN.md',directory+'/README.md');
  await copyFile('docs/third-party/dsh-superagent-MIT.txt',directory+'/UPSTREAM-NOTICE.txt');
  const files=Object.fromEntries(await Promise.all(['index.cjs','agentberth.extension.json','view.html','README.md','UPSTREAM-NOTICE.txt'].map(async name=>[name,await readFile(directory+'/'+name)])));
  await writeFile('dist/superagent-plugin.zip',zipSync(files));
}


export async function buildBackend() {
  await buildSuperagent();
  for (const name of ['main', 'preload', 'daemon']) {
    await build({
      entryPoints: [`src/${name}/index.ts`],
      outfile: `dist/${name}.cjs`,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      packages: 'external',
      sourcemap: true,
    });
  }
  await build({ entryPoints: ['src/mcp/index.ts'], outfile: 'dist/mcp.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['bufferutil', 'utf-8-validate'] });
  await build({ entryPoints: ['src/pet-hook/index.ts'], outfile: 'dist/pet-hook.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
  for (const version of ['v1', 'v2']) await build({ entryPoints: [`src/integrations/opencode/${version}.ts`], outfile: `dist/opencode-pet-${version}.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'es2022', banner: { js: `// AgentBerth desktop-pet adapter; managed file. OpenCode major: ${version.slice(1)}. No model runtime is bundled.` } });
}

if (process.argv[1]?.endsWith('/build.mjs') || process.argv[1]?.endsWith('\\build.mjs')) {
  await buildBackend();
  await buildRenderer();
}
