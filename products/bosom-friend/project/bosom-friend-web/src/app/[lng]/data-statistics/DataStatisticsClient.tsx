'use client'

import {
  BarChart3,
  FileText,
  Eye,
  Heart,
  LineChart,
  Loader2,
  MessageCircle,
  RefreshCw,
  Share2,
  Star,
} from 'lucide-react'
import Link from '@web/next-shims/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DateRangePicker from '@web/components/ui/date-range-picker'
import { Button } from '@web/components/ui/button'
import { useGetClientLng } from '@web/hooks/useSystem'
import { cn } from '@web/utils/className'
import { formatNumber, formatTime } from '@web/utils/format'
import { useTransClient } from '@web/app/i18n/client'
import { EmptyState } from '@web/components/common/EmptyState'
import { resolveAsset } from '@web/utils/assetPath'
import { DomesticPlatInfoMap, PlatType } from '@web/app/config/platConfig'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import {
  getPublishedContentDashboard,
  growthMetrics,
  metricAvailabilityKey,
} from './api'
import type {
  GrowthMetricKey,
  MetricAvailabilityReason,
  StatisticsDashboard,
  StatisticsMetricValues,
  StatisticsWork,
} from './api'
import { EChart } from './components/EChart'

/** 桌面端实时采集节流：2 分钟内不重复触发 CDP 采集（采集需刷新作品管理页，较重） */
let lastDesktopSyncAt = 0
const DESKTOP_SYNC_THROTTLE_MS = 2 * 60 * 1000

async function triggerDesktopSyncIfNeeded() {
  const ipc = typeof window === 'undefined' ? null : (window as any).ipcRenderer
  if (!ipc || ipc.__zyShim === true)
    return
  const now = Date.now()
  if (now - lastDesktopSyncAt < DESKTOP_SYNC_THROTTLE_MS)
    return
  lastDesktopSyncAt = now
  try {
    await ipc.invoke('ICP_PUBLISH_SYNC_RECORDS')
  }
  catch {
    // 采集失败不阻断概览加载（后端仍返回已有数据）
  }
}

const METRIC_ICONS = {
  viewGrowth: Eye,
  likeGrowth: Heart,
  commentGrowth: MessageCircle,
  shareGrowth: Share2,
  favoriteGrowth: Star,
}

function compact(value: number) {
  if (!Number.isFinite(value))
    return '0'
  if (Math.abs(value) >= 10000)
    return `${(value / 10000).toFixed(1)}w`
  return formatNumber(value)
}

function MetricCard({ label, value, icon: Icon, tone = 'default', hint }: {
  label: string
  value: number
  icon: React.ComponentType<{ className?: string }>
  tone?: 'default' | 'primary'
  hint?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/60 bg-card p-4 transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'primary' && 'text-primary')} />
        <span className="truncate">{label}</span>
      </div>
      <p className="font-[DIN,Suisseintl,sans-serif] text-2xl font-semibold tabular-nums text-foreground">
        {compact(value)}
      </p>
      {hint !== undefined && (
        <p data-testid="data-statistics-metric-hint" className="text-[11px] leading-4 text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

function TopWorkRow({ work, metric, maxValue, rank }: {
  work: StatisticsWork
  metric: GrowthMetricKey
  maxValue: number
  rank: number
}) {
  const { t } = useTransClient('publishedContentSummary')
  const lng = useGetClientLng()
  const title = work.title || t('states.untitled')
  const value = work[metric]
  const width = maxValue > 0 ? Math.max(4, (value / maxValue) * 100) : 0
  const platformInfo = DomesticPlatInfoMap.get(work.platform as PlatType)

  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_minmax(140px,0.75fr)] sm:items-center">
      <span
        data-testid={`data-statistics-growth-work-rank-${rank}`}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-[3px] bg-center bg-cover bg-no-repeat text-[11px] font-semibold leading-none tabular-nums',
          rank <= 3 ? 'text-gradient-foreground' : 'bg-muted text-muted-foreground',
        )}
          style={rank <= 3 ? { backgroundImage: `url('${resolveAsset(`./assets/data-statistics/rank-${rank}.svg`)}')` } : undefined}
      >
        {rank}
      </span>
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          {work.coverUrl
            ? (
                <img
                  src={work.coverUrl}
                  alt={title}
                  width={40}
                  height={40}
                  loading="lazy"
                  className="size-full object-cover"
                />
              )
            : (
                <FileText className="size-4" aria-hidden />
              )}
        </div>
        <div className="min-w-0">
          {work.url
            ? (
                <a
                  href={work.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block min-w-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <p className="truncate font-medium text-foreground">{title}</p>
                </a>
              )
            : <p className="truncate font-medium text-foreground">{title}</p>}
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{platformInfo?.name ?? work.platform}</span>
            {work.publishedAt && (
              <span className="truncate">{formatTime(work.publishedAt, 'MM-DD')}</span>
            )}
          </div>
        </div>
      </div>
      <div className="col-start-2 min-w-0 sm:col-start-auto">
        <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
          <span className="font-[DIN,Suisseintl,sans-serif] font-semibold tabular-nums text-foreground">
            {compact(value)}
          </span>
          <span className="text-muted-foreground">
            {Number(work.contributionRate ?? 0).toFixed(1)}
            %
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
        </div>
      </div>
    </div>
  )
}

/**
 * 指标没值时的如实文案。"本次没采到"与"平台未提供"是两件事：抖音同一批作品的历史同步
 * 采到过真实播放量，全 0 只能是本次没采到，必须让用户知道可以重新同步；无判定信号时不声称平台不提供。
 * @param reason - 服务端给出的没值原因。
 * @param t - 当前命名空间的翻译函数。
 * @returns 概览卡上的短提示。
 */
function metricUnavailableHint(reason: MetricAvailabilityReason | undefined, t: (key: string) => string): string {
  if (reason === 'not-collected-this-sync')
    return t('dashboard.metricNotCollectedShort')
  if (reason === 'no-signal')
    return t('dashboard.metricNoSignalShort')
  return t('dashboard.metricUnavailableShort')
}

/** 图表/排行上的指标说明：按服务端 reason 区分「本次未采到」与「无判定信号」。 */
function MetricNotice({ metric, available, reason }: {
  metric: GrowthMetricKey
  available?: boolean
  reason?: MetricAvailabilityReason
}) {
  const { t } = useTransClient('publishedContentSummary')
  if (available !== false)
    return null
  const label = t(growthMetrics.find(item => item.key === metric)?.labelKey ?? '')
  const textKey = reason === 'not-collected-this-sync'
    ? 'dashboard.metricNotCollected'
    : reason === 'no-signal'
      ? 'dashboard.metricNoSignal'
      : 'dashboard.metricUnavailable'
  return (
    <p data-testid="data-statistics-metric-unavailable" className="mt-3 text-xs leading-5 text-muted-foreground" role="status">
      {t(textKey, { metric: label })}
    </p>
  )
}

function OverviewCards({ overall, availability, reasons }: {
  overall: StatisticsDashboard['overall']
  availability: StatisticsDashboard['metricAvailability']
  reasons: StatisticsDashboard['metricAvailabilityReason']
}) {
  const { t } = useTransClient('publishedContentSummary')
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
      <MetricCard
        label={t('dashboard.metrics.workCount')}
        value={overall.workCount}
        icon={FileText}
      />
      <MetricCard
        label={t('dashboard.metrics.publishedWorkCount')}
        value={overall.publishedWorkCount}
        icon={FileText}
        tone="primary"
      />
      {growthMetrics.map(({ key, labelKey }) => {
        const Icon = METRIC_ICONS[key]
        // 指标全 0 时必须说出来，且要说清是"本次未采到（可重新同步）"还是"无判定信号"：
        // 否则用户看到"播放 0"会以为是自己的内容没播放。
        const missing = availability?.[metricAvailabilityKey[key]] === false
        return (
          <MetricCard
            key={key}
            label={t(labelKey)}
            value={overall[key]}
            icon={Icon}
            hint={missing ? metricUnavailableHint(reasons?.[metricAvailabilityKey[key]], t) : undefined}
          />
        )
      })}
    </div>
  )
}

function GrowthChartSection({ dashboard, metric, onMetricChange }: {
  dashboard: StatisticsDashboard
  metric: GrowthMetricKey
  onMetricChange: (metric: GrowthMetricKey) => void
}) {
  const { ready, t } = useTransClient('publishedContentSummary')
  const lng = useGetClientLng()

  const option = useMemo(() => {
    const dates = dashboard.growthTrend.map(item => item.date.slice(5))
    const values = dashboard.growthTrend.map(item => item[metric])
    const color = '#a78bfa'
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 44, right: 16, top: 24, bottom: 28 },
      xAxis: { type: 'category', data: dates, boundaryGap: false },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(128,128,128,0.15)' } } },
      series: [{
        type: 'line',
        data: values,
        smooth: true,
        symbolSize: 6,
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(169,137,255,0.25)' },
              { offset: 1, color: 'rgba(169,137,255,0.02)' },
            ],
          },
        },
      }],
    }
  }, [dashboard.growthTrend, metric])

  if (!ready)
    return null

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LineChart className="size-4 shrink-0 text-primary" aria-hidden />
          <h2 className="section-title">
            {t('dashboard.growthTitle')}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {growthMetrics.map(({ key, labelKey }) => (
            <button
              key={key}
              type="button"
              onClick={() => onMetricChange(key)}
              className={cn(
                'btn btn-sm rounded-lg font-medium',
                metric === key
                  ? 'btn-secondary text-brand-purple-deep'
                  : 'btn-ghost text-muted-foreground',
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
      <MetricNotice
        metric={metric}
        available={dashboard.metricAvailability?.[metricAvailabilityKey[metric]]}
        reason={dashboard.metricAvailabilityReason?.[metricAvailabilityKey[metric]]}
      />
      {dashboard.growthTrend.length > 0
        ? (
            <EChart
              option={option}
              className="mt-3 h-72 md:h-[360px]"
              testId="data-statistics-growth-chart"
            />
          )
        : (
            <div
              data-testid="data-statistics-growth-chart"
              className="mt-3 flex h-72 items-center justify-center text-sm text-muted-foreground md:h-[360px]"
              role="status"
            >
              {t('states.noData')}
            </div>
          )}
    </section>
  )
}

function PlatformContributionSection({ dashboard, onSelectPlatform, selectedPlatform }: {
  dashboard: StatisticsDashboard
  onSelectPlatform: (platform?: string) => void
  selectedPlatform?: string
}) {
  const { ready, t } = useTransClient('publishedContentSummary')

  const pieOption = useMemo(() => {
    const data = dashboard.platformContribution.map(item => ({
      name: DomesticPlatInfoMap.get(item.platform as PlatType)?.name ?? item.platform,
      value: item.count,
      platform: item.platform,
    }))
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '44%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontWeight: 600 } },
        data,
      }],
    }
  }, [dashboard.platformContribution])

  if (!ready)
    return null

  return (
    <section className="panel">
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-primary" aria-hidden />
        <h2 className="section-title">
          {t('dashboard.platformContributionTitle')}
        </h2>
      </div>
      {dashboard.platformContribution.length > 0
        ? (
            <EChart
              option={pieOption}
              className="mt-3 h-64"
              testId="data-statistics-platform-contribution-chart"
              onDataClick={(index) => {
                const platform = dashboard.platformContribution[index]?.platform
                if (platform)
                  onSelectPlatform(selectedPlatform === platform ? undefined : platform)
              }}
            />
          )
        : (
            <div
              data-testid="data-statistics-platform-contribution-chart"
              className="mt-3 flex h-64 items-center justify-center text-sm text-muted-foreground"
              role="status"
            >
              {t('states.noData')}
            </div>
          )}
      <div className="mt-2 flex flex-wrap gap-2">
        {dashboard.platformContribution.map(item => (
          <button
            key={item.platform}
            type="button"
            onClick={() => onSelectPlatform(selectedPlatform === item.platform ? undefined : item.platform)}
            className={cn(
              'btn btn-sm rounded-full',
              selectedPlatform === item.platform
                ? 'btn-secondary border-primary/50 text-brand-purple-deep'
                : 'btn-outline text-muted-foreground',
            )}
          >
            {DomesticPlatInfoMap.get(item.platform as PlatType)?.name ?? item.platform}
            {' '}
            {item.count}
          </button>
        ))}
      </div>
    </section>
  )
}

function PlatformEfficiencySection({ dashboard }: { dashboard: StatisticsDashboard }) {
  const { ready, t } = useTransClient('publishedContentSummary')
  const maxViews = Math.max(1, ...dashboard.platformEfficiency.map(item => item.avgViews))
  const maxLikes = Math.max(1, ...dashboard.platformEfficiency.map(item => item.avgLikes))
  const maxComments = Math.max(1, ...dashboard.platformEfficiency.map(item => item.avgComments))

  if (!ready)
    return null

  return (
    <section className="panel">
      <div className="flex items-center gap-2">
        <BarChart3 className="size-4 text-primary" aria-hidden />
        <h2 className="section-title">
          {t('dashboard.platformEfficiencyTitle')}
        </h2>
      </div>
      {dashboard.platformEfficiency.length > 0
        ? (
            <div className="mt-4 flex flex-col gap-3">
              {dashboard.platformEfficiency.map(item => (
                <div key={item.platform} className="grid grid-cols-[96px_minmax(0,1fr)_72px] items-center gap-3 text-xs">
                  <span className="truncate font-medium text-foreground">
                    {DomesticPlatInfoMap.get(item.platform as PlatType)?.name ?? item.platform}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${(item.avgViews / maxViews) * 100}%` }} />
                    </div>
                    <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand-cyan" style={{ width: `${(item.avgLikes / maxLikes) * 100}%` }} />
                    </div>
                    <div className="h-2 w-12 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-muted-foreground/50" style={{ width: `${(item.avgComments / maxComments) * 100}%` }} />
                    </div>
                  </div>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {compact(item.avgViews)}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-end gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-primary" />
                  {t('dashboard.metrics.views')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-brand-cyan" />
                  {t('dashboard.metrics.likes')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-muted-foreground/50" />
                  {t('dashboard.metrics.comments')}
                </span>
              </div>
              <MetricNotice
                metric="viewGrowth"
                available={dashboard.metricAvailability?.views}
                reason={dashboard.metricAvailabilityReason?.views}
              />
            </div>
          )
        : (
            <div className="mt-3 flex h-32 items-center justify-center text-sm text-muted-foreground" role="status">
              {t('states.noData')}
            </div>
          )}
    </section>
  )
}

function TopWorksSection({ dashboard, metric, onMetricChange }: {
  dashboard: StatisticsDashboard
  metric: GrowthMetricKey
  onMetricChange: (metric: GrowthMetricKey) => void
}) {
  const { ready, t } = useTransClient('publishedContentSummary')
  const key = `by${metric.charAt(0).toUpperCase()}${metric.slice(1)}` as keyof StatisticsDashboard['topWorks']
  const works = dashboard.topWorks[key] || []
  const maxValue = Math.max(1, ...works.map(work => work[metric]))

  if (!ready)
    return null

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Star className="size-4 text-primary" aria-hidden />
          <h2 className="section-title">
            {t('dashboard.topWorksTitle')}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {growthMetrics.map(({ key: itemKey, labelKey }) => (
            <button
              key={itemKey}
              type="button"
              onClick={() => onMetricChange(itemKey)}
              className={cn(
                'btn btn-sm rounded-lg font-medium',
                metric === itemKey
                  ? 'btn-secondary text-brand-purple-deep'
                  : 'btn-ghost text-muted-foreground',
              )}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
      <MetricNotice
        metric={metric}
        available={dashboard.metricAvailability?.[metricAvailabilityKey[metric]]}
        reason={dashboard.metricAvailabilityReason?.[metricAvailabilityKey[metric]]}
      />
      {works.length > 0
        ? (
            <div className="mt-3 divide-y divide-border">
              {works.map((work, index) => (
                <TopWorkRow
                  key={`${work.platform}-${work.dataId}`}
                  work={work}
                  metric={metric}
                  maxValue={maxValue}
                  rank={index + 1}
                />
              ))}
            </div>
          )
        : (
            <div className="mt-3 flex h-32 items-center justify-center text-sm text-muted-foreground" role="status">
              {t('states.noData')}
            </div>
          )}
    </section>
  )
}

function FilterBar({
  platforms,
  selectedPlatforms,
  onPlatformsChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  loading,
  onQuery,
  updateProgress,
  dataUpdatedAt,
}: {
  platforms: Array<{ platform: string; name: string }>
  selectedPlatforms: string[]
  onPlatformsChange: (platforms: string[]) => void
  startDate: string | null
  endDate: string | null
  onStartDateChange: (date: string | null) => void
  onEndDateChange: (date: string | null) => void
  loading: boolean
  onQuery: () => void
  updateProgress: StatisticsDashboard['updateProgress'] | null
  dataUpdatedAt?: string
}) {
  const { t } = useTransClient('publishedContentSummary')
  const togglePlatform = useCallback((platform: string) => {
    onPlatformsChange(selectedPlatforms.includes(platform)
      ? selectedPlatforms.filter(item => item !== platform)
      : [...selectedPlatforms, platform])
  }, [selectedPlatforms, onPlatformsChange])

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-8 cursor-pointer shadow-none',
              selectedPlatforms.length === 0 && 'border-primary/40 bg-primary/5 text-brand-purple-deep',
            )}
            onClick={() => onPlatformsChange([])}
          >
            {t('filters.allPlatforms')}
          </Button>
          {platforms.map(({ platform, name }) => (
            <Button
              key={platform}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                'h-8 cursor-pointer shadow-none',
                selectedPlatforms.includes(platform)
                  ? 'border-primary/40 bg-primary/5 text-brand-purple-deep'
                  : 'text-muted-foreground',
              )}
              onClick={() => togglePlatform(platform)}
            >
              {name}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onStartChange={onStartDateChange}
            onEndChange={onEndDateChange}
          />
          <Button
            data-testid="data-statistics-query"
            className="cursor-pointer shadow-none"
            disabled={loading}
            size="default"
            type="button"
            onClick={onQuery}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t('actions.query')}
          </Button>
        </div>
      </div>
      <div className="mt-2 flex shrink-0 flex-wrap items-center justify-end gap-y-1 self-end text-xs text-muted-foreground lg:ml-auto lg:self-auto lg:text-right">
        {updateProgress && (
          <span data-testid="data-statistics-update-progress" className="font-medium text-foreground tabular-nums">
            {(updateProgress.zeroOnlyCount ?? 0) > 0
              ? t('page.updateProgressPartial', {
                  total: updateProgress.totalCount,
                  updated: updateProgress.updatedCount,
                  zeroOnly: updateProgress.zeroOnlyCount ?? 0,
                })
              : t('page.updateProgress', {
                  total: updateProgress.totalCount,
                  updated: updateProgress.updatedCount,
                })}
          </span>
        )}
        <span data-testid="data-statistics-updated-at" className={updateProgress ? 'ml-2 border-l pl-2 tabular-nums' : 'tabular-nums'}>
          {dataUpdatedAt
            ? t('page.updatedAt', { date: formatTime(dataUpdatedAt, 'MM-DD HH:mm') })
            : t('page.noCapturedAt')}
        </span>
      </div>
      <div className="mt-3 h-px w-full bg-gradient-back" aria-hidden />
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1600px] animate-pulse px-4 pb-4 md:px-6 md:pb-5">
      <div className="h-6 w-40 rounded bg-muted" />
      <div className="mt-4 h-8 w-full rounded bg-muted" />
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="h-20 rounded-lg bg-muted" />
        ))}
      </div>
      <div className="mt-4 h-72 rounded-lg bg-muted" />
    </div>
  )
}

export function DataStatisticsClient() {
  const { ready, t } = useTransClient('publishedContentSummary')
  const [dashboard, setDashboard] = useState<StatisticsDashboard | null>(null)
  const [dashboardError, setDashboardError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [growthMetric, setGrowthMetric] = useState<GrowthMetricKey>('viewGrowth')
  const [rankingMetric, setRankingMetric] = useState<GrowthMetricKey>('viewGrowth')
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [accountId, setAccountId] = useState('')
  const [accountOptions, setAccountOptions] = useState<Array<{ id: string; nickname: string; type: string }>>([])
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const pendingAutoSyncAccountId = usePlanDetailStore(state => state.pendingAutoSyncAccountId)
  // 数据概览默认展示账号全量真实数据（不限日期）：平台历史作品发布早于「近 7 天」，
  // 默认带日期会把全部真实数据过滤成 0。用户需要时再手动选日期筛选。
  const [startDate, setStartDate] = useState<string | null>(null)
  const [endDate, setEndDate] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  const platforms = useMemo(
    () => [...DomesticPlatInfoMap.entries()]
      .filter(([, info]) => Boolean(info))
      .map(([platform, info]) => ({
        platform: platform as string,
        name: info!.name,
      })),
    [],
  )

  const load = useCallback(async (params?: { startDate?: string; endDate?: string; platforms?: string[]; accountId?: string }) => {
    setLoading(true)
    setDashboardError(undefined)
    try {
      // 桌面端：后台触发一次本地采集→上报（节流 2 分钟），绝不阻塞概览加载——
      // 否则主进程采集卡住时「数据概览」将永远空白（read 优先，sync 并行）
      void triggerDesktopSyncIfNeeded()
      const data = await getPublishedContentDashboard({
        startDate: params?.startDate ?? startDate ?? undefined,
        endDate: params?.endDate ?? endDate ?? undefined,
        platforms: params?.platforms ?? selectedPlatforms,
        accountId: params?.accountId ?? accountId ?? undefined,
      })
      setDashboard(data)
      // 平台没给"播放/浏览"时（抖音创作者接口对部分作品返回 play_count=0），默认指标切到第一个
      // 有数据的：否则用户打开数据中心首屏看到的是全 0 的趋势和排行，误以为数据没采到。
      const availability = data.metricAvailability
      if (availability !== undefined) {
        const pick = (current: GrowthMetricKey): GrowthMetricKey => {
          if (availability[metricAvailabilityKey[current]] !== false)
            return current
          return growthMetrics.find(item => availability[metricAvailabilityKey[item.key]] === true)?.key ?? current
        }
        setGrowthMetric(pick)
        setRankingMetric(pick)
      }
    }
    catch {
      setDashboardError(t('states.loadFailed'))
    }
    finally {
      setLoading(false)
    }
  }, [accountId, endDate, selectedPlatforms, startDate, t])

  const syncSelectedAccount = useCallback(async (forcedAccountId?: string) => {
    const targetAccountId = forcedAccountId ?? accountId
    if (!targetAccountId)
      return
    setSyncing(true)
    setSyncMessage('')
    try {
      const base = (window as unknown as { __BACKEND_BASE_URL__?: string }).__BACKEND_BASE_URL__ || '/bosom-friend/api'
      const token = (window as unknown as { __ZHIYIN_AUTH_TOKEN__?: string }).__ZHIYIN_AUTH_TOKEN__ || ''
      const response = await fetch(`${base}/v2/channels/accounts/${encodeURIComponent(targetAccountId)}/sync`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      const json = await response.json() as { code?: number; data?: { ok?: boolean; count?: number }; message?: string }
      if (json.code === 0 && json.data?.ok) {
        setSyncMessage(`已同步 ${json.data.count ?? 0} 条作品`)
        await load({ accountId: targetAccountId })
      }
      else {
        setSyncMessage(json.message || '数据同步失败')
      }
    }
    catch {
      setSyncMessage('数据同步请求失败')
    }
    finally {
      setSyncing(false)
      if (forcedAccountId)
        usePlanDetailStore.getState().consumePendingAutoSync()
    }
  }, [accountId, load])

  // AI 智能体发布完成后：自动进入数据中心，选中对应账号并点击同步数据。
  const syncSelectedAccountRef = useRef(syncSelectedAccount)
  useEffect(() => {
    syncSelectedAccountRef.current = syncSelectedAccount
  }, [syncSelectedAccount])
  useEffect(() => {
    if (!pendingAutoSyncAccountId)
      return
    const accountIdToSync = pendingAutoSyncAccountId
    setAccountId(accountIdToSync)
    const timer = window.setTimeout(() => {
      void syncSelectedAccountRef.current(accountIdToSync)
    }, 400)
    return () => {
      window.clearTimeout(timer)
    }
  }, [pendingAutoSyncAccountId])

  useEffect(() => {
    if (ready)
      load()
  }, [ready, retryTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // 账号列表（矩阵号筛选用）：失败静默，下拉保持「全部账号」
  useEffect(() => {
    const probe = async () => {
      try {
        const base = (window as unknown as { __BACKEND_BASE_URL__?: string }).__BACKEND_BASE_URL__ || '/bosom-friend/api'
        const token = (window as unknown as { __ZHIYIN_AUTH_TOKEN__?: string }).__ZHIYIN_AUTH_TOKEN__ || ''
        const res = await fetch(base + '/v2/channels/accounts', { headers: { Authorization: 'Bearer ' + token } })
        const json = await res.json() as { code?: number; data?: { list?: Array<{ id: string; nickname?: string; type?: string }> } }
        if (json.code === 0 && json.data?.list) setAccountOptions(json.data.list.map(a => ({ id: a.id, nickname: a.nickname || a.type || a.id, type: a.type || '' })))
      } catch { /* 忽略 */ }
    }
    void probe()
  }, [])

  // 窗口聚焦时自动刷新数据概览，保持数据最新
  useEffect(() => {
    let firstFocus = true
    const refreshOnFocus = () => {
      if (firstFocus) {
        firstFocus = false
        return
      }
      if (document.visibilityState === 'visible' && ready) {
        load()
      }
    }
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [load, ready])

  if (!ready)
    return <DashboardSkeleton />

  const selectPlatform = (platform?: string) => {
    const next = platform ? [platform] : []
    setSelectedPlatforms(next)
    load({ platforms: next })
  }

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 pb-4 md:px-6 md:pb-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">账号筛选</span>
        <select
          aria-label="按账号筛选"
          value={accountId}
          onChange={(e) => {
            setAccountId(e.target.value)
            load({ accountId: e.target.value || undefined })
          }}
          className="h-8 rounded-md border px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-brand-cyan/40"
        >
          <option value="">全部账号</option>
          {accountOptions.map(a => (
            <option key={a.id} value={a.id}>{a.nickname}</option>
          ))}
        </select>
        {accountId !== '' && (
          <Button
            type="button"
            size="sm"
            className="h-8 cursor-pointer"
            disabled={syncing || loading}
            onClick={() => syncSelectedAccount()}
          >
            {syncing && <Loader2 className="animate-spin" />}
            {syncing ? '同步中…' : '同步数据'}
          </Button>
        )}
        {accountId !== '' && (
          <button
            type="button"
            className="text-xs text-brand-cyan hover:underline"
            onClick={() => {
              setAccountId('')
              load({ accountId: undefined })
            }}
          >
            清除
          </button>
        )}
        {syncMessage && (
          <span className="text-xs text-muted-foreground">{syncMessage}</span>
        )}
      </div>

      <FilterBar
        platforms={platforms}
        selectedPlatforms={selectedPlatforms}
        onPlatformsChange={(next) => {
          setSelectedPlatforms(next)
          load({ platforms: next })
        }}
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
        loading={loading}
        onQuery={() => load()}
        updateProgress={dashboard?.updateProgress ?? null}
        dataUpdatedAt={dashboard?.dataUpdatedAt}
      />
      {dashboardError && !dashboard && (
        <EmptyState
          title={dashboardError}
          action={(
            <Button
              data-testid="data-statistics-dashboard-retry"
              className="cursor-pointer"
              disabled={loading}
              onClick={() => setRetryTick(tick => tick + 1)}
            >
              {loading && <Loader2 className="animate-spin" />}
              {t('common:retry')}
            </Button>
          )}
        />
      )}
      {dashboard && (
        <>
          <div className="mt-4">
            <OverviewCards
          overall={dashboard.overall}
          availability={dashboard.metricAvailability}
          reasons={dashboard.metricAvailabilityReason}
        />
          </div>
          {dashboard.overall.workCount > 0
            ? (
                <div className="mt-4 flex flex-col gap-4">
                  <GrowthChartSection
                    dashboard={dashboard}
                    metric={growthMetric}
                    onMetricChange={setGrowthMetric}
                  />
                  <PlatformContributionSection
                    dashboard={dashboard}
                    selectedPlatform={selectedPlatforms[0]}
                    onSelectPlatform={selectPlatform}
                  />
                  <PlatformEfficiencySection dashboard={dashboard} />
                  <TopWorksSection
                    dashboard={dashboard}
                    metric={rankingMetric}
                    onMetricChange={setRankingMetric}
                  />
                </div>
              )
            : (
                <div className="flex min-h-[calc(100vh-260px)] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border/70 bg-card/40 px-6 py-12 text-center">
                  <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {dashboard.overall.publishedWorkCount > 0
                      ? <BarChart3 className="size-7" />
                      : <FileText className="size-7" />}
                  </span>
                  <div>
                    <p className="text-base font-semibold text-foreground">
                      {t(dashboard.overall.publishedWorkCount > 0 ? 'states.noCaptured' : 'states.noPublished')}
                    </p>
                    <p className="mx-auto mt-1.5 max-w-md text-sm leading-6 text-muted-foreground">
                      {t(dashboard.overall.publishedWorkCount > 0 ? 'states.noCapturedDesc' : 'states.noPublishedDesc')}
                    </p>
                  </div>
                  {dashboard.overall.publishedWorkCount === 0 && (
                    <Button asChild className="cursor-pointer">
                      <Link href="/zh-CN/draft-box">{t('states.noPublishedAction')}</Link>
                    </Button>
                  )}
                </div>
              )}
        </>
      )}
    </main>
  )
}
