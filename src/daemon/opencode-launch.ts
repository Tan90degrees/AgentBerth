import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Only our installed 2.x adapter requires a private, environment-inheriting server. */
export async function openCodeLaunch(command: string, project: string, home = os.homedir(), env = process.env) {
  if (!/^opencode(?:\.exe|\.cmd)?(?:\s|$)/i.test(command) || /(?:^|\s)--(?:standalone|server)(?:\s|=|$)/.test(command)) return command;
  for (const root of [path.join(project, '.opencode'), path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')]) {
    let handle;
    try {
      handle = await open(path.join(root, 'plugins', 'agentberth-pet.js'), 'r');
      const buffer = Buffer.alloc(256), read = await handle.read(buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, read.bytesRead).toString('utf8');
      if (header.startsWith('// AgentBerth desktop-pet adapter; managed file.')) return header.includes('OpenCode major: 2') ? command.replace(/^(opencode(?:\.exe|\.cmd)?)/i, '$1 --standalone') : command;
    } catch { /* No managed adapter: preserve the user's launch command. */ }
    finally { await handle?.close(); }
  }
  return command;
}
