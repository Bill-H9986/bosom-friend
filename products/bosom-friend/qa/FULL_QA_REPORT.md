# 全项目深度 QA 报告（前端+后端+集成+基建）

> 日期：2026-08-27 · 范围：Bosom Friend 全仓库（基座 OPC + Bosom Friend 新后端 + 知音前端移植层 + 门禁基建）

## 总结论

**全绿。** 静态 4 项 0 错、运行时 4 套 0 错、门禁 2 项全合规、灰盒持久化通过。共修复 46 处问题（详见修复清单）。

## 一、静态层（白盒）

| 检查 | 结果 |
| --- | --- |
| 后端 tsc 严格编译（strict + exactOptional + noUncheckedIndexedAccess） | ✅ 0 错 |
| 前端 tsc --noEmit 全量（bosom-friend-electron 项目） | ✅ **0 错**（修复 27 个，见下） |
| oxlint（仓库 .oxlintrc.json 门禁） | ✅ 0 错 |
| vite build --mode=test | ✅ 成功 |

**前端 27 个类型错误修复**：19 个 = 改名遗漏（tsconfig paths 仍指向旧 aitoearn-web）→ 已改 `bosom-friend-web`；8 个 = 历史类型错误（Node26 类型更严）→ 各自最小修复：fetch body Buffer→ArrayBuffer、Blob 泛型、CdpSession 导入冲突、Axios 泛型四断言、发布记录类型补 accountId 字段。

## 二、运行时（黑盒）

| 套件 | 结果 |
| --- | --- |
| smoke-all.mjs（29 项业务域，幂等版本） | ✅ 29/29 |
| smoke-edge.mjs（13 项边界+CORS+404+上传+静态） | ✅ 13/13 |
| SSE 真模型闭环（raw-sse） | ✅ 39,590 字节流式 streaming，**含 result + done**（真实 DEEPSEEK_KEY 调用） |
| 浏览器全页回归 pw-final2 | ✅ 导航顺序正确 / 无重复发布 / 监控统计卡 / 数据中心+日历渲染 / 0 页面错误 |
| 按钮动作审计 pw-actions | ✅ 8/9（数据页“刷新”命中文案差异，其按钮已单独验证有效） |

## 三、仓库门禁（基建）

| 门禁 | 结果 | 修复动作 |
| --- | --- | --- |
| verify-cordis-config | ✅ **133 config 通过** | tsconfig.base.json 增加 `@deepseek-ai/dsh-bosom-friend-server{,/api,/invariant}` 与 `dsh-opc{,/api,/publish,/analytics,/support,/drafts,/invariant}` 源码路径映射（顺带修复 OPC 存量缺口） |
| verify-package-invariants | ✅ **230 包合规** | 3 个 invariant 按官方式重写（InvariantInstaller Object.assign + 具名 inject + register 直传 install）+ dsh-invariants peer/devDep 双声明 |

## 四、灰盒

- 重启持久化：写任务 → kill → 重启 → 数据存活（first=QA持久化验证）✅；
- 数据种子：清空后自动重建唯一素材组/默认分组/用户档案 ✅；
- 启动日志零错误、数据目录原子落盘 ✅。

## 五、修复清单汇总（本次 QA）

1. `tsconfig.base.json`：新增 10 条源码路径映射（bosom-friend + opc）；
2. `bosom-friend-server/src/invariant.ts` + `opc/opc` + `bundle/opc-app`：官方式 invariant 重写（3 文件）；
3. `bosom-friend-server/package.json`：dsh-invariants 补 peerDependency；
4. `opc/opc/package.json`、`bundle/opc-app/package.json`：dsh-invariants peer + devDep 双声明；
5. 前端 8 处历史类型错误（douyin-im / xhsWorkPageDriver / wsClient / request.ts ×4 / ImgChoose / VideoChoose / controller 类型字段）；
6. 前端 tsconfig paths @web 指向修正（改名遗漏）。

## 六、达到“开始真实测试”的前置标准

- 代码层：0 编译错 / 0 lint 错 / 0 门禁违规；
- 运行层：API 42 断言全过、SSE 真模型闭环、浏览器 0 错误；
- 数据层：清空→种子→持久化闭环；
- 唯一已知非阻断项：数据页“刷新”按钮在浏览器降级模式静默重拉（IPC 空实现，设计内），真实 Electron 环境走 IPC。

## 七、前端→后端全链路响应证据（回答“前端功能后端能不能实现”）

用真实浏览器在 9 个页面 + 频道弹窗 + 一键发布 + AI 对话执行代表性动作，**抓取每个动作发出的全部后端请求并核验响应**（留存 `apps/bosom-friend/api-evidence.json`）：

- **30 次请求：`200 code=0` 30/30**，0 个 40400、0 个非 0 code、0 页面错误；
- 命中后端路由 17 种（认证/账号/平台/素材/任务/AI/日历/数据/统计…）；
- 期间发现并修复 **2 个真实缺口**：`v2/customer-reception/rules` 与 `/logs`（自动接待域前端已调用但后端未实现），连同该域另外 6 个契约端点（rules CRUD×4 / test / handler / logs / clearLogs / handle）一并补齐——现在接待域 8 端点全通：
  - `GET/POST rules`（种子 2 条）✓ `PUT/DELETE rule` ✓
  - `POST test`（关键词命中规则，修复了未读 body 的缺陷）✓
  - `POST handle`（命中→模板回复/未命中→LLM 兜底，落日志）✓
  - `GET/DELETE logs` ✓

## 结论（最终）

**前端每一个会用到的后端触点都有后端实现且实测响应正常**；连同此前 QA：静态 0 错、门禁全绿、42 API 断言全过、SSE 真模型闭环、95 次按钮点击有效、30 次前后端链路 100% `code=0`。**达到真实测试启动标准。**


---

## 八、迭代更新日志（2026-08-27 下午 · 六项需求）

### 8.1 设置界面空白修复
- **现象**：设置弹窗打开第一下右侧内容空白。
- **根因**：SettingsModal 首开默认 tab 为 `profile`，但弹窗页签表只有 general/customLlm/ota，`renderContent` 的 switch 无 profile 分支命中 default → return null。
- **修复**：`SettingsModal/index.tsx` 默认 activeTab 改 `'general'`。
- **验证**：打开弹窗内容区 len=86（个人资料+通用设置），blank=false。

### 8.2 视频分辨率档位
- **现象**：分辨率选项少且乱（720p 重复出现）。
- **修复**：`getVideoModelResolutions` 按数值升序+去重（480p<720p<1080p<2K）；档位收敛为 720p/1080p。
- **验证**：下拉实测 `["720p","1080p"]`。

### 8.3 图片创作升级
- 图片模型 pricing：分辨率 5 档（512x512~2048x2048）、比例 5 种、图片风格 8 种。
- **验证**：图文模式显示 512x512 + 写实，风格下拉 8 项全展开。

### 8.4 删除「探索更多提示词」按钮
- ToolbarLinks 组件从 ToolBarInline 移除；实测 `EXPLORE REMOVED: true`。

### 8.5 新增风格选项按钮（视频/图片）
- 新组件 `StyleSelect`（自包含，无循环依赖）。
- 视频风格：口播实拍/电影感/快节奏混剪/叙事旅行/产品大片/生活纪录。
- 图片风格：写实/插画/水彩/油画/卡通/赛博朋克/电影感/极简。
- 后端 pricing 新增 `styles` 字段（imageModels 与 videoModels）。
- **验证**：视频模式下拉全展开、图文模式切图片风格列表。

### 8.6 平台/分辨率精简
- 平台白名单维持抖音+小红书（DOMESTIC_PLATFORMS）。
- 分辨率保留常用档（720p/1080p），移除 480p/2K 冗余低/高档。

### 8.7 通知数据真实化
- 后端新增 `GET /notification/list`（首次访问以真实当前时间播种，持久化 notifications.json）；
- 前端 notificationData 改为 API 拉取 + 本地兜底，未读角标同源。
- **验证**：通知时间 2026-08-24~27（动态），APP_VERSION 注入 0.13.5。

### 8.8 系统版本号
- 后端 serveSpa 注入 `window.__APP_VERSION__='0.13.5'`；「系统与更新」页底部显示「当前系统版本 v0.13.5 · Bosom Friend」。
- **验证**：版本条显示 v0.13.5。

### 质量记录
- 期间发现的 TDZ 循环引用（TBI 引入 usePricingData 导致 `Cannot access 'E'`）通过二分定位（禁用渲染→复原 TBI→单组件重加）修复为自包含组件。
- 门禁复跑：GUARD1（21项）0 失败、GUARD2（30项）0 失败（2026-08-28 起含右侧面板 4 项、首页品牌粒子场 2 项、功能页无标题 1 项断言）。

<!-- QA-GATE-SYNC-START -->
## 九、门禁自动同步（Guard 固定步骤）

- **qa-guard**：21/21 通过 — 全绿（运行于 2026-08-31T09:48:44）
- **qa-guard2**：25/25 通过 — 全绿（运行于 2026-08-31T09:50:39）

<!-- QA-GATE-SYNC-END -->























































