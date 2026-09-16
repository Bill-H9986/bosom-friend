'use client'

import { ChevronRight, Clock3, RotateCcw } from 'lucide-react'
import Link from '@web/next-shims/link'
import { useRouter } from '@web/next-shims/navigation'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { ScrollArea } from '@web/components/ui/scroll-area'
import { resolveAsset } from '@web/utils/assetPath'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select'
import { useGetClientLng } from '@web/hooks/useSystem'
import { cn } from '@web/utils/className'
import { formatTime } from '@web/utils/format'
import {
  getHotContentFeed,
  getHotContentSourceContext,
  HotContentFreshness,
  HotContentRequestStatus,
  useHotContentAuthReady,
} from '../api'
import type {
  HotContentFeed,
  HotContentRequestStatusValue,
  HotContentSource,
  HotContentSourceContext,
} from '../api'
import { HotContentRankedList } from './HotContentRankedList'
import {
  HotContentDetailMainSkeleton,
  HotContentPageSkeleton,
} from './HotContentSkeletons'
import { HotContentRouteError } from './HotContentRouteError'

function HotContentDetailHeader({ source, feed }: {
  source: HotContentSource
  feed: HotContentFeed
}) {
  const { ready, t } = useTransClient('hotContent')

  if (!ready)
    return <div className="h-20 animate-pulse rounded-lg bg-muted" />

  return (
    <header className="relative flex min-h-28 flex-col gap-4 overflow-hidden border-b border-border/60 bg-card px-5 py-6 after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-gradient-back after:opacity-70 sm:flex-row sm:items-center sm:px-6 sm:after:inset-x-6">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/5 shadow-sm ring-1 ring-primary/20">
          {source.iconUrl
            ? (
                <img
                  src={resolveAsset(source.iconUrl)}
                  alt=""
                  width={64}
                  height={64}
                  loading="lazy"
                  className="size-full object-contain"
                />
              )
            : (
                <span className="text-lg font-semibold text-primary">
                  {source.name.slice(0, 1)}
                </span>
              )}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-foreground">
            {source.name}
            <span aria-hidden>
              {' '}
              路
              {' '}
            </span>
            {source.display}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              {feed.updatedAt
                ? t('feed.updatedAt', {
                    time: formatTime(feed.updatedAt, 'YYYY-MM-DD HH:mm'),
                  })
                : t('feed.waiting')}
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}

function HotContentDetailSidebar({ activeSourceKey, siblings, source }: {
  activeSourceKey: string
  siblings: HotContentSource[]
  source: HotContentSource
}) {
  const router = useRouter()
  const { ready, t } = useTransClient('hotContent')
  const lng = useGetClientLng()
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLAnchorElement>(null)

  useLayoutEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]')
    if (!activeItemRef.current || !viewport)
      return
    const activeRect = activeItemRef.current.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    if (activeRect.top < viewportRect.top)
      viewport.scrollTop -= viewportRect.top - activeRect.top
    else if (activeRect.bottom > viewportRect.bottom)
      viewport.scrollTop += activeRect.bottom - viewportRect.bottom
  }, [activeSourceKey, ready])

  const navigate = useCallback(() => {
    document.getElementById('main-content')?.scrollTo({ top: 0 })
  }, [])

  if (!ready)
    return <aside className="h-24 animate-pulse rounded-lg bg-muted lg:h-96" />

  return (
    <aside aria-label={t('detail.sidebarLabel')} className="lg:self-stretch">
      <div className="rounded-lg border border-border/70 bg-card p-3 lg:hidden">
        <label
          className="mb-2 block text-xs font-medium text-muted-foreground"
          htmlFor="hot-content-source-select"
        >
          {t('detail.selectSource')}
        </label>
        <Select
          value={activeSourceKey}
          onValueChange={(value) => {
            navigate()
            router.push(`/${lng}/hot-content/source/${value}`, { scroll: false })
          }}
        >
          <SelectTrigger
            id="hot-content-source-select"
            data-testid="hot-content-detail-source-select"
            className="h-9 w-full shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {siblings.map(({ display, sourceKey }) => (
              <SelectItem
                key={sourceKey}
                data-testid={`hot-content-detail-source-option-${sourceKey}`}
                value={sourceKey}
              >
                {display}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="hidden lg:sticky lg:top-18 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:overflow-hidden lg:rounded-lg lg:border lg:border-border/70 lg:bg-card lg:shadow-sm">
        <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border/60 px-3">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/5 text-primary ring-1 ring-primary/15">
            {source.iconUrl
              ? (
                  <img
                    src={resolveAsset(source.iconUrl)}
                    alt=""
                    width={32}
                    height={32}
                    loading="lazy"
                    className="size-full object-contain"
                  />
                )
              : (
                  <span className="text-xs font-semibold">
                    {source.name.slice(0, 1)}
                  </span>
                )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {t('detail.sidebarLabel')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('category.totalSources', { count: siblings.length })}
            </p>
          </div>
        </div>
        <ScrollArea
          ref={scrollRef}
          className="min-h-0 flex-1 [&_[data-orientation=vertical]]:w-1.5"
        >
          <nav className="space-y-0.5 p-2 pr-3" aria-label={t('detail.siblingNavigation')}>
            {siblings.map(({ display, sourceKey }) => (
              <Link
                key={sourceKey}
                ref={sourceKey === activeSourceKey ? activeItemRef : undefined}
                data-testid={`hot-content-detail-source-link-${sourceKey}`}
                href={`/${lng}/hot-content/source/${sourceKey}`}
                scroll={false}
                onClick={navigate}
                aria-current={sourceKey === activeSourceKey ? 'page' : undefined}
                className={cn(
                  'group relative flex h-10 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-3 text-sm font-medium outline-none transition-colors duration-200 before:absolute before:inset-y-2.5 before:left-0 before:w-0.5 before:origin-center before:scale-y-0 before:rounded-full before:bg-gradient-back before:transition-transform before:duration-200 hover:bg-muted/60 hover:text-foreground active:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none motion-reduce:before:transition-none',
                  sourceKey === activeSourceKey
                    ? 'bg-primary/10 font-semibold text-foreground ring-1 ring-inset ring-primary/15 before:scale-y-100 hover:bg-primary/10'
                    : 'text-muted-foreground',
                )}
              >
                <span title={display} className="truncate">
                  {display}
                </span>
                <ChevronRight
                  className={cn(
                    'ml-auto size-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-[color,opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transform-none motion-reduce:transition-none',
                    sourceKey === activeSourceKey && 'translate-x-0 text-primary opacity-100',
                  )}
                  aria-hidden
                />
              </Link>
            ))}
          </nav>
        </ScrollArea>
      </div>
    </aside>
  )
}

export function HotContentDetailContent({ sourceKey }: { sourceKey: string }) {
  const { ready, t } = useTransClient('hotContent')
  const authReady = useHotContentAuthReady()
  const [context, setContext] = useState<HotContentSourceContext | null>(null)
  const [feed, setFeed] = useState<HotContentFeed | null>(null)
  const [status, setStatus] = useState<HotContentRequestStatusValue>(HotContentRequestStatus.Loading)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!authReady) {
      setStatus(HotContentRequestStatus.Loading)
      return
    }
    const controller = new AbortController()
    setStatus(HotContentRequestStatus.Loading)
    Promise.all([
      getHotContentSourceContext(sourceKey, controller.signal),
      getHotContentFeed(sourceKey, 50, controller.signal),
    ])
      .then(([ctx, feedData]) => {
        if (controller.signal.aborted)
          return
        setContext(ctx)
        setFeed(feedData)
        setStatus(HotContentRequestStatus.Success)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFeed(null)
          setStatus(HotContentRequestStatus.Error)
        }
      })
    return () => controller.abort()
  }, [authReady, retryTick, sourceKey])

  useLayoutEffect(() => {
    document.getElementById('main-content')?.scrollTo({ top: 0 })
  }, [sourceKey])

  const retry = useCallback(() => {
    setStatus(HotContentRequestStatus.Loading)
    setRetryTick(tick => tick + 1)
  }, [])

  const contextSource = context?.source
  const isSwitching = status === HotContentRequestStatus.Loading || contextSource?.sourceKey !== sourceKey

  if (!ready || (isSwitching && !context))
    return <HotContentPageSkeleton variant="detail" />

  if (status === HotContentRequestStatus.Error || !context || !contextSource || (!isSwitching && !feed))
    return <HotContentRouteError reset={retry} />

  const unavailable = feed?.freshness === HotContentFreshness.Unavailable

  return (
    <div className="flex min-h-full flex-col bg-muted/40">
      <div
        data-hot-content-detail-container
        className="mx-auto flex min-h-0 w-full max-w-[1600px] grow px-4 py-5 md:px-6"
      >
        <div className="grid min-h-0 w-full grow items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <HotContentDetailSidebar
            activeSourceKey={sourceKey}
            siblings={context.siblings}
            source={contextSource}
          />
          {isSwitching || !feed
            ? <HotContentDetailMainSkeleton />
            : (
                <main className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-all duration-300 ease-apple-out hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10">
                  {feed.isSample === true && (
                    <div className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                      当前为示例榜单；正式发布后会接入平台实时热点，数据将自动替换。
                    </div>
                  )}
                  <HotContentDetailHeader source={contextSource} feed={feed} />
                  {feed.items.length > 0 && !unavailable
                    ? (
                        <div className="px-4 sm:px-6">
                          <HotContentRankedList
                            sourceKey={contextSource.sourceKey}
                            items={feed.items.slice(0, 50)}
                          />
                        </div>
                      )
                    : (
                        <div className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
                          <p className="text-sm font-medium text-foreground">
                            {t(unavailable ? 'feed.unavailableTitle' : 'feed.empty')}
                          </p>
                          {unavailable && (
                            <Button
                              data-testid="hot-content-detail-retry"
                              type="button"
                              variant="outline"
                              size="sm"
                              className="mt-4 cursor-pointer"
                              onClick={retry}
                            >
                              <RotateCcw className="size-3.5" />
                              {t('common:retry')}
                            </Button>
                          )}
                        </div>
                      )}
                </main>
              )}
        </div>
      </div>
    </div>
  )
}
