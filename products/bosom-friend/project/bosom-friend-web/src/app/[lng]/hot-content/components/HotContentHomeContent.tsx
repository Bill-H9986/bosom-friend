'use client'

import { Flame, Newspaper } from 'lucide-react'
import Link from '@web/next-shims/link'
import { useCallback, useEffect, useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { EmptyState } from '@web/components/common/EmptyState'
import { resolveAsset } from '@web/utils/assetPath'
import { useGetClientLng } from '@web/hooks/useSystem'
import {
  listHotContentHomeSources,
  HotContentRequestStatus,
  useHotContentAuthReady,
} from '../api'
import type { HotContentRequestStatusValue, HotContentSource } from '../api'
import { HotContentGrid } from './HotContentCard'
import { HotContentPageSkeleton } from './HotContentSkeletons'
import { HotContentRouteError } from './HotContentRouteError'

function HotContentEmpty() {
  const { t } = useTransClient('hotContent')
  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-4 md:px-6 md:pb-5">
      <EmptyState
        icon={<Newspaper className="h-6 w-6" />}
        title={t('home.emptyTitle')}
        description={t('home.emptyDescription')}
      />
    </div>
  )
}

function HotContentPlatforms({ platforms }: { platforms: HotContentSource[] }) {
  const { t } = useTransClient('hotContent')
  const lng = useGetClientLng()

  return (
    <section
      className="border-b border-border py-5"
      aria-labelledby="hot-content-platforms-title"
    >
      <div className="flex items-center gap-2">
        <Flame className="size-4 text-primary" />
        <h1
          id="hot-content-platforms-title"
          className="text-base font-semibold text-foreground"
        >
          {t('home.platformsTitle')}
        </h1>
      </div>
      <nav
        aria-label={t('home.platformsTitle')}
        className="mt-4 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex min-w-max items-start gap-1">
          {platforms.map(({ iconUrl, name, sourceKey }) => (
            <Link
              key={sourceKey}
              data-testid={`hot-content-platform-${sourceKey}`}
              href={`/${lng}/hot-content/source/${sourceKey}`}
              className="group flex w-24 shrink-0 cursor-pointer flex-col items-center rounded-md px-2 py-1.5 text-center outline-none transition-colors duration-200 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="flex size-12 items-center justify-center overflow-hidden rounded-lg bg-muted/70 ring-1 ring-border/60 transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transform-none">
                {iconUrl
                  ? (
                      <img
                        src={resolveAsset(iconUrl)}
                        alt=""
                        width={48}
                        height={48}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    )
                  : (
                      <span className="text-base font-semibold text-muted-foreground">
                        {name.slice(0, 1)}
                      </span>
                    )}
              </span>
              <span className="mt-2 w-full truncate text-sm font-medium text-foreground">
                {name}
              </span>
            </Link>
          ))}
        </div>
      </nav>
    </section>
  )
}

function HotContentHomeLists({ sources }: { sources: HotContentSource[] }) {
  const { t } = useTransClient('hotContent')

  return (
    <section
      className="py-5"
      aria-labelledby="hot-content-home-lists-title"
    >
      <div className="mb-4 flex items-center gap-2">
        <Newspaper className="size-4 text-primary" />
        <h2
          id="hot-content-home-lists-title"
          className="text-base font-semibold text-foreground"
        >
          {t('home.title')}
        </h2>
      </div>
      <HotContentGrid sources={sources} />
    </section>
  )
}

export function HotContentHomeContent() {
  const { ready } = useTransClient('hotContent')
  const authReady = useHotContentAuthReady()
  const [sources, setSources] = useState<HotContentSource[]>([])
  const [status, setStatus] = useState<HotContentRequestStatusValue>(HotContentRequestStatus.Loading)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!authReady) {
      setStatus(HotContentRequestStatus.Loading)
      return
    }
    const controller = new AbortController()
    setStatus(HotContentRequestStatus.Loading)
    listHotContentHomeSources(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) {
          setSources(Array.isArray(list) ? list : [])
          setStatus(HotContentRequestStatus.Success)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSources([])
          setStatus(HotContentRequestStatus.Error)
        }
      })
    return () => controller.abort()
  }, [authReady, retryTick])

  const retry = useCallback(() => setRetryTick(tick => tick + 1), [])

  if (!ready || status === HotContentRequestStatus.Loading)
    return <HotContentPageSkeleton variant="home" />

  if (status === HotContentRequestStatus.Error)
    return <HotContentRouteError reset={retry} />

  if (sources.length === 0)
    return <HotContentEmpty />

  const platforms = sources.filter(
    (source, index, all) => all.findIndex(item => item.name === source.name) === index,
  )

  return (
    <div className="min-h-full bg-muted/40">
      <div className="mx-auto w-full max-w-[1600px] px-4 pb-4 md:px-6 md:pb-5">
        <HotContentPlatforms platforms={platforms} />
        <HotContentHomeLists sources={sources} />
      </div>
    </div>
  )
}
