# qa/ — Bosom Friend 质量与门禁体系

> 服务实例：http://127.0.0.1:3080/bosom-friend/（门禁套件硬编码 3080；端口不同请改脚本内 URL）
>
> **最高测试权限**：`qa/acceptance/EXAM_PROTOCOL.md`（S 级前端监考 v3）。
> 产品验收必须由 APP 前端发起、后端处理、再返回前端可见；接口冒烟、
> 后端白盒、SSE 和持久化审计只能作为基础设施诊断，不能代替 S 级结论。
> 执行 `node qa/acceptance/frontend-supreme-gate.mjs` 与
> `node qa/acceptance/run-supreme.mjs`。

## 目录角色

| 文件 | 角色 |
| --- | --- |
| `acceptance/verify-abort-timing-matrix.mjs` | 中断时序矩阵（5 个时间点 × 3 条不变量：终态落定后不得翻转 / 真中断必须落 aborted / 停晚了不得谎称已中断）；已接入 `run-gate.mjs` |
| `交付测试规则-v1.0.md` | **交付测试流程规则**：三种交付形态、七条铁律、六段流水线 D0~D5、用例/证据/环境/返工规则、交付物清单 |
| `run-gate-triple.mjs` | **发布准出判定器**：连续 3 次门禁全绿且零黄灯才判定可发布；准出硬门槛 R1~R9 见 `RELEASE_CHECKLIST-v1.0.md` |
| `qa-all.mjs` | 门禁总入口：S 级前端静态门槛 → qa-guard(21 项) → qa-guard2(30 项) → qa-docsync(报告自动同步)；任何失败即 exit 1 |
| `qa-guard.mjs` | 功能/品牌/布局/i18n 防火墙（21 项）；结果落盘 `last-guard1.json` |
| `qa-guard2.mjs` | 无障碍 axe / 视觉布局指纹基线 / 毒丸自检 / 性能预算 / Logo 区与首页粒子场 / 功能页无标题 / 移动端（30 项）；结果落盘 `last-guard2.json` |
| `qa-docsync.mjs` | 读 `last-guard{1,2}.json`，幂等同步三份报告的标记块（绝不重复堆叠） |
| `smoke-all.mjs`(28 断言) / `smoke-edge.mjs`(14) / `smoke-sse.mjs` / `smoke-api.ps1` / `raw-sse.mjs` / `contract-audit.mjs` | 后端 REST/SSE/边界回归（默认 3080，可用 `BF_QA_ORIGIN` 覆盖） |
| `../server/vitest.config.ts` + `../server/test/functional/` | **服务端功能测试（vitest，进程内）**：直接驱动真实路由表，测契约层级/统计口径/批量删除语义/上传票据/路由表不变量；秒级、可断点调试、带覆盖率；已接入门禁（检查项「服务端功能测试」） |
| `jscpd.product.json` | **重复代码分析**（产品范围）：`cd products/bosom-friend && node ../../node_modules/.bin/jscpd --config qa/jscpd.product.json server/src launcher/src bundle/app/src project/bosom-friend-web/src project/bosom-friend-electron/src desktop/electron`，报告落 `qa/reports/duplication/` |
| `e2e/` | **专业端到端套件（Playwright Test）**：内容创作 / AI 智能体 / 全局监控的 CRUD 与关键不变量，已接入 `run-gate.mjs`（检查项「专业 E2E 套件」）。原先按旧按钮名/旧路由写死的 `batch-delete-*.mjs` 探针、以及把 playwright-core 安装路径写死的
`verify-batch-delete.mjs` / `verify-dashboard-metric-honesty.mjs` 都已删除——它们早就跑不通，替代品是
`specs/content-crud.spec.ts` 与 `specs/dashboard-honesty.spec.ts`（逻辑断言那一半在 `../server/test/functional/`）。 |
| `verify-cordis-patches.mjs` | cordis 补丁一致性：dev/web 层与桌面层挂同一插件时 id 与共享配置必须一致；已接入门禁 |
| `verify-agent-task-actions.mjs` | AI 智能体任务动作验收（27 项）：分享有效期/只读页、中断真的停（以 `abort` 回报的 `interrupted` 判定，停晚了不判红）、收尾阶段停止不被覆盖回已完成、继续接得上、收藏与评分落库；已接入 `run-gate.mjs` |
| `crud-matrix.mjs` / `knowledge-distill.mjs` / `verify-llm-config.mjs` | 业务域 CRUD、知识库蒸馏链路、模型配置链路门禁；已接入 `run-gate.mjs` |
| `last-guard1.json` / `last-guard2.json` | 门禁运行记录（docsync 数据源） |
| `visual-baseline.json` / `.prev` / `baseline-change-log.txt` | 10 路由布局指纹基线。**冻结只读**：任何差异 = FAIL；仅人工确认后按流程固化（备份 prev + 写变更日志） |
| `axe-core.min.js` | 无障检查引擎（本地固定版本） |
| `FULL_QA_REPORT.md` / `GUARD2_REPORT.md` / `VISUAL_REPORT.md` / `BUTTONS_REPORT.md` / `TEST_REPORT.md` | QA 报告（门禁标记块由 qa-docsync 自动同步，叙述部分人工维护） |
| `probes/` | 一次性调试/审计/截图脚本与历史快照（**非门禁组成部分**，仅归档，可随时删除） |

## 运行

```bat
:: 全量门禁（需服务运行；约 5~7 分钟）
node products\bosom-friend\qa\qa-all.mjs

:: 后端业务回归（快速，几十秒）
node products\bosom-friend\qa\smoke-all.mjs
node products\bosom-friend\qa\smoke-edge.mjs
```

## 发布准出（商用上架）

```bat
:: 连续 3 次门禁全绿且零黄灯；应用须处于运行态
node products/bosom-friend/qa/run-gate-triple.mjs --full
```

判定依据：`RELEASE_CHECKLIST-v1.0.md`（R1~R9 硬门槛 + 干净机出厂验收 12 步 + 缺陷分级）。单次绿灯不作为发布依据。

## 规则

1. 门禁失败不许交付（qa-all 以非 0 退出）；报告如实记录 BLOCKED，不覆盖失败状态。
2. 视觉基线绝不允许脚本自动覆盖；人工固化的动作 = 备份到 `visual-baseline.prev.json` + `baseline-change-log.txt` 记录原因。
3. `probes/` 只做归档，不进门禁；门禁新增断言写入 `qa-guard*.mjs`。
