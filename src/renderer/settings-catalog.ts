import type { AgentDefinition, Settings } from '../shared/protocol';

// Only host-wide preferences belong to core settings. Plugin configuration
// never appears in this catalog or its search results.
export const settingsCategories = [
  { id: 'common', label: '常用设置' }, { id: 'all', label: '全部设置' },
  { id: 'terminal', label: '终端' },
  { id: 'backend', label: '后台服务' }, { id: 'about', label: '关于与支持' },
] as const;
export type SettingsCategory = typeof settingsCategories[number]['id'];
export type SettingsEntry = { id: string; category: SettingsCategory; title: string; keywords: string; common?: boolean; field?: keyof Settings };
export function settingsCatalog(_agents: AgentDefinition[], _apiVersion: number): SettingsEntry[] {
  return [
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
    && words.every(word => `${entry.title} ${entry.keywords} ${settingsCategories.find(value => value.id === entry.category)?.label}`.toLocaleLowerCase().replace(/\s+/g, '').includes(word)));
}
