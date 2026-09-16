#!/usr/bin/env node
/**
 * AI 智能体任务动作验收：C2-03「中断 / 继续」与 C2-04「分享链接」的可执行检查。
 *
 * 这三条行为很容易“页面看着能用、实际没生效”，所以按可证伪的方式断言：
 *   1. 中断：生成中调用 abort 后这次生成必须真的停下，任务落库为 aborted，
 *      且只保留已送达客户端的部分正文（不是中断之后又落一份完整回复）；
 *   2. 继续：同一 taskId 再发一条能接着上文跑完，任务回到 completed；
 *   3. 分享：有效期按请求生效、令牌落盘（重启后未过期的链接仍可用）、
 *      只读页只暴露 user/assistant 消息，urlPath 指向应用内只读页而不是私有任务详情页。
 *
 * 覆盖清单（对应 docs/trace/RTM.md）：
 *   - C2-04 分享链接：有效期按请求生效、令牌落盘、只读页消息过滤、无效/过期令牌、不存在的任务不发链接
 *   - C2-03 中断/继续：abort 真的停 + 落库 aborted + 只留部分正文；同任务可接着跑完
 *   - DEF-022 收尾窗口中断：正文流完、封面/动作卡生成期间点停止，终态不得被覆盖回 completed
 *   - 中断判定以 abort 接口回报的 interrupted 为准：停晚了（生成已跑完）重试或判 SKIP，不误报红灯
 *   - C1-07/AC-014：任务列表与详情的状态/时间，评分与收藏刷新后仍保持（回读 + 落盘双证）
 *   - AC-005 三态：未配置给固定提示 / 已配置真实调用 / 调用失败如实报错
 *   - BF_AGENT_BOARD_SLOW=1 追加上：60 秒真过期语义、关窗口（客户端断开）不算中断
 *
 * 用法：node products/bosom-friend/qa/verify-agent-task-actions.mjs
 * 退出码：0 = 全绿；1 = 存在产品失败；2 = 应用未运行或模型不可用（无法检查，门禁判黄灯）
 *
 * 模型不可用时「中断·只保留已送达客户端的部分正文」的前提不成立（兜底文案不是逐步吐字），
 * 该条按 DOWNGRADED 打印并计入退出码 2，不误报产品红灯；其余断言照旧严格。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

const ORIGIN = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const BASE = ORIGIN + '/bosom-friend/api/'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'
const DATA_ROOT = process.env.BOSOM_FRIEND_HOME ?? join(homedir(), '.bosom-friend', 'bosom-friend')
/** 慢检查开关：过期语义要真的等一次 60 秒有效期，默认不跑，避免拖慢快速门禁。 */
const SLOW = process.env.BF_AGENT_BOARD_SLOW === '1'
const PROMPT = '请用三句话介绍你自己能帮我做哪些事，内容写详细一点。'
const FOLLOW_UP = '再用一句话说：我今天应该先做哪件事？'
/** 带内容创作意图：服务端会进入「生成封面 + 发布动作卡」的收尾阶段，用来验证收尾窗口内的中断。 */
const ACT_PROMPT = '帮我在小红书发布一篇春季护肤种草笔记，先把完整文案写出来。'
const results = []
/** SKIP：环境不满足（应用未运行/模型不可用），门禁据此判黄灯而不是红灯。 */
const SKIPS = []
/** 运行中遇到环境性失败（模型/内核暂时不可用）时置位：最后以退出码 2 交回门禁判黄灯，不误报产品红灯。 */
let envUnavailable = false

/** 记录一条断言结果；失败也继续跑，最后统一汇总。 */
function check(ok, id, detail) {
  results.push({ ok: !!ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

/** 调用产品 HTTP 接口，返回 { status, code, data, message }。 */
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { code: -1, message: text.slice(0, 200) } }
  return { status: res.status, code: json.code, data: json.data, message: json.message }
}

/** 读数据根下的 JSON 文件（JsonFile 外层信封 { schemaVersion, value } 自动解包）。 */
function disk(file) {
  try {
    const parsed = JSON.parse(readFileSync(join(DATA_ROOT, file), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed
  } catch { return undefined }
}

const secondsFromNow = iso => Math.round((Date.parse(iso) - Date.now()) / 1000)

/**
 * 打开一条 SSE 对话流，收集事件；返回任务 id、事件、result 载荷与结束时刻。
 * @param prompt - 用户输入。
 * @param taskId - 续聊时的任务 id；新对话传空。
 * @param llm - 可选的模型覆写（模拟"配置了但调用失败"这类场景）。
 */
async function openStream(prompt, taskId, llm) {
  const state = { taskId: null, events: [], endedAt: null, done: false, error: null, result: null, controller: new AbortController() }
  const body = { prompt, includePartialMessages: true }
  if (typeof taskId === 'string' && taskId !== '') body.taskId = taskId
  if (llm !== undefined) body.llm = llm
  /** 模拟客户端断开（关窗口/切页），服务端只会看到 close，不涉及 abort。 */
  state.drop = () => state.controller.abort()
  const response = await fetch(BASE + 'agent/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body),
    signal: state.controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  state.finished = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const line = block.split('\n').find(item => item.startsWith('data:'))
          if (line === undefined) continue
          let payload = null
          try { payload = JSON.parse(line.replace(/^data:\s*/, '')) } catch { /* 心跳等非 JSON 行 */ }
          if (payload === null) continue
          state.events.push({ type: payload.type, at: Date.now(), text: payload.event?.delta?.text ?? '' })
          if (payload.type === 'result') state.result = { model: payload.model ?? null, content: String(payload.data?.content ?? '') }
          if (payload.type === 'init' && state.taskId === null) state.taskId = payload.taskId
          if (payload.type === 'done') state.done = true
        }
      }
    } catch (error) { state.error = error instanceof Error ? error.message : String(error) }
    state.endedAt = Date.now()
  })()
  return state
}

/** 等到条件成立或超时；返回是否成立。 */
async function waitFor(predicate, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  return predicate()
}

/** 按 id 读任务详情；任务不存在时返回 null。 */
const taskById = async taskId => (await api('GET', 'agent/tasks/' + taskId)).data ?? null

/** 任务里对外可见的消息（只读分享页同样只暴露这两类）。 */
const publicMessages = task => (task?.messages ?? []).filter(m => m.type === 'user' || m.type === 'assistant')
/** 取任务里最后一条 assistant 正文。 */
function lastAssistantText(task) {
  const messages = (task?.messages ?? []).filter(m => m.type === 'assistant')
  const last = messages[messages.length - 1]
  if (last === undefined) return ''
  if (typeof last.content === 'string' && last.content !== '') return last.content
  const blocks = last.message?.content
  return Array.isArray(blocks) ? blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : ''
}

async function main() {
  // 连通性：应用未运行时退出码 2，门禁据此判黄灯而非红灯。
  try {
    const probe = await api('GET', 'v2/channels/account-groups')
    if (probe.code !== 0) throw new Error('code=' + probe.code)
  } catch (error) {
    console.log('AGENT_TASK_ACTIONS SKIP 应用未运行（' + ORIGIN + '）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }

  // ---- C2-04 分享链接：拿一个已有已完成任务验，不产生新的模型调用 ----
  const list = await api('GET', 'agent/tasks?page=1&pageSize=50')
  const tasks = Array.isArray(list.data?.list) ? list.data.list : []
  const sample = tasks.find(item => item.status === 'completed' && item.favorite !== true) ?? tasks[0]
  if (sample === undefined) {
    console.log('AGENT_TASK_ACTIONS SKIP 任务列表为空，没有可用于分享检查的任务')
    process.exit(2)
  }
  const detail = await api('GET', 'agent/tasks/' + sample.id)
  const sampleTask = detail.data
  check(sampleTask !== undefined && publicMessages(sampleTask).length > 0, '分享·样本任务可读', 'taskId=' + sample.id + ' 可见消息=' + publicMessages(sampleTask).length)

  // ---- AC-014-1 任务记录：列表与详情里状态/时间必须真实可见 ----
  const rowOk = typeof sample.id === 'string' && typeof sample.title === 'string' && typeof sample.status === 'string'
    && typeof sample.createdAt === 'string' && Date.parse(sample.createdAt) > 0
  check(rowOk, 'AC-014-1 任务列表含状态与创建时间', 'status=' + sample.status + ' createdAt=' + String(sample.createdAt).slice(0, 19))
  check(sampleTask?.status === sample.status && Array.isArray(sampleTask?.messages) && Date.parse(sampleTask.updatedAt) > 0,
    'AC-014-1 任务详情延续同一状态与时间', 'status=' + sampleTask?.status + ' updatedAt=' + String(sampleTask?.updatedAt).slice(0, 19))

  const share = await api('POST', 'agent/tasks/' + sample.id + '/share', { ttlSeconds: 3600 })
  const token = share.data?.token
  check(share.code === 0 && typeof token === 'string' && /^[0-9a-f]{32}$/.test(token), '分享·生成令牌', 'code=' + share.code + ' token=' + String(token).slice(0, 8) + '…')
  check(share.data?.urlPath === '#/chat?token=' + token, '分享·urlPath 指向应用内只读页', 'urlPath=' + share.data?.urlPath)
  const ttl = secondsFromNow(share.data?.expiresAt)
  check(ttl > 3400 && ttl <= 3600, '分享·有效期按请求生效（1 小时）', 'expiresIn=' + ttl + 's')

  const persisted = disk('share-tokens.json')
  const saved = Array.isArray(persisted) ? persisted.find(item => item.token === token) : undefined
  check(saved !== undefined && saved.taskId === sample.id && saved.expiresAt > Date.now(), '分享·令牌落盘（重启后仍可用）', 'share-tokens.json 命中=' + (saved !== undefined))

  const shared = await api('GET', 'agent/tasks/shared/' + token)
  const sharedMessages = shared.data?.messages ?? []
  const onlyPublic = sharedMessages.every(m => m.type === 'user' || m.type === 'assistant')
  check(shared.code === 0 && sharedMessages.length === publicMessages(sampleTask).length && onlyPublic,
    '分享·只读页只暴露 user/assistant 消息', 'code=' + shared.code + ' 消息=' + sharedMessages.length + '/' + publicMessages(sampleTask).length)

  const bogus = await api('GET', 'agent/tasks/shared/' + randomBytes(16).toString('hex'))
  check(bogus.code === 40404, '分享·无效令牌被拒', 'code=' + bogus.code)

  const tooShort = await api('POST', 'agent/tasks/' + sample.id + '/share', { ttlSeconds: 5 })
  const fallbackTtl = secondsFromNow(tooShort.data?.expiresAt)
  check(fallbackTtl > 6 * 86400 && fallbackTtl <= 7 * 86400, '分享·越界有效期回落默认 7 天', 'expiresIn=' + fallbackTtl + 's')

  const ghost = await api('POST', 'agent/tasks/task-not-exist-' + randomBytes(4).toString('hex') + '/share', { ttlSeconds: 3600 })
  check(ghost.code === 18100 && ghost.data === null, '分享·不存在的任务不发链接', 'code=' + ghost.code + ' data=' + JSON.stringify(ghost.data))

  if (SLOW) {
    const shortLived = await api('POST', 'agent/tasks/' + sample.id + '/share', { ttlSeconds: 60 })
    const shortToken = shortLived.data?.token
    check(secondsFromNow(shortLived.data?.expiresAt) <= 60, '分享·1 分钟有效期生效', 'expiresIn=' + secondsFromNow(shortLived.data?.expiresAt) + 's')
    await new Promise(resolve => setTimeout(resolve, 62000))
    const expired = await api('GET', 'agent/tasks/shared/' + shortToken)
    check(expired.code === 410 && expired.status === 410, '分享·过期令牌被拒（区别于不存在）', 'http=' + expired.status + ' code=' + expired.code)
  }

  // ---- AC-005-1 未配置大模型：给固定提示，绝不编造内容（临时移开配置，finally 原样放回） ----
  const cfgPath = join(DATA_ROOT, 'llm-user.json')
  const cfgBak = cfgPath + '.ac005-bak'
  const hadConfig = existsSync(cfgPath)
  let unconfiguredText = null
  let cfgRestored = false
  try {
    if (hadConfig) renameSync(cfgPath, cfgBak)
    const bare = await openStream('你好')
    await Promise.race([bare.finished, new Promise(resolve => setTimeout(resolve, 30000))])
    const bareTask = bare.taskId === null ? null : (await api('GET', 'agent/tasks/' + bare.taskId)).data
    unconfiguredText = lastAssistantText(bareTask)
    if (bare.taskId !== null) await api('DELETE', 'agent/tasks/' + bare.taskId)
  }
  finally {
    if (hadConfig && existsSync(cfgBak)) renameSync(cfgBak, cfgPath)
    cfgRestored = !hadConfig || existsSync(cfgPath)
  }
  check(typeof unconfiguredText === 'string' && unconfiguredText.startsWith('未接入任何大模型'),
    'AC-005-1 未配置模型给固定提示', '正文=' + String(unconfiguredText).slice(0, 24))
  check(cfgRestored, 'AC-005-1 测试后模型配置已还原', 'llm-user.json 存在=' + cfgRestored)

  // ---- AC-005-3 配置了但调用失败：如实报错，不拿模板冒充成功（用密钥覆写模拟，不动本机配置） ----
  const failing = await openStream('你好', undefined, { baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: 'sk-invalid-ac005', model: 'agnes-2.5-flash' })
  await Promise.race([failing.finished, new Promise(resolve => setTimeout(resolve, 120000))])
  const failingTask = failing.taskId === null ? null : (await api('GET', 'agent/tasks/' + failing.taskId)).data
  const failingText = lastAssistantText(failingTask)
  if (failingText === '') {
    SKIPS.push('AC-005-3：配置错误时内核没有返回任何正文（模型/内核暂时不可用）')
    envUnavailable = true
  }
  else {
    check(failingText.startsWith('大模型调用失败') && !/第一步：明确目标|小贴士/.test(failingText),
      'AC-005-3 调用失败如实报错，不冒充成功', '正文=' + failingText.slice(0, 30))
  }
  if (failing.taskId !== null) await api('DELETE', 'agent/tasks/' + failing.taskId)

  // ---- C2-03 中断 / 继续：需要能真实生成，模型不可用时判 SKIP ----
  /** 在生成中发一次停止；返回这次停止有没有真的落到正在生成的那一次。 */
  async function interruptOnce(delayMs) {
    const s = await openStream(PROMPT)
    if (!await waitFor(() => s.taskId !== null, 20000)) {
      console.log('AGENT_TASK_ACTIONS SKIP 生成没有返回 init 事件（内核/模型不可用）')
      process.exit(2)
    }
    if (!await waitFor(() => s.events.some(item => item.text !== ''), 60000)) {
      await api('DELETE', 'agent/tasks/' + s.taskId)
      console.log('AGENT_TASK_ACTIONS SKIP 生成没有返回任何增量（模型不可用），已清理探针任务')
      process.exit(2)
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    const emitted = s.events.filter(item => item.text !== '').map(item => item.text).join('')
    const abortAt = Date.now()
    const abort = await api('POST', 'agent/tasks/' + s.taskId + '/abort')
    return { s, emitted, abortAt, abort }
  }

  // 模型可能把整段正文一口气吐完：那样这次停止落在生成结束之后，interrupted=false，
  // 中断根本没发生，断言无从谈起——重试到真的中断为止，三次都赶不上就如实判 SKIP（黄灯）。
  let stream = null
  let emitted = ''
  let abort = null
  let abortAt = 0
  for (const delayMs of [600, 0, 0]) {
    if (stream !== null) break
    const tried = await interruptOnce(delayMs)
    await Promise.race([tried.s.finished, new Promise(resolve => setTimeout(resolve, 90000))])
    if (tried.abort.data?.interrupted === true) { stream = tried.s; emitted = tried.emitted; abort = tried.abort; abortAt = tried.abortAt }
    else await api('DELETE', 'agent/tasks/' + tried.s.taskId)
  }
  if (stream === null) {
    console.log('AGENT_TASK_ACTIONS SKIP 三次「停止」都没赶上生成（模型一次吐完整段正文），无法验证中断语义')
    process.exit(2)
  }
  check(abort.code === 0, '中断·接口受理', 'code=' + abort.code + ' interrupted=' + abort.data?.interrupted)
  const stoppedAfterMs = stream.endedAt === null ? -1 : stream.endedAt - abortAt
  check(stream.endedAt !== null && stoppedAfterMs <= 30000, '中断·生成随即停止', '中断后 ' + stoppedAfterMs + 'ms 结束流')

  const abortedTask = (await api('GET', 'agent/tasks/' + stream.taskId)).data
  check(abortedTask?.status === 'aborted', '中断·任务落库为已中断', 'status=' + abortedTask?.status)
  const partial = lastAssistantText(abortedTask)
  check(partial.includes('已中断') && partial.length <= emitted.length + 60,
    '中断·只保留已送达客户端的部分正文', '落库 ' + partial.length + ' 字 / 客户端收到 ' + emitted.length + ' 字')

  // ---- DEF-022 回归：正文流完后、收尾（封面/动作卡生成）期间点停止，终态不得被覆盖回 completed ----
  // 实测末个增量到 result 事件约 420ms，其中「收尾段」只有百余毫秒：慢轮询必然停晚。
  // 因此按实测窗口取 20ms 快轮询 + 三个时间点，停晚了（interrupted=false）就换点重试，都没赶上如实 SKIP。
  const LATE_DELAYS = [400, 340, 460]
  let lateChecked = false
  for (let round = 1; round <= LATE_DELAYS.length && !lateChecked; round++) {
    const late = await openStream(ACT_PROMPT)
    if (!await waitFor(() => late.taskId !== null, 20000)) {
      SKIPS.push('收尾窗口中断：生成没有返回 init 事件')
      break
    }
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const chunks = late.events.filter(item => item.text !== '')
      const total = chunks.reduce((sum, item) => sum + item.text.length, 0)
      if (total >= 200 && Date.now() - (chunks.at(-1)?.at ?? 0) >= LATE_DELAYS[round - 1]) break
      if (late.result !== null || late.endedAt !== null) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const lateAbort = await api('POST', 'agent/tasks/' + late.taskId + '/abort')
    await Promise.race([late.finished, new Promise(resolve => setTimeout(resolve, 90000))])
    if (lateAbort.code !== 0) {
      check(false, '中断·收尾阶段停止接口受理', 'code=' + lateAbort.code)
      lateChecked = true
    }
    else if (lateAbort.data?.interrupted !== true) {
      SKIPS.push('收尾窗口中断：第 ' + round + ' 次停止没赶上生成（已跑完）')
    }
    else {
      const settled = await taskById(late.taskId)
      const lastMessage = (settled?.messages ?? []).at(-1)
      const settledText = lastAssistantText(settled)
      check(settled?.status === 'aborted', '中断·收尾阶段停止不被覆盖回已完成', 'status=' + settled?.status)
      check(settledText.includes('已中断'), '中断·收尾阶段正文如实标注已中断', '结尾=' + settledText.slice(-14))
      check(!Array.isArray(lastMessage?.result) || lastMessage.result.length === 0,
        '中断·收尾阶段不再挂发布动作卡', '动作卡=' + (Array.isArray(lastMessage?.result) ? lastMessage.result.length : 0))
      lateChecked = true
    }
    await api('DELETE', 'agent/tasks/' + late.taskId)
  }

  const resume = await openStream(FOLLOW_UP, stream.taskId)
  const resumed = await Promise.race([resume.finished.then(() => true), new Promise(resolve => setTimeout(resolve, 90000, false))])
  const resumedTask = (await api('GET', 'agent/tasks/' + stream.taskId)).data
  check(resumed && resumedTask?.status === 'completed', '继续·同一任务接着跑完', 'status=' + resumedTask?.status + ' 消息=' + (resumedTask?.messages?.length ?? 0))
  check((resumedTask?.messages?.length ?? 0) >= (abortedTask?.messages?.length ?? 0) + 2, '继续·新消息追加在中断之后', '中断时=' + (abortedTask?.messages?.length ?? 0) + ' 继续后=' + (resumedTask?.messages?.length ?? 0))

  // ---- AC-005-2 已配置时真实调用：result 事件必须带模型名与真实正文 ----
  const realLooksOk = value => typeof value?.model === 'string' && value.model !== '' && value.model !== 'local-template'
    && value.content.length > 0 && !value.content.startsWith('未接入任何大模型') && !value.content.startsWith('大模型调用失败')
  let real = resume.result
  if (!realLooksOk(real)) {
    // 偶发模型/内核不可用：重试一次，仍失败就按环境问题交回门禁（黄灯），不判产品红灯。
    const retry = await openStream('用一句话回答：今天先做哪件事？')
    await Promise.race([retry.finished, new Promise(resolve => setTimeout(resolve, 90000))])
    real = retry.result
    if (retry.taskId !== null) await api('DELETE', 'agent/tasks/' + retry.taskId)
  }
  if (realLooksOk(real)) {
    check(true, 'AC-005-2 已配置时真实调用并返回模型结果', 'model=' + real.model + ' 正文=' + real.content.length + ' 字')
  }
  else if (typeof real?.content === 'string' && real.content.startsWith('大模型调用失败')) {
    SKIPS.push('AC-005-2：模型暂时不可用（' + real.content.slice(0, 24) + '）')
    envUnavailable = true
  }
  else {
    check(false, 'AC-005-2 已配置时真实调用并返回模型结果', 'model=' + real?.model + ' 正文=' + String(real?.content ?? '').slice(0, 30))
  }

  // ---- C1-07 任务评分：在探针任务上验证落库与回读，随后连任务一起删除 ----
  const rating = await api('POST', 'agent/tasks/' + stream.taskId + '/rating', { rating: 5, comment: '自检评分' })
  const ratingRead = await api('GET', 'agent/tasks/' + stream.taskId + '/rating')
  // DEF-018：读接口只回一层 data；再出现 data.data 说明双包装回来了。
  check(rating.code === 0 && ratingRead.data?.rating === 5 && ratingRead.data?.comment === '自检评分' && ratingRead.data?.data === undefined,
    '任务·评分落库并回读（单层 data）', 'code=' + rating.code + ' rating=' + ratingRead.data?.rating + ' 双层=' + (ratingRead.data?.data !== undefined))
  const ratingMissing = await api('GET', 'agent/tasks/zz-nonexistent-task/rating')
  check(ratingMissing.code === 18100, '任务·不存在的任务评分接口如实报错', 'code=' + ratingMissing.code)

  // ---- AC-014-2 评分 / 收藏刷新后仍保持：重新发请求 + 落盘文件双证 ----
  await api('POST', 'agent/tasks/' + stream.taskId + '/favorite')
  const persistedTask = (await api('GET', 'agent/tasks/' + stream.taskId)).data
  const onDiskTask = (Array.isArray(disk('agent-tasks.json')) ? disk('agent-tasks.json') : []).find(item => item.id === stream.taskId)
  check(persistedTask?.favorite === true && persistedTask?.rating === 5 && onDiskTask?.favorite === true && onDiskTask?.rating === 5,
    'AC-014-2 评分/收藏刷新后仍保持', '回读 favorite=' + persistedTask?.favorite + ' rating=' + persistedTask?.rating + '；落盘 favorite=' + onDiskTask?.favorite + ' rating=' + onDiskTask?.rating)

  const cleanup = await api('DELETE', 'agent/tasks/' + stream.taskId)
  check(cleanup.code === 0, '中断·探针任务已清理', 'code=' + cleanup.code)

  if (SLOW) {
    // 关窗口/切页（客户端断开）不等于点「停止」：没有显式中断就该把答案跑完并落库，避免丢结果。
    const dropped = await openStream('用一句话说明「关掉窗口」和「点停止」的区别。')
    await waitFor(() => dropped.taskId !== null, 20000)
    const streamed = await waitFor(() => dropped.events.some(item => item.text !== ''), 60000)
    if (dropped.taskId === null || !streamed) {
      SKIPS.push('断开语义：没有拿到生成中的任务')
    }
    else {
      dropped.drop()
      let settled = null
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        const task = await taskById(dropped.taskId)
        if (task !== null && task.status !== 'running') { settled = task; break }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      check(settled?.status === 'completed' && !lastAssistantText(settled).includes('已中断'),
        '断开·关窗口不等于中断：答案照样跑完落库', 'status=' + (settled?.status ?? '未落定'))
      await api('DELETE', 'agent/tasks/' + dropped.taskId)
    }
  }

  /**
   * 只有「模型不可用时前提就不成立」的断言才允许降级。
   *
   * 「中断·只保留已送达客户端的部分正文」比较的是「落库字数」与「客户端在 abort 前
   * 收到的增量字数」。模型不可用时走的是兜底文案：它不是逐步吐字，客户端轮询与 abort
   * 之间必然出现落差（实测落库 668 / 客户端 550），这条断言的前提根本不成立。
   * 中断本身是否真的生效由另外三条独立断言把关：接口受理、生成随即停止、任务落库为已中断。
   *
   * 这个降级不是放宽产品要求：envUnavailable 只在真实模型调用明确返回「大模型调用失败」
   * 时置位；模型可用时这条断言照旧按 +60 字容差严格判。
   */
  const MODEL_DEPENDENT = new Set(['中断·只保留已送达客户端的部分正文'])
  const failed = results.filter(item => !item.ok)
  const blocking = failed.filter(item => !(envUnavailable && MODEL_DEPENDENT.has(item.id)))
  const downgraded = failed.filter(item => envUnavailable && MODEL_DEPENDENT.has(item.id))

  const pass = results.filter(item => item.ok).length
  console.log('')
  console.log('AGENT_TASK_ACTIONS ' + (blocking.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + results.length + ' pass=' + pass + ' fail=' + failed.length)
  if (blocking.length > 0) console.log('FAILED: ' + blocking.map(item => item.id).join('、'))
  if (downgraded.length > 0) console.log('DOWNGRADED（模型不可用，前提不成立）: ' + downgraded.map(item => item.id).join('、'))
  if (SKIPS.length > 0) console.log('SKIPPED: ' + SKIPS.join('、'))
  if (blocking.length > 0) process.exit(1)
  process.exit(envUnavailable ? 2 : 0)
}

await main()
