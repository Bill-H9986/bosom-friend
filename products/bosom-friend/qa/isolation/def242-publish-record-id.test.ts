import { describe, expect, it } from 'vitest'
import { getPublishRecordIdFromFlow } from '@web/components/PublishDialog/PublishDialog.util'

// DEF-242 阶段 A 定向回归：getPublishRecordIdFromFlow 的可选链修复
// 修复点：PublishDialog.util.ts:675  `flow?.tasks.length` -> `flow?.tasks?.length`

describe('DEF-242 阶段A：getPublishRecordIdFromFlow', () => {
  it('1) flow 为 undefined 时返回 undefined（原行为不变）', () => {
    expect(getPublishRecordIdFromFlow(undefined)).toBeUndefined()
  })

  it('1b) flow 为 undefined 且带 accountId 时返回 undefined', () => {
    expect(getPublishRecordIdFromFlow(undefined, 'acc-1')).toBeUndefined()
  })

  it('2) flow.tasks 缺失时不再抛 TypeError（本次修复的核心）', () => {
    // 修复前：flow?.tasks.length -> Cannot read properties of undefined (reading 'length')
    expect(() => getPublishRecordIdFromFlow({} as never)).not.toThrow()
    expect(getPublishRecordIdFromFlow({} as never)).toBeUndefined()
  })

  it('2b) flow.tasks 缺失 + accountId 时同样不抛，且返回 undefined', () => {
    expect(() => getPublishRecordIdFromFlow({} as never, 'acc-1')).not.toThrow()
    expect(getPublishRecordIdFromFlow({} as never, 'acc-1')).toBeUndefined()
  })

  it('3) tasks 为空数组时行为不变（返回 undefined）', () => {
    expect(getPublishRecordIdFromFlow({ tasks: [] } as never)).toBeUndefined()
    expect(getPublishRecordIdFromFlow({ tasks: [] } as never, 'acc-1')).toBeUndefined()
  })

  it('4) 正常任务数组：不带 accountId 取首条 id', () => {
    const flow = { tasks: [{ id: 'rec-1', accountId: 'acc-1' }, { id: 'rec-2', accountId: 'acc-2' }] }
    expect(getPublishRecordIdFromFlow(flow as never)).toBe('rec-1')
  })

  it('4b) 正常任务数组：带 accountId 命中对应记录', () => {
    const flow = { tasks: [{ id: 'rec-1', accountId: 'acc-1' }, { id: 'rec-2', accountId: 'acc-2' }] }
    expect(getPublishRecordIdFromFlow(flow as never, 'acc-2')).toBe('rec-2')
  })

  it('4c) 带 accountId 但未命中时回退首条 id（原行为不变）', () => {
    const flow = { tasks: [{ id: 'rec-1', accountId: 'acc-1' }] }
    expect(getPublishRecordIdFromFlow(flow as never, 'acc-404')).toBe('rec-1')
  })

  it('5) code===0 但 data.tasks 缺失：返回 undefined，不凭空构造 ID', () => {
    // 模拟后端返回 { code: 0, data: { flowId: 'm' } }，调用方传 res.data
    const resData = { flowId: 'm' }
    const id = getPublishRecordIdFromFlow(resData as never)
    expect(id).toBeUndefined()
    expect(id).not.toEqual(expect.any(String))
  })

  it('5b) res.data 为 undefined 时也不抛', () => {
    expect(() => getPublishRecordIdFromFlow(undefined)).not.toThrow()
  })
})
