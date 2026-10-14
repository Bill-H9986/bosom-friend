# 发布报告 0.2.51（内核 dsh-v0.1.5-rc.2，端口隔离修复版）

- 日期：2026-09-16
- 产品版本：0.2.51（权威来源 `products/bosom-friend/desktop/package.json`）；0.2.50 之后修掉 DEF-060 与两个探针假红
- 内核：`dsh-base` 0.1.5-rc.2，`SESSION_FORMAT_VERSION = 3`

## 产物

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `desktop/release/0.2.51/BosomFriend-Setup-0.2.51.exe` | 997.7 MB | SHA256 `1301D7A736168D65F9F2F006705CB6A76A413FE22A33890670B6E5C243329E0E`，已复制到桌面 |
| `desktop/dist/kernel-runtime.zip` | 414.5 MB / 195,471 条目 | 与 0.2.50 同规模 |

## 本版修的三件事

1. **DEF-060 真因**：注入副本按 (名字, 版本, peer 集合) 缓存——改了 `bundle/desktop/cordis.patch.yml` 却没提版本号，
   `pnpm install` 不刷新 `.pnpm/<id>/` 里的副本，运行时加载的还是旧配置（端口写死 31280）。
   修法：端口改 `!!js Number(process.env.BF_DESKTOP_PORT ?? 31280)` + desktop-bundle 版本 0.2.0 → 0.2.1。
   实测 `PORT_ISOLATION PASS`（`BF_DESKTOP_PORT=31299` 时只有 31299 在听）。
2. **新增配置漂移红线** `desktop/verify-runtime-config-drift.mjs`：逐字节比对三个补丁层与部署根入口的配置、
   并核对包版本，接进出包链第 3 步之后。它在本轮真的红过一次（运行时里是 0.2.0 的旧补丁）。
3. **两个探针假红**：`verify-splash-progress.mjs` 场景 B 现在接受「冷启动自己拉起内核并进入产品页」，
   失败分支断言记 SKIP（SKIP ≠ PASS）；`verify-kernel-handshake-timeout.mjs` 改用桩入口构造「永不回应」。

## 验收（本机实测）

| # | 判据 | 结果 |
| --- | --- | --- |
| 1 | 出包链 8 步（含配置漂移检查） | ✅ 全绿；第 6 步 `HANDSHAKE PASS` |
| 2 | 静默安装 + 装机核对 | ✅ `INSTALLED_PACKAGE PASS checks=13 fail=0`（注册表 0.2.51、解压 195,471 文件、无失败日志） |
| 3 | 安装版默认端口启动 | ✅ 9 秒进产品页 |
| 4 | 启动页进度条（开发态 A + 冷启动 B） | ✅ `SPLASH_PROGRESS PASS checks=15 fail=0 skipped=3` |
| 5 | 内核握手超时（桩入口） | ✅ `KERNEL_HANDSHAKE PASS checks=3 fail=0`（8.0 秒按预算抛错） |
| 6 | 内核运行时契约 | ✅ `KERNEL_RUNTIME_VERIFY PASS`、`KERNEL_EXTRACT PASS checks=47`、`M2_KERNEL_HOST_OK` |
| 7 | 迁移链（基座） | ✅ `packages/session/session-format*` 32 文件 / 1260 用例通过 |

## 门禁现状

「启动页进度条」「内核握手超时」两盏红灯已转绿。剩余一盏红灯「数据编码完整性」在仓库外：
`%USERPROFILE%\.bosom-friend` 里一份**旧的**知识库导入副本有编码损坏（产品数据，不是本次改动）。

## 回滚

- 上一版安装包：`desktop/release/0.2.50/BosomFriend-Setup-0.2.50.exe`（0.2.49 也在）；
- 内核 zip：`desktop/dist/kernel-runtime.zip.bak-<时间戳>`（含升级前的 `kernel-runtime.zip.bak-0.1.1`）；
- 仓库：分支 `fix/ai-autopublish`，升级前状态 `95fd7a62`，离线备份 `Desktop\bosom-friend-kernel-0.1.5-work.bundle`。

来源：`%TEMP%\chain5.log`、`verify-installed-package.ps1 -Install`、`verify-splash-progress.mjs --both`、
`verify-kernel-handshake-timeout.mjs`、`verify-runtime-config-drift.mjs`、`qa/defects/缺陷台账.md`（DEF-058~061）。