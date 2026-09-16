/**
 * 全自动接待执行器（仅前端智能体入口）。
 *
 * 读取后端只读登记的待办，生成缺失建议，然后通过页面自身发送请求调用真实平台互动任务；
 * 任务完成后再由前端回写待办状态。不会在后台直接发送。
 */
import {
  interactionApi,
  receptionApi,
  waitInteractionTask,
  type ReceptionPendingItem,
} from '@/api/reception'

let runnerActive = false

/** 无 AI 钥匙或未命中模板时的系统兜底话术（与后端 handle 默认一致，明确非 AI 生成）。 */
const DEFAULT_REPLY = '您好，收到您的消息～我们已记录，稍后为您处理。'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function replyTextOf(pending: ReceptionPendingItem, reply?: string): string {
  return (reply ?? pending.reply ?? pending.sentText ?? '').trim()
}

function unsupportedDmReason(pending: ReceptionPendingItem): string | null {
  if (pending.kind !== 'dm')
    return null
  const text = pending.commentText ?? ''
  const peer = pending.peerName ?? ''
  if (text.includes('请打开抖音app查看'))
    return '抖音要求打开APP查看该消息，无法自动回复'
  if (peer.includes('群') || peer.includes('粉丝群'))
    return '抖音群聊暂不支持自动回复'
  return null
}

/**
 * 执行一轮自动接待。
 * @returns 处理结果；无待办时不执行任何请求。
 */
export async function runReceptionAutoOnce(): Promise<{
  processedId?: string
  ok?: boolean
  error?: string
}> {
  if (runnerActive)
    return {}
  runnerActive = true
  try {
  const pending = await interactionApi.getPending()
  const target = (pending ?? []).find(item =>
    (item.status === 'pending' || item.status === undefined)
    && (item.matched === true || !!item.reply),
  )
  if (!target)
    return {}
  const unsupported = unsupportedDmReason(target)
  if (unsupported) {
    await interactionApi.markPending(target.id, 'skipped', unsupported).catch(() => undefined)
    return { processedId: target.id, ok: false, error: unsupported }
  }

  let reply = replyTextOf(target)
  if (!reply) {
    try {
      const suggested = await receptionApi.suggest({
        message: target.commentText ?? '',
        platform: target.platform,
        accountId: target.accountId,
      })
      reply = replyTextOf(target, suggested.reply)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await interactionApi.markPending(target.id, 'failed', `生成接待建议失败：${message}`).catch(() => undefined)
      return { processedId: target.id, ok: false, error: `生成接待建议失败：${message}` }
    }
  }
  if (!reply) {
    reply = DEFAULT_REPLY
  }

  try {
    await interactionApi.markPending(target.id, 'processing')
    const started = await interactionApi.reply({
      platform: target.platform,
      accountId: target.accountId,
      kind: target.kind,
      workId: target.workId ?? '',
      workTitle: target.workTitle ?? '',
      commentText: target.commentText ?? '',
      username: target.username ?? '',
      sessionId: target.sessionId ?? '',
      peerName: target.peerName ?? '',
      replyText: reply,
    })
    if (!started?.taskId)
      throw new Error('平台发送任务创建失败')
    const state = await waitInteractionTask(started.taskId)
    const data = state?.data as { ok?: boolean; message?: string } | undefined
    const ok = state?.status === 'done' && data?.ok === true
    await interactionApi.markPending(
      target.id,
      ok ? 'succeeded' : 'failed',
      ok ? undefined : (state?.error ?? data?.message ?? '平台未确认回复/发送'),
      ok ? reply : undefined,
    )
    return { processedId: target.id, ok, error: ok ? undefined : (state?.error ?? data?.message ?? '平台未确认回复/发送') }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await interactionApi.markPending(target.id, 'failed', message).catch(() => undefined)
    return { processedId: target.id, ok: false, error: message }
  }
  finally {
    // 相邻两条平台动作之间保留人类节奏，降低风控概率。
    await sleep(8000)
  }
  } finally {
    runnerActive = false
  }
}
