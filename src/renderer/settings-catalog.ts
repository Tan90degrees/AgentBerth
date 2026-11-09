import type { AgentDefinition, Settings } from '../shared/protocol';

export const settingsCategories = [
  { id: 'common', label: '常用设置' }, { id: 'all', label: '全部设置' },
  { id: 'appearance', label: '外观' }, { id: 'agent', label: 'Agent 与 Skills' },
  { id: 'files', label: '文件预览' }, { id: 'ssh', label: 'SSH 与 MCP' },
  { id: 'terminal', label: '终端' }, { id: 'backend', label: '后台服务' },
  { id: 'about', label: '关于与支持' },
] as const;
export type SettingsCategory = typeof settingsCategories[number]['id'];
export type SettingsEntry = { id: string; category: SettingsCategory; title: string; keywords: string; common?: boolean; field?: keyof Settings };
export function settingsCatalog(_agents: AgentDefinition[], _apiVersion: number): SettingsEntry[] {
  return [
    { id: 'appearance', category: 'appearance', title: '外观主题', keywords: 'theme appearance dark light system 深色 浅色 跟随系统', common: true },
    { id: 'ui-font', category: 'appearance', title: '界面字号', keywords: '界面 字号 缩放 ui font scale 大小 显示 布局', common: true, field: 'uiFontScale' },
    { id: 'default-agent', category: 'agent', title: '默认 Agent', keywords: 'agent provider codex claude opencode 默认接入', common: true, field: 'defaultAgent' },
    { id: 'skills', category: 'agent', title: 'Skills 管理', keywords: 'agent skill 技能 导入 管理', common: true },
    { id: 'preview', category: 'files', title: '文件预览', keywords: 'preview font 字体 字号 markdown 语法高亮', common: true },
    { id: 'ssh-limit', category: 'ssh', title: 'SSH 会话上限', keywords: 'ssh maxSshTerminals 并发 数量 容量', field: 'maxSshTerminals' },
    { id: 'connections', category: 'ssh', title: '服务器信息', keywords: 'ssh host server connection 密码 密钥 登录' },
    { id: 'mcp', category: 'ssh', title: 'Agent 远程终端 · MCP', keywords: 'ssh mcp agent remote terminal 远程工具 配置' },
    { id: 'shell', category: 'terminal', title: '默认终端', keywords: 'shell profile powershell pwsh cmd bash zsh 启动参数 环境', common: true, field: 'terminal' },
    { id: 'terminal-font', category: 'terminal', title: '终端字号', keywords: 'terminal fontSize 字体 字号 大小 size', common: true, field: 'fontSize' },
    { id: 'local-limit', category: 'terminal', title: '本机终端上限', keywords: 'maxActiveTerminals 并发 数量 容量 后台', common: true, field: 'maxActiveTerminals' },
    { id: 'backend', category: 'backend', title: '后台服务', keywords: 'daemon restart 更新 后台 重启 API 运行' },
    { id: 'about', category: 'about', title: '关于与支持', keywords: 'about version 版本 系统 环境 diagnostics 诊断 日志 数据目录 帮助' },
  ];
}
export function filterSettings(entries: SettingsEntry[], query: string, category: SettingsCategory): SettingsEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => (category === 'all' || category === 'common' ? category === 'all' || entry.common : entry.category === category)
    && words.every(word => `${entry.title} ${entry.keywords}`.toLocaleLowerCase().replace(/\s+/g, '').includes(word)));
}
