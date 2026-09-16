# 发布记录 · Bosom Friend 0.2.49（2026-09-15）

## 一句话

0.2.48 让"解压"不再依赖用户机器上的任何设置；**0.2.49 让"装完能开"也不再需要用户动手**——安装器检测到
Windows 长路径支持没开时，弹**一次**管理员授权把它打开，并在安装日志里写明结果。

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | `products/bosom-friend/desktop/release/0.2.49/BosomFriend-Setup-0.2.49.exe` |
| 桌面副本 | `C:\Users\Jay\Desktop\BosomFriend-Setup-0.2.49.exe` |
| 大小 | 932.2 MB（与 0.2.48 同量级） |
| SHA256 | `6178380A0C93F5D6A7C1C00B43FF8D21A674445AA917F0BA387003415A39BB89`（同目录 `sha256.txt`） |
| 构建 | `rebuild-kernel-and-installer.ps1` 六步全绿（内核构建 → 同步 lib → 依赖核对 → 组装引擎 → 重打 zip → electron-builder） |
| 版本来源 | `desktop/package.json` = 0.2.49；安装后 `Bosom Friend.exe` FileVersion = 0.2.49 |
| 安装结果 | 静默安装 `/S` **exit 0**；注册表 `DisplayName = Bosom Friend 0.2.49`；安装目录含 `resources\kernel-unzip.cjs` |

## 本轮内容（详见 CHANGELOG [0.2.49]）

`installer.nsh` 在解压阶梯**之前**新增一段：

1. `ReadRegDWORD` 读 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`；
2. 不是 1 → 非静默安装才 `ExecShell "runas" "$SYSDIR\reg.exe" add ... /d 1 /f`（一次 UAC）；
3. **轮询注册表直到真的读到 1**（每秒一次，最多 30 秒）才算成功——"命令跑过"不是成功；
4. 30 秒仍未生效 → 写安装日志 + 弹一条明确提示（内置运行时仍已装好，并给出下一步）；
5. 静默安装（`/S`）不弹 UAC，只留一行日志。

## 包内实测：`qa/probes/verify-installed-package.ps1 -Install` → **13/13 PASS**

| 检查 | 结果 |
| --- | --- |
| 安装包 FileVersion / SHA256 | PASS：0.2.49 / `6178380A…` |
| 打包产物带自带解压器且与仓库逐字节相同 | PASS：`4E7424E6…` |
| **包内解压器解包内 zip**（安装器同一条命令行） | PASS：`exit=0`、**200,537 文件**、204.2 秒（3.4 分钟） |
| 静默安装 | PASS：`exit 0` |
| 注册表 DisplayName / 安装后 exe 版本 | PASS：`Bosom Friend 0.2.49` / 0.2.49 |
| 安装后 `resources\kernel-unzip.cjs` | PASS |
| 安装器把内核运行时解到位 | PASS：**200,537 文件** + `runtime\bin-desktop.mjs` |
| 没有 `kernel-extract.log`（运行时出自安装器而非应用兜底） | PASS |

## 新增的长路径这一步：三层验证

| 层级 | 证据 |
| --- | --- |
| 编译 | 用 electron-builder 缓存里的 `makensis 3.0.4.1` 把 `installer.nsh` 连同 `!insertmacro customInstall` 编成一次性脚本 → **exit 0**（顺手抓到一个真错误：NSIS 字符串里 `\"` 不转义引号，改用单引号字符串） |
| 逻辑（不碰真注册表） | 复制同一段逻辑、把键换成一次性 `HKCU` 测试键、去掉 `ExecShell`：值始终为 0 → **`branch=denied seconds=30`**（30 秒到点退出，**不挂死**）；预置为 1 → 立即走"已开启"分支 |
| 真注册表（不弹 UAC，因为本机 shell 已是管理员） | 先把 `LongPathsEnabled` 置 0 → 跑同一段真实代码（含 `ExecShell "runas"` + `reg.exe add`）→ **注册表真的变成 1**、结果文件 `branch=enabled seconds=1` |

**唯一没法在开发机上验的**：UAC 弹窗本身需要人去点。这一步的效果由上面第三层（真注册表 0→1）覆盖；
弹窗行为只在目标机器上能观察到——装 0.2.49 时应当出现**一次**"是否允许…"的提示。

## 安装版启动实测

**8/8 PASS**（`qa/reports/splash-progress-2026-09-15T05-49-01.md`）：进度条出现、百分比单调不减、
阶段按序推进 `检查运行环境 2% → 6% → 清理旧版运行时残留 12% → 校验内核运行时 12% → 30% → 启动内核服务 30% → 80% → 加载产品界面 100%`、
**最终进入产品页**。

## 未做（如实）

1. **干净机器 / 那台 4 核 7.9GB 机器未实测**：0.2.49 就是为它准备的（一次安装、一次 UAC、无需修包）。
2. 全量门禁、卸载实测未重跑（本轮改动只在 `installer.nsh` 与版本/文案）。
3. 安装器"取不到授权"时的提示文案只在静默/自动化路径下被验证过逻辑，未在真机上被人为拒绝过。

## 证据文件

- 探针：`qa/probes/verify-installed-package.ps1`（13 项）、`qa/probes/verify-kernel-extract.mjs`（47 项，含两条新安装器不变量）
- 安装器：`desktop/build/installer.nsh`、`desktop/build-win.sh`、`desktop/electron/kernel-unzip.cjs`
- 知识库：`docs/工程经验/02-启动链路与内核运行时.md`、`12-常见坑速查表.md`
- 台账：`qa/defects/缺陷台账.md`（DEF-055 / DEF-056）
