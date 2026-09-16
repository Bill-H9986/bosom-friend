# products/ — 产品层（本仓库自制代码全部在此）

官方基座（packages/ vendor/ native/…）保持原样；**自制产品层**统一放在本目录，与基座物理/心智双重隔离。

## 目录

| 路径 | 角色 |
| --- | --- |
| `bosom-friend/launcher/` | 产品启动器（src/bin.ts 组合入口 + config/ 空根配置 + lib/ 构建产物） |
| `bosom-friend/bundle/app/` | `@deepseek-ai/dsh-bosom-friend-app` 产品组合补丁层（cordis.patch.yml 挂载后端插件） |
| `bosom-friend/shim/` | `@deepseek-ai/dsh-web-frontend` 启动占位包（`/` 跳转到 Bosom Friend 首页） |
| `bosom-friend/server/` | `@deepseek-ai/dsh-bosom-friend-server` 后端插件（api.ts 分发 / routes-* / store / http） |
| `bosom-friend/project/` | 前端移植包（electron 宿主 + bosom-friend-web 源码包 + 内层工作区） |
| `bosom-friend/qa/` | 质量门禁体系（套件/报告/视觉基线/probes 归档，见 qa/README.md） |
| `bosom-friend/README.md` | 前端移植与集成说明 |

## 与基座的衔接（最小侵入）

- 工作区：`pnpm-workspace.yaml` 声明 `products/bosom-friend/{launcher,bundle/*,shim,server}`；
- 编译：`tsconfig.base.json` 路径映射 + `tsconfig.host.json` 项目引用 + `tsdown.config.ts` 构建面均已指向 products/；
- 启动：`node products/bosom-friend/launcher/lib/types/bin.js --port 3080 --no-open`；
- 数据：`~/.bosom-friend/`（**产品独立数据根**，可用 `BOSOM_FRIEND_HOME` 覆盖，与开发机 DSH 的 `~/.dsh/` 完全隔离）；
- 详细调用链见根目录 [框架与调用逻辑.md](../框架与调用逻辑.md)。

## 运维备注（2026-08-28 审计结论）

- `project/node_modules` 为 NTFS junction（Windows 专有）：跨平台部署前须改为 workspace link。
- 网络红线：本机 GitHub 不可达 → `@electron/rebuild` 的 git 子依赖以 `deps-stub` 存根 + package.json `pnpm.overrides` 替代（见 bosom-friend-electron/package.json 注释）。
