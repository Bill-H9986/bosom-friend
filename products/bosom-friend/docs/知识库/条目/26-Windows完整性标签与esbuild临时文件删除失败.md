# 26 · Windows 完整性标签与 esbuild 临时文件删除失败

> 一次生产构建失败被当作「`%TEMP%` 权限问题」排查了三轮：目录可写、探测文件能建能删、
> 手工写 3 MB 再立即删除 100 次全成功 —— 但 esbuild 删同一个目录里的临时文件，**100% 报
> `Access is denied.`**。这篇条目给出这类「权限看起来没问题、特定程序却删不掉」的判据与排查顺序。
>
> **正式记录（证据与逐项明细的家）**：
> - 缺陷台账 `qa/defects/缺陷台账.md` → **DEF-243**（状态与待办）
> - 工作日志 `docs/过程档案/工作日志/工作日志-2026-10-10.md` → **第六十一节**（全部实测数据）
>
> 本篇只保留可复用判据与结论，不复制长报告，避免出现多个需要分别维护的版本。

## 1. 结论

Windows 上「某个程序删不掉文件」不只有 DACL 一种解释。**强制完整性控制（MIC）是独立于 DACL 的强制检查**：
低完整性（Low IL）进程**不能写入或删除中等完整性（Medium）对象**，即使 ACL 明确授予了 Delete 权限。

当**可执行文件本身**带 `Mandatory Label\Low Mandatory Level` 时，由它启动的进程完整性级别会被降到 Low
（Windows 规则：进程 IL = min(token IL, image IL)）。于是出现本条目开头那种「人/Node 能删、它删不掉」的分裂现象 ——
**差别不在权限，而在谁在删**。

## 2. 判据：怎么把 MIC 从「权限问题」里分出来

| 观察 | 指向 |
| --- | --- |
| 同一目录、同一文件，普通 shell / Node 能建能删，只有某个程序失败 | 不是目录 ACL 或可写性 → 查**该程序映像的完整性标签** |
| 失败率是 **100% 确定性**，不是偶发 | 不是竞态、不是杀软扫描窗口（那类通常间歇） |
| 换到全新空目录仍失败，且**错误里的路径跟着换** | 不是目录状态、残留或历史权限 |
| 用等价操作（同尺寸、同命名、写完即删）手工复现**全部成功** | 排除「这类操作本身不可能」 |
| 残留文件**独占打开成功**、事后立即能删 | 不是文件锁或长期占用 |

一条命令定位：

```powershell
icacls <程序.exe> | Select-String 'Mandatory Label'
```

出现 `Low Mandatory Level` 即成候选；再确认它是否被包管理器**硬链接**扩散（硬链接共享安全描述符）：

```powershell
fsutil hardlink list <程序.exe>
```

## 3. 本次的根因链

1. 沙箱给**工作区整棵树**（含 `node_modules`、`src`、`dist`）设置了 Low 完整性标签；
2. pnpm 用**硬链接**从全局 store 注入依赖 → store 里的文件共享同一安全描述符，因此也变成 Low；
3. 带 Low 标签的 `esbuild.exe` → 该进程以 Low IL 运行；
4. esbuild 对 **> 1 MB** 的输入不再走 stdio，而是把内容落盘为 `os.tmpdir()/esbuild-<32 字节随机 hex>`
   （`esbuild/lib/main.js`：阈值 1 MB + `randomFileName`）；文件由 **Node（Medium）** 创建，因此是 **Medium**；
5. **Low 进程删 Medium 文件 → 被 MIC 拒绝** → Go 端 `os.Remove` 报 `remove <path>: Access is denied.`
   （注意这是 **Go 的错误格式**，不是 Node 的 `EACCES: permission denied, unlink`）；
6. 检查是确定性的，所以失败率 100%。

**决定性对照**（同一份代码、同样存在 3 个 > 1 MB chunk）：把 `TEMP` 指向**工作区内（Low）**目录 → 构建**成功**；
用系统 `%TEMP%`（Medium）→ 构建**失败**。

> 换句话说：**TEMP 必须与可执行文件处于同一（或更低）完整性级别的目录**，esbuild 才删得掉自己那份临时文件。

## 4. 排查顺序（可复用）

1. **不要先怀疑 `%TEMP%` 权限** —— 先用自建探测文件验证当前用户在该目录建 / 写 / 删；
2. 拿**最小复现**（直接调 esbuild）确认是否 100% 确定性失败；
3. `icacls` 看**程序映像**的 `Mandatory Label`，`fsutil hardlink list` 看它是否被包管理器硬链接扩散；
4. 看**失败信息是谁的格式**：Go 的 `remove …: Access is denied.` ≠ Node 的 `EACCES … unlink`；
5. 做**同代码、单变量对照**（只换 TEMP 位置）—— 这比继续叠加权限测试有效得多。

## 5. 边界（不得越界表述）

- 本篇记录的是**本机实测**：标签、硬链接与两组构建对照均可复现；**进程 token 的实际完整性级别未直接测量**
  （由映像标签按 Windows 规则推断）。
- 标签的**施加者**未直接观测，与沙箱行为吻合属**推断**。
- 未验证**移除或调整标签后**生产构建是否恢复。
- 修复方向（调用侧把 `TEMP` 指到工作区内，或在脚本内重定向 TEMP）**尚未实施**；
  调整系统完整性标签属系统安全配置变更，风险最高，须单独评估授权。

## 5.5 项目内先例与修复路径（重要）

同一机制在本项目**已经出现过两次**，且都有已验证的修复：

| 缺陷 | 受害者 | 症状 | 修复 |
| --- | --- | --- | --- |
| **DEF-202** | `.venv\Scripts\python.exe` / `pythonw.exe` | 低完整性写不了中完整性的数据目录 → 引擎 `PermissionError`、「发布卡在 starting」「登录不了」 | `icacls <venv python> /setintegritylevel Medium` |
| **DEF-204** | `patchright\driver\node.exe` + `venv\Scripts` 下 11 个 exe | 低完整性写不了中完整性 TEMP → `BrowserType.launch: EPERM … mkdtemp playwright-artifacts-*` | `icacls … /setintegritylevel Medium /T`（410 + 18 文件） |
| **DEF-243（本条目）** | `node_modules` 下的 `esbuild.exe`（经 pnpm 硬链接扩散到 store） | > 1 MB 输入落盘的临时文件删不掉 → 生产构建失败 | **已修复并验收（2026-10-10）**：`icacls <esbuild.exe> /setintegritylevel Medium` —— **单文件、无 `/T`**；硬链接共享安全描述符，故 store 侧同步变为 Medium。验收：正常 `%TEMP%` 下生产构建**退出码 0**，`%TEMP%` 残留 32 → 32 未新增 |

**为什么第三个被漏掉**：DEF-204 已经要求「交付前必须纳入安装自检：**逐个检查工作区内可执行文件的完整性级别**」，
但该自检**未覆盖 `node_modules`**；而 pnpm 又用**硬链接**把 store 里的文件与项目里的文件绑成同一安全描述符 ——
只检查「自己安装的运行时目录」不足以覆盖「包管理器注入的可执行文件」。

> **可复用教训**：自检范围必须包含**包管理器注入的可执行文件**（`node_modules`、`.pnpm`、`vendor`），
> 并意识到**硬链接会让标签在 store 与项目之间共享**。

## 5.6 退出码不可信：先看产物

本轮另一个独立发现（已立 **DEF-244**）：`use-frontend-build.ps1 -Source` 的退出码**恒为 1**，
即使 vite 已完整产出。原因是该脚本第 31 行 `… 2>&1 | Select-Object -Last 4` 把 vite 写在 stderr 的进度行
变成 ErrorRecord，与第 22 行 `$ErrorActionPreference = 'Stop'` 叠加后脚本在管道处中止，
`exit $LASTEXITCODE` 从未执行。

> **判据**：当「退出码非 0」但**产物完整**（入口 chunk、`index.html`、引用可解析、0 零字节文件）时，
> 先怀疑**采集退出码的那一层**，而不是构建本身。本项目 `dev-web.ps1:49-55` 早已用注释记录同一陷阱并规避。

## 6. 来源

- `qa/defects/缺陷台账.md` → DEF-243
- `docs/过程档案/工作日志/工作日志-2026-10-10.md` → 第六十一节
- `analysis/_repro/DEF243-环境排查报告.md`，以及同目录的构建日志、残留 SHA-256 清单

---

**关联条目**：`04-缺陷台账与根因方法论`、`06-测试有效性专题`、`12-常见坑速查表`
