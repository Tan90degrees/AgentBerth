# 发布流程

## 发布前

1. 更新 package.json、package-lock.json 中的版本，并同步 README 的下载文件名。
2. 更新 CHANGELOG.md，新增 `docs/releases/v<版本>.md`，包含功能、安装/升级与已知限制。
3. 对变更运行 `npm run check`；PR 的 Windows/Linux 桌面和 Windows 打包回归必须通过。
4. 在评审通过并获得发布授权后合入 main。首版通过 MR #1 合入。

## 自动发布

`CI and Windows packages` 在 main 上执行全部检查。仅当 check 的两个系统和 windows-package 均成功时，Publish verified release 才会运行；PR、开发分支与 fork 不发布。

发布任务从同一次运行下载验证包，校验版本、提交、main 分支、packagedSmoke=success、installerSmoke=success、两个包的 SHA-256、文件名及发布说明。随后创建轻量版本标签和草稿 Release，上传四个附件，再核对附件状态、大小和 GitHub 返回的摘要；main 仍指向该提交时才公开 Release。

- 上传中断时，草稿保留；从原运行重跑可继续上传。
- 已公开的同一提交/版本不重复发布，也不覆盖附件。
- 普通 main 提交沿用已发布版本时跳过发布；新版本必须增加版本号。
- 标签已指向其他提交且版本尚未公开时直接失败，不移动标签。
- main 在上传期间前进时保留草稿，避免自动发布过时提交。

正式包提供安装 EXE、免安装 ZIP、SHA256SUMS.txt、build-info.json。构建信息记录版本、提交、分支、运行链接、打包测试和实际安装器测试结果；两项测试均通过后才允许发布。

Windows 安装定制位于 `build/agentberth-installer.nsh`。保留 electron-builder 的引导、应用 ID、注册表、快捷方式和卸载器生成/签名，仅通过包含路径中的两个薄包装替换文件准备及旧版清理。此实现与锁定的 electron-builder 26.15.3 模板配套；升级构建器时需复核包含顺序及宏名。`afterSign` 钩子为最终程序生成文件清单，避免图标/版本资源或签名修改造成校验失配。`scripts/test-installer.ps1` 使用构建出的真实 EXE，覆盖进度、日志、首次和升级取消、取消后继续、损坏旧卸载器的升级、后台运行保护、当前用户/所有用户安装及卸载。测试日志和截图保存到 `installer-smoke-Windows` 产物。

只有发布任务有 contents:write 权限，其余任务只读。无需配置个人 PAT。不要在 PR 工作流中直接发布，也不要把失败的打包产物手动当作正式版本。

## 图标

`assets/app.png` 为 512 像素透明底图，`assets/app.ico` 包含 16–256 像素多种尺寸。主进程从资源文件创建窗口与托盘图标，启动时检查图像非空；electron-builder 将 ICO 用于 Windows 程序、安装器和卸载器。源图与转换方法见 assets/README.md。

## 本地验证发布脚本

`npm run test:scripts` 覆盖校验失败、分支门禁、草稿上传顺序、中断恢复、重复运行、冲突标签、已发布附件保护和 main 前进等行为，测试使用本地替身，不访问 GitHub 或公开版本。
