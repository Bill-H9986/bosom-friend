# 发布报告 0.2.50（内核 dsh-v0.1.5-rc.2）

- 日期：2026-09-16
- 产品版本：0.2.50（权威来源 `products/bosom-friend/desktop/package.json`）
- 内核：`dsh-base` **0.1.5-rc.2**，`SESSION_FORMAT_VERSION = 3`（升级前 0.1.1-rc.2 / 0）
- 出包链：`products/bosom-friend/desktop/rebuild-kernel-and-installer.ps1`（8 步，自带闸门）

## 产物

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `desktop/release/0.2.50/BosomFriend-Setup-0.2.50.exe` | **997.7 MB** | NSIS 安装包，已复制到桌面 |
| `desktop/dist/kernel-runtime.zip` | **414.5 MB / 195,471 条目** | 升级前那份可用包是 384.9 MB / 200,537 条目 |

安装包 SHA256：`335E2BD3790492044612723765687D4E3338CB751D18F70A6C97EDB5F8F3F4C2`；
包内自带解压器与仓库副本一致（`4E7424E6FE885519877AF15AEFC5C033CC68F9B7CA574AD8BC302B5D41977471`）。

## 验收证据（全部本机实测）

| # | 判据 | 结果 |
| --- | --- | --- |
| 1 | 出包链第 5 步：重打 zip（展开联接点 + 补齐扁平层） | ✅ 195,471 条目 / 414.5 MB（压缩 1440 秒） |
| 2 | 出包链第 6 步：**解压新 zip 后真握手** | ✅ `HANDSHAKE PASS` → `{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}` |
| 3 | 装机：静默安装 | ✅ `INSTALLED_PACKAGE PASS checks=13 fail=0`（安装器解压 195,471 文件；注册表 `Bosom Friend 0.2.50`；无 `kernel-extract.log`） |
| 4 | 装机后运行时身份 | ✅ `SESSION_FORMAT_VERSION = 3`；顶层含 `dsh-sdk-client` 与 `dsh-bosom-friend-server`（主进程要按绝对路径加载） |
| 5 | **安装版真启动（默认端口 31280）** | ✅ 9 秒进产品页（`http://127.0.0.1:31280/bosom-friend/`；截图 `qa/evidence/启动页-进度条-安装版默认端口进入产品页.png`，该目录被 `.gitignore` 忽略，属本机证据） |
| 6 | 老数据兼容（**数据根副本**上跑） | ✅ 用真实 `~/.bosom-friend` 的副本启动，产品页正常、老会话日志原样未改写（v0 文件保持不动、无损坏） |
| 7 | 迁移链本身 | ✅ 基座 `packages/session/session-format*` + `session-persistence-jsonl`：**32 文件 / 1260 用例通过** |
| 8 | 内核工具与运行时契约 | ✅ `KERNEL_RUNTIME_VERIFY PASS`、`KERNEL_EXTRACT PASS checks=47`、`M2_KERNEL_HOST_OK` |

## 关键结论：老会话 v0→v3 迁移为什么没有发生（如实记录）

产品的 AI 对话每次都发 `ai-chat-<Date.now()>` 这个**新** id（`server/src/kernel-client.ts`），而 SDK 的
`session/prompt` 是**创建**语义（对已存在 id 回 `-32603 session already exists`）。也就是说：产品正常使用中
不会重新打开旧的 DSH 会话日志，v0→v3 迁移自然不会触发。实测也确认老日志在升级后原样留在盘上、没有损坏，
产品页与业务数据一切正常。迁移链本身由基座测试覆盖（上表第 7 行）。

## 仍未绿的两盏灯（不掩盖）

| 灯 | 原因 | 记录 |
| --- | --- | --- |
| 门禁「启动页进度条」场景 A/C | 探针用 `BF_DESKTOP_PORT` 做端口隔离，而桌面 bundle 补丁把端口写死 31280：服务其实起在 31280 上（实测 15 秒内可访问），探针却等隔离端口 | **DEF-060**（P2 / Open） |
| 门禁「内核握手超时」 | 同上：应用连 31297，服务在 31280，于是快速失败而不是走到超时分支 | 同上 |
| 门禁「数据编码完整性」 | `%USERPROFILE%\.bosom-friend` 里一份**旧的**知识库导入副本有编码损坏（仓库外，非本次改动） | 待处理 |

本轮用「默认端口」方式补做了安装版真启动验收（上表第 5 行），所以这两盏红灯不影响本版发布判据，但探针本身要修。

## 回滚

- 内核 zip：`desktop/dist/kernel-runtime.zip.bak-<时间戳>`（含升级前那份 `kernel-runtime.zip.bak-0.1.1`）；
- 安装包：`desktop/release/0.2.49/BosomFriend-Setup-0.2.49.exe`；
- 仓库：分支 `fix/ai-autopublish`，升级前的分支状态 `95fd7a62`，离线备份 `Desktop\bosom-friend-kernel-0.1.5-work.bundle`。

来源：本轮出包链日志（`%TEMP%\chain4.log`）、`verify-installed-package.ps1 -Install`、`verify-splash-progress.mjs --packaged`、
默认端口启动实测脚本、`pnpm vitest run packages/session/session-format*`、`qa/defects/缺陷台账.md`（DEF-058~061）。