'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@web/components/ui/pagination'
import {
  listHotContentCategorySources,
  HotContentRequestStatus,
  useHotContentAuthReady,
  useHotContentCategories,
} from '../api'
import type { HotContentRequestStatusValue, HotContentSource } from '../api'
import { HotContentGrid } from './HotContentCard'
import { HotContentPageSkeleton } from './HotContentSkeletons'
import { HotContentRouteError } from './HotContentRouteError'

const PAGE_SIZE = 12

export function HotContentCategoryContent({ cid }: { cid: string }) {
  const { ready, t } = useTransClient('hotContent')
  const authReady = useHotContentAuthReady()
  const { categories } = useHotContentCategories()
  const [sources, setSources] = useState<HotContentSource[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<HotContentRequestStatusValue>(HotContentRequestStatus.Loading)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!authReady) {
      setStatus(HotContentRequestStatus.Loading)
      return
    }
    const controller = new AbortController()
    setStatus(HotContentRequestStatus.Loading)
    listHotContentCategorySources(cid, page, PAGE_SIZE, controller.signal)
      .then((result) => {
        if (controller.signal.aborted)
          return
        setSources(result.list)
        setTotal(result.total)
        setStatus(HotContentRequestStatus.Success)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSources([])
          setTotal(0)
          setStatus(HotContentRequestStatus.Error)
        }
      })
    return () => controller.abort()
  }, [authReady, cid, page, retryTick])

  const retry = useCallback(() => setRetryTick(tick => tick + 1), [])
  const categoryName = useMemo(
    () => categories.find(category => category.cid === Number(cid))?.name ?? cid,
    [categories, cid],
  )
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (!ready || status === HotContentRequestStatus.Loading)
    return <HotContentPageSkeleton variant="grid" />

  if (status === HotContentRequestStatus.Error)
    return <HotContentRouteError reset={retry} />

  return (
    <div className="min-h-full bg-muted/40">
      <div className="mx-auto w-full max-w-[1600px] px-4 pb-4 md:px-6 md:pb-5">
        <div className="border-b border-border py-5">
          <h1 className="text-base font-semibold text-foreground">{categoryName}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('category.totalSources', { count: total })}
          </p>
        </div>
        <div className="py-5">
          {sources.length > 0
            ? <HotContentGrid sources={sources} />
            : (
                <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
                  {t('category.empty')}
                </div>
              )}
        </div>
        {totalPages > 1 && (
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    if (page > 1)
                      setPage(page - 1)
                  }}
                  isActive={page > 1}
                />
              </PaginationItem>
              {Array.from({ length: totalPages }).slice(0, 7).map((_, index) => {
                const targetPage = index + 1
                return (
                  <PaginationItem key={targetPage}>
                    <PaginationLink
                      href="#"
                      isActive={targetPage === page}
                      onClick={(event) => {
                        event.preventDefault()
                        setPage(targetPage)
                      }}
                    >
                      {targetPage}
                    </PaginationLink>
                  </PaginationItem>
                )
              })}
              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={(event) => {
                    event.preventDefault()
                    if (page < totalPages)
                      setPage(page + 1)
                  }}
                  isActive={page < totalPages}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}
      </div>
    </div>
  )
}
