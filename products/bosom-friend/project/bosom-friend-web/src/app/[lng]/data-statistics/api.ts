'use client'

import http from '@web/utils/request'

export interface StatisticsMetricValues {
  viewGrowth: number
  likeGrowth: number
  commentGrowth: number
  shareGrowth: number
  favoriteGrowth: number
}

export interface StatisticsWork {
  dataId: string
  platform: string
  title?: string
  coverUrl?: string
  url?: string
  publishedAt?: string
  viewGrowth: number
  likeGrowth: number
  commentGrowth: number
  shareGrowth: number
  favoriteGrowth: number
  contributionRate: number
}

export interface StatisticsDashboard {
  overall: {
    workCount: number
    publishedWorkCount: number
  } & StatisticsMetricValues
  /**
   * 是否有该项指标的非 0 采样值。全 0 只能说明"这次没看到值"，不能说成平台真值 0。
   */
  metricAvailability?: {
    views: boolean
    likes: boolean
    comments: boolean
    shares: boolean
    favorites: boolean
  }
  /**
   * 每项指标没值的原因。'not-collected-this-sync' = 本次只缺这一项（同批其它互动指标有真值），
   * 界面必须说"本次未采到/可重新同步"；'no-signal' = 全部互动指标都是 0，没有差分证据，
   * 不声称"平台不提供"；'available' = 有非 0 采样值。
   */
  metricAvailabilityReason?: {
    views: MetricAvailabilityReason
    likes: MetricAvailabilityReason
    comments: MetricAvailabilityReason
    shares: MetricAvailabilityReason
    favorites: MetricAvailabilityReason
  }
  growthTrend: Array<{
    date: string
    workCount: number
  } & StatisticsMetricValues>
  platformContribution: Array<{
    platform: string
    count: number
  } & StatisticsMetricValues>
  platformEfficiency: Array<{
    platform: string
    count: number
    avgViews: number
    avgLikes: number
    avgComments: number
  }>
  topWorks: {
    byViewGrowth: StatisticsWork[]
    byLikeGrowth: StatisticsWork[]
    byCommentGrowth: StatisticsWork[]
    byShareGrowth: StatisticsWork[]
    byFavoriteGrowth: StatisticsWork[]
  }
  updateProgress: {
    totalCount: number
    updatedCount: number
    /** 对上了 workId 但本次只采到全 0 占位的作品数：不并入「已更新」，但要如实告诉用户。 */
    zeroOnlyCount?: number
  }
  dataUpdatedAt?: string
}

export type GrowthMetricKey = 'viewGrowth' | 'likeGrowth' | 'commentGrowth' | 'shareGrowth' | 'favoriteGrowth'

/** 指标没值的原因，与响应字段 metricAvailabilityReason 的取值一一对应。 */
export type MetricAvailabilityReason = 'available' | 'not-collected-this-sync' | 'no-signal'

/** 指标 key ↔ metricAvailability 字段名的映射。 */
export const metricAvailabilityKey: Record<GrowthMetricKey, 'views' | 'likes' | 'comments' | 'shares' | 'favorites'> = {
  viewGrowth: 'views',
  likeGrowth: 'likes',
  commentGrowth: 'comments',
  shareGrowth: 'shares',
  favoriteGrowth: 'favorites',
}

export const growthMetrics: Array<{ key: GrowthMetricKey; labelKey: string }> = [
  { key: 'viewGrowth', labelKey: 'dashboard.metrics.views' },
  { key: 'likeGrowth', labelKey: 'dashboard.metrics.likes' },
  { key: 'commentGrowth', labelKey: 'dashboard.metrics.comments' },
  { key: 'shareGrowth', labelKey: 'dashboard.metrics.shares' },
  { key: 'favoriteGrowth', labelKey: 'dashboard.metrics.favorites' },
]

export async function getPublishedContentDashboard(
  params: {
    startDate?: string
    endDate?: string
    platforms?: string[]
    accountId?: string
  },
  signal?: AbortSignal,
): Promise<StatisticsDashboard> {
  const query: Record<string, string> = {}
  if (params.startDate)
    query.startDate = params.startDate
  if (params.endDate)
    query.endDate = params.endDate
  if (params.accountId)
    query.accountId = params.accountId
  if (params.platforms?.length)
    query.platforms = params.platforms.join(',')
  const res = await http.get<StatisticsDashboard>(
    'v2/statistics/published-content-summary/dashboard',
    query,
    true,
    { signal },
  )
  if (!res || res.code !== 0 || !res.data)
    throw new Error('Failed to load dashboard')
  return res.data
}
