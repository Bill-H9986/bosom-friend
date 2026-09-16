import type { AccountGroupItem, SocialAccount } from '@web/api/accounts/account.types'
import type { PluginAccountStatusMap } from '@web/store/plugin/account.utils'
import lodash from 'lodash'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { getAccountGroupApi, getAccountListApi } from '@web/api/accounts/account.api'
import { directTrans } from '@web/app/i18n/client'
import { usePluginStore } from '@web/store/plugin/store'
import { mergePluginAccountStatus } from '@web/store/plugin/account.utils'
import { AccountStatus } from '@web/app/config/accountConfig'

export interface AccountGroup extends AccountGroupItem {
  children: SocialAccount[]
}

export interface IAccountStore {
  accountList: SocialAccount[]
  accountMap: Map<string, SocialAccount>
  accountGroupList: AccountGroup[]
  accountGroupMap: Map<string, AccountGroup>
  accountLoading: boolean
  accountListInitialized: boolean
  accountPluginAuthLoading: boolean
  accountPluginAuthInitialized: boolean
  // 当前选择的账户
  accountActive?: SocialAccount
  // 当前选择的空间ID
  activeSpaceId?: string
  // 余额不足弹框状态
  lowBalanceAlertOpen: boolean
}

const store: IAccountStore = {
  // 不分组的账户数据
  accountList: [],
  // 分组的账户数据
  accountGroupList: [],
  accountGroupMap: new Map([]),
  accountMap: new Map([]),
  accountLoading: false,
  accountListInitialized: false,
  accountPluginAuthLoading: false,
  accountPluginAuthInitialized: false,
  accountActive: undefined,
  activeSpaceId: undefined,
  lowBalanceAlertOpen: false,
}

let pluginAuthStatusPromise: Promise<void> | null = null

/** 加载在途时收到的刷新请求：当前轮结束后自动重拉一次，避免刷新被静默丢弃 */
let pendingAccountRefresh = false

function getStore() {
  return lodash.cloneDeep(store)
}

function normalizeAccountListData(data: SocialAccount[] | { list: SocialAccount[] } | undefined) {
  if (Array.isArray(data))
    return data
  return data?.list ?? []
}

/** 桌面端环境判断：存在 Electron IPC 桥接时优先读取本地数据库账号 */
function isDesktopEnv() {
  // 浏览器模式由后端注入 ipcRenderer 垫片（__zyShim=true），不算桌面端
  return typeof window !== 'undefined'
    && !!window.ipcRenderer
    && !(window.ipcRenderer as unknown as { __zyShim?: boolean }).__zyShim
}

/**
 * 从桌面端本地数据库读取账号列表（与自动接待、发布共用同一数据源）。
 * 返回 null 表示非桌面端或读取失败，调用方应回退到 HTTP 后端。
 */
async function fetchDesktopAccounts(): Promise<SocialAccount[] | null> {
  if (!isDesktopEnv())
    return null
  try {
    const list = await window.ipcRenderer.invoke('ICP_ACCOUNT_GET_LIST')
    if (!Array.isArray(list))
      return []
    // 本地库无账号时回退后端数据源：保证 OAuth 平台（领英/Facebook 等）账号在桌面端可见
    if (list.length === 0)
      return null
    return list.map((a: Record<string, any>) => ({
      id: String(a.id),
      type: a.type,
      loginCookie: a.loginCookie,
      uid: a.uid,
      avatar: a.avatar || '',
      nickname: a.nickname || '',
      fansCount: a.fansCount ?? 0,
      workCount: a.workCount ?? 0,
      likeCount: a.likeCount ?? 0,
      income: a.income ?? 0,
      // 桌面端本地库状态与 Web 约定相反（本地 0=正常/1=失效，Web 1=正常/0=失效），这里统一转成 Web 语义
      status: a.status == null
        ? AccountStatus.USABLE
        : (a.status === 1 ? AccountStatus.DISABLE : AccountStatus.USABLE),
      rank: a.rank ?? 0,
      groupId: String(a.groupId ?? ''),
      createTime: a.createTime,
      updateTime: a.updateTime,
    }))
  }
  catch {
    return null
  }
}

/**
 * 从桌面端本地数据库读取账号分组列表。返回 null 表示非桌面端或读取失败。
 */
async function fetchDesktopGroups(): Promise<AccountGroupItem[] | null> {
  if (!isDesktopEnv())
    return null
  try {
    const groups = await window.ipcRenderer.invoke('ICP_ACCOUNTS_GROUP_GET')
    if (!Array.isArray(groups))
      return []
    return groups.map((g: Record<string, any>) => ({
      id: String(g.id),
      name: g.name || '',
      rank: g.rank ?? 0,
      isDefault: !!g.isDefault,
      createTime: g.createTime,
      updatedAt: g.updateTime,
    }))
  }
  catch {
    return null
  }
}

/** 列表刷新后校正当前选中账号：引用指向最新列表对象；已不存在的选中项清除（防止幽灵选中） */
function reconcileAccountActive(accountList: SocialAccount[]) {
  const active = useAccountStore.getState().accountActive
  if (!active)
    return
  const freshActive = accountList.find(account => account.id === active.id)
  useAccountStore.setState({ accountActive: freshActive })
}

/** 后端 OAuth 渠道账号补全：本地库优先，按 type+uid 去重合并，避免后端账号在桌面端不可见 */
async function mergeBackendAccounts(local: SocialAccount[]): Promise<SocialAccount[]> {
  try {
    const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), 8000))
    const result = await Promise.race([getAccountListApi(), timeoutPromise])
    if (!result || result.code !== 0)
      return local
    const remote = normalizeAccountListData(result.data)
    const seen = new Set(local.map(a => `${a.type}_${a.uid}`))
    return [...local, ...remote.filter(a => !seen.has(`${a.type}_${a.uid}`))]
  }
  catch {
    return local
  }
}

function createAccountListState(accountList: SocialAccount[]) {
  const accountMap = new Map<string, SocialAccount>()
  accountList.forEach((account) => {
    accountMap.set(account.id, account)
  })

  return {
    accountList,
    accountMap,
  }
}

function mergeAccountStateWithPluginStatus(pluginAccountStatus: PluginAccountStatusMap) {
  const accountList = useAccountStore.getState().accountList
  if (accountList.length === 0)
    return

  const mergedAccountState = mergePluginAccountStatus(accountList, pluginAccountStatus)
  const hasChange = mergedAccountState.accountList.some((account, index) => account !== accountList[index])

  if (hasChange) {
    useAccountStore.setState(mergedAccountState)
  }
}

function mergeAccountStateWithCurrentPluginStatus() {
  mergeAccountStateWithPluginStatus(usePluginStore.getState().platformAccounts)
}

// 视频发布所有组件的共享状态和方法
export const useAccountStore = create(
  combine(
    {
      ...getStore(),
    },
    (set, get, storeApi) => {
      const methods = {
        setLowBalanceAlertOpen(lowBalanceAlertOpen: boolean) {
          set({
            lowBalanceAlertOpen,
          })
        },

        clear() {
          // 状态机残留复位：与 accountLoading 同生命周期（退出登录时清空补拉标记）
          pendingAccountRefresh = false
          set({
            ...getStore(),
          })
        },
        // 设置选择账户ID
        setAccountActive(accountActive?: SocialAccount) {
          set({
            accountActive,
          })
        },

        // 设置选择的空间ID
        setActiveSpaceId(activeSpaceId?: string) {
          set({
            activeSpaceId,
          })
        },

        setAccountGroupList(accountGroupList: AccountGroup[]) {
          set({ accountGroupList })
        },

        /**
         * 异步获取账户列表（含稳健的loading与错误处理），避免阻塞UI
         * @param isBackground 后台刷新
         * @param options.force 强制刷新（即使列表非空，用于登录/切换后同步最新数据）
         */
        async getAccountList(isBackground = false, options?: { force?: boolean }) {
          if (get().accountLoading) {
            pendingAccountRefresh = true
            return
          }
          set({ accountLoading: true })

          try {
            // 桌面端优先读取本地数据库账号（与自动接待/发布共用同一数据源）
            const desktopAccounts = await fetchDesktopAccounts()
            if (desktopAccounts) {
              // 本地优先 + 后端 OAuth 渠道账号补全（按 type+uid 去重）
              const merged = await mergeBackendAccounts(desktopAccounts)
              set(createAccountListState(merged))
              reconcileAccountActive(merged)
              methods.refreshPluginAuthStatusInBackground(isBackground)
              methods.getAccountGroup()
              return
            }

            // 防卡死：给请求增加超时兜底（例如 15s），即使后端迟迟不返回也不会一直占用loading
            const timeoutMs = 10000
            const timeoutPromise = new Promise<Awaited<ReturnType<typeof getAccountListApi>>>((resolve) => {
              setTimeout(() => resolve({ code: -1, data: { total: 0, list: [] }, message: '', url: '' }), timeoutMs)
            })
            const result = await Promise.race([getAccountListApi(), timeoutPromise])

            if (result?.code !== 0)
              return

            const accountList = normalizeAccountListData(result.data)
            set(createAccountListState(accountList))
            reconcileAccountActive(accountList)

            methods.refreshPluginAuthStatusInBackground(isBackground)

            // 后续分组数据获取不阻塞调用方
            methods.getAccountGroup()
          }
          finally {
            set({ accountLoading: false, accountListInitialized: true })
            // 加载在途期间有新刷新请求（登录/切换/聚焦），本轮结束后自动补拉一次，避免静默丢失
            if (pendingAccountRefresh) {
              pendingAccountRefresh = false
              void methods.getAccountList(isBackground)
            }
          }
        },

        /**
         * 后台异步启动账户列表加载（不等待，不阻塞首屏/刷新渲染）
         */
        async getAccountListInBackground(options?: { force?: boolean }) {
          await methods.getAccountList(true, options)
        },

        refreshPluginAuthStatusInBackground(isBackground = false) {
          // 桌面端无浏览器插件：插件状态快照不存在，跳过合并，
          // 账号在线状态完全由主进程本地会话判定（避免等待插件注入拖慢列表）
          if (isDesktopEnv())
            return

          // 纯浏览器模式也没有浏览器插件：不能把空的插件快照当成“离线”，
          // 否则会把后端 status=1 的正常账号覆盖成失效。
          if (typeof window === 'undefined'
            || !window.ZhiyinPlugin
            || typeof window.ZhiyinPlugin.checkPermission !== 'function') {
            set({ accountPluginAuthLoading: false, accountPluginAuthInitialized: true })
            return
          }

          if (get().accountPluginAuthInitialized) {
            mergeAccountStateWithCurrentPluginStatus()
            return
          }

          if (pluginAuthStatusPromise)
            return

          set({ accountPluginAuthLoading: true })

          pluginAuthStatusPromise = usePluginStore
            .getState()
            .getAccountStatusSnapshot(isBackground, { waitForPluginApi: true })
            .then(mergeAccountStateWithPluginStatus)
            .catch(() => {})
            .finally(() => {
              set({ accountPluginAuthLoading: false, accountPluginAuthInitialized: true })
              pluginAuthStatusPromise = null
            })
        },

        // 获取用户组的数据并且将用户放到对应组下
        async getAccountGroup() {
          // 桌面端优先读取本地数据库分组
          const desktopGroups = await fetchDesktopGroups()
          const res = desktopGroups ? { data: desktopGroups } : await getAccountGroupApi()
          const groupList = res?.data

          if (!groupList)
            return
          if (groupList.length === 0)
            return
          const normalizedGroupList = groupList.map(v => ({
            ...v,
            name: v.isDefault ? directTrans('account', 'defaultSpace') : v.name,
          }))

          const accountGroupList: AccountGroup[] = []
          // key=组ID，val=账户ID
          const accountGroupMap = new Map<string, AccountGroup>()

          const defaultGroup = normalizedGroupList.find(v => v.isDefault) ?? normalizedGroupList[0]

          normalizedGroupList.map((v) => {
            const accountGroupItem = {
              ...v,
              children: [],
            }
            accountGroupList.push(accountGroupItem)
            accountGroupMap.set(v.id, accountGroupItem)
          })
          get().accountList.map((v) => {
            if (accountGroupMap.get(v.groupId!)) {
              accountGroupMap.get(v.groupId!)!.children?.push(v)
            }
            else if (defaultGroup) {
              accountGroupMap.get(defaultGroup.id)!.children?.push(v)
              v.groupId = defaultGroup.id
            }
          })

          accountGroupList.sort((a, b) => {
            return (a.rank ?? 0) - (b.rank ?? 0)
          })

          set({
            accountGroupList,
            accountGroupMap,
          })
        },

        async accountInit(options?: { force?: boolean }) {
          if (get().accountList.length > 0 && !options?.force)
            return
          // 改为后台异步拉取，避免初始化时阻塞界面；force 用于登录成功/切换账号后强制同步最新列表
          methods.getAccountListInBackground(options)
        },
      }
      return methods
    },
  ),
)
