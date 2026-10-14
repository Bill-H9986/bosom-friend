# Bosom Friend 基于 DeepSeek Harness 官方内核开发执行方案

> **本文档为 v1 基线，已被《DSH内核统一执行方案-v2.md》取代。**
> v2 使用官方 `dsh-sdk-*` 协议作为自研前端与 DSH 内核之间的唯一会话协议，解决“前端与内核各干各的”问题。

> 版本：v1.0
> 日期：2026-09-01
> 适用范围：Bosom Friend（.exe 桌面应用）
> 结论：DSH 只作为无界面内核嵌入 APP；APP 前端完全由 Bosom Friend 自研。任何 DSH Web UI、DSH Client UI、DSH 官方前端产物都不得进入产品。

## 0. 最高原则

1. DSH 官方内核是 Bosom Friend 唯一的 Agent 执行、模型调用、会话记录和工具执行引擎。
2. Bosom Friend 前端完全自研，通过本地桥接访问 DSH 内核，不使用官方 Web UI。
3. 业务能力必须注册为 DSH Tool 或 DSH Service Provider，禁止在 REST 路由或 IPC 处理器里重新实现 Agent 循环。
4. 一切模型可见内容和业务执行轨迹必须落在 DSH Session Log 中。
5. DSH 官方源码是只读依赖。产品代码不得修改、删除、替换 `dsh-official` 下的任何官方文件。
6. “基于 DSH”以运行时 DSH Session 轨迹和架构扫描结果为准，不以 README、项目名、宣传文案为准。

## 1. 目标架构

```text
BosomFriend.exe
├── Electron 主进程
│   ├── 加载并启动 DSH 内核
│   ├── 装配 Bosom Friend 产品插件
│   ├── 暴露 bosomKernel IPC 桥
│   └── 管理应用生命周期
├── DSH 内核（无 UI）
│   ├── @deepseek-ai/dsh-base
│   ├── @deepseek-ai/dsh-agent
│   ├── @deepseek-ai/dsh-agent-loop
│   ├── @deepseek-ai/dsh-session
│   ├── @deepseek-ai/dsh-tools
│   ├── @deepseek-ai/dsh-llm
│   └── @deepseek-ai/dsh-bosom-friend-kernel
│       ├── BosomPlatformService
│       ├── BosomPlatformProvider
│       ├── bosom_* 业务工具
│       └── BosomKernelBridge
└── Bosom Friend 自研前端
    ├── Electron renderer
    ├── React 页面与组件
    ├── 通过 window.bosomKernel 访问内核
    └── 渲染 DSH Session 事件流
```

## 2. 允许与禁止清单

### 允许使用

| 类别 | 官方包/能力 |
| --- | --- |
| Agent | `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-loop` |
| 会话 | `@deepseek-ai/dsh-session`、`dsh-session-persistence-*` |
| 模型 | `@deepseek-ai/dsh-llm`、`dsh-llm-deepseek`、`dsh-llm-pi-ai` |
| 工具 | `@deepseek-ai/dsh-tools`、`defineTool()` |
| 提示词 | `@deepseek-ai/dsh-system-prompt` |
| 作用域 | `@deepseek-ai/dsh-scope` |
| 技能 | `@deepseek-ai/dsh-skill`、`dsh-tool-skill` |
| 子 Agent | `@deepseek-ai/dsh-subagent`、`dsh-tool-subagent` |
| 工作流 | `@deepseek-ai/dsh-workflow`、`dsh-tool-workflow` |
| 持久化 | `ctx.sessions.flush()`、官方 Session Persistence |
| 外部进程 | Electron IPC / 官方 SDK JSON-RPC 适配层 |

### 禁止出现

| 禁止项 | 原因 |
| --- | --- |
| `@deepseek-ai/dsh-web-app` | 官方 Web UI 层 |
| `@deepseek-ai/dsh-web-frontend` | 官方前端产物 |
| `@deepseek-ai/dsh-client-*` | 官方客户端 UI 组件 |
| `apps/web` | 官方 Web 应用 |
| `HarnessAgent` | 自研 Agent 循环 |
| `AgnesLlmClient` | 自研 LLM 客户端 |
| 自定义 `ToolRegistry` | 必须使用 `ctx.tools` |
| 直接 `fetch('/chat/completions')` | 必须使用 `ctx.llm` |
| 自定义 SSE Agent 状态机 | 必须使用 DSH Session 事件 |
| `agent-tasks.json` 作为会话数据源 | 必须使用 DSH Session |
| `zhiyin:harness:*` IPC | 自研内核桥 |

## 3. 工作区结构

```text
Bosom friend APP/
├── dsh-official/                         # 官方 DSH，只读，锁定 b150a55
│   ├── packages/
│   └── vendor/
├── products/
│   └── bosom-friend/
│       ├── kernel/                       # 新增：DSH 产品内核插件
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── cordis.patch.yml
│       │   └── src/
│       │       ├── index.ts
│       │       ├── kernel.ts
│       │       ├── bridge.ts
│       │       ├── service/
│       │       ├── providers/
│       │       └── tools/
│       ├── launcher/                     # 启动器，只组合 dsh-base + kernel
│       ├── server/                       # 过渡期兼容层，逐步拆空
│       ├── project/
│       │   ├── bosom-friend-electron/    # Electron 壳 + 自研渲染入口
│       │   └── bosom-friend-web/         # 自研 React 前端源码
│       └── qa/                           # 验收与 DSH 门禁
└── pnpm-workspace.yaml
```

## 4. 内核启动组合

启动器只能叠加两个 bundle：

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-bosom-friend-kernel
```

`products/bosom-friend/launcher/src/bin.ts` 的核心组合：

```ts
const BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-bosom-friend-kernel',
]
```

`products/bosom-friend/kernel/cordis.patch.yml`：

```yaml
- insert:
    - id: bosom-platform-service
      name: '@deepseek-ai/dsh-bosom-friend-kernel/service'

    - id: bosom-platform-provider
      name: '@deepseek-ai/dsh-bosom-friend-kernel/providers'

    - id: bosom-tools
      name: '@deepseek-ai/dsh-bosom-friend-kernel/tools'

    - id: bosom-kernel-bridge
      name: '@deepseek-ai/dsh-bosom-friend-kernel/bridge'
```

`dsh-base` 已提供 `ctx.agents`、`ctx.sessions`、`ctx.tools`、`ctx.llm`、`ctx.systemPrompt`、`ctx.skills` 等服务，无需再挂 `dsh-web-app`。

## 5. 官方 API 使用契约

### 5.1 创建会话和 Agent

所有 AI 对话必须通过官方 `ctx.agents.create()`：

```ts
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

async function startBosomSession(ctx: Context, title: string) {
  const sessionId = `bosom-${randomUUID()}`
  const { agent } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    },
    setup(agentCtx) {
      // 只在此处注册该 Agent 的产品工具与 persona
      agentCtx.tools.register(bosomPublishTool)
      agentCtx.systemPrompt.section({
        name: 'bosom:persona',
        order: 100,
        text: '你是 Bosom Friend 的内容营销助手。',
      })
    },
  })
  return agent
}
```

### 5.2 发送消息并等待完成

使用官方 `agent.followup()`、`agent.whenIdle()`、`ctx.sessions.flush()`：

```ts
agent.followup({
  content: [{ type: 'text', text: '帮我写一篇小红书笔记' }],
  source: { kind: 'user' },
})

await agent.whenIdle()
await ctx.sessions.flush(agent.session)
```

禁止在业务代码里自己写 ReAct 循环、模型重试循环、工具调用循环或假 SSE。

### 5.3 注册业务工具

业务动作必须使用官方 `defineTool()` 和 `ctx.tools.register()`：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const bosomPublishTool = defineTool({
  name: 'bosom_content_publish',
  description: '将内容发布到指定平台账号',
  parameters: {
    platform: { type: 'string', required: true },
    accountId: { type: 'string', required: true },
    title: { type: 'string', required: true },
    body: { type: 'string' },
    mediaUrls: { type: 'array' },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        recordId: { type: 'string' },
        status: { type: 'string' },
        message: { type: 'string' },
      },
      additionalProperties: false,
    },
    render: (_args, value) => [
      { type: 'text', text: `发布结果：${value.message}` },
    ],
  },
  async execute(args, exec) {
    return platformService.publish(args, exec.signal)
  },
})
```

### 5.4 模型调用

所有模型请求通过 `ctx.llm` 或 DSH Agent Loop 发起，禁止在业务路由中直接调用 OpenAI 兼容接口。用户 BYOK 模型必须实现为 `LlmAdapter` 并注册到 `ctx.llm.registerAdapter()`，或通过官方 `llm-pi-ai` 配置。

## 6. 本地桥接

### 6.1 Electron IPC 接口

`products/bosom-friend/project/bosom-friend-electron/electron/main/bosom-kernel-host.ts` 暴露：

```ts
window.bosomKernel = {
  createSession(title): Promise<{ sessionId }>,
  sendMessage(sessionId, text): Promise<{ messageId }>,
  listSessions(): Promise<SessionSummary[]>,
  getEvents(sessionId, afterSeq): Promise<SessionEvent[]>,
  listTools(): Promise<ToolSchema[]>,
  invokeTool(name, args): Promise<{ result }>,
  disposeSession(sessionId): Promise<void>,
  onEvent(callback): () => void,
}
```

### 6.2 DSH 事件到前端的映射

| DSH Session Event | 前端用途 |
| --- | --- |
| `session/created` | 新建任务 |
| `user/message` | 用户消息 |
| `assistant/message` | AI 回复 |
| `tool/call` | 工具执行中 |
| `tool/result` | 工具执行结果 |
| `turn/end` | 本轮完成 |

前端只能渲染这些事件，不能自己维护第二份会话状态。

## 7. 业务域划分

### 7.1 Service Definition / Provider / Consumer

| 域 | Service Definition | Provider | Consumer Tool |
| --- | --- | --- | --- |
| 平台账号 | `PlatformService` | 小红书/抖音/快手 Provider | `bosom_platform_list_accounts` |
| 平台同步 | `PlatformService` | 同上 | `bosom_platform_sync_works` |
| 内容创作 | `ContentService` | 本地生成/模型生成 | `bosom_content_generate_script` |
| 素材 | `ContentService` | 本地文件/媒体库 | `bosom_material_list` |
| 发布 | `PublishService` | Python/Chrome 引擎 | `bosom_content_publish` |
| 接待 | `ReceptionService` | Python 轮询引擎 | `bosom_reception_list_pending`、`bosom_reception_reply` |
| 数据 | `DataService` | 数据聚合 Provider | `bosom_data_dashboard` |

### 7.2 首轮必做工具

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

平台登录、发布、接待的真实执行可以继续由 Python/Chrome 完成，但必须由 Provider 封装，再由 Tool 调用。

## 8. 前端改造

1. `bosom-friend-web/src/store/agent` 不再调用 `/bosom-friend/api/agent/tasks` 自研 SSE。
2. 所有会话、消息、任务状态改为调用 `window.bosomKernel`。
3. 任务列表从 DSH Session 列表渲染。
4. 消息详情从 DSH Session 事件渲染。
5. 发布按钮、同步按钮等业务按钮改由 `bosom_*` Tool 或经过确认的 Tool 调用触发。
6. 删除对 `zhiyinHarness`、`agent-tasks.json`、旧后端地址 8080 的依赖。

## 9. 实施阶段

### Phase 0：恢复官方内核基座

交付：

- 建立只读的 `dsh-official` 目录或恢复当前工作区中被删除的官方源码；
- 保证 `pnpm install`、官方 `packages` 构建可执行；
- 新增 `products/bosom-friend/kernel` 包。

验收：

```text
pnpm install 成功
DSH 内核可以无 Web UI 启动
ctx.agents、ctx.sessions、ctx.tools、ctx.llm 可用
不存在 dsh-web-app/dsh-client 依赖
```

### Phase 1：内核启动与桥接

交付：

- 修改 `launcher/src/bin.ts` 为 `dsh-base + dsh-bosom-friend-kernel`；
- 实现 `bosom-kernel-host.ts`；
- 实现 `createSession`、`sendMessage`、`onEvent`、`disposeSession`。

验收：

```text
Electron 主进程成功启动 DSH 内核
自研前端能够创建 Session
发送消息后收到 DSH Session 事件
```

### Phase 2：Agent 与模型链路

交付：

- 前端 AI 对话全部走 DSH Agent；
- 移除自定义 `streamLlmWithDeltas`、`fetch('/chat/completions')`；
- 接入官方 DeepSeek Adapter；
- BYOK 通过官方 Adapter 实现。

验收：

```text
一次用户消息产生完整 DSH 事件链
Session Log 包含 user/message、assistant/message、turn/end
```

### Phase 3：业务工具

交付：

- 完成首轮 10 个 `bosom_*` 工具；
- 将真实平台登录、发布、接待引擎封装为 Provider；
- REST 路由降级为只读兼容层。

验收：

```text
Agent 可以通过 DSH Tool 完成账号查询、内容生成、发布、接待
每个动作都有 tool/call 和 tool/result 记录
```

### Phase 4：移除自研内核

交付：

- 删除 `bosom-friend-harness`；
- 删除 `zhiyin:harness:*`；
- 删除 `HarnessAgent`、`AgnesLlmClient`、自研 `ToolRegistry`；
- 删除 `agent-tasks.json` 会话数据源。

验收：

```text
全仓库搜索不到自研内核主链路
产品功能不因删除自研内核而失效
```

### Phase 5：打包 .exe

交付：

- Electron 主进程内嵌 Node/DSH 运行时；
- 自研前端 dist 打包进安装包；
- 无外部 8080 后端、无外部 HTTP 依赖。

验收：

```text
干净机器安装 BosomFriend.exe
启动后无需手动启动 DSH 服务
前端页面能够直接使用 DSH Kernel
```

## 10. 门禁与杜绝机制

新增门禁脚本：

```text
products/bosom-friend/qa/verify-dsh-kernel-boundary.mjs
```

必须检查：

- 产品依赖图不得包含 DSH Web UI/Client 包；
- 产品代码不得直接调用 `/chat/completions`；
- 产品代码不得出现自研 `HarnessAgent`、`AgnesLlmClient`、`HarnessDataStore`；
- AI 对话路径必须调用 `ctx.agents`；
- 业务执行路径必须注册 `ctx.tools` 或 `Service Provider`；
- 发布必须附 DSH Session Log 证据。

发布验收标准：

```text
session/created
user/message
assistant/message
tool/call
tool/result
turn/end
```

缺少任意一项，禁止对外宣称“基于 DeepSeek Harness 官方内核”。

## 11. 完成定义

以下条件全部满足才算完成：

1. DSH 内核在 Electron 主进程内运行。
2. 官方 Web UI 和 Client 包完全不在产品依赖中。
3. 自研前端只通过 `window.bosomKernel` 访问 DSH。
4. 所有 AI 对话都产生 DSH Session 事件。
5. 所有业务动作都由 DSH Tool/Provider 执行。
6. 自研 Agent、LLM、工具注册、会话存储已删除。
7. `.exe` 在干净环境可运行并完成一条完整 DSH 业务链。

## 12. AI 听话保障（开发过程与使用过程）

### 12.1 总原则

提示词只能引导 AI，不能作为安全边界。AI 是否“听话”必须由四层机制共同保证：

```text
可见工具范围 × 审批与权限 × 执行边界 × 审计与恢复
```

任何一层都不能单独作为安全保证。

### 12.2 使用过程中的运行时控制

#### 1. 工具白名单

每个 Bosom Friend Agent 只能看到产品允许的工具：

```ts
setup(agentCtx) {
  agentCtx.tools.restrict([
    'bosom_platform_list_accounts',
    'bosom_platform_sync_works',
    'bosom_content_generate_script',
    'bosom_content_save_draft',
    'bosom_content_publish',
    'bosom_reception_list_pending',
    'bosom_reception_reply',
    'bosom_data_dashboard',
  ])
}
```

不在白名单中的 `shell`、`fs`、`subagent`、`web` 等通用工具不得暴露给普通产品 Agent。

#### 2. 高风险动作必须审批

以下动作必须经过用户确认：

- 真实平台登录；
- 真实平台发布；
- 评论/私信回复；
- 修改账号、解绑账号；
- 修改接待规则；
- 删除素材、发布记录或数据。

DSH 的 `tools/pre-execute` 管道负责把这类动作改成 `ask`，由 `ctx.approval` 出审批，前端展示审批按钮。前端不得自动代点“确认”。

#### 3. 沙箱与权限

- 默认使用 `workspace-write` 权限；
- 产品正式运行禁止使用 `danger-full-access`；
- 不必要的 shell、文件系统、网络工具不挂载；
- 模型不能直接读取 API Key、Cookie、密码文件；
- Cookie 只进入 Provider 内部，不进入提示词和 Session Log。

#### 4. 防失控与防死循环

- 使用官方 `dsh-tool-call-timeout-policy`；
- 使用官方 `repeat-tool-reminder`；
- 使用 `agent/turn-stopping` 限制无限工具循环；
- 单次任务设置步数上限和超时；
- 用户可随时取消 Agent：`agent.cancel()`。

#### 5. 输入与结果边界

- `defineTool()` 强制校验模型传来的参数；
- 每个工具声明严格 output schema；
- 工具执行结果必须落入 DSH Session Log；
- 模型无法通过自由文本绕过工具执行真正业务动作。

#### 6. 全链路审计与恢复

- 每次工具调用都记录 `tool/call` 和 `tool/result`；
- 每次模型消息都记录 `assistant/message`；
- 出现异常时可根据 Session Log 回放；
- 发布前保留内容快照，失败可恢复；
- 提供全局“停止 Agent”能力，不依赖模型自己停下来。

### 12.3 开发过程中的约束

1. 产品代码必须通过 `verify-dsh-kernel-boundary.mjs` 门禁；
2. 禁止直接 `fetch('/chat/completions')`；
3. 禁止重新实现 Agent 循环、工具注册表、会话存储；
4. 禁止提交 API Key、Cookie、真实账号数据；
5. 新增业务工具必须同时提供单元测试、参数校验测试和审批测试；
6. 高风险功能必须通过 S 级前端监考验证；
7. 官方 DSH 源码只读，不得为了绕过限制修改官方包。

### 12.4 “AI 听话”的验收定义

只有当以下条件全部成立，才算 AI 可控：

- AI 只能调用白名单内的工具；
- AI 发出的高风险动作没有审批就无法执行；
- AI 违反规则时，请求在代码层被拒绝，而不是依赖模型自觉；
- 拒绝、审批、执行、失败全过程都留在 Session Log；
- 用户随时可以停止任务并恢复现场；
- 恶意提示词无法让 AI 获取密钥、删除数据或自动发布。

## 13. 方案成熟度与未闭环项

本方案当前是 v1.0 架构基线，不是终版。以下问题必须继续决策和细化，否则无法视为“最完善”。

### 13.1 未闭环项

| # | 问题 | 为什么必须解决 |
| --- | --- | --- |
| 1 | DSH Tool 在 Kernel 执行与“前端动手”铁律的冲突 | 目前铁律要求业务动作由前端页面执行，但 `bosom_*` Tool 默认在 Kernel 内执行。需要定义“工具产出前端动作卡 → 用户在前端执行 → 结果写回 DSH Session”的闭环 |
| 2 | 工具调用如何暂停等待用户审批/操作 | 官方审批、ask-user、jobs 中应选择哪种机制，尚未定型 |
| 3 | 用户身份与 DSH Session 的映射 | 产品登录用户、匿名用户、多账号如何对应到 Session/Agent |
| 4 | BYOK 模型动态配置 | 用户换 Key、换 BaseURL、换模型时如何通过 `ctx.llm`/settings/credentials 热更新，而不是重新启动 |
| 5 | 业务数据存储归属 | 账号、素材、发布记录是走 DSH storage seam，还是保留产品自有存储，必须有明确边界 |
| 6 | 旧数据迁移 | 现有 `agent-tasks.json`、账号、发布记录如何迁移或降级 |
| 7 | 官方 DSH 基座恢复方式 | 当前工作区官方文件大量缺失，尚未决定 submodule、独立目录还是原地恢复 |
| 8 | Python/Chrome 引擎如何随 .exe 分发 | 打包形态、启动、失败兜底、资源占用尚未设计 |
| 9 | 历史 REST 契约兼容期 | 146 条路由哪些保留、哪些删除、保留多久 |
| 10 | 测试与门禁的精确断言 | DSH Session 门禁、恶意提示词、审批拒绝、工具超时的自动化用例尚未列出 |
| 11 | 安全威胁模型 | 本地 IPC 隔离、Cookie 存储、平台风控、exe 签名、网络零外发 |
| 12 | 里程碑与工时预算 | 各 Phase 的完成时间和人力尚未估算 |

### 13.2 结论

本方案已经确定了正确方向：只嵌入 DSH Kernel、不使用 DSH 前端、自研前端作为客户端、业务动作走 Tool/Provider、DSH Session 为唯一事实源。

但在 13.1 全部决策完成之前，本方案只能定位为“架构方案 v1.0”，不能对外宣称“最终执行方案”。
