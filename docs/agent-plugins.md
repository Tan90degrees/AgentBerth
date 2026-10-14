# 自定义 Agent 与插件协议 v1

在 **设置 → 自定义 Agent 类型 → 新增 Agent 类型** 中分别保存名称和单行启动命令，例如 Aider、Gemini CLI 或同一 CLI 的不同配置。新建会话和默认 Agent 可选择任意已保存类型。最多 64 个类型，名称不重复；类型 ID 稳定，重命名保留关联。已有旧版自定义会话不变。

每个会话保存独立启动命令。编辑类型的启动命令只影响新建会话；编辑类型的历史／恢复能力影响使用此类型的会话，需先停止这些会话的终端并等待历史请求结束。类型被会话（包括旧归档）或默认设置引用时禁止删除。改变会话的 Agent 类型会清除旧原生历史关联，运行记录保留。

## 不写插件也能恢复

类型的可选恢复命令可填写 `my-agent --resume {sessionId}`。只支持 `{sessionId}` 占位符，ID 限制为 1–128 个字母、数字、下划线或连字符。关联原生会话 ID 后，在会话工具栏选择恢复。启动／恢复命令交给用户选定的 Shell；请填写该 Shell 支持的语法。

## 接入插件

启用本地扩展插件，选择程序的**完整路径**，参数填写 JSON 字符串数组。如程序为 `C:\Program Files\nodejs\node.exe`，参数为 `["D:/plugins/agent-plugin.cjs"]`；Linux 例如程序 `/usr/bin/node`，参数 `["/home/me/plugins/agent-plugin.cjs"]`。程序可以使用任何语言，只需支持下面的 stdio 协议。无需修改 AgentBerth 源码；插件代码不在 renderer 中执行。

勾选历史和／或恢复能力。历史页“刷新记录”允许插件按项目和原生 ID 自动发现记录，也可用“关联记录文件”选择 JSON/JSONL。启用恢复插件后，其返回命令优先于恢复模板。

程序在项目目录中直接启动，**不经过 Shell**，参数按数组传递。每次请求启动一个进程，stdin 为一个 JSON 对象加换行，随后 EOF；stdout 必须仅返回一个 JSON 对象，完成后退出 0，日志写 stderr。非零退出、格式错误、超时会显示错误，已保存历史保留。插件有本机程序权限，应仅配置可信的本地程序。插件应执行一次请求后退出，不创建常驻服务或脱离进程树的后台进程。

程序有 10 秒时限，stdout 与 stderr 合计最多 2 MiB，同一后台最多 4 个插件请求、同时最多 2 个历史读取；超时和退出应用会取消并清理运行中的插件进程树。历史最近最多 1000 条，每条最多 32768 字符，展示总量最多 512 KiB；选定的记录文件须小于 16 MiB。插件失败不会覆盖原有记录，也不会停止其他终端。

请求示例：

```json
{
  "version": 1,
  "method": "history",
  "agent": { "id": "agent:…", "name": "My Agent" },
  "projectPath": "D:/Projects/demo",
  "session": { "id": "…", "title": "调试", "command": "my-agent", "nativeSessionId": "native-123" },
  "path": "D:/Projects/demo/session.json"
}
```

`method` 为 `history` 或 `resume`；自动读取时 `path` 为 null，尚未关联时 `nativeSessionId` 为 null。未来新增能力会增加版本或明确的能力字段，插件须拒绝未知版本和方法。

历史返回：

```json
{
  "version": 1,
  "cwd": "D:/Projects/demo",
  "nativeSessionId": "native-123",
  "path": "D:/Projects/demo/session.json",
  "messages": [
    { "role": "user", "text": "修复问题", "timestamp": null },
    { "role": "assistant", "text": "已完成", "timestamp": "2026-10-14T03:00:00Z" }
  ],
  "warnings": []
}
```

`cwd` 必须是当前项目目录（支持目录别名／符号链接）；原生 ID 可以为 null，否则须符合上述 ID 格式。自动读取时若已有关联 ID，插件必须返回同一 ID。`path` 可省略或为 null；选择文件导入时，工作台使用用户选定文件作为关联路径。`role` 仅接受 user/assistant，文本不渲染 HTML；timestamp 可省略或 null。未知字段或无效消息会拒绝整个响应。

恢复返回：

```json
{ "version": 1, "command": "my-agent --resume native-123" }
```

只有合法原生 ID 才会调用恢复插件。返回命令须为非空单行、最多 4096 字符，不包含 NUL；它将作为新运行实例的命令保留。

## 运行示例

仓库提供 [examples/agent-plugin.cjs](../examples/agent-plugin.cjs)，Windows 软件包的 `resources/examples` 也包含该文件，文档在 `resources/docs`。需安装 Node.js 来运行这个示例；插件也可使用独立的可执行程序。

1. 新增类型，命令填写你的 CLI 启动命令。
2. 按上面的 Node 程序／参数例子配置插件，勾选“读取和刷新对话历史”。需要测试恢复时勾选“生成会话恢复命令”（示例使用 `--resume ID`，应适配自己的 CLI）。
3. 在项目目录创建 `agent-session.json`，内容为 `{ "cwd": "当前项目完整路径", "nativeSessionId": "demo-123", "messages": [{ "role": "user", "text": "你好" }, { "role": "assistant", "text": "插件已连接" }] }`。
4. 使用该类型创建会话，在对话历史页点击刷新记录，应显示两条消息并关联 demo-123。
5. 更改文件中的消息后刷新验证更新，或选择其他 JSON/JSONL 文件验证显式导入。

示例是可替换的格式适配器；接入其他 CLI 时修改历史解析和恢复参数即可。它不启动或登录任何实际 Agent 服务。
