# AgentBerth Remote Terminal — Agent 操作说明

你通过 AgentBerth MCP 操作用户正在观看的同一个真实远程终端。遵循用户指定的主机、目录和会话；不要用 ssh-skill、直接 SSH、另一个 Shell 或隐藏执行路径绕过共享终端。远端只需要现有 SSH 服务和登录 Shell，不要求用户安装组件。

1. `terminal_list`：找到用户指定的会话，读取 sessionId、当前 runId、主机、连接、控制权和 commandTracking。会话由用户在桌面创建并启动；MCP 不提供自授权工具。
2. `terminal_screen`：读当前真实画面、光标和状态。输入要求 owner=agent；用户接管后等待重新授权，不能抢回控制权。
3. `terminal_execute`：commandTracking=posix 且 phase=idle 时执行单行命令。phase=unknown 时先读屏，只有确认空闲 Shell 提示符才传 `atPrompt: true`。每个新命令生成 UUID requestId，同一请求重试复用该 ID。目录、export 和虚拟环境在当前 Shell 连续保持；命令及标记包装会显示在终端。
4. `terminal_wait`：用 execute 返回的 actionId 等待。单次 timeoutMs<=30000，running 后继续等待相同 ID。completed 的 exitCode 才是已确认结果；unknown 不是失败，不允许自动重放有副作用的命令。
5. `terminal_keys`：读屏后发送 text 或一个 named key，二选一。用于 TUI 和 commandTracking=none 的登录 Shell。Enter 提交输入，Ctrl+C 明确中断前台任务。按键不自动重试，避免重复输入；不为探测状态擅自发送 Enter。
6. `terminal_actions`：按 sequence 翻页，before 取上一页最小 sequence。历史含先前 run，以 runId 区分；不能代替当前读屏。

约束：

- 一次等待超时、取消、MCP 断开不停止任务；客户端断开释放输入权。重连 MCP 后重新读取状态，等待用户交还输入权。
- 一个终端只有一个 Agent 写入。并行任务使用用户创建的不同终端，不向一个 Shell 混写命令。
- SSH 链路断开不会恢复原进程。用户重新连接会建立新 Shell，旧操作仍是 unknown，不自动重放命令；先检查任务是否仍在远端运行。
- 用户接管后仍可读屏、等待已提交任务；禁止继续输入。接管不代表中断当前命令。
- 不改变用户终端尺寸。TUI 使用当前画面，文本历史不能代表最新状态。
- POSIX 完成标记不依赖 Bash 钩子。执行 exit、替换 Shell、禁用回显或接管输入可能无法得到完成标记；按读屏/按键处理，不编造退出码。
- 停止终端关闭 SSH，不能确认远端自行脱离连接的任务已结束。需要确认时通过用户授权的可见终端检查实际进程。
