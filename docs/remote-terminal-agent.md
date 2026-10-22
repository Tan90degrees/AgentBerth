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

1. `terminal_execute` 在 commandTracking=posix 且 phase=idle 时直接执行单行命令；已知 idle 不必先读屏。返回同一对象中的 `id`、`status`、`exitCode`、`info` 和 `output`，普通命令一次调用就能获得结果。phase=unknown 时才先读屏确认空闲提示符，并传 atPrompt=true。每条新命令生成 UUID requestId，重试原样复用，不重放 unknown 操作。目录、export 和虚拟环境保持在同一个 Shell。
2. `status=completed` 且 `output.hasMore=false` 时已经获得完整的缓存结果，不再调用 wait/screen 验证。`terminal_execute` 默认最多等待 1000 ms（waitMs 可选 0..25000），完成即返回；waitMs=0 立即提交。`requestMs` 是本次后台请求耗时，`elapsedMs` 是命令从提交开始的持续时间，均不包含模型推理和客户端调度。
3. 长任务和流式日志用 `terminal_read_output({"alias":"dev-server","actionId":"<execute 返回的 id>","cursor":<output.nextCursor>,"timeoutMs":25000})`。有新增输出、完成、结果未知或缓存缺失立即返回；没有新输出时按事件等待，最长 30000 ms，不能写 sleep 或频繁轮询读屏。每次原样传回 output.nextCursor，同一游标只用于同一个 actionId/runId。`output.hasMore=true` 时先继续取剩余分页。只有 status=completed 才有已确认的退出码，安静、空输出和超时不代表完成。
4. 只关心最终完成时可用 `terminal_wait`，同样返回输出和 info，cursor/maxChars 参数与增量读取一致。它等待完成而非等待新日志；持续输出的任务优先用 read_output。
5. TUI 和 commandTracking=none 的 Shell 使用 `terminal_screen` 与 `terminal_keys`。读屏后才发 text 或 named key；Enter 提交，Ctrl+C 明确中断。不为探测提示符擅自发送 Enter，也不自动重试按键。
6. `terminal_actions` 按 sequence 翻页，before 取上一页最小 sequence。包含命令、连接、控制和传输记录，不代替当前读屏。所有后续工具可传 alias 或 sessionId/runId；多个运行会话必须用 ID。

输出是命令开始标记和完成标记之间的共享终端文本，不包含注入的命令回显和结束提示符；stdout/stderr 已由 PTY 合并，可能包含 ANSI、回车或后台程序交错输出，不可作为 TUI 画面替代。maxChars 默认 16384、范围 256..32768，分页不切断完整 Unicode 字符。

缓存只在内存中保留每会话最近 8 条命令、每条最近 128K 个 UTF-16 编码单元；不是永久日志。`output.truncated=true` 表示游标之前的部分已丢失，`available=false` 表示命令缓存已淘汰/不可用，不能把空文本当作命令没有输出，也不能为找回输出重新执行命令。后续 cursor 从返回的 nextCursor 继续。更新后台到 **API 28** 并重新连接 MCP 后使用，共 18 个工具。

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
