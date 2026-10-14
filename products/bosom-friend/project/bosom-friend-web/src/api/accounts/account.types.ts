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
  /**
   * 服务端写的账号定位（谁写：账号页的「AI 定位」，字段名与 server 的 ZySocialAccount 一致）。
   * 桌面端本机账号库没有这一列，所以只有 accountSource 为 backend 的行才可能有值。
   */
  aiPositioning?: string
  /**
   * AI 风险评估的结论（谁写：账号卡片上的「AI 风险评估」）。
   * 与定位分开：定位是"该讲什么"，风险是"现在能不能干活"。
   */
  aiRisk?: string
  /** 最近一次写风险评估的时间。 */
  aiRiskAt?: string
  /** 最近一次写定位的时间。 */
  aiPositioningAt?: string
  /**
   * 这条账号行住在哪里：backend=服务端账号文件（HTTP 读到的），desktop-local=桌面端本机 SQLite。
   * 账号级 AI 事实只能落在行所在的那个家里，卡片据此决定「AI 定位」是否可用。
   */
  accountSource?: 'backend' | 'desktop-local'
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
