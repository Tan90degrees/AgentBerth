// AgentBerth plugin protocol v1. Run with: node /absolute/path/agent-plugin.cjs
// This example adapts PROJECT/agent-session.json; replace its reader for your CLI.
const fs = require('node:fs/promises');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) process.exit(2); });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input);
    if (request.version !== 1) throw new Error('Unsupported protocol version');
    if (request.method === 'describe') {
      process.stdout.write(JSON.stringify({ version: 1, id: 'my-agent', name: '我的 Agent', command: 'my-agent', capabilities: { history: true, resume: true } }));
    } else if (request.method === 'history') {
      const file = request.path || path.join(request.projectPath, 'agent-session.json');
      const data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      // Expected data: { cwd, nativeSessionId, messages: [{ role, text, timestamp? }] }
      process.stdout.write(JSON.stringify({ version: 1, cwd: data.cwd, nativeSessionId: data.nativeSessionId, path: file, messages: data.messages.map(message => ({ role: message.role, text: message.text, timestamp: message.timestamp ?? null })), warnings: [] }));
    } else if (request.method === 'resume') {
      const id = request.session.nativeSessionId;
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid native session ID');
      // Adapt --resume to your CLI's syntax, or configure a resume template instead.
      process.stdout.write(JSON.stringify({ version: 1, command: request.session.command + ' --resume ' + id }));
    } else throw new Error('Unsupported method');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
