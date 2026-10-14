/**
 * useDraftGenerationPricing - AI 草稿生成定价数据 Hook
 * 复用 ai/draft-generation/pricing 接口，提供模块级缓存与防重复请求
 */

import type { DraftGenerationPricingVo } from '@web/api/ai/ai.types'
import { useEffect, useState } from 'react'
import { apiGetDraftGenerationPricing } from '@web/api/ai/ai.api'

interface DraftGenerationPricingCache {
  data: DraftGenerationPricingVo | null
  promise: Promise<DraftGenerationPricingVo | null> | null
}

const globalPricingCache = globalThis as typeof globalThis & {
  __draftGenerationPricingCache?: DraftGenerationPricingCache
}

function normalizePricingData(data: DraftGenerationPricingVo): DraftGenerationPricingVo {
  return {
    ...data,
    imageModels: (data.imageModels ?? []).map(model => ({
      ...model,
      pricing: model.pricing ?? [],
      tags: model.tags ?? [],
    })),
    videoModels: (data.videoModels ?? []).map(model => ({
      ...model,
      modes: model.modes ?? [],
      resolutions: model.resolutions ?? [],
      durations: model.durations ?? [],
      aspectRatios: model.aspectRatios ?? [],
      tags: model.tags ?? [],
      defaults: model.defaults ?? {},
      pricing: model.pricing ?? [],
    })),
  }
}

function getPricingCache() {
  if (!globalPricingCache.__draftGenerationPricingCache) {
    globalPricingCache.__draftGenerationPricingCache = {
      data: null,
      promise: null,
    }
  }

  return globalPricingCache.__draftGenerationPricingCache
}

async function fetchPricing(): Promise<DraftGenerationPricingVo | null> {
  const cache = getPricingCache()
  if (cache.data) {
    return cache.data
  }
  if (cache.promise) {
    return cache.promise
  }

  cache.promise = apiGetDraftGenerationPricing()
    .then((res) => {
      if (res?.data) {
        cache.data = normalizePricingData(res.data)
        return cache.data
      }
      return null
    })
    .catch(() => {
      return null
    })
    .finally(() => {
      cache.promise = null
    })

  return cache.promise
}

/** 缓存失效广播：配置变了要让**已经挂载**的内容创作页重新拉一次清单。 */
const PRICING_INVALIDATED_EVENT = 'bf:draft-generation-pricing-invalidated'

/**
 * 丢掉缓存，并通知所有正在用它的组件重新拉一次。
 *
 * 为什么必须两件事一起做：这份缓存是模块级单例、只请求一次，而内容创作页在设置弹窗后面
 * **一直挂着**（弹窗只是覆盖层）。只清缓存不广播，页面不会重新挂载、也就不会重新请求——
 * 用户按提示配好模型回来，看到的仍是"没配模型"的空清单，只能重启应用。
 */
export function clearDraftGenerationPricingCache(): void {
  const cache = getPricingCache()
  cache.data = null
  cache.promise = null
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(PRICING_INVALIDATED_EVENT))
}

export function useDraftGenerationPricing() {
  const [pricingData, setPricingData] = useState<DraftGenerationPricingVo | null>(() => getPricingCache().data)
  const [isLoading, setIsLoading] = useState(() => !getPricingCache().data)
  const [error, setError] = useState(false)

  useEffect(() => {
    const cache = getPricingCache()
    if (cache.data) {
      setPricingData(cache.data)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)

    fetchPricing().then((data) => {
      if (cancelled) {
        return
      }

      if (data) {
        setPricingData(data)
      }
      else {
        setError(true)
      }

      setIsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [])

  // 配置变更广播：重新拉一次清单（含"从没配到配好"这条路径）。
  useEffect(() => {
    const reload = (): void => {
      setIsLoading(true)
      setError(false)
      void fetchPricing().then((data) => {
        if (data) setPricingData(data)
        else setError(true)
        setIsLoading(false)
      })
    }
    window.addEventListener(PRICING_INVALIDATED_EVENT, reload)
    return () => window.removeEventListener(PRICING_INVALIDATED_EVENT, reload)
  }, [])

  return { pricingData, isLoading, error }
}
