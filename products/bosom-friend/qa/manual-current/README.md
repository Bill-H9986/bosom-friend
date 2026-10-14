# 图文使用手册（qa/manual-current）

面向最终用户的《知音 · 图文使用手册》维护目录。

## 当前版本：v0.2.54（`v0.2.54/`）

| 文件 | 作用 |
| --- | --- |
| `v0.2.54/用户使用手册-图文版.md` | **手册正文源文件**（Markdown，改内容只改这里） |
| `v0.2.54/build-manual.mjs` | 生成器：Markdown + 实机截图 → 单文件自包含 HTML |
| `v0.2.54/manual.css` | 版式（沿用上一版发布页：顶栏 / Hero / 目录侧栏 / 卡片章节 / 灯箱） |
| `v0.2.54/shots/` | 正文引用的配图（生成时从截图目录复制并转 JPEG 内嵌） |
| `v0.2.54/知音 · 图文使用手册.html` | **交付物**：单文件，可离线打开，也可直接发布到静态站点 |
| `v0.2.54/capture/*.mjs` | 实机抓图脚本（Playwright，跑在 :31280 的源码运行时上） |
| `capture-0.2.54/` | 抓图原始产物（1600×1000 PNG）与 `ui-text.json`（各页真实界面文字，写文案时的依据） |

重新抓图并生成手册：

```powershell
# 1) 启动源码运行时（http://127.0.0.1:31280/bosom-friend/）
powershell -File products/bosom-friend/launcher/scripts/dev-web.ps1
# 2) 抓图（按需，输出目录默认用 qa/manual-current/capture-0.2.54）
node products/bosom-friend/qa/manual-current/v0.2.54/capture/capture-pages.mjs <输出目录>
node products/bosom-friend/qa/manual-current/v0.2.54/capture/capture-states.mjs <输出目录>
node products/bosom-friend/qa/manual-current/v0.2.54/capture/capture-tabs.mjs <输出目录>
node products/bosom-friend/qa/manual-current/v0.2.54/capture/capture-final.mjs <输出目录> <仓库根>
# 3) 生成手册
node products/bosom-friend/qa/manual-current/v0.2.54/build-manual.mjs
```

出图约定：视口 1600×1000（启动页 1440×900，与桌面窗口一致）；每张配图在正文里紧跟一张
「编号 / 区域 / 说明」表，表格按「从左到右、从上到下」描述；配图一律是**实机截图**，
不使用示意图或占位图。界面文字以 `capture-0.2.54/ui-text.json` 为准，避免照抄过期文档。

## 历史文件（已过期，仅作留档）

- `用户使用手册-图文版.md`（2026-09-01，v0.13.5 时代）、`build-manual.py` 与 `01-home.png` ～ `16-rule-modal.png`：
  正文与配图都是旧版界面（"AI 内容营销系统"紫色版），已被 `v0.2.54/` 取代。
- `old-html-shots/`：从线上发布页（bill-h9986.github.io/zhiyin）另存下来的旧版内嵌配图，
  记录"正文已更新到 0.2.54、配图仍是旧界面"的那一版，供比对。
