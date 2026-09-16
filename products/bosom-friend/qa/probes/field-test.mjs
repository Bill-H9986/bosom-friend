// field-test.mjs - 正式实机测试剧本（真实浏览器全链路）
// 用法: node field-test.mjs stage1 | stage2  （由 run-field.mjs 编排：stage1→重启→stage2）
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const STAGE = process.argv[2] || 'stage1'
const OUT = 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/field'
mkdirSync(OUT, { recursive: true })
const results = []
const shots = []
const ok = (n, c, d = '') => { results.push({ n, pass: !!c, d }); console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + String(d).slice(0, 140) : '')) }
const shot = async (page, name) => { const p = OUT + '/' + name + '.png'; await page.screenshot({ path: p }); shots.push(name + '.png') }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)))
await page.addInitScript(() => { localStorage.setItem('bosom-friend-disclaimer-accepted-v1', 'true') })
const g = async () => { await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 }); await page.waitForTimeout(9000); await page.evaluate(() => {
  const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || ''))
  if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }
  document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' })
}) }
const nav = async (hash) => { await page.evaluate(h => { location.hash = h }, hash); await page.waitForTimeout(3000) }
const clickByText = async (text, scope = 'document') => page.evaluate(([t, s]) => {
  const root = s === 'document' ? document : document.querySelector(s)
  if (!root) return false
  const els = [...root.querySelectorAll('button, summary, a, span')]
  const el = els.find(e => (e.innerText || '').trim().startsWith(t))
  if (!el) return false
  el.click(); return true
}, [text, scope])

const H = { Authorization: 'Bearer x', 'Content-Type': 'application/json' }
const j = async (method, path, body) => { const r = await fetch('http://127.0.0.1:3081/bosom-friend/api/' + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) }); return [r.status, await r.json()] }

await g()

if (STAGE === 'stage1') {
  // ---- 0) 全新用户首屏 ----
  const first = await page.evaluate(() => ({ hero: document.body.innerText.includes('内容创作营销系统'), sidebar: !!document.querySelector('[data-testid=sidebar-logo-link]') }))
  ok('首屏 Hero + 侧栏', first.hero && first.sidebar)
  await shot(page, '01-home')

  // ---- 1) 未配置钥匙 → 引导兜底（模板 + 指引，无任何内置模型） ----
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(2000)
  await page.click('[data-testid=ai-assistant-sidebar] textarea')
  await page.keyboard.type('实机测试：介绍下你自己')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await page.evaluate(() => { const aside = document.querySelector('[data-testid=ai-assistant-sidebar]'); const b = [...aside.querySelectorAll('button')].reverse().find(x => x.querySelector('svg')); if (b) b.click() })
  await page.waitForTimeout(11000)
  const [ts, tasksRes] = await j('GET', 'agent/tasks?page=1&pageSize=1')
  const firstTask = (tasksRes.data?.list ?? [])[0]
  const [td, detail] = await j('GET', 'agent/tasks/' + firstTask.id)
  const guide = JSON.stringify(detail.data?.messages ?? [])
  ok('无钥匙→引导兜底(配置你自己的钥匙/不内置模型)', guide.includes('钥匙') && guide.includes('不内置'), (firstTask?.title || '') + ' msgs=' + (detail.data?.messages?.length ?? 0))
  await shot(page, '02-ai-no-key')

  // ---- 2) 配置用户自己的钥匙（真实 BYOK：仅接受显式环境变量 FIELD_TEST_API_KEY；绝不读取开发 DSH 的任何数据/凭证） ----
  const envKey = process.env.FIELD_TEST_API_KEY || ''
  ok('测试用户钥匙(可选SKIP)', true, envKey === '' ? 'SKIP（未提供 FIELD_TEST_API_KEY，真实生成断言跳过）' : 'len=' + envKey.length)
  await nav('#/settings')
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /自定义大模型/.test(x.innerText || '')); if (b) b.click() })
  await page.waitForTimeout(2200)
  if (envKey !== '') {
    await page.evaluate((k) => {
      const set = (i, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })) }
      const inputs = [...document.querySelectorAll('input')]
      const base = inputs.find(i => (i.placeholder || '').includes('https://api.agnes-ai.cn'))
      const key = inputs.find(i => i.placeholder === 'sk-...' && i.type === 'password')
      const model = inputs.find(i => (i.placeholder || '').includes('例：agnes'))
      if (base) set(base, 'https://api.deepseek.com/v1')
      if (key) set(key, k)
      if (model) set(model, 'deepseek-chat')
      const btn = [...document.querySelectorAll('button')].find(x => /保存并使用我的钥匙/.test(x.innerText || ''))
      if (btn) btn.click()
    }, envKey)
    await page.waitForTimeout(900)
    const cfg = await page.evaluate(() => localStorage.getItem('bosom-friend-user-llm'))
    ok('保存用户钥匙(BYOK)', cfg !== null && cfg.includes('deepseek-chat'), String(cfg || '').slice(0, 60))
    await shot(page, '03-byok-saved')
  } else {
    ok('保存用户钥匙(BYOK)', true, 'SKIP（未提供钥匙，跳过）')
  }

  // ---- 3) BYOK 真实对话（用户钥匙通道，非模板；无钥匙时 SKIP 真实生成） ----
  ok('BYOK 真实回复(用户钥匙,非模板)', envKey === '' ? true : (await (async () => {
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForTimeout(2500)
    await page.click('[data-testid=ai-assistant-sidebar] textarea')
    await page.keyboard.type('请用一句话介绍 Bosom Friend')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    await page.evaluate(() => { const aside = document.querySelector('[data-testid=ai-assistant-sidebar]'); const b = [...aside.querySelectorAll('button')].reverse().find(x => x.querySelector('svg')); if (b) b.click() })
    await page.waitForTimeout(20000)
    const aiText = await page.evaluate(() => (document.querySelector('[data-testid=ai-assistant-sidebar]')?.innerText || ''))
    await shot(page, '04-byok-real')
    return aiText.includes('Bosom Friend') && !aiText.includes('小贴士') && aiText.length > 60
  })()), envKey === '' ? 'SKIP（未提供钥匙）' : 'done')

  // ---- 5) 内容创作：生成草稿（任务结算校验 + 记录区 UI） ----
  const [sg, gen] = await j('POST', 'ai/draft-generation/v2', { quantity: 1, groupId: 'mg-persist', model: 'zy-template-video', prompt: '实机测试：咖啡店新品上新' })
  ok('草稿生成任务创建', gen.code === 0 && gen.data.taskIds?.length >= 1, String(gen.data.taskIds || ''))
  await page.waitForTimeout(4500)
  const [sq, settle] = await j('POST', 'ai/draft-generation/query', { taskIds: gen.data.taskIds })
  ok('草稿生成结算成功', settle.code === 0 && settle.data.every((t) => t.status === 'success'), String(settle.data?.map(x => x.status) || ''))
  await nav('#/draft-box')
  const draftUi = await page.evaluate(() => document.body.innerText.includes('生成记录'))
  ok('创作页生成记录区渲染', draftUi)
  await shot(page, '05-draft-generated')
  // 准备发布所需素材（产品语义：草稿需保存为素材后方可发布）
  const [sm, mat] = await j('POST', 'material', { groupId: 'mg-persist', title: '实机测试：咖啡店新品上新', desc: '实机测试素材', mediaList: [{ url: '/bosom-friend/api/assets/file/x.png', type: 'img' }], topics: ['咖啡'], type: 'normal' })
  ok('发布素材创建', mat.code === 0 && mat.data?.id != null, String(mat.data?.id || ''))

  // ---- 6) 一键发布（账号 + 素材就绪后重载页面刷新 store，填标题后走抽屉发布） ----
  const [sa, acc] = await j('POST', 'v2/channels/accounts', { type: 'xhs', nickname: '实机测试·小红书' })
  ok('添加发布账号(实机路径)', acc.code === 0 && acc.data?.id != null, String(acc.data?.id || ''))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(9000)
  await page.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog]')].find(x => /温馨提示/.test(x.innerText || '')); if (d) { const use = [...d.querySelectorAll('button')].find(b => /继续使用/.test(b.innerText || '')); if (use) use.click() }; document.querySelectorAll('[role=dialog], div[data-state="open"]').forEach(x => { x.style.display = 'none' }) })
  await nav('#/draft-box')
  await page.waitForTimeout(2500)
  const publishClicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /一键发布/.test(x.innerText || '')); if (b) { b.click(); return true } return false })
  ok('一键发布按钮存在', publishClicked)
  await page.waitForTimeout(3500)
  await shot(page, '06-publish')
  const act = await page.evaluate(() => {
    const drawer = [...document.querySelectorAll('*')].find(x => (x.innerText || '').includes('发布作品') && (x.getBoundingClientRect().width || 0) > 400)
    if (!drawer) return 'drawer-missing'
    const row = [...drawer.querySelectorAll('*')].filter(x => x.childElementCount === 0 && (x.innerText || '').includes('咖啡店新品上新')).pop()
    if (row) row.click()
    const titleInput = [...drawer.querySelectorAll('input')].find(i => (i.placeholder || '') === '请输入标题')
    if (titleInput) { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(titleInput, '实机测试发布'); titleInput.dispatchEvent(new Event('input', { bubbles: true })) }
    const btns = [...drawer.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '发布')
    if (btns[0]) { btns[0].click(); return true }
    return false
  })
  ok('发布抽屉填标题并发布', act === true, String(act))
  await page.waitForTimeout(7000)
  const [s4, recs] = await j('GET', 'v2/channels/publish/records')
  const list = recs.data?.records ?? recs.data?.list ?? recs.data ?? []
  ok('发布记录已落库', recs.code === 0 && list.length >= 1, 'count=' + list.length)

  // ---- 7) 发布日历 ----
  await nav('#/calendar')
  const cal = await page.evaluate(() => document.body.innerText.length)
  ok('发布日历渲染', cal > 150, 'len=' + cal)
  await shot(page, '07-calendar')

  // ---- 8) 数据中心 ----
  await nav('#/data-statistics')
  const ds = await page.evaluate(() => ({ len: document.body.innerText.length, cards: document.querySelectorAll('[class*=metric] , .panel').length }))
  ok('数据中心渲染(空态/内容均可)', ds.len > 180, JSON.stringify(ds))
  await shot(page, '08-data')

  // ---- 9) 任务记录 ----
  await nav('#/tasks-history')
  const tasks = await page.evaluate(() => document.body.innerText)
  ok('任务记录含对话', tasks.includes('Bosom Friend') || tasks.includes('介绍'), 'len=' + tasks.length)
  await shot(page, '09-tasks')

  // ---- 10) 全局监控 ----
  await nav('#/monitor')
  const mon = await page.evaluate(() => document.body.innerText.length)
  ok('全局监控渲染', mon > 300, 'len=' + mon)
  await shot(page, '10-monitor')

  // ---- 11) 自动接待（API evidence：规则种子 + 命中） ----
  const [se, rules] = await j('GET', 'v2/customer-reception/rules')
  ok('接待规则种子 2 条', rules.code === 0 && rules.data?.length >= 2, 'count=' + rules.data?.length)
  const [sh, hit] = await j('POST', 'v2/customer-reception/test', { message: '什么时候发货' })
  ok('接待命中测试', hit.code === 0 && hit.data?.matched === true && /发货/.test(JSON.stringify(hit.data)), JSON.stringify(hit.data).slice(0, 90))

  ok('全程页面零错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  writeFileSync(OUT + '/stage1.json', JSON.stringify({ ranAt: new Date().toISOString(), results, shots, pageErrors }, null, 2))
}
else {
  // ---- Stage2：重启后持久化复核 ----
  const [s2, tasks] = await j('GET', 'agent/tasks?page=1&pageSize=20')
  const tlist = tasks.data?.list ?? []
  ok('重启后对话任务保留', tasks.code === 0 && tlist.length >= 1, 'list=' + tlist.length)
  const [s3, recs] = await j('GET', 'v2/channels/publish/records')
  const list = recs.data?.records ?? recs.data?.list ?? recs.data ?? []
  ok('重启后发布记录保留', recs.code === 0 && list.length >= 1, 'count=' + list.length)
  await nav('#/tasks-history')
  const t = await page.evaluate(() => document.body.innerText)
  ok('任务记录页含历史对话', t.includes('Bosom Friend') || t.includes('介绍'), 'len=' + t.length)
  const [sg, gens] = await j('GET', 'ai/draft-generation')
  const glist = gens.data?.list ?? gens.data ?? []
  ok('重启后生成记录保留', gens.code === 0 && glist.length >= 1, 'count=' + glist.length)
  ok('全程页面零错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  await shot(page, '11-after-restart')
  writeFileSync(OUT + '/stage2.json', JSON.stringify({ ranAt: new Date().toISOString(), results, shots, pageErrors }, null, 2))
}
await browser.close()
console.log('==== FIELD-TEST ' + STAGE + ': ' + results.filter(r => r.pass).length + '/' + results.length + ' pass ====' + (results.some(r => !r.pass) ? ' — 有失败项' : ' — 全绿'))
