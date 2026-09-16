# Bosom Friend Desktop 0.2.0（已冻结，只读参考）

> 2026-09-03 起本目录冻结：桌面壳、进程管理、原子存储已并入唯一主线
> `products/bosom-friend`（见仓库根《0.2.0统一开发方案与路线图.md》）。
> 本目录仅作历史参考，不再继续开发，避免双线并行。

## Product contract

1. One executable: `BosomFriend.exe`, installed into the current user's application directory.
2. One startup path: the Windows desktop/start menu shortcut launches the Electron desktop EXE.
3. No external browser is opened for the product UI.
4. Closing the desktop window ends the application and all owned sidecar processes.
5. User data and logs live outside the installation directory.
6. Every business mutation is durable, testable after a page refresh, and auditable.

## Development entry points

- Architecture: `docs/architecture.md`
- DSH boundary decision: `docs/adr-001-dsh-single-runtime.md`
- DSH migration plan: `docs/migration-to-dsh.md`
- DSH domain contracts: `docs/domain-contracts.md`
- Engineering standard: `docs/development-standard.md`
- Release process: `docs/release-process.md`
- Acceptance standard: `docs/acceptance-standard.md`
- Desktop shell: `apps/desktop`
- Atomic storage utilities: `packages/storage`
- Owned process lifecycle utilities: `packages/lifecycle`
- End-to-end desktop acceptance: `qa/desktop-e2e`

## Status

0.2.0 is currently in Phase 0: project foundation. The shell code below is the canonical
desktop lifecycle reference and must remain free of browser-launching and process-name-wide
kill logic.
