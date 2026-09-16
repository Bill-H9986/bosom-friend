# tsdown workspace mode resolves the suite root config as a build target and aborts the whole run

**tsdown version:** 0.22.2 (rolldown 1.1.1)
**Node:** v24.19.0 (also reproduced on v24.18.0)
**OS:** Linux (docker `node:24-bookworm-slim`) **and** Windows 11 — byte-identical failure on both
**Package manager:** pnpm 11.7.0

## Summary

With a root `tsdown.config.ts` that declares `workspace` **and** `entry`, the workspace run aborts during config
resolution — before any package builds — with:

```text
ERROR  Error: [@scope/root-package] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
    at resolveEntry (tsdown/dist/options-*.mjs:83:34)
    at async resolveUserConfig (…:740:40)
    at async Promise.all (index 25)
    at resolveConfig (tsdown/dist/build-*.mjs:95:19)
```

The label is the **root package**, and the entry is the **root config's own `entry` template** — i.e. the suite root
config itself is being resolved as if it were a build target. A repository root is a declaration, not a package with
`lib/types/index.js`, so this can never succeed.

## Minimal reproduction

```sh
sh reproduce.sh        # creates ./tsdown-ws-repro, installs tsdown@0.22.2, runs three variants
```

The generated project is the smallest shape that carries the same structure:

```text
package.json                 { "name": "@repro/root", "private": true, "type": "module" }
pnpm-workspace.yaml          packages/*/*  +  apps/*
tsdown.config.ts             workspace: ['packages/*/*', 'apps/*']
                             entry: ['lib/types/{index,invariant,startup}.js']
packages/util/thing/         @repro/thing — has src/index.ts, and lib/types/index.js is pre-created
apps/web/                    @repro/web-frontend — a Vite-style app with no lib/types entry
```

## Observed

| Variant | Result |
| --- | --- |
| **A** — every discovered package has `lib/types/index.js` | ✅ `✔ Build complete` for both packages |
| **B** — `apps/web` lacks that entry (the real-world case) | ❌ `Error: [@repro/web-frontend] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]` |
| **C** — `workspace: { include: ['packages/*/*'] }` (exclude the package that lacks entries) | ❌ failure moves to the **root**: `[@repro/root] Cannot find entry` |
| **D** — root config returns `[]` for the host face | ❌ `Error: undefined No input files, try "tsdown <your-file>" or create src/index.ts` |
| **E** — root config returns `{ entry: '' }` (the `SKIP_WORKSPACE_BUILD` shape used by `packages/client/tsdown.client.ts`) | ❌ `No input files` (the empty entry fails the filter below, so the default branch runs) |

## Root cause pointer

`dist/build-*.mjs`:

```js
95: const configs = (await Promise.all(rootConfigs.map(async (rootConfig) => {
96:   const { configs: workspaceConfigs, deps: workspaceDeps } = await resolveWorkspace(rootConfig, inlineConfig, rootDeps);
98:   const configs = (await Promise.all(workspaceConfigs.filter((config) => !config.workspace || config.entry)
        .map((config) => resolveUserConfig(config, inlineConfig, workspaceDeps)))).flat()…
```

Line 98's filter keeps a config when `!config.workspace || config.entry`. The suite root config satisfies
`config.entry` (it is the template string), so it passes the filter and is handed to `resolveUserConfig`, which
resolves `entry` against the root `cwd` and throws at `resolveEntry` (line 83). Setting the root `entry` to an
empty string makes `config.entry` falsy, so the filter drops it — and the run then fails one branch later with
`No input files`, because `resolveEntry` falls back to `<cwd>/src/index.ts`, which a suite root does not have.

## Expected

The suite root config should not be resolved as a build target. Either exclude it explicitly during workspace
expansion, or make the existing "skip this package" convention work for it (client-only packages are skipped today
via a config whose `entry` is empty — the docs in `packages/client/tsdown.client.ts` describe the intent as
"Workspace mode replaces an empty config array with the root defaults. A falsey entry instead removes this package
before entry resolution.").

## Real-world impact

`deepseek-harness` (private fork) at tag `dsh-v0.1.5-rc.2`:

- `pnpm run build:lib:host` = `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host`
- `tsc -b` passes with 0 errors; `tsdown --env.DSH_BUILD_FACE host` fails exactly as above, leaving 81 packages in
  the bundle closure without `lib/` artifacts, so the downstream `pnpm deploy` cannot materialize the runtime.

Workaround in the fork today: none that we could find from the config surface (seven variants tried, A–E above plus
patching the discovery list and moving the config out of the root). A patch to `resolveConfig`/line 98 that skips the
root suite config works around it.
