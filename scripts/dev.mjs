import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { buildBackend } from './build.mjs';

await buildBackend();
const server = await createServer();
await server.listen();
server.printUrls();
const env = { ...process.env, AGENTBERTH_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
const close = async () => { child.kill(); await server.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
