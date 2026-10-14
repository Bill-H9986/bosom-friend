#!/usr/bin/env node
/** 临时诊断：免责声明的真实 DOM 与可点击性。 */
import { closeWorker, launchWorker, prepareWorker } from './parallel-lib.mjs'

const spec = { index: 97, port: 31409 }
const worker = prepareWorker(spec, { installRuntime: true })
const app = await launchWorker(spec, worker)
try {
  const page = await app.firstWindow()
  await page.waitForTimeout(6000)
  const dom = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter((el) => (el.textContent || '').includes('免责声明'))
      .map((el) => ({
        html: el.outerHTML.slice(0, 400),
        buttons: Array.from(el.querySelectorAll('button')).map((b) => ({
          text: (b.textContent || '').replace(/\s+/g, ' ').trim(),
          disabled: b.disabled,
          visible: b.getBoundingClientRect().height > 0,
        })),
      }))
    return { dialogs, body: document.body.innerText.slice(0, 500) }
  })
  console.log('DISCLAIMER_DOM=' + JSON.stringify(dom))
  const agree = page.locator('[role="dialog"] button').filter({ hasText: '我已阅读并同意' }).first()
  console.log('AGREE_COUNT=' + await agree.count())
  if (await agree.count() > 0) {
    await agree.click({ timeout: 5000 }).catch((e) => console.log('AGREE_CLICK_ERR=' + String(e).slice(0, 300)))
    await page.waitForTimeout(800)
    console.log('AFTER_AGREE=' + JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] button')).map((b) => ({ text: b.textContent?.replace(/\s+/g, ' ').trim(), disabled: b.disabled })))))
  }
} finally {
  await closeWorker(app)
}
