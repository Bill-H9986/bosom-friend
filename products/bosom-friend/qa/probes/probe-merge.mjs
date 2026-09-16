// probe-merge.mjs - 合并弹窗验证
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto('http://127.0.0.1:3081/bosom-friend/', { waitUntil: 'networkidle', timeout: 180000 })
await page.waitForTimeout(9000)
const info = await page.evaluate(() => {
  const dialogs = [...document.querySelectorAll('[role=dialog]')].map(d => (d.innerText || '').slice(0, 60))
  const body = document.body.innerText
  return {
    dialogCount: dialogs.length,
    dialogs,
    hasDisclaimer: body.includes('Bosom Friend平台免责声明'),
    hasTestPhase: body.includes('测试阶段'),
    hasAgentNotice: body.includes('该 Agent 目前仍在测试阶段'),
    hasJifen: body.includes('积分'),
  }
})
console.log(JSON.stringify(info, null, 1))
await page.screenshot({ path: 'C:/Users/Jay/Desktop/Bosom friend APP/products/bosom-friend/qa/probes/merged-dialog.png' })
await browser.close()
console.log('DONE')
