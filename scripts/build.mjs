import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';

export async function buildBackend() {
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
  // Exported developer tooling must work outside this repository without npm install.
  await build({ entryPoints: ['src/plugin-check/index.ts'], outfile: 'dist/check-plugin.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', minify: true });
}

if (process.argv[1]?.endsWith('/build.mjs') || process.argv[1]?.endsWith('\\build.mjs')) {
  await buildBackend();
  await buildRenderer();
}
