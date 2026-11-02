# Superagent 独立插件包

默认应用已带可启停、配置的 `superagent` 插件，通常直接使用即可。

`npm run build` 另外生成 `dist/superagent-plugin.zip`，发行软件资源的 `examples/superagent-plugin.zip` 也包含此包，可作为用户自定义开发的起点。

独立版本 ID 为 `superagent.custom`。先在插件中心停用内置 Superagent，再安装独立包；同一宿主只启用一个 Superagent 信息源服务提供者。两者使用独立数据目录，不会自动迁移或共享任务。依赖自定义版的信息源清单须把依赖从 `superagent` 改为 `superagent.custom`。想回到内置版时先停用自定义版。

源码在 `src/superagent`，插件入口仅导出 `apply`，视图通过自带 `view.html` 运行，除 Cordis 外的依赖已打包。无 GitHub、飞书适配器，无外部服务默认配置。插件运行可信本机 Node 代码，安装前应确认来源。

完整用法、ACP 配置、来源 SDK、回执与恢复语义见应用资源 `docs/ACP_SUPERAGENT.md` 或仓库同名文档。上游设计参考及 MIT 声明见包内 `UPSTREAM-NOTICE.txt`。
