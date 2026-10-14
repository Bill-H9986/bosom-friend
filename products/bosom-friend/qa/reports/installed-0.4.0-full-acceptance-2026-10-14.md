# 装机版 0.4.0 全套软件测试（2026-10-14 上午）

- 被测对象：**交付版** `C:\Users\Jay\AppData\Local\Programs\Bosom Friend\Bosom Friend.exe`（`BosomFriend-Setup-0.4.0.exe` 装机产物）
- 版本核验：启动日志 `[boot] 版本=0.4.0 packaged=true`；31280 端口宿主进程为安装目录下的 `resources\runtime\node.exe`
- 命令口径：所有运行时用例都打在 `http://127.0.0.1:31280/bosom-friend/`（= 装机版），开发版已停、无并发写入

## 结果总览

| 套件 | 内容 | 结果 |
| --- | --- | --- |
| A 全页走查（陌生人的眼睛） | 10 个页面逐页打开 + 截图 + 断图/报错检测 | **PASS 10/10**（0 页面错误、0 同源断图；截图 `qa/evidence/installed-0.4.0-walkthrough/`） |
| B qa-guard | 禁词防火墙、冻结产物哈希与引用、插件契约、免责流程、i18n、10 页 LAYOUT、页面零错误、API code=0 | **PASS 36/36**（2 条非阻塞告警：历史作品封面来自小红书 CDN `sns-na-i4.xhscdn.com`，外部依赖不可达） |

> 说明：B 的静态项读仓库源码（验证"跑的代码 = 该跑的代码"），运行时项全部打在装机版页面上。

| C qa-guard2 | 陌生人结构走查 + 视觉一致性 28 项 | **PASS 28/28** |
| D verify-before-package 全量 | 静态 6 项 + 冻结声明 + 服务在跑 + C(28) + **一句话端到端 13 条（真实模型）** | **PASS 9/9**（13 条：工具返回、助手回复、落库三方齐备同口径，全程未改业务数据） |
| E 静态门禁包 | publish-pipeline 23/23、缺陷台账 126 行、preset 一致 11/11、marvis 五项目标、agent-workflow 23/23、drift、api-size | 全过（api-size 顺带补齐昨晚 clamp 修复漏更的一处基线） |
| F 写链路（本地） | 一句话让管家存草稿 → 落库核验 → 删除不留痕 | **PASS**（`task-4aa85177` → 草稿 `cnt-nh32bpcl` 落库后已删除） |

## 未纳入本套件（如实）

- **真发布不在自动套件内**：发布需产品负责人明确指令（硬约束 2）。最近一次真机发布：2026-10-14 00:46 抖音图文直发成功（作品 `7696194554529074458`，回读第 1 轮命中）；小红书被平台以"账号处于禁言状态"拒收（原文见 `publish-records` 与缺陷台账 DEF-306）。
- A/B 的运行时检查为只读；写链路仅做了 F 一条本地写入并已清理。

## 证据落点

- 走查截图与清单：`qa/evidence/installed-0.4.0-walkthrough/`（10 张 + walkthrough.json）
- e2e 判定：`analysis/e2e-last-run.txt`（本轮 13 条）
- 装机启动日志：`%APPDATA%\Bosom Friend\logs\2026-10-14.log`
