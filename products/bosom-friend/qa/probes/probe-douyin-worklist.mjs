/**
 * 抖音作品列表原始响应探针（只读）：抓创作者中心 content-manage 页自己发的 work_list 响应，
 * 看清 statistics 里到底有没有 play_count（播放量）。不改数据、不发布。
 * 用法：node products/bosom-friend/qa/probes/probe-douyin-worklist.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const syncRoot = join(homedir(), '.bosom-friend', 'bosom-friend', 'platform-login', 'sync')
const dirs = readdirSync(syncRoot).map(name => ({ name, path: join(syncRoot, name), mtime: statSync(join(syncRoot, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)
let storagePath = null
for (const dir of dirs) {
  const file = join(dir.path, 'storage.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(parsed.cookies) && parsed.cookies.some(c => String(c.domain ?? '').includes('douyin'))) { storagePath = file; console.log('storage: ' + dir.name + ' cookies=' + parsed.cookies.length); break }
  }
  catch { /* 跳过非浏览器存储 */ }
}
if (storagePath === null) { console.log('NO_DOUYIN_STORAGE'); process.exit(0) }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ storageState: storagePath })
const page = await context.newPage()
const captured = []
page.on('response', (response) => {
  if (response.url().includes('/janus/douyin/creator/pc/work_list')) captured.push(response)
})
await page.goto('https://creator.douyin.com/creator-micro/content/manage', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(9000)
for (let i = 0; i < 2; i++) { await page.evaluate('window.scrollTo(0, document.body.scrollHeight)'); await page.waitForTimeout(3000) }

console.log('captured work_list responses: ' + captured.length)
for (const [index, response] of captured.entries()) {
  const data = await response.json().catch(() => null)
  const items = data?.aweme_list ?? data?.item_info_list ?? []
  console.log('\n--- response ' + index + ' items=' + items.length + ' url=' + response.url().slice(0, 120))
  for (const raw of items.slice(0, 2)) {
    console.log('  item keys: ' + Object.keys(raw).join(','))
    const stats = raw.statistics ?? {}
    console.log('  statistics: ' + JSON.stringify(stats))
  }
}
await browser.close()
