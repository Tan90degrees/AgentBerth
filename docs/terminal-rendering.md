# 终端绘制

工作台优先使用 xterm.js WebGL 渲染器，自绘块字符与框线。TUI 常用的 `█`、`▐`、`│` 等字符属于终端内容，和工作台右侧的滚动条是两回事。仅给右侧滚动条换样式，不能修复 TUI 内的断线。

WebGL 按单元格绘制块字符与框线，保留正常文字的行间距；单格字符超出格宽时缩放以减少覆盖。中文与 emoji 的格宽继续采用前后台一致的 Unicode 11 提供器。窗口缩放继续通过同一输出队列中的尺寸边界，保持 PTY、后台屏幕与前台网格一致，不重启进程。

硬件加速不可用或 WebGL 上下文丢失时，原位回退 DOM，并将额外行间距降为零。缓冲、输入、PTY 和 PID 保留；降级后的字形仍受本机字体影响。再次进入会话时重新尝试 WebGL。不会为纠正显示而清空历史或自动重启 Agent。

CI 用软件 WebGL 运行生产代码，验证真实全屏 TUI 的连续块字符像素、反复缩放后的尺寸和可查找文本、离开页面再接回、图形上下文丢失后的输入与退出。另有 Windows ConPTY / Linux PTY 的顺序与 Unicode 回归。这不能保证覆盖所有显卡驱动或第三方 TUI；如果特定 Agent 仍错位，应保留 Agent/终端版本、Windows 版本、显示缩放比例和复现步骤继续定位。

参考：[xterm 6 的 customGlyphs 与 rescaleOverlappingGlyphs](https://github.com/xtermjs/xterm.js/blob/6.0.0/typings/xterm.d.ts)、[WebGL 插件](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-webgl)。

## Windows ConPTY 生命周期故障

本机 Windows PTY 通过 `src/daemon/windows-pty.ts` 适配锁定的 node-pty 实现。输入管道的异步写入错误、输出管道在就绪前后的错误，以及启动阶段排队的 resize 异常，都需要在具体 PTY 边界处理，外层 RPC 的 try/catch 无法捕获这些稍后发生的事件。

通道失败后只停止并清理对应会话的进程树，运行记录保存失败原因；其他终端继续运行。旧管道在退出或重新启动后送达的错误不会影响新 run，也不会重放用户输入。正常 resize 仍沿用原有输出序号和解析屏障，不重建终端。

此适配访问 node-pty 的 ConPTY 内部接口；升级依赖时必须运行 `tests/windows-pty.test.ts` 的真实 Windows 管道故障用例，以及原有 `scripts/smoke.mjs` 的 Unicode TUI 连续缩放、最大化/还原和重挂接断言。上游背景见 [输入管道缺少错误监听](https://github.com/microsoft/node-pty/issues/942) 与 [延迟 resize 异常](https://github.com/microsoft/node-pty/issues/827)。

异常退出排查：数据目录内的 `daemon.log` 保留滚动的异常记录，`daemon-exit.json` 记录对应 PID 的退出码、信号和时间；不主动转储终端输入、环境变量或鉴权配置。未捕获异常只用 monitor 记录，不在全局吞异常后继续运行。桌面回归失败会输出这两类证据，便于区分 JavaScript 未捕获异常和原生进程终止。日志保存在本机，分享前仍需检查异常消息和堆栈中的本机路径。
