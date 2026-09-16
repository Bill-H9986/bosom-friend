import { bodyText, expect, openRoute, test } from '../fixtures'

/**
 * 数据中心页面诚实性（页面层）：指标没采到时必须给出可读原因，且「已更新 N/M 条」不虚报。
 *
 * 逻辑层断言在 server/test/functional/dashboard-honesty.spec.ts（进程内、秒级）；
 * 这里只守住"用户在页面上看得见这些说明"这件事。
 */
test.describe('数据中心 · 诚实性可见', () => {
  test('播放量没采到时，页面给出原因而不是显示成 0 真值', async ({ page }) => {
    await openRoute(page, '#/data-statistics', 9000)

    const hints = await page.locator('[data-testid=data-statistics-metric-hint]').allInnerTexts()
    expect(hints.length, '概览卡必须有指标说明位').toBeGreaterThan(0)
    // 语义正则：产品把「平台未提供」细分为「本次未采到 / 平台未提供」两态，两种都算如实。
    expect(hints.join(' '), '概览卡要说明播放量为什么没有值').toMatch(/本次未采到|平台未提供/)

    const progress = await page.locator('[data-testid=data-statistics-update-progress]').first().innerText().catch(() => '')
    expect(progress, '「已更新 N/M 条作品数据」要显示').toMatch(/已更新\s*\d+\s*\/\s*\d+\s*条作品数据/)

    // 服务端口径与页面文案对得上：有全 0 占位时必须如实说明，不能只报个数字。
    const dash = await (await page.request.get('api/v2/statistics/published-content-summary/dashboard')).json()
    const zeroOnly = dash?.data?.updateProgress?.zeroOnlyCount ?? 0
    if (zeroOnly > 0)
      expect(progress, '存在全 0 占位时必须如实说明').toContain('只回了 0')
  })
})
