import type { AgentDefinition, TerminalConfig } from '../shared/protocol';

export const agentNames: Record<string, string> = { shell: '普通终端', codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', custom: '自定义 Agent' };
export const terminalNames: Record<TerminalConfig['profile'], string> = { auto: '系统默认', powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', cmd: 'CMD', bash: 'Bash / Git Bash', custom: '自定义终端' };
export const statusNames: Record<string, string> = { running: '运行中', stopping: '停止中', exited: '已退出', stopped: '已停止', failed: '启动失败', interrupted: '曾中断' };

export function agentLabels(agents: AgentDefinition[] = []): Record<string, string> { return { ...agentNames, ...Object.fromEntries(agents.map(agent => [agent.id, agent.name])) }; }

export function nextSessionTitle(agent: string, titles: string[]): string {
  const base = `${agent.slice(0, 80)} 会话`; const existing = new Set(titles);
  if (!existing.has(base)) return base;
  let n = 2; while (existing.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
