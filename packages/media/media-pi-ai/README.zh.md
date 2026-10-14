---
description: "官方随包的 OpenAI 兼容媒体提供方：配置厂商路由、经凭据能力缝解析密钥，并在 ctx.media 背后讲图片与视频两种线上方言。"
kind: "package-reference"
---

# @deepseek-ai/dsh-media-pi-ai

[English](README.md) | 中文

## 概述

组合需要从 OpenAI 兼容厂商拿图片或视频时挂 `dsh-media-pi-ai`。它把唯一一份实现注册进 `ctx.media`，解析每个请求的路由与凭据，并且是**媒体厂商 HTTP 唯一出现的地方**。路由来自插件配置与 `media-pi-ai` 用户设置段，所以改端点或改密钥下一次调用就生效，不需要重启。

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

先挂媒体能力缝，再挂这个提供方：

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
      local:
        displayName: Local server
        baseURL: http://127.0.0.1:8000/v1
```

每条路由声明基址、可选的凭据 ref 与线上方言。调用方随后在请求里指名路由 id 与厂商模型。没有 `apiKeyEnv` 的路由不带鉴权头调用——本机服务需要的正是这种。

### 配置

| 字段 | 含义 |
|---|---|
| `providers` | 按 id 索引的路由；请求的 `provider` 字段选一条，未知 id 报 `MEDIA_ROUTE_UNKNOWN`。 |
| `displayName` | 配置界面用的名字；缺省用路由 id。 |
| `baseURL` | 厂商基址，带不带版本号都行。 |
| `apiKeyEnv` | 经凭据能力缝解析的引用名，或环境变量名。 |
| `api` | 线上方言：`openai`（默认）或 `agnes`。 |

没有任何路由时提供方如实报"不可用"，所以裸挂载是休眠而不是在厂商里失败。

<a id="understand-the-implementation"></a>
## 实现说明

`openai` 讲 OpenAI 兼容的字段名（`size`、`resolution`、`aspect_ratio`），走 `/videos/generations` 与 `/videos/<id>`，直接收发 JSON。`agnes` 讲 Agnes AI 的契约：图片用档位与画幅，视频的 `seconds` 是 `4`..`12` 的字符串、带 `mode` 选择的参考块，状态读 origin 上的 `/agnesapi`。厂商以"我可接受的尺寸"拒收时，按它自报的最接近档位重下**一次**。

厂商应答在离开本包之前已被归一：图片或视频的 URL 在这里下载、base64 在这里解码，非 2xx、无应答或没有可用结果都变成对应的 `MediaError` 码并带上厂商状态码。重试、预算与调度留在调用方。

<a id="further-exploration"></a>
## 延伸阅读

- [@deepseek-ai/dsh-media](../media/README.zh.md) —— 本提供方实现的服务。
- [@deepseek-ai/dsh-llm-pi-ai](../../llm/llm-pi-ai/README.zh.md) —— 模型侧那个读同一套设置与凭据能力缝的提供方。

-----

<a id="model-experience"></a>
## 模型可见效果

没有：本包为调用方产出媒体，不注册任何提示词、工具 schema 或请求字段。

#### KV Cache 影响

不直接造成失效；本包从不贡献请求前缀内容。

## 已知限制与未做

<a id="known-limitations-and-deferred-work"></a>

- **没有请求日志与用量记账** —— 调用不留痕、不产积分或字节合计；需要回放的部署在消费方记录。
- **每条路由只有一对线上方言** —— 同一厂商按模型变形状（而不是按部署变）的情况今天表达不出来。
- **没有 webhook 或推送入口** —— 异步厂商由调用方经 `ctx.media.pollVideo()` 轮询，没有回调端点。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
