# Superagent 信息源插件开发指南

适用 AgentBerth 0.19 / 后台 API 53。信息源插件负责把渠道消息变成任务事件，并按用户审核的内容回传消息；Superagent 负责项目绑定、身份准入、任务编排与审计。无需修改 Agent、工作台核心或 Agent 的配置。不附带任何 GitHub、飞书渠道。

## 1. 先跑通本地示例

1. 在 插件中心 → Superagent → 配置 → 开发文档与工具中阅读、复制信息源指南或导出开发套件。任务工作台的「设置」打开同一插件配置。
2. 插件中心 → 加载开发目录 → 选择导出的 `superagent-source-local`。保持 Superagent 已启用。
3. Superagent → 来源管道 → 新建管道，填写名称，选择「本地模拟源」、目标项目、协调 ACP Agent 和执行 ACP Agent，保存后会显示独立管道卡片。先保留逐条批准。可勾选多个信息源，并分别设置会话范围。同一来源可被多个管道订阅；匹配消息会在每个管道创建独立任务。
4. 让连接 AgentBerth MCP 的 Agent 调用描述为「向 Superagent 提交一个本地模拟事件」的扩展工具，参数如下。工具实际名称由插件 ID 确定，不要猜测工具名。未配置 MCP 时，可在应用开发者工具控制台执行下面的本机验证代码：

```js
await window.berth.extensions({
  action: 'call', id: 'example.superagent.source.local', command: 'emit',
  params: {
    id: 'event-001', threadId: 'thread-001', actorId: 'tester',
    title: '验证信息源接收', text: '请检查任务是否进入待审批列表。'
  }
});
```

5. 在 Superagent 看到待审批任务。用相同事件 ID 再提交一次，确认没有新任务。任务详情输入回传文字并明确发送，看到本地回执；本例不发送任何外部消息。

开发套件包含完整 `agentberth.extension.json` 和 `index.cjs`。复制这两个文件即可开始，不需要初始化构建工具或安装 Cordis。依赖第三方库时，先打包为 `.cjs`，不要假设宿主安装了你的 npm 依赖。

## 2. 修改为你的渠道

给复制后的清单设置稳定且唯一的插件 `id`、名称和版本。保留 `entry: "index.cjs"` 和 `dependencies: ["superagent"]`。使用独立 Superagent 版本时依赖改为 `superagent.custom`，不要同时依赖两者。

在 `apply(ctx, config)` 中注册：

```js
const source = ctx.berth.source({
  id: 'inbox', name: '我的信息源',
  // 可选：让用户直接按群聊/频道名称选择管道范围，而不是手填 ID。
  async listThreads(signal) {
    return [{id: 'room-001', name: '研发需求群'}];
  },
  // 可选；只在用户明确发送已审核文字时调用。
  async reply({threadId, text, idempotencyKey}, signal) {
    // 必须实现渠道侧或持久存储的幂等去重，遵守 signal。
    return {receipt: await sendOnce(threadId, text, idempotencyKey, signal)};
  }
});
```

上面的 `sendOnce` 是你需要实现的渠道适配函数，不是宿主 API。完整可运行的本地实现附在示例中。单向接收插件可以省略 `reply`。

注册后，通过 Webhook、队列、SDK 或轮询收到渠道消息时调用：

```js
const receipt = await source.emit({
  id: nativeEvent.stableId,
  threadId: nativeEvent.threadId,
  actorId: nativeEvent.authenticatedUserId,
  title: nativeEvent.title,
  text: nativeEvent.body
});
```

`nativeEvent` 由你的渠道代码提供。不能把正文声称的身份当作 `actorId`。校验签名、认证和租户归属后再提交，频道、线程或会话 ID 放在 `threadId`。

## 3. 明确接收和重试边界

| 返回/状态 | 插件应做什么 |
| --- | --- |
| `{accepted:true, duplicate:false, ticketId, ticketIds, deliveries}` | 所有匹配管道的任务已持久化，可以推进来源游标；`ticketId` 保留首项以兼容旧插件 |
| `{accepted:true, duplicate:true, ticketId}` | 已接收过同一事件，不重复创建任务，可以确认 |
| `{accepted:false, duplicate, reason}` | 明确拒绝；记录原因并按渠道约定确认或进入死信队列，不盲目循环重试 |
| `emit()` 抛错 | 可能部分管道已接收；持久保留事件并以相同 `id` 重试，不先推进游标；成功管道不会重复建任务 |
| 来源未绑定项目/Agent、停用、暂时断开 | 保留待发事件，等待配置或恢复；禁止每次重试生成新事件 ID |

事件字段严格校验，不接受额外字段：`id` / `actorId` 1–200 字、`threadId` 1–500 字、`title` 1–100 字、`text` 1–16000 字。超长正文在渠道侧提取任务相关摘要，附件的权限与获取由插件管理；不要偷偷截断身份或事件 ID。

完整来源 ID 为 `插件ID/来源ID`。来源 ID 以小写字母开头，支持小写字母、数字、点和连字符，最多 64 字；上线后保持稳定，否则原规则与去重记录无法匹配。

## 4. 生命周期和热更新

`apply()` 完成注册后应及时返回，不能在其中等待第一个事件或无限轮询。监听器、计时器、HTTP 连接和文件句柄放进 `ctx.berth.effect()` 并返回清理函数。插件重新配置、重载、停用或卸载时，旧监听必须停止，旧 handle 不能继续提交事件。

```js
ctx.berth.effect(() => {
  const controller = new AbortController();
  const stop = subscribe(async event => {
    try {
      const receipt = await source.emit(toSourceEvent(event));
      await acknowledge(event, receipt);
    } catch (error) {
      // 实现持久待发队列，并在下次启动以原事件 ID 重试。
      await retainForRetry(event, error);
    }
  }, controller.signal);
  return async () => { controller.abort(); await stop(); };
});
```

`subscribe`、`toSourceEvent`、`acknowledge`、`retainForRetry` 都由插件实现。异步回调必须处理异常；轮询要避免重入，并在清理时等待自己的在途请求结束。用 `ctx.berth.signal` 观察整体停用；健康状态用 `source.health('ready')` 或 `source.health('error', '可操作的错误说明')` 报告。

游标、待发队列和发送回执写入 `ctx.berth.dataDirectory`，不要只保存在内存。连接参数可由插件清单 `config` 声明；密钥不要写进示例默认值、安装包或日志。宿主插件配置是本机配置文件，不是通用凭据保险箱。

## 5. 回传语义

`reply({threadId,text,idempotencyKey}, signal)` 返回 `{receipt: "渠道实际回执"}`。同一 `idempotencyKey` 在显式重试时不变，必须跨插件重载/应用重启保持去重。仅靠内存 Set 不够。

默认 30 秒后中止等待；遵守传入的 AbortSignal。网络断开或发送成功但回执丢失时，状态为 unknown，Superagent 不自动重发。先核对渠道实际结果，再由用户显式重试。若渠道既不提供幂等键又无法查询历史发送结果，插件无法保证恰好一次，应保留未知状态等待核实。

## 6. 验收和交付

- 未配置、拒绝身份、人工审批、允许身份自动准入分别符合预期。
- 同一个事件重复投递、重启后再投递，均只产生一个任务。
- 关闭插件、修改配置、重新加载后旧监听停止，新监听只启动一次。
- 接收时断网不丢事件、不提前确认来源游标；错误信息不包含密钥。
- 单向插件不显示可用回传能力；有回传能力的插件处理取消、超时和回执丢失，重试沿用原幂等键。
- ZIP 根目录直接包含清单和 `.cjs` 入口，加载开发目录与安装 ZIP 都能正常启停。

给 Agent 的任务应明确目标渠道、认证方式、事件映射、持久化与重试策略和上述验收结果。不要让 Agent 猜私有 API，也不要用复制的事件正文作为可信身份。

完整 SDK 契约见 `ACP_SUPERAGENT.md`，通用清单、配置、打包与视图桥见 `CORDIS_PLUGIN_DEVELOPMENT.md`。本指南和完整本地示例都包含在应用资源及导出的开发套件中。

## 来源管道与匹配

来源插件只负责提供稳定的 `threadId`、`actorId` 和事件 ID，无需自行保存项目映射。用户在「来源管道」中维护多组命名配置：来源 → 来源会话范围 → 目标项目 → 协调/执行 Agent。每组独立编辑、启停、删除，模型与工作区方式分别保存。旧的一来源一规则配置首次启动自动转换为一组管道，不会丢失设置；删除后不会重建。

- `threadId` 按完整字符串精确匹配，不是标题搜索、通配符或正则。空范围表示该来源的全部会话；人员名单为空表示全部人员。ID 是渠道内部会话标识，显示名称可能不相同，插件应在自己的配置或调试页面说明其获取方式。
- 同一来源可以被多个管道订阅，会话和人员范围可以重叠。消息分别经过每个管道的关键词过滤和来源插件规则，匹配的管道各自创建一个任务，互不共用工作区。
- 无匹配会话返回 `accepted:false,reason:'no_matching_pipeline'`；身份不匹配返回 `actor_not_allowed`。接收记录会显示原因。未启用任何管道时抛出“尚未绑定或已停用”，插件保留事件，配置完成后用原 ID 重试。
- 接收回执一经保存，同一来源事件 ID 重发始终复用原结果；修改/删除管道不会让已处理事件再次开工。修复路由后需要重新提交请求时，由渠道以新的事件 ID 发起，不能静默改写旧事件。
- 「接收记录」仅展示最近 30 条轻量回执；被管道范围挡住的请求可从「全部接收记录」查看。任务保留触发时的管道名称和 ID，后续修改不改写历史归属。
- 删除或停用管道只停止后续接收，不会取消已创建的长任务。发送回复仍是任务内的人工确认动作，和路由开关无关。

`listThreads(signal)` 是可选的只读会话发现接口，最多返回 256 个 `{id, name}`。提供后，「新建/编辑管道 → 选择来源会话」直接显示可勾选的名称；不提供仍可通过高级配置填写 ID，现有插件不受影响。接口须处理停用信号，宿主 10 秒超时，不创建任务，不接触 Agent。返回列表不是授权规则，身份准入和管道配置继续由后端校验。

## 管道专属配置与关键词过滤

插件清单的 `config` 用于连接、认证等全局设置；`pipelineConfigSchema` 用于每个管道内、每个来源绑定的独立规则。同一来源接入两条管道时，各自填写并保存，不需要重复安装插件或在全局配置里维护管道映射。

```js
const source = ctx.berth.source({
  id: 'inbox', name: '需求收件箱',
  pipelineConfigSchema: {
    requiredLabel: {type:'string', title:'消息需包含', default:''},
    minimumLength: {type:'number', title:'最短正文长度', minimum:0, maximum:16000, default:0},
    acceptMessages: {type:'boolean', title:'接收消息', default:true},
    field: {type:'string', title:'匹配字段', enum:['title','text'], default:'text'},
  },
  match(event, {pipelineId, pipelineName, config}, signal) {
    if(signal.aborted)throw new Error('来源已停止');
    return config.acceptMessages && event.text.length >= config.minimumLength &&
      (!config.requiredLabel || event[config.field].includes(config.requiredLabel));
  },
});
```

- 字段支持 `string` / `number` / `boolean`、`title`、`description`、`default`、数字 `minimum` / `maximum`、字符串 `enum` 和 `required:true`。最多 64 个字段，名称以英文字母开头，仅含字母、数字、下划线；单个字符串最多 8000 字。无需编写配置页面，宿主按 schema 渲染控件并校验类型、范围、选项和必填项。
- 管道保存结构为 `inputs:[{sourceId,threadIds,config}]`；`config` 只传给当前来源的 `match`，不会混用其他来源或其他管道的值。默认值由宿主解析；`false` 和 `0` 不会被默认值覆盖。schema 未声明的字段会报错，避免拼写错误被忽略。来源插件停用时可以保留配置草稿，重新启用管道时再次验证。
- `match` 可选，必须返回布尔值。仅做无副作用的路由判断，不在这里创建任务、消费游标或发送回复。支持异步判断，遵守 AbortSignal；宿主等待上限为 10 秒。`false` 仅过滤当前管道；异常仅使当前分发失败，其他成功分发不会回滚。重试可能再次调用失败管道的 `match`，因此必须可重复调用。
- `emit` 提交原始规范事件一次即可。不要在插件全局预先过滤所有消息，否则宿主无法把该消息交给规则不同的其他管道。保留渠道签名、租户认证等全局安全检查。
- 通用关键词在管道界面的「管道关键词过滤」配置，不需要插件实现：匹配标题与正文的字面子串，包含词支持任意/全部匹配，默认忽略大小写，排除词优先。不使用正则。关键词规则对当前管道的所有来源生效，插件自定义规则再按来源分别判断。两者必须同时通过。
- 接收顺序为：来源/会话范围 → 人员准入 → 管道关键词 → 插件 `match` → 创建任务。关键词或插件规则拒绝时，接收记录的对应分发带 `filtered:true`，不视作错误、不重复重试。所有管道被关键词过滤时 `reason:'keyword_filtered'`，插件规则过滤时为 `filtered`；有任务成功时 `accepted:true`。
- 首次接收即固定订阅管道、关键词判定和来源配置。失败事件使用原 ID 重试时沿用该配置，仅重试失败分发；已经成功或明确过滤的管道不会重新执行。修改配置对新事件生效，不能用旧事件 ID 绕过去重。热更新后 schema 若不兼容旧事件配置，将保留失败记录供修复，不会静默丢弃字段。

可运行示例 `superagent-source-local/index.cjs` 包含上述四种字段。验收时建立两条同源管道，分别配置不同关键词和「消息需包含」，确认独立分发、重启后保留、非法配置无法保存、原事件 ID 重试不重复创建任务。
