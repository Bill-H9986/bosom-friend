import type { ClientType } from '@web/app/[lng]/accounts/accounts.enums'
import type { PlatType } from '@web/app/config/platConfig'

// Source: types/account.type.ts

/**
 * SocialAccount 类型。
 */
/**
 * 「刷新粉丝数」触发结果：状态如实描述本次请求真正做了什么。
 */
export interface AccountStatsRefreshResult {
  /** completed=已真实采集完；started=已在后台采集；in_flight=上一轮还在跑；throttled=仍在刷新间隔内。 */
  refreshStatus: 'completed' | 'started' | 'in_flight' | 'throttled'
  /** 服务端给出的原因/说明。 */
  message: string
  /** throttled 时给出剩余冷却时长，供前端精确记录冷却，而不是一律按整小时。 */
  remainingMs?: number
  lastStatsTime?: string
  fansCount?: number
  workCount?: number
}

export interface SocialAccount {
  id: string
  type: PlatType
  loginCookie?: string
  access_token?: string
  refresh_token?: string
  loginTime?: string
  uid: string
  avatar: string
  nickname: string
  fansCount?: number
  followingCount?: number
  readCount?: number
  likeCount?: number
  collectCount?: number
  forwardCount?: number
  commentCount?: number
  /** 最近一次真实平台采集成功的时间；读接口不会改写它。 */
  lastStatsTime?: string
  /** 最近一次真实平台采集的尝试时间（成功或失败都记）。 */
  lastStatsAttemptTime?: string
  /** 最近一次真实平台采集失败的原因；采集成功后清除。 */
  lastStatsError?: string
  workCount?: number
  income?: number
  status: number
  /** 平台侧登录态判定：valid=最近一次平台交互成功，invalid=平台明确要求重新登录。 */
  loginState?: 'valid' | 'invalid' | string
  /** 平台返回的登录失效原因（如"抖音登录已失效，请重新扫码登录"）。 */
  loginNote?: string
  /** 最近一次登录态判定的时间。 */
  loginCheckedAt?: string
  createTime?: string
  updateTime?: string
  createdAt?: string
  updatedAt?: string
  rank: number
  groupId: string
  channelId?: string
  clientType?: ClientType
}

/**
 * CreateChannelAccountParams 请求参数。
 */
export interface CreateChannelAccountParams {
  type: PlatType
  uid: string
  nickname: string
  loginCookie?: string
  avatar?: string
  groupId?: string
}

/**
 * AccountListData 数据结构。
 */
export interface AccountListData {
  total: number
  list: SocialAccount[]
}

/**
 * AccountGroupItem 数据结构。
 */
export interface AccountGroupItem {
  id: string
  name: string
  rank?: number
  isDefault: boolean
  proxyIp?: string
  ip?: string
  location?: string
  countryCode?: string
  hasBrowserConfig?: boolean
  createdAt?: string
  updatedAt?: string
}

// Source: accounts/account.api.ts inline types
// Source: accountSort.ts
/**
 * SortRankItem 数据结构。
 */
export interface SortRankItem
{
  id: string
  rank: number
}

/**
 * SortRankRequest 请求参数。
 */
export interface SortRankRequest {
  list: SortRankItem[]
}
