import type { AppRouterInstance } from '@web/next-shims/navigation'
import type { IActionCard } from '@web/store/agent'
import { apiCreateMaterial, apiUpdateMaterial } from '@web/api/materials/material.api'
import { PubType } from '@web/app/config/publishConfig'
import { useAccountStore } from '@web/store/account'
import { toast } from '@web/utils/ui/toast'
import { usePlanDetailStore } from '@web/store/draft-box/planDetailStore'
import { isAutoPublishAuthorized } from '@web/components/Chat/ActionCard/publishAuthorization'
import { publishActionResult } from './ActionResultsContext'

/**
 * 从接口返回里尽力取真实 id：拿不到就返回空串，**绝不编一个**。
 *
 * @param res - 草稿接口的返回体（形状随封装层而定，所以逐层找）。
 * @returns 真实 id，或空串。
 */
function pickRealId(res: unknown): string {
  if (res === null || typeof res !== 'object') return ''
  const row = res as Record<string, unknown>
  const nested = row.data === null || typeof row.data !== 'object' ? undefined : row.data as Record<string, unknown>
  for (const source of [row, nested]) {
    if (source === undefined) continue
    for (const key of ['_id', 'id', 'draftId']) {
      const value = source[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return ''
}

/**
 * 回填动作结果：把任务里的「已申请」推进到「已执行 / 已核验」。
 *
 * 回填是**记账**不是业务：拿不到 taskId 或 requestId 时静默跳过，写不进去也不打扰用户
 * （业务本身已经成功，弹一个报错只会让人以为功能坏了）。
 *
 * @param taskId - 所属任务 id；缺省表示这条路径还没接上，跳过回填。
 * @param requestId - 服务端发放的动作工单号。
 * @param state - executed（执行完成，有真实 id）/ verified（平台回执可核验）。
 * @param realId - 执行后拿到的真实 id；拿不到传空串。
 * @param note - 一句话说明，便于任务里回看。
 */
function reportAction(
  taskId: string | undefined,
  requestId: string | undefined,
  state: 'executed' | 'verified',
  realId: string,
  note: string,
): void {
  if (taskId === undefined || taskId === '' || requestId === undefined || requestId === '') return
  // 动态导入而不是顶层 import：顶层 import 会形成
  // action.handlers → executePublishAction → ai.api → store/agent → action.handlers 的循环，
  // 整张动作卡会因此不渲染（2026-10-10 实测：发布卡在页面上直接消失）。
  void import('@web/api/ai/ai.api')
    .then(async (mod) => {
      const res = await mod.agentApi.reportActionResult(taskId, { requestId, state, realId, note })
      // 只广播服务端确认过的回填：接口没写进去却把卡片刷成「已执行」就是假成功。
      const envelope = res as { code?: number } | null | undefined
      if (envelope?.code === 0) {
        publishActionResult({ requestId, state, realId, note, at: new Date().toISOString() })
      }
    })
    .catch(() => {})
}

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

/**
 * 建草稿：把 AI 写好的标题/正文/话题写进草稿箱。
 *
 * 执行者是**前端**：内核与 AI 都不再直接写草稿文件（产品铁律 #2），
 * 这里调的是前端自己的草稿接口，落库后列表随即能看到。
 *
 * @param action - 建草稿动作（title / description / tags）。
 * @param taskId - 所属任务 id（可选）：给了就在成功后回填「已执行」与真实草稿 id。
 * @returns 是否已写入。
 */
export async function executeAgentSaveDraftAction(action: IActionCard, taskId?: string): Promise<boolean> {
  const title = (action.title ?? '').trim()
  const description = (action.description ?? '').trim()
  if (title === '' && description === '') return false
  const res = await apiCreateMaterial({
    groupId: 'mg-persist',
    title: title === '' ? '未命名草稿' : title,
    desc: description,
    topics: action.tags ?? [],
    mediaList: [],
    type: PubType.ImageText,
  }, true)
  const ok = res !== undefined && res !== null
  if (ok) reportAction(taskId, action.requestId, 'executed', pickRealId(res), '草稿已写入草稿箱')
  return ok
}

/**
 * 改写草稿：由前端把新标题/正文写回那条草稿。
 *
 * @param action - 改草稿动作（draftId / title / description）。
 * @param taskId - 所属任务 id（可选）：给了就在成功后回填「已执行」。
 * @returns 是否已写回。
 */
export async function executeAgentUpdateDraftAction(action: IActionCard, taskId?: string): Promise<boolean> {
  const id = (action.draftId ?? '').trim()
  if (id === '') return false
  const patch: { title?: string, desc?: string } = {}
  if ((action.title ?? '').trim() !== '') patch.title = (action.title ?? '').trim()
  if ((action.description ?? '').trim() !== '') patch.desc = (action.description ?? '').trim()
  if (patch.title === undefined && patch.desc === undefined) return false
  await apiUpdateMaterial(id, patch)
  reportAction(taskId, action.requestId, 'executed', id, '草稿已写回')
  return true
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

  // 执行授权走**共享闸门**（与 PluginPublishCard 同一个函数，两条路径无法各自漂移）。
  const autoPublish = isAutoPublishAuthorized(action)
  const hasVideo = action.medias?.some(media => media.type === 'VIDEO' || media.type === 'video')
  const material = {
    id: `ai-action-${Date.now()}`,
    groupId: 'mg-persist',
    platform,
    autoPublish,
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

  // 工单号（DEF-247）：这张卡在服务端有 requestId，发布请求必须把它带回服务端，
  // 否则发布成功后「已核验 + 真实作品号」没有依据回填到这张卡上。没有工单号时如实不传。
  const actionRequestId = (action.requestId ?? '').trim()
  usePlanDetailStore.getState().openPublishDialog(material as any, {
    autoPublish,
    ...(actionRequestId === '' ? {} : { actionRequestId }),
  })
  const targetAccount = useAccountStore.getState().accountList.find(account => account.type === platform)
  usePlanDetailStore.getState().setPendingAutoSync(autoPublish ? targetAccount?.id ?? null : null)
  sessionStorage.setItem('bosom-friend:ai-publish-draft', JSON.stringify({ ...material, actionRequestId }))
  router.push('/draft-box?aiPublish=1')
  return true
}
