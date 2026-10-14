# Agent Note: SDK server agent preset composition

Status: implemented

## Problem

The stdio JSON-RPC server created every session with `meta: { cwd }` and no `setup`, so each session read its model-facing rows from the global plugin layer. A deployment that ships a preset roster could not join one: composition happens through `agentPresets.mount(agentCtx, id)` called from the agent factory's `setup(agentCtx)` hook — the only call site where the agent is still unpublished, so a rejected composition rolls the whole creation back. With no join point in this server, a deployment's presets (persona, skills, tool surface) never reached its sessions, and the server's own comment said so ("No preset composition").

## Decision

`HarnessSdkJsonRpcServerOptions.agentPreset?: string` carries the preset id, and `JsonRpcConfig.agentPreset` (schema string) exposes it to a cordis deployment. When it is set, `createSession` resolves the optional `agentPresets` service through `ctx.get`, fails loud (`agent-presets service is not loaded`) when the deployment configured a preset but loaded no roster, and then passes both `meta.agentPreset` and `setup: (agentCtx) => presets.mount(agentCtx, presetId)` to `agents.create`.

The service is named through the local structural interface `AgentPresetComposer` (`mount(agentCtx, id)`): the server names one method instead of taking a package dependency on agent-presets, and a deployment that loads no presets still boots. When `agentPreset` is unset the session is created exactly as before — no `setup`, no `meta.agentPreset`.

## Alternatives considered

**Add a preset field to the wire protocol (`initialize`/`session/prompt`).** Rejected: the preset is a deployment-level composition decided before any session exists, and a per-prompt field would invite switching the preset of a session that already produced something, which agent-presets forbids (a composition is fixed for the session's life).

**Import `@deepseek-ai/dsh-agent-presets` for its service types.** Rejected: a package dependency, lockfile and hygiene churn for one method name; `ctx.get` already treats services as optional, and the deployment that composes presets is the one that loads the plugin.

**Compose agents outside the SDK server.** Rejected: this server is the only place that creates these sessions, so an external composer would have to reimplement session creation, persistence wiring, and shutdown.

## Consequences

A deployment that configures `agentPreset` gets persona, skills, and tool surface from its preset directory; a preset that cannot be mounted now fails session creation instead of silently running a half-composed agent. Deployments that configure the field must load the agent-presets plugin — the failure is loud by design. Sessions with no configured preset are unchanged, so an SDK deployment with no roster keeps its previous behavior.

Upgrade cost: three touch points (`HarnessSdkJsonRpcServerOptions`, `createSession`, `JsonRpcConfig`/`Config`) must be reapplied when re-vendoring or rebasing `sdk/server`.

## Testing

`tests/agent-preset.spec.ts` pins all three branches keyless: no preset configured → no `setup` and no `meta.agentPreset`; preset configured with no service → creation rejects; preset configured with a composer → `setup` calls `mount(agentCtx, id)` once.
