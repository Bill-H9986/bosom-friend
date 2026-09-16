/**
 * 全链路循环自检：内容创作 / 账号管理 / AI 智能体 三大核心功能逐个真点、真跑。
 *
 * 用法：
 *   node products/bosom-friend/qa/acceptance/full-chain-loop.mjs                 # 跑到"发布弹窗就绪"，不真发
 *   node products/bosom-friend/qa/acceptance/full-chain-loop.mjs --real-publish  # 额外真实提交一次发布
 *   BF_CHAIN_PLATFORM=douyin|xhs
 *   BF_CHAIN_ONLY=A,L2-B,L3-B      # 只跑指定 id 前缀的项（按板块 debug 时用，层闸门只统计跑过的项）
 *
 * 每一步独立 try/catch：一步失败不影响后面的步骤，最后输出 BLOCKERS 清单。
 * 截图落在 qa/acceptance/full-chain/。
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadChromium } from '../browser.mjs'

const require = createRequire(import.meta.url)
const chromium = loadChromium()

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const PLATFORM = process.env.BF_CHAIN_PLATFORM || 'douyin'
const REAL_PUBLISH = process.argv.includes('--real-publish')
const OUT = join(import.meta.dirname, 'full-chain')
mkdirSync(OUT, { recursive: true })

/** 自检项 → 三大核心功能归属（与 docs/功能清单-三大核心功能.md 的编号一致）。 */
const CORE_OF = {
  A1: 'B', A2: 'B', A3: 'B', A4: 'B', A5: 'B', A6: 'B', A7: 'B', A8: 'B',
  A9: 'B', A10: 'B', A11: 'B', A12: 'B', A13: 'B', A14: 'B', A15: 'B', A16: 'B', A17: 'B',
  B1: 'A', B2: 'A', B3: 'A', B4: 'A', B5: 'A', B6: 'A', B7: 'A', B8: 'A',
  B9: 'A', B10: 'A', B11: 'A', B12: 'A', B13: 'A', B14: 'A', B15: 'A', B16: 'A', B17: 'A', B18: 'A',
  C1: 'C', C2: 'C', C3: 'C', C4: 'C', C5: 'C', C6: 'C', C7: 'C', C8: 'C', C9: 'C', C10: 'C', C11: 'C', C12: 'C', C13: 'C', C14: 'C', C15: 'C', C16: 'C',
  C17: 'C', C18: 'C', C19: 'C', B20: 'A',
  B19: 'A',
  D6: 'D',
  D1: 'C', D2: 'B', D3: 'A', D4: 'C', D5: 'C',
  E1: 'C', E2: 'A', E3: 'C', E4: 'B', E5: 'C', E6: 'D',
}
const CORE_NAME = { A: '内容创作', B: '账号管理', C: 'AI 智能体', D: '公共底座' }

/** 分层：L1 小功能点 → L2 小功能区 → L3 核心板块 → L4 整体集成（层层递进，低层失败即停止向上）。 */
function layerOf(id) {
  if (id.startsWith('L2-')) return 2
  if (id.startsWith('L3-')) return 3
  if (id.startsWith('L4-')) return 4
  return 1
}
const WANT_LAYER = process.env.BF_CHAIN_LAYER ? Number(process.env.BF_CHAIN_LAYER) : 0
/** 按板块 debug 时的项过滤：逗号分隔的 id 前缀，如 A,L2-B,L3-B；为空表示全跑。 */
const ONLY = (process.env.BF_CHAIN_ONLY ?? '').split(',').map(item => item.trim()).filter(Boolean)
const wanted = id => ONLY.length === 0 || ONLY.some(prefix => id === prefix || id.startsWith(prefix))
const layerFails = { 1: 0, 2: 0, 3: 0, 4: 0 }
let stoppedAtLayer = 0

const results = []
const blockers = []
const apiFailures = []
const pageErrors = []
const toasts = []
let shotSeq = 0

function record(id, name, ok, detail = '') {
  const layer = layerOf(id)
  results.push({ id, name, ok: !!ok, detail, layer })
  if (!ok) {
    blockers.push({ id, name, detail, layer })
    layerFails[layer] += 1
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' :: ' + detail : ''}`)
}

/** 层间闸门：本层有失败就停止向上执行（层层递进的硬约束）。 */
function layerGate(layer) {
  const failed = results.filter(item => item.layer === layer && !item.ok).length
  const total = results.filter(item => item.layer === layer).length
  console.log(`
--- L${layer} 闸门：${total - failed}/${total} 通过 ---`)
  if (failed > 0) {
    stoppedAtLayer = layer
    console.log(`*** L${layer} 存在失败，按层层递进原则停止，不再执行更高层 ***`)
  }
}

async function snap(page, label) {
  const file = join(OUT, `${String(shotSeq++).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file }).catch(() => {})
  return file
}

const text = async (page, selector = 'body') =>
  (await page.locator(selector).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()

/**
 * 主内容区文本。侧栏导航与右侧 AI 面板都在 #main-content 之外，因此页面断言必须用
 * 它：用整页 body 文案时，「任务记录/发布日历/全局监控」等常驻导航会让页面根本没
 * 渲染出来也判 PASS。
 * @param page - 当前页面。
 * @returns 主内容区纯文本。
 */
const mainText = async page =>
  (await page.locator('#main-content').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()

/**
 * 调用真实接口并断言业务码为 0。HTTP 200 不等于业务成功，落库类断言必须看 code。
 * @param path - 相对 BASE 的接口路径，如 'api/contents/drafts/1/200'。
 * @param init - 可选的 fetch 参数。
 * @returns 响应信封（{code,data,message}）里的 data。
 */
async function apiOk(path, init) {
  const response = await fetch(BASE + path, init)
  const envelope = await response.json().catch(() => null)
  if (envelope === null)
    throw new Error('接口没有返回 JSON：' + path + '（HTTP ' + response.status + '）')
  if (envelope.code !== 0)
    throw new Error('接口业务码非 0：' + path + ' code=' + String(envelope.code) + ' ' + String(envelope.message ?? '').slice(0, 80))
  return envelope.data
}

/**
 * 中文请求体编码守卫。本机 tools.pwsh 是 Windows PowerShell 5.1，`Invoke-WebRequest -Body <字符串>`
 * 按 ASCII 编码请求体，中文全部变成 '?'（本仓库已因此损坏落盘数据 3 次）。凡带中文的 POST/PUT 往返，
 * 回读字段必须仍有中文：出现连续 '?' 或中文整体丢失即判红，不允许"写进去是问号也算通过"。
 * @param label - 断言位置说明，写进失败信息。
 * @param sent - 请求体里发出的中文字段值。
 * @param readback - 服务端回读到的对应值（字符串或任意可序列化值）。
 */
function assertNoAsciiFallback(label, sent, readback) {
  const text = typeof readback === 'string' ? readback : JSON.stringify(readback ?? null)
  if (/\?{2,}/.test(text))
    throw new Error('请求体编码被 ASCII 回退（中文变 ?）：' + label + ' 发出=' + sent + ' 回读=' + text.slice(0, 80))
  if (/\p{Script=Han}/u.test(sent) && !/\p{Script=Han}/u.test(text))
    throw new Error('请求体编码被 ASCII 回退（中文丢失）：' + label + ' 发出=' + sent + ' 回读=' + text.slice(0, 80))
}

/**
 * 落库文件都是 {schemaVersion, value:[...]} 信封：按裸数组解析会静默得到 0 条，
 * 历史上"数据一致性审计"就是这么空转的，所以这里解析不出数组就直接报错。
 * @param name - 数据根下的文件名，如 metrics.json。
 * @returns 信封里的 value 数组。
 */
function readEnvelope(name) {
  const parsed = JSON.parse(readFileSync(join(homedir(), '.bosom-friend', 'bosom-friend', name), 'utf8'))
  if (Array.isArray(parsed))
    return parsed
  if (!Array.isArray(parsed.value))
    throw new Error(name + ' 不是数组信封')
  return parsed.value
}

/** 账号库（服务端权威数据）：断言账号是否真的落库/消失，不能只看界面文案。 */
const listAccounts = async () => (await apiOk('api/v2/channels/accounts'))?.list ?? []

/** 账号分组（服务端权威数据）。 */
const listGroups = async () => (await apiOk('api/v2/channels/account-groups')) ?? []

/** 破坏性操作前的落盘快照目录（backupBeforeDestructive 的产物）。 */
const BACKUPS_DIR = join(homedir(), '.bosom-friend', 'bosom-friend', 'backups')
function backupSnapshots(prefix) {
  try {
    return readdirSync(BACKUPS_DIR).filter(name => name.startsWith(prefix))
  }
  catch {
    return []
  }
}

/** 生成任务落库回读（draft-generations.json 对应的分页接口）。 */
const listGenerations = async () => (await apiOk('api/ai/draft-generation?page=1&pageSize=50'))?.list ?? []

/** 草稿落库回读（contents.json 里 kind='draft' 的记录）。 */
const listDrafts = async () => (await apiOk('api/contents/drafts/1/200')) ?? { list: [], total: 0 }

/** 生成任务状态标签，与 brandPromotion.json 的 detail.taskStatus 一致。 */
const GENERATION_STATUS_LABEL = { generating: '生成中', success: '生成成功', partial: '部分成功', failed: '生成失败' }

/**
 * 生成记录弹窗必须渲染 ai/draft-generation 的真实落库数据：空库给空态，有库必须出现
 * 最新任务的状态与标题。弹窗是点击后才挂载的独立节点，页面文案满足不了它。
 * @param dialog - [data-testid=draftbox-generation-detail-dialog] 定位器。
 * @returns 判定摘要。
 */
async function assertGenerationDialogMatchesApi(dialog) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const generations = await listGenerations()
    const dialogText = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (generations.length === 0) {
      if (dialogText.includes('暂无生成任务'))
        return '库中无生成任务，弹窗给出空态'
      if (attempt === 3)
        throw new Error('库中没有生成任务，弹窗也没有空态：' + dialogText.slice(0, 140))
    }
    else {
      const newest = generations[0]
      const label = GENERATION_STATUS_LABEL[newest.status] ?? String(newest.status)
      const title = String(newest.response?.title ?? '')
      if (dialogText.includes(label) && (title === '' || dialogText.includes(title.slice(0, 8))))
        return '弹窗与落库一致：' + newest.id + ' ' + label
      if (attempt === 3)
        throw new Error('弹窗没有渲染最新生成任务 ' + newest.id + '（status=' + label + '，title=' + title.slice(0, 20) + '）：' + dialogText.slice(0, 140))
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  throw new Error('生成记录弹窗与落库数据不一致')
}

async function acceptDisclaimer(page) {
  for (let i = 0; i < 6; i++) {
    const button = page.locator("button:has-text('我已阅读并同意')").first()
    if (await button.count() > 0 && await button.isVisible().catch(() => false))
      await button.click({ timeout: 4000 }).catch(() => {})
    const enter = page.locator("button:has-text('同意并进入平台')").first()
    if (await enter.count() > 0 && await enter.isVisible().catch(() => false))
      await enter.click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
}

/**
 * 关闭发布弹窗：右上角 X → 二次确认弹框的「确定」。
 * 发布弹窗不吃 Escape，且关闭前必须确认（useCloseDialog），所以要按真实路径关。
 */
async function closePublishDialog(page) {
  const close = page.locator('[data-testid=publish-close-button]').first()
  if (await close.count() > 0)
    await close.click({ timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1800)
  const ok = page.locator('.ant-modal-confirm button:has-text("确定"), .ant-btn-primary:has-text("确定")').last()
  if (await ok.count() > 0 && await ok.isVisible().catch(() => false))
    await ok.click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(2200)
  // 兜底：确认框按钮没被上面的选择器命中时，直接点最后一个「确定」。
  if (await page.locator('[data-testid=publish-dialog-container]').count() > 0) {
    const fallback = page.locator('button:has-text("确定")').last()
    if (await fallback.count() > 0)
      await fallback.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1500)
  }
}

/**
 * 关掉一切挡住点击的弹层（发布结果弹窗、确认框、抽屉等）。
 * 只点关闭类按钮，绝不点「发布/提交/确定」中的提交语义按钮——避免误触真实发布。
 */
async function dismissOverlays(page) {
  for (let round = 0; round < 4; round++) {
    const blocked = await page.evaluate(() => {
      const layers = [...document.querySelectorAll('.ant-modal-root, [role=dialog], [role=alertdialog], [data-radix-popper-content-wrapper]')]
        .filter(node => node.offsetWidth || node.offsetHeight)
      return layers.length
    })
    if (blocked === 0)
      return
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(600)
    const closers = [
      '.ant-modal-close',
      '[role=dialog] button[aria-label*="close" i]',
      '[role=dialog] button[aria-label*="关闭"]',
      '[role=dialog] button:has-text("关闭")',
      '[role=dialog] button:has-text("知道了")',
      '[role=dialog] button:has-text("取消")',
    ]
    for (const selector of closers) {
      const target = page.locator(selector).filter({ hasNotText: /发布|提交|立即/ }).first()
      if (await target.count() > 0 && await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(900)
      }
    }
    await page.waitForTimeout(600)
  }
}

/**
 * 关闭「跟随模式」：跟随中前端会自动点动作卡（会真的提交发布、并把 URL 改成 ?aiPublish=1），
 * 自检只验证"动作卡能打开发布弹窗"，所以涉及动作卡的步骤必须先关掉它。
 */
async function disableFollowMode(page) {
  const follow = page.locator('[data-testid=ai-assistant-sidebar] button[aria-label="跟随模式"]').first()
  if (await follow.count() === 0)
    return
  if ((await follow.getAttribute('aria-checked')) === 'true') {
    await follow.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1500)
  }
}

/**
 * 频道管理弹窗内的文案。页面上还有别的 role=dialog（账号页的接待规则表单就是隐藏的
 * role=dialog），所以必须用弹窗自己的 testid，不能用 [role=dialog] 取第一个。
 * @param page - 当前页面。
 * @returns 频道管理弹窗内的纯文本。
 */
const cmText = async page =>
  (await page.locator('[data-testid=channel-manager-dialog]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()

/**
 * 打开频道管理并停在「我的频道」（已经打开就复用；停在连接/授权页时先返回）。
 * @param page - 当前页面。
 * @returns 频道管理弹窗定位器。
 */
async function openChannelManager(page) {
  const dialog = page.locator('[data-testid=channel-manager-dialog]').first()
  const entry = page.locator('[data-testid=sidebar-account-entry]').first()
  // 关闭动画期间 isVisible() 仍然是 true：只看一次会把"正在关闭"当成"已经打开"，
  // 下一步点到隐藏按钮上就是 30 秒超时。每次先等动画落定再决定。
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await dialog.isVisible().catch(() => false)) {
      await page.waitForTimeout(700)
      if (await dialog.isVisible().catch(() => false))
        break
    }
    await entry.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(2500)
  }
  const back = page.locator('[data-testid=cm-connect-back-btn]').first()
  if (await back.count() > 0 && await back.isVisible().catch(() => false)) {
    await back.click()
    await page.waitForTimeout(2000)
  }
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  return dialog
}

/** 应用内通知卡片（NotificationCenter）：刷新粉丝数的反馈只走这里。 */
const NOTICE_CARD = 'div.fixed.top-4.right-4 [role=status]'

/** 等通知卡片自然消失（默认 3 秒自动关闭），避免上一步的卡片被当成本步反馈。 */
async function waitNoticesClear(page, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await page.locator(NOTICE_CARD).count() === 0)
      return
    await page.waitForTimeout(400)
  }
}

/**
 * 等一张匹配的应用内通知卡片出现并返回文案。
 * @param page - 当前页面。
 * @param pattern - 匹配通知文案的正则。
 * @param timeoutMs - 最长等待毫秒数。
 * @returns 命中的通知文案（压成单行）。
 */
async function waitForNotice(page, pattern, timeoutMs = 30000) {
  const started = Date.now()
  let seen = ''
  while (Date.now() - started < timeoutMs) {
    const texts = await page.locator(NOTICE_CARD).allInnerTexts().catch(() => [])
    seen = texts.join(' | ').replace(/\s+/g, ' ').trim()
    const hit = texts.map(item => item.replace(/\s+/g, ' ').trim()).find(item => pattern.test(item))
    if (hit)
      return hit
    await page.waitForTimeout(400)
  }
  throw new Error('没有等到匹配 ' + String(pattern) + ' 的通知（当前：' + (seen || '无通知') + '）')
}

/** 关掉所有弹层，回到干净页面。 */
async function resetPage(page, hash) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)
  // 同一 URL 的 goto 只会做同文档 hash 导航，SPA 的页内状态（如"素材库"页签）不会重置：
  // 加一个一次性参数强制真实重新加载。
  await page.goto(`${BASE}?planId=mg-persist&_r=${Date.now()}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
}

/**
 * 展开全局监控页的「引擎参数与 7×24 全自动接待」折叠面板。
 * antd Collapse 折叠时不挂载子节点，参数控件与全自动接待开关都不在 DOM 里；
 * 断言前必须先按用户操作展开，否则会用"控件不存在"误报产品缺陷。
 * @param page - 已导航到 #/monitor 的页面。
 */
async function expandEngineParamsPanel(page) {
  const header = page.locator('.ant-collapse-header', { hasText: '引擎参数与 7×24 全自动接待' }).first()
  if (await header.count() === 0) return
  const expanded = await header.getAttribute('aria-expanded')
  if (expanded === 'true') return
  await header.click()
  await page.waitForTimeout(1500)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', error => pageErrors.push(String(error).slice(0, 300)))
page.on('response', (response) => {
  if (!response.url().includes('/bosom-friend/api/'))
    return
  if (response.status() >= 400)
    apiFailures.push({ status: response.status(), method: response.request().method(), url: response.url().replace(BASE, '') })
})

/** 账号库快照：每一步之后都记一次，任何一步把账号删掉都能立刻定位。 */
const ACCOUNTS_FILE = join(homedir(), '.bosom-friend', 'bosom-friend', 'accounts.json')
function accountIds() {
  try {
    const parsed = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'))
    return (parsed.value ?? []).map(a => a.id).join(',')
  }
  catch {
    return '?'
  }
}

/** 内容库落库文件（信封 {schemaVersion, value:[...]}，value 里 kind 为 'asset' | 'draft'）。 */
const CONTENTS_FILE = join(homedir(), '.bosom-friend', 'bosom-friend', 'contents.json')

/**
 * 磁盘落库回读：contents.json 里的草稿条数。服务端 writeFileSync 期间的半截 JSON 会
 * 解析失败，重试三次仍失败返回 -1，由调用方判为落库异常。
 * @returns 草稿条数，读不出来时为 -1。
 */
function draftCountOnDisk() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = JSON.parse(readFileSync(CONTENTS_FILE, 'utf8'))
      return (parsed.value ?? []).filter(item => item.kind === 'draft').length
    }
    catch {
      // 半截文件重试；三次都失败说明落库文件不可读，交给调用方判失败。
    }
  }
  return -1
}

const step = async (id, name, fn) => {
  const layer = layerOf(id)
  if (!wanted(id))
    return
  if (WANT_LAYER !== 0 && layer !== WANT_LAYER)
    return
  if (stoppedAtLayer !== 0 && layer > stoppedAtLayer)
    return
  const before = accountIds()
  try {
    const detail = await fn()
    const after = accountIds()
    const lost = before !== after ? ` [账号库变化 ${before || '空'} -> ${after || '空'}]` : ''
    if (before !== after) {
      // 账号凭空消失是严重数据问题：把发生步骤持久化下来，便于定位。
      appendFileSync(join(OUT, 'account-changes.log'), `${new Date().toISOString()} ${id} ${name}: ${before || '空'} -> ${after || '空'}\n`, 'utf8')
    }
    record(id, name, true, (typeof detail === 'string' ? detail : '') + lost)
  }
  catch (error) {
    record(id, name, false, String(error?.message ?? error).slice(0, 220))
    await snap(page, `fail-${id}`)
  }
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await acceptDisclaimer(page)

  // ============ 账号管理 ============
  await step('A1', '频道管理打开且列出真实账号', async () => {
    const accounts = await listAccounts()
    if (accounts.length === 0)
      throw new Error('账号库为空：频道管理没有可验证的真实账号')
    await page.locator('[data-testid=sidebar-account-entry]').click()
    await page.waitForTimeout(3000)
    const dialog = page.locator('[role=dialog]', { hasText: '频道管理' }).first()
    await dialog.waitFor({ state: 'visible', timeout: 15000 })
    const body = (await dialog.innerText()).replace(/\s+/g, ' ')
    await snap(page, 'A1-channel-manager')
    if (!body.includes('我的频道'))
      throw new Error('没有「我的频道」区块')
    // 断言落到"每个落库账号都渲染成频道行"：只查 /抖音|小红书/ 时，频道行整体没渲染、
    // 只剩侧栏平台名也会判 PASS。
    for (const account of accounts) {
      const row = page.locator('[data-testid=cm-channel-item]:visible', { hasText: account.nickname })
      if (await row.count() === 0)
        throw new Error('没有渲染账号「' + account.nickname + '」的频道行（' + account.id + '）')
    }
    const rows = await page.locator('[data-testid=cm-channel-item]:visible').count()
    if (rows !== accounts.length)
      throw new Error('频道行 ' + rows + ' 行与账号库 ' + accounts.length + ' 个账号不一致')
    return rows + ' 行：' + accounts.map(a => a.nickname).join('/')
  })

  await step('A2', '刷新全部平台粉丝数给出真实反馈', async () => {
    const before = await listAccounts()
    await waitNoticesClear(page)
    const refresh = page.locator('[data-testid=cm-refresh-all-fans-btn]').first()
    await refresh.waitFor({ state: 'visible', timeout: 10000 })
    await refresh.click()
    // 刷新反馈走应用内通知（NotificationCenter 的 role=status 卡片），不是 sonner 提示：
    // 读频道管理弹窗文案时，点了没反应也会因为弹窗本来就有"刷新粉丝数"字样而 PASS。
    const notice = await waitForNotice(page, /粉丝数刷新完成|刷新间隔内|刷新间隔为 1 小时|刷新任务已提交|刷新失败|部分频道/, 30000)
    await snap(page, 'A2-refresh-fans')
    const after = await listAccounts()
    if (before.map(a => a.id).sort().join(',') !== after.map(a => a.id).sort().join(','))
      throw new Error('刷新粉丝数改动了账号库：' + before.length + ' -> ' + after.length)
    if (/刷新失败/.test(notice))
      throw new Error('刷新粉丝数报错：' + notice)
    if (/刷新完成/.test(notice)) {
      // "说刷新完成"必须有数据证据：analytics 会把 lastStatsTime 推到当前时刻。
      const advanced = after.filter(account => account.lastStatsTime !== before.find(item => item.id === account.id)?.lastStatsTime)
      if (advanced.length === 0)
        throw new Error('提示刷新完成，但没有任何账号的 lastStatsTime 前进：' + notice)
    }
    return notice
  })

  await step('A3', '新建分组 → 分组落库 → 删除分组', async () => {
    const name = '自检组' + Date.now().toString().slice(-5)
    const groupsBefore = await listGroups()
    await page.locator('[data-testid=cm-create-space-btn]').first().click()
    await page.waitForTimeout(1000)
    await page.locator('[data-testid=cm-create-space-input]').fill(name)
    await page.locator('[data-testid=cm-create-space-confirm]').click()
    await page.waitForTimeout(3500)
    let body = await cmText(page)
    if (!body.includes(name))
      throw new Error('新建的分组没出现：' + name)
    // 界面上出现不等于落库：分组接口必须真的有它，否则刷新一次就没了。
    const created = (await listGroups()).find(group => group.name === name)
    if (created === undefined)
      throw new Error('分组只出现在界面、没有落库：' + name)
    const space = page.locator('[data-testid=cm-space-item]', { hasText: name }).first()
    await space.locator('[data-testid=cm-space-more-menu]').click()
    await page.waitForTimeout(900)
    const delItem = page.locator('[role=menuitem]:has-text("删除"), button:has-text("删除分组")').first()
    if (await delItem.count() === 0)
      throw new Error('分组菜单里没有删除入口')
    await delItem.click()
    await page.waitForTimeout(900)
    const confirm = page.locator('[data-testid=cm-delete-confirm-btn]').first()
    if (await confirm.count() > 0)
      await confirm.click()
    await page.waitForTimeout(3000)
    body = await cmText(page)
    await snap(page, 'A3-groups')
    if (body.includes(name))
      throw new Error('删除后分组还在界面上：' + name)
    const groupsAfter = await listGroups()
    if (groupsAfter.some(group => group.id === created.id))
      throw new Error('删除后分组仍在落库里：' + created.id)
    if (!groupsAfter.some(group => group.isDefault))
      throw new Error('删除分组把默认分组一起删了')
    if (groupsAfter.length !== groupsBefore.length)
      throw new Error('分组数量没有回到初始值：' + groupsBefore.length + ' -> ' + groupsAfter.length)
    return name + ' 已落库并删除（分组回到 ' + groupsAfter.length + ' 个）'
  })

  await step('A5', '连接新频道入口可进可退', async () => {
    const connect = page.locator('[data-testid=cm-sidebar-connect-btn]').first()
    if (await connect.count() === 0)
      throw new Error('侧栏没有「连接新频道」入口')
    await connect.click()
    await page.waitForTimeout(2500)
    const list = page.locator('[data-testid=cm-connect-list]').first()
    await list.waitFor({ state: 'visible', timeout: 15000 })
    await snap(page, 'A5-connect-list')
    // 可连接平台列表必须真的渲染出卡片：用弹窗文案判 /小红书|抖音/ 时，
    // 侧栏平台名或标题就能满足，列表渲染成空壳也 PASS。
    const cards = page.locator('[data-testid=cm-connect-platform-card]:visible')
    const cardCount = await cards.count()
    // 白名单 = 引擎已落地的快手 / 视频号 + 已接登录适配器的闲鱼，与 CHANNEL_PLATFORMS 同源。
    const expectedPlatforms = ['小红书', '抖音', '快手', '视频号', '闲鱼']
    if (cardCount !== expectedPlatforms.length)
      throw new Error('可连接平台卡片 ' + cardCount + ' 个，期望 ' + expectedPlatforms.length + ' 个（' + expectedPlatforms.join('/') + '）')
    const cardText = (await cards.allInnerTexts()).join(' | ').replace(/\s+/g, ' ')
    for (const name of expectedPlatforms) {
      if (!cardText.includes(name))
        throw new Error('可连接平台卡片缺少' + name + '：' + cardText)
    }
    const back = page.locator('[data-testid=cm-connect-back-btn]').first()
    if (await back.count() === 0)
      throw new Error('连接页没有返回按钮')
    await back.click()
    await page.waitForTimeout(2000)
    const backText = await cmText(page)
    if (!backText.includes('我的频道'))
      throw new Error('返回后没有回到「我的频道」：' + backText.slice(0, 140))
    return cardCount + ' 个可连接平台：' + cardText
  })

  await step('A4', '账号页显示昵称/状态/粉丝', async () => {
    const accounts = await listAccounts()
    if (accounts.length === 0)
      throw new Error('账号库为空')
    await resetPage(page, '#/accounts')
    const body = await mainText(page)
    await snap(page, 'A4-accounts-page')
    if (!body.includes('我的账号'))
      throw new Error('账号页没有「我的账号」区块：' + body.slice(0, 140))
    // 用整页 body 时，"粉丝"两个字可能来自右侧 AI 面板或其它页面残留：
    // 断言必须对到落库账号的昵称、粉丝数与登录态徽标。
    for (const account of accounts) {
      if (!body.includes(account.nickname))
        throw new Error('账号页没有渲染账号昵称：' + account.nickname)
      if (typeof account.fansCount === 'number' && !body.includes(account.fansCount.toLocaleString()))
        throw new Error('账号页没有渲染「' + account.nickname + '」的粉丝数 ' + account.fansCount)
      const expected = account.loginState === 'invalid' ? '需重新登录' : '正常'
      if (!body.includes(expected))
        throw new Error('账号页状态徽标与 loginState=' + String(account.loginState) + ' 不一致，期望「' + expected + '」')
    }
    return accounts.map(a => a.nickname + '/' + a.fansCount + '粉').join(' ')
  })

  // ============ 内容创作 ============
  await step('B1', '目标平台与「添加频道」白名单一致', async () => {
    await resetPage(page, '#/draft-box')
    const trigger = page.locator('button', { hasText: /个平台/ }).first()
    await trigger.waitFor({ state: 'visible', timeout: 20000 })
    const label = (await trigger.textContent()) ?? ''
    await trigger.click()
    await page.waitForTimeout(1200)
    const dialog = page.locator('[role=dialog]', { hasText: '目标平台' }).first()
    const list = (await dialog.innerText()).replace('目标平台', '').replace('取消全选', '').split(/\s+/).filter(Boolean)
    await snap(page, 'B1-target-platforms')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    // 白名单是配置项，会随新增平台变化；这里必须比对当前白名单，不能写死平台名——
    // 否则每加一个平台都会产生一条假红（2026-09-11 加入快手/视频号后即出现）。
    const allowed = await (await fetch(BASE + 'api/v2/channels/platforms')).json()
    const allowedNames = (allowed.data ?? [])
      .filter(p => p.capabilities?.publish?.supported === true && p.capabilities?.auth?.supported === true)
      .map(p => p.displayName?.['zh-CN'] ?? p.platform)
    // 正确语义：创作页出现的平台必须都是目录里真实可发布的正规平台。
    // 不能用 every 要求目录里的平台全部出现——目录声明 11 个可发布平台，
    // 而产品实际只接入 4~5 个（支付宝生活号/TikTok/微博等尚未接入），
    // 那样写会在每次目录扩充时假红；也不能只判长度，那样等于把平台名写死。
    if (list.length === 0)
      throw new Error('创作页没有可选的目标平台')
    const unknown = list.filter(name => !allowedNames.includes(name))
    if (unknown.length > 0)
      throw new Error('创作页出现目录外平台：' + unknown.join('/') + '（目录=' + allowedNames.join('/') + '）')
    return label.trim() + ' -> ' + list.join('/')
  })

  await step('B2', 'AI 生成草稿并出现在列表', async () => {
    const prompt = '写一条抖音口播短视频文案：重庆山城夜景打卡，30 秒内，标题不超过 20 字。'
    // 基线：本次点击前已有的生成任务与草稿 id。原断言只匹配页面上的 /山城|夜景|重庆/，
    // 而提示词本身就含这些字，生成根本没跑完也会 PASS，后续 B5/B13/B15 随即扑空。
    const genIdsBefore = new Set((await listGenerations()).map(item => item.id))
    const draftsBefore = await listDrafts()
    const draftIdsBefore = new Set((draftsBefore.list ?? []).map(item => item._id))
    const draftsOnDiskBefore = draftCountOnDisk()
    const box = page.locator('[data-testid=draftbox-ai-prompt-input]').first()
    await box.click()
    await box.fill(prompt)
    await page.locator('[data-testid=draftbox-ai-submit-btn]').click()
    // 以落库为准等待「这一次」的任务跑完：视频素材链路实测 55s–250s（编排层给同一条
    // 链路的等待上限是 360s），所以按 5s × 72 轮 = 360s 轮询，任务一进终态立即继续。
    let task = null
    let waited = 0
    for (let i = 0; i < 72; i++) {
      await page.waitForTimeout(5000)
      waited += 5
      const fresh = (await listGenerations()).filter(item => !genIdsBefore.has(item.id))
      const mine = fresh.find(item => String(item.request?.prompt ?? '').includes('山城夜景'))
      if (i % 12 === 0)
        console.log('  [B2 poll ' + waited + 's] 新任务 ' + fresh.length + ' 个，本次任务 status=' + (mine?.status ?? '-'))
      if (mine !== undefined && mine.status !== 'generating') {
        task = mine
        break
      }
    }
    await snap(page, 'B2-ai-draft')
    if (task === null)
      throw new Error('等待 ' + waited + ' 秒，ai/draft-generation 没有出现本次提交的任务或它仍未跑完')
    if (task.status !== 'success')
      throw new Error('生成任务 ' + task.id + ' 未成功：status=' + task.status + ' error=' + String(task.errorMessage ?? '').slice(0, 120))
    const draftsAfter = await listDrafts()
    const freshDrafts = (draftsAfter.list ?? []).filter(item => !draftIdsBefore.has(item._id))
    const bound = freshDrafts.find(item => item.metadata?.generationId === task.id)
    if ((draftsAfter.total ?? 0) <= (draftsBefore.total ?? 0) || bound === undefined)
      throw new Error('生成任务 ' + task.id + ' 已成功但没有落库草稿：contents/drafts total ' + (draftsBefore.total ?? 0) + ' -> ' + (draftsAfter.total ?? 0) + '，新增 ' + freshDrafts.length + ' 条')
    const draftsOnDiskAfter = draftCountOnDisk()
    if (draftsOnDiskAfter < 0)
      throw new Error('contents.json 落库文件读取失败（' + CONTENTS_FILE + '）')
    if (draftsOnDiskAfter <= draftsOnDiskBefore)
      throw new Error('磁盘 contents.json 的草稿数没有变化：' + draftsOnDiskBefore + ' -> ' + draftsOnDiskAfter)
    return '生成任务 ' + task.id + ' status=success；草稿 ' + bound._id + ' 已落库（接口 total ' + draftsAfter.total + '，磁盘 ' + draftsOnDiskBefore + ' -> ' + draftsOnDiskAfter + '）'
  })

  await step('B3', '素材库页签可用', async () => {
    await page.locator('button:has-text("素材库")').first().click()
    await page.waitForTimeout(4000)
    const body = await text(page)
    await snap(page, 'B3-material-library')
    if (!/素材|分组/.test(body))
      throw new Error('素材库没有内容')
    return body.slice(0, 120)
  })

  await step('B4', '工具栏一键发布打开发布弹窗', async () => {
    await resetPage(page, '#/draft-box')
    const publishBtn = page.locator('button:has-text("一键发布")').first()
    await publishBtn.waitFor({ state: 'visible', timeout: 60000 })
    await publishBtn.click()
    await page.waitForTimeout(8000)
    const dialog = page.locator('[data-testid=publish-dialog-container]').first()
    if (await dialog.count() === 0)
      throw new Error('发布弹窗没打开')
    const info = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=publish-dialog-container]')
      return {
        accounts: d.querySelectorAll('[data-testid^="publish-account-item-"]').length,
        editor: !!d.querySelector('[data-testid=publish-content-editor]'),
        submit: !!d.querySelector('[data-testid=publish-submit-btn]'),
        text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      }
    })
    await snap(page, 'B4-publish-dialog')
    if (!info.editor || !info.submit)
      throw new Error('弹窗缺少编辑器或发布按钮：' + JSON.stringify(info))
    return JSON.stringify(info).slice(0, 200)
  })

  await step('B7', '提示词编辑器与重置配置可用', async () => {
    await resetPage(page, '#/draft-box')
    const editor = page.locator('[data-testid=draftbox-ai-open-prompt-editor-btn]').first()
    if (await editor.count() === 0)
      throw new Error('没有「打开提示词编辑器」按钮')
    const dialogInput = page.locator('[data-testid=draftbox-ai-prompt-dialog-input]').first()
    // 可证伪：PromptEditorDialog 关闭时返回 null，弹窗没打开就查不到这个输入区。
    // 原断言 /提示词|编辑器|模板/ 由输入区占位文案满足，弹窗没开也能 PASS。
    if (await dialogInput.count() !== 0)
      throw new Error('未点开提示词编辑器时弹窗输入区已存在')
    await editor.click()
    await page.waitForTimeout(2500)
    const opened = await text(page)
    await snap(page, 'B7-prompt-editor')
    await dialogInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
      throw new Error('提示词编辑器没打开：' + opened.slice(0, 140))
    })
    // 真实写回：在编辑区打字 → 保存 → 组合框必须回读到这段文字（链路没写通就失败）。
    const marker = 'QA-B7-EDITOR-' + Date.now().toString().slice(-6)
    await dialogInput.click()
    await dialogInput.pressSequentially(marker, { delay: 20 })
    await page.waitForTimeout(500)
    const typed = (await dialogInput.innerText()).replace(/\s+/g, '')
    if (!typed.includes(marker))
      throw new Error('编辑器输入区没有接收这段文字：' + typed.slice(-40))
    await page.locator('[role=dialog] button:has-text("保存")').last().click({ timeout: 10000 })
    await page.waitForTimeout(2000)
    if (await dialogInput.count() !== 0)
      throw new Error('保存后编辑器弹窗没有关闭')
    const composerAfterSave = (await page.locator('[data-testid=draftbox-ai-prompt-input]').first().innerText()).replace(/\s+/g, '')
    if (!composerAfterSave.includes(marker))
      throw new Error('保存后组合框没有回读编辑器内容：' + composerAfterSave.slice(0, 80))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    const reset = page.locator('[data-testid=draftbox-ai-reset-btn]').first()
    if (await reset.count() === 0)
      throw new Error('没有「重置配置」按钮')
    await reset.click()
    await page.waitForTimeout(1500)
    const composerAfterReset = (await page.locator('[data-testid=draftbox-ai-prompt-input]').first().innerText()).replace(/\s+/g, '')
    if (composerAfterReset.includes(marker))
      throw new Error('重置配置没有清掉刚写入的提示词')
    return '编辑器写入回读并重置清空：' + marker
  })

  await step('B8', '草稿列表批量模式可进可退', async () => {
    await resetPage(page, '#/draft-box')
    await page.waitForTimeout(3000)
    // 批量入口已合并为单个「批量管理」按钮（原来「批量移动」「批量移除」同绑一个动作）。
    const batch = page.locator('[data-testid=draftbox-batch-mode-btn], button:has-text("批量管理")').first()
    if (await batch.count() === 0)
      throw new Error('素材库没有批量操作入口')
    // 可证伪：批量模式必须真实挂上卡片选择框（Radix Checkbox = [role=checkbox]，
    // 非批量模式一个都没有），退出后必须全部卸载。原断言 /批量|选中|取消/ 由被点的
    // 「批量管理」按钮自身文案满足，批量模式没进去也 PASS。
    const selectionBoxes = async () => await page.locator('#main-content [role=checkbox]').count()
    const boxesBefore = await selectionBoxes()
    await batch.click()
    await page.waitForTimeout(2500)
    const boxesInBatch = await selectionBoxes()
    const body = await text(page)
    await snap(page, 'B8-material-batch')
    if (boxesInBatch <= boxesBefore)
      throw new Error('进入批量模式后选择框没有增加：' + boxesBefore + ' -> ' + boxesInBatch)
    const cancel = page.getByRole('button', { name: '取消', exact: true }).last()
    if (await cancel.count() === 0)
      throw new Error('批量模式没有退出（取消）按钮：' + body.slice(0, 140))
    await cancel.click({ timeout: 10000 })
    await page.waitForTimeout(2000)
    const boxesAfterExit = await selectionBoxes()
    if (boxesAfterExit !== boxesBefore)
      throw new Error('退出批量模式后选择框没有回到原状态：' + boxesBefore + ' -> ' + boxesInBatch + ' -> ' + boxesAfterExit)
    return '批量选择框 ' + boxesBefore + ' -> ' + boxesInBatch + ' -> ' + boxesAfterExit
  })

  await step('B5', '草稿卡片 → 详情 → 发布预填', async () => {
    await closePublishDialog(page)
    await resetPage(page, '#/draft-box')
    // 「全部」页签混排生成中任务与素材卡片；「草稿」页签才是真正的草稿卡片
    // （data-testid=draftbox-draft-card），点开是详情弹框，里面有发布入口。
    const draftTab = page.locator('button').filter({ hasText: /^草稿/ }).first()
    if (await draftTab.count() === 0)
      throw new Error('找不到「草稿」页签')
    await draftTab.click()
    await page.waitForTimeout(4000)
    const card = page.locator('[data-testid=draftbox-draft-card]').first()
    if (await card.count() === 0)
      throw new Error('草稿页签里没有草稿卡片')
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await card.click({ timeout: 15000 })
    await page.waitForTimeout(3500)
    const detail = page.locator('[data-testid=draftbox-detail-dialog]').first()
    if (await detail.count() === 0)
      throw new Error('草稿详情没打开')
    await snap(page, 'B5-draft-detail')
    const publishBtn = page.locator('[data-testid=draftbox-detail-publish-btn]').first()
    if (await publishBtn.count() === 0)
      throw new Error('详情里没有发布按钮')
    await publishBtn.click()
    await page.waitForTimeout(8000)
    const info = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=publish-dialog-container]')
      if (!d) return { none: true }
      const editor = d.querySelector('[data-testid=publish-content-editor]')
      return {
        editorText: (editor?.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
        title: [...d.querySelectorAll('input')].map(i => i.value).filter(Boolean)[0] ?? '',
        videos: d.querySelectorAll('video').length,
        problem: (d.innerText || '').includes('请上传图片或视频') ? '请上传图片或视频' : '',
        accounts: d.querySelectorAll('[data-testid^="publish-account-item-"]').length,
      }
    })
    await snap(page, 'B5-draft-publish')
    if (info.none)
      throw new Error('发布弹窗没打开')
    if (!info.editorText && !info.title && info.videos === 0)
      throw new Error('弹窗没有预填草稿内容：' + JSON.stringify(info))
    return JSON.stringify(info).slice(0, 220)
  })

  if (REAL_PUBLISH) {
    await step('B6', '真实提交发布并拿到任务反馈', async () => {
      const submit = page.locator('[data-testid=publish-submit-btn]').first()
      if (await submit.count() === 0)
        throw new Error('没有发布按钮')
      await submit.click()
      await page.waitForTimeout(20000)
      const body = await text(page)
      await snap(page, 'B6-published')
      if (!/已提交|发布中|发布成功|任务|成功/.test(body))
        throw new Error('提交后没有反馈：' + body.slice(-160))
      return body.slice(-160)
    })
  }


  // ============ 内容创作：编辑/删除/预览/排期等未覆盖项 ============
  await step('B9', '参数限制弹层', async () => {
    await resetPage(page, '#/draft-box')
    // 「参数限制」是图标按钮，可访问名来自 tooltip，has-text 匹配不到。
    const trigger = page.getByRole('button', { name: /参数限制/ }).first()
    await trigger.waitFor({ state: 'visible', timeout: 20000 })
    // 可证伪：Radix Popover 关闭时不挂载内容，弹层没打开就查不到这个节点。原断言
    // /标题|正文|话题|字数|数量/ 由创作页输入区文案满足，弹层没开也能 PASS。
    const limitsLayer = page.locator('[data-radix-popper-content-wrapper]').filter({ hasText: /标题上限|描述上限/ })
    if (await limitsLayer.count() !== 0)
      throw new Error('点击前参数限制弹层已存在')
    await trigger.click({ timeout: 15000 })
    await page.waitForTimeout(1500)
    const body = await text(page)
    await snap(page, 'B9-param-limits')
    await limitsLayer.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      throw new Error('参数限制弹层没打开：' + body.slice(0, 140))
    })
    const limits = (await limitsLayer.first().innerText()).replace(/\s+/g, ' ')
    for (const row of ['标题上限', '描述上限', '话题上限', '图片上限']) {
      if (!limits.includes(row))
        throw new Error('参数限制弹层缺少「' + row + '」行：' + limits.slice(0, 140))
    }
    if (!/\d/.test(limits) && !/无限制/.test(limits))
      throw new Error('参数限制弹层没有任何限制值：' + limits.slice(0, 140))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    if (await limitsLayer.count() !== 0)
      throw new Error('Escape 后参数限制弹层没有关闭')
    return limits.slice(0, 120)
  })

  await step('B10', '文案要求入口', async () => {
    // 可证伪：点「文案要求」必须真实挂载/卸载 CaptionPromptField 那一行表单控件（该行
    // 只在 isDraftMode && moreOptionsOpen 时渲染）。原断言 /文案|语气|字数|要求/ 由被点
    // 按钮自身文案满足，弹层没开也能 PASS。
    const captionFieldCount = async () => await page
      .locator('#main-content input:visible, #main-content textarea:visible')
      .evaluateAll(nodes => nodes.filter(node => (node.parentElement?.innerText ?? '').includes('提示词')).length)
    const trigger = page.locator('button:has-text("文案要求")').first()
    if (await trigger.count() === 0)
      throw new Error('创作页没有「文案要求」入口')
    const fieldBefore = await captionFieldCount()
    await trigger.click()
    await page.waitForTimeout(1500)
    const fieldAfter = await captionFieldCount()
    const body = await text(page)
    await snap(page, 'B10-caption-requirement')
    if (fieldBefore === fieldAfter)
      throw new Error('点「文案要求」没有挂载/卸载文案要求表单行（前后都是 ' + fieldBefore + ' 个控件）')
    await trigger.click()
    await page.waitForTimeout(1500)
    const fieldRestored = await captionFieldCount()
    if (fieldRestored !== fieldBefore)
      throw new Error('再点一次「文案要求」没有回到原状态：' + fieldBefore + ' -> ' + fieldAfter + ' -> ' + fieldRestored)
    await page.keyboard.press('Escape')
    return '文案要求表单行 ' + fieldBefore + ' -> ' + fieldAfter + ' -> ' + fieldRestored
  })

  await step('B11', '本地素材上传（先切到支持参考素材的模型）', async () => {
    // 用户视频模型是纯文生视频时上传按钮是禁用态（带原因提示）；切到内置 multi-ref 模型再验真实上传。
    await page.locator('[data-testid=draftbox-ai-model]').first().click()
    await page.waitForTimeout(1500)
    const popoverButtons = page.locator('[data-radix-popper-content-wrapper] button')
    const count = await popoverButtons.count()
    if (count === 0)
      throw new Error('模型选择弹层没打开')
    let switched = false
    for (let i = 0; i < count; i++) {
      const text = ((await popoverButtons.nth(i).innerText()) || '').replace(/\s+/g, ' ')
      if (/模板|Bosom Friend视频|multi/i.test(text) && !/单选|多选|已选/.test(text)) {
        await popoverButtons.nth(i).click()
        switched = true
        break
      }
    }
    await page.waitForTimeout(2500)
    if (!switched)
      await page.keyboard.press('Escape')

    const addBtn = page.locator('[data-testid=draftbox-ai-add-media-btn]').first()
    if (await addBtn.count() === 0)
      throw new Error('素材堆栈没有上传按钮')
    const disabled = await addBtn.isDisabled()
    const title = (await addBtn.getAttribute('title')) ?? ''
    await snap(page, 'B11-local-upload')
    if (disabled)
      throw new Error('切换模型后上传按钮仍是禁用态（模型未切成功）；提示：' + title.slice(0, 60))
    const input = page.locator('[data-testid=draftbox-ai-image-stack] input[type=file]').first()
    if (await input.count() === 0)
      throw new Error('上传按钮可用但找不到文件输入')
    await input.setInputFiles('C:/Users/Jay/AppData/Local/Temp/upload-probe.png')
    await page.waitForTimeout(7000)
    const state = await page.evaluate(() => {
      const stack = document.querySelector('[data-testid=draftbox-ai-image-stack]')
      return { imgs: stack ? stack.querySelectorAll('img').length : -1 }
    })
    if (state.imgs <= 0)
      throw new Error('上传后素材堆栈没有出现缩略图')
    return '已切换模型并上传成功（堆栈缩略图 ' + state.imgs + ' 张）'
  })

  await step('B18', '纯文生视频模型下上传按钮禁用且给出原因', async () => {
    await resetPage(page, '#/draft-box')
    const addBtn = page.locator('[data-testid=draftbox-ai-add-media-btn]').first()
    if (await addBtn.count() === 0)
      throw new Error('素材堆栈没有上传按钮')
    const disabled = await addBtn.isDisabled()
    const title = (await addBtn.getAttribute('title')) ?? ''
    const aria = (await addBtn.getAttribute('aria-label')) ?? ''
    await snap(page, 'B18-upload-unsupported')
    if (!disabled)
      return '当前模型支持参考素材，按钮可用（跳过禁用态断言）'
    if (title === '' && aria === '')
      throw new Error('按钮被禁用但没有任何原因说明')
    return '禁用并说明原因：' + (title || aria).slice(0, 60)
  })

  await step('B12', '生成记录弹窗', async () => {
    await resetPage(page, '#/draft-box')
    // 可证伪：GenerationDetailDialog 关闭时返回 null，弹窗没打开就查不到这个节点；
    // 打开后内容还必须与 ai/draft-generation 落库数据对得上。原断言
    // /生成|记录|时间|状态/ 由被点的「生成记录」按钮自身文案满足。
    const dialog = page.locator('[data-testid=draftbox-generation-detail-dialog]').first()
    if (await dialog.count() !== 0)
      throw new Error('点击前生成记录弹窗已存在')
    // 「生成记录」在页面里有隐藏副本（弹层内），必须取可见的那个。
    await page.locator('button:has-text("生成记录"):visible').first().click({ timeout: 15000 })
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'B12-generation-records')
    await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
      throw new Error('生成记录弹窗没打开：' + body.slice(0, 140))
    })
    const matched = await assertGenerationDialogMatchesApi(dialog)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    if (await dialog.count() !== 0)
      throw new Error('Escape 后生成记录弹窗没有关闭')
    return matched
  })

  await step('B13', '草稿详情编辑入口 + 删除确认可取消', async () => {
    await resetPage(page, '#/draft-box')
    const draftTab = page.locator('button').filter({ hasText: /^草稿/ }).first()
    await draftTab.click()
    await page.waitForTimeout(3500)
    const card = page.locator('[data-testid=draftbox-draft-card]').first()
    if (await card.count() === 0)
      throw new Error('草稿页签没有草稿卡片')
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await card.click({ timeout: 15000 })
    await page.waitForTimeout(3000)
    const edit = page.locator('[data-testid=draftbox-detail-edit-btn]').first()
    if (await edit.count() === 0)
      throw new Error('草稿详情没有编辑按钮')
    await edit.click()
    await page.waitForTimeout(2500)
    const editing = await text(page)
    await snap(page, 'B13-draft-edit')
    if (!/编辑|标题|正文|保存/.test(editing))
      throw new Error('编辑弹窗没有内容：' + editing.slice(0, 140))
    // 编辑弹窗有取消按钮时用它关闭；Escape 会连带关掉草稿详情，导致后面找不到删除按钮。
    const cancelEdit = page.locator('button:has-text("取消"):visible').last()
    if (await cancelEdit.count() > 0)
      await cancelEdit.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1800)
    if (await page.locator('[data-testid=draftbox-detail-dialog]').count() === 0) {
      await card.click({ timeout: 15000 })
      await page.waitForTimeout(3000)
    }
    const del = page.locator('[data-testid=draftbox-detail-delete-btn]').first()
    if (await del.count() === 0)
      throw new Error('草稿详情没有删除按钮')
    await del.click()
    await page.waitForTimeout(1500)
    const confirmText = await text(page)
    await snap(page, 'B13-draft-delete-confirm')
    if (!/删除|确定|取消/.test(confirmText))
      throw new Error('删除没有二次确认')
    const cancel = page.locator('button:has-text("取消")').last()
    if (await cancel.count() > 0)
      await cancel.click().catch(() => {})
    await page.waitForTimeout(1200)
    await page.keyboard.press('Escape')
    return '编辑入口 + 删除二次确认（已取消）'
  })

  await step('B14', '生成中任务卡打开生成详情', async () => {
    const card = page.locator('[data-testid=draftbox-generating-task-card]').first()
    if (await card.count() === 0)
      return '当前没有生成中任务卡（跳过）'
    // 可证伪：详情弹窗未打开时不存在；打开后必须渲染 ai/draft-generation 的落库任务。
    // 原断言 /生成|进度|状态/ 由任务卡自身的「正在生成内容」文案满足。
    const dialog = page.locator('[data-testid=draftbox-generation-detail-dialog]').first()
    if (await dialog.count() !== 0) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1500)
      if (await dialog.count() !== 0)
        throw new Error('点击任务卡前生成详情弹窗已打开且 Escape 关不掉')
    }
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await card.click({ timeout: 12000 })
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'B14-generation-detail')
    await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
      throw new Error('生成详情没打开：' + body.slice(0, 140))
    })
    const matched = await assertGenerationDialogMatchesApi(dialog)
    await page.keyboard.press('Escape')
    return matched
  })

  await step('B15', '素材预览可打开可关闭', async () => {
    await resetPage(page, '#/draft-box')
    await page.locator('button:has-text("素材库")').first().click()
    await page.waitForTimeout(4000)
    const media = page.locator('img[src*="api/assets/file/"]').first()
    if (await media.count() === 0)
      throw new Error('素材库没有素材')
    await media.scrollIntoViewIfNeeded().catch(() => {})
    await media.click({ timeout: 12000 })
    await page.waitForTimeout(2500)
    // 预览是灯箱：底部出现「1 / N」计数，不是 role=dialog。
    const tail = await text(page)
    const opened = /\d+\s*\/\s*\d+/.test(tail.slice(-200))
    await snap(page, 'B15-media-preview')
    if (!opened)
      throw new Error('点素材没有打开预览（未见 1 / N 计数）')
    await page.keyboard.press('Escape')
    return '预览灯箱已打开'
  })

  await step('B16', '发布日历可创建排期并取消', async () => {
    await resetPage(page, '#/calendar')
    const day = page.locator('[data-testid=calendar-week-view] button').first()
    await day.click()
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'B16-schedule-create')
    if (!/发布|排期|时间|新建|创建/.test(body))
      throw new Error('点日期后没有创建排期入口：' + body.slice(0, 140))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1000)
    return body.slice(0, 120)
  })

  await step('B17', '数据中心作品排行渲染', async () => {
    await resetPage(page, '#/data-statistics')
    await page.locator('[data-testid=data-statistics-query]').first().click()
    await page.waitForTimeout(6000)
    const body = await text(page)
    await snap(page, 'B17-datacenter-ranking')
    // 有数据时看排行/贡献；登录态失效导致同步为空时，页面应给"还没有发布过作品"空态而不是空白。
    if (/作品排行|平台贡献|增长趋势/.test(body))
      return '有数据：' + body.slice(0, 120)
    if (/还没有发布过作品|去发布内容/.test(body))
      return '空态（无作品数据，符合当前账号登录失效状态）'
    throw new Error('数据中心既没有排行区也没有空态：' + body.slice(0, 140))
  })

  // ============ 账号管理：资料 / 行操作 / 授权 / 分组 / 登录态 / 删除 ============
  await step('A6', '账号资料完整性（昵称/头像/粉丝/作品）', async () => {
    const list = await listAccounts()
    if (list.length === 0)
      throw new Error('账号库为空')
    const bad = list.filter(a => !a.nickname || a.fansCount === undefined || a.avatar === undefined || a.workCount === undefined)
    if (bad.length > 0)
      throw new Error('账号资料缺失：' + JSON.stringify(bad.map(a => a.id)))
    return list.map(a => a.nickname + '/' + a.fansCount + '粉/' + a.workCount + '作品').join(' ')
  })

  await step('A7', '频道行操作按钮与账号登录态一致', async () => {
    const accounts = await listAccounts()
    if (accounts.length === 0)
      throw new Error('账号库为空')
    await resetPage(page, '#/accounts')
    await page.locator('[data-testid=sidebar-account-entry]').click()
    await page.waitForTimeout(3000)
    // 在线账号显示「刷新粉丝数」；离线/需重新登录的账号显示「重新授权」；两者都有退出与删除。
    const has = async id => await page.locator('[data-testid=' + id + ']:visible').count() > 0
    const refresh = await has('cm-channel-refresh-fans-btn')
    const reauth = await has('cm-channel-reauth-btn')
    const logout = await has('cm-channel-logout-btn')
    const del = await has('cm-channel-delete-btn')
    await snap(page, 'A7-channel-actions')
    await page.keyboard.press('Escape')
    if (!logout || !del)
      throw new Error('缺少退出/删除按钮：logout=' + logout + ' delete=' + del)
    // 行内按钮必须跟账号真实登录态一致：只判"有刷新或有重新授权"时，
    // 失效账号显示刷新按钮（点了必然失败）也会 PASS。
    const offline = accounts.some(account => account.loginState === 'invalid' || account.status !== 1)
    if (offline && !reauth)
      throw new Error('账号库有失效账号，频道行却没有「重新授权」入口')
    if (!offline && !refresh)
      throw new Error('账号在线却没有「刷新粉丝数」入口（平台没声明 analytics.account？）')
    return '刷新=' + refresh + ' 重新授权=' + reauth + ' 退出=' + logout + ' 删除=' + del
  })

  await step('A8', '授权页可取消且不产生账号', async () => {
    const before = (await listAccounts()).map(account => account.id).sort().join(',')
    await openChannelManager(page)
    await page.locator('[data-testid=cm-sidebar-connect-btn]').first().click()
    await page.waitForTimeout(2500)
    const card = page.locator('[data-testid=cm-connect-platform-card]').first()
    if (await card.count() === 0)
      throw new Error('连接页没有平台卡片')
    await card.click()
    await page.waitForTimeout(4000)
    const body = await text(page)
    await snap(page, 'A8-auth-page')
    const cancel = page.locator('[data-testid=cm-auth-cancel-btn]').first()
    if (await cancel.count() === 0)
      throw new Error('授权页没有取消按钮：' + body.slice(0, 120))
    await cancel.click()
    await page.waitForTimeout(3000)
    // 取消 = 停止授权并退回「连接新频道」列表（handleCancel → setCurrentView('connect-list')），
    // 弹窗本身要留着，用户才能改选另一个平台。
    const back = await cmText(page)
    if (!/我的频道|可连接的平台|连接新频道/.test(back))
      throw new Error('取消后没有回到频道管理：' + back.slice(0, 120))
    await page.keyboard.press('Escape')
    const after = (await listAccounts()).map(account => account.id).sort().join(',')
    if (before !== after)
      throw new Error('取消授权却改动了账号库：' + before + ' -> ' + after)
    return '授权页已取消并返回，账号库未变'
  })

  await step('A9', '账号分组重命名与排序（界面操作 + 落库回读）', async () => {
    const stamp = Date.now().toString().slice(-5)
    await openChannelManager(page)
    const firstName = '自检改名前' + stamp
    const renamedTo = '自检改名后' + stamp
    const sortName = '自检排序组' + stamp
    const createdIds = []
    try {
      for (const name of [firstName, sortName]) {
        await page.locator('[data-testid=cm-create-space-btn]').first().click()
        await page.waitForTimeout(900)
        await page.locator('[data-testid=cm-create-space-input]').fill(name)
        await page.locator('[data-testid=cm-create-space-confirm]').click()
        await page.waitForTimeout(2500)
      }
      const groups = await listGroups()
      for (const name of [firstName, sortName]) {
        const group = groups.find(item => item.name === name)
        if (group === undefined)
          throw new Error('分组没有落库：' + name)
        createdIds.push(group.id)
      }
      // 改名：分组菜单 → 编辑 → 输入新名字 → 保存
      const space = page.locator('[data-testid=cm-space-item]', { hasText: firstName }).first()
      await space.locator('[data-testid=cm-space-more-menu]').click()
      await page.waitForTimeout(800)
      await page.locator('[role=menuitem]:has-text("编辑")').first().click()
      await page.waitForTimeout(800)
      const input = page.locator('[data-testid=cm-space-edit-input]').first()
      await input.waitFor({ state: 'visible', timeout: 8000 })
      // 保存按钮必须按"含编辑输入框的那个分组"定位：改名后分组文案已经变了，
      // 用 hasText:旧名字 的定位器在 fill 之后就再也匹配不上（点击 30 秒超时）。
      const editForm = page.locator('[data-testid=cm-space-item]')
        .filter({ has: page.locator('[data-testid=cm-space-edit-input]') })
        .first()
      const saveButton = editForm.getByRole('button', { name: '保存', exact: true }).first()
      await input.fill(renamedTo)
      await saveButton.click()
      await page.waitForTimeout(3000)
      const renamed = (await listGroups()).find(item => item.id === createdIds[0])
      if (renamed === undefined || renamed.name !== renamedTo)
        throw new Error('改名没有落库：' + JSON.stringify(renamed))
      // 排序：把排序组上移一格，落库 rank 顺序必须真的变
      const order = groups => groups.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map(item => item.id)
      const beforeSort = order(await listGroups())
      const sortSpace = page.locator('[data-testid=cm-space-item]', { hasText: sortName }).first()
      await sortSpace.locator('[data-testid=cm-space-more-menu]').click()
      await page.waitForTimeout(800)
      await page.locator('[role=menuitem]:has-text("上移")').first().click()
      await page.waitForTimeout(3500)
      const afterSort = order(await listGroups())
      const from = beforeSort.indexOf(createdIds[1])
      const to = afterSort.indexOf(createdIds[1])
      if (to !== from - 1)
        throw new Error('上移没有改变落库顺序：位次 ' + from + ' -> ' + to + '（' + afterSort.join(',') + '）')
      return '改名 ' + firstName + '→' + renamedTo + '，排序位次 ' + from + '→' + to
    }
    finally {
      for (const id of createdIds)
        await fetch(BASE + 'api/v2/channels/account-groups?ids=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {})
    }
  })

  await step('A10', '同一平台重复刷新粉丝数被 1 小时限频拦下', async () => {
    await openChannelManager(page)
    const single = page.locator('[data-testid=cm-channel-refresh-fans-btn]').first()
    if (await single.count() === 0)
      throw new Error('在线账号没有单账号「刷新粉丝」按钮')
    await waitNoticesClear(page)
    const pattern = /粉丝数刷新完成|刷新间隔内|刷新间隔为 1 小时|刷新任务已提交|刷新失败/
    await single.click()
    const first = await waitForNotice(page, pattern, 30000)
    await waitNoticesClear(page)
    // 第二次刷新同一平台：必须命中冷却，且不能再打一次平台接口。
    const analytics = []
    const listener = response => { if (response.url().includes('/analytics')) analytics.push(response.url()) }
    page.on('response', listener)
    await single.click()
    const second = await waitForNotice(page, /刷新间隔|粉丝数刷新完成|刷新失败/, 20000)
    await page.waitForTimeout(2500)
    page.off('response', listener)
    await snap(page, 'A10-refresh-cooldown')
    if (/刷新失败/.test(first) || /刷新失败/.test(second))
      throw new Error('刷新粉丝数报错：' + first + ' / ' + second)
    if (!/刷新间隔/.test(second))
      throw new Error('同一平台 1 小时内二次刷新没有被限频：' + second)
    if (analytics.length > 0)
      throw new Error('冷却窗口内仍然打了一次平台数据：' + analytics[0].replace(BASE, ''))
    return '首次：' + first + '；二次：' + second
  })

  await step('A11', '登录态失效在账号页与频道行都显示「需重新登录」', async () => {
    const accounts = await listAccounts()
    if (accounts.length === 0)
      throw new Error('账号库为空')
    // 用响应改写模拟"平台判定登录失效"：不改真实账号数据，只验界面是否如实显示。
    const matcher = url => /\/api\/v2\/channels\/accounts$/.test(url.pathname)
    const handler = async (route) => {
      const response = await route.fetch()
      const envelope = await response.json().catch(() => null)
      if (Array.isArray(envelope?.data?.list)) {
        envelope.data.list = envelope.data.list.map(account => ({
          ...account,
          loginState: 'invalid',
          loginNote: '自检：平台判定该账号登录已失效',
        }))
      }
      await route.fulfill({ response, json: envelope })
    }
    await page.route(matcher, handler)
    try {
      await resetPage(page, '#/accounts')
      const body = await mainText(page)
      await snap(page, 'A11-accounts-invalid')
      if (!body.includes('需重新登录'))
        throw new Error('账号页在 loginState=invalid 时没有显示「需重新登录」：' + body.slice(0, 160))
      await page.locator('[data-testid=sidebar-account-entry]').click()
      await page.waitForTimeout(3500)
      const status = (await page.locator('[data-testid=cm-channel-status]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
      await snap(page, 'A11-channel-invalid')
      if (!status.includes('需重新登录'))
        throw new Error('频道行的登录态是「' + status + '」，不是「需重新登录」')
      return '账号页与频道行都显示「需重新登录」'
    }
    finally {
      await page.unroute(matcher, handler).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
    }
  })

  await step('A15', '登录失效账号不参与刷新并如实提示', async () => {
    // 与 A11 同样的响应改写：把账号库标成"平台判定登录失效"。
    const matcher = url => /\/api\/v2\/channels\/accounts$/.test(url.pathname)
    const handler = async (route) => {
      const response = await route.fetch()
      const envelope = await response.json().catch(() => null)
      if (Array.isArray(envelope?.data?.list)) {
        envelope.data.list = envelope.data.list.map(account => ({
          ...account,
          loginState: 'invalid',
          loginNote: '自检：平台判定该账号登录已失效',
        }))
      }
      await route.fulfill({ response, json: envelope })
    }
    await page.route(matcher, handler)
    try {
      await resetPage(page, '#/accounts')
      await openChannelManager(page)
      await waitNoticesClear(page)
      const refresh = page.locator('[data-testid=cm-refresh-all-fans-btn]').first()
      if (await refresh.count() === 0)
        throw new Error('没有「刷新全部平台」按钮')
      await refresh.click()
      const notice = await waitForNotice(page, /暂无可刷新的正常账号|刷新间隔|粉丝数刷新完成|刷新失败/, 25000)
      await snap(page, 'A15-refresh-skip-invalid')
      // 全库登录失效时只能给"暂无可刷新的正常账号"：说"刷新完成"就是假成功。
      if (/粉丝数刷新完成/.test(notice))
        throw new Error('账号登录已失效却提示刷新完成（应跳过并如实说明）：' + notice)
      if (!/暂无可刷新的正常账号/.test(notice))
        throw new Error('登录失效账号的刷新提示不如实：' + notice)
      return notice
    }
    finally {
      await page.unroute(matcher, handler).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
    }
  })

  await step('A12', '合成账号：未确认删除被拦、退出只清 cookie、确认删除留快照', async () => {
    const marker = 'qa-selfcheck-' + Date.now()
    const created = await apiOk('api/v2/channels/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'xhs', uid: marker, nickname: '自检合成账号', loginCookie: 'qa-fake-cookie-value', groupId: 'grp-default' }),
    })
    const id = created.id
    try {
      // 请求体里是中文：回读必须仍有中文，否则就是请求体被 ASCII 回退（PowerShell -Body 字符串）。
      const createdRow = (await listAccounts()).find(account => account.id === id)
      assertNoAsciiFallback('A12 新建账号 nickname', '自检合成账号', createdRow?.nickname)
      // 1) 带登录 cookie 的账号必须二次确认（confirm=1）才允许删除
      const snapshotsBeforeBlock = backupSnapshots('pre-delete-account').length
      const blocked = await (await fetch(BASE + 'api/v2/channels/accounts/' + id, { method: 'DELETE' })).json().catch(() => null)
      if (blocked?.code === 0)
        throw new Error('带登录态的账号没二次确认就被删了')
      if (!(await listAccounts()).some(account => account.id === id))
        throw new Error('被拦下的删除却真的删掉了账号')
      if (backupSnapshots('pre-delete-account').length > snapshotsBeforeBlock)
        throw new Error('被拦下的删除请求也写了回滚快照：拒绝的请求不该有落盘副作用')
      // 2) 退出登录只清登录态，账号资料与历史数据保留
      const loggedOut = await apiOk('api/v2/channels/accounts/' + id + '/logout', { method: 'POST' })
      if (loggedOut.hasLoginCookie !== false)
        throw new Error('退出登录后账号仍带登录 cookie')
      if (!(await listAccounts()).some(account => account.id === id))
        throw new Error('退出登录把账号本身删掉了（产品约定：只清登录会话与 cookie）')
      // 3) 确认删除：账号消失 + 删前快照留痕
      const snapshotsBefore = backupSnapshots('pre-delete-account')
      await apiOk('api/v2/channels/accounts/' + id + '?confirm=1', { method: 'DELETE' })
      if ((await listAccounts()).some(account => account.id === id))
        throw new Error('确认删除后账号仍在库里')
      const added = backupSnapshots('pre-delete-account').length - snapshotsBefore.length
      if (added <= 0)
        throw new Error('删除账号前没有留回滚快照')
      return '未确认被拦 + 退出清 cookie 保留账号 + 确认删除新增 ' + added + ' 份快照'
    }
    finally {
      await fetch(BASE + 'api/v2/channels/accounts/' + id + '?confirm=1', { method: 'DELETE' }).catch(() => {})
    }
  })

  await step('A13', '删除分组后组内账号回落默认分组（合成数据）', async () => {
    const group = await apiOk('api/v2/channels/account-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '自检回落组' + Date.now().toString().slice(-5) }),
    })
    const account = await apiOk('api/v2/channels/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'xhs', uid: 'qa-group-' + Date.now(), nickname: '自检回落账号', groupId: group.id }),
    })
    try {
      const inGroup = (await listAccounts()).find(item => item.id === account.id)
      const groupRow = (await listGroups()).find(item => item.id === group.id)
      assertNoAsciiFallback('A13 新建分组 name', group.name, groupRow?.name)
      assertNoAsciiFallback('A13 新建账号 nickname', '自检回落账号', inGroup?.nickname)
      if (inGroup?.groupId !== group.id)
        throw new Error('新建账号没有进指定分组：' + String(inGroup?.groupId))
      await apiOk('api/v2/channels/account-groups?ids=' + encodeURIComponent(group.id), { method: 'DELETE' })
      const groups = await listGroups()
      if (groups.some(item => item.id === group.id))
        throw new Error('分组没被删掉：' + group.id)
      if (!groups.some(item => item.isDefault))
        throw new Error('默认分组丢失')
      const fallback = (await listAccounts()).find(item => item.id === account.id)
      if (fallback === undefined)
        throw new Error('删除分组把组内账号一起删了')
      if (fallback.groupId !== 'grp-default')
        throw new Error('组内账号没有回落默认分组，groupId=' + String(fallback.groupId))
      return '账号 ' + account.id + ' 从 ' + group.id + ' 回落 grp-default'
    }
    finally {
      await fetch(BASE + 'api/v2/channels/accounts/' + account.id + '?confirm=1', { method: 'DELETE' }).catch(() => {})
      await fetch(BASE + 'api/v2/channels/account-groups?ids=' + encodeURIComponent(group.id), { method: 'DELETE' }).catch(() => {})
    }
  })

  await step('A14', '平台目录：本地化名称 + 真实接通平台的能力声明', async () => {
    const platforms = await apiOk('api/v2/channels/platforms')
    if (!Array.isArray(platforms) || platforms.length === 0)
      throw new Error('平台元数据为空')
    const missingName = platforms.filter(item => !item.displayName || !item.displayName['zh-CN'])
    if (missingName.length > 0)
      throw new Error('平台缺少本地化名称：' + missingName.map(item => item.platform).join(','))
    for (const platform of ['douyin', 'xhs']) {
      const meta = platforms.find(item => item.platform === platform)
      if (meta === undefined)
        throw new Error('平台目录缺少 ' + platform)
      if (meta.capabilities?.auth?.supported !== true)
        throw new Error(platform + ' 没有声明扫码授权能力')
      if (meta.capabilities?.publish?.supported !== true)
        throw new Error(platform + ' 没有声明发布能力')
      if (meta.capabilities?.analytics?.account !== true)
        throw new Error(platform + ' 没有声明 analytics.account（频道行刷新粉丝入口会消失）')
    }
    // 账号库里显示的是本地化平台名，而不是平台 id
    await resetPage(page, '#/accounts')
    await page.locator('[data-testid=sidebar-account-entry]').click()
    await page.waitForTimeout(3000)
    const rowText = (await page.locator('[data-testid=cm-channel-item]:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    await snap(page, 'A14-platform-catalog')
    await page.keyboard.press('Escape')
    if (/\b(douyin|xhs)\b/.test(rowText))
      throw new Error('频道行显示的是平台 id 而不是本地化名称：' + rowText)
    return platforms.length + ' 个平台元数据齐全；频道行：' + rowText.slice(0, 80)
  })

  await step('A16', '账号数据一致性：账号库↔发布记录↔互动指标↔接口', async () => {
    const accounts = await listAccounts()
    if (accounts.length === 0)
      throw new Error('账号库为空')
    const records = readEnvelope('publish-records.json')
    const metrics = readEnvelope('metrics.json')
    const accountIds = new Set(accounts.map(account => account.id))
    const orphanRecords = records.filter(record => !accountIds.has(record.accountId))
    if (orphanRecords.length > 0)
      throw new Error('发布记录指向不存在的账号：' + orphanRecords.map(record => record.id).join(','))
    const missingEvidence = records
      .filter(record => record.status === 1)
      .filter(record => !record.platformWorkId || !record.workLink || !record.publishTime)
    if (missingEvidence.length > 0)
      throw new Error('已发布记录缺作品证据（platformWorkId/workLink/publishTime）：' + missingEvidence.map(record => record.id).join(','))
    const workIds = records.map(record => String(record.platformWorkId ?? '')).filter(id => id !== '')
    const duplicated = workIds.filter((id, index) => workIds.indexOf(id) !== index)
    if (duplicated.length > 0)
      throw new Error('同一平台作品被登记成多条记录：' + [...new Set(duplicated)].join(','))
    // 互动数据落两份（记录的 engagement 与 metrics.json）：必须逐条一致，
    // 否则就是"作品列表看 0、数据中心看真实值"两个真相。
    const metricByWork = new Map(metrics.map(metric => [String(metric.workId), metric]))
    const mismatches = []
    for (const record of records) {
      const metric = metricByWork.get(String(record.platformWorkId ?? ''))
      if (metric === undefined)
        continue
      for (const key of ['viewCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount']) {
        const fromRecord = Number(record.engagement?.[key] ?? 0)
        const fromMetric = Number(metric[key] ?? 0)
        if (fromRecord !== fromMetric)
          mismatches.push(record.id + '.' + key + ' ' + fromRecord + '≠' + fromMetric)
      }
    }
    if (mismatches.length > 0)
      throw new Error('记录的 engagement 与 metrics.json 不一致：' + mismatches.slice(0, 5).join('; '))
    for (const account of accounts) {
      const mine = records.filter(record => record.accountId === account.id)
      if (mine.length !== account.workCount)
        throw new Error('账号 ' + account.id + ' 的 workCount=' + String(account.workCount) + ' 与记录数 ' + mine.length + ' 不一致')
      const analytics = await apiOk('api/v2/channels/accounts/' + account.id + '/analytics')
      if (analytics.fansCount !== account.fansCount || analytics.workCount !== account.workCount)
        throw new Error('analytics 接口与账号库不一致：' + JSON.stringify({ apiFans: analytics.fansCount, diskFans: account.fansCount, apiWork: analytics.workCount, diskWork: account.workCount }))
    }
    const dashboard = await apiOk('api/v2/statistics/published-content-summary/dashboard')
    const published = records.filter(record => record.status === 1 && record.removedOnPlatform !== true)
    if (dashboard.overall?.workCount !== published.length)
      throw new Error('数据中心作品数与已发布记录不一致：' + String(dashboard.overall?.workCount) + ' ≠ ' + published.length)
    const views = metrics.reduce((sum, metric) => sum + Number(metric.viewCount ?? 0), 0)
    // 播放量合计 0 不等于平台真值：同一批作品历史同步采到过真实播放量（state.json 2026-09-02），
    // 所以这里只报落库合计，由 A17 判定"本次未采到"还是"平台未提供"。
    return '账号 ' + accounts.length + ' / 记录 ' + records.length + ' / 指标 ' + metrics.length
      + ' / 数据中心作品 ' + String(dashboard.overall?.workCount) + '（落库播放量合计 ' + views + '）'
  })

  await step('A17', '全 0 指标要判"本次未采到"还是"平台未提供"', async () => {
    const dashboard = await apiOk('api/v2/statistics/published-content-summary/dashboard')
    const availability = dashboard.metricAvailability
    if (availability === undefined || typeof availability.views !== 'boolean')
      throw new Error('数据中心接口没有返回 metricAvailability：前端无法判断这次到底采到没采到')
    const metrics = readEnvelope('metrics.json')
    const viewsAllZero = metrics.length > 0 && metrics.every(metric => Number(metric.viewCount ?? 0) === 0)
    const othersHaveRealValues = metrics.some(metric =>
      ['likeCount', 'commentCount', 'shareCount', 'favoriteCount'].some(key => Number(metric[key] ?? 0) > 0))
    const viewsReason = dashboard.metricAvailabilityReason?.views
    await resetPage(page, '#/data-statistics')
    const hints = await page.locator('[data-testid=data-statistics-metric-hint]').allInnerTexts().catch(() => [])
    const NOT_COLLECTED = /本次未采到|重新同步|not collected|retry/i
    const HONEST = /本次未采到|重新同步|本次无数据|not collected|retry|No data/i
    /**
     * A17 只对「增长趋势」「作品排行」两个板块断言：只有这两个板块的指标说明跟随选中指标。
     * 「平台效率」板块讲的是 avgViews（与该板块外的选中指标无关），播放量不可用时它必然渲染说明，
     * 全页取值会把它误判成"默认指标没避开"——所以用板块容器（<section> + 其 h2 标题）限定范围。
     */
    const metricSections = () => page.locator('section')
      .filter({ has: page.locator('h2', { hasText: /增长趋势|作品排行|Growth Trend|Top Works/ }) })
    const readMetricNotices = async () => metricSections()
      .locator('[data-testid=data-statistics-metric-unavailable]')
      .evaluateAll(nodes => nodes.map(node => node.innerText.replace(/\s+/g, ' ').trim()))
    /** 默认指标必须落在有采样值的指标上：看这两个板块里的选中态按钮，而不是看有没有提示。 */
    const assertDefaultMetricAvoidsViews = async () => {
      const active = await metricSections().locator('button').evaluateAll(nodes => nodes
        .filter(node => node.className.includes('btn-secondary') && /^(播放\/浏览|点赞|评论|分享|收藏|Views|Likes|Comments|Shares|Favorites)$/.test(node.innerText.trim()))
        .map(node => node.innerText.trim()))
      if (active.length === 0)
        throw new Error('增长趋势/作品排行里找不到选中态的指标按钮，无法判定默认指标是否避开了没有数据的项')
      if (active.some(label => /播放\/浏览|^Views$/.test(label)))
        throw new Error('播放量没采到，默认指标却仍停在「播放/浏览」：' + JSON.stringify(active))
      const notices = await readMetricNotices()
      if (notices.length > 0)
        throw new Error('默认指标已避开没采到的项，这两个板块却仍出现跟随选中指标的说明：' + notices[0].slice(0, 60))
    }

    if (availability.views === true) {
      if (viewsReason !== undefined && viewsReason !== 'available')
        throw new Error('接口说播放量有非 0 采样值，reason 却是 ' + String(viewsReason))
      return '播放量有非 0 采样值（reason=' + String(viewsReason) + '），无需标注'
    }
    /**
     * 抖音实测：同一批 15 条作品点赞/评论/分享有真值而播放量全 0，而同一批作品 2026-09-02 的同步
     * 采到过 13016/10329/9384… 的真实播放量（sync-ddq5g2kk/state.json），所以这种全 0 只能是
     * 本次没采到。旧断言把它当"平台未提供"直接放行就是长期假绿；这里必须判"本次未采到/需重新同步"。
     */
    if (viewsAllZero && othersHaveRealValues) {
      if (viewsReason !== 'not-collected-this-sync')
        throw new Error('播放量全 0 而点赞/评论/分享有真值，服务端 reason=' + String(viewsReason) + '，必须报 not-collected-this-sync')
      if (!hints.some(item => NOT_COLLECTED.test(item)))
        throw new Error('概览卡把全 0 播放量当平台真值：缺"本次未采到/可重新同步"标注，实际提示=' + JSON.stringify(hints))
      await assertDefaultMetricAvoidsViews()
      await page.getByRole('button', { name: /播放\/浏览|Views/ }).first().click()
      await page.waitForTimeout(1500)
      const after = (await readMetricNotices())[0] ?? ''
      await snap(page, 'A17-metric-not-collected')
      if (!NOT_COLLECTED.test(after))
        throw new Error('切到「播放/浏览」后没有说明本次未采到：' + after.slice(0, 60))
      if (/平台未提供|does not provide/.test(after))
        throw new Error('把"本次未采到"说成了"平台未提供"：' + after.slice(0, 60))
      return '播放量全 0（其它指标有真值）：判"本次未采到 + 可重新同步"，默认指标落在有值的项上，手动切换时如实说明'
    }
    // 无差分证据（播放量全 0 且其它互动指标也全 0）：不声称"平台不提供"，但必须如实标注。
    if (viewsReason === 'not-collected-this-sync')
      throw new Error('服务端报"本次未采到"，但落库没有"其它指标有真值"的差分证据：' + JSON.stringify({ viewsAllZero, othersHaveRealValues }))
    if (!hints.some(item => HONEST.test(item)))
      throw new Error('播放量全 0，概览卡却没有任何如实标注：' + JSON.stringify(hints))
    await assertDefaultMetricAvoidsViews()
    await page.getByRole('button', { name: /播放\/浏览|Views/ }).first().click()
    await page.waitForTimeout(1500)
    const after = (await readMetricNotices())[0] ?? ''
    await snap(page, 'A17-metric-unavailable')
    if (!HONEST.test(after))
      throw new Error('切到「播放/浏览」后没有如实说明：' + after.slice(0, 60))
    return '播放量全 0 且无差分证据：概览如实标注 + 默认避开 + 手动切换时说明'
  })

  // ============ AI 智能体 ============
  await step('C1', 'AI 助手给出真实回复（非模板）', async () => {
    await resetPage(page, '#/draft-box')
    const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
    await input.click({ timeout: 20000 })
    await input.fill('用两句话说明你能帮我做什么。')
    await page.locator('[data-testid=ai-assistant-sidebar] button[aria-label="发送"]').last().click()
    let reply = ''
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(2500)
      const side = await text(page, '[data-testid=ai-assistant-sidebar]')
      const idx = side.indexOf('用两句话说明你能帮我做什么。')
      reply = idx >= 0 ? side.slice(idx + 14) : side
      if (reply.length > 30 && !/正在(思考|生成)/.test(reply))
        break
    }
    await snap(page, 'C1-agent-reply')
    if (/未配置任何大模型|未接入任何大模型|还没有配置大模型|没有配置大模型|请先.{0,16}配置大模型|大模型调用失败|内置模板/.test(reply))
      throw new Error('AI 回复是模板：' + reply.slice(0, 160))
    if (reply.length < 20)
      throw new Error('没有拿到 AI 回复')
    return reply.slice(0, 160)
  })

  await step('C2', '跟随模式开关可切换并回读', async () => {
    const toggle = page.locator('[data-testid=ai-assistant-sidebar] button[aria-label="跟随模式"]').first()
    if (await toggle.count() === 0)
      throw new Error('AI 助手侧栏没有跟随模式开关')
    // 开关状态文字在按钮旁边的兄弟节点里，比较整个侧栏头部文字更可靠。
    const stateText = async () => {
      const side = await text(page, '[data-testid=ai-assistant-sidebar]')
      return (side.match(/跟随模式\s*(跟随中|已关闭|跟随)/) ?? [side.slice(0, 40)])[0]
    }
    const before = await stateText()
    await toggle.click()
    await page.waitForTimeout(1800)
    const after = await stateText()
    await snap(page, 'C2-follow-toggle')
    if (before === after)
      throw new Error('开关点击后状态没变：' + before)
    await toggle.click()
    await page.waitForTimeout(1500)
    return before + ' -> ' + after
  })

  await step('C3', 'AI 助手「新对话」可用', async () => {
    const fresh = page.locator('[data-testid=ai-assistant-sidebar] button:has-text("新对话")').first()
    if (await fresh.count() === 0)
      throw new Error('没有「新对话」按钮')
    await fresh.click()
    await page.waitForTimeout(2500)
    const body = await text(page, '[data-testid=ai-assistant-sidebar]')
    await snap(page, 'C3-new-chat')
    if (!/有什么我可以帮你|输入你的需求/.test(body))
      throw new Error('新对话后侧栏内容异常：' + body.slice(0, 140))
    return body.slice(0, 140)
  })

  // ============ 其余核心页面交互 ============
  await step('E1', 'AI 互动页渲染且接待内容可见', async () => {
    await resetPage(page, '#/ai-interaction')
    const body = await text(page)
    await snap(page, 'E1-ai-interaction')
    if (!/接待|私信|评论/.test(body))
      throw new Error('AI 互动页没有接待内容：' + body.slice(0, 140))
    return body.slice(0, 140)
  })

  await step('E2', '发布日历可点开某天创建排期', async () => {
    await resetPage(page, '#/calendar')
    const body = await text(page)
    if (!/今天|日历/.test(body))
      throw new Error('日历没渲染：' + body.slice(0, 120))
    const day = page.locator('[data-testid=calendar-week-view] button').first()
    if (await day.count() === 0)
      throw new Error('周视图里没有日期格')
    await day.click()
    await page.waitForTimeout(2500)
    const after = await text(page)
    await snap(page, 'E2-calendar-day')
    if (!/发布|排期|新建|创建/.test(after))
      throw new Error('点日期后没有排期入口：' + after.slice(0, 140))
    await page.keyboard.press('Escape')
    return after.slice(0, 140)
  })

  await step('E3', '我的任务可打开任务详情', async () => {
    await resetPage(page, '#/tasks-history')
    const item = page.locator('[class*=cursor-pointer]', { hasText: /已完成|进行中|失败/ }).first()
    if (await item.count() === 0)
      throw new Error('任务列表没有可点的任务')
    await item.click()
    await page.waitForTimeout(3500)
    const body = await text(page)
    await snap(page, 'E3-task-detail')
    if (!/任务|标题|内容|状态/.test(body))
      throw new Error('任务详情没渲染')
    await page.keyboard.press('Escape')
    return body.slice(0, 140)
  })

  await step('E4', '数据中心查询按钮可用', async () => {
    await resetPage(page, '#/data-statistics')
    const query = page.locator('button:has-text("查询数据")').first()
    if (await query.count() === 0)
      throw new Error('没有查询数据按钮')
    await query.click()
    await page.waitForTimeout(6000)
    const body = await text(page)
    await snap(page, 'E4-datacenter-query')
    if (!/作品|播放|粉丝|暂无/.test(body))
      throw new Error('查询后没有数据区：' + body.slice(0, 140))
    return body.slice(0, 140)
  })

  await step('E5', '知识库新建笔记并保存', async () => {
    await resetPage(page, '#/knowledge')
    const create = page.locator('button:has-text("新建笔记")').first()
    if (await create.count() === 0)
      throw new Error('没有新建笔记按钮')
    await create.click()
    await page.waitForTimeout(2500)
    const body = await text(page)
    await snap(page, 'E5-knowledge-new')
    if (!/笔记|标题|内容/.test(body))
      throw new Error('新建笔记后没有编辑区：' + body.slice(0, 140))
    return body.slice(0, 140)
  })

  await step('E6', '设置页通用/系统与更新可用', async () => {
    await resetPage(page, '#/draft-box')
    await page.locator('[data-testid=sidebar-user-trigger]').click()
    await page.waitForTimeout(900)
    await page.locator('[data-testid=sidebar-settings-entry] button').click()
    await page.waitForTimeout(1500)
    const general = await text(page, '[role=dialog]')
    if (!/外观|浅色|深色/.test(general))
      throw new Error('通用页签没有主题选项')
    await page.locator('[data-tab-key=ota]').click()
    await page.waitForTimeout(2000)
    const ota = await text(page, '[role=dialog]')
    await snap(page, 'E6-settings-ota')
    if (!/版本|更新/.test(ota))
      throw new Error('系统与更新页没有版本信息：' + ota.slice(0, 140))
    await page.keyboard.press('Escape')
    return ota.slice(0, 140)
  })


  // ============ AI 智能体：互动/接待/知识库/监控的未覆盖项 ============
  await step('C4', '对话附件上传入口', async () => {
    await resetPage(page, '#/draft-box')
    const upload = page.locator('[data-testid=ai-assistant-sidebar] button').filter({ hasText: /Upload media|上传/ }).first()
    const byLabel = (await upload.count()) > 0 ? upload : page.locator('[data-testid=ai-assistant-sidebar] button[aria-label*="Upload"], [data-testid=ai-assistant-sidebar] button[aria-label*="上传"]').first()
    if (await byLabel.count() === 0)
      throw new Error('AI 助手没有附件上传按钮')
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
      byLabel.click(),
    ])
    if (chooser === null)
      throw new Error('点击上传没有唤起文件选择')
    await chooser.setFiles('C:/Users/Jay/AppData/Local/Temp/upload-probe.png')
    await page.waitForTimeout(3000)
    const side = await text(page, '[data-testid=ai-assistant-sidebar]')
    await snap(page, 'C4-chat-attachment')
    return side.slice(0, 100)
  })

  await step('C5', '我的任务收藏筛选可用', async () => {
    await resetPage(page, '#/tasks-history')
    const fav = page.locator('button, [role=tab]').filter({ hasText: /我的收藏/ }).first()
    if (await fav.count() === 0)
      throw new Error('任务页没有「我的收藏」入口')
    await fav.click()
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'C5-task-favorite')
    if (!/收藏|暂无|任务/.test(body))
      throw new Error('收藏视图没有内容：' + body.slice(0, 140))
    return body.slice(0, 120)
  })

  await step('C6', '评论搜索可搜索', async () => {
    await resetPage(page, '#/ai-interaction')
    const tab = page.locator('button, [role=tab]').filter({ hasText: /评论搜索/ }).first()
    if (await tab.count() === 0)
      throw new Error('AI 互动页没有评论搜索页签')
    await tab.click()
    await page.waitForTimeout(3000)
    const input = page.locator('input[type=text], input[type=search], textarea').filter({ hasNot: page.locator('xpath=//*[@data-testid="ai-assistant-sidebar"]//input') }).first()
    if (await input.count() === 0)
      throw new Error('评论搜索没有输入框')
    await input.fill('重庆夜景')
    const search = page.locator('button').filter({ hasText: /^搜索|查询/ }).first()
    if (await search.count() > 0)
      await search.click()
    await page.waitForTimeout(8000)
    const body = await text(page)
    await snap(page, 'C6-comment-search')
    if (!/评论|搜索|暂无|结果|失败/.test(body))
      throw new Error('评论搜索没有反应：' + body.slice(0, 140))
    return body.slice(0, 120)
  })

  await step('C7', '热点页平台导航可跳转', async () => {
    // 平台导航是 hash 路由链接（#/hot-content/source/xxx），只在「热点内容」页签下存在。
    await resetPage(page, '#/ai-interaction')
    const hot = page.locator('button, [role=tab]').filter({ hasText: /^热点内容$/ }).first()
    if (await hot.count() > 0) {
      await hot.click()
      await page.waitForTimeout(2500)
    }
    const nav = page.locator('a[href*="hot-content/source/"]').first()
    if (await nav.count() === 0)
      throw new Error('热点页没有平台导航链接')
    const before = page.url()
    await nav.click()
    await page.waitForTimeout(3500)
    const after = page.url()
    await snap(page, 'C7-platform-nav')
    if (before === after)
      throw new Error('点击平台导航后 URL 没有变化：' + after)
    return before.split('#')[1] + ' -> ' + after.split('#')[1]
  })

  await step('C8', '接待规则推荐模板可套用', async () => {
    await resetPage(page, '#/accounts')
    const tpl = page.locator('button').filter({ hasText: /报价咨询|合作洽谈|售后客服|新品促销/ }).first()
    if (await tpl.count() === 0)
      throw new Error('账号页没有接待推荐模板')
    await tpl.click()
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'C8-reception-template')
    if (!/规则|关键词|回复|保存/.test(body))
      throw new Error('套用模板后没有表单：' + body.slice(0, 140))
    await page.keyboard.press('Escape')
    return body.slice(0, 120)
  })

  await step('C9', '接待规则测试可用', async () => {
    const test = page.locator('button').filter({ hasText: /^测试接待/ }).first()
    if (await test.count() === 0)
      throw new Error('没有测试接待入口')
    await test.click()
    await page.waitForTimeout(2500)
    const input = page.locator('[role=dialog] input, [role=dialog] textarea').last()
    if (await input.count() === 0)
      throw new Error('测试接待没有输入框')
    await input.fill('请问什么时候发货')
    const run = page.locator('[role=dialog] button').filter({ hasText: /测试|发送|确定/ }).last()
    if (await run.count() > 0)
      await run.click()
    await page.waitForTimeout(5000)
    const body = await text(page)
    await snap(page, 'C9-reception-test')
    if (!/命中|回复|未命中|规则/.test(body))
      throw new Error('测试接待没有返回结果：' + body.slice(0, 140))
    await page.keyboard.press('Escape')
    return body.slice(0, 120)
  })

  await step('C10', '全自动接待开关可切换', async () => {
    await resetPage(page, '#/monitor')
    // 参数区默认折叠（GlobalMonitor 的 Collapse「引擎参数与 7×24 全自动接待」）：
    // 折叠时 antd 不挂载子节点，必须先像用户一样展开，否则控件根本不在 DOM 里。
    await expandEngineParamsPanel(page)
    // Ant Switch：button[role=switch] 且名字来自 aria-label（没有可见文本，hasText 匹配不到）。
    const toggle = page.locator('button[role=switch][aria-label="全自动接待"]').first()
    await toggle.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    if (await toggle.count() === 0)
      throw new Error('监控页没有全自动接待开关')
    const before = await toggle.getAttribute('aria-checked')
    await toggle.click()
    await page.waitForTimeout(3000)
    const after = await toggle.getAttribute('aria-checked')
    await snap(page, 'C10-auto-reception')
    await toggle.click()
    await page.waitForTimeout(2000)
    if (before === after)
      throw new Error('开关点击后状态没变：aria-checked ' + before)
    return 'aria-checked ' + before + ' -> ' + after
  })

  await step('C11', '接待只剩一处入口：规则在账号页，待办与记录在全局监控', async () => {
    await resetPage(page, '#/accounts')
    const tab = page.locator('button, [role=tab]').filter({ hasText: /接待规则/ }).first()
    if (await tab.count() === 0)
      throw new Error('账号页没有接待规则页签')
    await tab.click()
    await page.waitForTimeout(2500)
    const accountText = await mainText(page)
    await snap(page, 'C11-reception-rules')
    if (!/接待规则|自动接待/.test(accountText))
      throw new Error('接待规则页签没有内容：' + accountText.slice(0, 140))
    // 重复入口已合并：账号页不得再出现「接待记录 / 评论接待 / 私信接待」页签。
    for (const legacy of ['接待记录', '评论接待', '私信接待']) {
      const legacyTab = page.locator('button, [role=tab]').filter({ hasText: new RegExp('^' + legacy) }).first()
      if (await legacyTab.count() > 0)
        throw new Error('账号页仍存在应被合并的重复页签：' + legacy)
    }

    await resetPage(page, '#/monitor')
    const board = page.locator('[data-testid=reception-todo-board]')
    await board.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    if (await board.count() === 0)
      throw new Error('全局监控没有待办处理区')
    const dmTab = board.locator('label, [role=radio]').filter({ hasText: /私信待办/ }).first()
    if (await dmTab.count() > 0) {
      await dmTab.click()
      await page.waitForTimeout(1500)
    }
    await snap(page, 'C11-reception-todo')
    return '规则在账号页；待办处理与回复记录统一在全局监控；3 个重复页签已删除'
  })

  await step('C12', '知识库新建→编辑→保存→回读', async () => {
    await resetPage(page, '#/knowledge')
    const name = '自检笔记' + Date.now().toString().slice(-5)
    await page.locator('button').filter({ hasText: /新建笔记/ }).first().click()
    await page.waitForTimeout(2500)
    const nameInput = page.locator('input[placeholder*="笔记名称"], input[placeholder*="名称"]').first()
    if (await nameInput.count() === 0)
      throw new Error('新建笔记没有名称输入框')
    await nameInput.fill(name)
    await page.locator('button').filter({ hasText: /^创建|确定|保存/ }).first().click()
    await page.waitForTimeout(4000)
    const editor = page.locator('textarea, [contenteditable=true]').last()
    if (await editor.count() > 0) {
      await editor.click()
      await editor.fill('自检内容：这是一条自动化验收写入的笔记。').catch(() => {})
      await page.waitForTimeout(800)
      const save = page.locator('button').filter({ hasText: /^保存/ }).first()
      if (await save.count() > 0)
        await save.click()
      await page.waitForTimeout(3000)
    }
    await resetPage(page, '#/knowledge')
    const body = await text(page)
    await snap(page, 'C12-knowledge-note')
    if (!body.includes(name))
      throw new Error('保存后左侧笔记树里没有这条笔记：' + name)
    // 自检用的笔记用完即删，避免污染用户知识库。
    await fetch(BASE + 'api/knowledge/notes/' + encodeURIComponent(name + '.md'), { method: 'DELETE' }).catch(() => {})
    return name + ' 已保存、回读并清理'
  })

  await step('C17', '生成记录自动沉淀到知识库', async () => {
    const r = await fetch(BASE + 'api/knowledge/tree')
    const json = await r.json()
    const flat = JSON.stringify(json.data ?? {})
    await snap(page, 'C17-knowledge-distill')
    if (!/自动沉淀|生成记录/.test(flat))
      throw new Error('知识库里没有「自动沉淀/生成记录」笔记')
    return '自动沉淀笔记存在'
  })

  await step('C13', '知识库搜索可用', async () => {
    const search = page.locator('input[placeholder*="搜索"], input[type=search]').first()
    if (await search.count() === 0)
      throw new Error('知识库没有搜索框')
    await search.fill('自检')
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'C13-knowledge-search')
    if (!/自检|暂无|结果/.test(body))
      throw new Error('搜索没有结果区：' + body.slice(0, 140))
    return body.slice(0, 120)
  })

  await step('C14', '挂载外部库入口可打开', async () => {
    const mount = page.locator('button').filter({ hasText: /挂载外部库/ }).first()
    if (await mount.count() === 0)
      throw new Error('知识库没有挂载外部库入口')
    await mount.click()
    await page.waitForTimeout(3000)
    const body = await text(page)
    await snap(page, 'C14-knowledge-vault')
    if (!/目录|路径|库|选择/.test(body))
      throw new Error('挂载外部库没有弹层：' + body.slice(0, 140))
    await page.keyboard.press('Escape')
    return body.slice(0, 120)
  })

  await step('C15', '全局监控参数保存可回读', async () => {
    await resetPage(page, '#/monitor')
    await expandEngineParamsPanel(page)
    const save = page.locator('button').filter({ hasText: /保存参数/ }).first()
    if (await save.count() === 0)
      throw new Error('监控页没有保存参数按钮')
    await save.click()
    await page.waitForTimeout(3500)
    const body = await text(page)
    await snap(page, 'C15-monitor-params')
    if (!/已保存|保存成功|轮询/.test(body))
      throw new Error('保存参数没有反馈：' + body.slice(0, 140))
    return body.slice(0, 120)
  })

  await step('C16', '立即处理待办可用', async () => {
    const run = page.locator('button').filter({ hasText: /立即处理待办|立即轮询/ }).first()
    if (await run.count() === 0)
      throw new Error('监控页没有立即处理入口')
    await run.click()
    await page.waitForTimeout(6000)
    const body = await text(page)
    await snap(page, 'C16-monitor-poll')
    if (!/待办|处理|轮询|暂无/.test(body))
      throw new Error('立即处理没有反馈：' + body.slice(0, 140))
    return body.slice(0, 120)
  })

  await step('D6', '通知与联系我们入口可用', async () => {
    await resetPage(page, '#/draft-box')
    await page.locator('[data-testid=sidebar-user-trigger]').click()
    await page.waitForTimeout(1000)
    const notice = page.locator('button').filter({ hasText: /消息通知/ }).first()
    if (await notice.count() === 0)
      throw new Error('用户菜单没有消息通知')
    await notice.click()
    await page.waitForTimeout(2500)
    const noticeBody = await text(page)
    await snap(page, 'D6-notification')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    await page.locator('[data-testid=sidebar-user-trigger]').click()
    await page.waitForTimeout(1000)
    const contact = page.locator('button').filter({ hasText: /联系我们/ }).first()
    if (await contact.count() === 0)
      throw new Error('用户菜单没有联系我们')
    await contact.click()
    await page.waitForTimeout(2500)
    const contactBody = await text(page)
    await snap(page, 'D6-contact')
    await page.keyboard.press('Escape')
    if (!/通知|暂无|消息/.test(noticeBody) || !/联系|反馈|客服/.test(contactBody))
      throw new Error('通知/联系我们内容异常')
    return '通知 + 联系我们均可用'
  })


  await step('B19', '平台同步能力声明（作品/粉丝可同步）', async () => {
    const r = await fetch(BASE + 'api/v2/platform-sync/capabilities')
    const json = await r.json()
    const list = json.data ?? []
    const syncable = list.filter(item => item.canSync === true)
    await snap(page, 'B19-sync-capabilities')
    if (list.length === 0)
      throw new Error('同步能力列表为空')
    if (syncable.length === 0)
      throw new Error('没有任何平台声明可同步')
    return syncable.map(item => item.name).join('/') + ' 可同步'
  })

  await step('C18', '任务详情收藏/分享/评分入口可用', async () => {
    await resetPage(page, '#/tasks-history')
    const item = page.locator('[class*=cursor-pointer]').filter({ hasText: /已完成|进行中|失败/ }).first()
    if (await item.count() === 0)
      throw new Error('任务列表没有可点任务')
    await item.click()
    await page.waitForTimeout(4000)
    const detail = await text(page)
    await snap(page, 'C18-task-detail-actions')
    const has = text => detail.includes(text)
    if (!has('收藏') || !has('分享') || !has('评分'))
      throw new Error('任务详情缺少收藏/分享/评分入口：' + detail.slice(0, 140))

    // 先验分享（评分点击可能改变详情状态），再点评分。
    const share = page.locator('button').filter({ hasText: /^分享/ }).first()
    if (await share.count() > 0) {
      await share.click().catch(() => {})
      await page.waitForTimeout(2500)
      const dialogText = await text(page)
      await snap(page, 'C18-task-share')
      if (!/分享对话|链接有效期/.test(dialogText))
        throw new Error('分享没有打开分享弹窗：' + dialogText.slice(0, 140))
      const create = page.locator('[role=dialog] button').filter({ hasText: /生成|创建|确定|复制/ }).last()
      if (await create.count() > 0) {
        await create.click().catch(() => {})
        await page.waitForTimeout(3000)
        const after = await text(page)
        await snap(page, 'C18-task-share-link')
        if (!/http|链接|复制成功|已复制/.test(after))
          throw new Error('生成分享链接后没有链接/提示')
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1000)
    }
    // 评分：点 5 星（容错，不阻塞结论）
    const star = page.locator('button[aria-label="5 star"], button:has-text("5 star")').first()
    if (await star.count() > 0) {
      await star.click().catch(() => {})
      await page.waitForTimeout(2000)
    }
    await page.keyboard.press('Escape')
    return '收藏/分享/评分入口齐全，分享弹窗可用'
  })

  await step('C19', '知识库反向链接区渲染', async () => {
    await resetPage(page, '#/knowledge')
    const body = await text(page)
    await snap(page, 'C19-knowledge-backlinks')
    if (!/反向链接/.test(body))
      throw new Error('知识库没有反向链接区：' + body.slice(0, 140))
    return body.match(/反向链接[^ ]{0,20}/)?.[0] ?? '反向链接区存在'
  })

  // ============ 对账页 ============
  // 逐页三条独立判据：主内容区自带本页内容特征（#main-content 不含常驻侧栏与 AI 面板）
  // + 本页专属控件在主内容区可见 + 支撑本页的接口业务码为 0。
  // 原判据是「整页文案命中 /数据|日历|监控/ 之类」，而这些词就在侧栏导航
  // （任务记录/发布日历/数据中心/全局监控/知识库）里，页面白屏也能 PASS。
  // D1/D3 的整页正则在主内容区恒不成立（实测：我的任务页只有卡片与状态文案，发布日历页
  // 只有周视图与工具栏），因此换成由本页 DOM 真实产出的特征，判据整体更严。
  for (const [id, name, hash, expect, anchor, api] of [
    ['D1', '我的任务页可用', '#/tasks-history', /收藏|暂无|已完成|进行中|失败/, 'input[placeholder="搜索任务标题..."]', 'api/agent/tasks?page=1&pageSize=1'],
    ['D2', '数据中心可用', '#/data-statistics', /数据|作品|粉丝|暂无/, '[data-testid=data-statistics-query]', 'api/v2/statistics/published-content-summary/dashboard'],
    ['D3', '发布日历可用', '#/calendar', /今天|公历节日|节气|星期|暂无|发布/, '[data-testid=calendar-week-view]', 'api/v2/channels/publish/records'],
    ['D4', '全局监控可用', '#/monitor', /监控|接待|平台/, '[data-testid=reply-customer-board]', 'api/v2/customer-reception/status'],
    ['D5', '知识库可用', '#/knowledge', /知识|文档|暂无/, 'input[placeholder="搜索笔记…"]', 'api/knowledge/tree'],
  ]) {
    await step(id, name, async () => {
      await page.goto(BASE + '?planId=mg-persist' + hash, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)
      const body = await text(page)
      const main = await mainText(page)
      await snap(page, `${id}-${hash.slice(2)}`)
      if (!page.url().includes(hash))
        throw new Error('没有导航到 ' + hash + '：' + page.url())
      if (main.length < 60 || !expect.test(main))
        throw new Error('主内容区没有本页内容（侧栏文案不算）：' + main.slice(0, 140))
      const anchorNode = page.locator('#main-content ' + anchor).first()
      if (await anchorNode.count() === 0)
        throw new Error('主内容区缺少本页专属控件 ' + anchor)
      await anchorNode.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
        throw new Error('本页专属控件不可见：' + anchor)
      })
      await apiOk(api)
      return body.slice(0, 140)
    })
  }

  await step('B20', '发布弹窗完整性与校验提示', async () => {
    await resetPage(page, '#/draft-box')
    await page.locator('button:has-text("一键发布")').first().click()
    await page.waitForTimeout(9000)
    const state = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=publish-dialog-container]')
      if (!d) return { none: true }
      const text = (d.innerText || '').replace(/\s+/g, ' ')
      return {
        title: !!d.querySelector('[data-testid=publish-title-input]'),
        editor: !!d.querySelector('[data-testid=publish-content-editor]'),
        account: d.querySelectorAll('[data-testid^="publish-account-item-"]').length,
        datePicker: !!d.querySelector('[data-testid=publish-date-picker]'),
        upload: !!d.querySelector('[data-testid=publish-upload-area]') || !!d.querySelector('[data-testid=publish-upload-local-button]'),
        hint: /上传|素材|图片|视频|存在问题|缺少/.test(text),
        text: text.slice(0, 160),
      }
    })
    await snap(page, 'B20-publish-completeness')
    await closePublishDialog(page)
    if (state.none)
      throw new Error('发布弹窗没打开')
    if (!state.title || !state.editor || !state.upload)
      throw new Error('发布弹窗缺字段：' + JSON.stringify(state))
    if (state.account === 0)
      throw new Error('发布弹窗没有可选账号')
    if (!state.datePicker)
      throw new Error('发布弹窗没有定时发布入口')
    if (!state.hint)
      throw new Error('发布弹窗没有任何素材/校验提示：' + state.text)
    return '标题/正文/账号/素材/定时齐备且有校验提示'
  })

  // ==================== L2：小功能区级（区内协同） ====================
  layerGate(1)

  await step('L2-A1', '创作工作台区内协同', async () => {
    await resetPage(page, '#/draft-box')
    const box = page.locator('[data-testid=draftbox-ai-prompt-input]').first()
    await box.fill('区内协同：重庆夜景打卡短视频')
    await page.locator('[data-testid=draftbox-ai-duration]').first().click().catch(() => {})
    await page.waitForTimeout(1200)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /参数限制/ }).first().click().catch(() => {})
    await page.waitForTimeout(1000)
    await page.keyboard.press('Escape')
    await page.locator('button:has-text("文案要求")').first().click().catch(() => {})
    await page.waitForTimeout(1000)
    await page.keyboard.press('Escape')
    await page.locator('button:has-text("生成记录"):visible').first().click().catch(() => {})
    await page.waitForTimeout(2000)
    await page.keyboard.press('Escape')
    await page.locator('[data-testid=draftbox-ai-reset-btn]').first().click().catch(() => {})
    await page.waitForTimeout(1500)
    const afterReset = await page.locator('[data-testid=draftbox-ai-prompt-input]').first().innerText().catch(() => '')
    await snap(page, 'L2-A1-composer')
    if (/区内协同/.test(afterReset))
      throw new Error('重置配置没有清空提示词')
    return '输入→参数→文案要求→生成记录→重置 全通'
  })

  await step('L2-A2', '草稿箱+素材库区内协同', async () => {
    await resetPage(page, '#/draft-box')
    await page.locator('button').filter({ hasText: /^草稿/ }).first().click()
    await page.waitForTimeout(3500)
    const card = page.locator('[data-testid=draftbox-draft-card]').first()
    if (await card.count() === 0)
      throw new Error('草稿页签没有草稿')
    await card.click({ timeout: 15000 })
    await page.waitForTimeout(3000)
    if (await page.locator('[data-testid=draftbox-detail-dialog]').count() === 0)
      throw new Error('详情没打开')
    await page.locator('[data-testid=draftbox-detail-publish-btn]').first().click()
    await page.waitForTimeout(7000)
    const dialog = await text(page)
    await snap(page, 'L2-A2-draft-publish')
    if (!/发布作品|立即发布/.test(dialog))
      throw new Error('从详情发布没打开发布弹窗')
    await closePublishDialog(page)
    await page.locator('button:has-text("素材库")').first().click()
    await page.waitForTimeout(4000)
    const media = await page.locator('img[src*="api/assets/file/"]').count()
    await snap(page, 'L2-A2-media')
    if (media === 0)
      throw new Error('素材库没有素材')
    return '草稿列表→详情→发布预填→素材库 全通'
  })

  await step('L2-A4', '发布链路区内协同', async () => {
    await resetPage(page, '#/draft-box')
    await page.locator('button:has-text("一键发布")').first().click()
    await page.waitForTimeout(8000)
    const info = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=publish-dialog-container]')
      if (!d) return { none: true }
      return {
        accounts: d.querySelectorAll('[data-testid^="publish-account-item-"]').length,
        editor: !!d.querySelector('[data-testid=publish-content-editor]'),
        submit: !!d.querySelector('[data-testid=publish-submit-btn]'),
        titleInput: [...d.querySelectorAll('input')].some(i => (i.placeholder || '').includes('标题')),
      }
    })
    await snap(page, 'L2-A4-publish')
    await closePublishDialog(page)
    if (info.none)
      throw new Error('发布弹窗没打开')
    if (!info.editor || !info.submit || !info.titleInput)
      throw new Error('发布弹窗缺字段：' + JSON.stringify(info))
    await resetPage(page, '#/calendar')
    const day = page.locator('[data-testid=calendar-week-view] button').first()
    await day.click()
    await page.waitForTimeout(2500)
    const cal = await text(page)
    await snap(page, 'L2-A4-calendar')
    await page.keyboard.press('Escape')
    if (!/发布|排期|时间/.test(cal))
      throw new Error('日历点日期没有排期入口')
    return '发布弹窗字段齐全 + 排期入口可用'
  })

  await step('L2-B1', '频道连接+账号库区内协同', async () => {
    await resetPage(page, '#/accounts')
    await page.locator('[data-testid=sidebar-account-entry]').click()
    await page.waitForTimeout(3000)
    await page.locator('[data-testid=cm-sidebar-connect-btn]').first().click()
    await page.waitForTimeout(2500)
    await page.locator('[data-testid=cm-connect-back-btn]').first().click()
    await page.waitForTimeout(2000)
    const name = '区级组' + Date.now().toString().slice(-5)
    await page.locator('[data-testid=cm-create-space-btn]').first().click()
    await page.waitForTimeout(1000)
    await page.locator('[data-testid=cm-create-space-input]').fill(name)
    await page.locator('[data-testid=cm-create-space-confirm]').click()
    await page.waitForTimeout(3000)
    // 新建分组必须真的落库，账号也必须仍在原组（未被新组带走）
    const accountsBefore = await listAccounts()
    const groupsAfterCreate = await listGroups()
    const created = groupsAfterCreate.find(group => group.name === name)
    if (created === undefined)
      throw new Error('新建分组没有落库：' + name)
    const acc = accountsBefore[0]
    if (acc === undefined)
      throw new Error('账号库为空')
    if (!groupsAfterCreate.some(group => group.id === acc.groupId))
      throw new Error('账号分组 id 不在分组表里：' + acc.groupId)
    const space = page.locator('[data-testid=cm-space-item]', { hasText: name }).first()
    await space.locator('[data-testid=cm-space-more-menu]').click()
    await page.waitForTimeout(900)
    await page.locator('[role=menuitem]:has-text("删除")').first().click()
    await page.waitForTimeout(900)
    const confirm = page.locator('[data-testid=cm-delete-confirm-btn]').first()
    if (await confirm.count() > 0)
      await confirm.click()
    await page.waitForTimeout(3000)
    const groupsAfter = await listGroups()
    await snap(page, 'L2-B1-channel-area')
    await page.keyboard.press('Escape')
    if (groupsAfter.some(group => group.id === created.id))
      throw new Error('删除后分组仍在落库里：' + created.id)
    if (!groupsAfter.some(group => group.isDefault))
      throw new Error('删除分组后默认分组丢了')
    const accAfter = (await listAccounts()).find(item => item.id === acc.id)
    if (accAfter?.groupId !== acc.groupId)
      throw new Error('建组/删组把账号换了分组：' + acc.groupId + ' -> ' + String(accAfter?.groupId))
    return '连接页往返 + 建组落库/删组消失后账号仍属 ' + acc.groupId
  })

  await step('L2-B2', '平台目录+账号数据区内协同', async () => {
    const list = await apiOk('api/v2/channels/platforms')
    const caps = await apiOk('api/v2/platform-sync/capabilities')
    const accounts = await listAccounts()
    const douyin = list.find(item => item.platform === 'douyin')
    const xhs = list.find(item => item.platform === 'xhs')
    if (list.length === 0)
      throw new Error('平台元数据为空')
    // 已连接的两个平台都必须声明"可按账号取数据"，否则频道行的刷新入口会消失。
    for (const [name, meta] of [['抖音', douyin], ['小红书', xhs]]) {
      if (meta?.capabilities?.analytics?.account !== true)
        throw new Error(name + ' 未声明 analytics.account（刷新粉丝入口会消失）')
      if (!new RegExp(name).test(JSON.stringify(caps)))
        throw new Error('同步能力声明里没有 ' + name)
    }
    await resetPage(page, '#/data-statistics')
    await page.locator('[data-testid=data-statistics-query]').first().click()
    await page.waitForTimeout(5000)
    const body = await mainText(page)
    await snap(page, 'L2-B2-platform-data')
    // 用主内容区而不是整页 body：数据中心筛选与账号行必须真的渲染出来。
    if (!body.includes('账号筛选'))
      throw new Error('数据中心没有账号筛选：' + body.slice(0, 140))
    for (const account of accounts) {
      if (!body.includes(account.nickname))
        throw new Error('数据中心没有渲染账号「' + account.nickname + '」')
    }
    return '平台元数据 ' + list.length + ' 个 + 两个平台能力声明 + 数据中心账号筛选（' + accounts.length + ' 个账号）'
  })

  await step('L2-C1', '对话+任务区内协同', async () => {
    await resetPage(page, '#/draft-box')
    const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
    await input.fill('区内协同：用一句话说明你能做什么。')
    await page.locator('[data-testid=ai-assistant-sidebar] button[aria-label="发送"]').last().click()
    let reply = ''
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(2500)
      const side = await text(page, '[data-testid=ai-assistant-sidebar]')
      const idx = side.indexOf('区内协同：用一句话说明你能做什么。')
      reply = idx >= 0 ? side.slice(idx + 20) : side
      if (reply.length > 30 && !/正在(思考|生成)/.test(reply))
        break
    }
    await snap(page, 'L2-C1-chat-task')
    if (/未配置任何大模型|未接入任何大模型|还没有配置大模型|没有配置大模型|请先.{0,16}配置大模型|大模型调用失败|内置模板/.test(reply))
      throw new Error('回复是模板：' + reply.slice(0, 120))
    await resetPage(page, '#/tasks-history')
    const tasks = await text(page)
    if (!/区内协同|已完成|进行中/.test(tasks))
      throw new Error('任务列表没有这次对话：' + tasks.slice(0, 120))
    return '对话真实回复 + 任务入列'
  })

  await step('L2-C2', '热点+接待区内协同', async () => {
    await resetPage(page, '#/ai-interaction')
    const hot = await text(page)
    if (!/热点|热榜/.test(hot))
      throw new Error('热点页没渲染')
    await resetPage(page, '#/accounts')
    const rules = await text(page)
    await snap(page, 'L2-C2-reception-area')
    if (!/接待规则|推荐模板|测试接待/.test(rules))
      throw new Error('账号页接待区缺失')
    const tpl = page.locator('button').filter({ hasText: /报价咨询/ }).first()
    await tpl.click()
    await page.waitForTimeout(2500)
    const form = await text(page)
    await page.keyboard.press('Escape')
    if (!/关键词|规则|回复/.test(form))
      throw new Error('模板没有带出表单')
    return '热点渲染 + 接待模板带出表单'
  })

  await step('L2-C3', '知识库+监控区内协同', async () => {
    await resetPage(page, '#/knowledge')
    const name = '区级笔记' + Date.now().toString().slice(-5)
    const keyword = '区级协同关键词' + Date.now().toString().slice(-4)
    await page.locator('button').filter({ hasText: /新建笔记/ }).first().click()
    await page.waitForTimeout(2000)
    await page.locator('input[placeholder*="名称"]').first().fill(name)
    await page.locator('button').filter({ hasText: /^创建|确定/ }).first().click()
    await page.waitForTimeout(3500)
    const editor = page.locator('textarea, [contenteditable=true]').last()
    if (await editor.count() > 0) {
      await editor.click()
      await editor.fill('本笔记用于验证注入：' + keyword).catch(() => {})
      await page.waitForTimeout(600)
      const save = page.locator('button').filter({ hasText: /^保存/ }).first()
      if (await save.count() > 0)
        await save.click()
      await page.waitForTimeout(3000)
    }
    // 注入预览：用关键词检索，应命中该笔记
    // 接口字段是 query（不是 instruction）：传错字段会静默返回空命中。
    const preview = await (await fetch(BASE + 'api/knowledge/inject-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: keyword }),
    })).json()
    assertNoAsciiFallback('L2-C3 注入预览回读的笔记路径', name, (preview.data?.paths ?? []).join(','))
    await fetch(BASE + 'api/knowledge/notes/' + encodeURIComponent(name + '.md'), { method: 'DELETE' }).catch(() => {})
    await resetPage(page, '#/monitor')
    // 参数区在折叠面板里：折叠时「保存参数」按钮根本不挂载，必须按用户操作先展开。
    await expandEngineParamsPanel(page)
    await page.locator('button').filter({ hasText: /保存参数/ }).first().click()
    await page.waitForTimeout(3000)
    const monitor = await text(page)
    await snap(page, 'L2-C3-knowledge-monitor')
    if (!(preview.data?.paths ?? []).some(p => String(p).includes(name)))
      throw new Error('注入预览没有命中刚建的笔记：' + JSON.stringify(preview.data).slice(0, 160))
    if (!/轮询|接待|参数/.test(monitor))
      throw new Error('监控页参数区缺失')
    return '知识笔记被注入预览命中 + 监控参数可保存'
  })

  // ==================== L3：核心板块级 ====================
  layerGate(2)

  await step('L3-A', '内容创作主链路：生成→草稿→详情→发布预填', async () => {
    await resetPage(page, '#/draft-box')
    const box = page.locator('[data-testid=draftbox-ai-prompt-input]').first()
    await box.fill('核心链路：重庆洪崖洞夜景 8 秒短视频')
    await page.locator('[data-testid=draftbox-ai-submit-btn]').click()
    let appeared = false
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000)
      const body = await text(page)
      if (/洪崖洞|夜景/.test(body))
        { appeared = true; break }
    }
    await snap(page, 'L3-A-generated')
    if (!appeared)
      throw new Error('生成 5 分钟未见草稿')
    await page.locator('button').filter({ hasText: /^草稿/ }).first().click()
    await page.waitForTimeout(4000)
    const card = page.locator('[data-testid=draftbox-draft-card]').first()
    await card.click({ timeout: 15000 })
    await page.waitForTimeout(3000)
    await page.locator('[data-testid=draftbox-detail-publish-btn]').first().click()
    await page.waitForTimeout(8000)
    const info = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=publish-dialog-container]')
      if (!d) return { none: true }
      const editor = d.querySelector('[data-testid=publish-content-editor]')
      return {
        editorText: (editor?.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
        accounts: d.querySelectorAll('[data-testid^="publish-account-item-"]').length,
      }
    })
    await snap(page, 'L3-A-publish-prefill')
    await closePublishDialog(page)
    if (info.none)
      throw new Error('发布弹窗没打开')
    if ((info.editorText ?? '') === '' && info.accounts === 0)
      throw new Error('发布弹窗没有预填内容也没有账号')
    return '生成→草稿→详情→发布预填 全链路通'
  })

  await step('L3-B', '账号管理主链路：连接→分组→刷新→数据完好', async () => {
    const before = await listAccounts()
    const beforeGroups = await listGroups()
    await resetPage(page, '#/accounts')
    await page.locator('[data-testid=sidebar-account-entry]').click()
    await page.waitForTimeout(3000)
    await waitNoticesClear(page)
    await page.locator('[data-testid=cm-refresh-all-fans-btn]').first().click()
    // 主链路上的"刷新"必须有可见反馈，不能只看它没把页面点崩。
    const notice = await waitForNotice(page, /粉丝数刷新完成|刷新间隔内|刷新间隔为 1 小时|刷新任务已提交|刷新失败/, 30000)
    if (/刷新失败/.test(notice))
      throw new Error('主链路刷新粉丝数报错：' + notice)
    const name = '核心组' + Date.now().toString().slice(-5)
    await page.locator('[data-testid=cm-create-space-btn]').first().click()
    await page.waitForTimeout(1000)
    await page.locator('[data-testid=cm-create-space-input]').fill(name)
    await page.locator('[data-testid=cm-create-space-confirm]').click()
    await page.waitForTimeout(3000)
    // 主链路创建的分组必须先落库，再谈删除
    const created = (await listGroups()).find(group => group.name === name)
    if (created === undefined)
      throw new Error('主链路新建分组没有落库：' + name)
    const space = page.locator('[data-testid=cm-space-item]', { hasText: name }).first()
    await space.locator('[data-testid=cm-space-more-menu]').click()
    await page.waitForTimeout(900)
    await page.locator('[role=menuitem]:has-text("删除")').first().click()
    await page.waitForTimeout(900)
    const confirm = page.locator('[data-testid=cm-delete-confirm-btn]').first()
    if (await confirm.count() > 0)
      await confirm.click()
    await page.waitForTimeout(3000)
    await snap(page, 'L3-B-account-chain')
    await page.keyboard.press('Escape')
    const after = await listAccounts()
    const afterGroups = await listGroups()
    const beforeIds = before.map(account => account.id).sort().join(',')
    const afterIds = after.map(account => account.id).sort().join(',')
    if (beforeIds !== afterIds)
      throw new Error('账号在链路中被改动：' + beforeIds + ' -> ' + afterIds)
    if (beforeGroups.length !== afterGroups.length)
      throw new Error('分组数量变化异常：' + beforeGroups.length + ' -> ' + afterGroups.length)
    if (!afterGroups.some(group => group.isDefault))
      throw new Error('默认分组丢失')
    // 数据不能被链路改坏：粉丝/作品数与开始前一致（时间戳允许前进）
    for (const account of before) {
      const current = after.find(item => item.id === account.id)
      if (current?.fansCount !== account.fansCount || current?.workCount !== account.workCount)
        throw new Error('账号数据被链路改动：' + account.id + ' ' + account.fansCount + '/' + account.workCount + ' -> ' + String(current?.fansCount) + '/' + String(current?.workCount))
    }
    return '刷新反馈「' + notice + '」；账号 ' + afterIds + ' 全程不变，分组回到初始 ' + afterGroups.length + ' 个'
  })

  await step('L3-C', 'AI 智能体主链路：对话→动作卡→任务记录', async () => {
    await resetPage(page, '#/draft-box')
    const baseline = await (await fetch(BASE + 'api/agent/tasks?pageNo=1&pageSize=1')).json().catch(() => null)
    const baselineId = (baseline?.data?.list ?? [])[0]?.id ?? ''
    await disableFollowMode(page)
    const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
    await input.fill('帮我写一条抖音短视频文案：重庆火锅探店，20 秒，标题不超过 15 字。')
    await page.locator('[data-testid=ai-assistant-sidebar] button[aria-label="发送"]').last().click()
    // 必须等"这一次"的任务真正跑完（首屏可能先出现一句寒暄），以任务接口为准。
    let reply = ''
    let hasCard = false
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(3000)
      const side = await text(page, '[data-testid=ai-assistant-sidebar]')
      if (/去发布|准备发布/.test(side))
        hasCard = true
      const tasks = await (await fetch(BASE + 'api/agent/tasks?pageNo=1&pageSize=1')).json().catch(() => null)
      const latest = (tasks?.data?.list ?? [])[0]
      if (latest === undefined || latest.id === baselineId)
        continue
      if (latest.status === 'running' || latest.status === 'pending')
        continue
      const detail = await (await fetch(BASE + 'api/agent/tasks/' + latest.id + '/messages')).json().catch(() => null)
      const msgs = detail?.data?.messages ?? detail?.data?.list ?? []
      reply = msgs.filter(m => m.type === 'assistant').map(m => m.content || '').join('\n')
      if (reply !== '')
        break
    }
    await snap(page, 'L3-C-agent')
    if (/未配置任何大模型|未接入任何大模型|还没有配置大模型|没有配置大模型|请先.{0,16}配置大模型|大模型调用失败|内置模板/.test(reply))
      throw new Error('智能体回复是模板：' + reply.slice(0, 120))
    // 账号不可用或素材生成失败时，智能体必须如实说明而不是给动作卡——两条路都算通过，
    // 但"既没动作卡也没有任何解释"是失败。
    const honest = /登录已失效|重新扫码|扫码登录|需要重新登录|尚未绑定|请先登录|未绑定|素材生成未完成|暂未提供「去发布」/.test(reply)
    if (!hasCard && !honest)
      throw new Error('既没有动作卡也没有如实说明：' + reply.slice(-160))
    await resetPage(page, '#/tasks-history')
    const tasks = await text(page)
    if (!/重庆火锅|已完成|进行中/.test(tasks))
      throw new Error('任务记录里没有本次智能体任务')
    return (hasCard ? '动作卡已出现' : '智能体如实说明原因（未给动作卡）') + ' + 任务入列'
  })

  // ==================== L4：整体集成 ====================
  layerGate(3)

  await step('L4-1', '智能体动作 → 内容创作发布弹窗联动', async () => {
    // 自包含：先开新对话，避免命中 L3-C 遗留的旧动作卡（旧卡点开只会改 URL、不再弹窗）。
    await resetPage(page, '#/draft-box')
    await dismissOverlays(page)
    const newChat = page.locator('[data-testid=ai-assistant-sidebar] button').filter({ hasText: /新对话/ }).first()
    if (await newChat.count() > 0) {
      await newChat.click().catch(() => {})
      await page.waitForTimeout(2500)
    }
    let card = page.locator('button, [role=button]').filter({ hasText: /去发布/ }).first()
    const baseline = await (await fetch(BASE + 'api/agent/tasks?pageNo=1&pageSize=1')).json().catch(() => null)
    const baselineId = (baseline?.data?.list ?? [])[0]?.id ?? ''
    if (await card.count() === 0) {
      await resetPage(page, '#/draft-box')
      await disableFollowMode(page)
      const input = page.locator('[data-testid=ai-assistant-sidebar] textarea, [data-testid=ai-assistant-sidebar] input').first()
      // 用图文请求（不触发视频素材生成），让动作卡不受"视频生成失败"影响，验证链路本身。
      await input.fill('帮我写一篇小红书图文笔记：集成测试·重庆小面探店，标题不超过 15 字，写好后准备发布。')
      await page.locator('[data-testid=ai-assistant-sidebar] button[aria-label="发送"]').last().click()
      // 以任务接口为准等待"这一次"的任务产出助手正文（前端渲染可能滞后）。
      let polled = 0
      for (let i = 0; i < 300; i++) {
        await page.waitForTimeout(3000)
        polled = i + 1
        const side = await text(page, '[data-testid=ai-assistant-sidebar]')
        if (i % 10 === 0)
          console.log('  [L4-1 poll ' + polled + '] card=' + (/去发布|准备发布/.test(side) ? 'yes' : 'no') + ' sidebarLen=' + side.length)
        const tasks = await (await fetch(BASE + 'api/agent/tasks?pageNo=1&pageSize=1')).json().catch(() => null)
        const latest = (tasks?.data?.list ?? [])[0]
        if (latest === undefined || latest.id === baselineId)
          continue
        if (latest.status === 'running' || latest.status === 'pending')
          continue
        const detail = await (await fetch(BASE + 'api/agent/tasks/' + latest.id + '/messages')).json().catch(() => null)
        const msgs = detail?.data?.messages ?? detail?.data?.list ?? []
        if (i % 10 === 0)
          console.log('  [L4-1 poll ' + polled + '] task=' + latest.id + ' status=' + latest.status + ' msgs=' + msgs.length)
        if (msgs.some(m => m.type === 'assistant' && (m.content || '').length > 0))
          break
      }
      card = page.locator('button, [role=button]').filter({ hasText: /去发布/ }).first()
    }
    if (await card.count() === 0) {
      // 账号登录失效时，智能体应当明确拒绝发布而不是给出动作卡——这也是正确行为。
      const tasks = await (await fetch(BASE + 'api/agent/tasks?pageNo=1&pageSize=1')).json()
      const latest = (tasks.data?.list ?? []).find(t => t.id !== baselineId) ?? (tasks.data?.list ?? [])[0]
      const detail = latest ? await (await fetch(BASE + 'api/agent/tasks/' + latest.id + '/messages')).json() : null
      const msgs = detail?.data?.messages ?? detail?.data?.list ?? []
      const reply = msgs.map(m => m.content || '').join('\n')
      console.log('  [L4-1 诊断] task=' + (latest?.id ?? '-') + ' status=' + (latest?.status ?? '-') + ' msgs=' + msgs.length + ' replyLen=' + reply.length)
      await snap(page, 'L4-1-no-card')
      // 账号不可用（登录失效 / 目标平台未绑定）时，智能体必须如实拒绝并给出下一步，而不是给动作卡。
      if (/登录已失效|重新扫码|扫码登录|需要重新登录|尚未绑定|请先登录|未绑定/.test(reply))
        return '账号不可用，智能体如实拒绝发布并给出下一步（未给动作卡，符合预期）'
      throw new Error('智能体没有给出「去发布」动作卡；任务回复尾部：' + reply.slice(-200))
    }
    await card.click({ timeout: 15000, noWaitAfter: true }).catch(async () => {
      // 点击后弹层可能立刻出现导致动作性检查失败，再兜底点一次。
      await card.dispatchEvent('click').catch(() => {})
    })
    // 动作卡会先跳转到 ?aiPublish=1，发布弹窗再异步拉数据渲染：必须轮询等待。
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000)
      const ready = await page.evaluate(() => !!document.querySelector('[data-testid=publish-dialog-container]'))
      if (ready)
        break
    }
    const state = await page.evaluate(() => {
      const d = document.querySelector('[data-testid=publish-dialog-container]')
      return {
        url: location.href,
        dialog: !!d,
        accounts: d ? d.querySelectorAll('[data-testid^="publish-account-item-"]').length : 0,
        editor: d ? (d.querySelector('[data-testid=publish-content-editor]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : '',
      }
    })
    await snap(page, 'L4-1-agent-publish')
    await closePublishDialog(page)
    await dismissOverlays(page)
    if (!state.dialog)
      throw new Error('动作卡没有打开发布弹窗（url=' + state.url + '）')
    if (state.accounts === 0 && state.editor === '')
      throw new Error('发布弹窗既没有账号也没有内容')
    return '动作卡→发布弹窗：账号 ' + state.accounts + ' 个，内容 ' + (state.editor ? '已预填' : '空')
  })

  await step('L4-2', '知识库 → 生成注入联动', async () => {
    const name = '集成笔记' + Date.now().toString().slice(-5)
    const keyword = '集成注入关键词' + Date.now().toString().slice(-4)
    // 正确契约：POST {name} 建笔记 → PUT {content} 写正文。
    const created = await (await fetch(BASE + 'api/knowledge/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })).json()
    const notePath = created.data?.path ?? name + '.md'
    await fetch(BASE + 'api/knowledge/notes/' + encodeURIComponent(notePath), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# ' + name + '\n\n' + keyword + '：本产品的售后电话是 400-000-0000。' }),
    })
    await page.waitForTimeout(1500)
    const hit = await (await fetch(BASE + 'api/knowledge/inject-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: keyword }),
    })).json()
    await snap(page, 'L4-2-knowledge-inject')
    await fetch(BASE + 'api/knowledge/notes/' + encodeURIComponent(notePath), { method: 'DELETE' }).catch(() => {})
    assertNoAsciiFallback('L4-2 知识笔记名回读', name, String(created.data?.name ?? ''))
    assertNoAsciiFallback('L4-2 注入预览命中的笔记', name, (hit.data?.paths ?? []).join(','))
    const paths = hit.data?.paths ?? []
    if (!paths.some(p => String(p).includes(name)))
      throw new Error('注入预览没有命中知识笔记：' + JSON.stringify(hit.data).slice(0, 160))
    return '命中 ' + paths.length + ' 篇，含新建笔记'
  })

  await step('L4-3', '账号状态 → 内容创作/发布联动', async () => {
    // 先清掉上一步可能残留的弹层（发布弹窗/发布结果弹窗都是异步渲染的），避免遮罩挡住后续点击。
    await closePublishDialog(page).catch(() => {})
    await dismissOverlays(page)
    const accounts = await (await fetch(BASE + 'api/v2/channels/accounts')).json()
    const acc = (accounts.data?.list ?? [])[0]
    if (acc === undefined)
      throw new Error('账号库为空')
    await resetPage(page, '#/draft-box')
    // 创作页目标平台按白名单展示（不点弹层，避免被浮层遮挡导致动作性检查失败）。
    const composer = await text(page)
    const pill = composer.match(/(\d+)\s*个平台/)?.[0] ?? ''
    const allowed = await (await fetch(BASE + 'api/v2/channels/platforms')).json()
    const allowedNames = (allowed.data ?? [])
      .filter(p => p.capabilities?.publish?.supported === true && p.capabilities?.auth?.supported === true)
      .map(p => p.displayName?.['zh-CN'] ?? p.platform)
    await snap(page, 'L4-3-account-link-before-publish')
    await page.locator('button:has-text("一键发布")').first().click()
    await page.waitForTimeout(8000)
    const publishText = await text(page)
    await snap(page, 'L4-3-account-link')
    await closePublishDialog(page)
    if (pill === '')
      throw new Error('创作页没有显示目标平台数量')
    if (!allowedNames.some(n => composer.includes(n)))
      throw new Error('创作页目标平台与平台白名单不一致：' + allowedNames.join('/'))
    const offline = acc.loginState === 'invalid' || acc.status !== 1
    if (offline && !/账号存在问题|重新授权|登录|离线/.test(publishText))
      throw new Error('账号异常时发布弹窗没有任何提示')
    return '账号状态=' + (acc.loginState ?? acc.status) + '，创作页白名单与发布提示联动正常'
  })

  await step('L4-4', '设置模型 → 对话模型联动', async () => {
    const cfg = await (await fetch(BASE + 'api/ai/user-llm')).json()
    const configured = cfg.data?.model ?? ''
    const chat = await (await fetch(BASE + 'api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '只回答一个词：你当前使用的模型名称。' }] }),
    })).json()
    await snap(page, 'L4-4-model-link')
    const reply = chat.choices?.[0]?.message?.content ?? ''
    if (configured === '')
      throw new Error('设置里没有配置模型')
    if (/未配置|未接入任何大模型|还没有配置大模型|大模型调用失败/.test(reply))
      throw new Error('对话没有真正走到配置的模型：' + reply.slice(0, 120))
    return '配置模型 ' + configured + '，对话返回模型 ' + (chat.model ?? '?')
  })

  layerGate(4)
}
finally {
  await browser.close()
}

const report = { platform: PLATFORM, realPublish: REAL_PUBLISH, results, blockers, apiFailures, pageErrors, toasts, wantLayer: WANT_LAYER, stoppedAtLayer, at: new Date().toISOString() }
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

console.log('\n=== 分层结果（L1 小功能点 → L2 小功能区 → L3 核心板块 → L4 整体集成） ===')
const LAYER_NAME = { 1: '小功能点', 2: '小功能区', 3: '核心板块', 4: '整体集成' }
let layerGateOk = true
for (const layer of [1, 2, 3, 4]) {
  const items = results.filter(item => item.layer === layer)
  if (items.length === 0)
    continue
  const ok = items.filter(item => item.ok).length
  console.log(`  L${layer} ${LAYER_NAME[layer]}: ${ok}/${items.length} 通过`)
  if (ok !== items.length)
    layerGateOk = false
}
console.log(layerGateOk && stoppedAtLayer === 0 ? 'LAYER_GATE PASS（逐层通过）' : `LAYER_GATE FAIL（L${stoppedAtLayer || '?'} 中断）`)

console.log('\n=== 按三大核心功能汇总 ===')
for (const core of ['A', 'B', 'C', 'D']) {
  const items = results.filter(item => CORE_OF[item.id] === core)
  if (items.length === 0)
    continue
  const ok = items.filter(item => item.ok).length
  console.log(`  ${core} ${CORE_NAME[core]}: ${ok}/${items.length} 通过`)
}
console.log('\n=== BLOCKERS ' + blockers.length + ' ===')
for (const item of blockers)
  console.log(`  ${item.id} ${item.name}: ${item.detail}`)
console.log('API_FAILURES ' + apiFailures.length + (apiFailures.length ? ' :: ' + JSON.stringify(apiFailures.slice(0, 8)) : ''))
console.log('PAGE_ERRORS ' + pageErrors.length + (pageErrors.length ? ' :: ' + pageErrors.slice(0, 3).join(' | ') : ''))
console.log(`FULL_CHAIN ${blockers.length === 0 ? 'PASS' : 'FAIL'} checks=${results.length} blockers=${blockers.length}`)
process.exit(blockers.length === 0 ? 0 : 1)
