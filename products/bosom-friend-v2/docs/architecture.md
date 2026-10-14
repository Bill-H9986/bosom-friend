# Bosom Friend 0.2.0 Desktop Architecture

## Goal

The product is a Windows desktop application. It is not a website served by a remote server.
The rendering technology may be Chromium inside Electron, but the product boundary is a
native desktop executable and an owned local runtime.

## Runtime boundary

DSH is the only application runtime. The product frontend is a display layer, not a
separate application backend. See ADR-001.

```text
BosomFriend.exe
  |
  +-- Electron shell (window, preload, native host)
  |
  +-- DSH runtime
        |
        +-- core agent/session/llm/tool/event services
        +-- product domain plugins
        +-- webServer/IPC gateway
        +-- managed sidecars (node/python/chrome)
        |
        +-- self-developed renderer UI
```

The Electron main process owns the desktop window and native lifecycle. It starts the DSH
runtime as the product's single business owner. No BAT, VBS, browser tab, or secondary
product backend is part of the product path.

## Hard rules

1. `contextIsolation: true`, `nodeIntegration: false`, renderer sandbox enabled.
2. Use `preload` and explicit IPC channels. Never render raw Node or `child_process`.
3. Never scan processes by name and kill them. Track exact child PIDs and stop only owned trees.
4. Never use `--no-sandbox` in production.
5. Never call `shell.openExternal` or `start http://...` for the product UI.
6. All business domains are DSH plugins; UI, Agent, and REST gateway call the same DSH
   capability layer.
7. Product state is owned by DSH storage providers with schema versioning and atomic writes.
8. Destructive operations return the number of rows actually changed.
9. Every user-visible mutation is re-verified after refresh in acceptance tests.

## Storage model

DSH session logs own AI conversation state. Product domains own their entity stores through
DSH storage providers. When one business aggregate spans accounts, materials, drafts, and
tasks, deletion must be one transaction or one explicit cascade operation. Partial deletion
is a bug.

## Legacy isolation

The old `products/bosom-friend` tree is frozen as reference. New code may import behavior
specifications but must not silently copy old lifecycle, installer, or storage assumptions.
