# Bosom Friend 桌面 APP 审计报告（标准版）

> 审计日期：2026-08-29　｜　方法：先学习行业标准（官方文档条款），再逐项取证审计。

## A. 审计采用的标准依据（学习成果）

| 编号 | 标准 | 来源 |
| --- | --- | --- |
| S1 | Electron Security Checklist（contextIsolation、nodeIntegration=false、sandbox、CSP、限制导航/新窗口、禁用远程内容执行） | Electron 官方文档 |
| S2 | Electron Process Model（主进程/渲染/预加载分层；渲染层零 Node 访问） | Electron 官方文档 |
| S3 | electron-builder 打包规范：appId/productName/icon 多尺寸、NSIS、代码签名、publish/updater | electron-builder 官方文档 |
| S4 | OWASP Desktop Application Security Top 10（本地数据保护、注入面、凭据最小化） | OWASP 官方 |
| S5 | Windows 桌面应用分发标准：签名证书、卸载项、升级保留用户数据、应用身份 | Microsoft Learn |
| S6 | 通用软件工程：单一版本源、可重复构建、自动化测试、许可证随包、日志诊断 | 行业惯例 |

## B. 逐项审计（标准条款 → 现状 → 证据 → 判定）

### 安全（S1/S4）

| # | 标准要求 | 现状 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| B1 | contextIsolation=true | 窗口壳已设 | eb-project/main.js | ✅ |
| B2 | nodeIntegration=false | 已设 | main.js | ✅ |
| B3 | 限制新窗口（setWindowOpenHandler deny） | 已实现 | main.js | ✅ |
| B4 | 渲染层不加载远程/不可信内容；设置 CSP | 加载本机服务，未设 CSP 头 | serveSpa | ⚠️ P2 |
| B5 | 显式 sandbox/最小权限 | 未显式 sandbox:true | main.js | ⚠️ P2 |
| B6 | 本地数据保护、密钥最小化、零外发 | 密钥仅内存/localStorage、独立数据根、ACL收紧、零外发实测 | security.ts + probe-net | ✅ |

### 架构（S2）

| B7 | 主进程负责生命周期与单实例 | 缺失单实例锁 | main.js | ⚠️ P0 |
| B8 | preload 受控桥 | 无（渲染层为本地 Web URL，符合最小桥；扩展前为缺口） | — | ⚠️ P1 |
| B9 | 后端进程职责独立 | 独立 Node 进程（ELECTRON_RUN_AS_NODE） | main.js | ✅ |

### 打包发布（S3/S5）

| B10 | appId/productName/artifactName | 已配置 | package.json | ✅ |
| B11 | 多尺寸应用/安装器图标 | 默认 Electron 图标 | win-unpacked | ❌ P0 |
| B12 | NSIS 向导/目录选择/卸载项 | 实测通过 | 安装测试记录 | ✅ |
| B13 | 升级路径（保留用户数据） | 无升级链 | — | ❌ P1 |
| B14 | 数字签名 | 自签（signtool dev 证书），无正式证书 | 构建日志 | ⚠️ P1 |
| B15 | 离线自包含 | 依赖链接式/首次联网 | 多项实测 | ❌ P0（最大差距） |
| B16 | 版本单源 | 0.13.5 多处硬编码 | 构建链 | ⚠️ P1 |

### 数据与隐私（S4/S5）

| B17 | 零遥测/数据不出网 | 实测零外发 | probe-net | ✅ |
| B18 | 独立数据根/可备份/可迁移 | ~/.bosom-friend/ + 自动备份/完整性自检 | security.ts | ✅ |
| B19 | 卸载保留用户数据并明确告知 | 卸载器保留数据并提示 | uninstall.cmd | ✅ |

### 工程化（S6）

| B20 | 可重复构建 | 构建链手工多步（可固化） | — | ⚠️ P2 |
| B21 | 许可证/第三方声明随包 | Chromium LICENSES 内置；产品依赖声明待补 | win-unpacked | ⚠️ P2 |
| B22 | 日志与诊断 | 壳日志+兜底页 | main.js v3 | ✅ |

## C. 差距分级与执行计划

**P0（阻塞正式发布）**
1. B15 离线自包含（策略：npm 平铺实体镜像内置；用 UNICODE 长路径改写攻坚）——2-3 轮；
2. B11 品牌图标（logo→16/32/48/256 ico 接入 electron-builder）——1 轮；
3. B7 单实例锁——30 分钟。

**P1（发布级）**：B13 升级路径、B14 正式签名、B16 版本单源、B8 preload 桥规划。
**P2（运营级）**：B4 CSP、B5 sandbox 显式化、B20 构建脚本固化、B21 声明清单、B23 APP 生命周期自动化测试（安装/升级/卸载脚本化）。

## D. 结论

按标准条款逐项核对：本产品在「安全上下文」与「数据与隐私」达行业优秀；「安装/卸载生命周期」达标；主要缺陷集中在**打包自包含（B15）、品牌（B11）、单实例（B7）与工程化（B13/B14/B16）**。执行 P0→P1→P2 后即符合正规桌面 APP 交付标准。
