# 安装版 AI 业务验收（真实大模型）

- 时间：2026-09-22T15:10:56.838Z
- 被测对象：C:\Users\Jay\AppData\Local\Programs\Bosom Friend\Bosom Friend.exe（端口 31296，真实数据根与真实凭据）
- 用例：AC-004-1|AC-016-1|AC-018-1
- 结果：  7 passed (3.9m)

```
Running 7 tests using 1 worker
(node:31676) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
  ✓  1 specs\ac-verification.spec.ts:942:3 › AC-004-1 一句话生成，页面流式显示 AI 回复 › 一句提示词真的调到大模型并返回非模板正文 (20.9s)
  ✓  2 specs\ac-verification.spec.ts:959:3 › AC-016-1 自定义大模型保存后对话生效 › 对话使用的就是设置里保存的那个模型 (9.1s)
  ✓  3 specs\agent-conversation.spec.ts:65:3 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「打开数据中心」后会话里出现导航卡，点一下就真的到数据中心 (39.2s)
  ✓  4 specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「帮我打开草稿箱。」拿到 navigateToDraft 导航卡，点一下就跳到 draft-box (27.3s)
  ✓  5 specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「带我去全局监控看看。」拿到 navigateToMonitor 导航卡，点一下就跳到 monitor (26.9s)
  ✓  6 specs\agent-conversation.spec.ts:91:5 › AC-018-1 仅与 AI 对话即可完成各项功能 › 说「打开知识库。」拿到 navigateToKnowledge 导航卡，点一下就跳到 knowledge (28.8s)
  ✓  7 specs\agent-conversation.spec.ts:103:3 › AC-018-1 仅与 AI 对话即可完成各项功能 › 没有导航意图的创作需求不会被误跳转 (1.3m)
  7 passed (3.9m)
```
