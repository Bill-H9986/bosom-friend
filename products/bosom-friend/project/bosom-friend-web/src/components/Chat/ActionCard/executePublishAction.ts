import type { AppRouterInstance } from '@web/next-shims/navigation'
import type { IActionCard } from '@web/store/agent'
import { useAccountStore } from '@web/store/account'
import { useAgentFollowStore } from '@web/store/agentFollow'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'

/** 动作类型 → 前端 hash 路由（全功能导航，AC-018 全对话自动化）。 */
const NAVIGATE_ROUTES: Record<string, string> = {
  navigateToDraft: '/draft-box',
  navigateToDatacenter: '/data-statistics',
  navigateToMonitor: '/monitor',
  navigateToReception: '/ai-interaction',
  navigateToKnowledge: '/knowledge',
  navigateToCalendar: '/calendar',
  navigateToTasks: '/tasks-history',
}

/** 通用导航执行：把导航类动作跳转到对应功能页，返回是否已执行。 */
export function executeAgentNavigateAction(action: IActionCard, router: AppRouterInstance): boolean {
  const route = NAVIGATE_ROUTES[action.type]
  if (!route) return false
  router.push(route)
  return true
}

/**
 * AI 智能体发布动作的统一前端执行入口：构造草稿、打开发布弹窗、标记自动同步并跳转草稿箱。
 * 所有执行都停留在前端 store/路由边界内，不直接调用后端写接口。
 */
export function executeAgentPublishAction(action: IActionCard, router: AppRouterInstance): boolean {
  const platform = action.platform || ''
  const actionText = `${action.title ?? ''} ${action.description ?? ''}`
  if (/大模型调用失败|未接入任何大模型/.test(actionText))
    return false

  const followEnabled = useAgentFollowStore.getState().enabled
  const hasVideo = action.medias?.some(media => media.type === 'VIDEO' || media.type === 'video')
  const material = {
    id: `ai-action-${Date.now()}`,
    groupId: 'mg-persist',
    platform,
    autoPublish: followEnabled,
    title: action.title || '',
    desc: action.description || '',
    coverUrl: action.medias?.find(media => media.coverUrl)?.coverUrl
      || action.medias?.find(media => media.type === 'IMAGE' || media.type === 'image')?.url
      || '',
    topics: action.tags || [],
    mediaList: (action.medias || []).map((media, index) => ({
      id: `ai-media-${index}`,
      type: media.type === 'VIDEO' || media.type === 'video' ? 'video' as const : 'img' as const,
      url: media.url,
      metadata: {},
    })),
    type: hasVideo ? 'video' : 'image_text',
    status: 0 as const,
  }

  usePlanDetailStore.getState().openPublishDialog(material as any, { autoPublish: followEnabled })
  const targetAccount = useAccountStore.getState().accountList.find(account => account.type === platform)
  usePlanDetailStore.getState().setPendingAutoSync(followEnabled ? targetAccount?.id ?? null : null)
  sessionStorage.setItem('bosom-friend:ai-publish-draft', JSON.stringify(material))
  router.push('/draft-box?aiPublish=1')
  return true
}
