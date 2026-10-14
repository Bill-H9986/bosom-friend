# DEF-176 专业 E2E 全部用例都先撞免责弹窗：不勾「我已阅读」就点「同意并进入平台」，弹层留着挡掉后面每一次点击

| 项 | 值 |
| --- | --- |
| 编号 | DEF-176 |
| 发现日期 | 2026-09-24 |
| 发现方式 | 0.2.61 发布卡在「三连绿」上连续 4 轮红灯，红的用例每次都不一样（清空全部生成记录 / 弹层单条删除 / 批量移除素材），改用隔离实例单跑同一条用例复现，拿到失败现场 |
| 严重级 | P2（缺陷在 QA 套件侧，不在产品；但它让 R1 无法判定。发布流程按 §6「未实现的功能必须从 UI 移除或明示」的同一种口径处理：检查必须诚实，不能把"没跑到"当成"通过"） |
| 状态 | Fixed（2026-09-24；负向对照见下） |

## 现象

0.2.61 的「三连绿」五次尝试共 14 轮门禁，四次非绿里三次红在**专业 E2E 套件**，
而且每次红的用例都不同：

| 轮次（报告） | 红的用例 |
| --- | --- |
| `gate-20260924-110831` | `delete-consistency.spec.ts` 生成记录弹层里单条删除 |
| `gate-20260924-120641` | `delete-consistency.spec.ts` 批量移除「生成产出的素材」 |
| `gate-20260924-140605` | `delete-consistency.spec.ts` 批量移除「生成产出的素材」 |
| 更早的 `gate-20260923-180042` / `184931` | 弹层里单条删除（同一族） |

现场（隔离实例 31520 单跑复现，失败截图 + `error-context.md`）：

```
TimeoutError: locator.click: Timeout 20000ms exceeded.
  - waiting for locator('button:has-text("批量管理"):visible').first()
  - <div data-state="open" aria-hidden="true" data-aria-hidden="true"
      class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm ..."></div> intercepts pointer events
```

页面快照里那个 `data-state="open"` 的遮罩是**平台免责声明**弹层，而它的
「同意并进入平台」按钮当时是 `[disabled]`——因为「我已阅读并同意以上免责声明」没勾。

## 根因

`qa/e2e/fixtures.ts` 的 `dismissDisclaimer()` **只点按钮、不勾选框**：

```ts
const button = page.locator("button:has-text('同意并进入平台')").first()
if (await button.count() > 0 && await button.isVisible().catch(() => false))
  await button.click({ timeout: 3000 }).catch(() => {})   // 禁用态上必然超时，且被 catch 吞掉
```

「同意并进入平台」在勾选之前是禁用的（`DisclaimerModal` 的 `disabled={!checked}`），
于是点击必然超时、异常被 `catch` 吞掉，弹层继续开着；它的 backdrop（`fixed inset-0 z-50`）
盖住整页，**后面每一次点击都被拦**。用例因此红在它自己的第一个交互上，失败信息里出现的
是"批量管理点不动""生成记录弹层点不动"——看起来像删除功能坏了，实际与删除毫无关系。

**为什么每次红的用例都不一样**：Playwright 每条用例都是全新浏览器上下文，`localStorage` 为空，
所以免责弹层**每条用例都会重新出现**；哪条用例先撞上、撞在哪一步取决于当时的渲染与冷启动快慢，
于是表现为"间歇性、且红的用例漂移"。这类红最容易被误判成产品功能缺陷或环境噪声。

## 负向对照

- 修前（同一份代码、同一台机器、隔离实例 31520）：`--grep '级联'` **1 failed**，红在
  `spec.ts:131` 的第一次点击，报错即上面的 `intercepts pointer events`；
- 修后：同一条用例 **1 passed (46.5s)**（真的走完出图 → 勾选删除 → 级联校验）。

## 改动

1. `qa/e2e/fixtures.ts` 的 `dismissDisclaimer()`：按钮禁用时先点「我已阅读并同意以上…」，
   再点进入，并等弹层**真的消失**（`state: 'detached'`）——弹层还在时任何后续点击都不可信；
2. `qa/gate-30.mjs` 里同一份只点按钮的 `dismiss()` 一并修掉：它是 R4 那 30 条硬验收截图的产出脚本，
   弹层没关时截出来的是被遮住的页面，而脚本自己不会报错（假证据）。

## 影响面（照实写）

- 第 4、5 次尝试里被判"专业 E2E 套件红"的那几轮，**红的原因不是产品**；真正的产品侧检查
  （内容创作 / AI 智能体 / 全局监控的 CRUD 与不变量）在这些轮次里没有被判定过；
- 三连绿此前从未达成，与这条同族；修好后需要重新跑满 3 轮才能判定 0.2.61 的 R1。
