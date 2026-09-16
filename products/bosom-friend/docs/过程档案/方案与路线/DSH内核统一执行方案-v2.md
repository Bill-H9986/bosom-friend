# DSH 内核统一执行方案 v2

> 版本：v2.0
> 日期：2026-09-01
> 适用对象：Bosom Friend（Electron .exe）
> 目标：DSH 官方内核与 Bosom Friend 自研前端共享同一套 Agent/Session/Tool 协议，不再存在两套执行系统。

## 0. 方案要解决的核心问题

v1 方案的缺陷不是“方向错”，而是把自研前端和 DSH 内核当成了两个系统：

```text
前端自己有会话状态、自己调 REST、自己管任务
DSH 内核只是被启动，没有成为前端真正依赖的运行时
```

v2 把边界改成：

```text
Bosom Friend 前端 = DSH 官方 SDK 的客户端
DSH 内核 = 唯一 Agent/Session/Tool/LLM 运行时
官方 SDK 协议 = 两者之间唯一的会话协议
```

因此不存在“前端与内核各干各的”，它们是被同一份 `SessionEventMap` 和同一个 Agent 生命周期连接起来的客户端与运行时。

## 1. 官方依据

DeepSeek Harness 官方已提供“无 UI、由外部客户端驱动内核”的协议栈：

| 包 | 角色 |
| --- | --- |
| `@deepseek-ai/dsh-sdk-protocol` | 定义 JSON-RPC 线协议 |
| `@deepseek-ai/dsh-sdk-server` | 让 DSH 运行时通过 stdio JSON-RPC 服务外部客户端 |
| `@deepseek-ai/dsh-sdk-client` | TypeScript 客户端 SDK，驱动一个 DSH 子进程 |

官方 SDK 提供：

- `initialize`：确认运行时就绪；
- `session/prompt`：向 Session 提交用户消息；
- `session.event`：持续推送该 Session 的每一个持久化事件；
- `session.status`：推送 Agent 生命周期状态；
- `shutdown`：优雅关闭运行时。

这证明：**自研前端作为 DSH 官方 SDK 客户端是完全受支持的使用方式，不需要使用官方 Web UI。**

## 2. 目标架构

```text
BosomFriend.exe
├── Electron 主进程
│   ├── 使用官方 @deepseek-ai/dsh-sdk-client 启动 DSH 运行时子进程
│   ├── 管理运行时进程生命周期
│   └── 通过 preload 向自研前端暴露窄接口
├── DSH 运行时子进程（官方内核，无 UI）
│   ├── dsh-base
│   ├── dsh-sdk-jsonrpc-server
│   └── dsh-bosom-friend-kernel
│       ├── BosomPlatformService
│       ├── BosomPlatformProvider
│       ├── bosom_* Tools
│       └── BosomActionBridge
└── Bosom Friend 自研前端
    ├── 通过官方 SDK 客户端创建/发送/订阅会话
    ├── 从 session.event 渲染消息、工具、任务状态
    └── 不维护第二份 Agent/会话状态
```

## 3. 明确禁止的组件

```text
@deepseek-ai/dsh-web-app
@deepseek-ai/dsh-web-frontend
@deepseek-ai/dsh-client-*
apps/web
官方 Web UI 页面
```

允许使用官方 SDK 协议包，因为它们是传输和客户端库，不是 UI。

## 4. 目录结构

```text
products/bosom-friend/
├── kernel/                     # DSH 产品内核插件
│   ├── src/service/            # Service Definition
│   ├── src/providers/          # 真实平台 Provider
│   ├── src/tools/              # bosom_* Tool
│   ├── src/actions/            # 前端动作桥
│   └── cordis.patch.yml
├── runtime/                    # 可打包的 DSH 运行时入口
│   ├── package.json
│   └── cordis.yml
├── launcher/                   # Electron 主进程启动 DSH 子进程
├── project/
│   ├── bosom-friend-electron/
│   └── bosom-friend-web/
└── qa/
```

## 5. 官方 SDK 调用链

### 5.1 创建运行时

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const harness = new DeepSeekHarness({
  launch: {
    command: packagedRuntimePath,
    args: ['kernel'],
  },
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
})
```

### 5.2 创建会话并发送消息

```ts
const session = harness.session(sessionId)
const result = await session.run('帮我写一篇小红书笔记', {
  onNotification(notification) {
    if (notification.method === 'session.event') {
      forwardToRenderer(notification.params)
    }
  },
})
```

### 5.3 前端事件映射

| 官方通知 | 前端渲染 |
| --- | --- |
| `session.event: session/created` | 创建任务 |
| `session.event: user/message` | 用户消息 |
| `session.event: assistant/message` | AI 回复 |
| `session.event: tool/call` | 工具执行中 |
| `session.event: tool/result` | 工具结果 |
| `session.event: turn/end` | 本轮完成 |
| `session.status: idle` | Agent 空闲 |

前端状态全部由这些通知推导，禁止另行保存第二份会话数据。

## 6. 前端动作闭环

“前端动手”铁律与 DSH 工具执行并存的方式：

```text
模型调用 bosom_content_publish
  → Tool.execute() 请求前端动作
  → Electron 主进程把动作请求转发给渲染进程
  → 用户在前端真实执行发布
  → 前端把结果回传给 Tool
  → Tool 返回 DSH 规范结果
  → DSH 写入 tool/result
  → 模型继续
```

该动作通道只是 Tool 执行期间的同步依赖，不承载任何 Agent 循环或会话状态。

### 6.1 Tool 侧

```ts
async execute(args, exec) {
  const result = await actionBridge.request({
    action: 'publish',
    platform: args.platform,
    payload: args,
  }, exec.signal)

  return {
    recordId: result.recordId,
    status: result.status,
    message: result.message,
  }
}
```

### 6.2 前端侧

```ts
window.bosomKernel.onActionRequest((request) => {
  if (request.action === 'publish') {
    openPublishDialog(request.payload)
  }
})

await window.bosomKernel.completeAction(requestId, userResult)
```

### 6.3 高风险动作

真实发布、登录、评论/私信回复、账号解绑、数据删除必须由用户在前端确认后才能执行。Tool 未收到前端结果前不得返回成功。

## 7. 业务能力设计

### 7.1 Service Definition

```text
PlatformService
ContentService
PublishService
ReceptionService
DataService
```

### 7.2 Provider

```text
XhsProvider
DouyinProvider
KuaishouProvider
LocalMediaProvider
PythonChromeEngineProvider
```

### 7.3 首轮工具

```text
bosom_platform_list_accounts
bosom_platform_sync_works
bosom_platform_login_status
bosom_content_generate_script
bosom_content_save_draft
bosom_content_publish
bosom_data_dashboard
bosom_reception_list_pending
bosom_reception_reply
bosom_material_list
```

## 8. 数据与身份边界

### 8.1 会话数据

只允许存在 DSH Session Log 和官方 Session Persistence 中。

### 8.2 业务数据

账号、素材、发布记录、接待规则属于产品域数据，可存在产品 Provider 维护的存储中，但必须只通过 Service Definition 访问。

### 8.3 用户身份

- 产品用户登录状态由产品身份模块管理；
- 产品用户创建自己的 DSH Session；
- Session 数据通过 DSH 会话持久化恢复；
- 不把用户身份塞进模型提示词。

## 9. LLM 接入

- 官方默认模型走 `dsh-llm-deepseek`；
- BYOK 模型通过官方 `llm-pi-ai` 的 settings/credentials seam 配置；
- 用户换 Key、BaseURL、模型时不重启运行时，通过官方 settings 热更新；
- 产品代码永远不直接调用 `/chat/completions`。

## 10. 实施阶段

### Phase 0：基座与运行时

- 恢复/隔离官方 DSH 源码；
- 创建 `kernel` 和 `runtime` 包；
- 用 `dsh-base + dsh-sdk-server + dsh-bosom-friend-kernel` 组成运行时；
- 验证官方 SDK 能启动运行时并完成一次消息往返。

### Phase 1：自研前端接入官方 SDK

- Electron 主进程使用 `DeepSeekHarness`；
- preload 暴露窄接口；
- 替换 `store/agent`；
- 删除自研 SSE、`agent-tasks.json`、`HarnessAgent`。

### Phase 2：业务工具

- 实现 Service Definition、Provider、首轮 10 个 Tool；
- 建立前端动作桥；
- 发布、登录、接待改为前端执行并回写 Tool 结果。

### Phase 3：领域数据与身份

- 业务数据迁移；
- Session 持久化恢复；
- BYOK 热更新。

### Phase 4：打包 .exe

- 将 DSH 运行时和自研前端一起打包；
- 无外部服务依赖；
- 干净环境可完成一条完整 DSH 业务链。

## 11. 验收与门禁

### 11.1 架构门禁

```text
products/bosom-friend/qa/verify-dsh-sdk-boundary.mjs
```

禁止项：

```text
dsh-web-app / dsh-client-* / dsh-web-frontend
直接 fetch('/chat/completions')
HarnessAgent / AgnesLlmClient / HarnessDataStore
前端第二份会话状态
```

### 11.2 运行时证据

一次业务任务必须产生：

```text
session/created
user/message
assistant/message
tool/call
tool/result
turn/end
session/status = idle
```

### 11.3 S 级前端验收

业务动作必须由自研前端页面完成，并产生可见页面结果；后端日志和 `code=0` 不能单独作为验收证据。

## 12. 完成定义

1. DSH 运行时以官方 SDK 子进程形式运行；
2. 自研前端只使用官方 SDK 协议与 DSH 交互；
3. 前端不维护第二份 Agent/会话状态；
4. 所有业务动作都是 DSH Tool/Provider 的一部分；
5. 前端动作闭环完整；
6. 自研 Agent、LLM、工具、会话存储已全部删除；
7. .exe 干净环境可运行并完成完整 DSH 业务链；
8. 架构门禁和运行时证据门禁全部通过。
