import { spawn } from 'node:child_process';
import { electronExecutable } from './electron-runtime.mjs';

async function dev() {
  const executable = electronExecutable();
  const { buildBackend } = await import('./build.mjs');
  const { createServer } = await import('vite');
  await buildBackend();
  const server = await createServer();
  try { await server.listen(); } catch (error) { await server.close(); throw error; }
  server.printUrls();
  const env = { ...process.env, AGENTBERTH_DEV_URL: 'http://127.0.0.1:5173' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['.'], { stdio: 'inherit', env });
  const close = async () => { child.kill(); await server.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  child.once('error', async error => {
    console.error(`Electron 启动失败：${error.message}`);
    await server.close(); process.exitCode = 1;
  });
  child.once('exit', async code => { await server.close(); process.exitCode = code ?? 1; });
}

try { await dev(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
