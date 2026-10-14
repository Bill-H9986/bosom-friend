import { describe, expect, it } from 'vitest'
import {
  CLIP_LATENCY_SECONDS_MAX,
  MEDIA_COMPOSE_OVERHEAD_MS,
  clipLatencyCeilingMs,
  planClipSeconds,
  videoMediaLatencyBudgetMs,
} from '../src/video-duration.ts'
import {
  DEFAULT_MEDIA_BUDGET_MAX_MS,
  generationBudgetMs,
  mediaBudgetMs,
  mediaTimeoutMessage,
} from '../src/generation-watchdog.ts'

/**
 * 媒体预算必须按档位推导，不能是一个定值。
 *
 * 回归自 DEF-107：30 秒档位要下 7 片、1 分钟档 15 片，而定值 15 分钟只够一次下单。
 * 现场的 30 秒成片已经拼好躺在盘上（AI_VID_COMPOSE actual=30.02），记录却被自己的超时判成
 * partial 并写"超时"——用户拿不到已经在盘上的成片。
 */
describe('视频媒体预算按档位推导（DEF-107）', () => {
  it('单片档位：预算覆盖厂商实测最慢的一次下单（4 分 10 秒）', () => {
    const five = mediaBudgetMs('video', { duration: 5 })
    expect(five).toBeGreaterThanOrEqual(CLIP_LATENCY_SECONDS_MAX * 1000)
    expect(five).toBeGreaterThanOrEqual(clipLatencyCeilingMs(1))
    expect(clipLatencyCeilingMs(1)).toBe(CLIP_LATENCY_SECONDS_MAX * 1000 + MEDIA_COMPOSE_OVERHEAD_MS)
  })

  it('30 秒档位（7 片）的预算远大于旧的 15 分钟定值', () => {
    expect(planClipSeconds(30).clips).toHaveLength(7)
    const budget = mediaBudgetMs('video', { duration: 30 })
    expect(budget).toBe(videoMediaLatencyBudgetMs(30))
    expect(budget).toBeGreaterThan(15 * 60_000)
    expect(Math.round(budget / 60_000)).toBe(34)
  })

  it('60 秒档位（15 片）比 30 秒档更长，且随片段数单调增长', () => {
    expect(planClipSeconds(60).clips).toHaveLength(15)
    const thirty = mediaBudgetMs('video', { duration: 30 })
    const sixty = mediaBudgetMs('video', { duration: 60 })
    expect(sixty).toBeGreaterThan(thirty)
    expect(sixty).toBe(clipLatencyCeilingMs(15))
  })

  it('5 分钟档位（75 片）的推导结果被默认上限兜住，不会真的挂 5 小时以上', () => {
    expect(planClipSeconds(300).clips).toHaveLength(75)
    expect(clipLatencyCeilingMs(75)).toBeGreaterThan(DEFAULT_MEDIA_BUDGET_MAX_MS)
    expect(mediaBudgetMs('video', { duration: 300 })).toBe(DEFAULT_MEDIA_BUDGET_MAX_MS)
  })

  it('没有档位时回落到定值：不能因为读不到档位就把任务判超时', () => {
    expect(mediaBudgetMs('video')).toBe(15 * 60_000)
    expect(mediaBudgetMs('video', { duration: 0 })).toBe(15 * 60_000)
    expect(mediaBudgetMs('video', { duration: Number.NaN })).toBe(15 * 60_000)
  })

  it('小于定值的推导结果被抬到定值下限（短片也不会秒超时）', () => {
    expect(mediaBudgetMs('video', { duration: 4 })).toBeGreaterThanOrEqual(15 * 60_000)
  })

  it('部署上限只收紧、不放大；配 0 或非法值等于没配', () => {
    const sixty = mediaBudgetMs('video', { duration: 60 })
    expect(mediaBudgetMs('video', { duration: 60, maxMs: 20 * 60_000 })).toBe(20 * 60_000)
    expect(mediaBudgetMs('video', { duration: 60, maxMs: sixty * 10 })).toBe(sixty)
    expect(mediaBudgetMs('video', { duration: 60, maxMs: 0 })).toBe(sixty)
    expect(mediaBudgetMs('video', { duration: 60, maxMs: Number.NaN })).toBe(sixty)
    expect(DEFAULT_MEDIA_BUDGET_MAX_MS).toBe(4 * 60 * 60_000)
  })

  it('图文预算与档位无关，仍是 8 分钟', () => {
    expect(mediaBudgetMs('image-text', { duration: 60 })).toBe(8 * 60_000)
    expect(mediaBudgetMs(undefined, { duration: 60 })).toBe(8 * 60_000)
  })

  it('超时文案里的分钟数跟着真实预算走（不再固定写 15 分钟）', () => {
    expect(mediaTimeoutMessage(mediaBudgetMs('video', { duration: 30 }), true)).toContain('34 分钟')
    expect(mediaTimeoutMessage(mediaBudgetMs('video', { duration: 60 }), true)).toContain('68 分钟')
  })

  it('停滞预算比同档位的媒体截止时间更宽：媒体还在正常拼接时不会被看门狗判失败', () => {
    for (const duration of [4, 8, 12, 30, 60, 300]) {
      const media = mediaBudgetMs('video', { duration })
      const stall = generationBudgetMs('video', duration)
      expect(stall).toBeGreaterThan(media)
    }
    // 没有档位时保持旧的 20 分钟，行为不变。
    expect(generationBudgetMs('video')).toBe(20 * 60_000)
    expect(generationBudgetMs('image-text', 60)).toBe(10 * 60_000)
  })
})
