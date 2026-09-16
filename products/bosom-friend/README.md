# Bosom Friend（AI 内容营销系统）前端移植

> **2026-09-03 现状**：以下“源项目/未修改”等描述仅保留历史上下文，不再代表当前代码。
> 本产品现名 `Bosom Friend`，后端为 `products/bosom-friend/server`，启动命令：
> `node products/bosom-friend/launcher/lib/types/bin.js --port 3080 --no-open`。
> 真实小红书发布、账号数据、数据中心、AI 客服均已接入；接待引擎为“7×24 只读采集 + 前端智能体自动发送/手动确认”，
> 支持组合关键词、排除词、去重窗口、冷却与待办生命周期；旧的 OPC/8080/9000 组合说明已失效。
>
> **2026-09-01 最高测试权限**：产品验收执行
> `qa/acceptance/EXAM_PROTOCOL.md`（S 级前端监考 v3）。业务动作必须由
> APP 前端页面发起，后端处理后再返回前端；任何接口冒烟、SSE、
> 持久化或 worker 日志都不能代替页面可见结果。

> 来源：`C:\Users\Jay\Desktop\ZhiYin-Ai smart system\project\`
>
> 搬运日期：2026-08-27。当前产品版本为 0.13.9，源码已按 Bosom Friend 需求和 DSH 后端持续修改，不再保留“未修改源文件”含义。

## 功能分区（三大核心功能）

整个项目按**内容创作（A）/ 账号管理（B）/ AI 智能体（C）**三大核心功能划分小功能区，
公共能力归入公共底座（D）。**唯一功能清单**：
[功能清单-三大核心功能](docs/功能清单-三大核心功能.md)（含每个功能点的入口、说明、实现位置、验证状态）。

新增或修改功能必须同步更新该清单（项目铁律 #14）。

## 运行环境（安装版）

| 项 | 要求 |
| --- | --- |
| 操作系统 | **Windows 10 / 11 64 位**。32 位 Windows 无法运行：随包的 Electron、Node、Python、Chromium 全部是 64 位，安装包本身也按 x64 构建（`electron-builder.yml` 的 `win.target.arch: [x64]`）。在 32 位系统上双击安装包会被 Windows 直接拒绝；即使强行运行也会在启动页给出"需要 64 位 Windows"的明确提示。 |
| 磁盘 | 安装约 1.1 GB；首次启动解压随包内核运行时另需约 1 GB 用户数据空间。 |
| 内存 | 建议 8 GB 以上（视频生成与浏览器自动化会同时占用较多内存）。 |
| 网络 | 首次配置模型、生成内容、发布与同步都需要联网。 |

## 目录结构（保持源项目内部相对布局不变）

```
products/bosom-friend/
└── project/                    ← 与源项目 project/ 一一对应
    ├── .npmrc                  # 原生依赖构建白名单（照搬）
    ├── pnpm-workspace.yaml     # 内层独立工作区（packages/* 仅含新增核心包）
    ├── pnpm-lock.yaml          # 源项目锁文件（保证可复现安装）
    ├── bosom-friend-electron/      # 构建宿主 + Electron 主进程/preload + 渲染器外壳
    │   ├── index.html          # 渲染器入口 HTML（title 知音）
    │   ├── vite.config.mts     # Vite 配置：@→自身src、@web→../bosom-friend-web/src
    │   ├── tailwind.config.js / postcss.config.cjs / tsconfig*.json
    │   ├── electron/main|preload/   # Electron 主进程与 preload 源码
    │   ├── src/                # 渲染器外壳（App/router/layout/views…，内嵌 @web 页面）
    │   ├── commont/            # @@ 别名公共模块
    │   └── public/             # 渲染器静态资源（字体/图片等）
    └── bosom-friend-web/           # Web 应用源码包（Next.js 风格 app/[lng] 路由）
        └── src/                # desktop-pages / components / store / api / i18n …
└── qa/                          # 质量门禁体系（套件/报告/视觉基线/probes 归档，见 qa/README.md）
```

另含 `project/zhiyin-harness/`（46 文件）：知音 Agent 内核包，`bosom-friend-electron/electron/main/zhiyin-kernel-host.ts`
以相对路径 `../../../zhiyin-harness/src/index` 引用它——缺少它主进程无法构建，故一并照搬。

## 与源项目的差异（如实记录，共两处机械性偏差）

1. `bosom-friend-electron/package.json`：devDependencies 增加 `"fast-glob": "^3.3.3"`。
   原因：`vite-plugin-svg-icons@2.0.1` 使用却不声明该依赖；源机器靠 npm/pnpm 平铺 hoist 才解析到，
   独立安装后必须显式声明，否则 vite.config.mts 加载即失败。
2. 安装与构建的生成物（`node_modules/`、`bosom-friend-electron/pnpm-lock.yaml`、`dist*/`、
   `project/node_modules/` 的 NTFS junction 镜像）均为本机重新生成，非源文件。
   其中 `project/node_modules/<pkg>` 是指向 `bosom-friend-electron/node_modules/<pkg>` 的 junction：
   `bosom-friend-web` 位于 electron 包之外，其 bare import 需要在上级目录找到依赖——
   源机器存在 `project/node_modules` 所以能解析，这里用 junction 复刻同一布局，未改任何源码。

两个包的关系：渲染器唯一界面来自 `bosom-friend-web` 的 `desktop-pages/WebAppLayout`，
经 vite 别名 `@web → ../bosom-friend-web/src` 注入 `bosom-friend-electron/src/App.tsx`。
因此搬运必须保持二者为相邻目录——本布局做到了。

## 排除项（未搬运）

| 排除目录/文件 | 原因 |
| --- | --- |
| `bosom-friend-electron/release/`（33.7 GB，10 万+ 文件） | 打包安装产物 |
| `bosom-friend-electron/resources/`（954 MB，2.4 万文件） | 打包资源（app.asar 解包物等） |
| `bosom-friend-electron/node_modules/`、`logs/`、`dist*` | 依赖缓存 / 日志 / 旧构建，可重新生成 |
| 源项目根 `dist/`、`dist-electron/`、`.git*`、node_modules | 同上 |

## 如何构建 / 运行（已在2026-08-27实测通过）

前端刻意放在本仓库根工作区之外（`products/bosom-friend/` 不匹配根 `apps/*` 成员 glob），避免 electron/sharp/better-sqlite3 等原生依赖混入 DSH 安装树。

```bat
cd /d C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\project\bosom-friend-electron
:: 用系统 Node 的 pnpm（不要用 DSH Desktop runtime 里的 pnpm，esbuild postinstall 会失败）
:: --ignore-workspace：屏蔽上层 project/pnpm-workspace.yaml（其 glob 只管 packages/* 后端核心包）
:: --ignore-scripts：跳过 electron 二进制下载与原生编译；纯 Web 构建不需要它们
pnpm install --ignore-workspace --ignore-scripts

:: 纯 Web + Electron 主进程/preload 构建（不打安装包），exit 0 验证通过
npx vite build --mode=test
```

构建产物（验证时点）：

| 产物 | 说明 |
| --- | --- |
| `bosom-friend-electron/dist/index.html` `splash.html` + `assets/`×241 | Web 渲染器（知音主界面） |
| `bosom-friend-electron/dist-electron/main/index.js` | Electron 主进程（799 KB） |
| `bosom-friend-electron/dist-electron/preload/index.mjs` | preload 桥（4.6 KB） |

开发模式：`npx vite`（Vite dev server :7777）；完整桌面应用需补装 electron 二进制后 `pnpm install`（去掉 `--ignore-scripts`）再按源项目 `pnpm dev` / `pnpm build` 走。

注意事项：
- 引擎声明 `node 20.x`，本机 Node v24.18 只告警不阻断。
- 后端接口地址在 `vite.config.mts` 的 `define` 中写死为 `http://127.0.0.1:3080/bosom-friend/api`；独立运行无后端时页面属空态但可完整预览 UI。

## 与 DSH 新后端的集成现状（2026-08-27 已打通）

知音前端已整体接入 **DeepSeek Harness 新后端**，不再需要原 NestJS 服务：

| 项 | 说明 |
| --- | --- |
| 新后端插件 | `products/bosom-friend/server/`（`@deepseek-ai/dsh-bosom-friend-server`），经 `products/opc/bundle/opc-app/cordis.patch.yml` 挂入产品树 |
| 路由挂载 | `/bosom-friend/api/*`——复刻前端全部运行时 REST 契约（约 80 端点：认证/账号/发布/素材/数据/热榜/笔记搜索/草稿生成/反馈） |
| 前端托管 | `/bosom-friend/*`——由 dsh webServer 服务 `bosom-friend-electron/dist`，并在 index.html 注入 `window.__BACKEND_BASE_URL__='/bosom-friend/api'` 与 `window.__ZHIYIN_AUTH_TOKEN__`（复刻 Electron preload 注入行为） |
| AI 对话 | `POST /bosom-friend/api/agent/tasks`(SSE)——直接由 dsh-llm 的 DeepSeek 模型流式驱动（`deepseek-official`/`deepseek-chat`），无 Key/超时自动落本地模板兜底，沟通闭环永不悬死 |
| 数据落盘 | `~/.bosom-friend/bosom-friend/`（产品独立数据根；user/accounts/tasks/materials/metrics/records 等 JSON 原子持久化，与开发机 DSH 的 ~/.dsh 完全隔离） |
| 响应契约 | 恒为 `{code, data, message}`（code===0 成功），HTTP 200 承载业务错，兼容前端三处 `api//` 双斜杠路径与 DELETE 带 JSON body 的旧约定 |

**一键启动**：`node products/bosom-friend/launcher/lib/types/bin.js --port 3080 --no-open`，浏览器访问：
- Bosom Friend：`http://127.0.0.1:3080/bosom-friend/`

**基础设施验证记录**（node fetch 直测，仅诊断后端；脚本在 `qa/`：
`smoke-sse.mjs` / `smoke-api.ps1` / `raw-sse.mjs`；不属于产品验收，
门禁体系见 `qa/README.md`）：
- SSE 字节级：`init → stream_event×N → result → done`，任务持久化 `status=completed` ✅
- 域接口：user/mine、channels/platforms、账号/分组、publish flows/records、dashboard、material groups、note-search、user 资料更新 全部 `code=0` ✅

**已知限制与后续**：① 首字延迟仍偏模型首包时间；② 小红书/抖音真实发布已经接入，成功必须回传平台作品 ID/链接；③ 视频号、快手同步与抖音 H5 用户确认通道仍是后续平台接入项；④ 平台登录、评论/私信、发布仍受平台登录态、IP 风控和页面改版影响。
