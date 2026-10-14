# 最小复现：tsdown workspace 模式把「仓库根」当构建目标

> 已提交上游（该仓库关闭了 issue，反馈走 Discussions）：https://github.com/deepseek-ai/deepseek-harness/discussions/6730
> 提交时间 2026-09-15，账号 Bill-H9986。

上游：`tsdown@0.22.2`。现象：在 workspace 模式（根 `tsdown.config.ts` 里配置了 `workspace` 与 `entry`）下，
配置解析阶段就会对**仓库根包**执行入口解析，根包没有 `src/`、也没有那三个产物文件，于是整轮构建在开始前 abort。

本仓库（DeepSeek Harness 0.1.5-rc.2）的报错：

```text
ERROR  Error: [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
    at resolveEntry (…/tsdown/dist/options-DWGUHu4D.mjs:83:34)
    at async resolveUserConfig (…:740:40)
    at async Promise.all (index 25)
    at resolveConfig (…/build-BxT2lm9L.mjs:95:19)
```

## 一键复现

需要 Node 22+ 与 pnpm 11：

```sh
sh reproduce.sh
```

脚本会造出下面这棵小工程、装 tsdown、跑 `tsdown`，并打印退出码：

```text
package.json                 { "name": "@repro/root", "private": true, "type": "module" }
pnpm-workspace.yaml          packages: packages/*/* 与 apps/*
tsdown.config.ts             workspace: ['packages/*/*', 'apps/*'] + entry: ['lib/types/{index,invariant,startup}.js']
packages/util/thing/         @repro/thing（有 src/index.ts，lib/types/index.js 由脚本预置）
apps/web/                    @repro/web-frontend（Vite 型前端包，没有 lib/types 入口）
```

## 观察到的行为

| 场景 | 结果 |
| --- | --- |
| 被扫到的每个包都有 `lib/types/index.js` | 通过（`✔ Build complete`）|
| 任一被扫到的包缺该入口（例如 `apps/web`）| `Error: [<该包名>] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]` |
| 用 `workspace: { include: [...] }` 把缺入口的包排除 | 失败点转移到**根包**：`[@repro/root] Cannot find entry`（根包没有 `src/`，不可能产出该文件）|
| 根配置在 host 面返回 `[]` | `No input files, try "tsdown <your-file>" or create src/index.ts` |
| 根配置在 host 面返回 `{ entry: '' }` | 同上（`No input files`）|

## 根因位置（0.22.2）

`dist/build-BxT2lm9L.mjs`：

```js
95: const configs = (await Promise.all(rootConfigs.map(async (rootConfig) => {
96:   const { configs: workspaceConfigs, deps: workspaceDeps } = await resolveWorkspace(rootConfig, inlineConfig, rootDeps);
98:   const configs = (await Promise.all(workspaceConfigs.filter((config) => !config.workspace || config.entry)
      .map((config) => resolveUserConfig(config, inlineConfig, workspaceDeps)))).flat()…
```

第 98 行的过滤器 `!config.workspace || config.entry`：当根配置**同时**带有 `workspace` 与 `entry` 时，
它自己也会通过过滤并被 `resolveUserConfig` 解析（`options-DWGUHu4D.mjs:740` → `resolveEntry` 第 83 行抛错）。
把 `entry` 设为空串只会让它被过滤器剔除，随后落到 `resolveEntry` 的默认分支
（`No input files…`）——所以两种写法都失败。

## 期望

根配置是 workspace 的**声明**，不是构建目标：workspace 展开后不应对"suite 根配置自身"做入口解析；
或者应提供明确跳过它的方式（类似 `packages/client/tsdown.client.ts` 用 `{ entry: '' }` 跳过客户端包的做法，
对根配置同样生效）。
