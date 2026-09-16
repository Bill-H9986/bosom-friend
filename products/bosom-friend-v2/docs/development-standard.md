# Development Standard

## 1. Version and branch policy

- Product version starts at `0.2.0`.
- Semantic versioning: `MAJOR.MINOR.PATCH`.
- Feature work happens on `feat/*`, bug work on `fix/*`, infrastructure work on `chore/*`.
- Never promote an unreviewed artifact.

## 2. Component boundaries

- `apps/desktop`: Electron host, preload, renderer assets, packaging configuration.
- `packages/domains/*`: DSH business domain services and tools.
- `packages/storage`: DSH-backed durable data contract, atomic writes, migrations, integrity checks.
- `packages/lifecycle`: child-process registry and graceful shutdown.
- `qa/desktop-e2e`: real desktop user paths.
- `scripts`: reproducible gates.

No component may reach into another component's implementation. A standalone product backend
is not allowed as the main business runtime.

## 3. Lifecycle contract

1. `app.requestSingleInstanceLock()` is called before windows are created.
2. A second instance focuses the existing window.
3. Closing the last window on Windows asks the user, then requests a graceful product stop.
4. `before-quit` waits for owned sidecars with a bounded timeout.
5. Only after timeout are exact tracked PIDs terminated.
6. `window-all-closed` never hides the app silently; the tray is an explicit facility.

## 4. DSH runtime contract

- DSH is the only runtime that owns product business execution.
- Every domain exposes a service definition and, where AI can invoke it, a tool mapping.
- UI and REST gateway call the same DSH domain service as the Agent.
- Legacy `bosom-friend-harness` and direct model calls are not part of the main path.

## 5. Data contract

- Every persisted file contains `schemaVersion`.
- Writes are atomic: temporary file, fsync, rename.
- Reads validate the schema and fail loud on incompatible data.
- Mutations return `{ changed, removed }` and never lie.
- Deletion of one aggregate removes or explicitly refuses all dependent records.

## 6. Security contract

- Local renderer only.
- No Node integration.
- Context isolation enabled.
- Renderer sandbox enabled.
- Content Security Policy present.
- No `shell.openExternal` for internal navigation.
- No wide PowerShell process enumeration.
- Secrets stored in user data with restricted ACL, never in logs.

## 7. Testing contract

Tests are not green from `code=0` alone. A user mutation is accepted only if:

1. The page action starts the request.
2. The backend writes the expected aggregate(s).
3. The page shows the new state.
4. A page refresh shows the same state.
5. The operation changes are observable without reading product internals.

## 8. Definition of done

- Type checks, unit tests, desktop E2E, release gate pass.
- No external browser in the launch path.
- No process leftovers after close.
- Installation and uninstall do not require administrator rights.
- Release artifact SHA256 and logs are recorded.
