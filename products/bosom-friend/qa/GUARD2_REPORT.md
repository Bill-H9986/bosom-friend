# Guard 2.0 无障碍/质量体系报告

生成时间：$(date '+%Y-%m-%d %H:%M')
环境：http://127.0.0.1:3081/bosom-friend/（DSH 插件后端 + SPA 前端）

## 结论

**qa-guard.mjs：21/21 通过**
**qa-guard2.mjs：19/19 通过**

## 本轮修复清单（Guard 2.0 首次跑分 10/19 → 19/19）

### A11Y（axe WCAG 2a/2aa serious+critical 全清零）

| 页面 | 修复前 | 修复内容 |
| --- | --- | --- |
| 全部 10 页 | 侧边栏激活项对比度不足（#a78bfa） | 新增 `--brand-purple-deep: #5b4bc4`（浅色主题）/ 深色主题回退品牌青，NavSection 激活/悬停/分支态全部改用 |
| #/calendar | button-name ×41、aria-roles ×1 | 上月/下周按钮、周视图+月视图「添加帖子」图标钮补 `aria-label`；DraggableBox 非法 role 移除；公历节日文本色调改深紫 |
| #/draft-box | contenteditable 无可访问名 | MediaMentionPromptInput 编辑器加 `role="textbox" aria-multiline aria-label`；AI 提交钮、平台限制信息钮补 aria-label |
| #/tasks-history | 刷新钮无名字 | 补 `aria-label` + `title` |
| #/settings | 组合框无可访问名、主题选项对比度 | GeneralTab 语言选择补 aria-label；主题标签激活色改深紫 |
| #/accounts | antd Switch 无名字 | 自动接待启用开关补 `aria-label="启用规则：{name}"` |
| #/monitor | #999/#888/#8b7cf6 文本、antd tag | GlobalMonitor/ReceptionMonitor 全部改 `#595959`/`#5b4bc4`/`#047857`；globals.css 加 antd tag 对比度覆盖 |
| 全局 | muted-foreground #6b7280 在浅灰底上 4.40:1 | 加深为 `#5b6472`（5.44:1+），一处 token 修复全站次级文本 |
| 全局 | data-statistics 选中态 `text-primary` | 全部改 `text-brand-purple-deep` |

### PERF 修证（重要）

- 原实现 `performance.getEntriesByType('largest-contentful-paint')` 取值 -1 → **PASS 是假阳性**。
- 升级为导航前注册 `PerformanceObserver`（buffered），并在**独立新页**测冷加载：
  - 实测 **LCP = 380ms**、CLS = 0.003、资源 57 个 / 24.2MB —— 真实达标。
  - 注：探测到 3 个 promptGallery 样例视频（~19MB）在首页被预取，为演示素材预加载；不影响 LCP（低于 3.5s 预算）。

### Guard 2.0 自检（检测器能力证明，防自证循环）

- SELF-CHECK 关键词检测（应命中/不应误报/拆行）——检测器本身经过正反用例校验。
- SELF-CHECK 视觉注入可检测：临时红色 80px 横幅注入后 DPI 检测到 —— 证明视觉检测通路有效。
- VISUAL 布局指纹：10 路由布局签名入基线库，回归时对比。

## 复现命令

```bash
node products/bosom-friend/qa/qa-guard.mjs      # 21 项功能/品牌/布局
node products/bosom-friend/qa/qa-guard2.mjs     # 30 项 a11y/视觉/性能/移动端
```

## 已知说明

- LCP 观察者需在页面脚本前注册（addInitScript），否则 headless 下 `getEntriesByType` 可能为 -1。
- 移动端 5 路由横向溢出/布局断裂检查通过（390×844）。


---

## 更新（2026-08-27 晚 · 六项需求后复跑）

- **qa-guard.mjs：21/21 通过**（功能/品牌/布局/i18n）
- **qa-guard2.mjs：22/22 通过**（a11y 10 页 / 视觉指纹冻结基线 / 毒丸自检 3 类 / LCP=380ms 真实测量 / 移动端 5 页）
- 新增 **LOGO-品牌区无重叠断言**（展开态矩形不相交 && 收起态不同时可见）。
- LCP 采集升级为导航前 PerformanceObserver + 独立新页冷加载；**未采集（-1）即为 FAIL**（防假阳性回归）。
- 本轮六项需求改动全部过门禁后记录于 FULL_QA_REPORT.md 第八节。

## 更新（2026-08-28 · 右侧 AI 助手面板布局定稿）

- **qa-guard.mjs：21/21 通过；qa-guard2.mjs：30/30 通过**（新增 4 项右侧面板 + 2 项首页品牌粒子场 + 1 项功能页无标题门禁）。
- 功能页标题移除：全部功能页（内容创作/我的任务/AI 互动/知识库/全局监控/设置/账号管理）去掉左上角页面标题，与发布日历/数据中心一致；`PageShell` 的 title 改为可选（无标题时顶部栏只保留标签/操作区），全局监控页去除 `全局监控中心` h2。视觉指纹基线已人工固化（prev 备份 + 变更日志）。
- 右侧 AI 助手面板（空间宝贵）：
  - 展开态：紧凑头部 = 32px logo +「AI 助手」+ 32×32 收起钮（与左侧按钮同款样式、**透明底**，不放品牌大 Logo）；
  - 收起态：与左侧一致——36px logo 居中，32×32 展开钮叠在同一位置，hover 侧栏时 logo 淡出、按钮原位浮现（互不同时可见）；
  - 输入框：自动增高上限收紧至 96~180px（面板高度 20%），禁止撑满面板。
- 首页 Hero：静态品牌 LOGO（最终回退）——移除全部流动光、线条蒙版、粒子汇聚效果与巨大粒子点面背景，只保留原始 180px 静态 ∞ LOGO、文案与开始创作按钮。
- 验证：`LOGO-右侧展开态-紧凑头部` / `LOGO/INPUT-右侧输入框紧凑` / `LOGO-右侧收起态-同位置交替` / `LOGO-右侧收起态-悬浮原位替换` 均 PASS；10 路由视觉指纹与冻结基线一致（无回归）；截图 `final-expanded.png` / `final-collapsed-hover.png`。

<!-- QA-LATEST-STATUS-START -->
## 最新状态（自动同步）

- **qa-guard2**：25/25 通过 — 全绿（运行于 2026-08-31T09:50:39）

<!-- QA-LATEST-STATUS-END -->














































