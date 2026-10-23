# AgentBerth Remote Terminal — 内置 MCP 契约参考

日常使用只需配置 MCP 并描述任务，**无需将本文复制给 Agent**。初始化指引、工具说明、标准注解和结果中的 `harness` 会自动提供操作约束；本文是可选参考，也通过 `agentberth://guide/remote-terminal` MCP 资源按需提供。

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

1. `terminal_execute` 在 commandTracking=posix 且 phase=idle 时直接执行命令（支持换行、Tab 和多行脚本，最多 16384 字符）；已知 idle 不必先读屏。返回同一对象中的 `id`、`status`、`exitCode`、`info` 和 `output`，普通命令一次调用就能获得结果。phase=unknown 时才先读屏确认空闲提示符，并传 atPrompt=true。普通调用只需 alias 和 command，MCP 会打开或复用已授权的连接；requestId 可省略，由工具生成并返回为 id。需要显式重试去重时传 UUID requestId，重试原样复用；传输失败会在错误中给出 ID，不以新 ID 重放 unknown 操作。目录、export 和虚拟环境保持在同一个 Shell。
2. `allOutputInThisResponse=true` 时，本次响应已包含本轮完整的已捕获输出；默认直接使用有界结果，不再调用 wait/screen 验证，也不因该标记为 false 自动读完缓存。`terminal_execute` 默认最多等待 5000 ms（waitMs 可选 0..25000），完成即返回，首段输出后最多合并等待 75 ms 以接收短命令退出码，持续输出的命令先返回首段，不等满上限；waitMs=0 立即提交。`requestMs` 是本次后台请求耗时，`elapsedMs` 是命令从提交开始的持续时间，均不包含模型推理和客户端调度。
3. 长任务和流式日志用 `terminal_read_output({"alias":"dev-server","actionId":"<execute 返回的 id>","cursor":<output.nextCursor>,"timeoutMs":25000})`。有新增输出、完成、结果未知或缓存缺失立即返回；没有新输出时按事件等待，最长 30000 ms，不能写 sleep 或频繁轮询读屏。每次原样传回 output.nextCursor，同一游标只用于同一个 actionId/runId。默认 mode=summary，每次只返回该游标之后的有界首尾摘要并推进到当前末尾，不回读省略的中间内容。只有 status=completed 才有已确认的退出码，安静、空输出和超时不代表完成。
4. 只关心最终完成时可用 `terminal_wait`，同样返回输出和 info，mode/cursor 参数与增量读取一致。它等待完成而非等待新日志；持续输出的任务优先用 read_output。
5. TUI 和 commandTracking=none 的 Shell 使用 `terminal_screen` 与 `terminal_keys`。读屏后才发 text 或 named key；text 默认一次发送文本和 Enter，不再单独调用 Enter；只有显式 enter=false 才不提交（例如输入 TUI 搜索框、补全文本）。命名 key 始终只发送一次，不会附带额外 Enter。Ctrl+C 明确中断。不为探测提示符擅自发送 Enter，也不自动重试按键。
6. `terminal_actions` 按 sequence 翻页，before 取上一页最小 sequence。包含命令、连接、控制和传输记录，不代替当前读屏。所有后续工具可传 alias 或 sessionId/runId；多个运行会话必须用 ID。

**不要用 clear 获取输出。** 终端高度、滚动和清屏只影响人看的画面；execute 返回本轮命令输出，不把整个终端历史塞入上下文。

默认限长与 [ssh-skill](https://github.com/badseal/ssh-skill/tree/c6c8a184a7d8c8b217860a015f5860418647d8ea) 一致：输出最多 **256 KiB / 4000 行**，字节预算中尾部保留 **64 KiB**。超过任一限制时保留首尾，返回 `totalBytes`、`totalLines`、`returnedBytes` 和 `omitted`。这里的摘要是截取原文，不是模型总结，不插入虚构日志。完整工具结果 JSON（包含转义、元数据和列表）还有 **256 KiB** 总上限，进一步裁剪时返回 `resultLimit`。中文等字符转义后可能提前触发此总上限。

**不要为了“完整性”自动读完所有分页。** 默认 `mode=summary`；完成的命令没有自动续读入口，`continuation` 仅用于运行中的新增输出。`details` 是任务确需细节时才使用的可选入口；显式 `mode=page` 可读本机保留的明细，maxChars 默认 32768、范围 256..65536，不切断完整 Unicode 字符。JSON 总预算进一步裁剪分页时，details 会指向同一页起点的较小读取。每次响应仍有总上限。

输出是命令开始和完成标记之间的共享终端文本，不包含注入的命令回显和结束提示符；stdout/stderr 由 PTY 合并，可能包含 ANSI、回车或后台程序交错输出，不可作为 TUI 画面替代。

本机缓存与模型上下文分开：每会话最近 8 条命令，每条保留最近 8M 个 UTF-16 编码单元（磁盘上限 16 MiB）；停止会话或重启后台清除，不是永久日志。`omitted=true` 表示按预算主动省略，`cacheLost=true` 表示游标之前的缓存实际淘汰，`available=false` 表示缓存不可用。`truncated` 可能由预算或缓存丢失引起，不能单独据此判断日志丢失。空文本也不表示命令没有输出。后续流式读取传回 nextCursor，不重新执行命令。更新后台到 **API 32** 并重新连接 MCP 后使用，共 18 个工具。

命令包装只用于内部识别开始、退出码和工作目录。已确认的包装回显会替换成原始命令，实际程序输出保留；遇到无法确认的 Shell 重绘或交错输出时保留原始数据，避免误删日志。

## 文件传输

文件走同一 SSH 登录连接的独立 SFTP 通道，不经过终端输入，不中断正在运行的 Shell/TUI，也不要求远端安装 Python、Node、rsync 或代理。SSH 服务需启用标准 SFTP 子系统。系统 SSH 配置兼容会话尚不支持此接口，先由用户填写服务器信息。

- `terminal_upload({"alias":"dev-server","requestId":"<UUID>","localPath":"<本机绝对路径>","remotePath":"/tmp/app.bin"})`
- `terminal_download({"alias":"dev-server","requestId":"<UUID>","remotePath":"/tmp/result.bin","localPath":"<本机绝对路径>"})`
- `terminal_transfer({"requestId":"<UUID>","sourceAlias":"dev-server","sourcePath":"/data/file.bin","destinationAlias":"backup-server","destinationPath":"/backup/file.bin"})`

服务器间传输也可传 sourceSessionId/sourceRunId 和 destinationSessionId/destinationRunId，分别替代对应 alias。数据通过本机有界流转发，不落地中转文件，也不转发 SSH Agent。

路径是完整目标路径，不自动追加源文件名。本机路径遵循当前系统格式，Windows 使用本机盘符路径；远端一律使用 POSIX 绝对路径。目录需 recursive=true，最多 10000 个条目和 64 层，不跟随符号链接；目标父目录会按需创建。

传输的 requestId 可省略，由 MCP 生成；返回后台任务，id 等于 requestId。使用 `terminal_transfer_status({"requestId":"…","timeoutMs":25000})` 事件式等待，或 timeoutMs=0 立即读状态。工具不返回文件内容。进度和最终状态会显示在 SSH 面板。MCP 超时、断开或用户接管不自动取消已经提交的传输；`terminal_transfer_cancel` 可明确取消。用户也可直接在面板取消传输。

默认不覆盖目标。明确允许覆盖时传 overwrite=true；已知中断文件需要 resume=true，续传前会通过流式 SHA-256 核对已有前缀。resume 与 overwrite 不能同时使用。失败、取消或断线可能留下部分文件；unknown 表示结果未确认，先检查状态。复用原 requestId 只查询原任务，不会重新复制；显式续传需新 requestId，不能循环重试覆盖。

## 生命周期

- 主窗口关闭、面板收起、MCP 等待超时：后台保持 SSH 和已提交任务。
- MCP 断开：释放输入权，既有任务继续；重新连接后读取状态并等待用户交还控制权。
- SSH 真正断线：不恢复或重放原任务。明确重连会新建 Shell；远端自行脱离连接的进程可能仍在运行。
- 停止 SSH 或托盘退出：取消对应传输并关闭本机 SSH。关闭连接不等于确认所有远端进程均已停止。
- 不改变用户终端尺寸，不用静默时间判断 TUI 是否完成。


## 最少调用示例

```json
{"name":"terminal_execute","arguments":{"alias":"dev-server","command":"uname -a"}}
```

已完成就直接使用有界结果；仅任务确需明细时才主动分页，不调用 screen、wait、Enter 或 clear。

```json
{"name":"terminal_keys","arguments":{"alias":"dev-server","text":"yes"}}
{"name":"terminal_keys","arguments":{"alias":"dev-server","text":"search text","enter":false}}
```

MCP 负责已有 SSH 连接、共享 PTY、去重和结果游标；本说明可以作为 Agent 的工作指导，与 MCP 配合使用。改为另开 SSH 或 HTTP 不会减少模型调度开销，还会失去同一终端的现场。不要每条命令执行连接探测或列表查询；复用已知目标和上一条返回的 info。需要批量获取同一主机的相关只读信息时，可在一个 command 中用分号或换行组织。


## 终端只显示了列表下半部分时

`terminal_screen` 返回 `scope=viewport`，只描述人当前能看到的画面，**不是完整命令结果**。普通的 `docker images`、`ls`、`ps` 等应使用 `terminal_execute`；不要根据屏幕行数重新运行原命令、修改排序或 clear 来“找回”上半部分。

1. 普通命令直接使用 execute 已返回的有界结果。读屏的可选 `details` 从该命令 cursor=0 取首尾摘要；不自动读取全部缓存。
2. 如果没有记住命令 ID，且任务确需结果，可调用 `terminal_read_output({"alias":"dev-server"})` 读取最近可靠关联的命令摘要。后续游标必须与明确 actionId 一起使用。
3. `scope=command` 才是按命令捕获的结果。`allOutputInThisResponse=false` 可能表示预算省略、运行中或非零起点；不等于需要读完所有分页。运行中按 continuation 读取新增有界输出，完成后不自动续读。
4. 从已确认空闲的 POSIX Shell 用 `terminal_keys` 一次提交完整文本时，会自动走同样的命令捕获通道并返回 id/output；输入给正在运行的程序、命名按键和 enter=false 仍是原始交互输入。
5. 未跟踪的人工输入、部分输入或未知提示符可能没有可靠的命令边界。这时不关联旧命令冒充新结果，会明确指出没有记录；不可自动重跑。缓存真实丢失遵循 cacheLost/available 提示，不宣称完整。

## 不依赖额外提示词的运行引导

每个工具结果提供 `harness.state` 和 `harness.next`：后者是准确的工具名及参数，或 null。它是任务需要继续时的候选步骤，不会自行执行。完成的命令 next=null；运行中的命令指向按原 ID/游标等待新增输出，日志不可用时改为等待完成，避免立即返回造成轮询。读屏之后不再自动读屏；下一次交互由当前画面与任务决定。传输同样返回准确的状态等待入口。

错误使用后端生成的稳定错误码，不根据远端输出猜测状态：USER_CONTROLLED 需用户交还输入；COMMAND_RUNNING 指向现有命令；PROMPT_REQUIRED/SHELL_UNSUPPORTED 指向读屏；STALE_RUN/ALIAS_AMBIGUOUS 指向重新选择目标。error.execution=not_started 表示被前置检查阻止，unknown 表示执行结果尚未确认。未知结果只查询原 ID，不重发操作。后端同时强制检查输入归属、单写入者、忙碌命令与运行实例，无需依赖模型记住文档。

工具说明与返回引导在客户端未注入初始化指引、未加载资源时也可使用。这里验证的是协议与状态机行为；实际工具选择仍由 Agent 客户端和模型执行。
