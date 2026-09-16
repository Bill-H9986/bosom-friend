# qa/e2e — 端到端测试套件（Playwright Test）

专业套件，替代此前一次性、绑定文案与旧路由的探针脚本。

## 跑法

```bat
cd products\bosom-friend\qa\e2e
npm install            # 只装 @playwright/test（不动 App 的 node_modules）
npx playwright test    # 默认打 http://127.0.0.1:31280（BF_QA_BASE 可覆盖）
npx playwright show-report report
```

## 覆盖（三大核心 CRUD + 关键不变量）

| 文件 | 覆盖 |
| --- | --- |
| `specs/content-crud.spec.ts` | 内容创作：首屏落在默认素材组（DEF-024）、素材组增/改/删、素材上传→页面批量删除→服务端总数 -1 且不回魂、**刷新后仍停在内容创作**（路由不丢） |
| `specs/agent-crud.spec.ts` | AI 智能体：任务创建→读取→评分/收藏→删除；DEF-018 回归（评分读接口单层 data、不存在任务 18100） |
| `specs/monitor.spec.ts` | 全局监控：刷新只重读不发轮询；立即轮询必须真触发并如实反馈（进行中重复点要说明） |

## 规矩

1. **靶子自建自删**：用例不删用户既有数据；失败也会在 finally 里清理。
2. **断言绑契约**：绑 code/字段/字段层级/数量关系；必须绑文案时用语义正则（`已触发一轮轮询|接待引擎正在跑这一轮`）。
3. **失败留证**：`trace: retain-on-failure` + 失败截图，产物在 `test-results/`，报告在 `report/`。
4. 已接入 `qa/run-gate.mjs`（检查项「专业 E2E 套件」）；套件红了就是红灯。
