import { AgentCli } from './agent-cli';
import { matchesProject, parseOpenCodeHistory } from './history';
import type { NativeCandidate } from './native-discovery';

export class OpenCodeHistory {
  constructor(private cli = new AgentCli()) {}
  async list(project: string): Promise<NativeCandidate[]> {
    const value = JSON.parse(await this.cli.run(['session', 'list', '--format', 'json', '--max-count', '500'], project, 2 * 1024 * 1024));
    if (!Array.isArray(value) || value.length > 500) throw new Error('OpenCode 会话列表格式无效');
    const items: NativeCandidate[] = [];
    for (const row of value) {
      if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id) || row.parentID || !await matchesProject(row.directory ?? row.location?.directory, project)) continue;
      const modified = row.updated ?? row.time?.updated;
      if (typeof modified !== 'number' || !Number.isFinite(modified) || Math.abs(modified) >= 8.64e15) continue;
      items.push({ nativeSessionId: row.id, title: typeof row.title === 'string' && row.title.trim() ? row.title.slice(0, 200) : row.id, path: null, modified, updatedAt: new Date(modified).toISOString() });
    }
    return [...new Map(items.sort((a, b) => b.modified - a.modified).map(item => [item.nativeSessionId, item])).values()];
  }
  async history(id: string, project: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('无效的 OpenCode 会话 ID');
    let value;
    try { value = JSON.parse(await this.cli.run(['session', 'export', id], project)); }
    catch { value = JSON.parse(await this.cli.run(['export', id], project)); }
    const history = await parseOpenCodeHistory(value, project, null);
    if (history.nativeSessionId !== id) throw new Error('OpenCode 返回的会话 ID 与选择不一致');
    return history;
  }
  close() { return this.cli.close(); }
}
