# 桌宠与 Agent hook

安装后先在 **设置 → 后台服务** 更新空闲后台至 API 38，再在 **设置 → 桌宠** 开启桌宠，也可从托盘选择“显示桌宠”。默认关闭，不会额外占据终端面积。桌宠只展示本机 Codex、Claude、OpenCode 和自定义 Agent 会话，普通 Shell 与 SSH 远程终端不展示；即使向它们发送 hook 也不会抢占桌宠。旧选中项被排除后自动切换到有效 Agent，没有 Agent 时显示空状态。桌宠是可拖动的独立透明窗口，平时仅显示角色图像，以动作展示 Agent 状态。左键按住图像拖动，右键图像打开系统原生菜单：查看当前 Agent/状态、切换 Agent、打开当前会话、调整大小、置顶、自动关注待处理会话、复制 hook 教程、前往桌宠设置或隐藏。无需常驻会话栏、状态卡片或关闭按钮。聚焦图像后也可按 Enter、空格或 Shift+F10 打开菜单。关闭主窗口后桌宠仍然显示，隐藏桌宠不影响终端；托盘退出会一并结束应用和 hook 监听。

可选择置顶、50%–200% 大小，以及等待输入/失败时自动切换会话。大小可在设置页或右键菜单直接调节，自动保存并同步；系统原生菜单独立于角色窗口，缩小桌宠后操作项也不会被裁切。拖动直接作用在图像上，左键拖动与右键操作分开处理。默认采用 dsh-pet 的完整 Q 版角色动画，提供空闲、执行、等待、完成、失败、状态待确认六种动作。保留原始 24 fps 节奏和半透明边缘，默认动画使用 WebP；用户仍可导入 GIF。设置页使用静态图，悬停或聚焦播放预览；减少动态时保留静态角色。为任意状态导入本地 GIF 即可替换动作；支持透明背景、每文件最多 8 MiB、边长最多 2048 px。文件复制到应用数据目录，原文件移动后仍可使用；恢复默认只重置对应动作。跟随系统的减少动态效果设置。

## 一键安装 Claude / OpenCode 适配

在 **设置 → 桌宠** 选择 Claude Code 或 OpenCode，再选项目或用户范围，点击 **安装/更新适配**。它只修改对应 hook/插件文件，不安装 Agent、不修改模型、账号或权限。已有配置保留，有变更时生成 `.agentberth-<id>.bak` 备份；再次安装按命令去重。损坏的 JSON 或非本应用管理的同名插件不会被覆盖。安装后重新启动对应 Agent 会话。

Claude 项目文件为 `.claude/settings.local.json`；用户文件为 `$CLAUDE_CONFIG_DIR/settings.json`（默认 `~/.claude/settings.json`）。OpenCode 项目插件为 `.opencode/plugins/agentberth-pet.js`；用户插件为 `$XDG_CONFIG_HOME/opencode/plugins/agentberth-pet.js`（默认 `~/.config/opencode/plugins/agentberth-pet.js`）。同一范围只安装一次，避免同时在项目和全局重复安装。

OpenCode 自动执行本机 `opencode --version` 选择 1.x 的函数式插件或 2.x 的 setup 插件，不安装 npm 包。工作/授权或问题等待/完成/错误均来自真实事件，不发送 prompt、工具参数或输出。子会话完成不能结束主会话。2.x 需独立服务继承当前运行的身份，标准启动和恢复自动附加 `--standalone`；非标准包装命令自行转发该参数。共享 `--server` 无法按终端安全归属，因此不参与桌宠绑定。上游接口参考 [OpenCode 官方插件文档](https://opencode.ai/docs/plugins/) 和 [2.x Promise Plugin API](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/README.md)。

原生 ID 按项目、类型和运行标识精确绑定。手动关联或解除优先；新对话可在同一终端更新自动关联。OpenCode 历史通过官方 CLI 列表和导出读取，两代格式均可使用；TUI 启动时不额外查询历史、不定时轮询数据库。缺少 CLI、超时或输出为空时显示错误，可手动导出并导入 JSON。Claude 继续读取本机 JSONL，导入不改写原文件。

自定义 Agent 导入文件声明 `integration: "claude"` / `"opencode"` 可继承适配，Skills 遵循对应配置目录，显式的历史/列表插件和 Skill 目录优先。恢复命令由配置文件声明。查看 [插件开发指南](AGENT_PLUGIN_DEVELOPMENT.md)。

## 让 Agent 自动配置

1. 在 AgentBerth 中启动 **Agent 类型**会话，进入 **设置 → 桌宠 → Agent hook 自动配置**。
2. 点击 **复制给 Agent 自动配置**，把完整说明粘贴给该 Agent；也可展开“查看完整自动配置教程”在应用内阅读。
3. 说明自动带入当前安装的运行时、脚本和数据目录，指导 Agent 识别版本、备份原配置、保留已有 hook、去重合并并验证真实事件；要求按命令去重，避免重复添加处理器。说明不含 token 或固定的会话/运行 ID，也不要求另装 Node.js。
4. 配置完成后，重新启动对应 Agent 会话以加载配置与绑定环境变量；当前任务仍在运行时先让它完成。让 Agent 执行一个真实工具调用并完成本轮，右键桌宠查看当前 Agent 和状态，确认动作变化。

没有 hook 的私有 TUI 会明确显示“状态待确认”，不会从终端输出猜测。生成的教程要求 Agent 报告不支持、缺少环境变量或尚未验证的情况；脚本失败也会返回 0，不能仅凭退出码宣称接入成功。

## Claude Code 手动配置

1. 在设置的桌宠页面，点击 **复制 Claude Code hook 配置**。
2. 将复制的 `hooks` 合并到自己的 `~/.claude/settings.json` 或项目 `.claude/settings.local.json`，保留原有 hook。
3. 在 AgentBerth **重新启动本机会话**，然后使用 Claude Code。已有进程没有新注入的会话标识，必须重新启动。

配置使用 Claude Code 当前的 command hook 格式；Windows 显式选择 PowerShell，其他平台使用 Shell。事件从 stdin 接收，配置设置短超时，脚本失败返回 0，不参与权限决策，不向 stdout 输出提示词或决策。只转发会话与运行 ID、状态，以及用于精确关联的原生 ID 和项目目录，不保存 prompt、命令输入、工具输出或完整 hook 原文。上游格式见 [Claude Code 官方 hook 文档](https://code.claude.com/docs/en/hooks)。

| hook | 桌宠状态 |
| --- | --- |
| SessionStart、SessionEnd | 空闲 |
| UserPromptSubmit、PreToolUse、PostToolUse | 执行中 |
| PreToolUse 且工具为 AskUserQuestion | 等待处理 |
| PermissionRequest、Notification 的 permission_prompt / idle_prompt / elicitation_dialog | 等待处理 |
| Stop | 完成 |
| StopFailure、PostToolUseFailure | 失败 |

SubagentStop 不会被当作整个会话完成。多个 AgentBerth 会话使用各自的会话/运行 ID，不会因为 cwd 或 Agent 原生 session_id 相同而串台。同一个终端内部的多个 subagent 合并显示该终端状态，不为每个子任务虚构独立终端。

## 自定义 Agent / 私有 TUI

不需要修改 TUI 渲染或开源。只要它支持事件 hook，就在相应 hook 中调用软件包内 `resources/pet/pet-hook.cjs`；开发环境对应 `dist/pet-hook.cjs`。如果没有 hook 能力，显示“状态待确认”，不从屏幕猜测思考状态。

AgentBerth 启动的每个**本机终端**会获得以下环境变量，子进程自动继承：

- `AGENTBERTH_DATA_DIR`：当前实例数据目录，脚本用于发现监听地址。
- `AGENTBERTH_SESSION_ID`：工作台会话 ID。
- `AGENTBERTH_RUN_ID`：本次启动 ID。
- `AGENTBERTH_AGENT`：解析后的 Agent 类型，防止跨类型子进程误报。
- `AGENTBERTH_NATIVE_SESSION_ID`：恢复运行的原生 ID（新运行为空）。

脚本支持 `--event working|waiting|completed|error|idle`，或从 stdin JSON 的 `hook_event_name` / `event` 接收事件。也支持显式 `--data-dir`、`--session-id`、`--run-id` 和诊断选项 `--verbose`。不要传入服务器密码或私钥，也不要把 hook token 写进 Agent 配置。

已安装 Node.js 的自定义 Agent 可以使用以下形式（替换脚本路径）：

```sh
node /path/to/resources/pet/pet-hook.cjs --event working
```

Windows PowerShell 可直接复用应用自带运行时，无需另装 Node；路径由实际安装位置决定：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'C:\Path\AgentBerth.exe' 'C:\Path\resources\pet\pet-hook.cjs' --event working
```

也可将以下 JSON 通过 stdin 送给该脚本，ID 使用继承的环境变量，无需在正文重复填写：

```json
{"event":"waiting"}
```

长时间没有工具调用的任务可以每隔数分钟发送一次 `working` 作为心跳；超过十分钟没有执行状态事件会显示“状态待确认”，不会自行宣称完成。等待输入不会自动超时。重启应用后不会恢复旧 hook 状态，而会等待当前运行的新事件。

## SSH、断线与边界

桌宠仅接收本机 Agent 类型会话的 hook，SSH 和普通终端不进入桌宠列表、待处理计数或自动切换范围。点击“打开当前会话”只导航到对应本机 Agent；SSH 面板及 MCP 控制保持原有独立工作方式。后台断线时明确显示“状态待确认”。

hook 接口仅监听本机回环地址，随机端口，鉴权信息在当前数据目录的 `pet-hook.json` 中，由每次应用启动重新生成。请求限制为 4 KiB，只接受已有本机 Agent 会话的当前运行 ID；已停止、已删除、旧运行事件会被拒绝。脚本没有命令执行、终端输入或文件读写控制接口。未运行应用或 hook 失败时脚本静默退出且返回成功，不阻断 Agent 工作；必要时使用 `--verbose` 排查。不要分享 `pet-hook.json`。

桌宠与 hook 接收服务属于桌面应用，主窗口隐藏仍有效；完全退出桌面应用后停止接收。不会更改终端控制权、MCP 的 Agent 隔离或命令输出预算。

## 默认素材来源

角色与动画来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的 MIT 授权素材；透明帧来自 [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu)，固定版本见 assets/pet/source.json。两份 MIT 许可证随软件安装。动作、原始视频校验值和离线输出校验值保存在 src/renderer/pet-assets/provenance.json；安装后无需下载素材，也不需要 Python。

有 Pillow 12.0.0 的开发环境可运行 `python scripts/build-pet-assets.py` 重建，或加 `--check` 离线校验。完成与失败动作完整播放一次；循环动作保留原片段，不用静态图缩放代替动作。
