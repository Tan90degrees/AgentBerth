import type { Agent, TerminalConfig } from '../shared/protocol';

export const agentNames: Record<Agent, string> = { shell: '普通终端', codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', custom: '自定义 Agent' };
export const terminalNames: Record<TerminalConfig['profile'], string> = { auto: '系统默认', powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', cmd: 'CMD', bash: 'Bash / Git Bash', custom: '自定义终端' };
export const statusNames: Record<string, string> = { running: '运行中', stopping: '停止中', exited: '已退出', stopped: '已停止', failed: '启动失败', interrupted: '曾中断' };
