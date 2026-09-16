# 14 Token 与成本怎么记（Agnes 实测）

> 问题起点：成本账本要"一条完整业务的 token 与耗时"，但 Agnes 是第三方网关，直觉上"用量拿不到"。
> 2026-09-16 用真实调用把这条链路走了一遍，结论与直觉**一半相反**：文本调用有用量，只是我们在中间层丢掉了；图像/视频确实没有。

## 一、Agnes 到底给不给用量（实测，非推测）

探针：`qa/probes/agnes-usage-probe.mjs`（真实调用，读数见下方原文）。

| 端点 | 是否有用量 | 实测证据 |
| --- | --- | --- |
| `POST /chat/completions`（非流式） | **有** | 响应顶层键 `id, created, model, object, choices, usage, metadata`；`usage = {prompt_tokens: 58, completion_tokens: 41, total_tokens: 99}` |
| `POST /chat/completions`（**流式** + `stream_options.include_usage=true`） | **有** | 34 帧，倒数第二帧带 `usage`（含 `completion_tokens_details.reasoning_tokens`），随后 `data: [DONE]`；不带 `include_usage` 时末帧 `usage` 为空 |
| `POST /images/generations` | **无** | 响应只有图片 URL 数组 |
| `POST /videos`（异步任务） | **无** | 只有 `video_id` 与任务状态；没有 token/credit 字段 |

模型清单（同一次实测）：`agnes-3.0-flash`、`agnes-2.5-pro(-alpha/-beta)`、`agnes-2.5-flash`、`agnes-2.0-flash`、`agnes-image-2.1-flash`、`agnes-image-2.5-flash`、`agnes-video-2.5`、`agnes-video-2.5-flash`、`agnes-video-v2.0`。

**避坑**：拿不存在的模型名打 `/chat/completions` 返回的是 **503**（不是 404），"服务不可用"的外观很容易被误判成网关故障；先 `GET /v1/models` 对齐名字。

## 二、用量是在哪一层丢掉的

```text
Agnes 响应(有 usage)
   ↓  DSH 适配器 llm-pi-ai：stream.ts 有 mapUsage()，但只在路由声明 supportsUsageInStreaming 时才请求 include_usage
   ↓  token-meter：deriveTurnTokenUsage() 能算出一轮用量
   ↓  agent-loop：usage 挂在 assistant/message 事件上（packages/core/session/src/types.ts:313-327）
   ×  产品 server/src/kernel-client.ts：只读 session.event 的文本增量（assistantTextOf），usage 直接丢掉
   ×  产品 server/src/api.ts:2059：/ai/chat 的响应把 usage 硬编码成 {0,0,0}
```

所以"没办法记录"的真实含义是：**上游给了，我们的中间层没接**。而硬编码的 0 比"没有字段"更糟——它看起来像实测值。

## 三、成本账本的三档口径（诚实排序）

| 档 | 记什么 | 精度 | 适用 |
| --- | --- | --- | --- |
| **A 实测** | 文本调用的 `input/output/reasoning tokens`（从 `assistant/message` 事件的 `usage` 取） | 精确 | 脚本生成、标题/文案、接待回复、内核对话 |
| **B 估算** | 图像/视频按**业务量**计（张数、秒数、段数、重试次数）；文本若拿不到用量，按字符数换算 | 估 | 图片生成、视频生成、第三方 TTS |
| **C 墙上时间** | 每一步的**本地计时**（发起→拿到结果/任务完成），含轮询等待 | 精确（我们自己量的） | 全部链路；也是"最贵三步"的主要判据 |

**红线**：三档必须**分别标注**，不许把 B 写成 A、不许把 0 当实测（这是 DEF-050 同类问题：弱信号冒充强信号）。

## 四、文本 token 的本地估算怎么做才不是"拍脑袋"

1. **固定分词器算**：用与目标模型同族的开源 tokenizer 算 `tokens(chars)` 比值，写死在工具里，不手抄常数；
2. **一次校准**：用 Agnes 返回的真实 `usage` 与我们本地估算**对同一批文本**比对，得到该厂商的实测比值（中文字/词/标点各有系数）——这一步把"估算"变成"有标定的估算"；
3. **给出误差带**：报告里写"估算 ±X%"，并随样本量更新；误差带超过阈值时就如实标"不可用"。

## 五、给成本账本的最小落地（尚未实现）

```text
~/.bosom-friend/bosom-friend/logs/cost-ledger.jsonl   每行一步
{ ts, business, step, model, kind: text|image|video|tts,
  tokens: { input, output, reasoning } | null,        # A 档，取自 assistant/message 的 usage
  units: { images: 2, videoSeconds: 5, retries: 1 },   # B 档
  ms: { request, wait, total },                        # C 档
  ok: true|false, error?: string, source: 'measured'|'estimated' }
```

配套三件事（按顺序）：① 路由声明 `supportsUsageInStreaming: true` 让适配器请求用量；② `kernel-client.ts` 把 `usage` 透出来，`api.ts:2059` 不再输出假 0；③ 每步写一行 jsonl，出报表时按 `business` 聚合，并打印"实测/估算"占比。

## 相关

- 条目 12（常见坑速查表）、条目 13（AI 视频生成工作流）
- `qa/probes/agnes-usage-probe.mjs`（可重跑：`AGNES_API_KEY=… AGNES_CHAT_MODEL=agnes-2.5-flash node qa/probes/agnes-usage-probe.mjs`）
- 上游可复用能力：`packages/llm/token-meter`（一轮用量推导）、`packages/llm/llm-pi-ai/src/stream.ts`（`mapUsage`）、`packages/core/agent-loop/src/assistant-stream.ts`（流内 usage）
- 成本账本的上位目标见 `docs/协作/AI深度学习方案与学习计划.md`（P3）
