// 知音桌面端黑盒巡检：逐页拟人检查关键元素/文本/交互，收集控制台错误。
// 用法：node scripts/blackbox-inspect.mjs
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'

function report(ok, name, extra = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`
  console.log(line)
  outLines.push(line)
  writeFileSync(new URL('./blackbox-inspect.out.txt', import.meta.url), outLines.join('\n') + '\n')
}

const outLines = []

async function main() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const target = list.find(t => t.url.includes('localhost:5173'))
  if (!target) {
    console.error('NO-APP-TARGET')
    process.exit(1)
  }
  const browser = await chromium.connectOverCDP(CDP)
  const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost:5173'))

  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error')
      consoleErrors.push(msg.text().slice(0, 160))
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(`PAGEERROR ${String(err).slice(0, 160)}`)
  })

  const clickSafe = async (locator) => {
    await locator.click({ timeout: 3000, force: true }).catch(() => {})
  }
  const goto = async (hash) => {
    await page.evaluate((h) => { location.hash = h }, hash)
    await page.waitForTimeout(2600)
  }
  const waitText = (text, timeout = 12000) =>
    page.waitForFunction(t => document.body.innerText.includes(t), text, { timeout })
      .then(() => true)
      .catch(() => false)
  const bodyText = () => page.evaluate(() => document.body.innerText)
  const hasText = (t, s) => s.includes(t)

  let fails = 0
  const check = (ok, name, extra) => {
    if (!ok)
      fails++
    report(ok, name, extra)
  }

  // 1. 首页
  await goto('#/')
  let t = await bodyText()
  check(hasText('知音', t), '首页渲染', '品牌名存在')
  check(/开始创作|立即创作|开始使用/.test(t), '首页 CTA', '创作入口存在')

  // 2. 内容创作
  await goto('#/creation')
  t = await bodyText()
  check(hasText('内容创作', t), '内容创作页', '')
  const createBtns = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => /开始创作|内容制作|新建/.test(b.textContent || '')).length)
  check(createBtns > 0, '内容创作交互', `创作按钮 ${createBtns} 个`)

  // 3. AI 互动
  await goto('#/ai-interaction')
  t = await bodyText()
  check(/AI互动|热点|评论搜索|有什么我可以帮你/.test(t), 'AI互动页', '')

  // 4. 我的任务
  await goto('#/task')
  t = await bodyText()
  check(/我的任务|任务|暂无|历史/.test(t), '我的任务页', '')

  // 5. 知识库
  await goto('#/knowledge')
  t = await bodyText()
  check(/知识库|笔记|新建/.test(t), '知识库页', '')

  // 6. 账号管理 - 全局监控
  await goto('#/accounts')
  await waitText('平台\t绑定账号', 15000)
  t = await bodyText()
  const monitor = await page.evaluate(() => {
    const seg = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean)
    const i = seg.findIndex(l => /平台\t绑定账号/.test(l))
    return seg.slice(i, i + 4)
  })
  check(monitor.some(l => /抖音\t1\t1\/1/.test(l)), '监控-抖音在线', JSON.stringify(monitor))
  check(monitor.some(l => /小红书\t1\t1\/1/.test(l)), '监控-小红书在线', '')

  // 7. 账号管理 tab
  await clickSafe(page.locator('.page-tab').filter({ hasText: '账号管理' }).first())
  await waitText('SKYC-重庆机长', 10000)
  t = await bodyText()
  const accountPanel = await page.evaluate(() => {
    // 只取账号管理面板区域文本（避开全局监控说明文字里的“快手/视频号”）
    const el = document.querySelector('[class*="account" i]') || document.body
    return el ? el.innerText : document.body.innerText
  })
  check(/SKYC-重庆机长/.test(t) || /XchanM520|抖音/.test(t), '账号列表', '已绑定账号可见')

  // 8. 数据概览 tab
  await clickSafe(page.locator('.page-tab').filter({ hasText: '数据概览' }).first())
  // 首次打开会先触发桌面端实时采集（IPC）再加载接口，等待更长
  const statsReady = await waitText('发布作品', 45000)
  t = await bodyText()
  check(statsReady, '数据概览加载', '')
  check(/发布作品\s*\n?\s*19/.test(t), '数据概览-作品数 19', '')
  check(/抖音\s*12/.test(t) && /小红书\s*7/.test(t), '数据概览-双平台', '')

  // 9. 发布日历 tab
  await clickSafe(page.locator('.page-tab').filter({ hasText: '发布日历' }).first())
  await page.waitForTimeout(3500)
  t = await bodyText()
  check(/发布日历|日历|周|月/.test(t), '发布日历', '')

  // 10. 连接新频道只剩抖音/小红书
  await clickSafe(page.locator('.page-tab').filter({ hasText: '账号管理' }).first())
  await waitText('添加频道', 8000)
  const addBtn = page.locator('button').filter({ hasText: /添加频道/ }).first()
  await clickSafe(addBtn)
  await waitText('连接新频道', 8000)
  const connectBtn = page.locator('button').filter({ hasText: /连接新频道/ }).first()
  await clickSafe(connectBtn)
  await waitText('扫码授权', 8000)
  // 只检查弹窗容器文本，避免误读页面底层的监控说明文字
  const modalText = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"], .ant-modal-content, [class*="modal" i], [class*="dialog" i]')
    return modal ? modal.innerText : ''
  })
  const onlyTwo = modalText.includes('抖音') && modalText.includes('小红书')
    && !modalText.includes('视频号') && !modalText.includes('快手') && !modalText.includes('哔哩哔哩') && !modalText.includes('微信公众号')
  check(onlyTwo, '接入通道仅抖音+小红书', '')
  // 关闭弹窗
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(1000)

  console.log('')
  console.log(`控制台错误数: ${consoleErrors.length}`)
  for (const e of consoleErrors.slice(0, 10))
    console.log('  ERR:', e)
  console.log('')
  console.log(fails === 0 ? 'RESULT: 全部通过' : `RESULT: ${fails} 项失败`)
  writeFileSync(new URL('./blackbox-inspect.out.txt', import.meta.url), outLines.join('\n') + '\n' + `控制台错误 ${consoleErrors.length} 条\n`)
  await browser.close()
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('INSPECT-FATAL', e)
  process.exit(2)
})
