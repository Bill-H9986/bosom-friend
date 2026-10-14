/**
 * server-fetch - 服务端 fetch 封装
 * 用于 Server Component / generateMetadata / sitemap 等 SSR 场景
 * 无客户端依赖（不使用 useUserStore、directTrans）
 */

interface ServerFetchOptions {
  revalidate?: number | false
  tags?: string[]
}

interface ApiResponse<T> {
  code: number | string
  data: T
  message: string
}

import { WEB_API_BASE_URL } from '@web/config/api'
import { APP_SITE_URL } from '@web/config/app'

function getBaseUrl() {
  const apiUrl = WEB_API_BASE_URL
  if (apiUrl.startsWith('http')) {
    return apiUrl
  }
  const hostUrl = process.env.NEXT_PUBLIC_HOST_URL || APP_SITE_URL
  return `${hostUrl}${apiUrl}`
}

/**
 * 服务端 GET 请求
 * 利用 Next.js fetch + next.revalidate 实现 ISR 缓存
 */
export async function serverFetch<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  options: ServerFetchOptions = {},
): Promise<ApiResponse<T> | null> {
  try {
    const baseUrl = getBaseUrl()
    const url = new URL(`${baseUrl}/${path}`)

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value))
        }
      })
    }

    const fetchOptions: RequestInit & { next?: { revalidate?: number | false, tags?: string[] } } = {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      next: {},
    }

    if (options.revalidate !== undefined) {
      fetchOptions.next!.revalidate = options.revalidate
    }
    if (options.tags) {
      fetchOptions.next!.tags = options.tags
    }

    const res = await fetch(url.toString(), fetchOptions)
    if (!res.ok)
      return null

    const data: ApiResponse<T> = await res.json()
    return data
  }
  catch {
    return null
  }
}
