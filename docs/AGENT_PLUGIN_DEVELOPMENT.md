# AgentBerth 插件开发指南（给编程 Agent）

目标：用户只需“导入一个配置文件或脚本 → 设置名称 → 保存”。不要让用户填写命令、选择运行时、勾选启用扩展或编辑参数。文件负责声明所有配置，软件自动启用其能力。不要把 TUI 的屏幕输出当作对话历史。

## 开工前确认

询问用户所用 CLI 的名称、实际启动命令、CLI 版本、需要的历史读取/原生恢复能力，以及原生会话数据的位置和示例。若用户授权查阅本机 CLI 帮助或官方文档，再确定数据格式和恢复参数。不能臆造 CLI 参数、目录或历史结构。不要替用户登录、修改权限或启动真实任务。

## 优先交付单个文件

只需要启动 CLI 时，交付一个 JSON 配置（最多 64 KiB），无需任何插件程序：

```json
{
  "schemaVersion": 1,
  "id": "my-cli",
  "name": "My CLI",
  "command": "my-cli"
}
```

可选 `resumeCommand`，例如 `my-cli --resume {sessionId}`。不要填写 runtime、entry 或 capabilities；未实现的能力不需要占位字段。模板 `agent.json` 可直接参考。

需要历史读取或动态恢复时，优先交付单个自描述 `.cjs`、`.mjs` 或 `.js` 脚本（最多 16 MiB），使用软件自带 Node 运行。导入时程序复制脚本并调用 describe，自动获取 id、名称、启动命令和能力，无需再交付清单。脚本必须自包含：优先使用 Node 内置模块，外部依赖打包进脚本；不能依赖原目录、其他未导入文件或外部 Node 安装。模板 `plugin.cjs` 本身即可直接导入。

同一类型更新必须保留稳定 id；清单、配置和 describe 返回的 id 必须一致，旧版清单适配器仍可省略 describe.id。用户点“更新插件”选择新文件，或重新导入同一 id，即可在终端运行中热更新；校验成功后原位切换，失败保留旧版。不要要求重启工作台、停止 Agent 或手工修改安装目录。每次请求独立执行，文件应自包含；旧请求结果会被版本校验丢弃，调用方可重试。不要依赖跨请求的内存缓存或常驻进程。更新保留用户名称和会话关联。已有会话继续保存原来的启动命令；新命令用于以后新建的会话。脚本在本机执行，describe 不能启动真实 Agent、要求登录或修改用户数据。

## 多文件资源（按需）

仅在适配器确实需要资源文件或独立可执行程序时交付便携目录，包含 `agentberth-plugin.json`、入口及声明的资源。用户仍只选择一个清单文件。导入时软件复制入口与 `files` 声明的文件到自身目录，因此代码不能依赖原开发目录。禁止启动时下载代码或执行 npm install。程序不能创建常驻/脱离进程树的子进程。

清单示例：

```json
{
  "schemaVersion": 1,
  "id": "my-cli-adapter",
  "name": "My CLI",
  "command": "my-cli",
  "runtime": "node",
  "entry": "plugin.cjs",
  "args": [],
  "files": [],
  "capabilities": { "history": true, "resume": true, "list": true }
}
```

- id：稳定的小写 ID，允许字母、数字、点、短横线、下划线，最多 100 字符。更新插件保留 ID；不同插件用不同 ID。
- name/command：用户界面名称和 CLI 单行启动命令。command 不得含换行或 NUL，最多 4096 字符；命令使用用户所选 Shell 的语法。
- runtime：node 使用软件自带 Electron/Node，无需用户安装 Node；executable 使用目录内独立程序。
- entry/files：必须是本目录内的相对文件路径，不允许 ..、绝对路径或外部符号链接。最多 64 个文件，每个不超过 16 MiB，合计不超过 32 MiB。不能声明整个项目目录。
- args：可选程序参数。`{pluginDir}` 会替换为安装后的资源目录，用于资产路径；绝不能写开发机绝对路径。
- capabilities：history 读取文本，resume 生成恢复命令，可选 list 分页发现项目下多条原生会话。不提供 list 时省略或设 false，旧版 history/resume 插件继续可用。仅声明真实实现的能力。不支持恢复就设 resume=false；可用可选 resumeCommand，例如 `my-cli --resume {sessionId}`，代替恢复接口。所有新插件必须实现 describe 自检。

## 调用协议 v1

每次请求启动一次程序，cwd 是项目目录（describe 的 cwd 是插件目录）。stdin 是 UTF-8 单个 JSON 加换行，然后 EOF。stdout 仅允许 UTF-8 单个 JSON 对象，随后退出 0。日志写 stderr；异常用明确的诊断写 stderr 并非零退出。所有请求必须在 10 秒内完成，stdout/stderr 合计最多 2 MiB；程序不可保留常驻进程。

### describe：自检（不得访问项目或执行 Agent）

输入：`{"version":1,"method":"describe","agent":{"id":"agent:…","name":"My CLI"}}`

返回（单脚本导入必须包含 id、name、command、capabilities）：

```json
{
  "version": 1,
  "id": "my-cli-adapter",
  "name": "My CLI",
  "command": "my-cli",
  "capabilities": { "history": true, "resume": true, "list": true }
}
```

可选 resumeCommand 与 JSON 配置语法相同。只实现 describe 也可以，能力均设 false。旧版通过清单安装的适配器仍可省略 id/command，由清单提供；新脚本必须自描述。

必须拒绝未知协议版本或方法。能力与清单保持一致。

### list：分页发现多条原生会话（可选）

在 describe / 清单中声明 `capabilities.list=true` 后，界面提供“发现会话”。**list 必须列出当前项目的全部可用原生会话，不可只按 session.nativeSessionId 过滤成一条。** 当前关联 ID 只是界面状态，用户需要从其他 ID 中选择。

输入：

```json
{
  "version": 1,
  "method": "list",
  "agent": { "id": "agent:…", "name": "My CLI" },
  "projectPath": "D:/Projects/demo",
  "session": { "id": "…", "title": "调试", "command": "my-cli", "nativeSessionId": "currently-linked" },
  "path": null,
  "pagination": { "cursor": null, "limit": 5, "query": "调度" }
}
```

返回：

```json
{
  "version": 1,
  "items": [
    { "cwd": "D:/Projects/demo", "nativeSessionId": "native-123", "title": "排查调度", "updatedAt": "2026-10-15T06:00:00Z", "path": "D:/Projects/demo/session.json" }
  ],
  "nextCursor": null,
  "total": 1,
  "warnings": []
}
```

- 每页最多请求的 limit（1–50）条，只返回 ID、标题、更新时间、文件路径等元数据，不包含 messages。标题 1–200 字符。cwd 必须是原记录所属项目；软件逐条校验，混入其他项目会拒绝整页。同页 ID 不重复。
- path 可省略或 null，存在时必须是完整路径。updatedAt 可省略或 null，有值须能解析为日期。total 可省略；有值须为非负整数。warnings 最多 20 条，每条最多 1000 字符。未知字段会被拒绝。
- query 是标题/ID 搜索文字（最多 100 字符），由适配器在完整结果集上筛选后分页，不要只搜索本页。请使用原生索引或轻量元数据，不为列列表读取所有正文。
- cursor 是插件自行编码的不透明游标（最多 2048 字符）。首请求为 null，末页返回 nextCursor=null；中间页返回非空新游标。顺序应稳定，例如更新时间降序 + ID；游标应绑定项目、搜索条件及排序位置，不能反复返回同一页。空页不可附带下一页游标。目录变化导致游标失效时明确提示刷新。
- 选中条目后软件调用 history，session.nativeSessionId 是选中 ID，path=null；必须按此 ID 读取，不能取最新的另一个会话。不提供 history 也可仅列 ID + resume；此时预览没有文本。
- list 与预览都是只读操作，不会自动修改当前关联。用户点击关联后才切换目标。终端运行中也允许关联和解除关联；不会向现有 PTY 注入恢复命令、切换 CLI 会话或重启进程，新 ID 仅用于工作台历史和以后恢复。
- 解除关联保留已保存的历史和原文件；同项目、同 Agent 类型的工作台会话共享已保存目录，每个工作台会话独立保存当前关联。旧插件没有 list 时仍可通过多个文件导入、手工 ID 关联积累历史。

### history：发现/导入/刷新原生对话

输入：

```json
{
  "version": 1,
  "method": "history",
  "agent": { "id": "agent:…", "name": "My CLI" },
  "projectPath": "D:/Projects/demo",
  "session": { "id": "…", "title": "调试", "command": "my-cli", "nativeSessionId": null },
  "path": null
}
```

- path 非空：只读解析用户选定文件；绝不能改写原记录。
- path 为空且 nativeSessionId 非空：自动查找此项目的该原生会话。
- 两者为空：自动发现当前项目最近的原生会话；如多个记录且无法可靠选择，应报出明确提示，指导选择记录或关联 ID，不得从其他项目取数据。

返回：

```json
{
  "version": 1,
  "cwd": "D:/Projects/demo",
  "nativeSessionId": "native-123",
  "path": "D:/Projects/demo/session.json",
  "messages": [
    { "role": "user", "text": "你好", "timestamp": null },
    { "role": "assistant", "text": "已完成", "timestamp": "2026-10-14T06:00:00Z" }
  ],
  "warnings": []
}
```

cwd 必须来自原生记录且对应当前项目，不能仅为了通过验证抄写输入 projectPath。原生 ID 仅允许 1–128 个字母、数字、下划线、连字符；CLI 使用其他 ID 字符时可用可逆 base64url 编码，并在 resume 中还原。自动读取必须保持已关联 ID。消息只取用户/助手的可读文本，排除工具载荷、系统提示和终端 ANSI；去重并按时间排序。最近最多 1000 条，每条不超过 32768 字符，总文本按 512 KiB 裁剪并给出 warnings。path 可省略或 null，返回实际文件时须是有效完整路径、文件小于 16 MiB。返回对象/消息不可添加未知字段。

warnings 只返回与本次读取有关的限制或诊断，正常排除其他项目不必逐文件警告；无效文件或扫描预算不足时聚合成一条说明，避免重复刷屏。文件来源与诊断由界面集中折叠显示，不能把真正的读取失败包装成成功响应的 warnings。多条会话应提供 list 让用户选择；明确指定 ID 时不得退回最新会话，找不到该 ID 就报错，不得读取另一条。

### resume：生成恢复命令（不得直接执行）

输入结构与 history 相同，method=resume，path=null，session.nativeSessionId 为合法原生 ID。

返回：`{"version":1,"command":"my-cli --resume native-123"}`

生成适用于会话原命令与当前 Shell 的单行命令，最多 4096 字符，严禁换行/NUL。不要执行该命令；由工作台启动新的运行实例。若无法正确处理配置或引号，明确报错而不是返回猜测的命令。

## 本地验证（Agent 必须完成）

导出的开发套件包含 **check-plugin.cjs**，已打包所需依赖，可由开发 Agent 使用 Node 24+ 直接运行，无需 npm install。它复用工作台实际的协议、文件导入和插件执行校验。用户使用 AgentBerth 时无需运行此工具或安装 Node。

```sh
# 先检查脚本/清单的 describe、身份和能力声明
node check-plugin.cjs ./plugin.cjs
# 在包含至少 12 条记录的测试项目中，检查多页发现、关联前后列表、按 ID 历史和恢复格式
node check-plugin.cjs ./plugin.cjs --project "测试项目目录" --session native-123
# 再检查搜索与指定文件；按目标 CLI 的实际记录准备数据
node check-plugin.cjs ./plugin.cjs --project "测试项目目录" --query "中文"
node check-plugin.cjs ./plugin.cjs --project "测试项目目录" --file "完整历史文件路径"
```

也可传 agent.json 或 agentberth-plugin.json。每页 5 条、最多检查 100 条；没有记录、只检查 describe 或未提供 ID 时，未覆盖的能力会明确提示，不能据此宣称全部通过。失败退出码为 1；检查器不会执行返回的恢复命令。插件自身仍在本机运行，应只使用受控测试数据。检查器验证结构、项目归属、分页与关联完整性、跨页去重，以及最多两个发现 ID 和显式 ID 的 history/resume。它不能证明数据已完整发现、内容正确、搜索语义正确、真实 CLI 兼容或桌面热更新可用，下面的行为验收仍须完成。只拿到此指南而没有工具时，用 Node 子进程编写相同协议测试，或导出完整开发套件。

使用 node 子进程 spawn + stdin JSON + EOF 测试，或创建可重复的自动测试。不要靠手工在终端敲复杂的转义 JSON。测试至少覆盖：

1. describe 可在无 CLI、无登录、无项目时成功，能力与清单一致。
2. 两个项目和两个原生会话不会串记录；项目路径含空格、中文、Windows 8.3 别名或符号链接。
3. 用户/助手中文与 emoji 保留，工具载荷不进入文本，ID、时间与顺序正确。
4. 指定文件、自动发现、按原生 ID 刷新，未知或不存在的数据给明确错误。
5. 文件截断、不完整末尾、错误 JSON、过大数据均可控；不写原文件。
6. resume 只返回命令，恶意/无效 ID 不注入 Shell；不产生真实任务。
7. 一次请求后进程与子进程退出，不依赖外部 Node 路径、开发目录或网络下载。
8. list 至少准备 12 条 ID，验证多页无重复无遗漏、上一页/下一页、标题/ID/中文搜索，且其他项目不会出现；当前已关联一个 ID 时仍能列出其他 ID。
9. 验证预览不改关联、按 ID 刷新不串记录、运行中关联/解除不改 PTY PID 与命令；刷新失败保留原数据，游标失效可刷新恢复。
10. 验证热更新：保持一个终端运行，修改并重新交付同一 id 的文件，点“更新插件”导入。确认下一次 history/list/resume 使用新版；名称、默认类型、ID、历史关联和当前 PID 不变；错误或 ID 不同的更新保留旧版；旧版延迟响应不能覆盖新历史或启动旧恢复命令。
11. 在 AgentBerth 导入配置或脚本，确认对话框只有名称输入，无运行时、命令和启用复选框；重新导入相同 id 不重复新增。含扩展的类型点“检查插件”，建会话后点“读取对话”；修改原生记录并刷新；验证普通 Shell 有运行记录，Agent TUI 无运行输出记录。

## 模板说明与完成报告

附带 plugin.cjs 是可运行的标准 JSON 示例，读取项目 `agent-session.json` 和 `agent-sessions/*.json`（cwd/nativeSessionId/messages，可选 title），示例恢复使用 `--resume ID`。它不是任何真实 CLI 的适配器；必须按目标 CLI 格式替换读入与恢复逻辑，不能谎称已适配。模板实现 describe/list/history/resume：list 以更新时间和 ID 分页，不按当前关联 ID 过滤；history 按所选 ID 读取，多会话时不会任意取最新一条。示例发现最多检查 1000 文件和合计 64 MiB，不足时返回 warnings；实际 CLI 优先使用原生索引。describe 包含完整元数据，可立即直接导入脚本并检查运行环境。只需启动的适配应交付 agent.json，不要引入多余历史接口。

报告应包括：最终可导入文件的完整路径、支持的 CLI 版本/能力、自动发现规则、通过的测试、实际测试与模拟测试的边界。给用户的使用步骤限制在“导入配置或脚本 → 设置名称 → 保存”，然后按需创建会话、读取对话；不得要求用户编辑工作台源码或 JSON 参数。
