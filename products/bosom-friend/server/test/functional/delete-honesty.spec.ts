import { beforeAll, describe, expect, it } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 删除与更新记录的诚实性。
 *
 * 三条删除路由此前一律回 `code: 0`（`writeOk(res, idx >= 0)` 之类）：
 * 一条都没删掉时前端照样弹"已删除"、关掉弹窗，用户看到列表没变，
 * 分不清是"没删掉"还是"没刷新"——历史缺陷 P-005/P-006 就是这一族。
 * 这里把"删没删到都要如实回报"钉成断言；同时覆盖新增的批量删除与更新记录。
 */
let h: Harness

/** 建一条草稿，返回它的 id。 */
async function createDraft(title: string): Promise<string> {
  const res = await h.call<{ _id?: string, id?: string }>('POST', 'contents/drafts', {
    body: { groupId: 'mg-persist', title, desc: '测试用', mediaList: [] },
  })
  expect(res.code, '草稿必须建得出来').toBe(0)
  const id = res.data?._id ?? res.data?.id ?? ''
  expect(id).not.toBe('')
  return id
}

beforeAll(() => { h = createHarness() })

describe('删除必须如实回报，不许假成功', () => {
  it('删除不存在的草稿回非零业务码，而不是 code:0 + false', async () => {
    const ghost = await h.call('DELETE', 'contents/no-such-draft-id')
    expect(ghost.code, '找不到就如实报不存在').not.toBe(0)
    expect(String(ghost.message)).toContain('不存在')
  })

  it('删掉一条真的草稿后，再删同一条必须报不存在', async () => {
    const id = await createDraft('待删除草稿')
    const first = await h.call('DELETE', 'contents/' + id)
    expect(first.code, '第一次删除必须成功').toBe(0)
    // 成功载荷保持既有契约：调用方（含 E2E）按 data === true 判定。
    expect(first.data, '成功仍回 true，不改既有契约').toBe(true)
    expect((await h.call<{ list: unknown[] }>('GET', 'contents/drafts/1/20', { query: { groupId: 'mg-persist' } })).data.list
      .some((item: unknown) => (item as { _id?: string })._id === id), '删除后列表里不得再出现').toBe(false)

    const second = await h.call('DELETE', 'contents/' + id)
    expect(second.code, '重复删除如实报不存在，不再回成功').not.toBe(0)
  })

  it('批量删除草稿：删到几条就报几条，一条都没删到就报错', async () => {
    const a = await createDraft('批量甲')
    const b = await createDraft('批量乙')
    const deleted = await h.call<{ deleted: number }>('DELETE', 'contents', { body: { kind: 'draft', ids: [a, b] } })
    expect(deleted.code).toBe(0)
    expect(deleted.data.deleted, '必须回报真实删除条数').toBe(2)

    const again = await h.call('DELETE', 'contents', { body: { kind: 'draft', ids: [a, b] } })
    expect(again.code, '已删过的再删一次必须报错').not.toBe(0)
    expect(String(again.message)).toContain('不存在')
  })

  it('删除不存在的素材组如实报错', async () => {
    const res = await h.call('DELETE', 'contents/groups/no-such-group')
    expect(res.code).not.toBe(0)
  })
})

describe('任务记录：批量删除（此前页面完全没有删除入口）', () => {
  /** 建一条任务记录（非流式通道只落记录）。 */
  async function createTask(prompt: string): Promise<string> {
    const res = await h.call<{ id: string }>('POST', 'agent/tasks', { body: { prompt } })
    expect(res.code).toBe(0)
    return res.data.id
  }

  it('批量删除勾选的任务，回报真实条数', async () => {
    const one = await createTask('任务甲')
    const two = await createTask('任务乙')
    const deleted = await h.call<{ deleted: number }>('DELETE', 'agent/tasks', { body: { taskIds: [one, two] } })
    expect(deleted.code).toBe(0)
    expect(deleted.data.deleted).toBe(2)
    expect(h.disk<Array<{ id: string }>>('agent-tasks.json').map(t => t.id), '被删的任务不得留在列表里')
      .not.toContain(one)
  })

  it('没勾选任何任务时拒绝，不误删整列表', async () => {
    const kept = await createTask('不该被删的任务')
    expect((await h.call('DELETE', 'agent/tasks', { body: { taskIds: [] } })).code, '空选择必须拒绝').not.toBe(0)
    expect(h.disk<Array<{ id: string }>>('agent-tasks.json').map(t => t.id), '拒绝后列表必须原样保留').toContain(kept)
  })

  it('删掉不存在的任务如实报错，顺带清掉它的分享链接', async () => {
    const task = await createTask('带分享链接的任务')
    const shared = await h.call<{ token: string }>('POST', 'agent/tasks/' + task + '/share', { body: { ttlSeconds: 3600 } })
    expect(shared.code).toBe(0)
    expect((await h.call('DELETE', 'agent/tasks/' + task)).code).toBe(0)
    // 任务没了、链接还在，会把用户带到一个永远打不开的只读页。
    const tokens = h.disk<Array<{ token: string }>>('share-tokens.json')
    expect(tokens.some(item => item.token === shared.data.token), '任务删除必须级联清掉分享链接').toBe(false)
    expect((await h.call('DELETE', 'agent/tasks/' + task)).code, '重复删除如实报错').not.toBe(0)
  })
})

describe('更新记录：每版都能在通知中心看到', () => {
  it('通知列表带出更新日志，且版本从新到旧排列', async () => {
    const res = await h.call<Array<{ id: string, type: string, title: string, content: string, time: string }>>('GET', 'notification/list')
    expect(res.code).toBe(0)
    const logs = res.data.filter(item => item.type === 'changelog')
    expect(logs.length, '至少要有一版更新记录').toBeGreaterThan(0)

    // 不写死具体版本号：每发一版都会往 changelog 头部加一条，钉死版本会让用例随发版变红。
    const versions = logs.map(item => /\d+\.\d+\.\d+/.exec(item.title)?.[0] ?? '')
    expect(versions.every(v => v !== ''), '每条标题都要带版本号').toBe(true)
    const rank = (v: string) => v.split('.').map(Number)
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [rank(versions[i - 1]!), rank(versions[i]!)]
      const descending = a[0]! > b[0]! || (a[0] === b[0] && (a[1]! > b[1]! || (a[1] === b[1] && a[2]! >= b[2]!)))
      expect(descending, '更新日志必须从新到旧：' + versions[i - 1] + ' 在 ' + versions[i] + ' 之前').toBe(true)
    }
    for (const log of logs) {
      expect(log.content, '要写清用户能感知的变化').not.toBe('')
      expect(log.time, '必须带发布日期').toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('更新日志来自代码里的真实发布记录，不依赖会被清空的通知表', async () => {
    // 运营通知表始终是空的（从没人写过），更新日志仍然出得来：
    // 它是产品随包携带的发布记录，与用户数据分开，清数据不会把它清掉。
    const res = await h.call<Array<{ type: string }>>('GET', 'notification/list')
    expect(res.data.length).toBeGreaterThan(0)
    expect(res.data.every(item => item.type === 'changelog'), '此时不应有运营公告混入').toBe(true)
  })
})
