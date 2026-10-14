import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { MIN_RANKED_WORKS, engagementRatingOf, performanceScore } from '../../src/sample-rating.ts'
import type { KnowledgeState } from '../../src/knowledge-distill.ts'

/**
 * 用发布后的真实表现给样本打分（ADR-004 附录 P1）。
 *
 * 为什么锁这一条：复利飞轮此前只能靠用户手点五星才转得起来，用户不点就永远停在第一次。
 * 而「这条内容发出去之后平台给了什么数据」是产品手里更硬的信号——但它有三处很容易做错：
 * ① 拿弱信号当强信号（发布表现不等于文案好）；② 把用户自己的判断覆盖掉；
 * ③ 排名样本太少也硬排名。下面三条负向对照分别盯着这三处。
 */

vi.mock('../../src/kernel-client.ts', async () => ({
  ...((({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  )),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      onDelta?.('模型回的一句话')
      return { text: '模型回的一句话' }
    },
    close: async () => {},
  }),
}))

const created: Harness[] = []

/** 一条已发布的作品记录；engagement 只在给了的时候写（缺省 = 平台还没采到）。 */
function record(id: string, options: { accountId?: string, draftId?: string, views?: number } = {}) {
  return {
    id,
    accountId: options.accountId ?? 'acc-1',
    accountType: 'xhs',
    type: 'ImageText',
    status: 1,
    title: '作品 ' + id,
    publishTime: '2026-09-20T10:00:00.000Z',
    platformWorkId: id,
    ...(options.draftId !== undefined ? { draftId: options.draftId } : {}),
    ...(options.views !== undefined ? { engagement: { viewCount: options.views, likeCount: 3 } } : {}),
  }
}

/** 一条对象动作留下的账本样本（形状与 api.ts 写下的一致）。 */
function sample(draftId: string, options: { rating?: number, ratingSource?: string } = {}) {
  return {
    id: 'dist-object-action-draft-' + draftId + '-draft-title',
    task: 'chat',
    instruction: '给这条草稿改标题',
    output: 'AI 改过的标题 ' + draftId,
    model: 'probe',
    knowledgePaths: [],
    knowledgeChars: 0,
    status: 'success',
    rating: options.rating ?? 0,
    ...(options.ratingSource !== undefined ? { ratingSource: options.ratingSource } : {}),
    createdAt: '2026-09-20T09:00:00.000Z',
    sourceId: 'object-action-draft-' + draftId + '-draft-title',
    objectKind: 'draft',
    objectId: draftId,
  }
}

const knowledgeDefault = () => ({ notes: {}, vault: { path: '', builtIn: true } })

/** 建一个装好数据的实例；账本与记录都按真实落盘形状写进去。 */
function makeHarness(records: unknown[], samples: unknown[]): Harness {
  const h = createHarness()
  created.push(h)
  new JsonFile(h.dataRoot + '/publish-records.json', () => []).save(records)
  const file = h.dataRoot + '/knowledge.json'
  const knowledge = new JsonFile<KnowledgeState>(file, knowledgeDefault).load()
  knowledge.distillations = samples as KnowledgeState['distillations']
  new JsonFile<KnowledgeState>(file, knowledgeDefault).save(knowledge)
  return h
}

/** 读回账本样本。 */
function readSamples(h: Harness): Array<{ id: string, rating: number, ratingSource?: string }> {
  const knowledge = new JsonFile<KnowledgeState>(h.dataRoot + '/knowledge.json', knowledgeDefault).load()
  return (knowledge.distillations ?? []) as Array<{ id: string, rating: number, ratingSource?: string }>
}

/** 配一个大模型提供方（助手冷启动需要它才会走到语境刷新那一步）。 */
async function configureLlm(h: Harness): Promise<void> {
  await h.call('PUT', 'ai/user-llm', {
    body: {
      providers: [{ id: 'chat', displayName: '对话网关', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-probe', models: ['chat-probe'] }],
      activeProviderId: 'chat',
    },
  })
}

/**
 * 触发一次稳定语境刷新。
 *
 * 走助手冷启动这条**真实路径**而不是直接调函数：这条链最容易坏的地方就是「函数写好了、没人调它」。
 */
async function triggerRefresh(h: Harness): Promise<void> {
  // 这条路由只走 SSE 流，信封本来就是空的（断言 code 会永远红）；真正的判据在下面：
  // 该打上分的样本打上了、不该动的一条没动。
  await h.call('POST', 'agent/tasks', { body: { prompt: '随便问一句', includePartialMessages: true } })
}

afterEach(() => {
  for (const h of created.splice(0)) h.dispose()
})

describe('表现分与名次口径', () => {
  it('优先播放量；没有播放量退回点赞；缺失或全 0 一律「还没采到」', () => {
    expect(performanceScore({ viewCount: 1200, likeCount: 88 })).toBe(1200)
    expect(performanceScore({ likeCount: 12 })).toBe(12)
    expect(performanceScore({ viewCount: 0, likeCount: 0 })).toBeUndefined()
    expect(performanceScore({})).toBeUndefined()
    expect(performanceScore(undefined)).toBeUndefined()
  })

  it('只有跑赢的才给分，而且样本太少时不排名', () => {
    const scores = [100, 80, 60, 40, 20]
    expect(engagementRatingOf(scores, 100), '第一名').toBe(5)
    expect(engagementRatingOf(scores, 80)).toBe(4)
    expect(engagementRatingOf(scores, 60), '没跑赢的不给分').toBeUndefined()
    expect(engagementRatingOf([100, 80], 100), '两条作品排名没有意义').toBeUndefined()
    expect(MIN_RANKED_WORKS).toBeGreaterThan(2)
  })

  it('样本上记的是对象身份，不是从来源 id 里拆出来的', () => {
    // 草稿 id 自己是 cnt-abc123、动作 id 是 draft-title，两者都含连字符：
    // 按分隔符拆就是猜。字段是记下来的（见 api.ts 的 runObjectAction）。
    const row = sample('cnt-abc123')
    expect(row.objectKind).toBe('draft')
    expect(row.objectId).toBe('cnt-abc123')
  })
})

describe('真实表现回流到样本', () => {
  const works = (draftId: string) => [
    record('w1', { draftId, views: 5000 }),
    record('w2', { views: 900 }),
    record('w3', { views: 700 }),
    record('w4', { views: 500 }),
    record('w5', { views: 300 }),
  ]

  it('跑赢的那条作品，把它来源草稿上的样本评上分', async () => {
    const h = makeHarness(works('cnt-win'), [sample('cnt-win'), sample('cnt-lose')])
    await configureLlm(h)
    await triggerRefresh(h)
    const rows = readSamples(h)
    const win = rows.find(item => item.id === 'dist-object-action-draft-cnt-win-draft-title')!
    expect(win.rating, '跑赢的样本拿到分').toBe(5)
    expect(win.ratingSource, '要记清楚这个分是机器按表现给的').toBe('engagement')
    const lose = rows.find(item => item.id === 'dist-object-action-draft-cnt-lose-draft-title')!
    expect(lose.rating, '没有作品的样本一条都不动').toBe(0)
  })

  it('用户自己打过的分，机器不许改', async () => {
    const h = makeHarness(works('cnt-user'), [sample('cnt-user', { rating: 2, ratingSource: 'user' })])
    await configureLlm(h)
    await triggerRefresh(h)
    // 按 id 找那一行：助手冷启动这一轮也会记一条自己的样本，[0] 不一定是它。
    const row = readSamples(h).find(item => item.id === 'dist-object-action-draft-cnt-user-draft-title')!
    expect(row.rating, '用户说 2 分就是 2 分，哪怕这条跑赢了').toBe(2)
    expect(row.ratingSource).toBe('user')
  })

  it('作品不够排名条数时一条都不评（不看数据就下结论比不评更糟）', async () => {
    const h = makeHarness(
      [record('w1', { draftId: 'cnt-few', views: 5000 }), record('w2', { views: 900 })],
      [sample('cnt-few')],
    )
    await configureLlm(h)
    await triggerRefresh(h)
    const row = readSamples(h).find(item => item.id === 'dist-object-action-draft-cnt-few-draft-title')!
    expect(row.rating, '只有两条作品可比的账号里，一条都不评').toBe(0)
  })
})

describe('发布记录要留下它来自哪条草稿', () => {
  it('界面传来的来源草稿会落进记录里（否则整条链在落库这一步就断了）', async () => {
    const h = createHarness()
    created.push(h)
    const res = await h.call<{ flowId: string }>('POST', 'v2/channels/publish/flows', {
      body: {
        content: { title: '标题', body: '正文', media: [{ url: 'https://example.com/a.png' }] },
        context: { type: 'ImageText', materialId: 'cnt-from-ui' },
        items: [{ accountId: 'acc-1', platform: 'xhs' }],
      },
    })
    expect(res.code, String(res.message)).toBe(0)
    const records = new JsonFile<Array<{ draftId?: string }>>(h.dataRoot + '/publish-records.json', () => []).load()
    expect(records[0]?.draftId).toBe('cnt-from-ui')
  })
})
