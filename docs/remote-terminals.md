# 可观察的远程终端与 MCP

AgentBerth 让 Agent 操作用户正在观看的同一个真实 SSH 终端。目录、环境变量和交互程序在当前连接中连续保持，终端画面直接来自 SSH 的 PTY 输出。

## 开始使用

1. 本机需要 OpenSSH 客户端。在系统终端配置主机别名，例如 `ascend-dev`，确认 `ssh ascend-dev` 能通过密钥或 SSH Agent 登录，并完成首次主机密钥确认。沿用 SSH 配置的端口、IdentityFile、ProxyJump，不复制私钥或发给模型。此版本不弹出密码或交互式 MFA 输入。
2. 远端只需 SSH 服务和系统已有的登录 Shell。无需安装 tmux、Bash、Python、Node、额外工具、脚本或常驻代理。POSIX Shell 可自动识别命令完成；其他登录 Shell 使用真实终端的读屏和按键模式。禁止远程命令或 PTY 的受限 SSH 账号不适用。
3. 在左侧项目上右键 → 新建会话 → 运行位置选择 **远程 SSH · 实时终端**。选择或输入主机别名。远端目录可留空使用登录目录；可选绝对目录适用于 POSIX Shell。
4. 打开 **设置 → Agent 远程终端 · MCP → 复制 MCP 配置**，加入 Agent 客户端的 MCP 配置。JSON 包含本机 Electron 路径、随软件打包的 MCP 程序、数据目录及 `ELECTRON_RUN_AS_NODE=1`，不需要另装本机 Node.js 或 npm 包。客户端使用 TOML 时保留 command、args、env 对应内容。
5. 启动会话，点击 **交给 Agent**。Agent 使用 `terminal_list` 选中该会话。用户仍可滚动、选中、复制和查找；点击 **接管** 即可收回输入权，当前任务继续运行，不会自动发送 Ctrl+C。

项目仍是本机分组。第一版文件树、预览、Git 和资源统计用于本机目录，不把远端路径当成本机文件，也不采集远端 CPU/内存。

## 命令、长任务和交互程序

POSIX Shell 的 `terminal_execute` 将命令及完成标记直接送入当前 Shell。标记只用 Shell 内建的 printf、eval 等，不上传文件或依赖提示符钩子；辅助包装也会真实显示在终端。目录和 export 保持有效。每个新命令生成 UUID requestId，重试复用原 ID，避免重复执行。返回 actionId 用于 `terminal_wait`，completed 才有已确认的退出码。不能根据安静的画面或超时推断成功。

后台按事件等待，单次最长 30 秒。工具返回 running 后，继续等待同一 actionId，不重新启动命令。部分 MCP 客户端不能由后台事件自动唤醒模型，仍需后续有界等待；任务不会因一次等待超时而中断。

对于 vim、top、其他非 POSIX 登录 Shell，使用 `terminal_screen` 与 `terminal_keys`。输入回到提示符后，phase 可能为 unknown；先读屏确认空闲提示符，POSIX Shell 下一次 execute 显式传 `atPrompt: true`。不要为了探测提示符擅自发送 Enter。Ctrl+C 明确中断前台任务，未能收到完成标记的命令保留 unknown。执行 exit、替换 Shell 或程序接管终端也可能无法获得退出码，不得自动重放。

## 连接生命周期

- 关闭主窗口、收起终端、MCP 等待超时：本机后台保持同一条 SSH 连接。
- MCP 客户端退出：释放输入权给人，已提交命令继续运行。
- SSH 链路中断：待确认结果标记 unknown，不自动重连或重放。点击 **重新连接（新 Shell）** 会明确建立新的登录 Shell，输入权交回用户。
- 本机后台退出或崩溃：SSH 连接不再由 AgentBerth 保持。重启后无法接回旧 Shell；再次启动建立新连接，旧操作结果仍为 unknown。
- 左侧“停止终端”、托盘“退出”：关闭本机 SSH。SSH 服务通常会结束对应 Shell，但脱离连接、忽略挂断信号或自行托管的远端进程可能继续运行，需在远端另行确认。

在远端不部署进程托管组件的前提下，普通 SSH 无法承诺链路断开后恢复同一进程，也无法仅通过断开连接确认所有远端任务都已停止。

## 操作步骤

顶部“操作步骤”默认折叠，记录命令、Agent 输入、控制权和连接变化；每页 50 条，每会话保留最近 1000 条。命令去重账本独立于可见步骤上限，淘汰旧步骤不会导致命令重放。旧 run 和当前 run 分开识别。

这不是模型内部推理或完整 TUI 录像。第一版文件修改通过可见终端命令进行，没有独立远程文件传输工具；步骤不会拆解脚本内部的每个动作。

提供给 Agent 的说明：[remote-terminal-agent.md](remote-terminal-agent.md)。
