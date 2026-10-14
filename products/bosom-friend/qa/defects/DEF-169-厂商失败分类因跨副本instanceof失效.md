# DEF-169 一次瞬时厂商 503 判死整条长视频：失败分类因 MediaError 跨副本 instanceof 失效而全线退化

| 项 | 值 |
| --- | --- |
| 编号 | DEF-169 |
| 发现日期 | 2026-09-23 |
| 发现方式 | 长视频端到端真机对账（`qa/probes/run-isolated-long-video.mjs`，隔离实例走真实 REST + 真实厂商）：11 镜任务跑到第 2 镜整条 failed |
| 严重级 | P1（一条已经跑成的任务被一次瞬时厂商错误作废，前面花掉的额度全白花；DEF-076/DEF-080 特意补的自动重试被整体旁路） |
| 状态 | Fixed（2026-09-23：能力面加跨副本错误标记 + 产品侧改用 `isMediaError`；两条回归用例，负向对照实测判红） |

## 现象（实测证据）

真机对账那条 12 秒走动 VLOG（隔离实例 31520，任务 `lv-8559a6d0`，11 镜）：

| 层 | 值 | 证据 |
| --- | --- | --- |
| 任务终态 | `failed`，第 6 分钟 | `GET long-videos/lv-8559a6d0` |
| 失败原因 | `第 2 镜生成失败：厂商没有受理这次生成任务` | 同上（**没有状态码、没有「[可重试]」前缀**） |
| 第 1 镜 | `ready`（已经花掉一次厂商调用） | 任务记录 |
| 运行日志 | `[AI_VID_ERR] submit 厂商调用出错：MediaError: media-pi-ai: video submission was rejected with HTTP 503` | `.dsh-build/lv-e2e-31520.err.log` |
| 运行日志 | `[AI_VID_EXC] poll 厂商调用出错：MediaError: media-pi-ai: video status was rejected with HTTP 429`（连续 7 次） | 同上 |

两行日志的措辞是关键：`describeMediaFailure()` 只在**不是 MediaError** 时才回「厂商调用出错：<原文>」。
也就是说产品侧根本没把这些错误认成媒体能力面的错误——状态码读不到（`503` 只出现在字符串里），
`isRetryableMediaFailure()` 一律 false（submit 该重试三次，实测只试一次），
`videoFailureReason(reason, undefined)` 于是回了一句**没有「[可重试]」前缀**的话，
编排层便不重试这一镜，整条任务就此判死。

## 根因

**同一个包在一个进程里有两份物理副本，`instanceof` 跨副本为假。**

pnpm 按依赖方的 peer 集合各注入一份副本，实测两个不同的物理路径：

| 使用方 | 解析到的副本 |
| --- | --- |
| 产品服务端（`server/src/media-gateway.ts`） | `node_modules/.pnpm/@deepseek-ai+dsh-media@file_a9b32bfb07126848687007ed673722d5/…` |
| Provider（`packages/media/media-pi-ai`） | `node_modules/.pnpm/@deepseek-ai+dsh-media@file_f3402c861a503d5e662fec91e33e18c2/…` |

Provider 抛出的 `MediaError` 因此不是产品 import 的那个类的实例。后果是一条链：

1. `mediaFailureStatus(error)` → `undefined`（状态码全丢）；
2. `isRetryableMediaFailure(error)` → `false`（429/5xx 不再重试，submit 的退避循环形同虚设）；
3. `isUnreachableMediaFailure(error)` → `false`（"厂商无应答"这条可重试路径也一起失效）；
4. `videoFailureReason('厂商没有受理这次生成任务', undefined)` → 不带 `[可重试] ` 前缀 → 编排层不重跑这一镜；
5. 一次瞬时 503 = 整条任务 failed。

`media-gateway.ts` 里四处 `instanceof MediaError` 就是全部落点。
## 为什么值得记

1. **"能力面把错误分类收进 Provider"这个设计，靠的是调用方能认出那个错误类型**——副本一多，
   `instanceof` 这条假设就不成立了，而失效方式是**静默降级**：没有报错、没有日志，只是不再重试；
2. 它把产品前几轮特意补的韧性（DEF-076 的 429 文案、DEF-080 的自动重试）整体旁路，
   而单测与门禁都看不出来——单测在**同一份副本**里跑，`instanceof` 永远为真；
3. 只有"真机跑厂商 + 恰好撞上限流/5xx"才会暴露：本地全套绿，真机一条任务作废。

## 修复（2026-09-23）

1. **能力面给错误加一个跨副本稳定的标记**（`packages/media/media/src/types.ts`）：
   `MediaError` 携带 `Symbol.for('@deepseek-ai/dsh-media/MediaError')`，并导出类型守卫
   `isMediaError(value)`——`Symbol.for` 在任何副本里解析到同一个符号，标记因此跟着对象走。
2. **产品侧改用守卫**（`server/src/media-gateway.ts`）：四处 `instanceof MediaError` → `isMediaError(error)`。
3. **回归用例**：
   - `packages/media/media/tests/media.spec.ts`「isMediaError：跨副本识别（DEF-169）」：
     断言"另一份副本的错误"（类不同、字段相同、同一个 `Symbol.for`）`instanceof` 为假而守卫为真；
   - `server/test/media-failure-classification.spec.ts`（5 条）：429/5xx 判可重试、4xx 不重试、
     状态码读得出来、无应答判连接失败、非媒体错误不冒充。
4. **负向对照（实测）**：把 `isRetryableMediaFailure` 的第一行还原成 `instanceof MediaError`
   → 用例判红（`Tests 1 failed | 4 passed (5)`）；改回守卫 → 5 条全绿。

5. **真机验证（最终那次跑通）**：任务 `lv-7f9b54f3` 的第 3 镜撞 429，任务记录里写着
   `第 3 镜暂时性失败（2/3 次重试），45 秒后自动重试：厂商限流，稍后再试（HTTP 429）`，
   任务照旧跑到 `success`（成片 `720x1280` / 20.00 秒，十项检查全绿）。**修之前，这一条 429 就是整条作废。**

## 回归判据

| 判据 | 用例 |
| --- | --- |
| 另一份副本的 MediaError 被认出来 | `packages/media/media/tests/media.spec.ts`「认得另一份副本抛出的 MediaError」 |
| 429/5xx 可重试、4xx 不重试 | `server/test/media-failure-classification.spec.ts` |
| 状态码读得出来（重试与文案都靠它） | 同上 |
| 真机：瞬时厂商错误不再判死整条任务 | `qa/probes/run-isolated-long-video.mjs`（端到端，任务须到 success） |

## 未做 / 边界

- **打包态的副本情况未复核**：本机装机运行时（`%APPDATA%\Bosom Friend\kernel-runtime`）里没有
  `dsh-media` 目录（那一版运行时还没带媒体包）。装出来的产品是否也会出现两份副本，要等带媒体包
  的安装包出来再验一次；守卫对两份、一份、零份都成立，所以打包态不需要改代码，只需要再验一次。
- **副本本身没被消除**：`isMediaError` 让分类跨副本成立，但同一进程里仍是两份物理副本（各带一份
  模块状态）。本次没有引入跨副本状态，所以不构成新问题；若将来能力面引入模块级缓存，需要一并复核。
