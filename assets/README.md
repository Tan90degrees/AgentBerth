# AgentBerth · 泊栈 图标

项目名称恢复为 AgentBerth · 泊栈，保留已采用的叠层图标。源图文件名及下方原始提示词保留生成记录。

使用内置 imagegen 生成，主题为深海军蓝底、象牙白和薄荷绿叠层岛屿，透明圆角外缘。通过缩放与格式转换生成桌面资源，未额外绘制或替换图形内容。

- `app.png`：512 × 512 RGBA，窗口、Linux 托盘与界面品牌图。
- `app.ico`：小尺寸使用带 AND 透明掩码的 32 位 DIB，256 像素使用 PNG，兼容 Windows 托盘及 Shell 图标提取。包含 16、20、24、32、40、48、64、128、256 像素，Windows 程序、窗口、托盘、安装器和卸载器共用。

在安装 Pillow 的开发环境执行 `python scripts/build-icons.py assets/stackisle-source.png` 可重新转换；不传源图时从 app.png 重建。

## 最终生成提示词

```text
Use case: logo-brand. Asset type: production Windows desktop app icon for StackIsle (栈屿), a focused project workspace unifying persistent coding terminals, agent sessions, files and history. Create ONE distinctive square app icon, flat straight-on vector-like graphic, not a mockup. A bold compact architectural island mark made of THREE terraced rounded horizontal slabs with generous negative-space channels, subtly suggesting an S and an orderly stack of workspaces. Warm ivory upper slabs and a single vivid mint-teal lower slab. Place the confident simple mark centrally on a very dark ink-navy rounded-square tile (#102025); restrained flat color, crisp geometric edges, generous optical padding. The mark must remain recognizable at 16px and 32px: only three large simple shapes, thick strokes, no tiny details, no thin outlines, no terminal symbols or letters, no text, no AI sparkle, no robot, no anchor or boat illustration, no gradients, no glossy 3D, no drop shadow. Tile fills about 94% of canvas; OUTSIDE rounded tile must be genuinely transparent. One icon only, 1024x1024 square.
```
