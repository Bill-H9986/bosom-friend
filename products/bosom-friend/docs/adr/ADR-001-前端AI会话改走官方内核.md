# ADR-001：前端 AI 会话改走官方内核（适配层先行）

> 状态：已接受
> 日期：2026-09-02
> 关联：门禁“禁止直连模型接口”红灯、REQ-004/005、ADR-000
> 评审：Codex（执行方）拟定，产品负责人委托确认

## 背景

前端 AI 对话目前走自研 SSE 通道，后端两处直连 `/chat/completions`（server/src/api.ts 与 legacy harness）。目标：前端只与官方 DSH 内核交互，任何 AI 路径不绕过内核。

## 决策

分两步绞杀，先杀直连、再杀自研通道：

1. 适配层切片（先清红灯，不改前端契约）：
   - server 插件以官方 dsh-sdk-client 启动内核运行时（launcher/src/bin-kernel.ts）；
   - ai/chat 与 agent/tasks 的对话请求改为 `session/prompt` 进内核；
   - SDK 的 `session.event`（assistant/chunk）翻译为前端现有 SSE 增量事件，前端零改动；
   - 两处直连 fetch 删除。
2. 原生直连切片（终态）：
   - Electron 主进程持有 `DeepSeekHarness`，preload 暴露 `window.bosomKernel`；
   - 渲染进程原生订阅 `session.event` / `session.status`，自研 SSE 通道下线；
   - 至此前端成为合法 DSH 客户端，内核是唯一 AI 引擎。

## 后果

- 正面：第 1 步即清零直连红灯，前端无感迁移，可回退；第 2 步达到“前端只吃官方 SDK 事件”的终态。
- 负面/代价：第 1 步引入“内核进程 + SSE 翻译层”，过渡期有一层适配；第 2 步需要改渲染进程事件消费。

## 部署约束（2026-09-02 补充）

- 开发态：内核运行时经 `node --import tsx/esm` 源码直跑（已实测通过）；
- 打包态：exe 内无 node/tsx，内核运行时必须先构建为 lib 产物、由打包内 Node 启动；
  因此生产默认仍走旧路径，`kernelAi` 开关等到打包链路就绪后再翻，避免破坏现有 APP。

## 备选方案

- 一步到位原生直连：否决——同时改后端与渲染进程，风险不可控，与 ADR-000 的绞杀原则冲突。

## 验证方式

- 第 1 步：门禁“禁止直连模型接口”转绿；S 级 AC-004/005 页面证据重跑通过；SSE 事件结构与旧实现逐字段对照。
- 第 2 步：前端仅订阅官方 SDK 通知；S 级 AC-004/005 通过；旧 SSE 处理器删除。

## 链接

- 内核运行时：products/bosom-friend/launcher/src/bin-kernel.ts
- 官方客户端：packages/sdk/client/README.md
- 门禁：products/bosom-friend/qa/run-gate.mjs
