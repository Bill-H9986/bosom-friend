'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import http from '@web/utils/request'

export const HotContentFreshness = {
  Fresh: 'fresh',
  Stale: 'stale',
  Unavailable: 'unavailable',
} as const

export type HotContentFreshness = (typeof HotContentFreshness)[keyof typeof HotContentFreshness]

export const HotContentFeedRequestStatus = {
  Queued: 'queued',
  Loading: 'loading',
  Success: 'success',
  Error: 'error',
} as const

export type HotContentFeedRequestStatusValue = (typeof HotContentFeedRequestStatus)[keyof typeof HotContentFeedRequestStatus]

export const HotContentRequestStatus = {
  Loading: 'loading',
  Success: 'success',
  Error: 'error',
} as const

export type HotContentRequestStatusValue = (typeof HotContentRequestStatus)[keyof typeof HotContentRequestStatus]

export const HotContentSearchStatus = {
  Idle: 'idle',
  Loading: 'loading',
  Success: 'success',
  Empty: 'empty',
  Error: 'error',
} as const

export type HotContentSearchStatusValue = (typeof HotContentSearchStatus)[keyof typeof HotContentSearchStatus]

export interface HotContentCategory {
  cid: number
  name: string
}

export interface HotContentSource {
  sourceKey: string
  name: string
  display: string
  iconUrl?: string
  cid?: number
}

export interface HotContentSearchResult extends HotContentSource {
  display: string
}

export interface HotContentFeedItem {
  rank: number
  title: string
  description?: string
  heatText?: string
  targetUrl?: string
}

export interface HotContentFeed {
  items: HotContentFeedItem[]
  freshness: HotContentFreshness
  isSample?: boolean
  updatedAt?: string
}

export interface HotContentSourceContext {
  source: HotContentSource
  siblings: HotContentSource[]
}

interface PageResult<T> {
  list: T[]
  total: number
}

function unwrap<T>(res: { code?: string | number; data: T } | null): T {
  if (!res)
    throw new Error('Network error')
  return res.data
}

export async function listHotContentCategories(signal?: AbortSignal): Promise<HotContentCategory[]> {
  const res = await http.get<HotContentCategory[]>('v2/hot-content/categories', undefined, true, { signal })
  const data = unwrap(res)
  return Array.isArray(data) ? data : []
}

export async function listHotContentHomeSources(signal?: AbortSignal): Promise<HotContentSource[]> {
  const res = await http.get<HotContentSource[]>('v2/hot-content/home/sources', undefined, true, { signal })
  const data = unwrap(res)
  return Array.isArray(data) ? data : []
}

export async function listHotContentCategorySources(
  cid: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<PageResult<HotContentSource>> {
  const res = await http.get<PageResult<HotContentSource>>(
    `v2/hot-content/categories/${encodeURIComponent(cid)}/sources`,
    { page, pageSize },
    true,
    { signal },
  )
  return unwrap(res)
}

export async function searchHotContentSources(q: string, signal?: AbortSignal): Promise<PageResult<HotContentSearchResult>> {
  const res = await http.get<PageResult<HotContentSearchResult>>(
    'v2/hot-content/sources/search',
    { q, page: 1, pageSize: 30 },
    true,
    { signal },
  )
  return unwrap(res)
}

export async function getHotContentSourceContext(
  sourceKey: string,
  signal?: AbortSignal,
): Promise<HotContentSourceContext> {
  const res = await http.get<HotContentSourceContext>(
    `v2/hot-content/sources/${encodeURIComponent(sourceKey)}/context`,
    undefined,
    true,
    { signal },
  )
  return unwrap(res)
}

export async function getHotContentFeed(
  sourceKey: string,
  itemLimit: number,
  signal?: AbortSignal,
): Promise<HotContentFeed> {
  const res = await http.get<HotContentFeed>(
    `v2/hot-content/sources/${encodeURIComponent(sourceKey)}/feed`,
    { itemLimit },
    true,
    { signal },
  )
  return unwrap(res)
}

export function useHotContentAuthReady(): boolean {
  // 本地站：登录后即可使用（与官方行为一致）
  return true
}

export function useHotContentCategories() {
  const ready = useHotContentAuthReady()
  const [categories, setCategories] = useState<HotContentCategory[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [retryTick, setRetryTick] = useState(0)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!ready)
      return
    const seq = ++requestSeqRef.current
    setStatus('loading')
    listHotContentCategories()
      .then((list) => {
        if (seq !== requestSeqRef.current)
          return
        setCategories(list)
        setStatus('success')
      })
      .catch(() => {
        if (seq !== requestSeqRef.current)
          return
        setCategories([])
        setStatus('error')
      })
  }, [ready, retryTick])

  const retry = useCallback(() => {
    setRetryTick(tick => tick + 1)
  }, [])

  return {
    categories: ready ? categories : [],
    isLoading: !ready || status === 'idle' || status === 'loading',
    isError: ready && status === 'error',
    retry,
  }
}
