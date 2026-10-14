/*
 * 登录态保护：会话失效时暂停自动操作，避免用无效 Cookie 频繁打平台接口触发风控。
 */
import { douyinService } from '../../plat/douyin'

interface SessionCacheEntry {
  valid: boolean
  checkedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<number, SessionCacheEntry>()

/**
 * 检查抖音登录态（带 5 分钟缓存，避免频繁请求平台接口）
 */
export async function isDouyinSessionValid(
  accountId: number,
  loginCookie: string,
): Promise<boolean> {
  const cached = cache.get(accountId)
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.valid
  }

  let valid = false
  try {
    valid = await douyinService.checkLoginStatus(loginCookie)
  }
  catch {
    valid = false
  }

  cache.set(accountId, { valid, checkedAt: Date.now() })
  return valid
}

/** 手动失效缓存（例如重新授权成功后立即恢复轮询） */
export function invalidateSessionCache(accountId: number): void {
  cache.delete(accountId)
}

/** 绕过缓存实时校验登录态（自动重登轮询专用，避免 5 分钟缓存拖慢扫码检测） */
export async function checkDouyinSessionNow(
  accountId: number,
  loginCookie: string,
): Promise<boolean> {
  try {
    return await douyinService.checkLoginStatus(loginCookie)
  }
  catch {
    return false
  }
}
