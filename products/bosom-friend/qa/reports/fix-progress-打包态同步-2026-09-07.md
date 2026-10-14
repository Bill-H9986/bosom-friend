# 打包态同步进度（2026-09-07）

> 任务：把今日全部修复同步进成品内核运行时（kernel-runtime-unpacked + kernel-runtime.zip）
> 背景：桌面壳开发态加载 `desktop/dist/kernel-runtime-unpacked/node_modules/**`（9/4 旧产物），
> 打包版安装后从 kernel-runtime.zip 解压。两处不吃 repo lib，今日修复对成品不生效。
> 域内约束：src+lib 双改、真实数据根、git 冻结（提交归总控）、不改 qa/acceptance 考试脚本。

---

## ① 旧产物定位与来源映射

| 目标 | 路径 | 现状（mtime） |
| --- | --- | --- |
| 运行时 server lib | `desktop/dist/kernel-runtime-unpacked/node_modules/@deepseek-ai/dsh-bosom-friend-server/lib/types/*.js` | 9/4 00:36~18:17（旧） |
| 运行时 kernel lib | `desktop/dist/kernel-runtime-unpacked/node_modules/@deepseek-ai/dsh-bosom-friend-kernel/lib/index.js` | 9/3 14:14（旧） |
| 随包 zip | `desktop/dist/kernel-runtime.zip` | 9/4（旧） |

来源映射与关键定性证据：

1. **运行时 api.js 是「路由拆分前」的旧单体产物**：runtime api.js 259KB/6433 行，
   内含 `appendChannelRoutes/appendContentRoutes/appendKnowledgeRoutes/assistantTextOf`
   等今日已拆到 routes-*.ts / kernel-client.ts 的函数；repo api.js 121KB/2511 行，
   与现 src（2569 行，routes 已拆分）一致。**整目录覆盖 repo lib 是正确做法**，
   不存在"runtime 里有 repo 缺失的路由"——那些路由在 runtime 的 routes-*.js 里（同样 9/4 旧）。
2. **kernel lib 是 esbuild 打包产物，store.ts 被内联**：kernel/src/data.ts imports
   `@deepseek-ai/dsh-bosom-friend-server/src/store.ts`，esbuild --bundle 会把 store.ts
   打进 kernel/lib/index.js。实测 kernel lib（repo 与 runtime 同为 9/3 版）含 JobQueue
   但**不含今日 fileMtime 同源修复**（grep fileMtime = 0）→ 必须重跑 esbuild 再同步，
   只拷 server lib 不够。
3. **ffmpeg 修复佐证**：repo platform-login.js 含 3 处 ffmpeg 候选（9/7 修复多出
   desktop/dist/runtime 路径），runtime 仅 2 处（9/4 旧）。

## ② 重构建与同步

（实施中追加）

## ③ 打包态冒烟

（待做）

## ④ 遗留项

（收尾时填写）
