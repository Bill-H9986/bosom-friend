#!/usr/bin/env node
/**
 * 中断时序矩阵：把「停止生成」这一族缺陷按时间窗整片扫一遍，而不是赌某一个时机。
 *
 * 由来：DEF-001（内存副本把 aborted 覆盖回 completed）修完后，DEF-022 在收尾窗口以同一形状复发；
 * 门禁原来的单点断言又因为时序假红（DEF-023）时绿时红——同一份代码跑两次结论不同。
 * 这里固定三条不变量，覆盖从「刚登记」到「生成已结束」的每个时间点：
 *   1. 终态落定后不得再翻转：同一任务隔 1.5 秒读两次必须一致；
 *   2. abort 回报 interrupted=true ⇒ 落库必须 aborted、正文标注已中断、不得挂发布动作卡；
 *   3. abort 回报 interrupted=false（这次停止没落到生成上）⇒ 落库必须是 completed，
 *      不得把「没停到」写成「已中断」。
 *
 * 用法：node products/bosom-friend/qa/acceptance/verify-abort-timing-matrix.mjs
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 应用未运行或模型不可用（判黄灯，不判产品红灯）
 */
const ORIGIN = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const BASE = ORIGIN + '/bosom-friend/api/'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'
/** 带内容创作意图：服务端会进入「生成封面 + 发布动作卡」的收尾阶段，覆盖 DEF-022 的时间窗。 */
const PROMPT = '帮我在小红书发布一篇春季护肤种草笔记，先把完整文案写出来。'
const results = []
const SKIPS = []

/** 调用产品 HTTP 接口。 */
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

/** 记录一条断言；失败也继续跑，最后统一汇总。 */
function check(ok, id, detail) {
  results.push({ ok: !!ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const taskById = async id => (await api('GET', 'agent/tasks/' + id)).data ?? null
/** 任务里最后一条 assistant 正文。 */
function lastAssistantText(task) {
  const messages = (task?.messages ?? []).filter(item => item.type === 'assistant')
  const last = messages.at(-1)
  return typeof last?.content === 'string' ? last.content : ''
}

/** 打开一条 SSE 生成流，收集增量与结束时刻。 */
function openStream(prompt) {
  const state = { taskId: null, deltas: [], resultAt: null, endedAt: null }
  state.finished = (async () => {
    const response = await fetch(BASE + 'agent/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ prompt, includePartialMessages: true }),
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
        try { payload = JSON.parse(line.replace(/^data:\s*/, '')) } catch { continue }
        if (payload.type === 'init' && state.taskId === null) state.taskId = payload.taskId
        const text = payload.event?.delta?.text ?? ''
        if (text !== '') state.deltas.push({ at: Date.now(), text })
        if (payload.type === 'result') state.resultAt = Date.now()
      }
    }
    state.endedAt = Date.now()
  })()
  return state
}

/** 等到这个时间点：init / 首个增量 / 正文停顿 quietMs / 生成已结束。 */
async function waitTiming(stream, timing) {
  const deadline = Date.now() + 120000
  if (timing.wait === 'init') {
    while (stream.taskId === null && Date.now() < deadline) await sleep(20)
    return
  }
  if (timing.wait === 'settled') {
    while (stream.endedAt === null && Date.now() < deadline) await sleep(50)
    return
  }
  while (Date.now() < deadline) {
    if (stream.deltas.length > 0) {
      if (timing.wait === 'delta') return
      const total = stream.deltas.reduce((sum, item) => sum + item.text.length, 0)
      const quiet = Date.now() - (stream.deltas.at(-1)?.at ?? 0)
      if (total >= 200 && quiet >= timing.quietMs) return
    }
    if (stream.endedAt !== null) return
    await sleep(20)
  }
}

const TIMINGS = [
  { name: '刚登记 init', wait: 'init', expectInterrupted: true },
  { name: '首个增量', wait: 'delta', expectInterrupted: true },
  { name: '正文停顿 300ms', wait: 'quiet', quietMs: 300, expectInterrupted: true },
  { name: '收尾窗口 450ms', wait: 'quiet', quietMs: 450, expectInterrupted: true },
  { name: '生成已结束', wait: 'settled', expectInterrupted: false },
]

/** 单个时间点：停一次，验证三条不变量。 */
async function runTiming(timing) {
  const stream = openStream(PROMPT)
  await waitTiming(stream, timing)
  if (stream.taskId === null) return null
  const emitted = stream.deltas.reduce((sum, item) => sum + item.text.length, 0)
  const abort = await api('POST', 'agent/tasks/' + stream.taskId + '/abort')
  // 停止之后高频盯住状态：终态一旦落定就不得再变。DEF-022 的覆盖只持续几百毫秒，
  // 隔几秒读两次是看不见的——必须把整条状态序列录下来（实测覆盖形态：aborted → completed）。
  const sequence = []
  const watchUntil = Date.now() + 4000
  while (Date.now() < watchUntil) {
    const snapshot = await taskById(stream.taskId)
    const status = snapshot?.status ?? null
    if (sequence.at(-1) !== status) sequence.push(status)
    if (stream.endedAt !== null && Date.now() > stream.endedAt + 1200) break
    await sleep(40)
  }
  await Promise.race([stream.finished, sleep(90000)])
  const settled = await taskById(stream.taskId)
  const lastMessage = (settled?.messages ?? []).at(-1)
  const record = {
    timing,
    emitted,
    abortCode: abort.code,
    interrupted: abort.data?.interrupted,
    sequence,
    statusSecond: settled?.status ?? null,
    text: lastAssistantText(settled),
    actionCards: Array.isArray(lastMessage?.result) ? lastMessage.result.length : 0,
  }
  await api('DELETE', 'agent/tasks/' + stream.taskId)
  return record
}

async function main() {
  try {
    const probe = await api('GET', 'v2/channels/account-groups')
    if (probe.code !== 0) throw new Error('code=' + probe.code)
  } catch (error) {
    console.log('ABORT_MATRIX SKIP 应用未运行（' + ORIGIN + '）：' + (error instanceof Error ? error.message : String(error)))
    process.exit(2)
  }

  for (const timing of TIMINGS) {
    const record = await runTiming(timing)
    const label = '矩阵·' + timing.name
    if (record === null) {
      SKIPS.push(label + '：没有拿到 init 事件（模型/内核不可用）')
      continue
    }
    check(record.abortCode === 0, label + '·停止接口受理', 'code=' + record.abortCode + ' interrupted=' + record.interrupted)
    // 不变量 1：终态落定后不得再翻转（DEF-022 就是落定后从 aborted 翻回 completed）
    const terminal = record.sequence.filter(status => status !== null && status !== 'running')
    check(new Set(terminal).size <= 1,
      label + '·终态落定后不再翻转', '状态序列=' + record.sequence.join(' → '))
    if (record.interrupted === true) {
      check(record.statusSecond === 'aborted', label + '·真中断落库 aborted', 'status=' + record.statusSecond)
      check(record.text.includes('已中断'), label + '·正文标注已中断', '结尾=' + record.text.slice(-14))
      check(record.actionCards === 0, label + '·不再挂发布动作卡', '动作卡=' + record.actionCards)
    }
    else {
      // 不变量 3：停止没落到生成上时不得写成已中断（诚实性反向断言）
      check(record.statusSecond === 'completed', label + '·停晚了如实落 completed', 'status=' + record.statusSecond)
      check(!record.text.includes('已中断'), label + '·停晚了不谎称已中断', '结尾=' + record.text.slice(-14))
    }
    if (record.interrupted !== timing.expectInterrupted)
      SKIPS.push(label + '：这次没命中预期时机（interrupted=' + record.interrupted + '），该点的时机覆盖不计入')
  }

  const pass = results.filter(item => item.ok).length
  const fail = results.length - pass
  console.log('')
  console.log('ABORT_MATRIX ' + (fail === 0 ? 'PASS' : 'FAIL') + ' checks=' + results.length + ' pass=' + pass + ' fail=' + fail)
  if (fail > 0) console.log('FAILED: ' + results.filter(item => !item.ok).map(item => item.id).join('、'))
  if (SKIPS.length > 0) console.log('SKIPPED: ' + SKIPS.join('、'))
  process.exit(fail > 0 ? 1 : 0)
}

await main()
