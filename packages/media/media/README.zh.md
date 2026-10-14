---
description: "媒体生成服务（ctx.media）：部署方与插件作者如何通过可替换的提供方出图、下单并轮询视频——同一套选择策略与错误词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-media

[English](README.md) | 中文

## 概述

用 `dsh-media` 出图或跑视频任务时，调用方不必绑定某一家厂商：每次调用由服务选出一个可用提供方，取消、结果与错误只有一套词汇。需要厂商媒体生成能力的插件或应用服务选它；没有注册提供方的组合里，每一次调用都会以结构化 `MediaError` 失败，而不是自己去连厂商。

## 目录

- [怎么用这个包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型可见效果](#model-experience)
- [已知限制与未做](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 怎么用这个包

需要媒体生成的组合加载 `dsh-media` 服务，并至少挂一个提供方（官方随包提供的是 `dsh-media-pi-ai`），调用方随后使用 `ctx.media.generateImage()`、`ctx.media.submitVideo()`、`ctx.media.pollVideo()`。服务在每次调用时解析提供方，所以调用方看不到提供方 id——除非部署方显式指定了一个。

### 什么时候选它

当一个插件或应用服务必须产出媒体，又不想把厂商端点、凭据或线上方言写死时选它。只跟模型对话的部署不需要它。本服务自己不产生任何网络访问：没有可用提供方时，每个操作都以结构化 `MediaError` 失败。

### 最小配置

加载服务并让唯一挂载的提供方自动选中，或用 `provider` 指定一个：

```yaml
- name: '@deepseek-ai/dsh-media'
- name: '@deepseek-ai/dsh-media-pi-ai'
  config:
    providers:
      agnes:
        displayName: Agnes AI
        apiKeyEnv: BF_AGNES_BUILTIN_API_KEY
        api: agnes
        baseURL: https://api.agnes-ai.cn/v1
```

每个请求用 `provider` 指名路由、用 `model` 指名厂商模型；该路由的端点与凭据由提供方实现解析。

### 操作与结果

| 操作 | 请求携带 | 结果 |
|---|---|---|
| `generateImage` | 提示词、张数、档位、画幅、该路由已接受过的厂商尺寸 | 解码后的图片与内容类型，以及厂商最终接受的尺寸 |
| `submitVideo` | 提示词、时长、档位、画幅、参考图或数字人输入 | 待轮询的任务 id，或已完成的成片 |
| `pollVideo` | 任务 id 与下单模型 | `pending`、`completed`（带成片）或 `failed`（带厂商原因） |

数字人请求携带参考图、可选参考音频，以及最多一条参考视频（`MediaTalkingHead.videos`）：时长 2–12 秒、小于 50 MB；能否使用参考视频取决于厂商模型。

厂商以非 2xx 应答、完全没有应答、或 2xx 但没有可用结果，分别报成 `MEDIA_VENDOR_REJECTED`（带状态码）、`MEDIA_VENDOR_UNREACHABLE`、`MEDIA_VENDOR_NO_RESULT`。重试、预算与调度仍归调用方；这条能力缝只负责厂商那一次往返。

每次调用在落定后还会在 `media/observation` 上报一条 `MediaObservation`——成功或失败都报，带输入规模、产出规模、能力面自己量的耗时与失败分类。订阅它就能把媒体调用记进自己的账本；能力面只负责报，记什么由部署自己决定。观察者抛错不会改变调用的结果。

分类这些失败一律用 `isMediaError()`，不要用 `instanceof`：一个进程里可能同时存在这个包的两份物理副本（包管理器按依赖方的 peer 集合各注入一份），提供方那份抛出的错误不是调用方 import 的那个类的实例——`instanceof` 会让全部分类静默降级，连重试判断也一起失效（DEF-169）。

<a id="understand-the-implementation"></a>
## 实现说明

`MediaRuntime` 持有一张按 id 索引的提供方注册表。选择发生在调用时，且从不依赖注册顺序：配了 id 就必须已注册且可用；没配 id 时要求恰好一个可用提供方——零个或多个分别是 `MEDIA_PROVIDER_UNAVAILABLE` 与 `MEDIA_PROVIDER_AMBIGUOUS`。重复注册以 `MEDIA_PROVIDER_DUPLICATE` 拒绝，且每次注册都是 effect：贡献它的 fiber 释放时一并撤销。

定义只拥有词汇与选择策略。端点、凭据、线上方言与产物下载属于提供方包，因此换厂商不需要改任何调用方。

<a id="further-exploration"></a>
## 延伸阅读

- [架构总览](../../../docs/architecture.zh.md) —— 能力缝在组合里的位置。
- [@deepseek-ai/dsh-media-pi-ai](../media-pi-ai/README.zh.md) —— 官方随包的 OpenAI 兼容提供方。
- [@deepseek-ai/dsh-web](../../web/web/README.zh.md) —— 采用同一套注册表与选择策略的能力缝。

-----

<a id="model-experience"></a>
## 模型可见效果

没有：本包不贡献任何提示词、工具 schema 或请求字段；把生成的媒体渲染出来或写进提示词的是消费方，模型可见效果归它。

#### KV Cache 影响

不直接造成失效；本包从不贡献请求前缀内容。

## 已知限制与未做

<a id="known-limitations-and-deferred-work"></a>

- **没有进度与用量面** —— 厂商应答即返回；没有排队位置的事件流，也没有 token、积分或字节记账。需要成本事实的调用方读自己的记录。
- **产物整块送达** —— 图片与视频字节会先在内存里汇聚再交给调用方，所以这条缝面向厂商交付的短片，而不是几十 GB 的渲染。
- **没有流式或分片交付** —— 每个操作都是请求/应答；只提供 webhook 或推送通道的厂商需要由提供方轮询或适配。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
