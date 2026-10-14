---
description: "媒体包族的包映射：厂商媒体生成服务、ctx.media 背后的提供方注册表，以及官方随包的 OpenAI 兼容提供方。"
kind: "package-group"
---

# 媒体包族

[English](README.md) | 中文

## 概述

厂商媒体生成——图片与视频任务——收在同一条能力缝后面。服务定义拥有请求词汇与提供方选择；提供方拥有端点、凭据与线上方言。把服务与一个提供方一起挂载，就能经 `ctx.media` 出图、下单并轮询视频。

## 目录

- [包](#packages)
- [它在哪一层](#where-it-fits)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 |
|---|---|
| [`media/`](media/README.zh.md) | Service Definition：`ctx.media`、请求/结果词汇、提供方注册表与 `MediaError` 分类 |
| [`media-pi-ai/`](media-pi-ai/README.zh.md) | Service Provider：官方随包的 OpenAI 兼容实现，也是媒体厂商 HTTP 唯一出现的地方 |

-----

<a id="where-it-fits"></a>
## 它在哪一层

调用方一律经 `ctx.media` 到达媒体生成，从不直接碰厂商端点。接一家新厂商＝在这里加一个提供方包，而不是在应用里开一条新的调用路径。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
