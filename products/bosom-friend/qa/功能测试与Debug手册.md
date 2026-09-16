# 功能测试与 Debug 手册

**这份文件回答一件事**：发现问题后，怎么用工具把它**定位到具体那几行代码**，而不是靠翻日志猜。

三层分工，先想清楚"该在哪一层测"，再动手：

| 层 | 位置 | 测什么 | 跑多久 | 看到什么 |
| --- | --- | --- | --- | --- |
| 功能测试（vitest） | `server/test/functional/`（配置 `server/vitest.config.ts`） | **逻辑**：契约字段层级、业务码、统计口径、状态机、落盘副作用 | 约 0.6 秒 | 断言位置 + 期望/实际值 + 可断点的 TS 栈 |
| 端到端（Playwright Test） | `qa/e2e/specs/` | **页面**：真实浏览器里的 CRUD、按钮真的做了什么 | 约 4 分钟 | trace/截图/录屏 + 逐步操作回放 |
| 门禁 | `qa/run-gate.mjs` | 上面两层 + 静态门槛 + 补丁一致性，一起判红绿 | 约 6 分钟 | `qa/reports/latest.md` |

判断规则：**能用函数调用复现的，写在功能测试里；只有"用户点得出来"的，才写进 E2E。** 逻辑缺陷写成 E2E 会又慢又脆。

## 1. 跑

```powershell
# 功能测试（秒级，改完随手跑）
cd products\bosom-friend\server
node ../../../node_modules/vitest/vitest.mjs run --config vitest.config.ts        # 全部
node ../../../node_modules/vitest/vitest.mjs run --config vitest.config.ts api-contract.spec.ts   # 只跑一个（按文件名过滤）
node ../../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage              # 带覆盖率

# 端到端（要开发实例在 31280 上跑着）
cd products\bosom-friend\qa\e2e
npx playwright test                      # 全部
npx playwright test monitor.spec.ts      # 只跑一个（按文件名过滤）
npx playwright test --ui                  # 图形界面：点着复跑、逐步回放
```

**E2E 前置条件**：开发实例必须活着。先确认再跑，别把"实例没起"当成"功能坏了"：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:31280/bosom-friend/' -UseBasicParsing -TimeoutSec 8 | Select-Object StatusCode
```

## 2. 断点调试（VS Code）

仓库根目录已配好 `.vscode/launch.json`（`.vscode/` 是 git 忽略目录，配置跟机器走、不入库），按 **F5** 选配置即可，不需要装额外调试扩展
（`vitest.explorer` / `ms-playwright.playwright` 是推荐扩展，装了更顺手，不装也能断点）：

| 配置 | 用途 |
| --- | --- |
| 功能测试：全部（可断点） | 整个功能测试套件，断点停在 `server/src/*.ts` 或 `test/**/*.spec.ts` |
| 功能测试：当前文件（可断点） | 只跑当前打开的 spec（按文件名过滤） |
| 功能测试：当前文件（watch） | 改一行存一次就跑一次，用来守着复现 |
| E2E：当前文件（有头浏览器） | 真浏览器 + 断点停在 spec 里 |
| E2E：Playwright Inspector（PWDEBUG） | 每步操作单步执行，看 locator 到底选中了什么 |

断点能停在 `server/src/api.ts` 这类 TypeScript 源码上，是因为 vitest 走 vite 转译并带 sourcemap——
这一点是"功能测试"和旧脚本（`node xxx.mjs` 打服务端黑盒）最大的区别：**旧脚本只能告诉你 HTTP 返回什么，
断点能告诉你是在哪一行拼出了那个返回。**

E2E 里断点在 spec 文件上有效；要断进浏览器页面里的前端代码，用 Inspector（PWDEBUG）配合 `page.pause()`。

## 3. 失败怎么读

1. **功能测试失败**：终端直接给文件:行号 + `expected ... to be ...`。先看断言，再看被测那段源码，中间不需要任何中间层。
2. **E2E 失败**：先开报告，再开 trace。
   ```powershell
   cd products\bosom-friend\qa\e2e
   npm run report --silent                 # HTML 报告（含失败截图）
   npx playwright show-trace test-results\<用例目录>\trace.zip   # 时间轴回放：每步 DOM 快照 + 网络
   ```
3. **门禁红**：`qa/reports/latest.md` 里按检查项列出。门禁红了先看是"哪一项检查"，不是先看页面。

## 4. 覆盖率的读法

`--coverage` 会生成 `server/coverage/index.html`（v8），逐行标红未执行代码。
当前功能测试覆盖 `server/src` 约 **14% 语句**（`api.ts` 7.96%、`routes-content.ts` 27.53%、`security.ts` 87.5%）。
这个数字是**待办清单**不是成绩单：`platform-login.ts`、`platform-sync.ts`、`reception-replies.ts`、
`routes-channels.ts` 目前几乎没被功能测试碰过，只有 E2E 的界面级覆盖。

## 5. 写用例的规矩（门禁会拦）

1. **断言绑契约，不绑文案**：绑 `code`/`data` 字段/字段层级/数量关系。必须绑文案时用语义正则（`本次未采到|平台未提供`），
   不钉整句——文案一改用例就假红，假红多了就没人看了。
2. **每个修复配一条负向对照**：把修复回退，用例必须变红（`EPERM ... backups\<ts>`、`expected undefined to be 5` 这类）。
   证明不了"能判红"的用例等于没写。
3. **靶子自建自删**：临时数据自己造、`finally` 里清掉，不删用户既有数据，不依赖其它用例的执行顺序。
4. **不用写死路径**：不要 `node_modules/.pnpm/<pkg>@<version>/...` 这种路径——依赖树一变就 `MODULE_NOT_FOUND`
   （`verify-batch-delete.mjs` / `verify-dashboard-metric-honesty.mjs` 就是这么腐掉被删的）。

## 6. 相关文件

- `qa/run-gate.mjs`：门禁入口；检查项「服务端功能测试」「专业 E2E 套件」对应上面两层。
- `qa/e2e/README.md`：E2E 套件自己的覆盖清单与规矩。
- `qa/e2e/playwright.config.ts`：`trace: retain-on-failure`、`workers: 1`（同一个实例，避免互扰）。
- `server/vitest.config.ts`：功能测试的 `root`/`include`/覆盖率参数。
- `.vscode/launch.json`：本文第 2 节的调试配置。
