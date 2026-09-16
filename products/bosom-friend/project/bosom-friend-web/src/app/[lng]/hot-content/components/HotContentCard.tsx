'use client'

import { ArrowRight, RotateCcw } from 'lucide-react'
import Link from '@web/next-shims/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { useGetClientLng } from '@web/hooks/useSystem'
import { cn } from '@web/utils/className'
import { resolveAsset } from '@web/utils/assetPath'
import { formatRelativeTime } from '@web/utils/format'
import {
  getHotContentFeed,
  HotContentFeedRequestStatus,
  HotContentFreshness,
} from '../api'
import type {
  HotContentFeed,
  HotContentFeedRequestStatusValue,
  HotContentSource,
} from '../api'
import { HotContentCardSkeleton } from './HotContentSkeletons'
import { HotContentRankedList } from './HotContentRankedList'

function createInitialStates(sources: HotContentSource[]) {
  return Object.fromEntries(
    sources.map(source => [
      source.sourceKey,
      { status: HotContentFeedRequestStatus.Queued },
    ]),
  )
}

interface FeedState {
  status: HotContentFeedRequestStatusValue
  data?: HotContentFeed
  error?: string
}

function HotContentCard({ source, state, onRetry }: {
  source: HotContentSource
  state?: FeedState
  onRetry: (sourceKey: string) => void
}) {
  const { ready, t } = useTransClient('hotContent')
  const lng = useGetClientLng()
  const [iconFailed, setIconFailed] = useState(false)
  const queued = state?.status === HotContentFeedRequestStatus.Queued
  const loading = state?.status === HotContentFeedRequestStatus.Loading
  const isWaiting = !state || queued || loading

  if (!ready || isWaiting) {
    return (
      <HotContentCardSkeleton testId={`hot-content-card-loading-${source.sourceKey}`} />
    )
  }

  const feed = state.data
  const unavailable = feed?.freshness === HotContentFreshness.Unavailable

  return (
    <article
      data-testid={`hot-content-card-${source.sourceKey}`}
      aria-label={source.name}
      className="group/card flex h-[24rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10 sm:h-[26rem]"
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-4">
        <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/70 ring-1 ring-border/60">
          {source.iconUrl && !iconFailed
            ? (
                <img
                  src={resolveAsset(source.iconUrl)}
                  alt=""
                  width={28}
                  height={28}
                  loading="lazy"
                  className="size-full object-contain"
                  onError={() => setIconFailed(true)}
                />
              )
            : (
                <span className="text-xs font-semibold text-muted-foreground">
                  {source.name.slice(0, 1)}
                </span>
              )}
        </div>
        <div className="min-w-0 flex-1">
          <Link
            data-testid={`hot-content-card-title-${source.sourceKey}`}
            href={`/${lng}/hot-content/source/${source.sourceKey}`}
            className="block cursor-pointer truncate rounded-sm text-sm font-semibold text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {source.name}
          </Link>
        </div>
        <span className="max-w-40 truncate text-right text-xs font-medium text-muted-foreground">
          {source.display}
        </span>
      </header>

      <div
        data-testid={`hot-content-card-scroll-${source.sourceKey}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 [scrollbar-color:transparent_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin] group-hover/card:[scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-button]:hidden [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent group-hover/card:[&::-webkit-scrollbar-thumb]:bg-border group-hover/card:[&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/40 [&::-webkit-scrollbar-track]:bg-transparent"
      >
        {state.status === HotContentFeedRequestStatus.Error || unavailable
          ? (
              <div className="flex min-h-full flex-col items-center justify-center px-4 text-center">
                <p className="text-sm font-medium text-foreground">
                  {t(unavailable ? 'feed.unavailableTitle' : 'feed.errorTitle')}
                </p>
                <p className="mt-1 max-w-64 text-xs leading-5 text-muted-foreground">
                  {t(unavailable ? 'feed.unavailableDescription' : 'feed.errorDescription')}
                </p>
                <Button
                  data-testid={`hot-content-card-retry-${source.sourceKey}`}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="relative z-10 mt-4 cursor-pointer"
                  onClick={() => onRetry(source.sourceKey)}
                >
                  <RotateCcw className="size-3.5" />
                  {t('common:retry')}
                </Button>
              </div>
            )
          : feed && feed.items.length > 0
            ? (
                <HotContentRankedList
                  sourceKey={source.sourceKey}
                  items={feed.items.slice(0, 10)}
                  compact
                />
              )
            : (
                <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
                  {t('feed.empty')}
                </div>
              )}
      </div>

      <footer className="flex min-h-11 items-center justify-between gap-3 border-t border-border/70 px-4 text-xs text-muted-foreground">
        <span className="truncate">
          {feed?.updatedAt
            ? t('feed.updatedAt', { time: formatRelativeTime(new Date(feed.updatedAt)) })
            : t('feed.waiting')}
        </span>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="relative z-10 h-7 shrink-0 px-2 text-xs"
        >
          <Link
            data-testid={`hot-content-card-more-${source.sourceKey}`}
            href={`/${lng}/hot-content/source/${source.sourceKey}`}
          >
            {t('actions.viewAll')}
            <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </footer>
    </article>
  )
}

function useHotContentGridState(sources: HotContentSource[]) {
  const [states, setStates] = useState<Record<string, FeedState>>(() => createInitialStates(sources))
  const generationRef = useRef(0)
  const inflightRef = useRef(0)
  const queueRef = useRef<string[]>([])
  const inflightAbortRef = useRef(new Map<string, AbortController>())
  const activeKeysRef = useRef(new Set(sources.map(source => source.sourceKey)))
  const pumpRef = useRef<() => void>(() => undefined)
  const sourceKeyJson = useMemo(
    () => JSON.stringify(sources.map(source => source.sourceKey)),
    [sources],
  )

  const pump = useCallback(() => {
    const generation = generationRef.current
    while (inflightRef.current < 4 && queueRef.current.length > 0) {
      const sourceKey = queueRef.current.shift()
      if (!sourceKey || inflightAbortRef.current.has(sourceKey))
        continue
      const controller = new AbortController()
      inflightAbortRef.current.set(sourceKey, controller)
      inflightRef.current += 1
      setStates(prev => ({
        ...prev,
        [sourceKey]: { status: HotContentFeedRequestStatus.Loading },
      }))
      getHotContentFeed(sourceKey, 10, controller.signal)
        .then((feed) => {
          if (generation !== generationRef.current || controller.signal.aborted)
            return
          setStates(prev => ({
            ...prev,
            [sourceKey]: {
              status: HotContentFeedRequestStatus.Success,
              data: feed,
            },
          }))
        })
        .catch((error) => {
          if (generation !== generationRef.current || controller.signal.aborted)
            return
          setStates(prev => ({
            ...prev,
            [sourceKey]: {
              status: HotContentFeedRequestStatus.Error,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
          }))
        })
        .finally(() => {
          if (generation === generationRef.current) {
            inflightRef.current -= 1
            inflightAbortRef.current.delete(sourceKey)
            pumpRef.current()
          }
        })
    }
  }, [])

  pumpRef.current = pump

  useEffect(() => {
    generationRef.current += 1
    inflightAbortRef.current.forEach(controller => controller.abort())
    inflightAbortRef.current.clear()
    inflightRef.current = 0
    const keys = [...new Set(sources.map(source => source.sourceKey))]
    activeKeysRef.current = new Set(keys)
    queueRef.current = keys
    setStates(createInitialStates(sources))
    pumpRef.current()

    return () => {
      generationRef.current += 1
      inflightAbortRef.current.forEach(controller => controller.abort())
      inflightAbortRef.current.clear()
      queueRef.current = []
      inflightRef.current = 0
    }
  }, [sourceKeyJson, sources, pump])

  const retry = useCallback((sourceKey: string) => {
    if (!activeKeysRef.current.has(sourceKey))
      return
    if (inflightAbortRef.current.has(sourceKey) || queueRef.current.includes(sourceKey))
      return
    queueRef.current.push(sourceKey)
    setStates(prev => ({
      ...prev,
      [sourceKey]: { status: HotContentFeedRequestStatus.Queued },
    }))
    pumpRef.current()
  }, [])

  /** 静默刷新：保留旧数据展示，后台拉取新数据后替换（不闪骨架屏） */
  const refreshSilently = useCallback(() => {
    const generation = generationRef.current
    for (const sourceKey of activeKeysRef.current) {
      if (inflightAbortRef.current.has(sourceKey) || queueRef.current.includes(sourceKey))
        continue
      const controller = new AbortController()
      inflightAbortRef.current.set(sourceKey, controller)
      inflightRef.current += 1
      getHotContentFeed(sourceKey, 10, controller.signal)
        .then((feed) => {
          if (generation !== generationRef.current || controller.signal.aborted)
            return
          setStates(prev => ({
            ...prev,
            [sourceKey]: {
              status: HotContentFeedRequestStatus.Success,
              data: feed,
            },
          }))
        })
        .catch(() => {
          // 静默刷新失败保留旧数据，下次再试
        })
        .finally(() => {
          if (generation === generationRef.current) {
            inflightRef.current -= 1
            inflightAbortRef.current.delete(sourceKey)
          }
        })
    }
  }, [])

  // 定时保鲜：60 秒静默刷新一次，热榜保持最新
  useEffect(() => {
    const timer = setInterval(() => refreshSilently(), 60_000)
    return () => clearInterval(timer)
  }, [refreshSilently])

  return { states, retry }
}

export function HotContentGrid({ sources }: { sources: HotContentSource[] }) {
  const { states, retry } = useHotContentGridState(sources)

  return (
    <div
      data-testid="hot-content-grid"
      className="grid grid-cols-1 gap-x-4 gap-y-6 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
    >
      {sources.map(source => (
        <HotContentCard
          key={source.sourceKey}
          source={source}
          state={states[source.sourceKey]}
          onRetry={retry}
        />
      ))}
    </div>
  )
}
