# AgentBerth Linux 服务器

Linux 服务器在独立进程中运行工作区、PTY、ACP、文件、Git、Superagent 和 Wiki。使用同版本的 AgentBerth 桌面客户端连接。退出桌面或网络断开后，服务端运行中的会话仍由服务器持有。

## 在桌面版自动部署

1. 在桌面右上角打开「工作区连接」，选择「SSH」。
2. 输入服务器 IP 或主机名、SSH 端口和用户名。选择密码或本机 SSH 私钥，按需填写私钥口令。首次连接时核对服务器的 SHA-256 主机指纹。
3. 点击「探测服务器」。按探测结果选择「进入工作区」「启动并进入」或「部署并进入」。

桌面安装包内置匹配版本的 Linux x64、ARM64 包和 Node.js 运行时。服务器需使用 glibc，开放 SSH shell、SFTP 和到服务器自身回环地址的 SSH TCP 转发。桌面上传后校验 SHA-256，安装到当前 SSH 用户的 `~/.local/opt/agentberth-server`，数据保存在 `~/.local/share/agentberth-server`。自动部署使用账号权限和 SSH 端口，不需要 sudo、单独开放 AgentBerth 端口或填写服务令牌。服务器上的 Agent CLI 与模型授权由该 SSH 用户配置。

服务账户已启用 systemd lingering 时优先使用用户服务 `agentberth-workspace.service`。其余环境使用独立后台进程，日志在 `~/.local/share/agentberth-server/service.log`。如果服务器会在 SSH 注销时清理该用户的后台进程，由系统管理员为服务账户启用 lingering。已有兼容服务会直接复用，离线的已有安装会启动。探测读取同一用户标准数据目录中的运行描述符。使用自定义目录的部署可以通过「地址与令牌」连接。

在系统支持安全凭据存储时，可以勾选「记住 SSH 登录并在下次打开时连接」。首次信任的指纹按主机和端口保存。服务器更换 SSH 主机密钥后，先从服务器控制台核验，再处理本机数据目录的 `workspace-ssh-hosts.json` 对应记录。

切换时，本机和服务器各自保留草稿、项目选择和 SSH 凭据。新建项目可直接浏览服务器目录。远程工作区的 Agent 启动程序、项目目录和工作区内 SSH 连接的密钥路径使用服务器上的值。

## 安装服务器插件

连接远程工作区后，在桌面「扩展管理」点击「安装扩展插件」或「安装 Agent 插件」，选择本机 ZIP。桌面上传到当前服务器，由服务端验证并安装，已部署的 SSH 服务可直接使用。插件的后台入口与 HTML 页面在远程工作区可用，依赖的程序和配置使用服务器环境。开发目录和 Electron 桌面入口用于本机工作区。

通过「地址与令牌」连接时，服务端需支持 ZIP 上传。若经反向代理，把 `POST /extension-package` 转发到同一服务，保留 `Authorization` 请求头，允许插件包上传所需的请求体大小和响应时限。

## 手动安装与启动

下载对应架构的 `AgentBerth-Server-*-linux-x64.tar.gz` 或 `AgentBerth-Server-*-linux-arm64.tar.gz` 和 SHA-256 校验文件。预构建包包含 Node.js 24。使用 `npm run dist:server` 从源码构建且未打包 Node.js 时，服务器需要从 PATH 提供 Node.js 24。建议以专用普通用户运行。将 Agent 运行时及模型配置放在该用户的服务端环境。

```bash
sha256sum -c AgentBerth-Server-*-linux-*.tar.gz.sha256
mkdir -p "$HOME/.local/opt"
tar -xzf AgentBerth-Server-*-linux-*.tar.gz -C "$HOME/.local/opt"
"$HOME/.local/opt/agentberth-server/bin/agentberth-server" --data-dir "$HOME/.local/share/agentberth-server"
```

默认监听 `127.0.0.1:7467`。服务器首次启动生成令牌，令牌文件的权限为 `0600`。需要连接时，从服务端终端读取令牌。

```bash
"$HOME/.local/opt/agentberth-server/bin/agentberth-server" --data-dir "$HOME/.local/share/agentberth-server" --token
```

## 地址与令牌

在桌面「工作区连接」的「地址与令牌」页填写地址和令牌。需要自动重连时，可通过操作系统的安全凭据存储保存令牌。

- **SSH 隧道**。服务器保留默认监听。在桌面机器执行 `ssh -N -L 17467:127.0.0.1:7467 user@server`，在 AgentBerth 中填写 `ws://127.0.0.1:17467`。
- **直接 TLS**。启动时添加 `--bind 0.0.0.0 --port 7467 --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem`，在桌面填写 `wss://server.example.com:7467`。如果使用私有 CA，向桌面提供受信任的 PEM CA 证书。证书的主机名须与填写的地址匹配。
- **TLS 反向代理**。将代理的 `/rpc` WebSocket 转发到 `http://127.0.0.1:7467/rpc`，转发 `Upgrade`、`Connection` 和 `Authorization` 头。桌面使用代理的 `wss://` 地址。

令牌拥有该服务账号的工作台权限，包括读写文件和启动进程。每个信任边界使用独立的 Linux 用户、数据目录和端口。需要更换令牌时，先停止服务，移走原 `server-token`，启动后取得新令牌并更新客户端。连接走加密通道时仍应限制入站来源。

## systemd 用户服务

```bash
mkdir -p "$HOME/.config/systemd/user"
cp "$HOME/.local/opt/agentberth-server/agentberth-server.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now agentberth-server
journalctl --user -u agentberth-server -f
```

默认用户服务使用上面的 SSH 隧道配置。按需通过 `systemctl --user edit agentberth-server` 覆盖启动参数。需要登出后持续运行时可以启用该 Linux 用户的 lingering。

版本升级前通过 systemd 停止进程并备份数据目录。升级后重新连接桌面。服务进程重启会中断正在运行的 PTY 与 Agent 请求，记录可在工作台回看。桌面客户端的退出操作只断开连接。

原生网页插件窗口、桌面侧 Skills 管理和 Hook 安装属于本机桌面集成。服务端的 Agent 配置使用服务器终端管理，支持 HTML 插件页面。会话 Markdown 导出保存到当前桌面机器。服务器上的 MCP 程序可用 `node /path/agentberth-server/dist/mcp.cjs /absolute/server/data-directory` 启动。
