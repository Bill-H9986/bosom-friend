/**
 * AI 智能体板块行为探针（debug 用，不参与门禁）。
 *
 * 目的：为 C2-03「中断 / 继续」与 C2-04「分享链接」写断言之前，先看清真实运行时
 * 到底发了哪些请求、服务端如何落库、页面如何表现——避免用页面文案凑断言。
 *
 * 用法：
 *   node products/bosom-friend/qa/probes/probe-agent-board.mjs          # 只观察接口
 *   node products/bosom-friend/qa/probes/probe-agent-board.mjs --ui     # 追加浏览器观察
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const WITH_UI = process.argv.includes('--ui')
// 只跑 UI 观察：跳过真实对话生成，复用既有已完成任务（避免每轮都往用户任务列表里塞新任务）。
const SKIP_CHAT = process.argv.includes('--skip-chat')
const OUT = join(import.meta.dirname, 'probe-agent-board-report.json')
const SHOTS = join(import.meta.dirname, 'agent-board')
const report = { base: BASE, at: new Date().toISOString(), api: {}, ui: {}, notes: [] }

/** 调用产品接口，返回 { status, envelope }；envelope 为 {code,data,message} 或 null。 */
async function api(path, init) {
  const response = await fetch(BASE + path, init)
  const envelope = await response.json().catch(() => null)
  return { status: response.status, envelope }
}

/** 打开一条 SSE 对话流；返回 { taskId, events, abortNow, done }。 */
function openChatStream(prompt, taskId) {
  const state = { taskId: null, events: [], controller: new AbortController(), finished: false, abortedAt: null }
  const body = { prompt, includePartialMessages: true }
  if (typeof taskId === 'string' && taskId !== '')
    body.taskId = taskId
  state.done = (async () => {
    const response = await fetch(BASE + 'api/agent/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: state.controller.signal,
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true)
          break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const line = block.split('\n').find(item => item.startsWith('data:'))
          if (line === undefined)
            continue
          let payload = null
          try { payload = JSON.parse(line.replace(/^data:\s*/, '')) }
          catch { /* 心跳等非 JSON 行 */ }
          if (payload === null)
            continue
          state.events.push({ type: payload.type, at: Date.now(), text: payload.event?.delta?.text ?? null })
          if (payload.type === 'init' && state.taskId === null)
            state.taskId = payload.taskId
          if (payload.type === 'done')
            state.finished = true
        }
      }
    }
    catch (error) {
      state.streamError = String(error?.message ?? error)
    }
    state.finished = true
  })()
  state.abortNow = async () => {
    if (state.taskId === null) {
      report.notes.push('abortNow 调用时还没有拿到 taskId，跳过')
      return null
    }
    state.abortedAt = Date.now()
    return api('api/agent/tasks/' + state.taskId + '/abort', { method: 'POST' })
  }
  return state
}

const taskById = async (taskId) => {
  const { envelope } = await api('api/agent/tasks/' + taskId)
  return envelope?.data ?? null
}

console.log('=== 1. 任务列表 ===')
{
  const { envelope } = await api('api/agent/tasks?page=1&pageSize=50')
  const list = envelope?.data?.list ?? []
  report.api.taskList = { code: envelope?.code, total: envelope?.data?.total, statuses: list.map(item => item.status) }
  console.log('code=' + envelope?.code + ' total=' + envelope?.data?.total + ' statuses=' + JSON.stringify(report.api.taskList.statuses))
}

console.log('=== 2. 生成分享 token（请求 1 小时，看服务端回什么） ===')
const completed = await (async () => {
  const { envelope } = await api('api/agent/tasks?page=1&pageSize=50')
  return (envelope?.data?.list ?? []).find(item => item.status === 'completed') ?? null
})()
if (completed === null) {
  console.log('没有已完成任务，分享部分跳过（先跑一次对话）')
}
else {
  const shareOne = await api('api/agent/tasks/' + completed.id + '/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttlSeconds: 3600 }),
  })
  const vo = shareOne.envelope?.data ?? {}
  const claimedDays = vo.expiresAt === undefined ? null : Math.round((Date.parse(vo.expiresAt) - Date.now()) / 86400000 * 10) / 10
  report.api.share = { taskId: completed.id, code: shareOne.envelope?.code, token: vo.token, expiresAt: vo.expiresAt, urlPath: vo.urlPath, claimedDays, requestedSeconds: 3600 }
  console.log(JSON.stringify(report.api.share))

  console.log('=== 3. 共享页接口 ===')
  const shared = await api('api/agent/tasks/shared/' + vo.token)
  const sharedTask = shared.envelope?.data ?? null
  const types = [...new Set((sharedTask?.messages ?? []).map(m => m.type))]
  report.api.shared = { code: shared.envelope?.code, messageCount: (sharedTask?.messages ?? []).length, messageTypes: types, status: sharedTask?.status, title: sharedTask?.title }
  console.log(JSON.stringify(report.api.shared))
  const bogus = await api('api/agent/tasks/shared/deadbeefdeadbeef')
  report.api.sharedBogus = { code: bogus.envelope?.code, message: bogus.envelope?.message }
  console.log('无效 token -> ' + JSON.stringify(report.api.sharedBogus))

  console.log('=== 4. 同一任务再分享一次：token 会不会换、旧 token 还灵不灵 ===')
  const shareTwo = await api('api/agent/tasks/' + completed.id + '/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttlSeconds: 60 }) })
  const second = shareTwo.envelope?.data ?? {}
  const oldStillWorks = await api('api/agent/tasks/shared/' + vo.token)
  const shortTtl = second.expiresAt === undefined ? null : Math.round((Date.parse(second.expiresAt) - Date.now()) / 60000 * 10) / 10
  report.api.shareAgain = { tokenChanged: second.token !== vo.token, oldTokenCode: oldStillWorks.envelope?.code, requestedSeconds: 60, claimedMinutes: shortTtl }
  console.log(JSON.stringify(report.api.shareAgain))
}

console.log('=== 5. 中断：发起真实对话 → 中途中断 → 回读落库状态 ===')
if (!SKIP_CHAT) {
  const prompt = '请详细介绍你自己都能帮我做哪些事情，尽量写详细一些，内容多一点。'
  const stream = openChatStream(prompt)
  // 等到第一个增量文本后 800ms 再中断：确保中断落在生成过程中，而不是模型还没开始。
  const gotDelta = await (async () => {
    const started = Date.now()
    while (Date.now() - started < 30000) {
      if (stream.events.some(item => item.text !== null && item.text !== ''))
        return true
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  })()
  await new Promise(resolve => setTimeout(resolve, 800))
  const abortResponse = await stream.abortNow()
  console.log('拿到首个增量=' + gotDelta + ' 中断接口 code=' + abortResponse?.envelope?.code)
  await Promise.race([stream.done, new Promise(resolve => setTimeout(resolve, 120000))])
  const task = await taskById(stream.taskId)
  report.api.abort = {
    taskId: stream.taskId,
    gotFirstDelta: gotDelta,
    abortRequestedAtMs: stream.abortedAt,
    streamFinished: stream.finished,
    streamEvents: stream.events.length,
    doneEventAfterAbort: stream.events.some(item => item.type === 'done' && stream.abortedAt !== null && item.at > stream.abortedAt),
    storedStatus: task?.status,
    storedMessages: task?.messages?.length ?? 0,
    lastAssistantChars: (() => {
      const assistants = (task?.messages ?? []).filter(m => m.type === 'assistant')
      const last = assistants[assistants.length - 1]
      return typeof last?.content === 'string' ? last.content.length : (typeof last?.message?.content?.[0]?.text === 'string' ? last.message.content[0].text.length : 0)
    })(),
  }
  console.log(JSON.stringify(report.api.abort))

  console.log('=== 6. 继续对话：同一 taskId 再发一条 ===')
  const again = openChatStream('再用一句话总结你刚才说的重点。', stream.taskId)
  await Promise.race([again.done, new Promise(resolve => setTimeout(resolve, 120000))])
  const after = await taskById(stream.taskId)
  report.api.continue = {
    taskId: stream.taskId,
    storedStatus: after?.status,
    storedMessages: after?.messages?.length ?? 0,
    streamFinished: again.finished,
    streamError: again.streamError ?? null,
  }
  console.log(JSON.stringify(report.api.continue))
  report.api.probeTaskId = stream.taskId
}
else {
  report.api.probeTaskId = completed?.id ?? null
  console.log('--skip-chat：跳过真实生成，UI 观察复用 ' + report.api.probeTaskId)
}

if (WITH_UI) {
  const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error).slice(0, 200)))
  const mainText = async target => (await target.locator('#main-content').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()

  async function acceptDisclaimer(target) {
    for (let i = 0; i < 8; i++) {
      const agreement = target.locator("button:has-text('我已阅读并同意')").first()
      if (await agreement.count() > 0 && await agreement.isVisible().catch(() => false))
        await agreement.click({ timeout: 3000 }).catch(() => {})
      const enter = target.locator("button:has-text('同意并进入平台')").first()
      if (await enter.count() > 0 && await enter.isVisible().catch(() => false))
        await enter.click({ timeout: 3000 }).catch(() => {})
      await target.waitForTimeout(400)
    }
  }

  const taskId = report.api.probeTaskId ?? completed?.id
  console.log('=== 7. UI：任务详情 → 分享 → 打开生成的链接 ===')
  await page.goto(BASE + '#/chat/' + taskId, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await acceptDisclaimer(page)
  await page.screenshot({ path: join(SHOTS, '01-task-detail.png') })
  const shareButton = page.locator('button').filter({ hasText: /^分享/ }).first()
  report.ui.shareButtonCount = await shareButton.count()
  if (await shareButton.count() > 0) {
    await shareButton.click()
    await page.waitForTimeout(2500)
    const dialog = page.locator('[role=dialog]').last()
    const dialogText = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
    report.ui.shareDialogText = dialogText.slice(0, 400)
    console.log('分享弹窗：' + report.ui.shareDialogText.slice(0, 220))
    const buttonTexts = await dialog.locator('button:visible').allInnerTexts().catch(() => [])
    report.ui.shareDialogButtons = buttonTexts.map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t !== '')
    console.log('弹窗按钮：' + JSON.stringify(report.ui.shareDialogButtons))
    const generate = dialog.locator('button:visible').filter({ hasText: /复制链接|Copy link|生成/ }).first()
    if (await generate.count() > 0) {
      await generate.click().catch(() => {})
      await page.waitForTimeout(4000)
      const afterGenerate = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
      report.ui.shareDialogAfter = afterGenerate.slice(-400)
      const linkMatch = /https?:\/\/[^\s]+/.exec(afterGenerate)
      report.ui.generatedLink = linkMatch?.[0] ?? null
      const linkNode = await dialog.locator('.break-all').first().innerText().catch(() => '')
      report.ui.shareLinkNode = linkNode.replace(/\s+/g, ' ').trim()
      if (report.ui.generatedLink === null && report.ui.shareLinkNode !== '')
        report.ui.generatedLink = report.ui.shareLinkNode
      console.log('生成后弹窗：' + afterGenerate.slice(0, 260))
      console.log('抓到的链接：' + report.ui.generatedLink)
      await page.screenshot({ path: join(SHOTS, '02-share-dialog.png') })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1200)

      if (report.ui.generatedLink !== null) {
        const linkPage = await context.newPage()
        const [response] = await Promise.all([
          linkPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
          linkPage.goto(report.ui.generatedLink, { waitUntil: 'domcontentloaded' }).catch(error => (report.ui.linkNavigationError = String(error?.message ?? error))),
        ])
        await linkPage.waitForTimeout(6000)
        report.ui.linkHttpStatus = response?.status?.() ?? null
        report.ui.linkFinalUrl = linkPage.url()
        report.ui.linkBodyText = (await linkPage.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
        await linkPage.screenshot({ path: join(SHOTS, '03-generated-link.png') })
        console.log('打开生成链接 -> HTTP ' + report.ui.linkHttpStatus + ' url=' + report.ui.linkFinalUrl)
        console.log('页面文案：' + report.ui.linkBodyText.slice(0, 200))

        const token = /token=([0-9a-f]+)/.exec(report.ui.generatedLink)?.[1]
        if (token !== undefined) {
          const fixed = await context.newPage()
          await fixed.goto(BASE + '#/chat?token=' + token, { waitUntil: 'domcontentloaded' })
          await fixed.waitForTimeout(6000)
          report.ui.fixedLinkUrl = fixed.url()
          report.ui.fixedLinkText = (await fixed.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
          await fixed.screenshot({ path: join(SHOTS, '04-hash-token-link.png') })
          console.log('改用 hash 路由打开 -> ' + report.ui.fixedLinkText.slice(0, 200))
        }
        await linkPage.close()
      }
    }
    else {
      console.log('弹窗里没有找到生成链接按钮')
    }
  }
  else {
    console.log('任务详情页没有分享按钮')
  }

  console.log('=== 8. UI：详情页发送 → 停止 → 回读 ===')
  await page.goto(BASE + '#/chat/' + taskId, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const input = page.locator('textarea').last()
  report.ui.detailInputCount = await input.count()
  if (await input.count() > 0) {
    await input.fill('请用三句话说明你今天能帮我做什么。')
    const send = page.locator('button[aria-label="发送"]').last()
    report.ui.sendButtonCount = await send.count()
    if (await send.count() > 0) {
      await send.click()
      await page.waitForTimeout(1500)
      const stop = page.locator('button[aria-label="停止生成"]').last()
      const stopVisible = await stop.count() > 0 && await stop.isVisible().catch(() => false)
      report.ui.stopButtonVisible = stopVisible
      if (stopVisible) {
        await stop.click()
        await page.waitForTimeout(1500)
      }
      const toast = await page.locator('[data-sonner-toast], .ant-message').allInnerTexts().catch(() => [])
      report.ui.stopToast = toast.map(t => t.replace(/\s+/g, ' ').trim())
      await page.screenshot({ path: join(SHOTS, '05-after-stop.png') })
      const afterStop = await taskById(taskId)
      report.ui.afterStopStatus = afterStop?.status
      console.log('停止按钮可见=' + stopVisible + ' 提示=' + JSON.stringify(report.ui.stopToast) + ' 落库状态=' + afterStop?.status)
      await page.waitForTimeout(8000)
      const settled = await taskById(taskId)
      report.ui.settledStatus = settled?.status
      report.ui.settledMessages = settled?.messages?.length ?? 0
      console.log('等待 8 秒后落库状态=' + settled?.status + ' 消息数=' + settled?.messages?.length)
      await page.screenshot({ path: join(SHOTS, '06-after-settle.png') })
    }
  }

  console.log('=== 9. UI：右侧 AI 助手发送 → 停止 → 回读（侧栏路径） ===')
  {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(7000)
    await acceptDisclaimer(page)
    const before = new Set(((await api('api/agent/tasks?page=1&pageSize=20')).envelope?.data?.list ?? []).map(item => item.id))
    const panel = page.locator('[data-testid=ai-assistant-sidebar]').first()
    const sideInput = panel.locator('textarea').first()
    report.ui.sidebarInputCount = await sideInput.count()
    if (await sideInput.count() > 0) {
      await sideInput.fill('请用三句话说明你今天能帮我做什么。')
      await panel.locator('button[aria-label="发送"]').last().click({ timeout: 15000 }).catch(error => (report.ui.sidebarSendError = String(error?.message ?? error)))
      const sideStop = panel.locator('button[aria-label="停止生成"]').last()
      const appeared = await sideStop.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false)
      report.ui.sidebarStopVisible = appeared
      const list = (await api('api/agent/tasks?page=1&pageSize=20')).envelope?.data?.list ?? []
      const fresh = list.find(item => !before.has(item.id))
      report.ui.sidebarTaskId = fresh?.id ?? null
      if (appeared) {
        await sideStop.click().catch(() => {})
        await page.waitForTimeout(6000)
      }
      const after = fresh === undefined ? null : await taskById(fresh.id)
      report.ui.sidebarTaskStatus = after?.status ?? null
      await page.screenshot({ path: join(SHOTS, '07-sidebar-stop.png') })
      console.log('侧栏停止按钮=' + appeared + ' 任务=' + report.ui.sidebarTaskId + ' 停止后状态=' + report.ui.sidebarTaskStatus)
    }
    else {
      console.log('侧栏没有输入框')
    }
  }
  report.ui.mainTextAfterEverything = (await mainText(page)).slice(0, 200)
  report.ui.pageErrors = pageErrors
  await browser.close()
}

writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
console.log('报告已写入 ' + OUT)
