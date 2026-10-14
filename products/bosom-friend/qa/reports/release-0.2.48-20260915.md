# 发布记录 · Bosom Friend 0.2.48（2026-09-15）

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | `products/bosom-friend/desktop/release/0.2.48/BosomFriend-Setup-0.2.48.exe` |
| 桌面副本 | `C:\Users\Jay\Desktop\BosomFriend-Setup-0.2.48.exe` |
| 大小 | 977,460,196 字节（932.2 MB） |
| SHA256 | `C1F8BF59D4DB97C1F339065C118CD833E20B75F3E7C98E0EE10410AB1D4A6F5A`（同时写在同目录 `sha256.txt`） |
| 构建时间 | 2026-09-15，`rebuild-kernel-and-installer.ps1` 六步全绿：内核构建 → 同步 lib 进运行时（含 `.pnpm` 第二份副本）→ 依赖核对 → 组装便携引擎（17,240 文件 / 1,951.8 MB）→ 重打 `kernel-runtime.zip`（384,896,412 字节）→ electron-builder（NSIS 编译 + 签名流程 + blockmap） |
| 版本来源 | `desktop/package.json` = 0.2.48（唯一权威来源）；`Bosom Friend.exe` FileVersion = 0.2.48 |
| 安装结果 | 静默安装 `/S` **exit 0**；注册表 `DisplayName = Bosom Friend 0.2.48`；安装目录内 `resources\kernel-unzip.cjs` 已就位 |

## 本轮内容（详见 CHANGELOG [0.2.48]）

- **DEF-055**：内核运行时解压不再依赖系统工具与系统设置。新增纯 Node 解压器
  `desktop/electron/kernel-unzip.cjs`（ZIP64 + 逐条 CRC + zip-slip 防护 + 显式 `\\?\` 前缀）；
  阶梯改为"长路径可用时 tar 优先，不可用时自带解压器优先"；安装器（`resources\runtime\node.exe` +
  `resources\kernel-unzip.cjs`）与主进程共用同一份实现。
- **DEF-056**：解压失败文案改成取 `stderr` 末行（真实异常），完整事实落
  `%APPDATA%\Bosom Friend\kernel-extract.log`；错误框保持脱敏。
- **Added**：现场修复包（`qa/repair-kit/` + 生成器 `qa/make-repair-kit.ps1`），双击完成"提权开长路径 + 自带解压器展开运行时"。
- **Changed**：每一步的成败判据从"退出码 0"改成"运行时入口 `runtime/bin-desktop.mjs` 在位"；首次启动解压显示真实 `N/M` 进度。

## 包内实测：`qa/probes/verify-installed-package.ps1 -Install` → **13/13 PASS**

这个探针是本轮新增的常设资产（此前"装包实测"每次都是手工一次性动作，台账上长期写着"待出包后补"）。
它先用**安装包里那份** `node.exe` + `kernel-unzip.cjs` 解**包内那份** zip，再静默安装并检查安装结果。

| 检查 | 结果 |
| --- | --- |
| 安装包存在 / FileVersion / SHA256 | PASS：932.2 MB、0.2.48、`C1F8BF59…` |
| 打包产物带自带解压器，且与仓库那份逐字节相同 | PASS：`kernel-unzip.cjs` SHA256 `4E7424E6…`（两边一致） |
| 打包产物带 `runtime\node.exe` | PASS |
| **包内解压器解包内 zip**（安装器将要跑的同一命令行） | PASS：`exit=0`、**200,537 个文件**、216.7 秒（3.6 分钟） |
| 静默安装 | PASS：`exit 0` |
| 注册表 DisplayName | PASS：`Bosom Friend 0.2.48` |
| 安装后的 `Bosom Friend.exe` 版本 | PASS：0.2.48 |
| 安装后 `resources\kernel-unzip.cjs` | PASS |
| 安装器把内核运行时解到位 | PASS：**200,537 个文件** + `runtime\bin-desktop.mjs` 在位 |
| 没有解压失败日志（说明运行时确实出自安装器，不是应用兜底） | PASS：`kernel-extract.log` 不存在 |

## 安装版启动实测

| 检查 | 结果 |
| --- | --- |
| 启动页进度条 / 百分比单调 / 阶段推进 / 进入产品页（`verify-splash-progress.mjs --packaged`） | **8/8 PASS**：留痕走完 `检查运行环境 2% → 6% → 清理旧版运行时残留 12% → 校验内核运行时 12% → 30% → 启动内核服务 30% → 80% → 加载产品界面 100%`，**最终进入产品页**；报告 `qa/reports/splash-progress-2026-09-15T05-03-44.md` |
| 解压进度上报（真实 `N/M`） | 由 45 项探针断言覆盖；本机安装走 tar 快路，未在装机过程触发 |

## 未做（如实）

1. **干净机器与低配机（4 核 / 7.9GB）未实测**：需要外部机器；现场修复包与 0.2.48 包都已就绪，等那台机器上的一次双击。
2. **安装器的"自带解压器分支"未在真机触发**：本机有 `System32\tar.exe`（长路径也是开的），安装期走的是 tar 快路。
   该分支的可用性由三件事覆盖：NSIS 编译通过、`verify-installed-package.ps1` 用包内文件跑通同一条命令行、
   探针断言"安装器在 Python 之前调用自带解压器"。
3. **未跑全量门禁**：本轮只跑了与改动直接相关的检查，结果如下（都真跑过）：

   | 检查 | 结果 |
   | --- | --- |
   | `qa/probes/verify-kernel-extract.mjs` | **45/45 PASS**（阶梯两种顺序、长路径真解与回读、CLI 契约、修复包不变量、出包脚本带上解压器） |
   | `qa/probes/verify-installed-package.ps1 -Install` | **13/13 PASS** |
   | `qa/probes/verify-splash-progress.mjs --packaged` | **8/8 PASS**（安装版 0.2.48 进入产品页） |
   | `qa/verify-product-version.mjs --strict-installed` | **PASS**（注册表 `Bosom Friend 0.2.48` = `desktop/package.json`） |
   | `qa/verify-kernel-runtime.mjs` | **PASS**（复核时修掉一条过宽规则：启动器自带的 `config/desktop.cordis.yml` 本就随包，见工作日志） |
4. **卸载实测未重跑**：卸载钩子本轮未改动。
5. **读取侧长路径仍未闭环**：解压已不依赖系统设置，但 Node/libuv 读 >260 的运行时文件仍需要
   `LongPathsEnabled=1`；0.2.48 的取舍是"现场修复包负责开它 + 安装期文案说明"，见
   `docs/工程经验/02-启动链路与内核运行时.md`。

## 证据文件

- 验收探针：`qa/probes/verify-installed-package.ps1`（新增）、`qa/probes/verify-kernel-extract.mjs`（45 项）
- 现场修复包：`qa/repair-kit/`、生成器 `qa/make-repair-kit.ps1`
- 知识库：`docs/工程经验/02-启动链路与内核运行时.md`、`12-常见坑速查表.md`、`05-诚实性缺陷专题.md`
- 台账：`qa/defects/缺陷台账.md`（DEF-055 / DEF-056）
