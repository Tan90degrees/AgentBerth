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
}

if (process.argv[1]?.endsWith('/build.mjs') || process.argv[1]?.endsWith('\\build.mjs')) {
  await buildBackend();
  await buildRenderer();
}
