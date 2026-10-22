# AgentBerth Remote Terminal — Agent 操作说明

你通过 AgentBerth MCP 操作用户正在观看的同一个真实远程终端。遵循用户指定的主机、目录与会话，所有远程操作使用此 MCP；不要同时使用 ssh-skill、直接 ssh、另一个 Shell 或隐藏的后台执行路径绕过共享终端。

1. `terminal_list`：查找用户指定的会话。记录 sessionId、当前 runId、主机、连接状态和控制权。不要猜测 ID。会话需要用户在桌面中创建、启动；MCP 不提供自动创建或自授权工具。
2. `terminal_screen`：读取真实屏幕、光标和当前状态。Agent 需要输入时，owner 必须是 agent；否则说明用户接管或尚未授权，请等待用户点击“交给 Agent”。不要用其他工具抢回控制权。
3. `terminal_execute`：仅在 phase=idle 的 Bash 提示符执行单行命令。每个新命令生成一个 UUID requestId，同一命令的请求重试复用该 ID。cwd、export、虚拟环境状态在同一 Shell 连续保留。命令本身会显示在用户的终端中。
4. `terminal_wait`：用 execute 返回的 actionId 等待结果。单次 timeoutMs<=30000，返回 running 后继续等待同一个 actionId；不要重复执行命令。completed 的 exitCode 才是已确认的结果。unknown 表示无法确认，不等于失败，更不允许自动重放有副作用的命令。
5. `terminal_keys`：处理 TUI 或命令的交互输入。每次先读屏，再发送 text 或一个 named key，二选一。Enter 提交输入；Ctrl+C 明确中断当前前台任务。按键操作不自动重试，避免重复按键。对于未知状态先读屏，只有确认是空闲提示符才发送 Enter 来刷新 Shell 标记。
6. `terminal_actions`：按 sequence 翻页查看实际操作步骤。before 使用上一页最小 sequence。列表可能包含先前 run 的记录，按 runId 区分；历史不能替代当前屏幕。

重要约束：

- 超时、工具取消、客户端断开不停止远端任务。工具取消可能释放 Agent 输入权；重新连接后读取状态，等待用户重新交还。
- 同一个远程终端只允许一个 Agent 客户端输入。并行任务使用不同的、由用户建立的终端，不能向一个 Shell 混写多个命令。
- SSH 断线由后台恢复原 tmux 会话。不要重新提交已接收的命令，也不要把“没输出”当作完成。
- 用户接管后你仍可读取屏幕和等待已提交的任务，但不能继续输入。人工接管不会中断正在运行的命令。
- 不改变终端尺寸以适应模型输出；尺寸由用户界面统一管理。
- 工具能显示命令和输入输出，不代表知道程序内部所有动作。需要了解文件变化时执行可见的 diff/status 等检查；不编造操作或成功结果。
- 切换到 TUI 后优先读当前渲染画面，普通文本日志不能代表最新 TUI 状态。
- 不覆盖 Bash PROMPT_COMMAND、DEBUG trap 和 AgentBerth 的 __ab_* 钩子。若用户环境导致钩子失效，说明限制并通过读屏/按键进行交互，不能伪造退出码。
