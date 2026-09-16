#!/usr/bin/env node
/**
 * 适配层翻译单元冒烟（免 Key）：验证 assistantTextOf 只把
 * session.event 的 assistant/chunk 内容块转成文本增量，其余通知返回空。
 */
import { assistantTextOf } from '../../../bosom-friend/server/src/kernel-client.ts'

const cases = [
  [{ method: 'session.event', params: { event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: '你好世界' } } } } }, '你好世界'],
  [{ method: 'session.event', params: { event: { type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0, blockType: 'text' } } } } }, ''],
  [{ method: 'session.event', params: { event: { type: 'turn/end', content: [] } } }, ''],
  [{ method: 'session.status', params: { sessionId: 'x', status: 'idle' } }, ''],
  [null, ''],
]
let failed = 0
for (const [input, expected] of cases) {
  const actual = assistantTextOf(input)
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}
console.log(failed === 0 ? 'KERNEL_TRANSLATE_OK' : `KERNEL_TRANSLATE_FAIL ${failed}`)
process.exit(failed === 0 ? 0 : 1)
