# AgentBerth 图标

使用内置 imagegen 生成，主题为深海军蓝底、薄荷绿 B 字母和终端提示符，透明圆角外缘。通过缩放与格式转换生成桌面资源，未额外绘制或替换图形内容。

- `app.png`：512 × 512 RGBA，窗口、Linux 托盘与界面品牌图。
- `app.ico`：小尺寸使用带 AND 透明掩码的 32 位 DIB，256 像素使用 PNG，兼容 Windows 托盘及 Shell 图标提取。包含 16、20、24、32、40、48、64、128、256 像素，Windows 程序、窗口、托盘、安装器和卸载器共用。

在安装 Pillow 的开发环境执行 `python scripts/build-icons.py [选定的正方形源图.png]` 可重新转换；不传源图时从 app.png 重建。

## 最终生成提示词

```text
Use case: logo-brand. Asset type: production Windows desktop application icon for AgentBerth (泊栈), a workspace that docks and manages coding-agent terminals. Create ONE polished square app icon, straight-on flat graphic, no mockup. A bold distinctive geometric capital B monogram subtly combines a terminal prompt (>_) and a sheltered berth/dock shape. The mark must remain immediately legible at 16x16 and 32x32 pixels: extremely simple silhouette, thick clear strokes, generous internal gaps, no tiny ornament. Center a bright mint green (#70DFC0) monogram on a dark navy (#101A24) softly rounded square tile with restrained tonal depth, no glossy 3D, no outer shadow. Tile occupies roughly 94 percent of canvas width and height, and outside the tile is genuinely transparent. Use the established dark-navy and mint brand palette, professional developer-tool aesthetic. No words, no app name, no watermark, no additional text or labels, no extra icons, no surrounding scene. 1024 by 1024 square composition.
```
