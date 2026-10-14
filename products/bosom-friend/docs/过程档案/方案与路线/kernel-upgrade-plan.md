# DSH 内核升级执行方案：dsh-v0.1.1-rc.2 → dsh-v0.1.5-rc.2

- 仓库根：`C:\Users\Jay\Desktop\Bosom friend APP`
- 当前分支：`fix/ai-autopublish`，HEAD = `3cf1ac0c1171e2919cb734fedf29469d5741ef2c`
- 基线 tag：`dsh-v0.1.1-rc.2`（`b150a551` = Merge PR #2908 from release/dsh-0.1.1-rc.2，本地唯一 tag）
- 目标 tag：`dsh-v0.1.5-rc.2`（`fb2c4b9e698e30edb738bca4cf0618587db7d203`）
- 本文由只读调研产出：未修改任何既有文件，唯一的写入是本文件。
- 证据分级：**【实测】**= 本次在本机跑出的命令输出 / 读到的文件内容；**【推断】**= 由实测数据推理；**【待核实】**= 本次拿不到证据，附确切命令。

---

# 执行记录（2026-09-15）：升级落地与 tsdown 卡点

> 本节由执行过程追加，记录"基座替换已完成、构建被 tsdown 挡住"的确切位置与取证。
> 与上文（只读调研）的区别：本节全部是**实测**，命令与输出都可复现。

## 1. 已完成（提交见 git log）

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 上游 tag 入本地 | `dsh-v0.1.5-rc.2`（`fb2c4b9e`）| `git cat-file -t` = commit |
| 基座整体替换 | 提交 `b6b53b82`（双父：本地 HEAD + 上游 tag）| `package.json` = 0.1.5-rc.2；新增 benchmarks/、snapshots/、packages/{webhook,storage,session-format*} |
| 被上游取代的旧目录清理 | 2745 个文件（`examples/{acp,headless,jsonrpc}-agent`、`packages/examples`、旧 `apps/web` 文件、`.agents/notes` 旧归档）| 同上提交 |
| 依赖树安装 | `pnpm install` 绿（1482 包 / 3m35s）| 提交 `f7faa1f4`；`.npmrc` + pnpm 全局 `fetchTimeout: 600000`（pnpm 11 的超时不读 .npmrc）|
| TypeScript 两个面 | `error TS` = **0** | `tsc -b tsconfig.host.json` / `tsconfig.client.json` 均通过 |
| 工作区决策纠错 | `apps/*` 回归、shim 改名退出解析 | 提交 `4a8dcc8d`（上游 `bundle/web-app` 与 `apps/desktop-host` 按包名依赖 `@deepseek-ai/dsh-web-frontend`）|

## 2. 卡点：`tsdown` workspace 模式把仓库根当成构建目标

**现象**（`pnpm run build:lib:host` 的第二步，`npx tsdown --env.DSH_BUILD_FACE host`）：

```text
ERROR  Error: [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
    at resolveUserConfig … options-DWGUHu4D.mjs:740
    at … build-BxT2lm9L.mjs:98 (Promise.all index 24)
```

**根因（读 tsdown 0.22.2 源码得出）**：`build-BxT2lm9L.mjs:48-86` 的 `resolveWorkspace` 用
`glob('**/package.json')` 在**整个仓库**发现包目录，然后对每个目录 `loadConfigFile(...)` 并
`mergeConfig(normalized, config)`——也就是把**根配置的 `entry`** 施加到每个包上；第 95-101 行再对结果
调用 `resolveUserConfig`（第 740 行 `resolveEntry`）。仓库根与被扫到的非基座包都拿不到这三个入口文件，
于是整个 workspace 运行在**构建开始之前**就 abort。

**已排除的可能（都做过反证）**：
1. 不是 glob 语法/Windows 路径问题——用 tsdown 自带的 tinyglobby@0.2.17 在本机跑
   `lib/types/{index,invariant,startup}.js` → 命中 3 个文件；
2. 不是"文件不存在"——在仓库根**真的建了**这三个文件，仍报同一错误（入口的解析发生在 workspace 展开期，
   走的不是根目录）；
3. 不是"删掉根配置就行"——移开 `tsdown.config.ts` 后变成 `No input files`（根配置还负责注入
   `typertPlugin`，必须保留）。

**取到的关键事实（对上游复现至关重要）**：
- 0.1.1 与 0.1.5 的根 `tsdown.config.ts` 在 `entry`/`workspace`/`plugins` 上**逐字相同**；
- 0.1.1 的 `apps/web` 也**没有** `lib/types` 入口，所以上游 CI 若真跑这条命令，理应有同样问题；
- 唯一的环境差异是上游 CI 在 Linux 跑、本机是 Windows（仓库路径还带空格 `Bosom friend APP`）。

**已试过的两条修法（都未通过）**：
1. 用 `workspace: { include: [...] }` 把发现范围收窄到基座树（`vendor/*`、`packages/*/*`、`apps/cli`）——
   错误标签会随 include 内容在 `dsh-root` 与具体包名之间漂移，但始终存在一条；
2. 把根配置搬进根 `package.json` 的 `tsdown` 字段（让 `loadConfigFile` 在根目录找不到配置文件）——
   根标签消失，但随后的失败变成 `[@deepseek-ai/dsh-web-frontend] Cannot find entry`（apps/web 本来就无此入口）。

**结论**：这是 tsdown workspace 展开与上游配置的相互作用，**不是产品层改动引入的**；在 Windows 上需要
上游修（或本地对 tsdown 打补丁/替代入口方案）。当前 `tsdown.config.ts` 里保留了一条**未验证通过**的
`workspace.include` 收窄（它确实能阻止 `products/` 混入基座构建，但尚未让构建转绿）——下次接手时应先决定
是保留、继续迭代，还是回退成上游原样。

## 3. 后续步骤（未开始）

1. 定下 tsdown 方案后跑通 `pnpm run build:lib:host`（判据：退出 0 且 `packages/bundle/web-app/lib/types/index.js`、
   `packages/api/*/lib/typert.host.js` 在位；当前闭包内 **81 个包**仍缺 `lib/index.js`）；
2. 产品四包编译（`dsh-bosom-friend-{kernel,server}`、launcher、bundle）；
3. **`pnpm deploy` 重新物化内核运行时**（不能只同步 lib，DEF-052 的成因）；
4. 重打 `kernel-runtime.zip` → 出包 → 装机实测（含老会话 `SESSION_FORMAT_VERSION` 0→3 迁移）。

---

### 执行记录补记（同日）：对 tsdown 打补丁的方案已试过并回退

按"给 tsdown 打小补丁跳过非构建目标"的思路实际动过手，结论是**此路不通**，细节如下（避免下次重复投入）：

| 尝试 | 结果 |
| --- | --- |
| 在 `resolveWorkspace` 里把"仓库根"从发现到的包目录中剔除 | 无效——报错标签始终是 `[@deepseek-ai/dsh-root]`，而根目录**在**发现结果里；说明解析发生在配置合并之后的 `resolveUserConfig`，与包目录列表无关 |
| 把第 98 行的 `.filter((config) => !config.workspace || config.entry)` 收紧为 `&&` | 报错从 `Cannot find entry` 变成 `No valid configuration found`（**该过滤器同时承担"保留 workspace 根配置"的职责**，收紧会把整套配置滤掉） |
| 改成"跳过 index 0 的 workspace 根配置" | 仍报同一错误，但**栈行号从 740 漂到 724**——说明根配置在第二处也被解析；同时 87 行 `entry:` 说明大部分包已成功解析，问题集中在根配置这一处 |
| 回退 | 已把 `node_modules/.pnpm/tsdown@.../dist/build-BxT2lm9L.mjs` 还原成上游原样（校验：上游过滤器在位、无 fork 标记），重跑仍得到原始报错，确认环境干净 |

**判断（待上游核实）**：0.1.1 与 0.1.5 的根 `tsdown.config.ts` 在 `entry`/`workspace`/`plugins` 上逐字相同；0.1.1 的 `apps/web` 同样没有 `lib/types` 入口。因此这更像是**上游只在 Linux 上跑这条命令**，Windows 上 workspace 展开与根配置的相互作用暴露了这个缺陷。

**下一步（按成本排序）**：
1. **在 WSL / Linux 容器里跑同一条命令**（判据：`npx tsdown --env.DSH_BUILD_FACE host` 退出 0 且 `packages/bundle/web-app/lib/types/index.js` 在位）——这是最便宜的分辨实验，能直接判定"平台问题"还是"配置问题"；
2. 若 Linux 也失败 → 按 1 的最小复现提上游（一个含 `apps/web` 的 pnpm workspace + 根 tsdown workspace 配置）；
3. 若 Linux 通过 → 升级路径改为"在 Linux 侧产出基座 lib → 拷回 Windows 打包"，或在本机给 `apps/cli` 等无配置包补上各自的最小 `tsdown.config.ts`（让根配置不再作为该包的有效配置参与解析）。

**当前仓库保留的唯一改动**：`tsdown.config.ts` 里把 workspace 收窄为 `{ include: ['vendor/*', 'packages/*/*', 'apps/cli'] }`——它能阻止 `products/` 混进基座构建（真实存在的第二个问题），但**尚未让构建转绿**；若第 3 步采用"补 per-package 配置"的方案，这条收窄应当保留。

### 执行记录补记 2（同日）：平台判别完成 —— **Linux 上完全相同的失败**

在 Docker Desktop 的 Linux 容器里（`node:24-bookworm-slim`，pnpm 11.7.0，同一份源码、同一个 tsdown 0.22.2）跑了
同一条 `tsdown --env.DSH_BUILD_FACE host`，报错与 Windows **逐字相同**：

```text
 ERROR  Error: [@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]
    at resolveEntry (…/tsdown/dist/options-DWGUHu4D.mjs:83:34)
    at async resolveUserConfig (…:740:40)
    at async Promise.all (index 25)
    at resolveConfig (…/build-BxT2lm9L.mjs:95:19)
```

⇒ **不是 Windows 问题，是上游 tsdown 的行为问题**（原先"上游只在 Linux 跑、Windows 才炸"的推断被推翻）。

**根因那一行**（0.22.2 `dist/build-BxT2lm9L.mjs:98`）：

```js
workspaceConfigs.filter((config) => !config.workspace || config.entry)
```

根配置同时带 `workspace` 与 `entry`，于是**它自己也通过过滤**并被 `resolveUserConfig` 解析入口；根包没有 `src/`，
必然抛错。把根 `entry` 设成空串只会让它被这条过滤器剔除，随后落到 `resolveEntry` 的默认分支
（`No input files…`）——两种写法都失败，这也解释了先前"返回 `[]` 或 `{entry:''}` 都无效"的观察。

**容器侧附带确认**：
- 容器里 `pnpm install` 2m48s 成功，但**必须先 `pnpm config set fetchTimeout 900000`**（pnpm 11 不读 `.npmrc` 的超时项，与宿主侧结论一致）；
- 容器里 `tsc -b` 报的 3 个"找不到模块"是探针拷贝不完整所致（未拷 `snapshots/`、`scripts/release/`），真实仓库的 `tsc -b` 是 0 错误。

**产物**：最小复现工程 + 上游 issue 正文落在 `analysis/tsdown-ws-repro/`（`README.md` / `reproduce.sh` /
`ISSUE-tsdown-workspace-root-entry.md`），可直接提交给上游。

### 执行记录补记 3（同日）：产品层第一处真实破坏性变更 —— SDK 客户端改成「dsh profile」契约

跑 `pnpm --filter @deepseek-ai/dsh-bosom-friend-server build` 的结果：

```text
src/kernel-client.ts(110,7): error TS2353: Object literal may only specify known properties,
and 'command' does not exist in type 'HarnessClientOptions'.
```

`@deepseek-ai/dsh-bosom-friend-kernel` 构建通过（exit 0），**server 卡在这一处**。

**0.1.5 的新契约**（`packages/sdk/client/src/types.ts`，实测）：`HarnessClientOptions` 已不含
`command`/`args`/`cwd`，改为：

| 字段 | 含义 |
| --- | --- |
| `dshBin?` | **dsh CLI 模块**路径；省略则用同版本依赖 |
| `profile?` | 提供 SDK 协议的命名 profile（默认 `sdk`） |
| `patches?` | 每次启动叠加的 profile 补丁（相对路径在 spawn 前解析） |
| `dshHome?` | 子进程的 Harness home |
| `processCwd?` | dsh 进程自身的工作目录 |
| `env?` | 完整子进程环境（传对象即整体替换父环境） |

配合上游 0.1.5 的 AGENTS.md 新增条款（"Only `dsh` profiles launch supported Node apps; package bins,
demos, and public SDK argv escapes are forbidden"），方向很清楚：**上游把"自研入口 + 自选 argv 启动运行时"
这条路关掉了**，运行时只能由 `dsh` CLI 按 profile 拉起。

**我们现在的做法（`products/bosom-friend/server/src/kernel-client.ts`，约 7.8KB）**：

```ts
client ??= new HarnessClient({
  command: process.execPath,            // Electron 以 ELECTRON_RUN_AS_NODE 当 Node 用
  args: [entry.bin],                    // products/bosom-friend/launcher/lib/bin-kernel.mjs
  cwd: entry.cwd,
  env: { ...process.env, AGNES_API_KEY: ... },
})
```

即：自研启动入口 + 自选 argv + 用环境变量把用户密钥传进子进程。**这与新契约不兼容**。

**适配所需（真实工作量，非配置项）**：
1. 把产品内核运行时表达成一个 **dsh profile**（或等价的 `--profile` + `patches` 组合），
   让 `dsh CLI` 按 profile 拉起，而不是我们直接 spawn 自己的 bin；
2. BYOK 密钥不能再走"父环境整体替换"这条路（新契约下 `env` 传对象=替换父环境），要改为受支持的凭据通道
   （`dshHome` 下的凭据存储或 profile 配置）；
3. 桌面壳（Electron 当 Node 用）与"应用自带的 Node 运行时"要接到 `dshBin` 上；
4. 改完后仍需过：产品四包编译 → 内核运行时重新物化（`pnpm deploy`）→ 打 zip → 装机实测。

**据此对整件事的重新判断**：内核 0.1.1-rc.2 → 0.1.5-rc.2 不是"换基座 + 重新打包"，而是
**换基座（已完成）+ 修上游 tsdown 构建缺陷（未解决）+ 按 profile 契约重写产品启动链（未开始）**。
后两项都不是一次会话能完成的量级。

### 执行记录补记 4（同日）：**tsdown 卡点已解决** —— 按 pnpm patch 机制固化

**根因（插桩实测，不再靠推断）**：给 tsdown 的 workspace 展开插桩后打印全部 313 个
`workspaceConfigs`，**没有任何一条的 `cwd` 是仓库根**，全部是各包目录；但错误仍报
`[@deepseek-ai/dsh-root] Cannot find entry ["lib/types/{index,invariant,startup}.js"]`
——即"根配置"在这条链路之外被解析。既然无法靠对象属性（`cwd`/`name`/`workspace`）把它挑出来，
补丁改为**按内容识别**：`entry` 恰好是 suite 根模板那一条，直接跳过。

**补丁**（`patches/tsdown@0.22.2.patch`，13 行，pnpm 自动登记进 `pnpm-workspace.yaml` 的
`patchedDependencies`）：

```diff
@@ -95,7 +95,7 @@ async function resolveConfig(inlineConfig) {
-		const configs = (await Promise.all(workspaceConfigs.filter((config) => !config.workspace || config.entry)
+		const configs = (await Promise.all(workspaceConfigs.filter((config) => !(config.workspace && config.entry !== undefined && Array.isArray(config.entry) && config.entry.length === 1 && config.entry[0] === "lib/types/{index,invariant,startup}.js") && (!config.workspace || config.entry))
```

**验收（实测）**：`npx tsdown --env.DSH_BUILD_FACE host` → **exit 0 + `✔ Build complete`**；产物全部生成：
`packages/bundle/web-app/lib/types/index.js`、`packages/api/session-controller/lib/typert.host.js`、
`apps/cli/lib/bin.js`、`packages/session/session-format/lib/index.js`、`packages/storage/storage-json/lib/index.js`
均已在位；仍缺 `lib/types/index.d.ts` 的 54 个包全部是 `packages/client/*`（client face 才产出，符合设计）。

**真话**：补丁是"按内容匹配"的定点补丁，依赖 tsdown 内部那一行字符串；**每次升级 tsdown 都要重做**
（`pnpm patch` 会因上下文不匹配而失败，届时按本文档的方法重新定位）。

### 执行记录补记 5（同日）：补丁稳固后的新进展与**下一轮的唯一动作**

**已验证可用（当前仓库状态）**：
- `patches/tsdown@0.22.2.patch` + `pnpm-workspace.yaml` 的 `patchedDependencies` → `pnpm install` 会产出
  `node_modules/.pnpm/tsdown@0.22.2_patch_hash=…`（补丁在位，实测）；
- `npx tsdown --env.DSH_BUILD_FACE host` → **exit 0**，全包 `✔ Build complete`；
- 清掉 288 个陈旧 `lib/` 后 `pnpm run build` 的 `build:lib`（tsc 两个面 + tsdown 两个 face）**已通过**。

**剩下两处（同一根因：根 entry 的花括号模板）**：
1. `vendor/*` 的九个包**只 emit `lib/types/index.js`**，而根 entry 写的是
   `['lib/types/{index,invariant,startup}.js']`——花括号要求组内**全部**存在，于是这些包**零命中**，
   不产出 `lib/index.js`（而它们的 `package.json` main 正指向它）；
2. 因此 `build:web`（官方 Web UI 的 vite 构建）解析不到 `@deepseek-ai/cordis` 入口而失败。

**下一轮唯一动作**（按此顺序，两步耦合，必须一起改）：
1. 把根 entry 改成同时列出单文件与花括号模板（已验证"只写 index.js"能让 vendor 产出，但会打到
   只 emit `invariant.js` 的包）：
   `entry: client ? '' : ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/startup.js', 'lib/types/{index,invariant,startup}.js']`
2. 同步把补丁的"suite 根识别"改成**不依赖 entry 形状**的版本（现在的条件是内容匹配 + 长度等于 1，
   一改 entry 就失效）：在 `resolveWorkspace` 所在文件里加一个函数级 helper，
   `const __bfSuiteRootEntry = (entry) => Array.isArray(entry) && entry.some((item) => typeof item === 'string' && item.includes('{index,invariant,startup}'))`，
   过滤器写成 `!(config.workspace && __bfSuiteRootEntry(config.entry)) && (!config.workspace || config.entry)`。
   **注意**：`pnpm patch tsdown@0.22.2` 打开的工作区里可能已带上旧补丁，写新补丁前必须先把它归一
   （否则字符串锚点匹配不到）——这一轮就是卡在这里消耗了时间，下一轮直接按"删除 `.pnpm_patches` 目录后重开"来避免。
3. 判据：`vendor/cordis/lib/index.js` 等九个 vendor 包入口在位；`pnpm run build` 退出 0；
   随后接 `pnpm deploy` 重新物化内核运行时 → 打 zip → 出包。

**未受影响**：产品侧启动链适配已完成（`48500c8d`），产品两包构建与两项内核探针此前均已验证通过。

### 执行记录补记 6（同日）：补丁已通用化并生效，剩最后一处（vendor 入口）

**本轮确证**：
- 手写 unified diff（**必须用 Node/UTF-8 写**；PowerShell `*>` 会把 `git diff` 输出写成 UTF-16，
  上一版补丁因此是乱码、pnpm 应用后无效——这是本轮绕远路的原因）：
  `patches/tsdown@0.22.2.patch` 现在在文件级插入 helper
  `const __bfSuiteRootEntry = (entry) => Array.isArray(entry) && entry.some((item) => typeof item === 'string' && item.includes('{index,invariant,startup}'))`，
  过滤器改为 `!(config.workspace && __bfSuiteRootEntry(config.entry)) && (!config.workspace || config.entry)`；
- pnpm 重新应用成功：新目录 `tsdown@0.22.2_patch_hash=28_56dfd0e9d3…`，文件内 helper 在位；
- 根 entry 放宽为 `['lib/types/index.js','lib/types/invariant.js','lib/types/startup.js','lib/types/{index,invariant,startup}.js']`；
- `npx tsdown --env.DSH_BUILD_FACE host` → **exit 0**（放宽 entry 后仍绿）。

**剩下唯一一处**：`vendor/cordis` 等**没有 per-package `tsdown.config.ts`** 的 vendored 包仍不产出
`lib/index.js`（`loader`/`logger-console` 有自己的配置，就产出）。日志显示它们的 `package.json`
被当作配置来源发现，但**没有 dedup 出 `entry:` 行**——即"workspace 模板 entry 对这些包不生效"。
因此 `build:web`（官方 Web UI 的 vite 构建）解析不到 `@deepseek-ai/cordis` 入口而失败。

**下一轮两个可选修法（都小）**：
1. **给需要 `lib/index.js` 的 vendored 包各加一行 `tsdown.config.ts`**（照 `vendor/loader/tsdown.config.ts` 的样子），
   让"自带配置"这条已验证路径覆盖它们——最贴合上游惯例，且不动 tsdown；
2. 或在补丁里对"合并配置来自 package.json 且 entry 模板未命中"的包回退到 `src/index.ts`，再跑一次 tsdown。

判据：`vendor/cordis/lib/index.js` 在位 + `pnpm run build` 退出 0 + `build:web` 通过；随后即可
`pnpm deploy` 重新物化内核运行时 → 打 zip → 出包。

**注意**：`build:web` 产出的**官方 Web UI** 我们不随产品交付（产品用自建前端）；它只是基座末段的一步，
但它依赖一个我们**确实需要**的东西（`@deepseek-ai/cordis` 的 ESM 入口，内核运行时也要用）。

### 执行记录补记 7（同日）：**内核运行时已在 0.1.5 上启动**（握手进入业务层）

**本轮完成的关键链条**：
1. 基座 `pnpm run build` **全绿**（提交 `ff32b706` 之后的状态）——`build:lib`（tsc 两面 + tsdown 两 face）与
   `build:web`（vite + 234 个客户端产物记录）都通过；
2. **补齐 package 入口**（本轮主因）：`packages/*/*` 里有大量包**没有自带 `tsdown.config.ts`**，
   落到 workspace 模板 entry 上零命中 ⇒ 不产出 `lib/index.js`（而它们的 `exports`/`main` 正指向它）。
   按 `vendor/loader` 的样板批量补齐（含 `vendor/{cordis,cosmokit,include,group,timer,hmr}`、
   `packages/util/*`、`packages/llm/llm` 等）；**甄别规则**：只在"声明了 `./lib/index.js` 且该文件不存在
   且无自带配置"时补，已有产物的包一律不碰（第一版守卫写得太宽，回退了 48 个，其中 10 个是真缺，已重新补上）；
3. **内核运行时重新物化**：`pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel-bundle deploy --prod
   products/bosom-friend/desktop/dist/kernel-runtime-unpacked` ⇒ `dsh-base = 0.1.5-rc.2`、
   **`SESSION_FORMAT_VERSION = 3`**（升级目标达成）；deploy 末尾仍报 `ERR_PNPM_IGNORED_BUILDS`
   （`@deepseek-ai/dsh-subprocess-local` 的 postinstall 被 `allowBuilds` 策略拒绝；Windows 上无影响，待复核）；
4. **端到端握手**：`runtime/bin-kernel.mjs --profile bosom-friend-kernel` 现在**能启动并应答 JSON-RPC**
   （此前是 `ERR_MODULE_NOT_FOUND` 直接崩），返回
   `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"cannot create effect on inactive context"}}`。

**剩下这一处**：`initialize` 返回 `-32603 cannot create effect on inactive context`（cordis 上下文的
生命周期问题——某个插件在 fiber 未激活时注册 effect）。**这是内核侧启动期问题，不再是构建/产物问题**：
`runtime/bin-kernel.mjs` 用 `boot()` 起的组合里，可能是 `dsh-sdk-jsonrpc-server` 与新产品内核插件
在 0.1.5 的 app-boot 语义下注册时机不对。下一轮从这里查：读 `@deepseek-ai/dsh-sdk-jsonrpc-server` 的
apply 与 `boot()`/fiber 就绪语义（0.1.5 的 `installFailLoud`/`boot` 行为可能已变）。

### 执行记录补记 8（同日）：**✅ 内核 0.1.5 握手成功 —— 升级的核心验收判据达成**

**证据**（对物化后的运行时直接发 JSON-RPC initialize）：

```json
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
```

- 运行时：`products/bosom-friend/desktop/dist/kernel-runtime-unpacked`，`dsh-base = 0.1.5-rc.2`，
  **`SESSION_FORMAT_VERSION = 3`**；
- `stderr` **0 字节**、`ERR_MODULE_NOT_FOUND` **0 次**（此前 20 次）。

**真因（值得记住）**：`initialize` 一直返回的 `-32603 cannot create effect on inactive context` 是**次生现象**，
不是 cordis 的 bug：运行时缺 0.1.5 base 补丁层**新增的插件包**，loader 加载失败 ⇒ fiber 从未激活 ⇒
任何 effect 注册都报 `INACTIVE_EFFECT`。补齐 `bundle/kernel/package.json` 的 6 个依赖后一次通过：

`dsh-deepseek-llm-api-extensions`、`dsh-session-log-deepseek`、
`dsh-plugin-package-inventory-deepseek`、`dsh-storage-json`、`dsh-web-fetch-http`、`dsh-util-time`
（前者五个来自 0.1.5 base 的新增行；`util-time` 是它们的传递依赖，必须直连才会进 deploy 闭包）。

**找法（可复用）**：不看 JSON-RPC 的错误消息，改看**运行时 stderr 全文**——那里才有
`failed to import loader entry <id> (<pkg>): Cannot find package '<pkg>'` 的真清单。

**当前 base 构建的已知残留**：删掉 `tsbuildinfo` 强制全量重解析后，`tsc -b` 报 58 个
`TS2307`（集中在 `packages/experimental/webworker-packer`、`apps/cli/tests/*` 对
`.../src/<file>.ts` 子路径的解析）。**不影响运行时**（tsdown host pass 单独跑是绿的、握手已通过），
但会挡住 `pnpm run build` 全绿。下一轮二选一：
1. 查清子路径 `TS2307`（很可能与 path mapping/增量缓存有关）；或
2. 让 `build` 脚本在需要时跳过这些实验/测试项目的类型检查。

**升级链剩余**：重打 `kernel-runtime.zip` → 出包装机实测（含老会话 v0→v3 迁移）。

### 执行记录补记 9（同日）：出包链——运行时可交付，**zip 仍差最后一处**

**已完成并验证**：

| 环节 | 证据 |
| --- | --- |
| 内核运行时物化（0.1.5）| `dsh-base = 0.1.5-rc.2`、`SESSION_FORMAT_VERSION = 3` |
| **运行时 initialize 握手** | ✅ 返回 `result.serverInfo.name = deepseek-harness-sdk-runtime`，stderr 0 字节 |
| 运行时契约探针 | ✅ `KERNEL_RUNTIME_VERIFY PASS` |
| 解压器探针 | ✅ `KERNEL_EXTRACT PASS checks=47` |
| 重打 zip | ✅ 171,301 条目 / 354.8 MB（旧 0.1.1 为 200,537 条目 / 367 MB）|
| 用自带解压器解该 zip | ✅ `UNZIP_OK files=171301 bytes=1219600708 deepest=204 ms=125207` |

**zip 仍差的一处（下一轮唯一动作，已定位到具体形态）**：
从解压结果启动运行时失败，报 `Cannot find package 'js-yaml' imported from .../node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`。

排查结论：
- 该依赖**在 zip 里存在**，但路径不对——磁盘上 `@deepseek-ai/dsh-app-boot/node_modules` **是一个目录联接点**，
  而 zip 里对应位置**只有 `.bin/cordis*` 与 `.bin/js-yaml*` 六个 shim，没有 `js-yaml` 实体**；
- 即 `os.walk(root, followlinks=True)` **只穿过了一部分联接点**（顶层的 `node_modules/@deepseek-ai/*` 穿了，
  写成了 `.pnpm/.../node_modules/@deepseek-ai/<pkg>` 实体），但**没穿 `.pnpm/<pkg>/node_modules/<dep>` 这一级**；
- 直接对物理路径做 Node 解析是能解析到 `js-yaml` 的（实测命中 `.pnpm/@deepseek-ai+dsh-app-boot@…/node_modules/js-yaml/index.js`），
  所以缺的就是"把这些联接点实体化进 zip"这一步。

**修法（下一轮）**：打包脚本改成显式递归——用 `os.scandir`，对每个条目判断
`entry.is_dir(follow_symlinks=False)` 为假但带 `st_file_attributes & 0x400`（reparse point）时，
解析其真实目录并**递归下去**（并维护 visited 集合防环）；不要依赖 `os.walk(followlinks=True)` 的
"跟随链接"语义（实测它只覆盖一部分形态）。改完的判据：zip 里
`node_modules/@deepseek-ai/dsh-app-boot/node_modules/js-yaml/package.json` 存在，且从解压结果能完成握手。

> **2026-09-16 更正**：上面这条修法**只对了一半**。显式递归确实该做（已按此实现），但**光展开联接点不够**——
> 展开后 `Cannot find package '@deepseek-ai/cosmokit'` 照样报，因为 Node 的解析基准是**真实路径**。
> 完整成因与修法见下面的补记 10；判据也从「zip 里有某个文件」改成「从解压结果真握手」。

---

### 执行记录补记 10（2026-09-16）：**出包链最后一环闭合 —— 解压出来的运行时真能跑**

**三次真实产物的对照**（都是本机跑出来的，不是推断）：

| 产物 | 条目 | 结果 | 报错/回话 |
| --- | --- | --- | --- |
| 照原样打包（未展开联接点） | 24,741 | ❌ | `Cannot find package 'js-yaml'`（顶层链接包下只剩 `.bin`） |
| 展开联接点、未补齐扁平层 | 171,301 | ❌ | `Cannot find package '@deepseek-ai/cosmokit' imported from .../kernel-runtime-join/node_modules/@deepseek-ai/cordis/lib/index.js` |
| 展开 + 补齐扁平层 | 195,203 | ✅ | `HANDSHAKE PASS` → `{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}` |

**成因（关键在 Node 用真实路径解析）**：

- 联接点布局下，加载 `node_modules/@deepseek-ai/cordis/lib/index.js` 的真实路径落在
  `.pnpm/<hash>/node_modules/@deepseek-ai/cordis/`，它的依赖在**兄弟层** `.pnpm/<hash>/node_modules/` ✔；
- 展开成真实目录后，真实路径就是顶层路径，Node 从顶层逐级向上找 `node_modules`，而
  `.pnpm/<hash>/node_modules` **不在祖先链上** ⇒ 依赖明明在 zip 里却解析不到。
  这解释了为什么补记 9 那份 171,301 条目的包解压后报的是一模一样的错。

**修法（`repack_kernel.py` 现在做的两步）**：

1. **展开**：`os.scandir` 自走目录，遇链接用 `os.path.realpath` 解析真实目标再复制（`shutil.copytree` 会因为
   pnpm 写的是**相对**目标而把每个链接误判成悬空、静默跳过——实测整棵树只剩顶层 4 个条目且脚本报成功）；
2. **补齐扁平层**：把 pnpm 自己算好的私有提升层 `.pnpm/node_modules`（`hoist-pattern` 默认 `*`）搬到顶层
   `node_modules`。实测 **387** 个包 + 顶层已有的 **130** 个工作区包 = **517** 个名字，正好是闭包全集；
   534 个 `.pnpm/<hash>` 分组里依赖版本与扁平层不一致的 **37** 条边，按包嵌套补一份到
   `<包>/node_modules/<依赖>`（Node 先看包内 `node_modules`，嵌套副本优先，不会串味）。
   `.pnpm` 虚拟仓**整份保留**：实测有 17 个多版本包，删掉换一层扁平必然解析错。

**同轮修掉的四处过时假设**（前三处都假设「运行时是一棵普通目录树」，pnpm 11 下必然出错）：

1. 出包流程第 2 步只在顶层 `node_modules/@deepseek-ai/<pkg>` 找 server 包——pnpm 11 的顶层只挂**部署根的
   直接依赖**（实测 130 个），该步必然 `throw`。改成写**所有物理副本**（顶层 + 每个 `.pnpm/<dir>` + 公共提升层）；
2. `verify-runtime-deps.mjs` 只看顶层 `node_modules`——第三方依赖全在 `.pnpm` 里。改成按 **Node 的解析规则**
   从服务端的每一份物理副本逐级向上解析（实测 1 个第三方依赖 × 1 份物理副本）；
3. 出包流程**没有任何一步**验证「解压后的树能不能跑」，只有「条目数/字节数对得上」这种弱证据。新增第 6 步：
   用装机同款 `tar.exe` 把新 zip 解到临时目录，跑新探针 `qa/probes/handshake-kernel.mjs`
   （走装机路径 `runtime/bin-kernel.mjs`，发真实 `initialize`），失败即中止、**不换 zip**；
4. 第 2 步的 `Copy-Item -Force` 在 pnpm 11 下必然报 `being used by another process`：部署产物与工作区构建输出
   是**硬链接**（实测 nlink = 10，同一 inode 被 `server/lib`、多个 `.pnpm` 副本与运行时共享），就地覆盖等于
   读写的同一个文件。改成**只写真实副本**（`.pnpm/<dir>/...` 与公共提升层里那些是联接点，指向同一份文件）
   + **先删后拷**（`Remove-Item` 只摘掉这个目录项，工作区里的构建输出另有名字）。

**本轮产物**：`kernel-runtime.zip.new` = **195,203 条目 / 413.6 MB**（压缩耗时 13.9 分钟），与升级前那份可用包
（200,537 条目 / 384.9 MB）同一量级；`tar.exe` 解压 + 握手见上表第三行。

### 执行记录补记 11（2026-09-16 第二轮）：**桌面主进程的内核启动链也停在 0.1.1**

跑产品门禁（`qa/run-gate.mjs`，2026-09-16 00:35）时暴露：「启动页进度条」与「内核握手超时」转红，而**安装版**场景
（`--packaged`）反而 8/8 PASS——因为安装版跑的是 0.1.1 运行时，把开发态的断链掩盖了过去。查下去是三个互相独立、
必须一起修的点：

| # | 位置 | 断在哪 | 修法 |
| --- | --- | --- | --- |
| 1 | `desktop/electron/kernel-host.cjs` | 仍用 0.1.1 契约 `new HarnessClient({ command, args, cwd, env })`（0.1.5 只认 `dshBin`/`profile`/`processCwd`）；开发态还用裸包名 `import('@deepseek-ai/dsh-sdk-client')`，而仓库根**没有**这个链接（只有 server 的 workspace 链接） | 客户端按宿主取路径（随包态取运行时顶层 → 开发态取 server 的 workspace 链接 → 裸名兜底）；启动规格改用 `HarnessClient(options, runtime)` 显式传入，保住「随包 Node 优先」（profile 契约把 command 钉成 `process.execPath`，在 Electron 里就是 Electron 的 Node ABI，与随包 Node 的 ABI 不同） |
| 2 | 三层 bundle 补丁 | 补丁里的插件是**裸包名**，Node 按**配置文件所在目录**解析：`launcher/config/` 与 `launcher/node_modules` 里没有插件闭包（实测第一处 `@deepseek-ai/dsh-spill-policy` 就断） | 开发态入口改成与随包版**同一个文件** `bundle/kernel/runtime/bin-desktop.mjs`（`kernel-host.cjs` 与 `server/src/kernel-client.ts` 的 dev 回退一起改）——开发态与出货态同源，也免掉两份入口各自漂移 |
| 3 | `bundle/kernel/package.json` | 少两条**直接**依赖：`@deepseek-ai/dsh-sdk-client`（Electron 主进程要从运行时顶层加载它）与 `@deepseek-ai/dsh-bosom-friend-server`（桌面 bundle 的补丁按裸名引用它）。pnpm 11 的部署产物顶层只挂部署根的**直接**依赖，「间接依赖能解析到」在那里不成立 | 补齐两条依赖 → 重新 `pnpm deploy` 物化 → 顶层出现这两个包（实测 `node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js` 与 `.../dsh-bosom-friend-server/package.json` 均在位） |

**判定证据**（修复前后各跑一次同一条命令）：

```text
修复前: M2_KERNEL_HOST_FAIL bosom-friend desktop kernel: DeepSeek Harness runtime is not running
        stderr tail: Cannot find package '@deepseek-ai/dsh-sdk-client' …
修复后: M2_KERNEL_HOST_OK {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}
```

（命令：`node products/bosom-friend/desktop/electron/smoke-host.cjs`——在纯 Node 下跑与主进程同一套 `kernel-host.cjs` 代码。）

**顺带**：`launcher/package.json` 补上它自己入口 `require.resolve` 的两个 bundle（`dsh-bosom-friend-kernel`、
`dsh-bosom-friend-desktop-bundle`）与 `dsh-sdk-client`——这是同一个 MODULE_NOT_FOUND 家族里最早的一处。

**教训**（已进知识库条目 12 的 44/45 条）：换基座这类「公开契约变更」要按**宿主**清点，不是按包；
「某个包能解析到」必须从**真正加载它的那个目录**上验证。

---

## 0. 结论摘要（先看这 6 条）

---

## 0. 结论摘要（先看这 6 条）

1. **基座是干净的**：相对 `dsh-v0.1.1-rc.2`，`packages/`、`vendor/`、`apps/`、`scripts/`、`python/`、`native/`、`examples/`、`website/`、`docs/` **零改动、零未跟踪文件**。【实测】
   所以本次升级**不是合并分叉，而是整体换基座**——真正的冲突面只有根级 6 个文件，且全部是本地为了接入 `products/` 而做的构建配置改动。
2. **最大破坏性变更（已实测）**：`SESSION_FORMAT_VERSION` 从 `0` 升到 `3`。0.1.5 自带 v0→v1→v2→v3 迁移链，且 `dsh-session-persistence-jsonl` 直接依赖迁移目录，因此走标准 provider 就能自动迁移——但这是一次性磁盘改写，必须用真实老数据实测。
3. **第二个破坏性变更（已实测）**：vendored `@deepseek-ai/cordis` 需从 `4.0.1` 升到 `4.0.2`（0.1.5 发布包依赖 4.0.2），即 `vendor/` 必须走同步流程。
4. **好消息（已实测）**：产品内核最依赖的两个 API 面没有破坏——`dsh-tools` 的 `defineTool`/`DefineToolOptions` 与本地逐字段一致；`dsh-app-boot` 的 `boot`/`installFailLoud`/`loadOptionalPatches` 仍在且签名一致。
5. **最大风险**：packages 包集合大面积改名/新增（客户端 UI 系列最明显），而产品的 `bundle/kernel/package.json` 是一份 141 行的**封闭依赖清单**——上游每改一个包名，这里就必须跟着改；同时 `server` 依赖的 `@deepseek-ai/dsh-sdk-client` 在 0.1.5 发布闭包里查不到（【待核实】，可能改名或转私有）。
6. **本次调研的硬缺口**：上游 git 对象不在本地（`git cat-file -t fb2c4b9e...` 报 bad object），`git fetch origin --tags --prune` 在 5 分钟预算内未完成（疑似卡在凭据），已主动终止。第 2 节的上游结论全部来自 npm 已发布 0.1.5-rc.1 的 `lib/` 与 `.d.ts`，**不是源码 diff**。

---

## 1. 现状核实：本仓库相对基线到底改了什么

### 1.1 跑过的命令与结论【实测】

| 命令 | 输出 / 结论 |
| --- | --- |
| `git tag -l` | 只有 `dsh-v0.1.1-rc.2` |
| `git log --oneline -3 dsh-v0.1.1-rc.2` | `b150a551 Merge pull request #2908 from .../release/dsh-0.1.1-rc.2` |
| `git merge-base --is-ancestor dsh-v0.1.1-rc.2 HEAD` | 退出码 0 → 基线 tag 是 HEAD 的祖先，可直接 merge，无需 rebase |
| `git rev-list --count dsh-v0.1.1-rc.2..HEAD` | **200** 个本地提交 |
| `git diff --name-status dsh-v0.1.1-rc.2 HEAD -- packages vendor apps scripts python native` | **空** |
| `git log --oneline dsh-v0.1.1-rc.2..HEAD -- packages vendor apps scripts` | **0 条** |
| `git status --porcelain -- packages vendor apps scripts python native examples website docs` | **0 行**（连未跟踪文件都没有） |
| `git diff --stat dsh-v0.1.1-rc.2 HEAD` | 390 files changed, +72010 / -1349，全部落在 `products/` 与根级中文文档 |
| `git remote -v` | `origin = https://github.com/deepseek-ai/deepseek-harness.git` |
| `git for-each-ref refs/remotes` | 只有 `origin/master = b150a55`（停在基线，远端引用从未更新） |
| `git cat-file -t fb2c4b9e... / 0a15e36e... / 0d1f5000...` | bad object → **上游 0.1.5 / 0.1.6 / master 的对象都不在本地** |
| `node -v ; pnpm -v` | `v24.18.0` / `11.7.0`；root package.json: packageManager=pnpm@11.7.0, engines=^22.19.0 或 >=24.0.0 |
| `git status --porcelain`（只看跟踪文件） | 未提交改动集中在 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 与 `products/bosom-friend/{desktop,launcher,server,project,qa,docs}` |

> 踩坑记录：**不要**用 `git rev-parse --verify --quiet <sha>` 判断对象是否存在——它会把 40 位十六进制字符串原样回显并返回 0，造成上游对象已在本地 的假象。要用 `git cat-file -t <sha>`。（本次就先用错了，已纠正。）

### 1.2 必须保留的本地改动清单（基座侧：6 个文件 + 1 个新增目录）

| 文件 | 本地改了什么 | 为什么必须保留 |
| --- | --- | --- |
| `pnpm-workspace.yaml` | (1) `apps/*` 收窄为 `apps/cli`；(2) 删除 `python/sdk-runtime` 成员；(3) 新增 5 条 `products/bosom-friend/*` 成员；(4) 删除 `patchedDependencies: node-pty@1.2.0-beta.15`；(5) 保留 `allowBuilds.node-pty` 与 `msedge-tts: false` | (1) 见 1.3 的重名冲突，**最关键**；(3) 产品层才能被 workspace 解析；(4) 本地决定不再打 node-pty 补丁 |
| `tsconfig.client.json` | 删除 `apps/web` 的 project reference | 与 (1) 同因，apps/web 已退役 |
| `tsconfig.host.json` | 删除约 80 行 `apps/web/tests/**` 的 `include` | 同上 |
| `AGENTS.md` | +1 行：AI-assisted edits follow the vibe-coding constraints | 仓库级 AI 协作约定，本地新增 |
| `THIRD_PARTY_NOTICES.md` | 删除 node-pty patch 段、删除 `@vitejs/plugin-react` 与 `playwright` 两行 | 与 (4) 及 apps/web 退役一致 |
| `pnpm-lock.yaml` | 本地成员集合变化后重算（1901 行变动） | 这不是改动而是产物：**冲突时不要手工解**，删掉重新 `pnpm install` |
| `.agents/skills/vibe-coding-guide/SKILL.md` + `Vibe-Coding-避坑实战指南.md` | 新增文件 | AGENTS.md 引用它们，删了会断链 |

另有若干根级中文文档（工作日志、项目铁律、流程规范等）与本任务无关，但属于本地资产，merge 时不要被顺手清理。

### 1.3 一个必须知道的坑：包名重名【实测】

- `apps/web/package.json` 的 `name` = `@deepseek-ai/dsh-web-frontend`
- `products/bosom-friend/shim/package.json` 的 `name` **也是** `@deepseek-ai/dsh-web-frontend`

本地把 `apps/*` 收窄成 `apps/cli` 正是为了让 shim 顶替这个名字。**升级时若把 `pnpm-workspace.yaml` 的 `apps/cli` 恢复成 `apps/*`，pnpm 会因重名直接报错。**（root `package.json` 的 `build:web` 脚本会 `pnpm --filter @deepseek-ai/dsh-web-frontend run build`，本地解析到的就是 shim。）

### 1.4 内核运行时的现状【实测】

- `products/bosom-friend/desktop/dist/kernel-runtime.zip` = 384,897,392 字节（约 385MB），另有 6 个 `*.bak-<时间戳>` 历史包；
- `dist/kernel-runtime-unpacked/node_modules/@deepseek-ai/` 下 136 个包，抽查 `dsh-app-boot` 与 `dsh-base` 的 `version` = `0.1.1-rc.2`；
- 运行时由更早一次 `pnpm deploy` 物化。`rebuild-kernel-and-installer.ps1` 第 2 步**只同步 lib、不同步依赖**——这是 DEF-052 的根因，脚本里已加 `verify-runtime-deps.mjs` 拦截；
- 本地 `SESSION_FORMAT_VERSION = 0`（`packages/core/session/src/types.ts`）。

---

## 2. 上游增量：0.1.1-rc.2 → 0.1.5-rc.2

### 2.1 【实测】从 npm 已发布 `@deepseek-ai/dsh@0.1.5-rc.1` 读到的硬事实

证据来源：`C:\Users\Jay\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`（240 个目录，含 10 个 vendored 包）。

**(a) 磁盘格式：破坏性**

| 常量 | 本地 0.1.1-rc.2 | 发布 0.1.5-rc.1 | 影响 |
| --- | --- | --- | --- |
| `SESSION_FORMAT_VERSION` | `0`（`packages/core/session/src/types.ts`） | **`3`**（`dsh-session/lib/types/types.js:54`） | 会话日志换格式，旧日志必须走迁移链 |
| `SESSION_QUERY_SQLITE_SCHEMA_VERSION` | `8` | `8`（`dsh-session-query-sqlite/lib/index.js:11`） | **未变**，SQLite 侧无迁移 |

0.1.5 新增一整族格式包：`dsh-session-format`（导出 `createSessionFormatCatalog`、`defineSessionFormatMigration`、`createSessionFormatChain` 等）、`dsh-session-format-catalog`（导出 `sessionFormatCatalog`）、`dsh-session-format-v0-to-v1`、`dsh-session-format-v1-to-v2`、`dsh-session-format-v2-to-v3`。
**迁移链会自动生效**：`dsh-session-persistence-jsonl`（base 层本来就挂的 provider）依赖 `dsh-session-format-catalog` 与 `dsh-session-format-v2-to-v3`，产品侧不需要额外挂插件。

**(b) vendored Cordis：需要同步**

| | 本地 | 0.1.5 发布包依赖 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.1`（`vendor/cordis/package.json`） | `4.0.2`（npx 缓存里的 `@deepseek-ai/cordis/package.json`） |

按 `vendor/README.md` 的 Sync procedure 更新，并重新核对其中登记本地改动的段落。

**(c) dsh-base 补丁层：行集合变了，结构没变**

两端都是同一个 insert 结构，按 `id` 覆盖。行 id 差异：

- **0.1.5 新增（8 行）**：`deepseek-llm-api-extensions`、`session-log-deepseek`、`plugin-package-inventory-deepseek`、`storage`、`storage-json`、`storage-domain`、`session-projection-cache`、`web-fetch-http`；
- **本地 0.1.1 base 有、0.1.5 base 已移除（2 行）**：`tool-subagent-report`、`tool-str-replace-editor`；
- `hmr` 行在 0.1.5 默认 `disabled: true`；
- 产品内核补丁层覆盖的 `llm-pi-ai` 行**两端都在**，行 id 未变。

**(d) dsh-app-boot：新增 profile 管理层，但产品入口依赖的函数未变**

发布版新增导出：`PROFILES_DIR = profiles`、`PROFILE_PATCH_FILENAME = cordis.patch.yml`、`initProfile`、`loadProfile`、`loadProfileDirectory`、`composeEntries`、`resolveBundleDir`、`readProfileManifest`、`healProfilesModuleFallback`、`DEFAULT_PROFILE_BUNDLES` 等。
产品入口 `launcher/src/bin-kernel.ts` 与 `bundle/kernel/runtime/bin-kernel.mjs` 用到的三个函数的签名对比：

- `loadOptionalPatches(binName: string, file: string): PatchOptions[] | undefined` —— **一致**；
- `installFailLoud(binName: string, proc?, release?)` —— **一致**；
- `boot(binName, absoluteConfigPath, patches?, prepare?, bareModuleBaseUrl?)` —— **兼容**，仅新增两个可选参。

**(e) dsh-tools：产品最关键的 API 面，兼容**

产品 `kernel/src/index.ts` 有 **9 处** `ctx.tools.register(defineTool({...}))`。发布版的 `DefineToolOptions` 与本地逐字段相同：

    name / description / parameters / output{ schema, render(args,value), presentationMeta?(args,value) } / timeoutMs?

发布版**新增**（本地没有，属可选增强）：`assertSupportedJsonSchema`、`assertObjectJsonSchema`、`validateJsonSchemaValue`、`validateArgs`、`ToolArgsError`、`JsonSchemaError`、`ToolNotFoundError`、`ToolOutputError`、`createRunCodeTool`。`RUN_CODE_NAME` 现在从 `./ptc.ts` 导出（本地是 `./code-mode.ts`，即 code-mode 已改名 ptc）。`ToolRuntime` 仍是 `Service`，`ctx.tools.register` 未变。

**(f) dsh-llm-pi-ai：产品 Agnes 网关的配置字段未变**

产品 `kernel/cordis.patch.yml` 给 `llm-pi-ai` 行配置 providers.agnes 下的 `displayName` / `apiKeyEnv` / `api` / `baseURL` / `models[]`。发布版 `dsh-llm-pi-ai/lib/types/config.d.ts` 仍有 `displayName`(:57)、`api`(:63)、`baseURL`(:65)、`models`(:71)、`apiKeyEnv`(:55)；`catalog.d.ts` 有 `contextWindow`(:263)、`maxTokens`(:270)。

**(g) 包集合：大面积改名/新增（这份对照表是升级工作量的主要来源）**

本地 `packages/*/*` = 227 个包；发布闭包 `@deepseek-ai/` = 240 个目录（含 10 个 vendored）。把本地 `packages/ + apps/ + vendor/ + native/ + website/` 全部计入（243 个名字）后，**发布侧有 40 个名字在本地任何位置都不存在**，节选：

| 类别 | 发布侧的新名字 |
| --- | --- |
| 会话格式族 | `dsh-session-format`、`dsh-session-format-catalog`、`dsh-session-format-v0-to-v1`、`dsh-session-format-v1-to-v2`、`dsh-session-format-v2-to-v3`、`dsh-session-log-deepseek`、`dsh-session-turn-outline` |
| 客户端 UI 重构 | `dsh-client-ui-chat`、`dsh-client-ui-cordis`、`dsh-client-ui-approval`、`dsh-client-ui-input-trigger`、`dsh-client-ui-jobs`、`dsh-client-ui-schedule`、`dsh-client-ui-session`、`dsh-client-ui-sidebar-files`、`dsh-client-ui-sidebar-right`、`dsh-client-ui-sidebar-documentpreview`、`dsh-client-ui-open-in-app`、`dsh-client-resources`、`dsh-client-file-upload` |
| 工具 / 宿主 | `dsh-tool-present`、`dsh-host-open-in-app`、`dsh-win32-process`、`dsh-http-proxy` |
| util / 基础设施 | `dsh-util-crypto`、`dsh-util-time`、`dsh-util-values`、`dsh-util-workspace-path`、`dsh-deque`、`dsh-chunked-list`、`dsh-package-manifest` |
| API / 插件 | `dsh-api-session-controller`、`dsh-api-settings-controller`、`dsh-api-workspace-controller`、`dsh-api-workspace-files`、`dsh-plugin-package-inventory-deepseek`、`dsh-deepseek-llm-api-extensions` |
| 其它 | `dsh-webhook`、`dsh-webhook-github`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`、`@deepseek-ai/node-addon-system`（新增 vendored 包） |

反向：本地有 37 个名字在发布闭包里没有，但**多数是 private / 实验 / 测试支撑包**，不能据此判定被删除：`dsh-e2b`、`dsh-fs-e2b`、`dsh-subprocess-e2b`、`dsh-experimental-*`、`dsh-lsp`、`dsh-tool-lsp`、`dsh-tool-terminal`、`dsh-subagent-acp/claude-code/codex`、`dsh-client-runtime`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-client-web`、`dsh-session-persistence-sqlite`、`dsh-storage-sqlite`、`dsh-typert-generator`、`dsh-*-demo` 等。**但 `dsh-sdk-client` 是产品 server 的直接依赖，必须优先核实。**

### 2.2 【推断】

- 0.1.5 把组合方式从 bundle 补丁层推进到了 **profile 机制**（`PROFILES_DIR`、`initProfile`、`resolveBundleDir`）。产品现在用 `loadOptionalPatches` 手工叠三层（`dsh-base` → `bundle/app` 或 `bundle/desktop` → `kernel`），大概率仍能用（函数签名一致），但上游入口可能已切到 profile；`bundle/app/package.json` 里的 `dsh.bundle.patch` 清单字段在 profile 机制下是否仍被解析，**未验证**。
- 客户端 UI 包大面积改名对产品的直接影响较小：产品前端与桌面壳都不 import 客户端 UI 包，只走 SDK JSON-RPC。但 `bundle/app` 若依赖 `dsh-web-app` 这条链，仍需跟着改。

### 2.3 【待核实】：fetch 后必须补的证据

本次 `git fetch origin --tags --prune` 以后台任务启动，5 分钟预算内**未完成**（输出为空，疑似卡在凭据交互），已终止。因此**没有拿到任何上游 commit 级 diff**。拿到网络与凭据后按顺序跑：

```sh
git fetch origin --tags --prune
git cat-file -t dsh-v0.1.5-rc.2            # 必须是 commit，不能是 bad object
git log --oneline dsh-v0.1.1-rc.2..dsh-v0.1.5-rc.2 | Measure-Object -Line
git diff --stat dsh-v0.1.1-rc.2 dsh-v0.1.5-rc.2 -- packages vendor apps scripts python native
git diff --name-status --diff-filter=D dsh-v0.1.1-rc.2 dsh-v0.1.5-rc.2 -- packages   # 被删的包
git diff --name-status --diff-filter=A dsh-v0.1.1-rc.2 dsh-v0.1.5-rc.2 -- packages   # 新增的包
git diff dsh-v0.1.1-rc.2 dsh-v0.1.5-rc.2 -- packages/core/session/src/types.ts
git diff dsh-v0.1.1-rc.2 dsh-v0.1.5-rc.2 -- packages/bundle/base/cordis.patch.yml
git diff dsh-v0.1.1-rc.2 dsh-v0.1.5-rc.2 -- pnpm-workspace.yaml package.json tsconfig.host.json tsconfig.client.json
git show dsh-v0.1.5-rc.2:package.json       # engines / packageManager
git show dsh-v0.1.5-rc.2:vendor/README.md   # 上游把 vendored cordis 同步到哪个 SHA
git ls-tree -r --name-only dsh-v0.1.5-rc.2 packages/sdk    # dsh-sdk-client 是否还在
```

**必须先回答的 5 个问题**（按对产品的杀伤力排序）：

1. `@deepseek-ai/dsh-sdk-client` 是被删、被改名，还是仅仅没被发布？（产品 `server` 直接依赖它）
2. `dsh-session-format*` 全族是否在 `packages/` 中，包名与发布侧一致？
3. 客户端 UI 系列改名后，是否存在兼容别名包？
4. `vendor/README.md` 里 cordis 的目标 SHA 与本地登记的 local modifications 是否冲突？
5. 上游 `package.json` 的 `engines.node` / `packageManager` 是否仍兼容本机的 node 24.18.0 与 pnpm 11.7.0？

---

## 3. 升级路径（分步、可回滚）

原则：**每一步都能独立验收、独立回滚**，不追求一次 merge 到底。

### 步骤 0：冻结现场（必做）

```sh
cd "C:/Users/Jay/Desktop/Bosom friend APP"
git status --porcelain > analysis/plan/pre-upgrade-worktree.txt
git rev-parse HEAD >> analysis/plan/pre-upgrade-worktree.txt
git branch backup/pre-kernel-upgrade-$(date +%Y%m%d)
git stash push -u -m pre-kernel-upgrade     # 或先把在途的 products/ 改动提交掉（更推荐）
```

- **验收**：`git status --porcelain` 只剩 `analysis/`；backup 分支存在。
- **回滚**：`git stash pop`。
- 注意：当前工作区有大量未提交改动（`pnpm-workspace.yaml`、`pnpm-lock.yaml`、desktop 构建脚本、server 源码、大量 qa 产物）。**带着脏工作区做 merge 是最容易丢东西的做法**，务必先落地。

### 步骤 1：取上游

```sh
git fetch origin --tags --prune
git cat-file -t dsh-v0.1.5-rc.2
git log --oneline -1 dsh-v0.1.5-rc.2
```

- **验收**：输出 `commit` 与 `fb2c4b9e...`。
- **回滚**：不需要（只新增对象与引用）。
- **失败处理**：fetch 需要凭据。若卡住，改为在能联网的机器上 `git bundle create` 后拷回，或先走 6.2 的发布包预演路线。

### 步骤 2：建升级分支并预演 merge（先不提交）

```sh
git switch -c upgrade/kernel-v0.1.5-rc.2 fix/ai-autopublish
git merge --no-commit --no-ff dsh-v0.1.5-rc.2
git diff --name-only --diff-filter=U
```

- **验收**：冲突清单**应当只有根级文件**（`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`AGENTS.md`、`THIRD_PARTY_NOTICES.md`、`tsconfig.host.json`、`tsconfig.client.json`）。**若 `packages/` 下出现冲突，说明前提有变，立即 `git merge --abort` 并重新调研。**
- **回滚**：`git merge --abort`。

### 步骤 3：冲突处理规则（逐文件）

| 文件 | 处理规则 |
| --- | --- |
| `pnpm-workspace.yaml` | **以本地为骨架**，只把上游新增成员合并进来。硬性约束：保留 `- apps/cli`（**绝不能写回 `apps/*`**，见 1.3）、保留 5 条 `products/bosom-friend/*`、保留 `overrides` 与 `allowBuilds` 与 `minimumReleaseAgeExclude`；上游若仍声明 `patchedDependencies`，需**显式决策**是否恢复（本地是删除的，`THIRD_PARTY_NOTICES.md` 也已同步删除，恢复就要两边一起改） |
| `pnpm-lock.yaml` | **不手工解**：`git checkout --theirs pnpm-lock.yaml` 或直接 `git rm -f pnpm-lock.yaml`，随后 `pnpm install` 重算（本地成员集合与上游不同，任何手工合并都是错的） |
| `tsconfig.host.json` / `tsconfig.client.json` | 以本地去掉 apps/web 的版本为准；**若上游已彻底删除 `apps/web`**，直接取上游版本，再确认本地不再需要那两处删除 |
| `AGENTS.md` | 取上游 + 重新贴回本地那一行 vibe-coding 约定 |
| `THIRD_PARTY_NOTICES.md` | 取上游 + 重新应用本地删除；若决定恢复 node-pty 补丁，本文件要相应恢复 |

- **验收**：`git diff --name-only --diff-filter=U` 为空。
- **回滚**：`git merge --abort`。

### 步骤 4：安装 + 基座构建门禁

```sh
pnpm install                 # 不要 --frozen-lockfile（lock 刚被替换）
pnpm run build               # tsc + tsdown
pnpm run typecheck
pnpm run lint
pnpm run hygiene             # knip + publint + workspace 约束 + NodeNext 消费者检查
```

- **验收**：全部 0 退出。因为本地 `packages/` 零改动，这里的失败几乎等价于上游自身问题或本机环境问题（node 24.18.0 / pnpm 11.7.0），**不要**用改产品代码的方式绕过。
- **回滚**：`git reset --hard backup/pre-kernel-upgrade-<date>`（`pnpm install` 只动 `node_modules` 与 lock，不影响源码）。
- 常见坑：pnpm 10+ 会因未登记的 install 脚本**硬失败**（strictDepBuilds）。上游新增依赖若带 lifecycle script，`pnpm-workspace.yaml` 的 `allowBuilds` 必须显式登记否则或 `false`）。

### 步骤 5：基座测试门禁

```sh
pnpm run test              # vitest 单测
pnpm run test:coverage     # CI 覆盖率门禁（per-file 100%），比 test 更严
pnpm run test:snapshot     # keyless ACP/headless 回放
pnpm run doc-sync          # 文档门禁（含 verify-cordis-config）
```

- **验收**：全绿；有 `DEEPSEEK_API_KEY` 时补跑 `pnpm run test:e2e`（无 key 会自跳过）。
- **特别注意**：`test:snapshot` 覆盖 ACP/headless 的期望输出；`SESSION_FORMAT_VERSION` 与 `SessionEventMap` 的变化都会改快照。按仓库约定，快照漂移要用 `pnpm run test:snapshot:record` **重新录制并逐条 review**，不要手改期望文件。
- **回滚**：同步骤 4。

### 步骤 6：产品层编译

```sh
pnpm --filter @deepseek-ai/dsh-bosom-friend-server build
pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build
pnpm --filter @deepseek-ai/bosom-friend build:kernel
pnpm --filter @deepseek-ai/bosom-friend build:desktop
```

- **验收**：0 错误。重点盯：`kernel/src/index.ts` 的 9 处 `defineTool`（已核实兼容）、`server` 对 `dsh-sdk-client` / `dsh-invariants` / `dsh-host-webserver` 的 import。
- **回滚**：`git checkout -- products/`。

### 步骤 7：**重新物化**内核运行时（本次升级最关键的一步）

不能只做同步 lib——包集合与版本整体变了，必须重新 `pnpm deploy`：

```sh
# 1) 重新物化（目标目录就是打包读取的 dist/kernel-runtime-unpacked）
pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel-bundle deploy --prod ./products/bosom-friend/desktop/dist/kernel-runtime-unpacked
# 2) 依赖齐全性闸门（DEF-052 的拦截器）
node products/bosom-friend/desktop/verify-runtime-deps.mjs "C:/Users/Jay/Desktop/Bosom friend APP"
```

- **验收（三条都要过）**：
  1. `verify-runtime-deps.mjs` 退出 0；
  2. `dist/kernel-runtime-unpacked/node_modules/@deepseek-ai/dsh-base/package.json` 的 `version` == `0.1.5-rc.2`（现在是 `0.1.1-rc.2`）；
  3. 运行时里 `dsh-session` 的 `SESSION_FORMAT_VERSION` 读出来是 `3`。
- **回滚**：运行时目录可整体删除后由 `pnpm deploy` 重建；`kernel-runtime.zip` 有 6 个 `*.bak-*` 可回退。
- **务必先做**：`desktop/rebuild-kernel-and-installer.ps1` 第 2 步的 lib 同步**不能替代** `pnpm deploy`；把两者混淆正是 DEF-052 的成因。

### 步骤 8：出包 + 装机实测

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File products/bosom-friend/desktop/rebuild-kernel-and-installer.ps1
node products/bosom-friend/qa/verify-kernel-runtime.mjs
```

- 脚本依次执行（8 步）：产品包 build → lib 同步到**每一份物理副本** → 依赖核对（按 Node 规则解析）→ `engine-portable`
  → `repack_kernel.py` 重打 zip（展开联接点 + 补齐扁平层）→ **解压新 zip 真握手**（`qa/probes/handshake-kernel.mjs`，
  失败即中止、不换 zip）→ 换入新 zip（旧包改名 `.bak-<时间戳>`）→ `build-win.sh` 出 NSIS 安装包并复制到桌面。
- 第 5~6 步各约 14 分钟与 3 分钟（本机实测：压缩 13.9 分钟、`tar.exe` 解 195,203 个文件 2.5 分钟、握手 13.5 秒）。
- **验收**：
  1. `dist/kernel-runtime.zip` 重新生成，并记录**字节数与条目数**（当前基线 **195,203 条目 / 413.6 MB**，
     即 2026-09-16 已验证握手通过的那一份；升级前那份可用包是 200,537 条目 / 384.9 MB，留作 `.bak-0.1.1`）；
     **注意**：条目数或字节数对得上不算证据——唯一判据是第 6 步的"解压后真握手"（DEF-058）；
  2. `qa/verify-kernel-runtime.mjs` 通过（注意它硬编码 `C:/Program Files/7-Zip/7z.exe` 与 userData 目录名 `kernel-runtime-v3`）；
  3. 真机安装 → 启动页走完 → 内核握手成功 → 产品页可用（**这是唯一能证明升级成功的判据**）；
  4. **老数据实测**：拿升级前的 `%APPDATA%/Bosom Friend` 或 `~/.bosom-friend/sessions` 旧会话，验证 v0→v3 迁移；失败要如实记录（上游对旧格式**不做兼容承诺**）。
- **回滚**：`Move-Item dist/kernel-runtime.zip.bak-<stamp> dist/kernel-runtime.zip -Force` 后重跑 `build-win.sh`，产出上一版安装包。

### 步骤 9：提交与标记

分步提交（见第 6 节），最后打一个产品侧 tag（例如 `bosom-v0.2.50-kernel-0.1.5-rc.2`），便于整包回退。

---

## 4. 产品层适配清单（`products/bosom-friend/`）

### 4.1 内核构建 / 打包链

| 文件 | 需要改什么、为什么 |
| --- | --- |
| `bundle/kernel/package.json` | **改动量最大**：141 行的封闭依赖清单。上游每个改名或新增的包都要在这里对齐；新增的 `dsh-session-format*`（若需显式挂）、`dsh-storage*`、`dsh-session-log-deepseek`、`dsh-deepseek-llm-api-extensions`、`dsh-plugin-package-inventory-deepseek` 等要评估是否纳入运行时。**这份清单就是内核运行时到底装了哪些包的唯一事实来源。** |
| `bundle/desktop/package.json` | 3 条依赖（`dsh-host-webserver`、server、kernel）；上游若改 host-webserver 的包名或导出需同步 |
| `bundle/app/package.json` | 依赖 `dsh-bosom-friend-server` 与 `dsh-mcp-client`；另含 `dsh.bundle.patch` 清单字段，在 0.1.5 的 profile 机制下是否仍被解析**待核实** |
| `desktop/rebuild-kernel-and-installer.ps1` | 硬编码仓库绝对路径与 `%LOCALAPPDATA%/Programs/Python/Python312/python.exe`；**需新增 pnpm deploy 重新物化步骤**（当前流程缺失，见步骤 7）；第 2 步的 lib 同步按内容匹配 `.pnpm` 目录，包名变化后仍应成立但要复测 |
| `desktop/verify-runtime-deps.mjs` | 只校验 `server/package.json` 里非 `@deepseek-ai/` 的依赖；建议同时校验 `dsh-session` 版本与 `SESSION_FORMAT_VERSION` |
| `desktop/repack_kernel.py` / `desktop/build-engine-portable.ps1` | 与内核版本无关，但 zip 体积与最深路径会变（DEF-055 的 MAX_PATH 教训） |
| `desktop/build-win.sh`、`electron-builder.yml`、`build/installer.nsh` | 打包产物清单（kernel-runtime.zip、engine、frontend-dist）；zip 结构不变则无需改 |
| `desktop/electron/main.cjs` | 开发态 `BF_KERNEL_ROOT` 指向 `dist/kernel-runtime-unpacked`；解压、校验、启动链路与内核版本无关 |

### 4.2 组合配置与插件

| 文件 | 需要改什么、为什么 |
| --- | --- |
| `bundle/kernel/cordis.patch.yml` | insert 两行（`dsh-sdk-jsonrpc-server`、`dsh-bosom-friend-kernel`）+ 覆盖 `llm-pi-ai` 行。**已核实字段名未变**；但要确认这两行的 id 与上游 base 不冲突 |
| `bundle/app/cordis.patch.yml` | `bosom-friend-server-api` 行（dataRoot / authEnabled）+ 两个 `dsh-mcp-client` 行；`dsh-mcp-client` 的 config 键（serverName / transport / command / args / toolCallTimeoutMs）**待核实** |
| `bundle/desktop/cordis.patch.yml` | `dsh-host-webserver` 行（host / port 31280）+ `bosom-friend-server-api` 行（多一个 frontendDist）。host-webserver 的 Config 字段与默认值**待核实**；两层的行 id 一致性由 `qa/verify-cordis-patches.mjs` 守 |
| `launcher/config/kernel.cordis.yml` | 空数组根配置，无需改 |
| `launcher/config/desktop.cordis.yml` | 同层一致性需复核 |
| `launcher/src/bin-kernel.ts` 与 `bundle/kernel/runtime/bin-kernel.mjs` | `boot` / `installFailLoud` / `loadOptionalPatches` **已核实兼容**；只有采用 profile 机制才需要改 |
| `kernel/src/index.ts` | 9 处 `ctx.tools.register(defineTool({...}))`；`inject = ['tools','llm']` 需确认服务名未变；`defineTool` **已核实逐字段兼容** |
| `kernel/src/{data,jobs,drafts,runner}.ts` | 经 `dsh-bosom-friend-server/src/store.ts` 读写产品数据根；若 `dsh-home-paths` 语义或 `DSH_HOME` 解析变化需复核 |
| `server/package.json` | 依赖 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/schemastery` 与 `msedge-tts`。**`dsh-sdk-client` 在 0.1.5 发布闭包里不存在 → 最高优先级核实项** |
| `server/src/*.ts` | import `dsh-host-webserver`、`dsh-invariants`、`dsh-sdk-client`、`schemastery`；`dsh-invariants` 的不变量 API 是 owned relationship 语义，0.1.5 若有调整会直接编译失败（好事，会早暴露） |
| `shim/package.json` | 包名 `@deepseek-ai/dsh-web-frontend` **与 `apps/web` 同名**；必须保持 workspace 排除 `apps/web`（见 1.3） |

### 4.3 版本号与残留

| 文件 | 现状 | 建议 |
| --- | --- | --- |
| `shim/package.json`、`launcher/package.json`、`bundle/app/package.json`、legacy-archive | version 字段写 `0.1.1-rc.2` | 这是**产品自身**版本号却用了**内核**版本号，极易误导（`qa/defects` 已记录版本号分散在 7 个包的缺陷）。建议改为产品版本，并在升级 PR 里一次性说明 |
| `products/bosom-friend/project/pnpm-workspace.yaml` | `catalog` 里 `@deepseek-ai/dsh` / `dsh-tools` / `dsh-scope` 钉在 `0.1.1-rc.2` | **实测该目录下没有任何 package.json 依赖 `@deepseek-ai/dsh`** → 疑似 v2.0 软起步的残留。要么删、要么跟着升到 `0.1.5-rc.2`，不要留半吊子状态 |
| `project/pnpm-lock.yaml` | 引用大量 `0.1.1-rc.2` | 若 catalog 保留则必须重算 |

### 4.4 QA / 门禁里写死的路径与断言

| 文件 | 写死了什么 | 影响 |
| --- | --- | --- |
| `qa/verify-kernel-runtime.mjs` | `C:/Program Files/7-Zip/7z.exe`；userData 目录 `kernel-runtime-v3`（文档 02 写的是 `kernel-runtime`，两者不一致） | 7-Zip 不存在会判红；目录名不一致会让检查落空 |
| `qa/probes/verify-kernel-extract.mjs` | `--real-zip` 真解 385MB；断言 zip 条目路径与最深可读路径 | 新运行时最深路径分布变了，**必须重跑 --real-zip** |
| `qa/parallel/*.mjs`、`qa/acceptance/*.mjs` | `BF_KERNEL_ROOT` 指向 `dist/kernel-runtime-unpacked` | 重新物化后路径不变，无需改 |
| `qa/probes/repair-kernel-runtime.ps1`、`qa/repair-kit/*` | zip 名、解压阶梯、长路径探测 | 与内核版本无关 |
| `qa/reports/*`、`qa/visual-baseline*.json`、`qa/evidence/**` | 大量历史报告与基线截图 | **预期会大面积变红**：内核升级会改变界面细节。要按门禁设计原则**重新基线化并说明原因**，不要静默刷新 |

---

## 5. 风险与不确定性

### 5.1 【实测】已确认的事实（可直接依赖）

1. 基座 `packages/ vendor/ apps/ scripts/ python/ native/` 相对 `dsh-v0.1.1-rc.2` 零改动；冲突面只有根级 6 个文件。
2. `SESSION_FORMAT_VERSION`：本地 `0` → 0.1.5 `3`；`SESSION_QUERY_SQLITE_SCHEMA_VERSION`：两端都是 `8`。
3. 迁移链随 `dsh-session-persistence-jsonl` 自动可用。
4. `defineTool` / `DefineToolOptions` 兼容；`boot` / `installFailLoud` / `loadOptionalPatches` 兼容。
5. `llm-pi-ai` 的 provider 配置字段（displayName / api / apiKeyEnv / baseURL / models / contextWindow / maxTokens）仍在。
6. vendored cordis 需要 4.0.1 → 4.0.2。
7. `dsh-base` 补丁层新增 8 行、移除 2 行，`llm-pi-ai` 行仍在。
8. `apps/web` 与 `shim` 包名相同，workspace 必须排除 `apps/web`。
9. 内核运行时当前由 `pnpm deploy` 物化、内容是 0.1.1-rc.2；zip 约 385MB。

### 5.2 【推断】需要在阶段 1 验证的

1. 把 0.1.5 的包集合照抄进 `bundle/kernel/package.json` 后，`pnpm deploy` 能成功物化（依赖图闭合、无 peer 冲突）。
2. 旧会话日志能自动 v0→v3 迁移（迁移包存在不等于迁移一定成功）。
3. 客户端 UI 包重构不影响产品（产品前端不 import 这些包，只走 JSON-RPC）。
4. Node 版本兼容：本机 node 24.18.0；但**产品打包用的是 Electron 33 自带 node 20.18.3**（文档 02 实测），而发布版 `dsh/package.json` **没有 engines 字段**（实测）→ 内核运行时在 node 20 上能否跑，**未验证**。

### 5.3 【未验证 / 高风险】

| # | 风险 | 为什么危险 | 缓解 |
| --- | --- | --- | --- |
| R1 | `@deepseek-ai/dsh-sdk-client` 在 0.1.5 发布闭包里查不到 | 产品 `server` 直接依赖它；若被删或改名，server 直接编译不过 | fetch 后跑 `git ls-tree -r dsh-v0.1.5-rc.2 packages/sdk` |
| R2 | 发布闭包不等于源码树 | (g) 的包清单对照有**两个方向的系统性偏差**：private 包不发布、非运行时依赖不发布。**不能**据此断言某包被删 | 必须拿到源码 diff 才能定稿 `bundle/kernel/package.json` |
| R3 | 老用户会话数据 | `SESSION_FORMAT_VERSION` 0→3 是一次性磁盘改写；仓库 AGENTS.md 明确不做兼容承诺 | 升级前备份 `~/.bosom-friend`；真机用老数据实测迁移；失败要有明确结论与用户文案 |
| R4 | 内核运行时体积与 MAX_PATH | 现 385MB / 200,537 条目，最深条目已 232 字符；新包集会改变深度分布，DEF-055 就是这么栽的 | 重打 zip 后实测最深路径与长路径用例（`verify-kernel-extract.mjs --real-zip`） |
| R5 | 前端项目 catalog 残留 | 误删或误改可能连带影响前端构建 | 单独一个提交处理，先确认无引用 |
| R6 | 上游 profile 机制取代 bundle 补丁 | `bundle/app` 的 `dsh.bundle.patch` 字段是否仍被解析未验证 | fetch 后读 `packages/boot/app-boot/src/profile.ts` |
| R7 | qa 视觉基线大面积失效 | 会造成门禁全红，掩盖真实回归 | 升级 PR 里显式重新基线化并在报告中写明原因 |

---

## 6. 工作量与建议提交顺序

### 6.1 建议的原子提交序列（每步都能跑门禁）

| # | 提交 | 内容 | 该步门禁 | 预估 |
| --- | --- | --- | --- | --- |
| 1 | `chore: 冻结升级前现场` | 落地在途 `products/` 改动 + backup 分支 + pre-upgrade-worktree.txt | `git status` 干净 | 0.5h |
| 2 | `chore(vendor): 同步 Cordis 4.0.1 → 4.0.2` | 按 `vendor/README.md` 流程 | `pnpm run test && pnpm run build` | 2–4h |
| 3 | `chore: merge upstream dsh-v0.1.5-rc.2` | 步骤 2–3 的 merge 与冲突解，**只动根级 6 个文件** | `pnpm install && pnpm run build && pnpm run typecheck` | 3–6h |
| 4 | `chore(lock): 重算 pnpm-lock` | 单独提交 lock 变化，便于 review | `pnpm install --frozen-lockfile` | 0.5h |
| 5 | `fix(bosom-friend): 适配内核 0.1.5 包集合` | `bundle/kernel/package.json` 依赖清单 + 补丁层 + `kernel/src` 与 `server/src` 的编译修复 | `pnpm run test && pnpm run typecheck && pnpm run lint` + 产品包 build | 1–3 人日（取决于 R1/R2） |
| 6 | `feat(desktop): 内核运行时重新物化` | 把 `pnpm deploy` 固化进 `rebuild-kernel-and-installer.ps1`，加版本断言 | `verify-runtime-deps.mjs` + 运行时版本断言 | 0.5–1 人日 |
| 7 | `chore(qa): 重新基线化并补齐升级探针` | 视觉基线重录 + --real-zip + 老会话迁移探针 | `qa/qa-all.mjs`、`verify-kernel-runtime.mjs` | 1–2 人日 |
| 8 | `release: 0.2.50（内核 dsh-v0.1.5-rc.2）` | 出安装包 + 真机装机实测 + 老数据迁移实测 | 装机可用 + 迁移结论 | 1–2 人日 |
| 9 | `docs: 更新工程经验 02 / 12` | 记录新的启动链路事实与本次踩坑 | `pnpm run doc-sync` | 0.5 人日 |

**合计约 5–10 人日**（不含等 fetch 与等真机的时间），其中 #5 的方差最大，完全取决于 R1/R2 的结论。

### 6.2 低风险探路：先用发布包做一次假升级预演

在拿不到上游源码的情况下，这条路可行，因为：

1. 内核运行时本来就是 `pnpm deploy` 出来的**发布包**（`dist/kernel-runtime-unpacked/node_modules/@deepseek-ai/*` 现在是 0.1.1-rc.2 的发布形态）；
2. 把 `bundle/kernel/package.json` 里的 `workspace:^` 换成 `0.1.5-rc.2` 后，可以直接对着 npm 物化一份运行时；
3. 产品的产品代码只依赖 `dsh-tools` / `dsh-llm` / `dsh-sdk-client` 这几个 API 面，其中两个已核实兼容。

这条路能在**一次都不改基座源码的前提下**回答 R1（dsh-sdk-client 是否还在）、验证内核能否启动、以及老会话能否迁移——代价是与源码树不同步，只适合做探针，不能作为最终形态。

---

## 附：本次调研的证据边界（诚实声明）

- 所有【实测】结论都可在本机复现，命令已写在文中；
- **上游 0.1.5 的源码 diff 完全缺失**：git 对象不在本地，fetch 在 5 分钟预算内未完成；
- 第 2 节 (g) 的包清单对照是全文**最弱**的一节，请以 5.3 的 R2 为前提阅读；
- 本次调研未运行任何构建、未执行 `pnpm install`、未改动任何既有文件。
