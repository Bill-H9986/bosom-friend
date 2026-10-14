'use client'

import { Activity, BarChart3, CalendarDays, Loader2, Sparkles, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { NoSSR } from '@kwooshung/react-no-ssr'
import Image from '@web/next-shims/image'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import AccountsTopNav from '@web/app/[lng]/accounts/components/AccountsTopNav'
import { AccountStatus } from '@web/app/config/accountConfig'
import { DomesticPlatInfoMap, PlatType } from '@web/app/config/platConfig'
import ReceptionPage from '@/views/reception'
import { useTransClient } from '@web/app/i18n/client'
import { PageShell } from '@web/app/layout/PageShell'
import rightArrow from '@web/assets/images/jiantou.png'
import { useChannelManagerStore } from '@web/components/ChannelManager'
import { EmptyState } from '@web/components/common/EmptyState'
import { Button } from '@web/components/ui/button'
import type { SocialAccount } from '@web/api/accounts/account.types'
import { useAccountStore } from '@web/store/account'
import { accountActionTarget, accountFactKey, accountFactsIndex } from '@web/store/accountPatch'
import { cn } from '@web/utils/className'
import http from '@web/utils/request'
import { toast } from '@web/utils/ui/toast'
import { setAgentFocus } from '@web/utils/agentFocus'
import { OneSentenceEquivalents } from '../tasks-history/components/OneSentenceEquivalents'
import { getOssUrl } from '@web/utils/oss'
import { useCalendarTiming } from './components/CalendarTiming/useCalendarTiming'
import 'driver.js/dist/driver.css'

interface AccountPageCoreProps {
  searchParams?: {
    platform?: string
    spaceId?: string
    addChannel?: string // 添加频道引导参数
    updateChannel?: string // 更新频道授权参数
    action?: string // 动作类型：publish 等
    // AI生成的内容参数
    aiGenerated?: string
    accountId?: string
    taskId?: string
    title?: string
    description?: string
    tags?: string
    medias?: string
  }
}

export default function AccountPageCore({ searchParams }: AccountPageCoreProps) {
  const { accountInit, accountLoading, accountListInitialized } = useAccountStore(
    useShallow(state => ({
      accountInit: state.accountInit,
      accountLoading: state.accountLoading,
      accountListInitialized: state.accountListInitialized,
    })),
  )

  const { t } = useTransClient('account')

  // 当前选中的账号就是助手的焦点（ADR-004 S1）：在账号上问"这个号该怎么定位"，
  // 助手读到的就是这个号的平台与昵称，不需要用户复述。离开页面时清掉。
  const accountActive = useAccountStore(state => state.accountActive)
  useEffect(() => {
    if (!accountActive)
      return
    setAgentFocus({
      page: '账号管理',
      objectKind: '账号',
      objectId: String(accountActive.id ?? ''),
      title: String(accountActive.nickname ?? ''),
      excerpt: '平台：' + String(accountActive.type ?? '') + '；粉丝：' + String(accountActive.fansCount ?? 0),
    })
    return () => setAgentFocus(null)
  }, [accountActive])

  // 对象级 AI 动作（ADR-004 S2）：给这个账号定一次位，结果写回这个号。
  // 账号是"用户画像"的源头——定位不清，模型给出的选题与文案就全都在猜。
  // 事实的落点是唯一的事实库 `account-facts.json`，按 `(平台, uid)` 寻址：服务端账号行用它的行 id
  // 寻址，桌面端本机账号（住在本机 SQLite，服务端看不到行）用 `(平台, uid)`——两种寻址写进同一个家，
  // 页面按事实表优先、账号行回落显示，所以本机账号一样读得到定位（见缺陷台账 DEF-147）。
  const patchAccount = useAccountStore(state => state.patchAccount)
  const [positioningId, setPositioningId] = useState<string | null>(null)
  /**
   * 账号级 AI 事实（定位 / 风险），按 (平台, uid) 对账（DEF-147）。
   *
   * 为什么要单独取一份：**桌面端本机账号不在服务端账号列表里**（它住在本机 SQLite），
   * 事实写在账号行上它就永远看不到。事实库以 (平台, uid) 为地址，两边都能对上。
   */
  const [facts, setFacts] = useState<Map<string, { positioning?: string, risk?: string }>>(new Map())
  const loadFacts = useCallback(async () => {
    const envelope = await http.get<{ list: Array<{ platform: string, uid: string, positioning?: string, risk?: string }> }>('v2/channels/account-facts')
    if (envelope?.code !== 0) return
    setFacts(accountFactsIndex(envelope.data?.list ?? []))
  }, [])
  useEffect(() => { void loadFacts() }, [loadFacts])
  /** 这条账号的事实键：平台 + uid（服务端行与本机行都用它）。拼法只有一处，见 `accountFactKey`。 */
  const factKeyOf = (account: SocialAccount): string => accountFactKey(account.type, account.uid)
  const factOf = (account: SocialAccount): { positioning?: string, risk?: string } => facts.get(factKeyOf(account)) ?? {}
  const runPositioning = useCallback(async (account: SocialAccount) => {
    if (positioningId) return
    setPositioningId(account.id)
    try {
      // 请求层对业务失败不抛错：原样返回信封 {code,data,message}，必须自己判 code、自己取 data。
      const envelope = await http.post<{ value?: string }>('ai/object-action', {
        kind: 'account',
        // 本机账号在服务端没有行：用 (平台, uid) 寻址，事实照样落在唯一的那个家里。
        id: accountActionTarget(account),
        action: 'account-positioning',
      })
      if (envelope?.code !== 0) return
      const value = envelope.data?.value
      if (!value) {
        toast.error('AI 没有返回可用内容，请重试')
        return
      }
      // 时间戳由服务端写（stampField=aiPositioningAt）：前端自己盖一个就成了两处事实，迟早不一致。
      patchAccount(account.id, { aiPositioning: value })
      setFacts(prev => new Map(prev).set(factKeyOf(account), { ...prev.get(factKeyOf(account)), positioning: value }))
      toast.success('已写入这个账号的定位')
    }
    catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI 定位失败，请重试')
    }
    finally {
      setPositioningId(null)
    }
  }, [factKeyOf, patchAccount, positioningId])

  // 频道管理器相关方法
  const { openModal, openConnectList, openAndAuth } = useChannelManagerStore(
    useShallow(state => ({
      openModal: state.openModal,
      openConnectList: state.openConnectList,
      openAndAuth: state.openAndAuth,
    })),
  )

  // 微信浏览器提示弹窗开关
  const [showWechatBrowserTip, setShowWechatBrowserTip] = useState(false)
  const { accountGroupList, accountList } = useAccountStore(useShallow(state => ({ accountGroupList: state.accountGroupList, accountList: state.accountList })))
  const allAccounts = useMemo(() => {
    const grouped = accountGroupList.reduce<typeof accountList>((acc, g) => [...acc, ...g.children], [])
    return grouped.length > 0 ? grouped : accountList
  }, [accountGroupList, accountList])
  const navigate = useNavigate()
  const activeSection: 'accounts' = 'accounts'
  // 发布弹窗状态

  // 使用新建作品 hook

  useEffect(() => {
    accountInit()
  }, [])

  // 窗口聚焦时刷新账号状态：停留页面也能及时发现掉登录/失效
  useEffect(() => {
    let firstFocus = true
    const refreshOnFocus = () => {
      if (firstFocus) {
        firstFocus = false
        return
      }
      if (document.visibilityState === 'visible') {
        // 强制刷新：列表非空时也重新拉取，确保掉登录/失效状态能被及时发现
        accountInit({ force: true })
      }
    }
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [accountInit])

  // 处理URL参数
  useEffect(() => {
    // 处理更新频道授权（仅打开频道连接列表，授权由用户点击平台卡片触发）
    if (searchParams?.updateChannel) {
      const platform = searchParams.updateChannel as PlatType
      const validPlatforms = Object.values(PlatType)

      if (validPlatforms.includes(platform)) {
        // 仅打开频道管理器连接列表，授权需用户点击平台卡片触发
        openConnectList()

        // 清除URL参数
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href)
          url.searchParams.delete('updateChannel')
          window.history.replaceState({}, '', url.toString())
        }
      }
      return
    }

    // 添加频道直链：打开频道管理器并自动发起指定平台授权，减少普通用户操作步骤。
    if (searchParams?.addChannel && accountListInitialized) {
      const platform = searchParams.addChannel as PlatType
      const validPlatforms = Object.values(PlatType)
      if (validPlatforms.includes(platform)) {
        openAndAuth(platform, searchParams.spaceId)
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href)
          url.searchParams.delete('addChannel')
          url.searchParams.delete('spaceId')
          window.history.replaceState({}, '', url.toString())
        }
        return
      }
    }

    // Handle AI-generated content params

    // 注意：只有在不是 AI 发布场景时才处理 platform 参数打开添加账号弹窗
    if (
      (searchParams?.platform || searchParams?.spaceId)
      && searchParams?.action !== 'publish'
      && searchParams?.aiGenerated !== 'true'
    ) {
      // 验证平台类型是否有效
      const platform = searchParams.platform as PlatType
      const validPlatforms = Object.values(PlatType)
      const spaceId = searchParams.spaceId

      if (searchParams.platform && validPlatforms.includes(platform)) {
        // 有指定平台，仅打开连接频道列表，授权需用户点击平台卡片触发
        openConnectList(spaceId)
      }
      else if (spaceId) {
        // 只有spaceId，打开连接频道列表
        openConnectList(spaceId)
      }
    }
  }, [searchParams, allAccounts.length, accountListInitialized, openAndAuth, openConnectList])

  /**
   * 检测是否为微信浏览器
   */
  const isWechatBrowser = () => {
    if (typeof window === 'undefined')
      return false
    const ua = window.navigator.userAgent.toLowerCase()
    return ua.includes('micromessenger')
  }

  /**
   * 在移动端首次进入时，如果是微信浏览器，显示微信浏览器提示
   */
  useEffect(() => {
    if (typeof window === 'undefined')
      return
    const isMobile = window.innerWidth <= 768
    const hasShownWechatTip = sessionStorage.getItem('accountsWechatTipShown')

    if (isMobile && isWechatBrowser() && !hasShownWechatTip) {
      setShowWechatBrowserTip(true)
      sessionStorage.setItem('accountsWechatTipShown', '1')
    }
  }, [])

  /**
   * 关闭微信浏览器提示弹窗
   */
  const closeWechatBrowserTip = () => {
    setShowWechatBrowserTip(false)
  }

  const wechatBrowserTexts = (() => {
    return {
      title: t('browserTip.title'),
      desc: t('browserTip.description'),
      cta: t('browserTip.button'),
    }
  })()


  return (
    <NoSSR>
      <PageShell
        toolbar={(
          <AccountsTopNav onAddAccount={() => openModal()} />
        )}
      >
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <button type="button" className="panel flex items-center gap-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg" onClick={() => navigate('/monitor')}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Activity size={20} /></span>
            <span>
              <span className="block font-medium">全局监控</span>
              <span className="block text-xs text-muted-foreground">自动接待与运营状态总览</span>
            </span>
          </button>
          <button type="button" className="panel flex items-center gap-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg" onClick={() => navigate('/data-statistics')}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><BarChart3 size={20} /></span>
            <span>
              <span className="block font-medium">数据中心</span>
              <span className="block text-xs text-muted-foreground">作品数据与涨粉分析</span>
            </span>
          </button>
          <button type="button" className="panel flex items-center gap-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg" onClick={() => navigate('/calendar')}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><CalendarDays size={20} /></span>
            <span>
              <span className="block font-medium">发布日历</span>
              <span className="block text-xs text-muted-foreground">定时发布排期与节日提醒</span>
            </span>
          </button>
        </div>
        {activeSection === 'accounts' && (
        <>
        <OneSentenceEquivalents page="accounts" />
        {/* 账号管理：频道/账号列表 */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="section-title">我的账号</h2>
          </div>
          {allAccounts.length === 0 ? (
            <div className="panel border-dashed">
              <EmptyState
                icon={<Users size={24} />}
                title="暂无绑定账号"
                description="添加第一个平台开始自动化运营"
                action={<Button size="sm" className="cursor-pointer" onClick={() => openModal()}>添加频道</Button>}
              />
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {allAccounts.map((acc) => {
                const info = DomesticPlatInfoMap.get(acc.type)
                // 平台明确判定登录失效时优先提示重新扫码：账号"看着在线、发不出去"最坑用户。
                const reloginRequired = acc.loginState === 'invalid'
                const usable = acc.status === AccountStatus.USABLE && !reloginRequired
                return (
                  <div
                    key={acc.id}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3 transition-all duration-300 ease-apple-out hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-xl hover:shadow-primary/10"
                  >
                    <div className="relative shrink-0">
                      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-muted-foreground">
                        {acc.avatar ? (
                          <img
                            src={getOssUrl(acc.avatar)}
                            alt={acc.nickname}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          (info?.name || acc.type).slice(0, 1)
                        )}
                      </div>
                      {info?.icon && (
                        <img
                          src={info.icon}
                          alt={info.name}
                          className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border border-background bg-background object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {acc.nickname || info?.name || acc.type}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {info?.name || acc.type}
                        {typeof acc.fansCount === 'number'
                          ? ` · ${acc.fansCount.toLocaleString()} 粉丝`
                          : ''}
                      </p>
                      {(() => {
                        // 事实表优先、账号行回落：本机账号的定位只可能在事实表里（DEF-147）。
                        const positioning = factOf(acc).positioning ?? acc.aiPositioning
                        const risk = factOf(acc).risk ?? acc.aiRisk
                        return (
                          <>
                            {positioning && (
                              <p className="mt-1 line-clamp-2 text-xs text-foreground/70" title={positioning}>
                                定位：{positioning}
                              </p>
                            )}
                            {/* 风险评估的结论：与定位分开显示——一个是"该讲什么"，一个是"现在能不能干活" */}
                            {risk && (
                              <p
                                className="mt-1 line-clamp-2 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700"
                                title={risk}
                              >
                                风险：{risk}
                              </p>
                            )}
                          </>
                        )
                      })()}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs',
                          reloginRequired
                            ? 'bg-amber-500/10 text-amber-700'
                            : usable
                              ? 'bg-emerald-500/10 text-emerald-700'
                              : 'bg-red-500/10 text-red-600',
                        )}
                        title={reloginRequired ? (acc.loginNote ?? '') : undefined}
                      >
                        {reloginRequired ? '需重新登录' : usable ? '正常' : '失效'}
                      </span>
                      {!usable && (
                        <button
                          type="button"
                          onClick={() => openAndAuth(acc.type)}
                          className="btn btn-link text-xs"
                        >
                          重新授权
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={positioningId !== null}
                        title={'让 AI 依据平台与粉丝量给出这个号的定位'}
                        onClick={() => void runPositioning(acc)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-xs transition-colors',
                          positioningId !== null
                            ? 'cursor-not-allowed text-muted-foreground/60'
                            : 'cursor-pointer text-muted-foreground hover:border-primary/40 hover:text-foreground',
                        )}
                      >
                        {positioningId === acc.id
                          ? <><Loader2 className="size-3 animate-spin" />定位中…</>
                          : <><Sparkles className="size-3" />{acc.aiPositioning ? '重新定位' : 'AI 定位'}</>}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 自动接待：与账号管理一体（账号运营的自动回复能力） */}
        <section className="mt-6 border-t border-border/60 pt-5">
          <ReceptionPage />
        </section>
        </>
        )}

        {/* 微信浏览器提示（遮罩 + 箭头指向右上角） */}
        {showWechatBrowserTip && (
          <>
            <div
              className="fixed inset-0 bg-black/85 z-[1000] animate-[fadeIn_0.2s_ease-out]"
              onClick={closeWechatBrowserTip}
            />
            <Image
              src={rightArrow}
              alt="rightArrow"
              width={120}
              height={120}
              className="fixed top-[10%] right-5 z-[1002] pointer-events-none bg-accent animate-[arrowPulse_2s_ease-in-out_infinite] rounded-full p-2.5"
            />
            <div className="fixed inset-0 z-[1001] flex items-center justify-center pointer-events-none">
              <div className="bg-background/95 rounded-2xl p-6 mx-5 max-w-[320px] shadow-[0_10px_40px_rgba(0,0,0,0.3)] backdrop-blur-[10px] pointer-events-auto animate-[tipFadeIn_0.3s_ease-out]">
                <div className="text-lg font-bold text-foreground text-center mb-5">
                  {wechatBrowserTexts.title}
                </div>
                <div className="mb-5">
                  <div className="flex items-center gap-3 mb-3 text-sm text-foreground leading-normal">
                    <span className="bg-gradient-back text-gradient-foreground w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 shadow-sm shadow-primary/20">
                      1
                    </span>
                    <span className="flex-1">
                      {t('wechatBrowserTip.clickCorner')}
                      <span className="bg-muted text-muted-foreground px-2 py-0.5 rounded text-xs mx-1 inline-block">
                        ⋯
                      </span>
                      {t('wechatBrowserTip.dotsButton')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mb-3 text-sm text-foreground leading-normal">
                    <span className="bg-gradient-back text-gradient-foreground w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 shadow-sm shadow-primary/20">
                      2
                    </span>
                    <span className="flex-1">
                      {t('wechatBrowserTip.selectBrowser')}
                      <span className="bg-muted text-muted-foreground px-1.5 py-0.5 rounded text-xs mx-1 inline-block">
                        🌐
                      </span>
                      {t('wechatBrowserTip.openInBrowser')}
                    </span>
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-lg w-full rounded-lg font-semibold"
                  onClick={closeWechatBrowserTip}
                >
                  {wechatBrowserTexts.cta}
                </button>
              </div>
            </div>
          </>
        )}

      </PageShell>
    </NoSSR>
  )
}
