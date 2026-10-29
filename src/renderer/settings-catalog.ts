import type { AgentDefinition, Settings } from '../shared/protocol';

export const settingsCategories = [
  { id: 'common', label: '常用设置' }, { id: 'all', label: '全部设置' },
  { id: 'pet', label: '桌宠' }, { id: 'appearance', label: '外观' }, { id: 'preview', label: '文件预览' },
  { id: 'skills', label: 'Skills' }, { id: 'terminal', label: '终端' }, { id: 'agents', label: 'Agent' },
  { id: 'ssh', label: 'SSH 连接' }, { id: 'mcp', label: 'MCP' },
  { id: 'backend', label: '后台服务' }, { id: 'about', label: '关于与支持' },
] as const;
export type SettingsCategory = typeof settingsCategories[number]['id'];
export type SettingsEntry = { id: string; category: SettingsCategory; title: string; keywords: string; common?: boolean; field?: keyof Settings };
export function settingsCatalog(agents: AgentDefinition[], apiVersion: number): SettingsEntry[] {
  return [
    { id: 'pet', category: 'pet', title: '桌宠', keywords: 'desktop pet mascot agent hook 执行 状态 动画 gif 自定义 形象 多会话 切换 置顶 大小 缩放 隐藏 自动 配置 教程 复制 指南' },
    { id: 'theme', category: 'appearance', title: '外观主题', keywords: 'theme color 深色 浅色 跟随系统 配色', common: true },
    { id: 'preview', category: 'preview', title: '文件预览', keywords: 'font 字体 字号 字体大小 大小 size Markdown md JSON YAML 代码 高亮 Git diff 自定义 字体名称' },
    { id: 'shell', category: 'terminal', title: '默认终端', keywords: 'shell profile powershell pwsh cmd bash zsh 程序 路径 启动参数 运行环境', common: true, field: 'terminal' },
    { id: 'terminal-font', category: 'terminal', title: '终端字号', keywords: 'terminal fontSize font 字体大小 字体 大小 size', common: true, field: 'fontSize' },
    { id: 'local-limit', category: 'terminal', title: '本机终端上限', keywords: 'maxActiveTerminals 本地 并发 数量 最大 限制 容量 后台', common: true, field: 'maxActiveTerminals' },
    { id: 'default-agent', category: 'agents', title: '默认 Agent', keywords: `defaultAgent defaultCommand 默认启动命令 自定义 Codex Claude OpenCode shell ${agents.map(value => value.name).join(' ')}`, common: true, field: 'defaultAgent' },
    { id: 'ssh-limit', category: 'ssh', title: 'SSH 会话上限', keywords: 'maxSshTerminals 远程 并发 数量 最大 限制 容量', common: true, field: 'maxSshTerminals' },
    { id: 'skills', category: 'skills', title: 'Skill 管理', keywords: 'skill skills SKILL.md 技能 导入 安装 停用 启用 查看 编辑 移除 私有 自定义 目录 项目 全局 Claude Codex OpenCode' },
    { id: 'agent-types', category: 'agents', title: '自定义 Agent 类型', keywords: `导入 配置 插件 plugin 扩展 更新 热更新 开发 指南 文档 套件 重命名 删除 history 历史 resume 恢复 ${agents.map(value => value.name).join(' ')}` },
    ...(apiVersion >= 22 ? [{ id: 'connections', category: 'ssh' as const, title: '服务器信息', keywords: 'ssh server host hostname IP 连接 别名 用户名 密码 私钥 身份 登录 authentication 端口 port 地址 新建 编辑 删除' }] : []),
    ...(apiVersion >= 21 ? [{ id: 'mcp', category: 'mcp' as const, title: 'Agent 远程终端 · MCP', keywords: '复制 配置 说明 远端 工具 文件 传输 上传 下载 协议 连接 Agent' }] : []),
    { id: 'backend', category: 'backend', title: '后台服务', keywords: 'daemon restart 更新 后台 重启 API 运行' },
    { id: 'about', category: 'about', title: '关于与支持', keywords: 'about version 版本 系统 环境 diagnostics 复制诊断信息 打开 诊断 日志 数据目录 使用说明 反馈 帮助' },
  ];
}
export function filterSettings(entries: SettingsEntry[], query: string, category: SettingsCategory): SettingsEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => (category === 'all' || category === 'common' ? category === 'all' || entry.common : entry.category === category)
    && words.every(word => `${entry.title} ${entry.keywords} ${settingsCategories.find(value => value.id === entry.category)?.label}`.toLocaleLowerCase().replace(/\s+/g, '').includes(word)));
}
