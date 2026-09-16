#!/usr/bin/env node
/** 门槛8复测：清空可编辑区后输入，读回必须等于主题。 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const { _electron: electron } = require(join(repoRoot, 'node_modules', '.pnpm', 'playwright@1.61.1', 'node_modules', 'playwright', 'test'))

const app = await electron.launch({ executablePath: process.env.BF_DESKTOP_EXE || 'C:/Users/Jay/AppData/Local/Programs/Bosom Friend/Bosom Friend.exe' })
try {
  const p = await app.firstWindow()
  await p.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 300000 })
  await p.getByText('内容创作', { exact: true }).first().click()
  await p.waitForTimeout(2500)
  await p.locator('[data-testid="draftbox-ai-open-prompt-editor-btn"]').first().click()
  await p.waitForTimeout(800)
  const di = p.locator('[data-testid="draftbox-ai-prompt-dialog-input"]').first()
  await di.click()
  await p.keyboard.press('Control+A')
  await p.keyboard.press('Delete')
  const topic = '关于人社局无人机装调检修工程师就业免费培训'
  await p.keyboard.type(topic)
  const rb = (await di.innerText().catch(() => '')).trim()
  console.log('GATE8_RETEST_' + (rb === topic ? 'GREEN' : 'RED') + ' readBack=' + JSON.stringify(rb))
} finally {
  try {
    const w = app.windows()[0]
    if (w) await w.evaluate(() => { window.bosomFriend?.quit?.() }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
  } catch {}
  await app.close().catch(() => {})
}
