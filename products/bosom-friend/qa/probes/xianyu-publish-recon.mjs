#!/usr/bin/env node
/**
 * 闲鱼发布落地探针：一次扫码，把这个账号的"发闲置"真实表单结构 dump 出来。
 *
 * 为什么需要它：闲鱼网页版的发布是"发闲置商品"（图片+标题+描述+**价格**），
 * 与我们现有的 title/desc/media 模型不是一一对应。价格、分类、成色这些字段到底长什么样，
 * 只能看登录后的真实页面——猜着写适配器就是造假。
 *
 * 流程：起一次真实扫码登录 → 二维码写文件供人扫 → 登录成功后
 *   1) 保存 storage_state（后续发布复用）；
 *   2) 打开 /publish，dump 表单骨架（输入框/下拉/必填标记/按钮）到 JSON。
 *
 * 用法：node qa/probes/xianyu-publish-recon.mjs
 * 产物：qa/xianyu-recon/{qr.png,storage.json,publish-form.json,screenshot.png}
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChromium } from '../browser.mjs'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'xianyu-recon')
mkdirSync(OUT, { recursive: true })
const LOGIN_URL = 'https://passport.goofish.com/mini_login.htm?lang=zh_cn&appName=xianyu&appEntrance=web&styleType=vertical&bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false&qrCodeFirst=true&stie=77'
const chromium = loadChromium()

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
})
const page = await context.newPage()
console.log('OPEN ' + LOGIN_URL)
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

const frame = page.frames().find(f => f.url().includes('passport.goofish.com'))
if (!frame) {
  console.log('FAIL 登录框未加载')
  await browser.close()
  process.exit(1)
}
const canvas = await frame.waitForSelector('canvas', { timeout: 30000 })
let qrBytes = 0
for (let i = 0; i < 40; i += 1) {
  const shot = await canvas.screenshot()
  if (shot.length > 3000) {
    writeFileSync(join(OUT, 'qr.png'), shot)
    qrBytes = shot.length
    break
  }
  await new Promise(r => setTimeout(r, 800))
}
console.log('QR_BYTES=' + qrBytes + ' -> ' + join(OUT, 'qr.png'))
if (qrBytes === 0) {
  console.log('FAIL 二维码未渲染')
  await browser.close()
  process.exit(1)
}
console.log('WAITING_FOR_SCAN 用闲鱼 APP 扫 ' + join(OUT, 'qr.png') + '（' + Math.round(scanWindowMs / 60000) + ' 分钟内）')

// 扫码是人的动作，窗口必须可调：默认 5 分钟，等不及就 BF_XIANYU_SCAN_TIMEOUT_MS=900000 给 15 分钟。
const scanWindowMs = Number(process.env.BF_XIANYU_SCAN_TIMEOUT_MS ?? 300000) || 300000
const deadline = Date.now() + scanWindowMs
let loggedIn = false
while (Date.now() < deadline) {
  const cookies = await context.cookies()
  const unb = cookies.find(c => c.name === 'unb' && /^\d+$/.test(c.value))
  if (unb) { loggedIn = true; break }
  await new Promise(r => setTimeout(r, 1500))
}
if (!loggedIn) {
  console.log('FAIL 等待扫码超时')
  await browser.close()
  process.exit(1)
}
console.log('LOGIN_OK unb=' + (await context.cookies()).find(c => c.name === 'unb')?.value)
await context.storage_state({ path: join(OUT, 'storage.json') })

// 登录后 dump 发闲置表单：只读，不提交任何东西。
const publish = await context.newPage()
publish.on('response', () => {})
await publish.goto('https://www.goofish.com/publish', { waitUntil: 'domcontentloaded', timeout: 60000 })
await publish.waitForTimeout(8000)
const form = await publish.evaluate(() => {
  const pick = (el) => ({
    tag: el.tagName,
    type: el.getAttribute('type') || '',
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40),
    cls: (el.className || '').toString().slice(0, 80),
  })
  const labels = [...document.querySelectorAll('label')].map(el => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean)
  const inputs = [...document.querySelectorAll('input, textarea, select')].map(pick)
  const buttons = [...document.querySelectorAll('button')].map(el => (el.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30)
  const required = [...document.querySelectorAll('[class*=required], [aria-required=true]')].map(el => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean).slice(0, 20)
  const dropzones = [...document.querySelectorAll('[class*=upload], [class*=drop], input[type=file]')].map(pick)
  return { url: location.href, title: document.title, labels, inputs, buttons, required, dropzones, bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200) }
})
writeFileSync(join(OUT, 'publish-form.json'), JSON.stringify(form, null, 2), 'utf8')
await publish.screenshot({ path: join(OUT, 'screenshot.png'), fullPage: false })
console.log('PUBLISH_FORM -> ' + join(OUT, 'publish-form.json'))
console.log('BODY=' + form.bodyText.slice(0, 400))
await browser.close()
