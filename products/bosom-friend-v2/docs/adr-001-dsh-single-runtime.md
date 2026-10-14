# ADR-001: DSH 作为唯一应用运行时

Status: Accepted

## Decision

从 0.2.0 开始，Bosom Friend 不再维护一个独立的产品后端作为业务主链路。
DSH 是唯一应用运行时，所有业务域都作为 DSH 插件/服务运行在 DSH 上。

产品前端是 DSH 的显示层；Electron 桌面壳是 DSH 宿主；Agent、UI、REST 网关
都调用同一套 DSH 能力层。

## Boundaries

```text
BosomFriend.exe
  |
  +-- DSH runtime (only runtime)
        |
        +-- core: agent-loop / session / llm / tools / events
        |
        +-- product domain plugins:
        |     auth / accounts / content / media / publish /
        |     data / reception / platform-integration
        |
        +-- webServer / IPC gateway
              |
              +-- self-developed frontend
```

## Consequences

1. No standalone product backend process as the source of truth.
2. Every user operation enters a DSH capability first.
3. AI-facing actions map to DSH tools; non-AI UI actions use the same DSH capability through
   the UI/REST gateway. Both paths execute on DSH.
4. Product state is owned by DSH storage providers. There is no second business JSON service.
5. Sidecars such as Node/Python/Chrome engines are started and stopped by a DSH host plugin.
6. `bosom-friend-harness`, direct `fetch('/chat/completions')` business paths, and the old
   standalone REST backend are legacy. They are removed after migration, never kept as a
   second runtime.

## Migration rule

Each business route is migrated by replacing its implementation with a DSH domain service,
not by wrapping it with a second backend. A feature is accepted only when its UI, agent tool,
and REST gateway call the same DSH implementation.
