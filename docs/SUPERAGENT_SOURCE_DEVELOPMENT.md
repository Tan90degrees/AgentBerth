# Superagent 信息源插件开发指南

适用 AgentBerth 0.18 / API 46。信息源插件负责把渠道消息变成任务事件，并按用户审核的内容回传消息；Superagent 负责项目绑定、身份准入、任务编排与审计。无需修改 Agent、工作台核心或 Agent 的配置。不附带任何 GitHub、飞书渠道。

## 1. 先跑通本地示例

1. 在 Superagent → 信息源 →「开发指南 / 复制给 Agent」中导出开发套件。插件中心也有「Superagent 信息源开发指南」入口。
2. 插件中心 → 加载开发目录 → 选择导出的 `superagent-source-local`。保持 Superagent 已启用。
3. Superagent → 信息源，选择「本地模拟源」，选择项目、协调 ACP Agent 和执行 ACP Agent，勾选接收并保存。先保留人工审批。
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
| `{accepted:true, duplicate:false, ticketId}` | 任务已经持久化，可以推进来源游标 |
| `{accepted:true, duplicate:true, ticketId}` | 已接收过同一事件，不重复创建任务，可以确认 |
| `{accepted:false, duplicate, reason}` | 明确拒绝；记录原因并按渠道约定确认或进入死信队列，不盲目循环重试 |
| `emit()` 抛错 | 尚未确认接收；持久保留事件，以相同 `id` 稍后重试，不先推进来源游标 |
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
