# AgentBerth Cordis 插件开发指南

适用：AgentBerth 0.17 / 后台 API 41。插件框架使用固定版本 Cordis 4.0.0-rc.12；借鉴 DeepSeek Harness 的作用域与副作用管理，不承诺直接加载 DSH 的业务插件。

用户只需在 **设置 → 插件 → 安装插件包** 选择 ZIP，或用 **加载开发目录** 选择目录。插件自动启用，配置在同一页面实时应用。开发目录保存后自动重载；失败保留上一版代码与配置，页面显示错误。无需修改 Agent 的配置来安装工作台插件。

## 给开发 Agent 的任务

先读取本指南和 `examples/cordis-agent`。确认用户的 CLI、真实启动/恢复参数、Skill 实际加载目录和需要的能力。实现一个 Cordis 插件包，Agent 与 Skills 在同一次 `ctx.berth.agent()` 注册。不要臆造私有 TUI 的事件接口或记录 TUI 屏幕充当历史。使用已有 Claude / OpenCode 接入时声明 `integration`；其他私有 CLI 只有声明并实现了真实协议的能力才能显示。不要替用户登录、改变权限或启动真实任务。最终交付根目录含清单的 ZIP，并说明已验证能力与限制。

## 最小包

复制 `examples/cordis-agent` 即可修改，不需要 npm install。ZIP **根目录**必须有：

- `agentberth.extension.json`：清单、配置、依赖与视图。
- `index.cjs`：已打包的 CommonJS 入口，导出 Cordis 函数或 `{ apply(ctx, config) }`。
- 清单声明的 HTML、脚本和其他资源。

不要把整个 node_modules 打包。使用 TypeScript 时自行用 esbuild 打包为 `.cjs`，把 `cordis` 和 `electron` 标记 external；在普通入口中不要加载 Electron。包内禁止符号链接、绝对路径和 `..`，限制 64 MiB / 2000 文件。插件运行可信的本机 Node 代码，具有当前用户的权限，**不是安全沙箱**。

清单字段：

| 字段 | 说明 |
| --- | --- |
| `apiVersion` | 固定为 1 |
| `id` | 稳定的小写字母、数字、点或连字符；不能覆盖内置 ID |
| `name` / `version` | 显示名称与 SemVer 版本 |
| `entry` | 后台 `.cjs` 入口，默认 `index.cjs` |
| `desktopEntry` | 可选，Electron 主进程 `.cjs` 入口，适合自定义桌宠或独立窗口 |
| `dependencies` | 必须启用的插件 ID；缺失时等待，不偷偷安装依赖；拒绝依赖循环 |
| `config` | 配置字段，支持 string / number / boolean、default、title、description、minimum、maximum、enum |
| `views` | `{id,title,location,entry}`；location 为 sidebar、panel 或 settings；HTML 须自包含 |

内置插件 ID：`workspace`、`appearance`、`agents`、`agent.codex`、`agent.claude`、`agent.opencode`、`ssh`、`files`、`git`、`resources`、`pet`。核心仅保留配置存储、传输、插件管理和应用生命周期。工作台 RPC 随插件作用域注册与注销。已有单文件 Agent 适配器作为 `agents` 插件的兼容能力保留，不要求迁移现有会话。

## 后台 SDK

入口上下文为真正的 Cordis Context，可使用 `ctx.plugin()` / `ctx.effect()`；同一插件的所有副作用必须登记清理函数。初始化应在 5 秒内完成；长任务由命令启动，不能阻塞 apply。禁止在模块顶层启动进程或监听器，因为顶层代码无法由 Cordis 回收。其他依赖须打包进插件；Cordis 服务依赖可以由子插件声明。

| API | 用途 |
| --- | --- |
| `ctx.berth.id` / `dataDirectory` | 插件身份与持久数据目录；卸载保留此目录 |
| `ctx.berth.signal` | 作用域释放时 abort |
| `ctx.berth.command({name,description,inputSchema}, handler)` | 注册插件命令；同时进入 MCP 的动态工具列表；参数由 AJV 校验 |
| `ctx.berth.agent({id,definition})` | 同时注册 Agent 类型、原生适配和 Skills |
| `ctx.berth.effect(setup)` | setup 返回清理函数；异步 setup 请优先 `await ctx.effect(...)` |
| `ctx.berth.interval(callback,ms)` | 自动清理的同步定时器，至少 100 ms |
| `ctx.berth.call(method,params)` | 调用当前已启用功能的后台 RPC；MCP 命令继承调用方连接身份 |

命令名用小写 snake_case，不能把 `agentId` 用作业务参数；它由 MCP 保留为调用方标识。inputSchema 必须为 object。返回 JSON，最多 128 KiB，长结果应分页。MCP 工具名为 `extension_<稳定ID摘要>_<命令名>`；不要硬编码摘要，从 tools/list 获取。启停后支持 tools/list_changed 的客户端自动刷新，不支持的客户端需刷新或重连。SDK 不会为命令错误自动重放。

`definition` 与原有 Agent 配置一致：`name`、`command`、可选 `resumeCommand`、`integration: claude|opencode`、`skills:{project,user}`、`plugin`。Skills 的项目路径必须为相对目录，用户路径为绝对路径或 `~/`；仅声明 CLI 真正使用的位置。历史脚本、分页列表、私有恢复协议见 [兼容适配器指南](AGENT_PLUGIN_DEVELOPMENT.md)。使用 `__dirname` 指向包内历史适配脚本；`plugin.runtime: node` 使用应用自带运行时。注册 ID 在更新中保持不变，应用为其派生稳定 Agent ID，已有会话和默认项不因重载变更。

## UI 与桌面入口

HTML 视图置于无 Node 的 sandbox iframe，不能联网或直接访问工作台。用 `await window.agentberth.call(command, params)` 调用**自己的**命令；不要加载外部 JS/CSS。sidebar / panel 入口显示在侧边栏并在主区打开，settings 视图在插件卡片内展开。主程序校验消息来源，不允许视图指定其他插件 ID。

`desktopEntry` 同样导出 Cordis 插件，通过 `require('electron')` 使用桌面 API。上下文提供 `ctx.desktop = {id,dataDirectory,call}`，每次配置和代码更新会释放旧作用域再加载新作用域。示例：

```js
exports.apply = ctx => {
  const { BrowserWindow } = require('electron');
  ctx.effect(() => {
    const win = new BrowserWindow({ width: 240, height: 200,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.loadURL('data:text/html,<h1>My companion</h1>');
    return () => { if (!win.isDestroyed()) win.destroy(); };
  });
};
```

自定义宠物动作可以用自己的窗口与 GIF；现有桌宠的形象设置继续可用。框架不会伪造私有 Agent 的精确执行状态；需要官方事件源或用户选择的适配能力。不要静默修改全局 Agent 配置。

## 生命周期与验证

配置、启停、安装、卸载被串行处理；停用依赖会释放其依赖者的作用域，重新启用后自动恢复。若相关插件仍持有正在运行的终端、命令、历史读取或 Git 操作，修改会明确拒绝，绝不默默杀掉任务；其他无关插件可独立修改。配置和开发重载失败恢复旧后台模块及配置。卸载移除受管理的代码包，保留配置、数据与会话；开发模式绝不删除源目录。内置插件可重新安装，外部插件卸载后需重新选择包。

验证顺序：安装 → 读取短命令 → 应用配置 → 开发重载 → 故意语法错误并确认旧版仍工作 → 停用依赖并确认工具/视图消失 → 重新启用 → 卸载并检查定时器/监听器/窗口均释放 → 重启确认配置与原会话保留。为 Agent 接入额外验证 Skill 列表、导入/启停与原生历史恢复；不支持的能力保持未声明。

桌面入口在主进程独立激活，失败会显示在插件卡片中，修复后可重新加载；后台的回滚保证不代表跨进程的桌面窗口也能原样恢复。插件的异步清理也必须自行响应取消，框架无法终止恶意或阻塞事件循环的本机代码。
