# aitoearn-web

知音 AI 内容营销系统的 Web 应用源码包（对齐官方仓库独立 aitoearn-web 项目结构）。

## 结构
- `src/app` — Next.js 风格页面（[lng] 路由、layout、i18n）
- `src/components` — PublishDialog / ChannelManager / draft-box / Chat 等核心组件
- `src/store` — zustand 状态层（account/user/plugin/draft-box）
- `src/api` — 后端 API 封装

## 构建宿主
当前由 `project/aitoearn-electron` 的 Vite 构建宿主（`@web` 别名指向本目录 `src`），
桌面客户端以本 Web 应用为唯一主界面（WebAppLayout）。

## 与官方结构对齐
官方仓库中本目录为独立 Next.js 项目。本项目为 Electron 桌面一体化架构，
Web 源码独立成包以便对齐官方边界；后续如需独立部署（Web 站点），
可为本包补充独立构建配置（vite/next 构建 + 独立 node_modules）。

