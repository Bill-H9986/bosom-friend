import { expect, test as base } from '@playwright/test'

/**
 * 允许在**开发/共享实例**（默认 31280）上运行的显式开关。
 *
 * 为什么需要这道闸：本套件会创建真实生成记录（真厂商出图）、账号、分组，并往知识库写蒸馏样本。
 * 打在共享实例上时，靶子记录会留在**用户的真实数据根**里——2026-09-22 实测用户
 * knowledge.json 里累积了 47 条 E2E 靶子条目，删除生成记录也无法回收（级联缺失，已另行修复）。
 *
 * 默认拒绝；要打共享实例必须显式设 `BF_QA_ALLOW_SHARED=1`，让"会在用户数据上跑"这件事可被看见。
 * 指向非默认地址（即启动了一个隔离实例）时自动放行——那才是本套件的预期用法。
 */
const ALLOW_SHARED = process.env.BF_QA_ALLOW_SHARED === '1'
const DEFAULT_BASE = 'http://127.0.0.1:31280/bosom-friend/'
const CONFIGURED_BASE = process.env.BF_QA_BASE

if (CONFIGURED_BASE === undefined && !ALLOW_SHARED) {
  throw new Error(
    'E2E 套件拒绝在共享实例（' + DEFAULT_BASE + '）上运行：它会创建真实记录并写入用户数据根。\n'
    + '请二选一：\n'
    + '  1) 起一个隔离实例并指向它（推荐）——需要 BOSOM_FRIEND_HOME 指向一次性目录：\n'
    + "     $env:BOSOM_FRIEND_HOME='<临时目录>'; $env:BF_DESKTOP_PORT='31399'\n"
    + "     $env:BF_QA_BASE='http://127.0.0.1:31399/bosom-friend/'\n"
    + '  2) 确实要打共享实例时显式承担风险：$env:BF_QA_ALLOW_SHARED=1',
  )
}

/** 被测实例基址（末尾带斜杠）。 */
export const BASE = CONFIGURED_BASE ?? DEFAULT_BASE
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

/**
 * 关掉首访免责声明弹层；没有弹层时静默返回。
 *
 * 「同意并进入平台」在勾选「我已阅读并同意以上免责声明」之前是**禁用**的，
 * 而勾选框没有 role/aria 属性可定位，只能按它的可见文案点。
 * 不勾就点按钮会一直点不动（Playwright 的 click 在禁用态上超时），弹层随即留在页面上，
 * 它的 backdrop 会拦截后续每一次点击——2026-09-24 门禁实测：`批量管理` 被
 * `data-state="open"` 遮罩挡住 20 秒超时，红在用例第一行，看起来却像删除功能坏了。
 * 每条用例都是全新浏览器上下文（localStorage 为空），所以这个弹层每次都要现勾现点。
 *
 * @param page - Playwright 页面。
 */
export async function dismissDisclaimer(page: import('@playwright/test').Page) {
  for (let i = 0; i < 6; i += 1) {
    const button = page.locator("button:has-text('同意并进入平台')").first()
    if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
      if (await button.isDisabled().catch(() => false)) {
        await page.locator("button:has-text('我已阅读并同意以上')").first().click({ timeout: 3000 }).catch(() => {})
        await page.waitForTimeout(200)
      }
      await button.click({ timeout: 3000 }).catch(() => {})
      // 点完要等弹层真的收起来：遮罩还在时后续点击会被拦，而失败现场看起来与删除功能无关。
      await button.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
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
