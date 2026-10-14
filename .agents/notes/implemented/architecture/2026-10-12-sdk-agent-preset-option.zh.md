# Agent Note: SDK server agent preset composition

Status: implemented

## Problem

stdio JSON-RPC 服务端在创建每个会话时只传 `meta: { cwd }`、不传 `setup`，于是每个会话都从全局插件层读面向模型的那些行。随产品交付 preset 名册的部署因此无法 join 任何 preset：组装必须由 agent 工厂的 `setup(agentCtx)` 钩子调 `agentPresets.mount(agentCtx, id)`——那是唯一一个 agent 尚未发布的调用点，组装被拒时整次创建回滚。本服务端没有这个 join 点，部署的 preset（人设、技能、工具面）就永远到不了会话；服务端自己的注释也承认了这一点（"No preset composition"）。

## Decision

`HarnessSdkJsonRpcServerOptions.agentPreset?: string` 承载 preset id，`JsonRpcConfig.agentPreset`（schema string）把它暴露给 cordis 部署。设置后 `createSession` 会经 `ctx.get` 取可选的 `agentPresets` 服务；**配置了 preset 却没挂名册时直接报错**（`agent-presets service is not loaded`），然后把 `meta.agentPreset` 与 `setup: (agentCtx) => presets.mount(agentCtx, presetId)` 一起交给 `agents.create`。

服务经本地结构化接口 `AgentPresetComposer`（`mount(agentCtx, id)`）命名：服务端只声明一个方法，不为一个方法名引入 agent-presets 包依赖，没装 preset 的部署也照样能启动。`agentPreset` 未设置时会话创建与以前完全一致——没有 `setup`、没有 `meta.agentPreset`。

## Alternatives considered

**在 wire 协议上（`initialize`/`session/prompt`）加 preset 参数。** 否决：preset 是部署级组装，在任何会话存在之前就已确定；每轮可变的字段会诱导人们给"已经产出过东西"的会话换 preset，而 agent-presets 明确禁止（组合在会话生命周期内固定）。

**import `@deepseek-ai/dsh-agent-presets` 拿它的服务类型。** 否决：为一个方法名付出一份包依赖、锁文件与 hygiene 变更；`ctx.get` 本就把服务当可选项，而真正做组装的部署自己会挂那个插件。

**在 SDK server 之外组装 agent。** 否决：这些会话只有本服务端创建，外部组装者得把会话创建、持久化接线与关停整套重写一遍。

## Consequences

配置了 `agentPreset` 的部署从此从 preset 目录拿到人设、技能与工具面；挂不上的 preset 会在创建会话时就失败，而不是悄悄跑一个只组装了一半的 agent。启用该字段的部署必须挂 agent-presets 插件——失败是刻意做成响亮的。未配置 preset 的会话行为不变，没有名册的 SDK 部署保持原样。

升级代价：三处触点（`HarnessSdkJsonRpcServerOptions`、`createSession`、`JsonRpcConfig`/`Config`）在重新 vendoring 或 rebase `sdk/server` 时要重新应用。

## Testing

`tests/agent-preset.spec.ts` 以 keyless 方式锁住三个分支：未配置 preset → 没有 `setup`、没有 `meta.agentPreset`；配置了但没有服务 → 创建被拒；配置了且有 composer → `setup` 恰好调一次 `mount(agentCtx, id)`。
