import { useLocation, useNavigate, useParams as useRouterParams, useSearchParams as useRouterSearchParams } from 'react-router-dom'
import { useCallback } from 'react'

export interface AppRouterInstance {
  push: (href: string, options?: unknown) => void
  replace: (href: string, options?: unknown) => void
  reload: () => void
  refresh: () => void
  back: () => void
  forward: () => void
  prefetch: (href: string) => void
}

export function useRouter(): AppRouterInstance {
  const navigate = useNavigate()
  return {
    push: useCallback((href: string) => navigate(href), [navigate]),
    replace: useCallback((href: string) => navigate(href, { replace: true }), [navigate]),
    reload: useCallback(() => window.location.reload(), []),
    refresh: useCallback(() => window.location.reload(), []),
    back: useCallback(() => navigate(-1), [navigate]),
    forward: useCallback(() => navigate(1), [navigate]),
    prefetch: useCallback(() => { /* no-op */ }, []),
  } as AppRouterInstance
}

export function usePathname(): string {
  return useLocation().pathname
}

export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0]
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  return useRouterParams() as T
}

export function useSelectedLayoutSegment(): string | null {
  return null
}

export function useSelectedLayoutSegments(): string[] {
  // 桌面端：从 react-router 真实路径取段（去掉可能的语言前缀）
  const pathname = useLocation().pathname
  return pathname.split('/').filter(Boolean).filter(seg => !['zh-CN', 'en', 'ja'].includes(seg))
}

export function useParamsSimple<T = Record<string, string | undefined>>(): T {
  return useRouterParams() as T
}

export function redirect(url: string): never {
  window.location.href = url
  throw new Error(`Redirect to ${url}`)
}

export function notFound(): never {
  throw new Error('NOT_FOUND')
}
