// Reproduces the old Wiki build's authenticated state failure and idle gate.
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const directory = process.argv[2];
const runtime = path.join(directory, 'runtime.json');
const lock = path.join(directory, 'daemon.lock');
const token = randomBytes(32).toString('hex');
const server = createServer();
const sockets = new WebSocketServer({ noServer: true });
let busy = process.argv.includes('--busy');
let issuePath = 'integration';

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/rpc' || request.headers.authorization !== 'Bearer ' + token) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
});
sockets.on('connection', socket => socket.on('message', message => {
  const { id, method } = JSON.parse(String(message));
  if (method === 'state') {
    socket.send(JSON.stringify({ id, error: JSON.stringify([{
      code: 'invalid_value', values: ['codex', 'claude', 'opencode'], path: [issuePath],
      message: 'Invalid option',
    }]) }));
  } else if (method === 'shutdownIdle') {
    if (busy) socket.send(JSON.stringify({ id, error: '请先停止全部终端和 ACP 会话，再更新后台' }));
    else socket.send(JSON.stringify({ id, result: null }), () => {
      rmSync(runtime, { force: true });
      rmSync(lock, { force: true });
      process.exit(0);
    });
  }
}));
process.on('message', message => {
  if (message === 'idle') busy = false;
  if (message === 'unrelated-error') issuePath = 'option';
  if (message === 'integration-error') issuePath = 'integration';
  process.send?.(message);
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  writeFileSync(runtime, JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, token }));
  process.send?.('ready');
});
