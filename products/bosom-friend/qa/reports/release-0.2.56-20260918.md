# 装机验收：Bosom Friend 0.2.56（2026-09-18）

## 被测产物

| 项 | 值 |
| --- | --- |
| 安装包 | `BosomFriend-Setup-0.2.56.exe`（742.8 MB / 778,899,443 B） |
| SHA256 | `C939B09FF220A24B7BBBCB4FE577BF694A1B01362F4D60DB65CE2621C72AACAF` |
| 本版改动 | 内核运行时改为扁平树打包（zip 419.3MB → 62.5MB，条目 195,539 → 23,297）；安装包 1004.3MB → 742.8MB |
| 前置 | 先装过 0.2.53；本次为覆盖安装（修复安装），真实数据根 `%USERPROFILE%\.bosom-friend`（7.3GB）保留 |

## 静默安装

`BosomFriend-Setup-0.2.56.exe /S` → **exit 0，213.8 秒**（含删除旧版 195,539 文件的运行时、重新解压 23,297 文件、以及一次 UAC 长路径开关；本机 `LongPathsEnabled` 已为 1）。

| 装机事实 | 实测 | 期望 |
| --- | --- | --- |
| 注册表 DisplayName / DisplayVersion | `Bosom Friend 0.2.56` / `0.2.56` | 与 `desktop/package.json` 一致 |
| `%APPDATA%\Bosom Friend\kernel-runtime` | **23,297 文件 / 220 MB** | 与 `dist/kernel-runtime-flat` 条目数一致（新口径） |
| `runtime\bin-desktop.mjs` | 存在 | 在 |
| `resources\kernel-runtime.zip` | **已删除** | 安装器解压成功即删（省 62.5MB） |
| 安装目录 | 2,365 MB | — |

## 验收结果

| 探针 | 结果 | 关键数据 |
| --- | --- | --- |
| `verify-installed-package.ps1` | **PASS checks=7 fail=0** | 随包解压器解开随包 zip：`UNZIP_OK files=23297 bytes=230704907 deepest=134 ms=28548`（0.5 分钟） |
| `verify-splash-progress.mjs --packaged` | **PASS checks=8 fail=0** | 采样 137 次；阶段序列 `检查运行环境 2% → 清理旧版运行时残留 12% → 校验内核运行时 30% → 启动内核服务 80% → 加载产品界面 100%`；最终进入产品页 |
| `verify-installed-logging.ps1` | **PASS checks=6 fail=0** | 主进程 boot / kernel spawn / health / 产品侧 `[boot] server` 四条留痕齐全 |
| `verify-installed-compose.mjs` | **PASS** | 随包 ffmpeg 解析到 `resources\runtime\ffmpeg.exe`；拼接与字幕烧录成功，成片 1080x1920 / 24fps |
| `verify-installed-ai-business.mjs` | 首轮 6 passed / 1 failed，**重跑通过** | 见下 |
| `verify-uninstall-residue.ps1`（本版新建） | **PASS checks=19 fail=0** | 干净卸载 20.7 秒；用户数据根 6,369 文件 / 7,623,966,521 字节逐字节存活；重装 157.3 秒、23,297 文件与打包源一致；重装后启动页 8/8 与日志 6/6 复测通过 |

## 那一条失败：AC-018-1「打开知识库。」（已定性为模型侧偶发）

首轮：`说「打开知识库。」拿到 navigateToKnowledge 导航卡` 在 180 秒断言窗口内没等到卡片（该用例耗时 3.4 分钟）。同一轮里其它 6 条真实模型用例全过，包括同一 describe 下的 `navigateToDatacenter` / `navigateToDraft` / `navigateToMonitor` 三条同类导航卡。

排查（全部实测）：

1. **不是本版改动**：0.2.56 的改动只在打包脚本、文档与注释（`flatten_kernel_tree.py`、`repack_kernel.py`、`rebuild-kernel-and-installer.ps1`、`main.cjs` 注释、`installer.nsh` 注释），内核与服务端代码逐字节未变——装机版 `kernel-runtime/node_modules/@deepseek-ai/dsh-bosom-friend-server/lib/types/api.js` 与工作区构建产物 **SHA256 SAME**；
2. **服务端映射在**：装机版 `api.js` 含 `navigateToKnowledge` 与知识库匹配模式 `/知识库|笔记库|素材库/`（`server/src/api.ts:190`，且该分支不依赖模型答得上来：`NAVIGATE_VERB` 命中即回卡）；前端 `executePublishAction.ts:13` 的 `NAVIGATE_ROUTES.navigateToKnowledge = '/knowledge'` 也在；
3. **同一用例重跑 24.8 秒通过**（`1 passed`），说明卡片产出路径是通的；失败那次是模型未在窗口内产出可识别回复；
4. 该 spec 自己在 2026-09-13 就记录过同类现象（注释：「服务端已产出 navigateToKnowledge，断言却在 120 秒到点判红」），并为此把三次调用拆成三条独立用例。

**结论与处置**：既有偶发（端到端用例夹了一次真实模型调用，模型慢/未给可识别动作时断言在窗口内判红），非 0.2.56 引入的回退。判定依据是「装机版服务端产物与工作区逐字节相同」+「同用例重跑通过」。

**这一版把它钉死了**：新增 `server/test/functional/agent-navigate-intent.spec.ts`——用内核桩固定模型回复，只让服务端自己的意图判定起作用，逐个断言七个功能页的说法各产出哪张导航卡，并要求创作需求一张导航卡都不产出。实测 **8 passed / 2.60 秒**（同一批断言在端到端要跑 7 分钟且受模型影响）。今后模型侧的偶发再也掩盖不了服务端的确定性：那条端到端用例红了，先看这个 spec 是绿是红就能分辨是产品缺陷还是模型偶发。

## 随本版一起更新的门禁

`qa/probes/verify-installed-package.ps1` 的「内核运行时由安装器解压」判据原来写死 `files > 150000`。0.2.56 起条目数是 23,297，这条会把「打包变好了」误判成红，已改为按版本分档：`>= 0.2.56` 用 `> 20000`，更早版本仍用 `> 150000`。

## 附带收益（实测）

- 随包解压器解开内核 zip：**28.5 秒**（旧包同一步实测 3.7 分钟）；
- 解压后最长路径 134 字符（旧包解压后有 ~290 字符的路径，是长路径支持的根源），长路径依赖明显减轻；
- 装机后内核运行时占 220 MB（旧版 1,190 MB）。

## 卸载/重装循环（已完成）

`qa/probes/verify-uninstall-residue.ps1`（本版新建，可复用）跑完整循环：

| 阶段 | 实测 |
| --- | --- |
| A 卸载前 | 无残留进程；安装目录 / 两个快捷方式 / 注册表项都在；用户数据根 6,369 文件 / 7,623,966,521 字节 |
| B 静默卸载 | exit 0，20.7 秒 |
| C 卸载后 | 安装目录、桌面快捷方式、开始菜单快捷方式、注册表项、`%APPDATA%\Bosom Friend` 全部消失；无进程残留；**用户数据根逐字节一致**（文件数、字节数、清单 SHA256 三者都比对） |
| D 重装 | exit 0，157.3 秒；`runtime\bin-desktop.mjs` 在；内核运行时 23,297 文件 = 打包源 23,297；桌面快捷方式恢复 |
| D 复测 | 重装后启动页 8/8、日志 6/6 再次通过 |

**合计 19 项断言全 PASS，0 失败。**

来源：本轮实测输出、`qa/probes/*`、`qa/reports/splash-progress-2026-09-18T11-29-54.md`、`qa/reports/installed-ai-business-2026-09-18T11-37-41.md`。
