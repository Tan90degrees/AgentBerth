/** Explicit shell choice makes paths with spaces work under Windows Git Bash as well. */
function hookCommand(executable: string, script: string, directory: string, platform: NodeJS.Platform, event?: string) {
  const quoteSh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const quotePs = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  return platform === 'win32'
    ? `$env:ELECTRON_RUN_AS_NODE='1'; ${event ? '' : '$input | '}& ${quotePs(executable)} ${quotePs(script)} --data-dir ${quotePs(directory)}${event ? ` --event ${quotePs(event)}` : ''}; exit 0`
    : `ELECTRON_RUN_AS_NODE=1 ${quoteSh(executable)} ${quoteSh(script)} --data-dir ${quoteSh(directory)}${event ? ` --event ${quoteSh(event)}` : ''}`;
}
export function petHookConfiguration(executable: string, script: string, directory: string, platform = process.platform) {
  const command = hookCommand(executable, script, directory, platform);
  const handler = { type: 'command', command, timeout: 3, onFailure: 'continue', ...(platform === 'win32' ? { shell: 'powershell' } : {}) };
  return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'].map(event => [event, [{ hooks: [handler] }]])) };
}

/** Copyable instructions use this installation's paths, never credentials or run IDs. */
export function petHookSetupGuide(executable: string, script: string, directory: string, platform = process.platform): string {
  return `# 自动配置 AgentBerth 桌宠 hook

请直接为我当前使用的 Agent 完成 hook 配置和验证，而不是只给我手工操作步骤。
桌宠仅展示 AgentBerth 的本机 Agent 会话；普通 Shell、SSH 远程终端不展示，也不接收状态 hook。

## 当前安装
- 平台：${platform}
- 应用运行时：${JSON.stringify(executable)}
- hook 脚本：${JSON.stringify(script)}
- 数据目录：${JSON.stringify(directory)}
使用应用自带运行时，不需要另外安装 Node.js。路径已经按本机平台转义，请保留引号。

## 配置流程
1. 识别当前 Agent 和版本，检查它实际支持的事件 hook 格式。优先配置当前项目的本地设置；用户已指定全局范围时采用全局设置。不要修改系统或组织策略。
2. 编辑前备份已有配置；保留所有其他配置和原有 hook。将下面的处理器追加到对应事件，按命令去重；重复执行本教程不能添加重复处理器。配置有语法错误时先报告具体位置，不得清空重建。写入后重新解析并检查格式。
3. Claude Code 可将下方 JSON 合并到当前项目 .claude/settings.local.json；全局范围使用 ~/.claude/settings.json。先核对版本兼容性（onFailure 需要 v2.1.295+）；不支持的字段按该版本官方格式适配，保持失败不阻塞。不要将 hooks 整体覆盖，更不要调整 permissions 或关闭权限确认。
4. 如果是其他 Agent，按其实际支持的事件使用下方通用命令。不要把 Claude 的配置直接写进其他 Agent 配置；没有 hook 能力时明确报告不支持，不要用屏幕内容猜测状态，也不要伪装成功。
5. hook 子进程必须继承 AGENTBERTH_DATA_DIR、AGENTBERTH_SESSION_ID、AGENTBERTH_RUN_ID，由 AgentBerth 在启动本机 Agent 会话时注入。不得将当前会话 ID、运行 ID 固定写入配置，也不要读取或导出 pet-hook.json 的 token。

## Claude Code 配置片段
官方格式参考：https://code.claude.com/docs/en/hooks
\`\`\`json
${JSON.stringify(petHookConfiguration(executable, script, directory, platform), null, 2)}
\`\`\`

## 其他 Agent / 私有 TUI
可把事件 JSON 通过 stdin 传给脚本（event 或 hook_event_name），也可以给每个生命周期事件注册以下命令。${platform === 'win32' ? '这些命令使用 PowerShell，必须指定 PowerShell 执行。' : '这些命令使用 POSIX Shell。'}
${(['working', 'waiting', 'completed', 'error', 'idle'] as const).map(event => `- ${event}: ${hookCommand(executable, script, directory, platform, event)}`).join('\n')}
开始处理/工具执行映射 working；需要用户输入或授权映射 waiting；本轮完成映射 completed；本轮失败映射 error；会话初始化/结束映射 idle。子 Agent 完成不能当作整个会话完成。只发送状态，不传 prompt、工具参数、命令输出或密码。hook 使用短超时，失败继续；脚本静默失败不影响 Agent，不要加入阻断决策。

## 验证与交付
- 先检查实际配置文件语法、重复项、脚本和运行时是否存在，以及命令的路径引号。
- 当前进程若没有三个 AGENTBERTH 环境变量，提示我从 AgentBerth 启动/重新启动一个 Agent 类型会话。不要替我停止正在执行的任务或重启整个后台；外部终端和 SSH 无法用于此次绑定验证。
- 在正确的 Agent 会话内触发一次真实工具调用和一次真实完成事件，右键桌宠查看当前 Agent 和状态，确认对应会话收到 hook；需要诊断时给脚本增加 --verbose（Windows 放在分号 exit 0 之前）。脚本失败也返回 0，因此不能仅用退出码判断接入成功。未验证时明确标记“配置已写入，待重启/验证”，不要伪称成功。
- 最后告诉我修改了哪个配置、备份位置、已注册的事件、验证结果，以及是否需要重新启动 Agent 会话。
`;
}
