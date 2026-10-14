/**
 * ChannelManager - 频道管理器类型定义
 * 包含三页面视图状态、授权状态、侧边栏状态等类型
 */

import type { SocialAccount } from '@web/api/accounts/account.types'
import type { PlatType } from '@web/app/config/platConfig'
import type { PluginPlatformType } from '@web/store/plugin'

/** 频道管理器视图类型 */
export type ChannelManagerView = 'main' | 'connect-list' | 'auth-loading'

/** 授权状态 */
export interface AuthState {
  /** 正在授权的平台 */
  platform: PlatType | null
  /** 授权 Session ID */
  sessionId: string | null
  /** 授权URL */
  authUrl: string | null
  /** Authorization mode */
  authMode?: 'oauth' | 'miniappQr' | 'desktop'
  /** Mini app QR code image for authorization */
  qrCodeDataUrl?: string | null
  /** Mini app QR code embedded page path */
  qrCodePath?: string | null
  /** 倒计时秒数（默认300秒 = 5分钟） */
  countdown: number
  /** 是否正在轮询 */
  isPolling: boolean
  /** 授权错误信息 */
  error: string | null
  /** 是否授权超时 */
  isTimeout: boolean
}

/** 频道管理器状态 */
export interface ChannelManagerState {
  /** 弹窗是否打开 */
  open: boolean
  /** 当前页面视图 */
  currentView: ChannelManagerView
  /** 侧边栏选中的频道类型，'all' 表示全部频道 */
  selectedPlatform: PlatType | 'all'
  /** 授权相关状态 */
  authState: AuthState
  /** 目标空间ID（授权成功后账号添加到哪个空间） */
  targetSpaceId: string | null
  /** 授权成功回调（外部设置） */
  onAuthSuccess: ((account: SocialAccount, platform: PlatType) => void) | null
  /** 是否为新用户（没有任何账号） */
  isNewUser: boolean
}

/** 频道管理器方法 */
export interface ChannelManagerMethods {
  /** 打开弹框（默认显示主页） */
  openModal: () => void
  /** 关闭弹框 */
  closeModal: () => void
  /** 直接打开并进入指定平台的授权流程 */
  openAndAuth: (platform: PlatType, spaceId?: string) => void
  /** 直接打开并进入连接新频道列表页 */
  openConnectList: (spaceId?: string) => void
  /** 设置授权成功回调 */
  setOnAuthSuccess: (
    callback: ((account: SocialAccount, platform: PlatType) => void) | null,
  ) => void
  /** 切换视图 */
  setCurrentView: (view: ChannelManagerView) => void
  /** 设置侧边栏选中的平台 */
  setSelectedPlatform: (platform: PlatType | 'all') => void
  /** 设置目标空间ID */
  setTargetSpaceId: (spaceId: string | null) => void
  /** 开始授权流程 */
  startAuth: (platform: PlatType, spaceId?: string, options?: StartAuthOptions) => Promise<void>
  /**
   * 打开服务端扫码会话并在界面里出示二维码。
   *
   * 与 `openAndAuth` 的差别只有一处来源：桌面端 `openAndAuth` 走本地登录窗口（IPC，
   * 界面里没有码可看），而 AI 发起的登录走的是服务端会话，二维码只在服务端。这个入口
   * 跳过本地窗口分支，把服务端会话的二维码直接显示出来——用户不必再自己去找「添加频道」。
   */
  showLoginQr: (platform: PlatType, spaceId?: string) => void
  /** 处理插件平台的授权（小红书、抖音等） */
  handlePluginPlatformAuth: (platform: PluginPlatformType, spaceId?: string) => Promise<void>
  /** 停止授权（取消/超时） */
  stopAuth: () => void
  /** 重新打开授权页面 */
  reopenAuthWindow: () => void
  /** 更新小程序二维码图片（用于二维码自动续码） */
  updateQrCodeDataUrl: (dataUrl: string | null) => void
  /** 授权成功处理 */
  handleAuthSuccess: (account: SocialAccount) => void
  /** 重置状态 */
  reset: () => void
  /** 检查是否为新用户 */
  checkIsNewUser: () => void
}

/** `startAuth` 的可选行为开关。 */
export interface StartAuthOptions {
  /**
   * true 时跳过桌面端本地登录窗口（IPC）分支，直接走服务端扫码会话。
   *
   * 用在「AI 已经用内核工具发起了登录」这条路径上：那次登录只存在于服务端，
   * 本地窗口分支既不认识它，也出示不了它的二维码。
   */
  forceServerQr?: boolean
}

/** 授权URL响应 */
export interface AuthUrlResponse {
  url: string
  sessionId: string
  expiresAt?: string
}

/** 默认授权倒计时时间（秒） */
export const DEFAULT_AUTH_COUNTDOWN = 600

/** 轮询间隔（毫秒） */
export const POLLING_INTERVAL = 2000
