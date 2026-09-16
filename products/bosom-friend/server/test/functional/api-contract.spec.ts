import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 产品服务端功能测试（进程内驱动真实路由表，不起服务、不开浏览器）。
 *
 * 覆盖的是**逻辑与契约**：
 * - 信封层级与业务码（DEF-018 双包装）；
 * - 统计口径的诚实性（DEF-020 全 0 占位不计入"已更新"）；
 * - 批量删除语义（素材保护 / 草稿级联）；
 * - 上传票据三种寻址（去重后同一份实现）；
 * - 接待引擎 poll-now 如实回报（DEF-026）；
 * - 路由表不变量（重复注册、路径形态、kind 必填）。
 *
 * 调试：`npx vitest --inspect-brk` 可断点；失败断言直接给出期望/实际与源码位置。
 */
let h: Harness

beforeAll(() => {
  h = createHarness()
})
afterAll(() => {
  h.dispose()
})

describe('agent/tasks 评分（DEF-018：不再双包装）', () => {
  it('不存在的任务如实回 18100，而不是静默回 null', async () => {
    const res = await h.call('GET', 'agent/tasks/zz-nonexistent/rating')
    expect(res.code).toBe(18100)
    expect(res.message).toContain('task not found')
    expect(res.data).toBeNull()
  })

  it('写入后回读走单层 data，且不存在 data.data', async () => {
    const created = await h.call<{ id: string }>('POST', 'agent/tasks', { body: { prompt: '功能测试探针任务' } })
    expect(created.code).toBe(0)
    const taskId = created.data.id

    const written = await h.call('POST', 'agent/tasks/' + taskId + '/rating', { body: { rating: 5, comment: '自检评分' } })
    expect(written.code).toBe(0)

    const read = await h.call<{ rating: number | null; comment: string | null; data?: unknown }>('GET', 'agent/tasks/' + taskId + '/rating')
    expect(read.code).toBe(0)
    expect(read.data.rating).toBe(5)
    expect(read.data.comment).toBe('自检评分')
    expect(read.data.data, '出现 data.data 说明双包装回来了').toBeUndefined()

    await h.call('DELETE', 'agent/tasks/' + taskId)
  })
})

describe('数据中心「已更新 N/M 条」（DEF-020：全 0 占位不算已更新）', () => {
  it('只把采到真值的作品计入 updatedCount，另出 zeroOnlyCount', async () => {
    const store = createHarness()
    try {
      new JsonFile(store.dataRoot + '/publish-records.json', () => []).save([
        { id: 'r1', accountId: 'a1', accountType: 'xhs', platformWorkId: 'w1', status: 1, title: '有真值', publishTime: '2026-09-11T02:00:00.000Z' },
        { id: 'r2', accountId: 'a1', accountType: 'xhs', platformWorkId: 'w2', status: 1, title: '全 0 占位', publishTime: '2026-09-11T03:00:00.000Z' },
        { id: 'r3', accountId: 'a1', accountType: 'xhs', platformWorkId: 'w3', status: 1, title: '点赞有值', publishTime: '2026-09-11T04:00:00.000Z' },
      ])
      new JsonFile(store.dataRoot + '/metrics.json', () => []).save([
        { workId: 'w1', accountId: 'a1', platform: 'xhs', date: '2026-09-11', viewCount: 13016, likeCount: 20, commentCount: 3, shareCount: 1, favoriteCount: 0 },
        { workId: 'w2', accountId: 'a1', platform: 'xhs', date: '2026-09-11', viewCount: 0, likeCount: 0, commentCount: 0, shareCount: 0, favoriteCount: 0 },
        { workId: 'w3', accountId: 'a1', platform: 'xhs', date: '2026-09-11', viewCount: 0, likeCount: 7, commentCount: 0, shareCount: 0, favoriteCount: 0 },
      ])

      const dash = await store.call<{ updateProgress: { totalCount: number; updatedCount: number; zeroOnlyCount: number } }>(
        'GET',
        'v2/statistics/published-content-summary/dashboard',
      )
      expect(dash.code).toBe(0)
      expect(dash.data.updateProgress.totalCount).toBe(3)
      expect(dash.data.updateProgress.updatedCount, '全 0 占位不能算已更新').toBe(2)
      expect(dash.data.updateProgress.zeroOnlyCount, '被保留的全 0 占位要如实报出').toBe(1)
    }
    finally {
      store.dispose()
    }
  })
})

describe('路由表不变量', () => {
  it('没有重复的「方法 + 路径」注册', () => {
    const seen = new Map<string, number>()
    for (const route of h.routes)
      seen.set(route.m + ' ' + route.p, (seen.get(route.m + ' ' + route.p) ?? 0) + 1)
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key)
    expect(duplicated, '重复注册会让先注册的那个永远命中不到').toEqual([])
  })

  it('路径不带前导斜杠、不含连续斜杠', () => {
    const bad = h.routes.filter(route => route.p.startsWith('/') || route.p.includes('//')).map(route => route.m + ' ' + route.p)
    expect(bad).toEqual([])
  })

  it('批量删除要求显式 kind，不猜素材还是草稿', async () => {
    const missingKind = await h.call('DELETE', 'contents', { body: { ids: [] } })
    expect(missingKind.code).toBe(40000)
    expect(missingKind.message).toContain('kind')
  })
})

describe('素材批量删除：被生成记录引用的必须保留', () => {
  it('只删没被引用的，返回 { deleted, kept }', async () => {
    const store = createHarness()
    try {
      new JsonFile(store.dataRoot + '/contents.json', () => []).save([
        { kind: 'asset', _id: 'asset-keep.png', url: '/bosom-friend/api/assets/file/asset-keep.png', title: 'keep', groupId: 'mg-persist' },
        { kind: 'asset', _id: 'asset-drop.png', url: '/bosom-friend/api/assets/file/asset-drop.png', title: 'drop', groupId: 'mg-persist' },
      ])
      new JsonFile(store.dataRoot + '/draft-generations.json', () => []).save([
        { id: 'gen-1', response: { imageUrls: ['/bosom-friend/api/assets/file/asset-keep.png'] } },
      ])

      const res = await store.call<{ deleted: string[]; kept: string[] }>('DELETE', 'contents', {
        body: { ids: ['asset-keep.png', 'asset-drop.png'], kind: 'asset' },
      })
      expect(res.code).toBe(0)
      expect(res.data.deleted).toEqual(['asset-drop.png'])
      expect(res.data.kept).toEqual(['asset-keep.png'])
      expect(store.disk<Array<{ _id: string }>>('contents.json').map(item => item._id)).toEqual(['asset-keep.png'])
    }
    finally {
      store.dispose()
    }
  })
})

describe('草稿批量删除：级联清掉生成记录', () => {
  it('删草稿后对应生成记录一并消失，其它记录不受影响', async () => {
    const store = createHarness()
    try {
      new JsonFile(store.dataRoot + '/contents.json', () => []).save([
        { kind: 'draft', _id: 'cnt-1', id: 'cnt-1', title: '草稿', groupId: 'mg-persist', metadata: { generationId: 'gen-9' } },
      ])
      new JsonFile(store.dataRoot + '/draft-generations.json', () => []).save([{ id: 'gen-9', response: {} }, { id: 'gen-keep', response: {} }])

      const res = await store.call('DELETE', 'contents', { body: { ids: ['cnt-1'], kind: 'draft' } })
      expect(res.code).toBe(0)
      expect(store.disk<unknown[]>('contents.json')).toEqual([])
      expect(store.disk<Array<{ id: string }>>('draft-generations.json').map(g => g.id)).toEqual(['gen-keep'])
    }
    finally {
      store.dispose()
    }
  })
})

describe('上传票据：三种寻址共用同一份实现', () => {
  it('私有 / 体带 publicUploadId / 路径带 publicUploadId 都给出正确上传地址', async () => {
    const priv = await h.call<{ id: string; uploadUrl: string }>('POST', 'assets/uploadSign', { body: { filename: 'a.png' } })
    expect(priv.code).toBe(0)
    expect(priv.data.uploadUrl).toBe('/bosom-friend/api/assets/upload/' + priv.data.id)

    const viaBody = await h.call<{ id: string; uploadUrl: string }>('POST', 'assets/uploadSign', { body: { filename: 'a.png', publicUploadId: 'pub-1' } })
    expect(viaBody.data.uploadUrl).toBe('/bosom-friend/api/assets/public/pub-1/upload/' + viaBody.data.id)

    const viaPath = await h.call<{ id: string; uploadUrl: string }>('POST', 'assets/public/pub-1/uploadSign', { body: { filename: 'b.png' } })
    expect(viaPath.data.uploadUrl).toBe('/bosom-friend/api/assets/public/pub-1/upload/' + viaPath.data.id)
  })
})

describe('接待引擎 poll-now 如实回报（DEF-026）', () => {
  it('返回 triggered 布尔值，调用方据此区分「真的触发」与「正在跑这一轮」', async () => {
    const res = await h.call<{ ok: boolean; triggered: boolean }>('POST', 'v2/customer-reception/poll-now')
    expect(res.code).toBe(0)
    expect(typeof res.data.triggered).toBe('boolean')
  })
})

describe('接口不得假成功（回 code 0 就必须真的做了事）', () => {
  it('收藏不存在的任务如实回 18100，不再静默成功', async () => {
    const post = await h.call('POST', 'agent/tasks/zz-nonexistent/favorite')
    expect(post.code).toBe(18100)
    expect(post.message).toContain('task not found')

    const del = await h.call('DELETE', 'agent/tasks/zz-nonexistent/favorite')
    expect(del.code).toBe(18100)
  })

  it('收藏真实任务后回读为已收藏（确认上面的拒绝不是因为整条链路不通）', async () => {
    const created = await h.call<{ id: string }>('POST', 'agent/tasks', { body: { prompt: '收藏契约探针' } })
    const taskId = created.data.id
    expect((await h.call('POST', 'agent/tasks/' + taskId + '/favorite')).code).toBe(0)
    expect((await h.call<{ favorite: boolean }>('GET', 'agent/tasks/' + taskId)).data.favorite).toBe(true)
    expect((await h.call('DELETE', 'agent/tasks/' + taskId + '/favorite')).code).toBe(0)
    expect((await h.call<{ favorite: boolean }>('GET', 'agent/tasks/' + taskId)).data.favorite).toBe(false)
  })

  it('反馈提交成功就必须真的落盘（不能回 sent:true 却把反馈丢掉）', async () => {
    const res = await h.call<{ sent: boolean }>('POST', 'contact/feedback', { body: { content: '契约用例反馈正文', contact: 'qa@local' } })
    expect(res.code).toBe(0)
    expect(res.data.sent).toBe(true)

    const file = join(h.dataRoot, 'feedback.jsonl')
    expect(existsSync(file), '反馈文件必须真的被创建').toBe(true)
    const body = readFileSync(file, 'utf8')
    expect(body).toContain('契约用例反馈正文')
    expect(body).toContain('receivedAt')
  })

  it('模型配置保存成功就必须真的落盘 llm-user.json（不能吞掉写失败）', async () => {
    const res = await h.call('PUT', 'ai/user-llm', {
      body: { baseUrl: 'https://example.invalid/v1', apiKey: 'sk-contract-probe', model: 'contract-probe-model' },
    })
    expect(res.code).toBe(0)

    const file = join(h.dataRoot, 'llm-user.json')
    expect(existsSync(file), 'llm-user.json 必须真的被创建').toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('contract-probe-model')
  })

  it('作品分析接口在无采样行时给空 metrics + sampleCount=0，而不是一组 0', async () => {
    const res = await h.call<{ metrics: Record<string, number>, sampleCount: number }>(
      'GET',
      'v2/channels/works/douyin/zz-no-such-work/analytics',
    )
    expect(res.code).toBe(0)
    expect(res.data.metrics).toEqual({})
    expect(res.data.sampleCount).toBe(0)
    expect('viewCount' in res.data.metrics, '没有采样行就不能声称播放是 0').toBe(false)
  })

  it('邮箱/手机验证码登录如实拒绝，不再返回 code 0 却什么都不做', async () => {
    for (const path of ['login/mail', 'login/phone']) {
      const res = await h.call('POST', path, { body: { mail: 'a@b.c', phone: '13800000000' } })
      expect(res.code, path + ' 必须如实失败').not.toBe(0)
      expect(res.message).toContain('账号密码')
    }
  })
})
