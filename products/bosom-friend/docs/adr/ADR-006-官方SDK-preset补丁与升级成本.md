# ADR-006：官方 SDK server 打补丁接通 preset 组装（含升级成本评估）

> 状态：已接受
> 日期：2026-10-12
> 关联：ADR-005（AI 管家形态）、BFS-901 章程 901.12（改 DSH SDK 必须先评估升级成本）、本轮 task-4 / task-7
> 评审：Lead 已确认成果与配套物（Agent Note / 单测 / config catalog）；升级策略待产品负责人拍板

## 背景

- 管家 preset（人设 + 工具面 + 技能）要生效，唯一官方调用点是 agent 工厂的 `setup(agentCtx)` 里调 `agentPresets.mount(agentCtx, id)`——只有在那里 join，agent 还没发布，组装被拒才能整次回滚。
- 产品的内核入口是官方 `@deepseek-ai/dsh-sdk-jsonrpc-server`（`kernel/cordis.patch.yml` 的 `bosom-jsonrpc`）。它**原本不做任何 preset 组装**：`createSession` 只传 `sessionId / meta{cwd} / agentOptions`，源码里明写 "No preset composition"。
- 后果（2026-10-12 实测前）：工具面能靠 `BF_AGENT_ROLE` 经 `roles.json` 切开，但 **人设与技能永远不生效**，"总管 + 四管家"只是纸面。
- 2026-10-12 落地：改官方包四处 + 产品补丁层两处，`901.2b 官方 mount 组装` 从「未生效（欠账）」变为「已生效」，并有端到端证据（creator 任务里人设原文 + creator 工具面 + 落库 agentRole=creator 三者同时在场）。

## 决策

### 逐处改动（文件:行 ＋ 原文 ＋ 改后）

**① `packages/sdk/server/src/server.ts:60-69`（选项声明）**

原文：

```ts
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}
```

改后（:68 新增）：

```ts
  /**
   * Preset every session this server creates is composed from. Absent keeps the
   * previous behavior: sessions join no preset and read their model-facing rows
   * from the global plugin layer.
   */
  agentPreset?: string
```

**② `packages/sdk/server/src/server.ts:71-80`（新增结构化接口）**

原文：无此接口。

改后：

```ts
interface AgentPresetComposer {
  /** Compose one agent from a preset; see `@deepseek-ai/dsh-agent-presets`. */
  mount(agentCtx: Context, id?: string): Promise<unknown>
}
```

为什么是结构化接口而不是 import 类型：服务端只用到 `mount` 一个方法，为此给官方包添一份对 `@deepseek-ai/dsh-agent-presets` 的依赖（含锁文件、hygiene、构建次序）不划算；而且**没装 preset 的部署也要能启动**，所以服务在运行时按可选服务解析。

**③ `packages/sdk/server/src/server.ts:291-315`（createSession 里真正 join）**

原文（:274-288）：

```ts
  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const handle = await this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
```

改后（同一逻辑位置，:298-315）：

```ts
    const presetId = this.options.agentPreset
    const presets = presetId === undefined
      ? undefined
      : this.ctx.get('agentPresets') as AgentPresetComposer | undefined
    if (presetId !== undefined && presets === undefined) {
      throw new Error('SDK server is configured with agent preset "' + presetId + '" but the agent-presets service is not loaded')
    }
    const handle = await this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: {
        cwd: this.cwd,
        ...(presetId === undefined ? {} : { agentPreset: presetId }),
      },
      ...(presetId === undefined || presets === undefined ? {} : {
        setup: async (agentCtx: Context): Promise<void> => {
          await presets.mount(agentCtx, presetId)
        },
      }),
      agentOptions: {
```

三个要点：**配置了却没挂服务 → 抛错**（fail loud，不静默降级到"没有 preset"）；`meta.agentPreset` 记录这次组装来自哪份 preset；`setup` 是官方扩展点（`packages/core/agent/src/index.ts:100-118`），在 `session/created` 之前跑。

**④ `packages/sdk/server/src/index.ts:25-45`（插件配置）**

原文：

```ts
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  ...
}
export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})
```

改后：`JsonRpcConfig` 加 `agentPreset?: string`（:33），`Config` 加 `agentPreset: Schema.string()`（:44）。

**⑤ `packages/sdk/server/src/index.ts:66-70`（透传）**

改后：

```ts
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
  })
```

（条件展开是因为仓库开了 `exactOptionalPropertyTypes`：`string | undefined` 不能直接赋给可选属性，第一版 tsc 报 TS2379。）

**⑥ 产品侧（不属于官方包）`products/bosom-friend/kernel/cordis.patch.yml`**

- `bosom-jsonrpc` 加 `config.agentPreset`：由 `BF_AGENT_ROLE` 决定角色、`BF_TEXT_ONLY=1` 时不 join（纯文本会话连工具都不挂）。**整行 `!!js` 表达式必须整体加引号**——不加引号时 YAML 把 `? … : …` 当真值对解析成映射对象，schemastery 报 `expected string but got [object Object]`，loader 直接拒绝启动（2026-10-12 实测事故，见 :14-18 注释）。
- **根层 `bosom-kernel` 让位**（:20-26 注释）：工具插件现在由会话 join 的 preset 提供；两处同挂会以 `tool "…" is already registered` 整轮失败。

### 为什么必须改官方包（不改的路与为什么不选）

产品侧拿不到 `setup` 这个 join 点：`createSession` 是 `HarnessSdkJsonRpcServer` 的 private 方法，会话只能经它创建，插件层无法在其间插入（`agent/created` 之后 mount 已晚于"未发布"约束）。**没有不改官方包就能让人设/技能生效的路**——这是本 ADR 存在的理由。

## 升级成本

### 冲突会以什么形态出现

官方升级 = 覆盖 `packages/sdk/server`（重新 vendoring 或 rebase）→ 上述四处改动**消失**。多数情况下不是 git 冲突，而是**被覆盖后无声失效**。

**实测（关键，决定了兜底方式）**：schemastery 的对象 schema **放行未知键**：

```
OK    已知键      → {"maxTokensAsSuccess":true}
OK    未知键      → {"maxTokensAsSuccess":true,"agentPreset":"creator"}
```

所以补丁丢失后，patch 里的 `agentPreset` 不会报错，而是被**忽略**：不 join 任何 preset；又因为根层已经让位给 preset，**这次会话会一个工具都没有**。这是本方案最危险的失败形态——**静默**。

### 重放补丁步骤（可执行清单）

1. 先记录基线：`npx tsc -b packages/sdk/server`（改前应为 exit 0），`node products/bosom-friend/qa/verify-marvis-progress.mjs` 记下 901.2b 现状。
2. 按本 ADR 的 ①②③④⑤ 逐处重放（行号会漂，按片段匹配；每处都带 JSDoc）。
3. 重建包：`cd packages/sdk/server && npx tsc -b && npx tsdown`（该包没有 `build` 脚本；`lib/index.js` 由 tsdown 从 `lib/types/index.js` 打出）。
4. 刷新**真正被加载的那份**副本——**只对 `@deepseek-ai/dsh-sdk-jsonrpc-server` 适用**：实测它从 `bundle/kernel/runtime/bin-kernel.mjs` 解析到 `.pnpm` 注入副本；而**产品自己的内核包 `@deepseek-ai/dsh-bosom-friend-kernel` 解析到 workspace 包自身**（`products/bosom-friend/kernel/package.json`），**不需要刷副本**——这条是踩坑后实测确认的（按旧假设先删后拷，误删了 `kernel/lib`，重建即恢复）。用
   `node -e "const {createRequire}=require('node:module');console.log(createRequire('<repo>/products/bosom-friend/bundle/kernel/runtime/bin-kernel.mjs').resolve('@deepseek-ai/dsh-sdk-jsonrpc-server/package.json'))"`
   拿到路径后，把 `packages/sdk/server/lib` 复制过去（复制前删旧 `lib`）。
5. 跑门禁：`node products/bosom-friend/qa/verify-preset-parity.mjs`（应 11/11）、`node products/bosom-friend/qa/verify-marvis-progress.mjs`（应 exit 0 且 **901.2b=已生效**——它现在检查的是"组装调用本身在不在"，不是注释字符串）。
6. 跑包测试：`npx vitest run packages/sdk/server`（含 `tests/agent-preset.spec.ts` 的三分支）。
7. 端到端：起一条 creator 任务，确认工具面来自 preset、人设原文在场、落库 `agentRole=creator`。

### 更稳的落点（已评估）

| 落点 | 结论 |
| --- | --- |
| overlay / 子类覆盖 | **不可行**：`createSession` 是 private，SDK server 类是官方实现，产品侧只能从配置进入 |
| 自建 agent 入口（不用 SDK server） | 要自己实现会话协议、持久化接线、关停与子代理通知，代价最大；不建议在 P2 做 |
| 上游 PR（把 `agentPreset` 变成官方能力） | **最稳**：一次成本换永久；下节建议 |

## 风险

| 官方可能的变化 | 现象 | 是否响亮 |
| --- | --- | --- |
| `createSession` 签名变化（`setup` 改名/移除、`meta` 收窄） | 重放补丁时 `tsc` 直接报错（对象字面量多余属性 / 找不到属性） | **编译期响亮**（前提是重放了补丁） |
| 补丁被覆盖（升级时未重放） | `agentPreset` 被 schemastery 放行但忽略 → 不 join preset → 根层又已让位 → **会话零工具** | **静默（最危险）** |
| `setup` 语义变化（改为 session 创建之后调用） | `mount` 在已发布会话上被拒 → setup 抛错 → 创建回滚 | 运行时响亮 |
| `agentPresets` 服务改名/移除 | 我们主动抛 `agent-presets service is not loaded` | 运行时响亮 |
| `mount` 改名/签名变化 | 调用 `undefined` → TypeError → 创建失败 | 运行时响亮 |

**兜底（必须保留）**：门禁 `907.2b`（`qa/verify-marvis-progress.mjs` 的 `officialMount`）已从"文件里有没有某句话"改为"**组装调用本身在不在**"；建议再加一条**运行时自检**（内核首轮会话后断言注册工具数 > 0，或 creator 面必须含 `bosom_content_list_drafts`），把"零工具"这种静默失败变成红。

## 后果

- 正面：人设、技能、工具面首次真正由官方组装机制提供；join 时机与失败回滚由官方语义保证（未发布即 join，组装被拒整次创建回滚）。
- 负面/代价：产品与官方包的一处私有实现细节耦合；每次官方升级要重放 4 处补丁 + 重建 + 刷副本；**升级失败可能是静默的**，只能靠门禁与运行时自检兜底；本轮未跑官方 lint/hygiene，也未走上游流程。

## 备选方案

- **方案 B：只靠 `BF_AGENT_ROLE` + `roles.json` 切工具面（补丁前的状态）**。不选原因：工具面能切，但**人设与技能永远不生效**，"总管 + 四管家"在运行时不存在。
- **方案 C：给 wire 协议（`initialize`/`session/prompt`）加 preset 参数**。不选原因：preset 是部署级组装，在任何会话存在之前就定了；每轮可变的字段会诱导给"已经产出过东西"的会话换 preset，而 agent-presets 明确禁止（组合在会话生命周期内固定）。
- **方案 D：`import @deepseek-ai/dsh-agent-presets` 拿服务类型**。不选原因：为一个方法名付出一份包依赖、锁文件与 hygiene 变更；`ctx.get` 本就把服务当可选项。
- **方案 E：自建 agent 入口（不用 SDK server）**。不选原因：要自己实现会话协议、持久化、关停与子代理通知；收益（不碰官方包）远小于代价。

## 建议

1. **短期：继续打补丁，但把它变成"有清单、有门禁、可复现"的动作**——本 ADR 的重放清单 + `officialMount` 门禁 + `agent-preset.spec.ts` 三分支已具备；升级时按清单走一遍即可（估计 15 分钟内）。
2. **中期：推上游 PR**，把 `agentPreset`（或更通用的 `setup` 配置化）变成官方 SDK server 的能力。理由：这是**通用需求**（任何配置了 roster 的部署都需要 join 点），官方注释本身就写着"配置了 roster 的部署要自己先 join"；上游化之后升级不再有静默失效风险。代价：走官方评审与测试要求（仓库要求真实组装测试 + README + Agent Note，本轮的 Note 与单测可直接复用）。
3. **无论哪条，都补一条运行时自检**：把"零工具"从静默失败变成红。这是本轮实测暴露的唯一无防线场景。

## 验证方式

- `npx tsc -b packages/sdk/server` → exit 0
- `npx vitest run packages/sdk/server` → 通过（含 `tests/agent-preset.spec.ts`：不配 → 不 join；配了没服务 → 抛错；配了有服务 → `mount(agentCtx, id)`）
- `node products/bosom-friend/qa/verify-preset-parity.mjs` → 11/11
- `node products/bosom-friend/qa/verify-marvis-progress.mjs` → exit 0，`901.2b 官方 mount 组装 = 已生效`
- 端到端：creator 任务（`task-e13ed847`）人设原文 + creator 工具面 + 落库 `agentRole=creator`

## 附录：② 的尝试与回滚（2026-10-12 晚）

### 试了什么

把 `agentPreset` 从可选改成**必填**（`Schema.string().required()`），并新增空组装 `presets/none/`（`agent.cordis.yml` 为空列表），让纯文本会话（`BF_TEXT_ONLY=1`）join 到 `none` 而不是「不 join」——目标是让「配置层断线」在**内核启动时就 fail loud**，而不是静默跑出一个没有能力的管家。

### 结果：纯文本路径失败，已回滚

隔离实例上走 `textOnly` 的接口（`POST /long-videos/enhance-topic`）返回 `code:50000`，stderr 原文：

```
Error: bosom-friend-kernel: plugin tree failed to load: failed to apply loader entry bosom-jsonrpc
(@deepseek-ai/dsh-sdk-jsonrpc-server): invalid config:
  - $.agentPreset missing required value (at agentPreset)
```

即 `BF_TEXT_ONLY=1` 那一支下 loader 认为 `agentPreset` 没有值。回滚（schema 恢复可选、patch 表达式恢复 `undefined`）后同一接口返回 `{"code":0,"data":{…真实生成正文…}}`，角色路径同时复验健康（creator 对话 HTTP 200、工具面来自 preset、落库 `agentRole=creator`）。

### 已知与未知

**已知**：用同一个内核入口、同一份 patch、`BF_TEXT_ONLY=1` **独立起内核通过**（stderr 无配置错误）——表达式与必填本身没问题，`none` 也不是原因。**未知（未查清）**：由 SDK client（服务端）起的那个进程为何拿不到值；怀疑点在 SDK client 的环境构造、启动时机或 patch 加载路径。重做时的排查顺序：打印 SDK client 实际 argv/env 与独立启动逐项比对 → 数 patch 被加载几遍 → 在 loader 的 config 解析处打印原始 config。

### 保留物

`presets/none/`（空组装，当前无人 join）与 `launcher/scripts/sync-presets.mjs` 里对它的物化都**保留**：它们无害，且是重做 ② 的现成材料。

## 链接

- 官方包改动：`packages/sdk/server/src/server.ts:60-69`、`:71-80`、`:291-315`；`packages/sdk/server/src/index.ts:25-40`、`:42-45`、`:66-70`
- 官方扩展点：`packages/core/agent/src/index.ts:100-118`（`setup`）；`packages/preset/agent-presets/src/index.ts:414`（`mount`）
- 产品侧：`products/bosom-friend/kernel/cordis.patch.yml:5-26`
- 测试：`packages/sdk/server/tests/agent-preset.spec.ts`
- Agent Note：`.agents/notes/implemented/architecture/2026-10-12-sdk-agent-preset-option.md`
- 门禁：`products/bosom-friend/qa/verify-preset-parity.mjs`（第 11 条 runtime-injection-by-owner）、`products/bosom-friend/qa/verify-marvis-progress.mjs`（901.2a/901.2b）
