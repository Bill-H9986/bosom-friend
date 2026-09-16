'use client'

import { Skeleton } from '@web/components/ui/skeleton'

export function HotContentCardSkeleton({ testId }: { testId?: string }) {
  return (
    <article
      data-testid={testId}
      className="flex h-[24rem] flex-col overflow-hidden rounded-lg bg-card shadow-sm sm:h-[26rem]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-4">
        <Skeleton className="size-7 shrink-0 rounded-md" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="ml-auto h-3.5 w-20" />
      </div>
      <div className="min-h-0 flex-1 divide-y divide-border/70 overflow-hidden px-4">
        {Array.from({ length: 9 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 py-3">
            <Skeleton className="size-5 shrink-0 rounded" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
      <div className="flex min-h-11 items-center justify-between border-t border-border/70 px-4">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>
    </article>
  )
}

export function HotContentDetailMainSkeleton() {
  return (
    <main className="min-w-0 overflow-hidden rounded-lg bg-card shadow-sm">
      <div className="relative flex min-h-28 flex-col gap-4 overflow-hidden border-b border-border/60 bg-card px-5 py-6 after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-gradient-back after:opacity-70 sm:flex-row sm:items-center sm:px-6 sm:after:inset-x-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Skeleton className="size-16 rounded-xl bg-primary/10" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      </div>
      <div className="divide-y divide-border px-4 sm:px-6">
        {Array.from({ length: 12 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 py-4">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </main>
  )
}

export function HotContentPageSkeleton({ variant = 'grid' }: { variant?: 'grid' | 'home' | 'detail' }) {
  if (variant === 'detail') {
    return (
      <div className="flex min-h-full flex-col bg-muted/40">
        <div className="mx-auto grid min-h-0 w-full max-w-[1600px] grow items-start gap-5 px-4 py-5 md:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="hidden lg:sticky lg:top-18 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:overflow-hidden lg:rounded-lg lg:border lg:border-border/70 lg:bg-card lg:shadow-sm">
            <div className="flex h-16 items-center gap-2.5 border-b border-border/60 px-3">
              <Skeleton className="size-8 rounded-lg bg-primary/10" />
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden p-2 pr-3">
              {Array.from({ length: 24 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full rounded-md" />
              ))}
            </div>
          </div>
          <HotContentDetailMainSkeleton />
        </div>
      </div>
    )
  }

  if (variant === 'home') {
    return (
      <div className="min-h-full bg-muted/40">
        <div className="mx-auto w-full max-w-[1600px] px-4 pb-4 md:px-6 md:pb-5">
          <section className="border-b border-border py-5">
            <Skeleton className="h-5 w-24" />
            <div className="mt-4 flex gap-2 overflow-hidden">
              {Array.from({ length: 12 }).map((_, index) => (
                <div key={index} className="flex w-24 shrink-0 flex-col items-center gap-2 py-1">
                  <Skeleton className="size-12 rounded-lg" />
                  <Skeleton className="h-3 w-14" />
                </div>
              ))}
            </div>
          </section>
          <section className="py-5">
            <Skeleton className="mb-4 h-5 w-28" />
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <HotContentCardSkeleton key={index} testId={`hot-content-page-skeleton-card-${index}`} />
              ))}
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-4 md:px-6 md:pb-5">
      <section className="py-5">
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <HotContentCardSkeleton key={index} testId={`hot-content-page-skeleton-card-${index}`} />
          ))}
        </div>
      </section>
    </div>
  )
}
