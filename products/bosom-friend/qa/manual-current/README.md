# Bosom Friend 图文使用手册（v0.13.5）

本目录保存 2026-09-01 根据当前产品界面重新抓取的图文手册资产：

- `用户使用手册-图文版.md`：可维护正文与图片引用；
- `build-manual.py`：复用线上旧版手册样式，生成独立 HTML；
- `*.png`：由本机 Bosom Friend Web（127.0.0.1:3080）实机截图；
- `manual-preview.png`、`preview-*.png`：渲染检查截图。

重新生成：

```powershell
python build-manual.py
```

生成结果写入 `C:\Users\Jay\Desktop\ZhiYin-Ai smart system\docs\用户使用手册-图文版.html`，
Markdown 与截图同步复制到同名 `docs\manual-shots\`。
