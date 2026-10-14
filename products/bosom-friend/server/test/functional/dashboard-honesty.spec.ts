import { afterEach, describe, expect, it } from 'vitest'
import { JsonFile } from '../../src/store.ts'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 数据中心指标诚实性（DEF-008 / DEF-015 / DEF-020）——进程内直接驱动 dashboard 路由。
 *
 * 三条语义必须在接口层就分清楚，页面才有东西可如实展示：
 * - available：该项采到非 0 真值；
 * - not-collected-this-sync：该项全 0，而同批其它互动指标有真值（本次只缺这一项，可重新同步）；
 * - no-signal：全部互动指标都是 0，没有差分证据，不声称"平台不提供"。
 * 以及 DEF-020：「已更新 N/M 条」只算采到真值的作品。
 */
const created: Harness[] = []

function makeHarness(records: unknown[], metrics: unknown[]): Harness {
  const h = createHarness()
  created.push(h)
  new JsonFile(h.dataRoot + '/publish-records.json', () => []).save(records)
  new JsonFile(h.dataRoot + '/metrics.json', () => []).save(metrics)
  return h
}

const record = (id: string, workId: string) => ({
  id,
  accountId: 'a1',
  accountType: 'douyin',
  platformWorkId: workId,
  status: 1,
  title: id,
  publishTime: '2026-09-11T02:00:00.000Z',
})
const metric = (workId: string, values: Record<string, number>) => ({
  workId,
  accountId: 'a1',
  platform: 'douyin',
  date: '2026-09-11',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  favoriteCount: 0,
  ...values,
})

afterEach(() => {
  for (const h of created.splice(0)) h.dispose()
})

describe('数据中心指标诚实性', () => {
  it('播放量全 0 而同批点赞有真值 → views 判 not-collected-this-sync', async () => {
    const h = makeHarness([record('r1', 'w1'), record('r2', 'w2')], [
      metric('w1', { likeCount: 12 }),
      metric('w2', { likeCount: 3, commentCount: 1 }),
    ])
    const dash = await h.call<{ metricAvailability: { views: boolean; likes: boolean }; metricAvailabilityReason: { views: string; likes: string } }>(
      'GET',
      'v2/statistics/published-content-summary/dashboard',
    )
    expect(dash.data.metricAvailability.views).toBe(false)
    expect(dash.data.metricAvailability.likes).toBe(true)
    expect(dash.data.metricAvailabilityReason.views).toBe('not-collected-this-sync')
    expect(dash.data.metricAvailabilityReason.likes).toBe('available')
  })

  it('全部互动指标都是 0 → 判 no-signal，不声称平台不提供', async () => {
    const h = makeHarness([record('r1', 'w1')], [metric('w1', {})])
    const dash = await h.call<{ metricAvailabilityReason: { views: string } }>('GET', 'v2/statistics/published-content-summary/dashboard')
    expect(dash.data.metricAvailabilityReason.views).toBe('no-signal')
  })

  it('没有采样行 → 不下任何结论（availability 与 reason 均为 undefined）', async () => {
    const h = makeHarness([record('r1', 'w1')], [])
    const dash = await h.call<{ metricAvailability?: unknown; metricAvailabilityReason?: unknown }>('GET', 'v2/statistics/published-content-summary/dashboard')
    expect(dash.data.metricAvailability).toBeUndefined()
    expect(dash.data.metricAvailabilityReason).toBeUndefined()
  })

  it('没有采样行时，作品行的贡献占比是"未知"而不是 120000% 或 0%', async () => {
    // 分母缺失时老写法是 `sum || 1`：1200 / 1 → 界面显示 "120000.0%"。
    // 占比未知就说不知道——和"平台没提供"一样，是这一族的基本口径。
    const withEngagement = { ...record('r1', 'w1'), engagement: { viewCount: 1200, likeCount: 88 } }
    const noSamples = makeHarness([withEngagement], [])
    const dashA = await noSamples.call<{ topWorks: { byViewGrowth: Array<{ contributionRate: number | null }> } }>(
      'GET',
      'v2/statistics/published-content-summary/dashboard',
    )
    expect(dashA.data.topWorks.byViewGrowth[0]!.contributionRate).toBeNull()

    // 分母来自采样行（另一条作品的采样也算进总量），不是被评估的那条自己的数字。
    const withSamples = makeHarness([withEngagement], [metric('w1', { viewCount: 1200 }), metric('w2', { viewCount: 800 })])
    const dashB = await withSamples.call<{ topWorks: { byViewGrowth: Array<{ contributionRate: number | null }> } }>(
      'GET',
      'v2/statistics/published-content-summary/dashboard',
    )
    expect(dashB.data.topWorks.byViewGrowth[0]!.contributionRate, '有分母时照样给真实占比').toBe(60)
  })

  it('「已更新 N/M 条」只算采到真值的作品，全 0 占位单独报出（DEF-020）', async () => {
    const h = makeHarness([record('r1', 'w1'), record('r2', 'w2'), record('r3', 'w3')], [
      metric('w1', { viewCount: 13016 }),
      metric('w2', {}),
      metric('w3', { likeCount: 7 }),
    ])
    const dash = await h.call<{ updateProgress: { totalCount: number; updatedCount: number; zeroOnlyCount: number } }>(
      'GET',
      'v2/statistics/published-content-summary/dashboard',
    )
    expect(dash.data.updateProgress).toEqual({ totalCount: 3, updatedCount: 2, zeroOnlyCount: 1 })
  })
})
