import { expect, test as base } from '@playwright/test'

/** 被测实例基址（末尾带斜杠）。 */
export const BASE = process.env.BF_QA_BASE ?? 'http://127.0.0.1:31280/bosom-friend/'
/** 产品接口地址（与页面同源）。 */
export const API = new URL('api/', BASE).toString()
/** 开发实例的本地访客令牌（前端由主进程注入同一个值）。 */
export const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'

/**
 * 调用产品接口。
 *
 * @param method - HTTP 方法。
 * @param path - 相对 api/ 的路径。
 * @param body - 可选 JSON 请求体。
 * @param token - 可选会话令牌；缺省用本地访客令牌，传空串可验证「未登录被拒」。
 * @returns 解析后的响应体；非 JSON 时回 { code: -1, message }。
 */
export async function api(method: string, path: string, body?: unknown, token: string = TOKEN) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, message: text.slice(0, 200) } }
}

/** 关掉首访免责声明弹层；没有弹层时静默返回。 */
export async function dismissDisclaimer(page: import('@playwright/test').Page) {
  for (let i = 0; i < 6; i += 1) {
    const button = page.locator("button:has-text('同意并进入平台')").first()
    if (await button.count() > 0 && await button.isVisible().catch(() => false))
      await button.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(300)
  }
}

/**
 * 打开产品内的一个 hash 路由并等页面稳定。
 *
 * @param page - Playwright 页面。
 * @param hash - 形如 '#/draft-box' 的路由片段。
 * @param settleMs - 渲染等待时长（内核冷启动较慢，默认 6 秒）。
 */
export async function openRoute(page: import('@playwright/test').Page, hash: string, settleMs = 6000) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await dismissDisclaimer(page)
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(settleMs)
  await dismissDisclaimer(page)
}

/** 页面可见文本（空白折叠）。 */
export async function bodyText(page: import('@playwright/test').Page) {
  return (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
}

export { expect }
export const test = base
