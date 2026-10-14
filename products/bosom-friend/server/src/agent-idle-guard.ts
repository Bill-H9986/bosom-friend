/**
 * 空转兜底（DEF-292）——**B 方案：结构化留痕 ＋ 下一轮带上提示**。
 *
 * 背景：免费档模型会「承诺而不执行」——回复写「我来查一下发布记录」，却一次工具都没调就结束
 * （qa/verify-one-sentence-e2e.mjs 实测：这一轮的 toolTrace 是空数组）。用户拿到一句"我去查"，
 * 却永远等不到结果。
 *
 * **B 方案的已知局限：它不是当场催。**
 * 本轮**不会**重跑模型——同轮再催要么多一次模型调用（免费档 RPM=1，既有成本又可能再空转），
 * 要么改对话主循环（api.ts 对话链路，风险高且今晚拿不到端到端证据）。所以空转仍会发生一次，
 * 只是不再无声：① 服务端日志留痕（log('idle-guard', …)）；② 下一轮的 continuation 上下文里带上
 * {@link IDLE_NEXT_TURN_HINT}，让下一轮真的动手。**不要把这条当成"空转已经当场解决"。**
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/agent-idle-guard
 */

/** 承诺了动作的措辞：命中即认为这一轮"答应了要干活"。 */
const PROMISE = /我来查|我来看看|我看一下|我先看|我去查|我确认一下|我先确认|让我先|稍等|马上|正在查/

/** 空转判定的结果。 */
export interface IdleVerdict {
  /** true = 这一轮是空转（零工具调用，且回复里承诺了动作）。 */
  idle: boolean
  /** 人话原因（写日志与下一轮上下文用）；不空转时为空串。 */
  reason: string
}

/**
 * 判定这一轮是否空转。
 *
 * @param toolCalls - 本轮模型实际发起的工具调用次数（内核侧实测）。
 * @param reply - 本轮助手正文。
 * @returns 是否空转与原因。
 */
export function idleVerdict(toolCalls: number, reply: string): IdleVerdict {
  const text = reply.trim()
  if (toolCalls > 0) return { idle: false, reason: '' }
  if (text === '') return { idle: false, reason: '' }
  if (!PROMISE.test(text)) return { idle: false, reason: '' }
  return { idle: true, reason: '本轮零工具调用，但回复承诺了动作：「' + text.slice(0, 40) + '」' }
}

/**
 * 空转时写一条结构化留痕（B 方案的第一处落痕）。
 *
 * @param toolCalls - 本轮工具调用次数。
 * @param reply - 本轮助手正文。
 * @param sink - 落痕出口（服务端 log）。
 * @returns true = 这一轮被判为空转并已留痕。
 */
export function noteIdleTurn(toolCalls: number, reply: string, sink: (kind: string, detail: string) => void): boolean {
  const verdict = idleVerdict(toolCalls, reply)
  if (!verdict.idle) return false
  sink('idle-guard', verdict.reason + '（B 方案：不重跑本轮、不是当场催；只留痕，并在下一轮上下文里提示必须真的调用工具）')
  return true
}

/** 下一轮 continuation 里追加的提示（B 方案的第二处落痕）。 */
export const IDLE_NEXT_TURN_HINT = '（上一轮你没有调用任何工具就结束了，却答应了去查/去看。这一轮必须真的调用工具；确实查不到就如实说明原因，不要再说"我去查"却不查。）'

/**
 * 从落库状态判断"上一轮是否空转"：可用轨迹为空 + 已经有过助手回复。
 *
 * @param toolTrace - 任务上累计的工具调用轨迹（可能不存在）。
 * @param hasAssistantReply - 任务里是否已经有助手回复（没有就是首轮，谈不上"上一轮空转"）。
 * @returns true = 上一轮空转，下一轮该带上提示。
 */
export function previousTurnWasIdle(toolTrace: unknown, hasAssistantReply: boolean): boolean {
  if (!hasAssistantReply) return false
  return Array.isArray(toolTrace) && toolTrace.length === 0
}

/** A 方案（DEF-292/258，产品负责人 2026-10-13 拍板）：空转时当场再催一次——同一条对话、有界（只催一次）。 */
export const IDLE_NUDGE = '你刚才说要去做这件事，但一次工具都没有调用就结束了。现在**真的调用工具**把它做完；确实做不到就如实说明原因，不要再承诺。'

/**
 * 空转就**当场催一次**（A 方案）。
 *
 * **有界**：本函数只调一次 retry（同一条对话只催一次），里面没有任何循环——第二次仍空转时给一句完整的如实回复。
 * 免费档 freeTierRpm=1，催多了会互相限流，禁止无限催。
 * **留痕**：催之前先 sink 一条，催完再 sink 结果（B 方案的账保留——日志里能看到"催过几次、催完什么样"）。
 *
 * @param opts.toolCalls - 本轮工具调用次数。
 * @param opts.reply - 本轮助手正文。
 * @param opts.sink - 留痕出口（服务端 log）。
 * @param opts.retry - 真正跑第二轮（复用同一内核会话）；返回新正文与**累计**工具调用次数，跑不起来返回 undefined。
 * @returns 没催或催不动时 undefined；否则返回 { text, gaveUp }——gaveUp=true 表示二次仍没调工具、
 *   已给出完整的如实回复，调用方应把它当**失败态**（status=error），让前端渲染三个可点的出口。
 */
export async function nudgeOnceIfIdle(opts: {
  toolCalls: number
  reply: string
  sink: (kind: string, detail: string) => void
  retry: () => Promise<{ text: string, toolCalls: number } | undefined>
}): Promise<{ text: string, gaveUp: boolean } | undefined> {
  const verdict = idleVerdict(opts.toolCalls, opts.reply)
  if (!verdict.idle) return undefined
  opts.sink('idle-guard', verdict.reason + '；当场催一次（A 方案，有界：同一条对话只催一次）')
  const second = await opts.retry()
  if (second === undefined) {
    opts.sink('idle-guard', '催的第二轮没跑起来（模型或内核会话不可用）——按失败如实汇报')
    return undefined
  }
  // 判"催完有没有动"只看**结构化信号**：这一轮到底有没有真调工具。
  // 不能拿第二轮的措辞去套第一轮那套承诺词表——实测「我这就去看一下」不在词表里，
  // 按文本判会把"一次工具都没调"判成"动了"（单元测试当场抓到）。
  if (second.toolCalls > 0) {
    opts.sink('idle-guard', '催完这一轮真的动了（累计工具调用 ' + String(second.toolCalls) + ' 次）')
    return { text: second.text, gaveUp: false }
  }
  opts.sink('idle-guard', '催过之后仍然一次工具都没调（第二次）——如实认输，不再催')
  // 二次仍空转：给一句**完整的**如实回复（绝不停在半截），并把三个出口写进正文。
  // 按钮形态的「断点继续 / 重新生成 / 放弃」由前端按 message.status==='error' 渲染；
  // 这里先用文字给全，保证用户无论如何都看得到"没办成 + 下一步能选什么"。
  return {
    text: '我没能完成这件事：催了一次之后，我还是一次工具都没有调用（只是又答应了一遍）。'
      + '\n\n请选择下一步：**断点继续**（我再跑一次）/ **重新生成**（把需求换个说法）/ **放弃**（先放下这件事）。',
    gaveUp: true,
  }
}
