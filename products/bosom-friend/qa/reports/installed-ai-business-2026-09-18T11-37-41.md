# 安装版 AI 业务验收（真实大模型）

- 时间：2026-09-18T11:37:41.586Z
- 被测对象：C:\Users\Jay\AppData\Local\Programs\Bosom Friend\Bosom Friend.exe（端口 31296，真实数据根与真实凭据）
- 用例：AC-004-1|AC-016-1|AC-018-1
- 结果：  1 failed

```
(Use `node --trace-warnings ...` to show where the warning was created)
  ✓  1 specs\ac-verification.spec.ts:938:3 › AC-004-1 一句话生成，页面流式显示 AI 回复 › 一句提示词真的调到大模型并返回非模板正文 (21.7s)
  ✓  2 specs\ac-verification.spec.ts:951:3 › AC-016-1 自定义大模型保存后对话生效 › 对话使用的就是设置里保存的那个模型 (3.5s)
  ✓  3 specs\agent-conversation.spec.ts:65:3 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「打开数据中心」后会话里出现导航卡，点一下就真的到数据中心 (58.2s)
  ✓  4 specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「帮我打开草稿箱。」拿到 navigateToDraft 导航卡，点一下就跳到 draft-box (25.7s)
  ✓  5 specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「带我去全局监控看看。」拿到 navigateToMonitor 导航卡，点一下就跳到 monitor (37.1s)
  ✘  6 specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「打开知识库。」拿到 navigateToKnowledge 导航卡，点一下就跳到 knowledge (3.4m)
(node:33112) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
  ✓  7 specs\agent-conversation.spec.ts:103:3 › AC-018-1 仅与 AI 对话即可完成各项功能 › 没有导航意图的创作需求不会被误跳转 (1.3m)
  1) specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「打开知识库。」拿到 navigateToKnowledge 导航卡，点一下就跳到 knowledge
    Error: 「打开知识库。」应产出 navigateToKnowledge 导航卡
    expect(locator).toBeVisible() failed
    Locator: locator('[data-action-card="navigateToKnowledge"]')
    Expected: visible
    Timeout: 180000ms
    Error: element(s) not found
    Call log:
      - 「打开知识库。」应产出 navigateToKnowledge 导航卡 with timeout 180000ms
      - waiting for locator('[data-action-card="navigateToKnowledge"]')
      94 |       await ask(page, item.prompt)
      95 |       const card = page.locator('[data-action-card="' + item.type + '"]')
    > 96 |       await expect(card, '「' + item.prompt + '」应产出 ' + item.type + ' 导航卡').toBeVisible({ timeout: 180_000 })
         |                                                                            ^
      97 |       await card.getByRole('button').click()
      98 |       await expect.poll(async () => page.url(), { timeout: 20_000, message: item.prompt + ' 应跳到 ' + item.route }).toContain(item.route)
      99 |       await page.screenshot({ path: evidence('AC-018-1-对话导航到-' + item.route) })
        at C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\qa\e2e\specs\agent-conversation.spec.ts:96:76
    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    test-results\agent-conversation-AC-018--f87ba-wledge-导航卡，点一下就跳到-knowledge\test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────
    Error Context: test-results\agent-conversation-AC-018--f87ba-wledge-导航卡，点一下就跳到-knowledge\error-context.md
    attachment #3: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results\agent-conversation-AC-018--f87ba-wledge-导航卡，点一下就跳到-knowledge\trace.zip
    Usage:
        npx playwright show-trace test-results\agent-conversation-AC-018--f87ba-wledge-导航卡，点一下就跳到-knowledge\trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  1 failed
    specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「打开知识库。」拿到 navigateToKnowledge 导航卡，点一下就跳到 knowledge
  6 passed (7.3m)
```
