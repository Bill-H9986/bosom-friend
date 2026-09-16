/**
 * ChannelManager - 频道管理器状态管理
 * 管理三页面视图状态、授权状态、侧边栏状态等
 */

import type {
  AuthState,
  AuthUrlResponse,
  ChannelManagerMethods,
  ChannelManagerState,
  ChannelManagerView,
} from './types'
import type { SocialAccount } from '@web/api/accounts/account.types'
import type { ChannelAccountAuthStatus } from '@web/api/channels/channel.types'
import type { PlatType } from '@web/app/config/platConfig'
import type { PluginPlatformType } from '@web/store/plugin'
import lodash from 'lodash'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { getChannelAccountAuthStatusApi, startChannelAccountAuthApi } from '@web/api/channels/channel.api'
import i18next from '@web/app/i18n/client'
import { useAccountStore } from '@web/store/account'
import { getPlatformInfoSync, isPlatformDisabledSync, isPlatformEnabledSync } from '@web/store/platformMetadata'
import {
  isPluginPlatformAccountReady,
  PLUGIN_SUPPORTED_PLATFORMS,
  PluginStatus,
  usePluginStore,
} from '@web/store/plugin'
import { confirmPlatformRegionRedirect } from '@web/utils/region/redirect'
import { toast } from '@web/utils/ui/toast'
import { isDesktopEnv, isDesktopLoginPlatform } from './utils/desktopLogin'
import { DEFAULT_AUTH_COUNTDOWN, POLLING_INTERVAL } from './types'

/**
 * 获取翻译文本
 */
function t(key: string, options?: Record<string, string>): string {
  return i18next.t(key, { ns: 'account', ...options })
}

function getPlatformName(platform: PlatType) {
  return getPlatformInfoSync(platform)?.name || platform
}

function notifyPlatformComingSoon(platform: PlatType) {
  toast.warning(t('channelManager.platformComingSoon', { platform: getPlatformName(platform) }))
}

/**
 * 检查平台是否为插件支持的平台
 */
function isPluginSupportedPlatform(platform: PlatType): platform is PluginPlatformType {
  return PLUGIN_SUPPORTED_PLATFORMS.includes(platform as PluginPlatformType)
}

/** 初始授权状态 */
const initialAuthState: AuthState = {
  platform: null,
  sessionId: null,
  authUrl: null,
  authMode: 'oauth',
  qrCodeDataUrl: null,
  qrCodePath: null,
  countdown: DEFAULT_AUTH_COUNTDOWN,
  isPolling: false,
  error: null,
  isTimeout: false,
}

/** 初始状态 */
const initialState: ChannelManagerState = {
  open: false,
  currentView: 'main',
  selectedPlatform: 'all',
  authState: { ...initialAuthState },
  targetSpaceId: null,
  onAuthSuccess: null,
  isNewUser: false,
}

function getInitialState(): ChannelManagerState {
  return lodash.cloneDeep(initialState)
}

/** 轮询定时器ID */
let pollingTimerId: ReturnType<typeof setTimeout> | null = null
/** 倒计时定时器ID */
let countdownIntervalId: ReturnType<typeof setInterval> | null = null

/**
 * 清理所有定时器
 */
function clearAllTimers() {
  if (pollingTimerId) {
    clearTimeout(pollingTimerId)
    pollingTimerId = null
  }
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId)
    countdownIntervalId = null
  }
}

/**
 * 根据平台类型获取授权URL
 */
async function getAuthUrl(platform: PlatType, spaceId?: string): Promise<AuthUrlResponse | null> {
  try {
    const res = await startChannelAccountAuthApi(platform, { groupId: spaceId })

    if (res?.code === 0 && res.data?.url && res.data.sessionId) {
      return {
        url: res.data.url,
        sessionId: res.data.sessionId,
        expiresAt: res.data.expiresAt,
      }
    }

    return null
  }
  catch (error) {
    console.error(`Failed to get auth URL for ${platform}:`, error)
    return null
  }
}

function getAuthCountdown(expiresAt?: string) {
  if (!expiresAt)
    return DEFAULT_AUTH_COUNTDOWN

  const expiresTime = new Date(expiresAt).getTime()
  if (Number.isNaN(expiresTime))
    return DEFAULT_AUTH_COUNTDOWN

  return Math.max(0, Math.ceil((expiresTime - Date.now()) / 1000))
}

interface AuthStatusResult {
  status: ChannelAccountAuthStatus['status']
  data?: ChannelAccountAuthStatus
  message?: string
}

async function checkAuthStatus(
  platform: PlatType,
  sessionId: string,
): Promise<AuthStatusResult | null> {
  try {
    const res = await getChannelAccountAuthStatusApi(platform, sessionId)

    if (res?.code === 0 && res.data) {
      return {
        status: res.data.status,
        data: res.data,
        message: res.data.status === 'failed' ? res.message : undefined,
      }
    }

    if (res?.message) {
      return { status: 'failed', message: res.message }
    }

    return null
  }
  catch (error) {
    console.error(`Failed to check auth status for ${platform}:`, error)
    return null
  }
}

function getAuthAccountIds(data?: ChannelAccountAuthStatus) {
  return [
    data?.accountId,
    ...(data?.accountIds ?? []),
    ...(data?.accounts?.map(account => account.accountId) ?? []),
  ].filter((accountId): accountId is string => Boolean(accountId))
}

function findAuthorizedAccount(
  accountList: SocialAccount[],
  platform: PlatType,
  data?: ChannelAccountAuthStatus,
) {
  const accountIds = getAuthAccountIds(data)

  if (accountIds.length > 0) {
    const accountIdSet = new Set(accountIds)
    const matchedAccount = accountList.find(account => accountIdSet.has(account.id))

    if (matchedAccount)
      return matchedAccount
  }

  return accountList.find(account => account.type === platform)
}

export const useChannelManagerStore = create(
  combine(getInitialState(), (set, get) => {
    const methods: ChannelManagerMethods = {
      /** 打开弹框（默认显示主页） */
      openModal() {
        const accountList = useAccountStore.getState().accountList
        const isNewUser = accountList.length === 0

        set({
          open: true,
          currentView: isNewUser ? 'connect-list' : 'main',
          isNewUser,
        })
      },

      /** 关闭弹框 */
      closeModal() {
        // 停止所有授权相关的定时器
        methods.stopAuth()
        set({
          open: false,
          currentView: 'main',
          selectedPlatform: 'all',
          authState: { ...initialAuthState },
          targetSpaceId: null,
        })
      },

      /** 直接打开并进入指定平台的授权流程 */
      openAndAuth(platform: PlatType, spaceId?: string) {
        if (isPlatformDisabledSync(platform)) {
          notifyPlatformComingSoon(platform)
          return
        }

        if (!isPlatformEnabledSync(platform)) {
          confirmPlatformRegionRedirect(getPlatformName(platform))
          return
        }

        // 如果没有指定空间，使用默认空间
        const accountGroupList = useAccountStore.getState().accountGroupList
        const defaultSpace = accountGroupList.find(g => g.isDefault)
        const targetSpaceId = spaceId || defaultSpace?.id || null

        set({
          open: true,
          currentView: 'auth-loading',
          targetSpaceId,
        })

        // 开始授权流程
        methods.startAuth(platform, targetSpaceId || undefined)
      },

      /** 直接打开并进入连接新频道列表页 */
      openConnectList(spaceId?: string) {
        // 如果没有指定空间，使用默认空间
        const accountGroupList = useAccountStore.getState().accountGroupList
        const defaultSpace = accountGroupList.find(g => g.isDefault)
        const targetSpaceId = spaceId || defaultSpace?.id || null

        set({
          open: true,
          currentView: 'connect-list',
          targetSpaceId,
          isNewUser: false,
        })
      },

      /** 设置授权成功回调 */
      setOnAuthSuccess(callback) {
        set({ onAuthSuccess: callback })
      },

      /** 切换视图 */
      setCurrentView(view: ChannelManagerView) {
        set({ currentView: view })
      },

      /** 设置侧边栏选中的平台 */
      setSelectedPlatform(platform) {
        set({ selectedPlatform: platform })
      },

      /** 设置目标空间ID */
      setTargetSpaceId(spaceId) {
        set({ targetSpaceId: spaceId })
      },

      /** 开始授权流程 */
      async startAuth(platform: PlatType, spaceId?: string) {
        if (isPlatformDisabledSync(platform)) {
          notifyPlatformComingSoon(platform)
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          return
        }

        if (!isPlatformEnabledSync(platform)) {
          confirmPlatformRegionRedirect(getPlatformName(platform))
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          return
        }

        const targetSpaceId = spaceId || get().targetSpaceId || undefined

        // 桌面端：官方插件式登录 —— 打开平台创作者页（内置官方自动化引擎），
        // 用户直接在网页上登录，主进程自动检测登录态并同步账号；无阻塞弹窗
        if (isDesktopEnv() && isDesktopLoginPlatform(platform)) {
          clearAllTimers()
          set({
            currentView: 'connect-list',
            authState: {
              ...initialAuthState,
              platform,
              authMode: 'desktop',
              isPolling: true,
            },
            targetSpaceId: targetSpaceId || null,
          })

          try {
            const account = await window.ipcRenderer.invoke('ICP_PLATFORM_LOGIN_OPEN', platform)
            if (account) {
              // 强制刷新账号列表，确保新账号立即可见
              await useAccountStore.getState().getAccountList(false, { force: true })
              methods.handleAuthSuccess({
                id: String(account.id),
                type: account.type,
                uid: account.uid || '',
                nickname: account.nickname || '',
                avatar: account.avatar || '',
                fansCount: account.fansCount ?? 0,
                workCount: account.workCount ?? 0,
                likeCount: account.likeCount ?? 0,
                status: 1,
                rank: 0,
                groupId: String(account.groupId ?? ''),
                loginCookie: account.loginCookie || '',
              })
              toast.success(t('channelManager.syncSuccess'))
            }
            else {
              // 用户取消（关闭登录窗口）或未完成登录：不打扰，仅重置状态
              if (get().authState.isPolling) {
                set({ authState: { ...initialAuthState } })
                toast.info(t('channelManager.loginIncompleteTip'))
              }
            }
          }
          catch {
            if (get().authState.isPolling) {
              set({ authState: { ...initialAuthState } })
              toast.error(t('channelManager.authFailedTip'))
            }
          }
          return
        }

        // 清理之前的定时器
        clearAllTimers()

        const platformInfo = getPlatformInfoSync(platform)
        const authMode: AuthState['authMode'] = platformInfo?.authType === 'qrcode'
          ? 'miniappQr'
          : 'oauth'

        // 设置授权状态
        set({
          currentView: 'auth-loading',
          authState: {
            ...initialAuthState,
            platform,
            authMode,
            isPolling: true,
          },
          targetSpaceId: targetSpaceId || null,
        })

        // 检查是否为插件支持的平台
        if (authMode !== 'miniappQr' && isPluginSupportedPlatform(platform)) {
          await methods.handlePluginPlatformAuth(platform, targetSpaceId)
          return
        }

        // OAuth授权流程
        // 先同步打开空白窗口，避免 Safari 拦截弹窗
        const authWindow = authMode === 'oauth' ? window.open('about:blank') : null
        try {
          // 获取授权URL
          const authData = await getAuthUrl(platform, targetSpaceId)

          if (!authData) {
            authWindow?.close()
            set({
              authState: {
                ...get().authState,
                error: t('channelManager.authFailedTip'),
                isPolling: false,
              },
            })
            return
          }

          // 更新状态并打开授权窗口/二维码
          set({
            authState: {
              ...get().authState,
              sessionId: authData.sessionId,
              authUrl: authData.url,
              countdown: getAuthCountdown(authData.expiresAt),
              qrCodeDataUrl: authMode === 'miniappQr' ? authData.url : null,
            },
          })

          // 设置授权窗口地址
          if (authMode === 'oauth') {
            if (authWindow) {
              authWindow.location.href = authData.url
            }
            else {
              window.open(authData.url)
            }
          }

          // 启动倒计时
          countdownIntervalId = setInterval(() => {
            const currentState = get()
            const newCountdown = currentState.authState.countdown - 1

            if (newCountdown <= 0) {
              // 超时
              methods.stopAuth()
              set({
                authState: {
                  ...currentState.authState,
                  isTimeout: true,
                  isPolling: false,
                  countdown: 0,
                },
              })
            }
            else {
              set({
                authState: {
                  ...currentState.authState,
                  countdown: newCountdown,
                },
              })
            }
          }, 1000)

          const pollAuthStatus = async () => {
            const authState = get().authState

            if (
              authState.sessionId !== authData.sessionId
              || authState.platform !== platform
              || !authState.isPolling
            ) {
              return
            }

            const result = await checkAuthStatus(platform, authData.sessionId)
            const latestAuthState = get().authState

            if (
              latestAuthState.sessionId !== authData.sessionId
              || latestAuthState.platform !== platform
              || !latestAuthState.isPolling
            ) {
              return
            }

            if (result?.status === 'completed') {
              // 授权成功
              clearAllTimers()

              // 刷新账户列表
              await useAccountStore.getState().getAccountList()
              const completedAuthState = get().authState

              if (
                completedAuthState.sessionId !== authData.sessionId
                || completedAuthState.platform !== platform
                || !completedAuthState.isPolling
              ) {
                return
              }

              // 获取新添加的账户
              const accountList = useAccountStore.getState().accountList
              const newAccount = findAuthorizedAccount(accountList, platform, result.data)

              if (newAccount) {
                methods.handleAuthSuccess(newAccount)
              }
              else {
                // 没找到新账户，但也算成功
                set({
                  currentView: 'main',
                  selectedPlatform: platform,
                  authState: { ...initialAuthState },
                  isNewUser: false,
                })
              }
            }
            else if (result?.status === 'failed' || result?.message) {
              clearAllTimers()
              set({
                authState: {
                  ...latestAuthState,
                  error: result.message || t('channelManager.authFailedTip'),
                  isPolling: false,
                },
              })
            }
            else {
              pollingTimerId = setTimeout(() => {
                void pollAuthStatus()
              }, POLLING_INTERVAL)
            }
          }

          // 启动轮询：每次请求完成后再安排下一轮，避免接口重叠请求
          pollingTimerId = setTimeout(() => {
            void pollAuthStatus()
          }, POLLING_INTERVAL)
        }
        catch (error) {
          authWindow?.close()
          console.error('Auth error:', error)
          set({
            authState: {
              ...get().authState,
              error: error instanceof Error ? error.message : t('channelManager.authFailedTip'),
              isPolling: false,
            },
          })
        }
      },

      /**
       * 处理插件平台的授权（小红书、抖音等）
       * 这些平台通过浏览器插件同步账号，而非OAuth
       */
      async handlePluginPlatformAuth(platform: PluginPlatformType, spaceId?: string) {
        const pluginStore = usePluginStore.getState()
        const platformName = getPlatformInfoSync(platform)?.name || platform

        // 检查插件是否就绪
        if (pluginStore.status !== PluginStatus.READY) {
          // 插件未就绪，重置状态并打开插件弹框
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          toast.warning(t('channelManager.pluginNotReady', { platform: platformName }))
          // 打开插件弹框引导用户安装/授权
          pluginStore.openPluginModal()
          return
        }

        // 检查是否有账号
        const account = pluginStore.platformAccounts[platform]
        if (!account || !isPluginPlatformAccountReady(account)) {
          // 平台未登录，重置状态并打开插件弹框
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          toast.warning(t('channelManager.platformNotLoggedIn', { platform: platformName }))
          // 打开插件弹框引导用户登录
          pluginStore.openPluginModal()
          return
        }

        // 同步账号到数据库
        try {
          const result = await pluginStore.syncAccountToDatabase(platform, spaceId)

          if (result) {
            // 同步成功
            toast.success(t('channelManager.syncSuccess'))

            // 刷新账户列表
            await useAccountStore.getState().getAccountList()

            // 处理授权成功
            methods.handleAuthSuccess(result)
          }
          else {
            set({
              currentView: 'connect-list',
              authState: { ...initialAuthState },
            })
            toast.error(t('channelManager.syncFailed'))
          }
        }
        catch (error) {
          console.error('Plugin auth error:', error)
          set({
            currentView: 'connect-list',
            authState: { ...initialAuthState },
          })
          toast.error(t('channelManager.syncFailed'))
        }
      },

      /** 停止授权（取消/超时） */
      stopAuth() {
        clearAllTimers()
        const { authState } = get()
        // 桌面端应用内登录：取消时必须通知主进程关闭登录窗口并结束等待，
        // 否则窗口残留、主进程登录 Promise 挂起，再次登录会互相干扰
        if (authState.authMode === 'desktop' && authState.platform && isDesktopEnv()) {
          window.ipcRenderer.invoke('ICP_ACCOUNT_LOGIN_CANCEL', authState.platform).catch(() => {})
        }
        set({
          authState: {
            ...get().authState,
            isPolling: false,
          },
        })
      },

      /** 重新打开授权页面 */
      reopenAuthWindow() {
        const { authState } = get()
        if (authState.authMode === 'miniappQr' && authState.platform) {
          methods.startAuth(authState.platform, get().targetSpaceId || undefined)
          return
        }
        if (authState.authUrl) {
          window.open(authState.authUrl)
        }
      },

      /** 更新小程序二维码图片（用于二维码自动续码） */
      updateQrCodeDataUrl(dataUrl: string | null) {
        set({
          authState: {
            ...get().authState,
            qrCodeDataUrl: dataUrl,
          },
        })
      },

      /** 授权成功处理 */
      handleAuthSuccess(account: SocialAccount) {
        const { authState, onAuthSuccess, selectedPlatform } = get()
        const platform = authState.platform

        // 调用外部回调
        if (onAuthSuccess && platform) {
          onAuthSuccess(account, platform)
        }

        // 移动端保持原筛选状态，PC 端切换到授权平台
        const isMobile
          = typeof window !== 'undefined'
            && window.matchMedia('(max-width: 767px)').matches

        // 数据互通：绑定成功即把浏览器登录账号同步注册到后端账号库
        // （桌面端扫码/浏览器登录只写本地，不落服务端会导致账号管理/发布框/统计读到不同数据）
        // Web 端账号已经由后端登录会话真实落库；只有桌面 Electron 端才需要把
        // 浏览器插件同步的账号补注册到服务端，避免重复创建无 Cookie 占位账号。
        if (authState.authMode === 'desktop' && platform && account) {
          import('@web/api/channels/channel.api').then(async ({ browserRegisterAccountApi }) => {
            try {
              await browserRegisterAccountApi(platform, account)
              await useAccountStore.getState().getAccountList(false, { force: true })
            }
            catch (e) {
              console.warn('[channel-manager] 后端账号注册失败（不阻塞本地绑定）:', e)
            }
          }).catch(() => {})
        }

        // 重置状态，跳转到主页
        set({
          currentView: 'main',
          selectedPlatform: isMobile
            ? selectedPlatform
            : (platform || 'all'),
          authState: { ...initialAuthState },
          isNewUser: false,
        })
        // 授权成功后以最新账号列表重新判定新用户态（列表可能刚被强制刷新）
        methods.checkIsNewUser()
      },

      /** 重置状态 */
      reset() {
        clearAllTimers()
        set(getInitialState())
      },

      /** 检查是否为新用户 */
      checkIsNewUser() {
        const accountList = useAccountStore.getState().accountList
        set({ isNewUser: accountList.length === 0 })
      },
    }

    return methods
  }),
)
