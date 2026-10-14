# 自建 Marvis 技术实现方案 v1.0

> **文档编号**：BFS-902 ｜ **版本**：1.0 ｜ **状态**：待产品负责人批准
> **建立**：2026-10-12 ｜ **执行人**：AI 实现者 ｜ **责任人**：产品负责人
> **上位依据**：ADR-005《产品形态改为「AI 管家」》；BFS-901《Marvis 对标实施章程》（顺序与准出）
> **本文解决什么**：BFS-901 讲「按什么顺序、什么算完」，本文讲「**技术上怎么造**」——四个必须自建的核心件、各自的落点与验证方式。
> **对标对象**：腾讯 Marvis（「贾维斯」是媒体对它的通俗比喻，不是对标对象名）。

---

## 修订记录

| 版本 | 日期 | 修订内容 | 依据 |
| --- | --- | --- | --- |
| 1.0 | 2026-10-12 | 首版：目标分层架构；四个核心技术件（管家组装器 / 会话池 / 能力注册表 / 视觉降级）的现状、证据、方案、落点与验证 | 产品负责人：「你准备怎么实现我们的自建 Marvis，还没拿个具体专业的章程出来」 |

---

## 1 目标形态（技术视角）

```
① 入口层   对话 —— 唯一第一入口（页面不再承担执行）
     ↓
② 编排层   总管：理解一句话 → 拆解 → 分派给专业管家
     ↓
③ 管家层   creator / publisher / operator / device
           每个管家 = 人设(persona) + 工具面(tools) + 技能(skills)
     ↓
④ 能力层   bosom_* 工具（由「能力注册表」生成，不是手写）
     ↓
⑤ 执行层   server 的能力实现 / 平台引擎 / 媒体能力缝
     ↓
⑥ 数据层   store（单写入点 + 事务）
     ↓
⑦ 呈现层   会话流 + 过程卡（工具序列 / 截图 / 中间产物）—— 页面只读
```

**判断一处改动属于哪一层，就知道它该放哪**：加能力 → ④ 登记；加平台 → ⑤ 引擎；改交互 → ⑦ 呈现。

---

## 2 现状与四个核心技术件

### T1 · 管家组装器（**最高优先级**）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 管家定义**已写好** | 5 个角色 × (人设 + 工具面 + 技能)，共 20 个文件 | `presets/{steward,creator,publisher,operator,device}/{preset.yml,agent.cordis.yml,skills/*.md}` |
| 工具面唯一事实源**已有** | `presets/roles.json`，由 `qa/verify-preset-parity.mjs` 10 项门禁守住 | 5 个角色、工具面逐条一致 |
| **但从未被加载** | 内核真正的插件树是**空的** | `bundle/kernel/cordis.yml` = `[]` |
| preset 插件**实际已经挂上了**，但**不产生组装效果** | `bosom-agent-presets`（`@deepseek-ai/dsh-agent-presets`）在 `kernel/cordis.patch.yml:33-36` 已 insert（`config.default: steward`）；同一文件 24-32 行自述「本行当前**不产生任何组装效果**」 | `kernel/cordis.patch.yml`（**修正：首版误写为"未挂载"**） |
| 组装不生效的**上游原因** | 「No preset composition: this server's compositions keep the model-facing rows in the host plane… A deployment that configures a roster has to join one here first」 | `packages/sdk/server/src/server.ts:274-278` |
| 组装源文件自己承认是"第二表示" | 「产品内核入口（dsh-sdk-jsonrpc-server）**不做 preset 组装**，所以它是同一事实的第二种表示」 | `presets/creator/agent.cordis.yml:19-21` |
| 运行期只有环境变量在起作用 | `BF_AGENT_ROLE` → `Config.tools` 前缀筛选 | 内核工具面筛选 |

**结论**：**管家系统是"纸面的"——定义齐全，从未装配。**

**方案（三条路；**摸底 DSH 后改为推荐 B**）**

- **B · 走官方 `mount()` ＋ 给 SDK server 补一处 setup 透传（推荐）**
  官方唯一接入点是 `presets.mount(agentCtx, id)`（`packages/preset/agent-presets/src/index.ts:414`，
  注释原文「Call from the agent factory's **setup(agentCtx)**」）；而 agent 工厂**正好有这个扩展点**：
  `readonly setup?: AgentSetup`（`packages/core/agent/src/index.ts:100-118`），
  且「Everything registered through agentCtx（scoped tools, prompt sections/variables, `restrict()`, listeners, awaited child plugins）exists **before session/created**」，
  meta 里还带 `agentPreset?: string`。
  **断点只有一个**：SDK server 的 `createSession` 只传 `sessionId / meta{cwd} / agentOptions`，
  **既无 `setup` 也无 `meta.agentPreset`**（`packages/sdk/server/src/server.ts:279-288`），
  协议层也没有预设参数（`packages/sdk/protocol/src/types.ts:115-119`，整个 `packages/sdk` 内 `agentPreset` 命中 0 处）。
  → **补这一处透传，组装即生效**；改动小、走官方机制、人设/技能/工具面全部由官方 `mount` 负责。
- **A · 内核侧自建组装**：内核就是 Cordis 应用，把空插件树改为按角色读 preset 并注入。
  不动官方包，但**人设、技能、工具面都得自己拼**，且与官方 preset 机制并行两套（升级易脱节）。
- **C · 产品自建 agent 入口**：不用 SDK server，直接起 cordis 应用 ＋ agent 工厂 ＋ `mount` preset。
  最彻底，但要自己实现会话协议。

**官方硬限制（必须先知道）**：一个会话**只能在"还没产出任何东西"时切换 preset**，一旦产出，组合在会话生命周期内固定
（`packages/preset/agent-presets/README.md:81`：「only while it has produced nothing … the composition is fixed for the session's life」）
→ **所以"转交"不能给当前会话换角色，必须走子代理新建会话**（见 T5）。

**验证（必须结构化）**：对创作者角色说「把这条发到抖音」——**发布工具在它的工具列表里根本不存在**（是"不存在"，不是"被叮嘱别用"）。

---

### T2 · 会话与角色（管家不失忆、工具面真的生效）

> **修正（2026-10-12 摸底）**：首版写「会话池完全缺失、一进程一请求」——**错了**。会话池**已经有了**。

| 项 | 事实 | 证据 |
| --- | --- | --- |
| **会话池已有** | `AGENT_KERNEL_LIMIT = 4`；`agentKernels = Map<taskId, {client, sessionId, usedAt}>`；`takeAgentKernel(taskId, options)` 命中即复用，超限淘汰最旧；中断时 `dropAgentKernel` | `server/src/api.ts:1887-1931`、`:3284` |
| 进程内 session 的硬限制 | 「一个内核进程只服务一次请求……跨请求复用同一个 session id 会以 `session "…" already exists` 整轮失败」，所以**每个 taskId 用独立 client ＋ 独立 sessionId**（`taskId + '-s' + seq`） | `kernel-client.ts:34-36`、`api.ts:1912` |
| **对话主链路写死 steward** | `takeAgentKernel(task.id, kernelOptionsOf(llmOverride, { role: 'steward' }))` —— 而 steward 的面是 `["*"]`（全量） | `server/src/api.ts:2913`；`presets/roles.json` |
| 后果 | **四个管家的专业工具面在对话里从不生效**；工具面即权限**在唯一入口上等于没有** | 同上 |
| 池**不按角色分组** | 池的键只有 `taskId`，值只有一个 client，**不记角色** | `api.ts:1888` |
| 归属管家只用于**界面** | `task.agentRole` 在任务创建时写一次，注释「已经有归属的一律不改判」 | `api.ts:2683`、`types.ts:394` |
| 管家之间**无转交机制** | 全仓未找到按角色改判/移交的代码；注释把专业子集写作「**未来的**管家转交」 | `api.ts:2912` |

**结论**：不是"没有会话池"，而是——**会话池有了，但唯一入口写死了总管的全量工具面，角色从头到尾没参与进去。**

**方案**：
1. `api.ts:2913` 的 `role: 'steward'` 改为**按任务归属角色**取值（`agentRoleOfFocus` 已有），并在**池键里带上角色**（`taskId + ':' + role`）；
2. 归属角色可变（转交时改判），并同步重建该任务的会话（工具面是**进程级**的，换角色 = 换进程）；
3. 总管保持 `["*"]` 作为**唯一入口**，但它**必须会转交**（详见 T5）。

**验证**：给创作管家一个任务说「把这条发到抖音」——**发布工具在它的工具列表里不存在**；转交给发布管家后，同一任务能用发布工具，且两段的工具序列都能在会话日志里看到。

---

### T3 · 能力注册表（121 条写操作 → 工具）

| 项 | 事实 |
| --- | --- |
| 管家工具 | **51 个**，手写在 `kernel/src/index.ts` |
| 服务端写操作 | **121 条**，分布在 `server/src/` 47 个文件，主入口是 `api.ts`（**8565 行，手工分发路由**，不是 REST 框架） |
| 覆盖率 | **42%** —— 58% 的能力用户只能自己点页面 |
| 已有雏形 | `server/src/object-actions.ts`（531 行）：一条动作只描述三件事——**改什么字段 / 给模型什么任务 / 输出整理成什么值** |

**方案**：建**能力注册表** `server/src/capabilities.ts`：

```ts
/** 一条能力 = 一次可被管家调用的写操作。 */
export interface Capability {
  /** 能力 id：content.createDraft */
  id: string
  /** 暴露给管家的工具名：bosom_content_create_draft */
  tool: string
  /** 归属管家：决定工具面（唯一事实源） */
  role: 'creator' | 'publisher' | 'operator' | 'device' | 'steward'
  /** 给模型看的描述——必须写明「必须调用本工具，不要自己直接做」 */
  description: string
  /** 参数 schema */
  input: Record<string, unknown>
  /** 真正干活：调用既有实现，不重写业务 */
  run: (args: Record<string, unknown>, ctx: CapabilityContext) => Promise<unknown>
}
```

- **内核工具由注册表生成**：不再手写 51 个工具文件；
- **工具面由 `role` 派生**：`roles.json` 可从注册表生成 → 权限与能力天然一致；
- **旧路由保留**：页面在双轨期仍能调，但**新能力一律只登记为工具**。

**验证**：覆盖率 42% → 100%；`verify-preset-parity`（10 项）与 `verify-kernel-tools` 全绿；每条能力至少一次「一句话办成」的三方交叉证据。

---

### T4 · 呈现层降级（页面从执行入口 → 可视化）

| 项 | 事实 |
| --- | --- |
| 前端规模 | **260,373 行 / 37.5%**，是整个项目最大的一块 |
| 形态 | 7 项一级导航 + 页面按钮作为执行入口 |
| 已有基础 | SSE 事件流、动作卡、工具序列都已在通道里 |

**方案（三步，禁止一次性重排）**：
1. **双轨期**：每个功能入口旁边给出"**一句话等价物**"（点按钮时提示对应的话），让用户自然迁移；
2. **主区改造**：页面主区从"表单 + 按钮"改为**会话流 + 过程卡**（工具序列、每步截图、中间产物、结果卡）；
3. **撤入口**：功能入口逐页撤下，只保留"查看/筛选"。

**验证**：关掉页面主链路仍可一句话办成；前端行数只减不增（棘轮已守，`verify-zone-discipline`）。

---

### T5 · 拆解与转交（"一句话拆解"目前**没有实现手段**）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| **子代理能力被整套禁用** | `tool-subagent`、`tool-subagent-fork`、`tool-subagent-list-agents`、`tool-subagent-control` 四条**全部 disabled**（与 pwsh / fs / workflow / jobs / todo / plan-mode 等共 14 项一起关掉） | `kernel/cordis.patch.yml:138-178` |
| 现有的 `bosom_task_create` / `bosom_task_follow_up` **不是分派** | 它们把整句话**再交给同一条总管链路**（`startTaskTurn` → `POST /agent/tasks`） | `kernel/src/index.ts:2602、2664、3458-3463` |
| 51 个工具里**没有拆解/分派/转交类工具** | 逐个核对工具名 | `kernel/src/index.ts` |

**结论**：**"总管自己拆解、自己分派给专业管家"这件事，当前没有任何实现路径**——既没有子代理工具，也没有转交工具。

**方案（摸底 DSH 后发现官方机制正对口，推荐 A）**：

- **A · 解禁并配置官方 `tool-subagent`（推荐）**——DSH 的委派机制**几乎就是 Marvis 形态要的东西**：
  - **一个 `tool-subagent` 实例 = 一个 provider ＋ 一个工具名 ＋ persona ＋ toolFilter{allow,deny}**（`packages/subagent/tool-subagent/src/index.ts:44-103`）；
  - persona 与工具面在子代理创建时落地：`composition.persona` → 系统提示；`composition.toolFilter` → `childCtx.tools.restrict(...)`（`packages/subagent/subagent/src/child-agent.ts:210-217`）；
  - 总管可**反复指挥同一个管家**：`startContinuable` / `sendMessage` / `interrupt`（`packages/subagent/subagent/src/index.ts:228-253`）；
  - **而产品的内核补丁层把四个子代理工具全禁用了**（`kernel/cordis.patch.yml:138-178`）。
  → **做法**：解禁，并为四个管家各配一个实例，总管侧就得到四扇门：
    `delegate_creator` / `delegate_publisher` / `delegate_operator` / `delegate_device`。
  **三条注意事项**：① 一个实例只能绑一个工具名（`:55`「Each loaded instance must use a distinct name」）→ 四扇门 = 四个实例；
  ② 子代理**默认看不到父对话**（`subagent-spawn-in-process/src/index.ts:49-50`「a spawned child starts fresh」）→ 要继承上下文须用 **fork 型 provider**；
  ③ 默认 `maxDepth = 3`，够用。

- **B · 自建 `bosom_steward_dispatch`**：不依赖官方委派，自己写转交工具。可控，但上下文传递、审计、中断都要自己实现。

**验证**：一句「帮我写条无人机培训的图文，写完直接发小红书」——工具序列里出现**两次不同工具面**的调用（创作管的工具 → 转交 → 发布管的工具），且任务归属从 creator 变为 publisher。

---

### T6 · 工具面漏洞（权限边界有洞）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| **3 个工具绕过工具面筛选** | `bosom_content_get_draft`、`bosom_platform_sync_now`、`bosom_platform_login_start` 直接 `ctx.tools.register(defineTool({...}))`，**不经`register()` 包装** | `kernel/src/index.ts:3085、3278、3320` |
| 后果 | 任何角色（含 creator / publisher / operator / device）都会拿到这 3 个工具，**与 `roles.json` 的归属不一致** | 同上 |
| 覆盖实况（按 roles.json 实算） | steward 51 ｜ creator 23 ｜ publisher 5 ｜ operator 6 ｜ device 7；**12 个工具只有 steward 看得到** | 本次摸底实算 |

**方案**：把 3 处直接注册改为走统一的 `register()` 包装；并加一条门禁断言：**源码里不允许出现绕过 `register()` 的 `ctx.tools.register`**。

**验证**：门禁断言通过；四个角色的实得工具数与 `roles.json` 逐条一致。

---

## 3 分层落点速查

| 层 | 现有落点 | 本方案要动的 |
| --- | --- | --- |
| ① 入口 | 前端对话页（现被降级为右侧面板） | 升回第一入口（T4） |
| ② 编排 | 无（单 agent 直连内核） | 总管拆解与分派（T1 生效后即可用 preset 定义） |
| ③ 管家 | `presets/*`（定义齐全、未装配） | **T1 组装器** |
| ④ 能力 | `kernel/src/index.ts`（51 个手写工具） | **T3 能力注册表** |
| ⑤ 执行 | `server/src/*`（47 文件，api.ts 手工分发） | 从 api.ts 抽出能力实现（T3 顺带） |
| ⑥ 数据 | `server/src/store.ts`（单写入点 + 事务） | 不动 |
| ⑦ 呈现 | `project/*`（260,373 行） | **T4 降级** |

---

## 4 与 DSH 的关系（自建 vs 复用）

| 能力 | 来源 | 说明 |
| --- | --- | --- |
| Agent 循环 / 工具协议 / 会话日志 | **复用 DSH** | `packages/core/*`、`packages/session` |
| 工具注册与 schema | **复用 DSH** | 只在其上包一层能力注册表（T3） |
| 技能（Skill） | **复用 DSH** | `packages/skill`；产品已有 11 个技能 |
| preset 组装 | **复用 DSH ＋ 补一处透传**（T1） | `dsh-agent-presets` 有官方 `mount()`，断点只在 SDK server 不传 `setup`／`meta.agentPreset` |
| 工具面过滤 | **复用 DSH** | `ctx.tools.restrict(filter)`（`packages/core/tools/src/index.ts:1061-1079`，必须 scoped 到 `agent.ctx`） |
| 管家委派与多轮指挥 | **复用 DSH** | `tool-subagent`（persona ＋ toolFilter）＋ `subagent`（`startContinuable`/`sendMessage`/`interrupt`） |
| **用户拍板闸门** | **复用 DSH** | `tools/pre-execute` 返回 `{kind:'ask'}` 强制拍板（`packages/core/tools/src/index.ts:144,1669-1714`）＋ `user-approval` 审计（`approval/asked`/`decided`）——**这正是硬约束 2「未经明确发布指令绝不自动发布」的落地机制** |
| 按角色分配技能 | **复用 DSH** | `skill-filesystem` 的 `customSkillDirs(config)`，每个 preset 指定自己的技能目录（`packages/skill/skill-filesystem/src/index.ts:59`） |
| 会话存活与持久化 | **已有**（T2） | 产品已有按 taskId 的会话池；DSH 提供 `session-persistence`（JSONL＋zstd）与投影 |
| **跨会话长期记忆** | **自建** | **DSH 没有记忆服务**（`packages/session/` 下无 memory/knowledge 包；`session-query` 自述是"会话历史检索"不是记忆）→ 靠产品自己的 `server/src/memory-store.ts` ＋ `agent-instructions`（`AGENTS.md` 注入）＋ `session-query`（检索） |
| 管家分工与工具面 | **复用 DSH** | 产品特有的只是"四个角色叫什么、各持哪些工具"，机制本身是官方的 |
| 平台自动化 | **复用 vendored 引擎** | `engine/social-auto-upload`（护城河） |

**原则**：**能复用 DSH 的绝不重写；DSH 明确不提供或与产品形态冲突的，才自建，且自建部分必须有自己的门禁。**

---

## 5 实施顺序（承接 BFS-901 的 P0~P5）

| 阶段 | 本方案对应的工作 |
| --- | --- |
| **P0 立判据** | 修 DEF-285；主链路用例 3 → ≥12（**含写链路，须先建"看得见的窗口里跑写链路"的机制**）；三指标进棘轮（已建 `verify-marvis-progress.mjs`） |
| **P1 补能力** | **T3 能力注册表** + 121 条写操作逐条登记（P1 的主工作量） |
| **P2 通编排** | **T1 管家组装器**（推荐 A 方案）+ **T2 会话池** |
| **P3 降前端** | **T4 三步降级** |
| **P4 收门禁** | 一能力一门禁；注册表可自动生成能力清单，门禁随之收敛 |
| **P5 交付** | 只打一次包 + 装机 + 装机后跑主链路 |

> **为什么 T1 排在 P2 而不是 P0**：组装生效后若没有足够工具（T3），管家分到了工具面也无事可做；反过来，工具齐了但组装不生效，则所有工具都堆在总管身上——**两者都在 P2 收口最省返工**。

---

## 6 风险

| # | 风险 | 应对 |
| --- | --- | --- |
| R1 | T1 走 A 方案（内核侧组装）可能与 DSH 官方升级冲突 | 组装逻辑放在产品自己的 bundle，不改官方包；升级后重跑 `verify-preset-parity` |
| R2 | T2 会话长期存活会放大内存与进程占用 | 池化设上限 + 空闲回收；先量后调 |
| R3 | T3 一次性登记 121 条工作量大 | 按 BFS-901 的"最常说的那句话"排序，**每组登记完即可用**，不做大爆炸 |
| R4 | T4 改呈现层会打乱用户熟悉的排版 | 三步走 + 双轨期；**禁止一次性重排**；每步留证 |
| R5 | 121 条写操作里有相当一部分是"只能手动"的伪能力 | 登记时逐条判：**能一句话办成才算登记成功**，办不成的就地暴露 |

---

## 7 本件自身的判据

| # | 判据 |
| --- | --- |
| 1 | 四个核心件（T1~T4）各有**现状证据**（文件:行号）、**方案**、**落点**、**验证方式** |
| 2 | 每条验证都是**结构化信号**（工具列表里有没有、会话日志里有什么、退出码），不依赖"页面出现了某段文字" |
| 3 | 与 DSH 的分工明确：**复用哪些、自建哪些**，自建部分各有门禁 |
| 4 | 与 BFS-901 的 P0~P5 逐阶段对应，不另立顺序 |
