import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { matchesProject } from './history';
import type { Agent, NativeHistoryItem } from '../shared/protocol';
import { OpenCodeHistory } from './opencode-history';

export interface NativeCandidate extends NativeHistoryItem { path: string | null; modified: number }
// Discovery reads metadata only. Large transcripts remain resumable by ID.
export class NativeDiscovery {
  private identities = new Map<string, { id: string; cwd: string }>();
  constructor(private roots = {
    codex: path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions'),
    claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects'),
  }, readonly opencode = new OpenCodeHistory()) {}
  async list(agent: Agent, project: string): Promise<NativeCandidate[]> {
    if (agent === 'opencode') return this.opencode.list(project);
    if (agent !== 'codex' && agent !== 'claude') return [];
    const files: { path: string; modified: number }[] = [];
    let visited = 0;
    const walk = async (folder: string, depth: number) => {
      if (depth > 4 || visited >= 4000) return;
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
      // Codex's date directories sort newest first; Claude stores one folder per project.
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (++visited > 4000) break;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'subagents') await walk(file, depth + 1); }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try { const info = await stat(file); files.push({ path: file, modified: info.mtimeMs }); } catch { /* concurrent removal */ }
        }
      }
    };
    await walk(this.roots[agent], 0);
    files.sort((a, b) => b.modified - a.modified);
    const result: NativeCandidate[] = [];
    for (const file of files.slice(0, 500)) {
      let identity = this.identities.get(file.path);
      if (!identity) {
        try {
          const handle = await open(file.path, 'r');
          let text: string;
          try { const buffer = Buffer.alloc(128 * 1024); const read = await handle.read(buffer, 0, buffer.length, 0); text = buffer.subarray(0, read.bytesRead).toString('utf8'); }
          finally { await handle.close(); }
          for (const line of text.split('\n')) {
            try {
              const item = JSON.parse(line), meta = agent === 'codex' ? item.type === 'session_meta' ? item.payload : null : item;
              const id = agent === 'codex' ? meta?.session_id ?? meta?.id : meta?.sessionId;
              if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && typeof meta?.cwd === 'string') {
                identity = { id, cwd: meta.cwd }; break;
              }
            } catch { /* partial line: retry next scan */ }
          }
          if (identity) { if (this.identities.size >= 4000) this.identities.clear(); this.identities.set(file.path, identity); }
        } catch { continue; }
      }
      if (identity && await matchesProject(identity.cwd, project)) result.push({ nativeSessionId: identity.id, title: identity.id, path: file.path, updatedAt: new Date(file.modified).toISOString(), modified: file.modified });
    }
    return [...new Map(result.map(item => [item.nativeSessionId, item])).values()];
  }
}

export function unambiguousNewHistory(items: NativeCandidate[], baseline: Set<string>, started: number, claimed: Set<string>): NativeCandidate | null {
  const candidates = items.filter(item => !baseline.has(item.nativeSessionId) && item.modified >= started - 1000 && !claimed.has(item.nativeSessionId));
  return candidates.length === 1 ? candidates[0] : null;
}
