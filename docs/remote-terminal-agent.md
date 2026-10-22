# AgentBerth Remote Terminal — Agent 操作说明

用户只需保存服务器别名、地址、用户名和登录方式。你通过 AgentBerth MCP 管理 SSH 会话并操作用户正在观看的真实终端；不要用直接 SSH 或另一个执行器绕过该终端。不要向工具传入密码或私钥内容。

## 会话管理

- `terminal_list` 列出已保存服务器和会话。服务器信息由用户维护，不需要用户手动新建会话。
- `terminal_open({"alias":"dev-server"})` 按别名打开或复用会话。重复调用不会产生新终端，也不会夺回人工控制或自动修复断线。
- `terminal_create({"alias":"dev-server","title":"build","directory":"/workspace/app"})` 创建并打开命名会话；相同服务器和名称会复用，其他名称可并行运行。directory 可省略。同名会话的目录不同会报错。
- `terminal_update({"sessionId":"…","runId":"…","title":"new name"})` 改名。修改 directory 前先关闭 SSH 会话。
- `terminal_close` 关闭 SSH 并保留会话及工作台记录。`terminal_delete` 删除已停止会话及其工作台记录，不删除服务器配置或远端文件。
- `terminal_reconnect` 明确建立一个新 Shell；不会恢复原进程、目录变量或重放旧操作。
- 管理工具可用 alias 或 sessionId；运行中使用 ID 时同时提供 runId。一个服务器有多个会话时，修改、关闭、删除使用明确的 sessionId/runId。

用户接管后不可继续输入、管理或开始新的传输，不能靠 open/create/reconnect 绕过接管。服务器需允许 Agent 打开；默认不改动登录信息。

## 命令与交互

1. `terminal_screen` 读取当前画面、光标和状态。后续工具可用 alias 或 sessionId/runId，二选一；多个运行会话必须用 ID。
2. `terminal_execute` 在 commandTracking=posix 且 phase=idle 时执行单行命令。phase=unknown 时先读屏，确认空闲 Shell 提示符后才传 atPrompt=true。新命令生成 UUID requestId，重试复用原 ID。目录、export 和虚拟环境保持在同一个 Shell。
3. `terminal_wait` 用 execute 返回的 actionId 等待，单次 timeoutMs<=30000。running 后继续等待相同 ID；completed 的 exitCode 才是已确认结果。unknown 不代表失败，不能自动重放有副作用的命令。
4. `terminal_keys` 在读屏后发送 text 或一个 named key，二选一。用于 TUI 和 commandTracking=none 的登录 Shell。Enter 提交输入，Ctrl+C 明确中断前台任务；按键不自动重试，不为探测状态擅自发送 Enter。
5. `terminal_actions` 按 sequence 翻页，before 取上一页最小 sequence。包含命令、连接、控制和传输记录，不代替当前读屏。

命令包装只用于内部识别开始、退出码和工作目录。已确认的包装回显会替换成原始命令，实际程序输出保留；遇到无法确认的 Shell 重绘或交错输出时保留原始数据，避免误删日志。

## 文件传输

文件走同一 SSH 登录连接的独立 SFTP 通道，不经过终端输入，不中断正在运行的 Shell/TUI，也不要求远端安装 Python、Node、rsync 或代理。SSH 服务需启用标准 SFTP 子系统。系统 SSH 配置兼容会话尚不支持此接口，先由用户填写服务器信息。

- `terminal_upload({"alias":"dev-server","requestId":"<UUID>","localPath":"<本机绝对路径>","remotePath":"/tmp/app.bin"})`
- `terminal_download({"alias":"dev-server","requestId":"<UUID>","remotePath":"/tmp/result.bin","localPath":"<本机绝对路径>"})`
- `terminal_transfer({"requestId":"<UUID>","sourceAlias":"dev-server","sourcePath":"/data/file.bin","destinationAlias":"backup-server","destinationPath":"/backup/file.bin"})`

服务器间传输也可传 sourceSessionId/sourceRunId 和 destinationSessionId/destinationRunId，分别替代对应 alias。数据通过本机有界流转发，不落地中转文件，也不转发 SSH Agent。

路径是完整目标路径，不自动追加源文件名。本机路径遵循当前系统格式，Windows 使用本机盘符路径；远端一律使用 POSIX 绝对路径。目录需 recursive=true，最多 10000 个条目和 64 层，不跟随符号链接；目标父目录会按需创建。

传输返回后台任务，id 等于 requestId。使用 `terminal_transfer_status({"requestId":"…","timeoutMs":25000})` 事件式等待，或 timeoutMs=0 立即读状态。工具不返回文件内容。进度和最终状态会显示在 SSH 面板。MCP 超时、断开或用户接管不自动取消已经提交的传输；`terminal_transfer_cancel` 可明确取消。用户也可直接在面板取消传输。

默认不覆盖目标。明确允许覆盖时传 overwrite=true；已知中断文件需要 resume=true，续传前会通过流式 SHA-256 核对已有前缀。resume 与 overwrite 不能同时使用。失败、取消或断线可能留下部分文件；unknown 表示结果未确认，先检查状态。复用原 requestId 只查询原任务，不会重新复制；显式续传需新 requestId，不能循环重试覆盖。

## 生命周期

- 主窗口关闭、面板收起、MCP 等待超时：后台保持 SSH 和已提交任务。
- MCP 断开：释放输入权，既有任务继续；重新连接后读取状态并等待用户交还控制权。
- SSH 真正断线：不恢复或重放原任务。明确重连会新建 Shell；远端自行脱离连接的进程可能仍在运行。
- 停止 SSH 或托盘退出：取消对应传输并关闭本机 SSH。关闭连接不等于确认所有远端进程均已停止。
- 不改变用户终端尺寸，不用静默时间判断 TUI 是否完成。
