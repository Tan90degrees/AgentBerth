# ACP Agent 与 Superagent

适用 AgentBerth 0.18 / 后台 API 44。ACP 使用稳定 v1 的逐行 JSON-RPC stdio 协议，不捆绑模型或 Agent 运行时。已有 CLI / TUI 接入继续可用。

## 配置已有 ACP Agent

在「插件中心 → Agent 接入 → 新增 ACP Agent」填写名称、启动程序与 JSON 参数数组。OpenCode 示例：

```text
名称：OpenCode ACP
启动程序：opencode
启动参数：["acp"]
```

使用本机已安装、已登录的 OpenCode。Windows 支持 PATH 中的 `.exe`、`.cmd`、`.bat` 和 `.ps1` 启动器；也可「选择文件」直接选择程序或脚本。含空格的完整路径保持为一个文件名，不需要加引号；粘贴时已有的成对外层引号也可以处理。程序与参数分开填写，不把整段 shell 命令放入程序字段。环境变量默认继承本机；高级配置仅用于明确覆盖，保存在本机配置中。不要把令牌写入可分享的插件包。

脚本配置示例：

| 类型 | 启动程序 | 启动参数（JSON 数组） |
| --- | --- | --- |
| PowerShell | `C:\Program Files\My Agent\start-acp.ps1` | `["acp"]`，或脚本不需要参数时 `[]` |
| 批处理 | `C:\Program Files\My Agent\start-acp.cmd` | `[]` |
| Python | `python` 或解释器完整路径 | `["C:\\Agent Scripts\\start_acp.py"]` |
| JavaScript | `node` 或解释器完整路径 | `["C:\\Agent Scripts\\start-acp.mjs"]` |

`.ps1` 通过无 profile 的 PowerShell 启动，仅对此子进程使用执行策略参数，不修改系统执行策略。其他脚本使用其真实解释器；Unix 下也可直接运行有执行权限且带 shebang 的脚本。脚本的 stdout 必须只写 ACP JSON-RPC，日志写 stderr。脚本内部调用其他程序也须保留完整路径与参数边界。

遇到 `spawn … ENOENT` 时核对程序/解释器、脚本内部调用的程序和项目目录是否存在；路径不要只填写到含空格文件名的前一部分。「测试连接」使用同一启动链，先确认能力协商成功再创建会话。

Windows 下不写扩展名时优先查找 `.exe/.com/.cmd/.bat/.ps1`。npm 同时安装的无扩展名 Unix shim 不会再被误当作 Windows 可执行文件；仅有这类脚本时会提示选择解释器。

「测试连接」只做 initialize 能力协商，不创建会话、不运行任务。Claude Code、Codex 等需填写各自真正提供 ACP 的适配器程序；普通 `claude` 或 `codex` 的交互命令不能直接视为 ACP 服务。不同适配器的安装、登录和授权方式由其维护者提供，工作台不静默替换适配器。

回到左侧项目，右键新建会话并选择该 Agent。主区变为对话：Enter 发送，Shift+Enter 换行；支持流式回复、计划、工具调用和手动授权。项目/会话的创建、重命名、删除、连接与断开仍在左侧。停止当前轮次与断开 Agent 是两种操作。

模式、模型选项、登录入口只在 Agent 实际声明后显示。Agent 未声明能力时不会伪造对应入口。项目 Skills 目录可在接入高级设置中填写；插件方式可同时注册 ACP 和 Skills：

```js
exports.apply = ctx => {
  ctx.berth.agent({
    id: 'my-acp',
    definition: {
      name: 'My ACP Agent', command: 'my-agent',
      acp: { executable: 'my-agent', args: ['acp'], env: {} },
      skills: { project: '.my-agent/skills' }
    }
  });
};
```

仅声明 Agent 真正读取的 Skills 目录，工作台不更改其私有配置。

### 历史、恢复与权限

ACP 对话记录由工作台保存，不解析 CLI 私有 JSONL，也不读取终端画面充当回答。初次加载最近 100 个事件，可以加载更早的消息。每会话保留最近 5000 个事件，单个文本事件拆分为最多 8192 字；这是有界日志，不承诺无限历史归档。

重新连接时，Agent 声明 `loadSession` 才恢复原生会话；未声明时保留本机记录、明确提示并新建原生会话。配置或工作区变化也会明确建立新绑定。未知结果不自动重发旧消息，同一 `requestId` 不重复执行。托盘退出后恢复只重建连接，不自动继续被中断的任务。

Agent 可以调用项目范围内的客户端文本文件读写与命令工具；文件限制 1 MiB，路径包含符号链接校验。命令输出最多 1 MiB，截断有显式标记，等待退出后读取已排空的输出。授权请求必须由用户选择，工作台不会默认批准。但 ACP Agent 本身是当前用户启动的本机程序，原生工具权限由 Agent 自身决定，这不是进程沙箱。

协议参考：[ACP v1](https://agentclientprotocol.com/protocol/v1/initialization)、[OpenCode ACP](https://opencode.ai/docs/acp)。

## Superagent 的使用方式

在侧栏打开 Superagent，选择项目、ACP 协调者和 ACP 执行者，填写任务与验收要求。可以选择同一种 Agent，但每个任务的协调/执行都使用独立会话。Git 项目默认创建独立 Worktree；非 Git 项目取消该选项。

流程是：确定性准入 → 协调者决策 → 独立执行者 → 人工确认结果。协调者支持 plan 模式时自动选择；不支持时会在审计中说明，不能据此承诺只读权限。协调结果必须为可校验的 JSON，格式或范围有问题就交回人工确认，不无限循环猜测。任务规则可在插件配置中调整。

授权等待、阻塞、未知结果、完成待确认都可从任务面板打开对应会话。确认完成不会自动合并或推送分支。取消、禁用、重载只停止该任务自己的连接，保留 Worktree 和日志；后台退出或连接中断后记录为中断，只有显式继续才创建新尝试。已在 Agent 内独立启动的外部任务仍需人工核对。

并行任务默认 2 个，可配置 1–4 个。任务列表显示最近 50 个摘要，未结束任务最多 200 个；审计和完整任务字段保存在插件 SQLite 中，可通过 `get` / `read` 分页读取。它是首版任务编排插件，并非 DeepSeek 原型全部业务功能的复刻。

## 自定义信息源插件

从零开发请先阅读 [Superagent 信息源开发指南](SUPERAGENT_SOURCE_DEVELOPMENT.md)。应用中可在 Superagent → 信息源打开同一指南，复制给 Agent 或导出含完整可运行示例的开发套件；下面是详细接口参考。

**不内置、不自动安装 GitHub 或飞书信息源。** Superagent 不感知特定渠道，只接收已注册插件提交的规范事件。开发套件中的 `superagent-source-local` 是可选本地模拟示例，不连接外部服务。

清单声明依赖 `superagent`（使用独立构建版本时改为对应插件 ID），然后注册信息源：

```js
exports.apply = ctx => {
  const source = ctx.berth.source({
    id: 'inbox', name: 'My inbox',
    // 可选：仅在用户明确确认回复时调用。必须按 key 做持久幂等。
    async reply({ threadId, text, idempotencyKey }, signal) {
      return { receipt: await sendOnce({ threadId, text, idempotencyKey, signal }) };
    }
  });
  ctx.berth.effect(() => {
    const stop = subscribe(async nativeEvent => {
      const receipt = await source.emit({
        id: nativeEvent.stableId,
        threadId: nativeEvent.threadId,
        actorId: nativeEvent.authenticatedUserId,
        title: nativeEvent.title,
        text: nativeEvent.body
      });
      // 收到接收或明确拒绝回执后才能提交来源游标。
      await acknowledge(nativeEvent, receipt);
    });
    return stop;
  });
};
```

此代码展示契约，`sendOnce` / `subscribe` / `acknowledge` 由插件实现；可直接运行的示例在 `examples/superagent-source-local`。

### 契约与生命周期

| 项目 | 约定 |
| --- | --- |
| 注册身份 | 完整来源 ID 为 `插件ID/来源ID`；来源 ID 为小写字母开头的字母、数字、点、连字符，最多 64 字 |
| 事件 | `id` / `actorId` 非空且最多 200 字，`threadId` 最多 500 字；`title` 1–100 字；`text` 1–16000 字；未知字段拒绝 |
| 身份 | 插件校验渠道签名、登录与真实用户身份；正文自称的身份不能当 `actorId` |
| 接收 | `emit` 返回 `{accepted, duplicate, ticketId?, reason?}`；同来源同事件 ID 返回原有结果，不重复调度 |
| 未配置、已停用、临时错误 | 抛错表示尚未确认接收。插件持久保留事件，以相同 ID 重试，不先推进来源游标 |
| 准入 | 用户在 Superagent「信息源」中绑定项目与两个 ACP Agent；自动准入必须明确填写允许身份名单，否则待人工批准 |
| 信息源状态 | `source.health('ready'|'error', detail?)`，用于报告连接状态；不包含密码或令牌 |
| 回传 | 可选 `reply`，只发送用户审核的文字；`idempotencyKey` 跨显式重试保持不变，来源适配器负责持久去重 |
| 超时 | 回传默认 30 秒；传入 AbortSignal，插件必须取消自己持有的请求。已发送但回执丢失记为 unknown，不自动重发 |
| 清理 | 在 Cordis effect 中关闭监听、连接、文件句柄和计时器。禁用或卸载后旧 source handle 不再接受事件 |
| 持久化 | 来源连接参数、接收游标、幂等回执存在自身 `ctx.berth.dataDirectory`；不要存在全局临时变量里 |

`actorId` 白名单属于身份匹配，不是正文提示词。任务内容仍来自外部输入，协调者的权限取决于实际 Agent 配置。工作台的确定性校验不等于防止 Agent 一切越权操作。

自定义来源可以是 Webhook、轮询队列或本机事件，不要求修改工作台核心。上游重发、热更新、宿主重启、丢失发送回执等情况都应使用真实插件回归验证。开发期先安装本地模拟来源，再在信息源页面设置规则，验证接收、拒绝、去重和回传。

## 包体与 DeepSeek Harness 兼容边界

插件 ZIP 上限 256 MiB，展开总量 1 GiB，单文件 256 MiB，最多 50000 个条目，目录深度最多 32 层；检查元数据和实际解压字节数。采用分块解压落盘，不再一次性读入整个 ZIP。80 MiB 实际存储型 ZIP 已有回归测试。ZIP 根目录必须有 `agentberth.extension.json` 和已打包 `.cjs` 入口。

| 层次 | 是否可以直接复用 |
| --- | --- |
| Cordis 生命周期、effect、服务依赖思路 | 可以复用，版本固定为 4.0.0-rc.12 |
| 纯 Node 算法/协议代码 | 取决于实际依赖和许可证，打包后可复用 |
| Harness 清单、Agent/session/tool 服务、消息模型 | 不能直接通用，需要适配为 AgentBerth 清单与 `ctx.berth` API |
| Harness 前端扩展、桌面桥与权限 | 不能直接通用，需要适配视图消息桥和桌面入口 |
| GitHub/飞书信息源 | 不随 AgentBerth 附带；需要时自行开发来源插件 |

**不承诺 100% 兼容 DeepSeek Harness 插件。** 放宽 ZIP 大小解决容量问题，不改变宿主 API 的差异。缺少 AgentBerth 清单时会明确报告兼容性原因。

设计参考：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，保留其 MIT 声明于 `docs/third-party/dsh-superagent-MIT.txt`。本实现使用 AgentBerth 的 ACP 会话、Worktree、Cordis 生命周期和视图桥，不打包上游渠道代码。

## 真实 OpenCode 回归

CI 使用测试目录中固定版本 OpenCode 1.19.5 验证 initialize、创建会话、模型选择、plan 模式和相同原生 ID 恢复。测试只配置本机占位提供者，不提交 prompt、不调用模型、不登录、不安装 hook；XDG 配置、数据和缓存均隔离。测试用 CLI 不进入发行软件包。

OpenCode 的模式由标准 `configOptions` 提供，部分较早的 Agent 则返回 `modes`。工作台优先使用实际声明的配置项，旧模式接口仅在没有同名配置项时使用；Superagent 同时识别两种 plan 模式声明。没有可选值的配置项显示禁用状态。

已有本机 OpenCode 可手动复用同一回归（需先安装项目开发依赖）：

```powershell
$env:AGENTBERTH_OPENCODE_TEST_EXECUTABLE = 'C:\path\to\opencode.exe'
node scripts/test-opencode-acp.mjs
```

这组测试验证真实 CLI 的协议和会话管理，不等同于对所有模型提供者、真实任务或私有 Agent 的完整兼容承诺。
