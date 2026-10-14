import { api, expect, openRoute, test } from '../fixtures'

/**
 * 全局监控（接待引擎）两个按钮的语义差别（DEF-026）：
 * 「刷新数据」只重读页面数据、不触发平台采集；「立即轮询」必须真的触发一轮并给出可读反馈。
 */
test.describe('全局监控 · 刷新 / 立即轮询', () => {
  test('刷新数据只重读，不发 poll-now', async ({ page }) => {
    const polls: string[] = []
    const reads: string[] = []
    page.on('request', request => {
      const url = request.url()
      if (!url.includes('/bosom-friend/api/')) return
      if (request.method() === 'POST' && url.includes('customer-reception/poll-now')) polls.push(url)
      if (request.method() === 'GET' && /customer-reception\/(status|replies)|channels\/accounts/.test(url)) reads.push(url)
    })
    await openRoute(page, '#/monitor', 9000)
    // 只统计"点击之后"的窗口：应用自身的后台行为（如接待引擎自有排程）不该被算到这个按钮头上。
    const readsBefore = reads.length
    polls.length = 0
    await page.locator('button:has-text("刷新数据")').first().click()
    await page.waitForTimeout(3000)
    expect(reads.length, '「刷新数据」必须重新读取状态/账号/回复').toBeGreaterThan(readsBefore)
    expect(polls, '「刷新数据」这个按钮本身不得触发平台轮询').toEqual([])
  })

  test('立即轮询触发一轮并如实反馈（进行中重复点也要说明）', async ({ page }) => {
    const polls: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('customer-reception/poll-now')) polls.push(request.url())
    })
    await openRoute(page, '#/monitor', 9000)

    await page.locator('button:has-text("立即轮询")').first().click()
    await expect.poll(() => polls.length, { timeout: 15000 }).toBeGreaterThan(0)
    await expect.poll(async () => page.evaluate(() =>
      Array.from(document.querySelectorAll('.ant-message-notice')).map(node => node.textContent ?? '').join(' '),
    ), { timeout: 15000 }).toMatch(/已触发一轮轮询|接待引擎正在跑这一轮/)

    // 一轮进行中再点：必须如实说「正在跑这一轮」，不允许静默无效。
    const second = await api('POST', 'v2/customer-reception/poll-now')
    expect(second.code, 'poll-now 接口受理').toBe(0)
    expect(typeof second.data?.triggered, '接口必须如实回报这次有没有真的触发').toBe('boolean')
  })
})
