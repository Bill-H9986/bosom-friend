import i18next from 'i18next'
import lodash from 'lodash'
import { getUserInfoApi, logoutApi } from '@web/api/auth/auth.api'
import { createPersistStore } from '@web/utils/storage/createPersistStore'
import { useAccountStore } from '../account'
import { LOGIN_ENABLED } from '@web/config/auth'

export interface UserInfo {
  createdAt: string
  id: string
  name: string
  password: string
  phone?: string
  mail: string
  salt: string
  status: number
  updateTime: string
  _id: string
  avatar?: string
  score?: number
  income?: number
  popularizeCode?: string
  placeId?: string
}

export interface IUserStore {
  token?: string
  userInfo?: Partial<UserInfo>
  isAddAccountPorxy: boolean
  lang: string
  creditsBalance: number
  creditsLoading: boolean
  creditsInitialized: boolean
  seedanceCreditsBalance: number
  seedanceCreditsAvailableBalance: number
  seedanceCreditsLoading: boolean
  seedanceCreditsInitialized: boolean
  sidebarCollapsed: boolean
  defaultPlanId?: string
  hasEverLoggedIn: boolean
}

/** 开发模式模拟登录账号（仅本地开发使用，生产环境不生效） */
/** 用户主动退出标记：开发模式自动登录需尊重该标记，避免退出后又被自动登录顶回 */
const USER_LOGGED_OUT_KEY = 'zhiyin-user-logged-out'

const DEV_MOCK_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNzkzZGE4MWYwYmZhYjhhZDVkMDY0OCIsIm1haWwiOiJhZG1pbkBhaXRvZWFybi5sb2NhbCIsIm5hbWUiOiJBZG1pbiIsImlhdCI6MTc4NjMzMDUzNiwiZXhwIjo0OTQyMDkwNTM2fQ.QUQqQ7xI935ZWF6GE6RBaNJoKUVz1S1gW1WPZCLbc1s'
const DEV_MOCK_USER: UserInfo = {
  _id: 'dev-user-001',
  id: 'dev-user-001',
  name: 'Bosom Friend客户端',
  mail: 'dev@zhiyin.local',
  phone: '13800000000',
  password: '',
  salt: '',
  status: 1,
  avatar: '',
  score: 1000,
  income: 0,
  createdAt: '2026-08-10T00:00:00.000Z',
  updateTime: '2026-08-10T00:00:00.000Z',
}

const state: IUserStore = {
  token: undefined,
  userInfo: {},
  isAddAccountPorxy: false,
  lang: i18next.language || 'zh-CN',
  creditsBalance: 0,
  creditsLoading: false,
  creditsInitialized: false,
  seedanceCreditsBalance: 0,
  seedanceCreditsAvailableBalance: 0,
  seedanceCreditsLoading: false,
  seedanceCreditsInitialized: false,
  sidebarCollapsed: false,
  defaultPlanId: undefined,
  hasEverLoggedIn: false,
}

function getState(): IUserStore {
  return lodash.cloneDeep(state)
}

export const useUserStore = createPersistStore(
  {
    ...getState(),
  },
  (set, _get) => {
    const methods = {
      setLang(lang: string) {
        set({ lang })
      },
      setIsAddAccountPorxy(isAddAccountPorxy: boolean) {
        set({ isAddAccountPorxy })
      },
      setToken(token: string) {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(USER_LOGGED_OUT_KEY)
        }
        set({
          token,
          hasEverLoggedIn: true,
          creditsInitialized: false,
          seedanceCreditsInitialized: false,
        })
      },
      setUserInfo(userInfo: UserInfo) {
        set({ userInfo })
      },
      appInit(autoLoginToken?: string) {
        // 用户主动退出后不再自动登录（开发模式模拟账号同样尊重该标记）
        const loggedOutByUser = typeof localStorage !== 'undefined'
          && localStorage.getItem(USER_LOGGED_OUT_KEY) === '1'

        // 免登录模式（LOGIN_ENABLED=false）与本地开发模式：没有 token 时自动使用本地访客账号，
        // 保证打包产物在「登录页暂时屏蔽」期间也能直接进入主页，不再空页/跳转死循环。
        if (!_get().token && (import.meta.env.DEV || !LOGIN_ENABLED) && !loggedOutByUser) {
          methods.setToken(autoLoginToken || DEV_MOCK_TOKEN)
          methods.setUserInfo(DEV_MOCK_USER)
        }
        // 打包版：主进程注入持久化登录 token 自动登录；
        // 用户主动退出后（loggedOutByUser 标记）不再自动登录，登录弹窗等待手动登录
        else if (!_get().token && autoLoginToken && !loggedOutByUser) {
          methods.setToken(autoLoginToken)
        }
        methods.getUserInfo()
        useAccountStore.getState().accountInit()
      },
      async getUserInfo() {
        const res = await getUserInfoApi()
        if (res?.code === 0 && res.data) {
          set({ userInfo: res.data })
          return res.data
        }
      },
      async fetchCreditsBalance() {
        set({ creditsInitialized: true })
      },
      setCreditsBalance(balance: number) {
        set({ creditsBalance: balance, creditsInitialized: true })
      },
      fetchSeedanceCreditsBalance() {
        const balance = _get().creditsBalance
        set({
          seedanceCreditsBalance: balance,
          seedanceCreditsAvailableBalance: balance,
          seedanceCreditsInitialized: true,
        })
      },
      setSeedanceCreditsBalance(balance: number) {
        set({
          seedanceCreditsBalance: balance,
          seedanceCreditsAvailableBalance: balance,
          seedanceCreditsInitialized: true,
        })
      },
      setSidebarCollapsed(collapsed: boolean) {
        set({ sidebarCollapsed: collapsed })
      },
      setDefaultPlanId(planId: string | undefined) {
        set({ defaultPlanId: planId })
      },
      logout() {
        const token = _get().token
        if (token) {
          void logoutApi().catch(() => {})
        }
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(USER_LOGGED_OUT_KEY, '1')
        }
        // 通知主进程清理平台会话（抖音自动化窗口持久分区等），防止会话残留
        if (typeof window !== 'undefined' && window.ipcRenderer) {
          window.ipcRenderer.invoke('ICP_USER_LOGOUT').catch(() => {})
        }
        set({
          token: undefined,
          userInfo: {},
          hasEverLoggedIn: true,
          creditsBalance: 0,
          creditsInitialized: false,
          seedanceCreditsBalance: 0,
          seedanceCreditsAvailableBalance: 0,
          seedanceCreditsInitialized: false,
          defaultPlanId: undefined,
        })
        useAccountStore.getState().clear()
      },
    }

    return methods
  },
  {
    name: 'User',
    partialize: (storeState) => {
      const {
        creditsInitialized,
        creditsLoading,
        seedanceCreditsInitialized,
        seedanceCreditsLoading,
        ...rest
      } = storeState
      return rest as typeof storeState
    },
  },
  'localStorage',
)
