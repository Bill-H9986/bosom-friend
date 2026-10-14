# 发布记录 · Bosom Friend 0.2.41（2026-09-13 最终）

## 安装包

| 项 | 值 |
| --- | --- |
| 文件 | `products/bosom-friend/desktop/release/0.2.41/BosomFriend-Setup-0.2.41.exe` |
| 桌面副本 | `C:\Users\Jay\Desktop\BosomFriend-Setup-0.2.41.exe` |
| 大小 | 992,736,050 字节（946.7 MB） |
| SHA256 | `934CDF89C8B4E2E681C5045B87F4330BBC4CF9211C409E269356B354A39A4FC7` |
| 构建时间 | 2026-09-13 14:04:08（exit 0） |
| 代码冻结 | `151f50c` |
| 安装结果 | 静默安装 exit 0；注册表 `Bosom Friend 0.2.41` |

## 门禁（run-gate.mjs --full，跑在安装版上）

**0 红 / 18 绿 / 2 黄**（2026-09-13T06:37Z）

- 服务端功能测试 **46 / 46**
- 专业 E2E 套件 **41 passed**（含 28 条 AC 验收用例）
- 业务域 CRUD 34/34、知识库蒸馏 12/12、中断时序矩阵 22/22、S 级前端验收 7 文件 0 违规、
  产品版本单源一致、数据编码完整性、安装包只读保护、模型配置链路 全绿
- 黄灯一：验收准则覆盖率 **85.6%**（覆盖 32 / 部分 13 / 未覆盖 0）
- 黄灯二：AI 智能体任务动作 —— 本机大模型当前不可用，按检查脚本自身契约降级为黄灯

## 包内实测（安装版）

| 检查 | 结果 |
| --- | --- |
| `resources/engine/browsers/chromium-1169` | 86 文件（playwright 系 6 个平台的启动前提） |
| `resources/engine/browsers/chromium-1208` / `headless_shell` | 310 / 293 文件 |
| `resources/engine/tools/biliup` | 已随包（否则首次 B 站发布要现下 225 秒） |
| `resources/engine/bilibili_login.py` | 已随包（新增的 B 站扫码登录） |
| 内核运行时 `.pnpm` 副本 | 3 份与直接路径时间戳一致（构建脚本已修，不再分叉） |
| 平台清单 / 频道数 | 10 / 9（xhs,alipay,baijiahao,bilibili,douyin,hupu,KWAI,wxSph,weibo） |
| 无任何国外平台 | 是 |
| 接口级实测 | 14 / 14 通过（平台、假成功修复、数据诚实性） |
| 数据 | 2 个真实账号、15 条真实发布记录、0 测试残留 |

## 卸载实测

安装目录 / 开始菜单 / 桌面快捷方式 / 注册表全部清零；用户数据 21,694 文件完整保留；
`%APPDATA%\Bosom Friend` 由 1.11 GB 降为 0（内核运行时残留回收已生效）。

## 本轮修复口径（详见 最终交付报告-20260912.md）

- 平台：国内 10 家，9 家可作频道；TikTok/YouTube 等国外平台全部移除；闲鱼只登录不发布故不开放。
- 要求二 R3 无源不显示：9 处伪造 0 清除（含新建发布流的 engagement、建账号的 fans/work/income）。
- 接口假成功：9 处「回 code 0 但什么都没做」清除。
- 交付链：随包浏览器补齐 playwright 1169；构建脚本按内容同步 .pnpm 副本；
  卸载清内核运行时残留（曾堆 8.9 GB）；启动回收平台任务目录（曾堆 4108 个）。
