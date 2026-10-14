/**
 * 回复记录单测：发起即落记录、平台任务结果核对成功/失败、超时判失败、按客户聚合与筛选。
 * 运行：node --import tsx/esm products/bosom-friend/server/test/reception-replies.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachReceptionConversation, listReceptionReplies, recordReceptionReply, reconcileReceptionReplies } from '../src/reception-replies.ts'

/** 内存版 JsonFile：只实现被测模块用到的 load/save。 */
function memFile(initial) {
  let value = initial
  return {
    load: () => value,
    save: (next) => { value = next },
  }
}

const dataRoot = mkdtempSync(join(tmpdir(), 'bf-replies-'))
const replies = memFile([])
const accounts = memFile([{ id: 'acc-1', type: 'douyin', nickname: '抖音主号' }])
const deps = { dataRoot, store: { files: { receptionReplies: replies, accounts } } }

/** 写入一条平台互动任务状态文件（核对逻辑只读它）。 */
function writeTaskState(taskId, state) {
  const dir = join(dataRoot, 'platform-login', 'interact', taskId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ taskId, ...state }), 'utf8')
}

// 1. 发起即落记录：状态 sending，客户键按评论者聚合，账号名从账号库补齐
const first = recordReceptionReply(deps, {
  taskId: 'inter-1',
  platform: 'douyin',
  accountId: 'acc-1',
  kind: 'comment',
  commentText: '多少钱？',
  username: '小明',
  workId: 'w-1',
  workTitle: '作品A',
  replyText: '价格以商品页为准～',
})
assert.equal(first.status, 'sending')
assert.equal(first.customerKey, 'comment:小明')
assert.equal(first.customerName, '小明')
assert.equal(first.accountNickname, '抖音主号')
assert.equal(first.workTitle, '作品A')

// 2. 平台任务 done → 记录转 succeeded（成功只认平台任务状态）
writeTaskState('inter-1', { status: 'done', finishedAt: '2026-09-10T00:00:00.000Z' })
let view = listReceptionReplies(deps)
assert.equal(view.records[0].status, 'succeeded')
assert.equal(view.records[0].finishedAt, '2026-09-10T00:00:00.000Z')

// 3. 平台任务 failed → 失败原因原样保留；私信按会话 id 聚合
recordReceptionReply(deps, {
  taskId: 'inter-2',
  platform: 'douyin',
  accountId: 'acc-1',
  kind: 'dm',
  peerName: '小红',
  sessionId: 's-9',
  commentText: '在吗',
  replyText: '在的～',
})
writeTaskState('inter-2', { status: 'failed', error: '平台风控：操作频繁' })
view = listReceptionReplies(deps)
const failedRecord = view.records.find(r => r.taskId === 'inter-2')
assert.equal(failedRecord.status, 'failed')
assert.equal(failedRecord.error, '平台风控：操作频繁')
assert.equal(failedRecord.customerKey, 'dm:s-9')
assert.equal(failedRecord.customerName, '小红')

// 4. 同客户多条合并为一条会话摘要
recordReceptionReply(deps, {
  taskId: 'inter-3',
  platform: 'douyin',
  accountId: 'acc-1',
  kind: 'comment',
  commentText: '还有货吗',
  username: '小明',
  replyText: '有货～',
})
view = listReceptionReplies(deps)
const xiaoming = view.customers.find(c => c.customerKey === 'comment:小明')
assert.equal(xiaoming.total, 2)
assert.equal(xiaoming.succeeded, 1)
assert.equal(xiaoming.sending, 1)

// 5. 关键词与类型筛选
assert.equal(listReceptionReplies(deps, { keyword: '有货' }).records.length, 1)
assert.equal(listReceptionReplies(deps, { kind: 'dm' }).records.length, 1)
assert.equal(listReceptionReplies(deps, { platform: 'xhs' }).records.length, 0)

// 6. 平台任务长期无回执 → 判失败，不留"永久发送中"
replies.save([...replies.load(), {
  id: 'reply-old',
  taskId: 'inter-missing',
  at: new Date(Date.now() - 11 * 60_000).toISOString(),
  platform: 'douyin',
  accountId: 'acc-1',
  kind: 'dm',
  customerKey: 'dm:老会话',
  customerName: '老会话',
  sourceText: '（历史）',
  replyText: '（历史）',
  status: 'sending',
}])
const reconciled = reconcileReceptionReplies(deps)
assert.equal(reconciled.find(r => r.id === 'reply-old').status, 'failed')

// 7. 原对话快照挂到记录上，并按客户回读
const attached = attachReceptionConversation(deps, failedRecord.id, {
  at: '2026-09-10T01:00:00.000Z',
  source: 'platform',
  kind: 'dm',
  messages: [{ from: 'customer', text: '在吗' }, { from: 'me', text: '在的～' }],
})
assert.equal(attached.conversation.messages.length, 2)
view = listReceptionReplies(deps)
assert.equal(view.records.find(r => r.id === failedRecord.id).conversation.messages[1].text, '在的～')
assert.equal(attachReceptionConversation(deps, 'reply-missing', { at: '', source: 'platform', kind: 'dm', messages: [] }), undefined)

console.log('RECEPTION_REPLIES_OK checks=7')
