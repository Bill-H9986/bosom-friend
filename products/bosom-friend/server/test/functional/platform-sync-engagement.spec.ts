import { describe, expect, it } from 'vitest'
import { upsertMetrics, upsertRecord } from '../../src/platform-sync.ts'
import type { ZyMetricRow, ZyPublishRecord, ZySocialAccount } from '../../src/types.ts'

/**
 * 平台同步回写的互动指标必须「有则写、无则缺省」（要求二 R3 无源不显示）。
 *
 * 平台没返回的计数如果写成 0，界面就无法区分「确实是 0」和「根本没采到」，
 * 于是会向用户展示一个编造的 0。这里锁死 upsertRecord 的写入语义。
 */
const account = { id: 'a1', type: 'douyin' } as unknown as ZySocialAccount

describe('平台同步互动指标诚实性', () => {
  it('平台只给了部分计数 → 只写这些字段，其余保持缺省而不是 0', () => {
    const records: ZyPublishRecord[] = []
    upsertRecord(records, account, { dataId: 'w1', viewCount: 13016, likeCount: 12 }, 'douyin')

    const engagement = records[0]!.engagement as Record<string, number | undefined>
    expect(engagement.viewCount).toBe(13016)
    expect(engagement.likeCount).toBe(12)
    expect(engagement.commentCount).toBeUndefined()
    expect(engagement.shareCount).toBeUndefined()
    expect(engagement.favoriteCount).toBeUndefined()
    expect(engagement.clickCount).toBeUndefined()
    expect(engagement.impressionCount).toBeUndefined()
  })

  it('平台一个计数都没给 → engagement 为空对象，不伪造 7 个 0', () => {
    const records: ZyPublishRecord[] = []
    upsertRecord(records, account, { dataId: 'w2', title: '无计数作品' }, 'douyin')

    expect(records[0]!.engagement).toEqual({})
    expect(Object.keys(records[0]!.engagement ?? {})).toHaveLength(0)
  })

  it('指标行同样只写平台给了的计数，其余整键缺省', () => {
    const metrics: ZyMetricRow[] = []
    upsertMetrics(metrics, account, { dataId: 'w4', publishTime: '2026-09-12T00:00:00.000Z', likeCount: 37, shareCount: 55 }, 'douyin')

    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.likeCount).toBe(37)
    expect(metrics[0]!.shareCount).toBe(55)
    expect(metrics[0]!.viewCount).toBeUndefined()
    expect(metrics[0]!.favoriteCount).toBeUndefined()
    expect(metrics[0]!.commentCount).toBeUndefined()
  })

  it('平台这次没给的计数要清掉上一次的旧值，不留陈旧数字', () => {
    const metrics: ZyMetricRow[] = []
    const work = { dataId: 'w5', publishTime: '2026-09-12T00:00:00.000Z' }
    upsertMetrics(metrics, account, { ...work, viewCount: 13016 }, 'douyin')
    expect(metrics[0]!.viewCount).toBe(13016)

    upsertMetrics(metrics, account, work, 'douyin')
    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.viewCount).toBeUndefined()
  })

  it('抖音真实播放量：投稿分析接口给了才写，没给的作品绝不留 0', () => {
    // 真实抓包：账号 acc-ejn65i8l 的作品 7586620032134778150 在作品列表接口里
    // digg_count=37、share_count=55，而 statistics.play_count 是 0——这个 0 是占位，
    // 创作者中心页面自己「播放」一栏显示的都是「-」。
    // 真实播放量只在投稿分析接口 item_contribution_top（english_metric_name=play_cnt），
    // 实测作品 7680660673825869119 在近 7 天拿到 metric_value=5。
    const records: ZyPublishRecord[] = []
    // worker 只会给「分析接口确实返回了该作品」的 work 补上 viewCount 字段。
    upsertRecord(records, account, { dataId: '7586620032134778150', likeCount: 37, shareCount: 55 }, 'douyin')
    upsertRecord(records, account, { dataId: '7680660673825869119', viewCount: 5 }, 'douyin')

    const placeholder = records.find(r => r.platformWorkId === '7586620032134778150')!
    expect(placeholder.engagement?.likeCount, '列表接口的真值照常写入').toBe(37)
    expect(placeholder.engagement?.shareCount).toBe(55)
    expect(placeholder.engagement?.viewCount, '列表接口的占位 0 不得变成播放量 0').toBeUndefined()

    const real = records.find(r => r.platformWorkId === '7680660673825869119')!
    expect(real.engagement?.viewCount, '分析接口的真值必须写进去').toBe(5)
  })

  it('重复同步同一作品 → 原位合并且不新增记录', () => {
    const records: ZyPublishRecord[] = []
    upsertRecord(records, account, { dataId: 'w3', viewCount: 5 }, 'douyin')
    upsertRecord(records, account, { dataId: 'w3', viewCount: 9 }, 'douyin')

    expect(records).toHaveLength(1)
    expect(records[0]!.engagement?.viewCount).toBe(9)
  })
})
