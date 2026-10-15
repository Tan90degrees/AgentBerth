import path from 'node:path';
import { connectDaemon } from '../../src/main/connection';
import type { Project, Run, Session } from '../../src/shared/protocol';

async function main() {
  const folder = process.argv[2];
  const connection = await connectDaemon(path.join(folder, 'data'), path.resolve('dist/daemon.cjs'), process.execPath, () => {});
  const project = await connection.rpc<Project>('createProject', { name: 'persistent project', path: folder });
  const session = await connection.rpc<Session>('createSession', { projectId: project.id, title: 'survives UI exit', agent: 'shell', command: '' });
  const run = await connection.rpc<Run>('start', { sessionId: session.id, cols: 100, rows: 30 });
  await connection.rpc('attach', { sessionId: session.id });
  const command = process.platform === 'win32' ? 'Start-Sleep -Milliseconds 700; Write-Output ("PERSIST_" + (37+5))\r' : 'sleep .7; echo PERSIST_$((37+5))\r';
  await connection.rpc('input', { sessionId: session.id, runId: run.id, data: command });
  console.log(JSON.stringify({ sessionId: session.id, runId: run.id, pid: run.pid }));
  connection.close();
}
void main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
