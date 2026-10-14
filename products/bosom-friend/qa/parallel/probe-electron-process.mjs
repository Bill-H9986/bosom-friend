#!/usr/bin/env node
/** 临时探测 Playwright ElectronApplication 是否暴露 process() 以便捕获子进程日志。 */
import { closeWorker, launchWorker, prepareWorker } from './parallel-lib.mjs'

const spec = { index: 98, port: 31408 }
const worker = prepareWorker(spec, { installRuntime: true })
const app = await launchWorker(spec, worker)
try {
  console.log('PROCESS_TYPE=' + typeof app.process)
  try {
    const proc = app.process()
    console.log('PROCESS_KEYS=' + Object.keys(proc).slice(0, 20).join(','))
    proc.stderr?.on('data', (chunk) => console.log('CHILD_ERR=' + chunk.toString().slice(0, 800)))
    proc.on('exit', (code) => console.log('CHILD_EXIT=' + code))
  } catch (error) {
    console.log('PROCESS_ERROR=' + String(error))
  }
  const page = await app.firstWindow()
  await page.waitForTimeout(12000)
  console.log('KERNEL=' + JSON.stringify(await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)))
  await page.waitForTimeout(12000)
  console.log('KERNEL2=' + JSON.stringify(await page.evaluate(() => window.bosomKernel?.getStatus?.() ?? null).catch(() => null)))
} finally {
  await closeWorker(app)
}
