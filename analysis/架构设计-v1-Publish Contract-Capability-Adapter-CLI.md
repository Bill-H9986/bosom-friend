# Publish Contract → Capability → Adapter → CLI：Architecture v1

> 作者：本次会话（非 DSH 生成）。设计目标是解决已实测的 3 类故障：
> ① 视频号图文「能力声明错误」② 11/12 格缺 `--declaration` 的「参数契约漂移」③ `TencentNote` 骨架被当成能力。

## 0. 设计原则：把「能力」和「契约」彻底分开

这是约束 4 和约束 6 的统一解，也是整个设计的支点。

| | 能力（Capability） | 契约（Contract） |
| --- | --- | --- |
| 回答的问题 | 我们**打算**支持什么？ | 代码**实际**接受什么？ |
| 本质 | 人的**意图** | 机器的**事实** |
| 能否从代码推导 | **不能**（`TencentNote` 就是反例） | **能**（ast 解析 parser 即可） |
| 因此应该 | **人工声明** | **机器提取** |
| 出错方式 | 声明了但没实现（视频号图文） | 提取不了（上游改 parser） |

**关键推论**：两者**都不能作为对方的依据**，但**必须交叉校验**。
- 用 parser 推能力 → 会把 `TencentNote` 这种骨架当成能力（约束 4 的反例）
- 用能力推契约 → 会重新变成手工维护参数表，必然漂移（现在的 11/12 格）

## 1. 五个模块

### 1.1 Publish Contract（发布契约）

**负责什么**
- 定义一次发布请求的**规范字段集**：字段名、类型、语义、**强制等级**
- 字段的强制等级分两类：`enforced`（业务/合规上所有能发布的平台都必须支持，如 `declaration`）与 `optional`（如 `location`）
- 定义 `(platform, contentType)` 这个**产品语言**的枚举（`contentType ∈ {video, image_text}`）
- `input.json` 的**向后兼容映射**（格式不变，只重新定义语义）

**不负责什么**
- 不判断哪个平台支持哪个字段（Capability 的事）
- 不生成 CLI 参数（Adapter 的事）
- 不含任何逻辑，是纯数据

**数据从哪来**：人工声明一次，从现有 `input.json` 反向提取为 v1 基线。字段集天然有界（发布字段不会无限增长）。

**谁调用它**：后端（构造请求）、Worker（读取）、Capability（判断字段支持性）、Adapter（字段→参数映射）、门禁。

### 1.2 Capability Registry（能力注册表）

**负责什么**
- 存**人工意图声明**：`(platform, contentType) → claimed`，外加一句人类可读的备注
- **计算**四级状态 L0–L3（见 1.2.1）
- 对外提供两个查询：`level(platform, contentType)` 与 `supports(platform, contentType)`
- 提供**用户可读的拒绝文案**（约束 7 的落点）

**不负责什么**
- **不存** CLI 参数契约（那是 CLI Boundary 提取的）
- **不存** L0–L3 的人工值（那是算的）
- 不做参数校验（校验在 Worker 与门禁）

**数据从哪来**（三个源，只有一个人工）

| 源 | 内容 | 性质 |
| --- | --- | --- |
| 人工 | `claimed` 意图声明 | 唯一需要人写的 |
| CLI Boundary | action 集合 + 每 action 的参数集合 | 机器提取 |
| Adapter | 该平台声明映射了哪些字段 | 代码即声明 |
| 运行数据 | `publish-records.json` 的成功记录 | 机器读取 |

**谁调用它**：前端（渲染可选范围）、后端路由（发布前校验）、Worker（防绕过校验）、门禁。

#### 1.2.1 L0–L3 的判定规则（全部可机器计算）

| 级别 | 判据 | 数据源 | 当前实例 |
| --- | --- | --- | --- |
| **L0** 代码存在 | 声明了，且代码里能找到对应实现符号 | 静态扫描 | `TencentNote` 类存在 |
| **L1** 可调用 | L0 + CLI Boundary 里存在对应 action | ast 提取 | 视频号图文**卡在这里**（无 `upload-note`） |
| **L2** 链路可执行 | L1 + Adapter 产出的 argv ⊆ parser 注册参数 | ast 提取 + argv 构造 | 抖音图文卡在这里（缺 `--declaration`） |
| **L3** 真实运行验证 | L2 + 运行数据里有该 `(platform, contentType)` 的**成功记录** | `publish-records.json` | 抖音视频是 L3 |

**注意**：L0–L3 **不是人工填的**，是算出来的。这直接回答了隐藏约束（见第 5 节）。

### 1.3 Platform Adapter（平台适配器）

**负责什么**
- **一个平台一个文件**（`adapters/douyin.ts`、`adapters/tencent.ts` …）
- 声明式地表达两件事：① 我映射到哪个 `cliPlatform` + `action`；② 每个 Contract 字段→哪个 CLI 参数
- 产出 argv（纯函数：`(request) → string[]`）
- **它是唯一必须人工写的代码**，但它是声明式数据，不是 if/else 逻辑

**不负责什么**
- 不判断能力（Capability 的事）
- 不校验参数是否被 parser 接受（CLI Boundary 的事）
- 不 spawn 进程（Worker 的事）

**数据从哪来**：人工。但按平台分文件，所以**不会成为上帝文件**。

**谁调用它**：Worker。

### 1.4 Worker（保持存在，职责收窄）

**负责什么**（只懂流程）
- 读 `input.json`
- 调 Capability 校验（**约束 6 的第二道闸门**）
- 取 Adapter → 拿 argv
- spawn CLI、泵日志、超时、回写 `state.json`、失败分类

**不负责什么**（这是本次最重要的收窄）
- **不再构造 argv**。现在 `worker.py:706-750` 里那些 `if cli_platform == 'bilibili': args += ['--tid']` **全部搬进 Adapter**
- 不再知道任何平台细节

**数据从哪来**：`input.json`（业务请求）+ Adapter（argv）+ CLI Boundary（校验用契约）。

**谁调用它**：后端 spawn。

**「worker 应该知道多少？」的回答**

> worker 应该知道**流程**，但**不知道任何平台**。

**为什么不是「worker 读 capabilities.json」**（你特别警告的）：
那样 worker 仍然要**自己决定**「哪个字段转成哪个参数」——只是把 `if/else` 换成查表，
**决策权还在 worker**。正确的分工是：**Adapter 掌握字段→参数的映射，worker 只负责执行它**。
worker 从「知道 12 个平台的分支」变成「知道一个接口：`adapter.buildArgs(request) → string[]`」。

### 1.5 CLI Boundary（CLI 边界）

**负责什么**
- **提取** parser 的真实契约：有哪些 `(platform, action)`、每个 action 注册了哪些参数
- **校验**：Adapter 产出的 argv ⊆ 该 `(platform, action)` 注册的参数
- **它是唯一允许读 vendored parser 的模块**

**不负责什么**：不判断能力、不构造参数。

**数据从哪来**：**机器提取**（`ast` 解析 `sau_cli.py`，可行性已被本轮 `analysis/_contract/extract3.py` 证明：10 平台 / 33 action）。

**谁调用它**：Capability（判定 L1/L2）、门禁、Worker（spawn 前最后一道校验）。

## 2. 完整链路

```
前端
 ↓ ①  capability 查询：这个平台这个内容类型可选吗？（不可选则置灰 + 文案）
Capability Registry  ←── 意图声明(人工) + 契约提取(机器) + 运行记录(机器)
 ↓ ②  用户在合法范围内选择
后端路由（197 条不变）
 ↓ ③  构造 Canonical Publish Request（Publish Contract）
input.json（格式不变，向后兼容）
 ↓ ④  spawn
worker.py（只懂流程）
 ↓ ⑤  【闸门 2】Capability 校验：这次发布在能力范围内吗？
 ↓ ⑥  Adapter：request → CLI platform/action + argv
 ↓ ⑦  【闸门 2.5】CLI Boundary 校验：这些参数 parser 都认吗？
CLI（sau_cli.py，vendored，只读）
 ↓ ⑧  执行
uploader → 平台
```

**三道闸门，各自的理由**：

| 闸门 | 位置 | 为什么需要它 |
| --- | --- | --- |
| ① 前端 | 选择阶段 | 离用户最近（约束 7）：用户根本选不到非法组合 |
| ② Worker | spawn 前 | **防绕过**：DSH Kernel 的工具（`bosom_publish_content`）不走前端，必须在这里拦 |
| ②.5 CLI Boundary | spawn 前 | 拦「能力合法但参数不匹配」——这正是 `--declaration` 那一类 |

## 3. 三个场景：开发者究竟要改几处

### 案例 A：新增 `--foo` 参数

| 步骤 | 改哪里 | 人/机器 |
| --- | --- | --- |
| 1 | Publish Contract 加字段 `foo`，标注 `enforced` 还是 `optional` | 人工（1 处） |
| 2 | 真正支持它的平台，在各自 Adapter 加一行映射 | 人工（0–N 处，**只有真支持的平台**） |
| 3 | 契约提取、门禁断言、前端可选范围 | **机器** |

**开发者改 1 + N 处**（N 通常 0–2）。

**关键**：如果字段是 `enforced` 而某平台 Adapter 漏了映射 → **门禁在 CI 阶段红**（不是等用户点发布）。
如果字段是 `optional` 而某平台没映射 → 合法（该平台就是不发这个参数）。

### 案例 B：新增平台 Y

| 步骤 | 改哪里 | 人/机器 |
| --- | --- | --- |
| 1 | Capability Registry 加一行声明：`{ platform: 'Y', contentType: ['video'] }` | 人工（1 处） |
| 2 | 新建 `adapters/y.ts`（声明 cliPlatform/action + 字段映射） | 人工（1 处） |
| 3 | CLI 契约、L0–L3 计算、前端元数据、门禁 | **机器** |

**开发者改 2 处。**（对照约束 8：现在是「改 catalog + worker + parser + 前端 + enum + map + 提示词」7 处）

**注意平台键的去重**：当前有**三套键**（产品 `PlatType` / engineKey / CLI parser 名）与**两次转换**。
新架构里，**平台键只在 Adapter 里声明一次**，其余全部从它派生 —— 这是消灭「第二份事实」的第一刀。

### 案例 C：新增「图文」内容类型（以视频号为例）

| 步骤 | 改哪里 | 结果 |
| --- | --- | --- |
| 1 | 声明 `{ platform: 'wxSph', contentType: ['video','image_text'] }` | 人工 |
| 2 | Adapter 加 `image_text` 的映射 | 人工 |
| 3 | 契约提取发现 `tencent` **只有 `upload-video`** | **机器 → L1 判定失败** |
| 4 | 门禁红：「声明了图文，但 CLI 无对应 action」 | **机器** |

**开发者被迫面对一个显式选择**：要么撤掉声明（承认不支持），要么去补实现。
**这正是我们想要的** —— `TencentNote` 那种「骨架被当成能力」的情况，**在 CI 阶段就会被拦住**。

## 4. 你要求我主动发现的五个「哪里」

| 问题 | 我的回答 |
| --- | --- |
| **哪里存在第二份事实？** | ① 三套平台键（`PlatType` / engineKey / parser 名）② `PLATFORM_CONTENT_LIMITS` 与 prompt 里的字数口径 ③ 前端 `PLATFORM_CONSTRAINTS`（已自述「从来没命中过」）④ `ENGINE_PUBLISH_PLATFORMS` 与 `sau_cli` 的 action 列表 |
| **哪里会漂移？** | ① 意图声明 ↔ 实际实现（视频号）② Adapter 映射 ↔ parser 注册（11/12 格）③ uploader 类名 ↔ 真实可用性（`TencentNote`） |
| **哪里应该生成？** | ① CLI 契约（ast 提取）② L0–L3 状态（计算）③ 前端平台元数据（从 Capability 读）④ 门禁断言（从契约生成） |
| **哪里必须人工声明？** | ① 意图（`claimed`）② Adapter 的字段→参数映射 ③ Contract 字段的强制等级 |
| **哪里应该失败？** | ① 前端（不可选）② 后端（400 + 用户可读文案）③ Worker（防绕过）④ 门禁（CI 阶段） |

## 5. 隐藏约束：Capability 应该按什么粒度组织

**如果按 `platform + action + field` 组织**：10 平台 × 2 action × ~20 字段 ≈ **400 格**，
而且**每格都要人维护** → 必然成为新的上帝文件。

**我的答案：分三层，粒度不同、来源不同**

| 层 | 粒度 | 来源 | 规模 |
| --- | --- | --- | --- |
| **意图声明** | `(platform, contentType)` | **人工** | **约 12–20 格** |
| **契约事实** | `(platform, action, field)` | **机器提取** | 自动生成，不维护 |
| **能力状态** | `(platform, contentType)` → L0–L3 | **计算** | 自动 |

**为什么声明层停在 `(platform, contentType)` 而不下探到 field**：
因为那是**产品决策的最小粒度** —— 产品只会说「视频号支不支持图文」，不会说「视频号支不支持 declaration」。
字段级的问题由**契约交叉校验**自动回答，不需要人重复声明一遍。

**所以 Registry 的人工部分只有约 20 行**，其余全是计算 —— 这是它不会变成上帝文件的原因。

## 6. 我主动指出的残留风险（这一节是给自己挑毛病）

1. **Contract 字段表会增长**：每加一个字段加一行。它比 Registry 更容易变大，但天然有界（发布字段有限）。
   → 缓解：字段表只存语义与强制等级，**不存平台差异**。
2. **Adapter 的映射表是 10 份小表**：总量可能到 200 行，但分散在 10 个文件里，不构成上帝文件。
3. **`enforced` 字段的判定需要人拿主意**：`declaration` 是「合规强制」，`location` 是「可选」。
   这个判断**无法自动化**，必须人工 —— 但它**只判一次**，不是每平台判一次。
4. **L3 依赖运行数据**：如果用户从不发布，L3 永远是「未验证」。
   → 这是**正确**的诚实表现，不是缺陷；但要确保 UI 不把「未验证」显示成「不支持」。
5. **上游升级 parser 会变更契约**：提取结果变化 → 与 Adapter 映射不符 → 门禁红。
   → 这是**期望行为**（契约漂移的自动发现），但需要有人处理红灯。

## 7. 与 8 条约束的对照

| 约束 | 落点 |
| --- | --- |
| 1 不推倒现有 | `input.json` 格式不变；197 路由不变；worker 保留；只新增模块与校验 |
| 2 不改 vendored | 全程**只读** `sau_cli.py`（ast 提取）。若将来要支持视频号图文，**必须**改 vendored（写那 3 个方法），届时需显式立项 |
| 3 保留 worker | worker 保留，但职责收窄为「流程」；argv 构造搬进 Adapter |
| 4 不把 parser 当能力源 | 能力由人工声明；parser 只提供**契约**；两者交叉校验 |
| 5 表达 L0–L3 | 四级全部**可机器计算**（见 1.2.1） |
| 6 参数契约 | 闸门 ②.5：`argv ⊆ parser 注册参数`，在 spawn 前 |
| 7 有意义的失败 | 三道闸门；前端给用户可读文案 |
| 8 新增平台不改 5 处 | 案例 B：**改 2 处**（声明 + adapter） |

*本文档为架构设计，不含代码实现，未修改任何文件。*