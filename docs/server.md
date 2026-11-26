# AgentBerth Linux 服务器

Linux 服务器在独立进程中运行工作区、PTY、ACP、文件、Git、Superagent 和 Wiki。使用同版本的 AgentBerth 桌面客户端连接。退出桌面或网络断开后，服务端运行中的会话仍由服务器持有。

## 安装与启动

下载对应架构的 `AgentBerth-Server-*-linux-x64.tar.gz` 或 `AgentBerth-Server-*-linux-arm64.tar.gz` 和 SHA-256 校验文件。运行环境使用带 glibc 的 Linux 和 Node.js 24。建议以专用普通用户运行。将 Agent 运行时及模型配置放在该用户的服务端环境。

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

## 桌面连接

点击桌面右上角的工作区按钮，填写地址和令牌。勾选「记住令牌并在下次打开时连接」会使用操作系统的安全凭据存储。切换时，桌面分别保存本机和服务器的草稿、项目选择和 SSH 凭据。新建项目可浏览服务器目录。Agent 启动程序、项目目录和 SSH 密钥路径使用服务器上的值。

选择下面任一接入方式。

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
