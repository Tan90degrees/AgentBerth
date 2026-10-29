# 发布流程

## 发布前

1. 更新 package.json、package-lock.json 中的版本，并同步 README 的下载文件名。
2. 更新 CHANGELOG.md，新增 `docs/releases/v<版本>.md`，包含功能、安装/升级与已知限制。
3. 对变更运行 `npm run check`；PR 的 Windows/Linux 桌面和 Windows 打包回归必须通过。
4. 在评审通过并获得发布授权后合入 main。首版通过 MR #1 合入。

## 自动发布

`CI and Windows packages` 在 main 上执行全部检查。仅当 check 的两个系统和 windows-package 均成功时，Publish verified release 才会运行；PR、开发分支与 fork 不发布。

开发分支通过 PR 事件执行完整验证，避免 push 与 PR 同时重复构建。未创建 PR 时，可在 Actions 手动运行工作流并选择分支生成测试包；main 的推送继续自动验证并发布。

发布任务从同一次运行下载验证包，校验版本、提交、main 分支、packagedSmoke=success、installerSmoke=success、四个更新/安装载荷的 SHA-256、文件名及发布说明。随后创建轻量版本标签和草稿 Release，上传六个附件，再核对附件状态、大小和 GitHub 返回的摘要；main 仍指向该提交时才公开 Release。

- 上传中断时，草稿保留；从原运行重跑可继续上传。
- 已公开的同一提交/版本不重复发布，也不覆盖附件。
- 普通 main 提交沿用已发布版本时跳过发布；新版本必须增加版本号。
- 标签已指向其他提交且版本尚未公开时直接失败，不移动标签。
- main 在上传期间前进时保留草稿，避免自动发布过时提交。

正式包提供安装 EXE、免安装 ZIP、轻量更新 ZIP、更新清单 JSON、SHA256SUMS.txt、build-info.json。构建信息记录版本、提交、分支、运行链接、打包测试和实际安装器测试结果；两项测试均通过后才允许发布。

桌面与打包后测试分别执行工作台套件和文件预览/Git 套件，各自使用独立的 5 分钟步骤时限，避免前一组耗时挤掉后一组。全部原有断言保留，任一组失败仍使任务失败；未取消时会继续执行另一组以提供独立诊断。打包信息中的 `packagedSuites.workbench` 与 `packagedSuites.files` 分别记录结果，只有两组都为 success 时 `packagedSmoke` 才为 success。发布脚本同时核对总结果和存在的分组结果，失败、取消、跳过或缺少任一分组结果的包均不能发布；旧格式构建信息继续按原有总结果验证。本地 `npm run test:desktop` 和 `npm run test:packaged` 仍按顺序执行两组。

Windows 安装定制位于 `build/agentberth-installer.nsh`。保留 electron-builder 的引导、应用 ID、注册表、快捷方式和卸载器生成/签名，仅通过包含路径中的两个薄包装替换文件准备及旧版清理。此实现与锁定的 electron-builder 26.15.3 模板配套；升级构建器时需复核包含顺序及宏名。`afterSign` 钩子为最终程序生成文件清单，避免图标/版本资源或签名修改造成校验失配；同时固定 7z 使用 BCJ 过滤器，规避当前解码器静默跳过 ARM64 原生文件的[上游问题](https://github.com/electron-userland/electron-builder/issues/9983)。`scripts/test-installer.ps1` 使用构建出的真实 EXE，覆盖进度、日志、首次和升级取消、取消后继续、损坏旧卸载器的升级、后台运行保护、当前用户/所有用户安装及卸载。测试日志和截图保存到 `installer-smoke-Windows` 产物。

只有发布任务有 contents:write 权限，其余任务只读。无需配置个人 PAT。不要在 PR 工作流中直接发布，也不要把失败的打包产物手动当作正式版本。

## 安装器问题复检

CI 将原始文件清单单独保存为 `installer-payload-inventory`。在 Actions 手动运行 `Recheck existing Windows installer`，输入同一次构建的 run ID，可直接下载该清单与 `AgentBerth-Windows-x64`，复检安装、取消、升级和卸载，无需重新打包。复检记录安装包提交与测试提交，不修改原包的构建信息，也不发布软件。

Windows 测试显式等待 GUI 类型的 Electron 校验进程，按本轮启动时间筛选日志，发现 `FAILED` 即退出。升级回归包含中文/空格目录、超过 260 字符的旧文件，以及文件真正被占用时的完整文件恢复。卸载清理只在文件操作阶段切换到 Windows 扩展长度路径；快捷方式和注册表沿用原有路径，成功或失败回调恢复正常显示路径。

## 图标

`assets/app.png` 为 512 像素透明底图，`assets/app.ico` 包含 16–256 像素多种尺寸。主进程从资源文件创建窗口与托盘图标，启动时检查图像非空；electron-builder 将 ICO 用于 Windows 程序、安装器和卸载器。源图与转换方法见 assets/README.md。

## 本地验证发布脚本

`npm run test:scripts` 覆盖校验失败、分支门禁、草稿上传顺序、中断恢复、重复运行、冲突标签、已发布附件保护和 main 前进等行为，测试使用本地替身，不访问 GitHub 或公开版本。

## 软件内更新包

Windows 打包后运行 `npm run dist:update`，通过构建机的 Python 标准库压缩最终 resources 目录，无需给用户安装 Python。更新包与 Electron 版本、平台、架构和后台 API 最低版本绑定；发布脚本校验清单和压缩包摘要。`hotUpdateSmoke=success` 是 v0.16.0 起的发布前置条件，缺失、跳过或失败均不能发布。

`scripts/smoke-updates.mjs` 使用真实打包 Electron、系统 ZIP 解压器、本地 PTY、SSH 协议连接和 MCP 进程验证更新。测试只控制操作系统的 relaunch 启动步骤，便于 Playwright 附加到新进程；指针切换、进程退出、固定启动器选择更新 ASAR、界面恢复及后台延后切换均走正式代码。夹具仅模拟官方 GitHub 的网络响应，产品不开放自定义下载源或测试绕过参数。

资源更新存入数据目录的 `app-updates/versions`，不覆盖原安装目录。活动版本和回退版本不可被下载操作替换；旧资源保留，避免删除运行中的后台或 MCP 仍可能加载的文件。首次安装更新启动器需要完整软件包；Electron 版本改变时继续使用完整安装包。

`package.json` 的 `agentberthUpdates.minimumBackendApi` 明确声明界面可兼容的最小后台 API；新增兼容功能时保留该值，并用后台版本判断隐藏未生效功能，避免每次迭代都强迫用户结束终端。只有无法兼容旧后台的变更才提高下限；此时更新保留在本地，等待终端结束后再应用。
