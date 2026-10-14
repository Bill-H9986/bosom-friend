# S 级前端验收执行记录 · 真实平台全自动发布（2026-09-09 下午）

> 授权：用户明确批准「真实平台发布/互动监考必须执行，否则无法证明业务链路是否打通」（2026-09-09）。
> 对象：`http://127.0.0.1:31280/bosom-friend/`（源运行桌面运行时 `bin-desktop.ts`）
> 协议：`qa/acceptance/EXAM_PROTOCOL.md`（S 级唯一合格证据 = 页面可见结果 + 页面自身请求闭环）
> 数据根：`~/.bosom-friend/bosom-friend`

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 小红书全自动发布监考 | **PASS**（一次用户动作 → AI 全自动 → 真实发布 → 自动同步） |
| 抖音全自动发布监考 | **PASS**（同上） |
| 依赖监考的 FRONTEND_FINAL | **PASS** |
| 依赖监考的 FRONTEND_EMPTY_REPRO | **PASS** |
| 0.2.33 安装包"能不能用" | **FAIL**（窗口白屏，前端资源 404）→ 已定位并重建 0.2.34 |

---

## 2. 首轮监考失败 → 定位到两个真实产品缺陷（已修复）

### 缺陷 A：`worker.py` 元组解包缺失，真实发布 100% 失败

- 现象：小红书发布记录 `rec-ry1sefqz` `status=-1`，`errorMsg="平台发布失败: 'list' object has no attribute 'get'"`。
- 根因：`run_publish` 回读作品列表写成 `works = asyncio.run(_sync_xhs_works(...))`，
  而 `_sync_xhs_works` 已改为返回 `(works, complete)` 元组（`run_sync` 已解包，此处漏改）；
  `max(works, key=lambda w: w.get(...))` 于是对 list 调 `.get()` 抛异常。
- 修复：解包为 `works, _complete = ...`（提交 `8145a6c`）。

### 缺陷 B：抖音视频等待上限 180s < 实际出片耗时，动作卡永不出现

- 现象：抖音监考任务 `task-a45521af` 无 `result`（无发布动作卡），链路停在"AI 只给文字"。
- 证据：视频生成 `gen-708adeb5` 于 06:19:32 创建、06:23:39 完成（4m07s，videoUrl 正常），
  但 `generateAgentVideo` 的 180s deadline 在 06:22:32 到期返回 null → `publishReady=false` → 不发动作卡。
- 修复：deadline 180s → 360s，并加注释说明实测耗时（提交 `8145a6c`）。

---

## 3. 修复后监考结果（一次用户动作，全程无人工干预）

### 3.1 小红书

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 06:33:54 | page-ready / 发送（唯一用户动作） | `auto-xhs-step-00-page-ready.png` |
| 06:34:24 | AI 产出内容 | `auto-xhs-0-agent-content.png` |
| 06:34:29 | AI 自动点击「去发布」→ `#/draft-box?aiPublish=1` | `auto-xhs-1-publish-dialog.png` |
| 06:36:37 | 真实发布完成并自动跳数据中心 | `auto-xhs-2-datacenter-synced.png` |
| 06:36:40 | 账号数据自动同步（页面显示"已更新 1/1 条作品数据"） | 同上 |
| — | 监控 / 账号 / 任务历史 | `auto-xhs-4-monitor.png`、`auto-xhs-5-accounts.png`、`auto-xhs-3-tasks-history.png` |

- 真实作品：`6aa0fce70000000026015874`
- 可打开链接：https://www.xiaohongshu.com/explore/6aa0fce70000000026015874
- 发布记录：`rec-real-6aa0fce70000000026015874`（status=1）

### 3.2 抖音

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 06:37:13 | page-ready / 发送（唯一用户动作） | `auto-douyin-step-00-page-ready.png` |
| 06:37:25 | AI 产出内容 | `auto-douyin-0-agent-content.png` |
| 06:39:19 | 视频就绪后 AI 自动点击「去发布」 | `auto-douyin-1-publish-dialog.png` |
| 06:40:42 | 真实发布完成并自动跳数据中心 | `auto-douyin-2-datacenter-synced.png` |
| 06:40:46 | 账号数据自动同步 | 同上 |
| — | 监控 / 账号 / 任务历史 | `auto-douyin-4-monitor.png`、`auto-douyin-5-accounts.png`、`auto-douyin-3-tasks-history.png` |

- 真实作品：`7683421642705489186`
- 可打开链接：https://www.douyin.com/video/7683421642705489186
- 发布记录：`rec-0l4fytdg`（status=1）

### 3.3 依赖监考的脚本

- `verify-frontend-final.mjs` → **PASS**（`checks.taskChat=true`、`accountsXhs=true`、`forbiddenHits` 全空、`pageErrors` 空）。
- `frontend-empty-repro.mjs` → **PASS**（`chatContainsUserAndAssistant=true`、`draftBoxShowsGeneratedMaterials=true`、`noWrongOssHost=true`）。

---

## 4. 安装包"能不能用"验收（0.2.33）

| 步骤 | 结果 |
| --- | --- |
| 静默安装 `BosomFriend-Setup-0.2.33.exe /S /currentuser` | 退出码 0，25s，注册表 `Bosom Friend 0.2.33` |
| 启动 | 4 个进程 + 主窗口 "Bosom Friend"，端口 31280 监听，HTTP 200 |
| **页面渲染** | **FAIL：白屏**。`/assets/index-B8s2xArO.js`、`index-Cpk-foAn.css`、`vendor-*.js` 全部 404 |
| 根因 | 打包内 `resources/frontend-dist/index.html` 引用 `/assets/...`（base=/），
而打包服务器只在 `/bosom-friend/` 下提供前端；当前源码 dist 已用 `base: '/bosom-friend/'` |
| 静默卸载 | 退出码 0；安装目录/开始菜单/桌面快捷方式/进程全部清除；**数据根 14415 个文件前后一致，accounts.json 保留** |
| 残留 | 注册表遗留 `Bosom Friend 0.13.5`（历史安装残留，非 0.2.33 产生） |

处理：版本升至 **0.2.34** 并用当前 dist（`base: '/bosom-friend/'`）重新构建安装包 → **复验通过**：

| 0.2.34 复验项 | 结果 |
| --- | --- |
| 打包内 `frontend-dist/index.html` | 引用 `/bosom-friend/assets/index-DmeJFBlC.js`（正确） |
| 静默安装 | 退出码 0；注册表 `Bosom Friend 0.2.34` |
| 启动 | 主窗口 "Bosom Friend"，端口 31280，HTTP 200 |
| **页面渲染** | **PASS**：`root` 渲染成功、首页文案正常、`failedRequests=[]`（无 404） |
| 数据保留 | 账号页显示「抖音 · 36 粉丝 · 正常」「Jayson in · 小红书 · 0 粉丝 · 正常」 |
| 静默卸载 | 退出码 0；目录/快捷方式/进程清除；数据根 14419 个文件前后一致 |
| 产物 | `BosomFriend-Setup-0.2.34.exe` 431,852,472 字节；SHA256 `BD81E567CADCA2337262A4680ADE05B9F8435CFCF36B314C62C544A1260E2B99` |
| 签名 | **NotSigned**（证书未购买，见 §5） |

---

## 5. 仍未覆盖

1. 平台**拒绝发布**场景（AC-009-2）尚无 S 级证据。
2. 自动互动（点赞/评论/私信/关注/浏览）尚无 S 级监考题目——按铁律 #10 属全自动范围，需补题。
3. 0.2.34 安装包渲染/卸载复验。
4. 注册表 `Bosom Friend 0.13.5` 残留清理（涉及删除，待拍板）。
