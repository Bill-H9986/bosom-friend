import { expect, openRoute, test } from '../fixtures'

/**
 * 发布弹窗：全应用唯一宿主。
 *
 * 此前内容创作 / 账号日历 / AI 批量工具条各自挂载一份 <PublishDialog> 并各管一套开关状态，
 * 同一个弹窗实现了三遍。合并后只有一个宿主（WebAppLayout 里的 PublishDialogHost），
 * 这里用「同一时刻只可能出现一个弹窗标题」把它钉住。
 */
const DIALOG_TITLE = 'text=发布作品'

test.describe('发布弹窗 · 唯一宿主', () => {
  test('内容创作「一键发布」打开弹窗，且同一时刻只有一个实例', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error).slice(0, 160)))

    await openRoute(page, '#/draft-box', 9000)
    expect(await page.locator(DIALOG_TITLE).count(), '未点击时不应有发布弹窗').toBe(0)

    await page.locator('button:has-text("一键发布")').first().click()
    await expect.poll(async () => page.locator(DIALOG_TITLE).count(), { timeout: 25000 }).toBe(1)

    // 弹窗是两步向导：第 1 步编辑内容（底部「下一步」），第 2 步选账号/平台并定发布时间。
    // 两步都要真的渲染出来，只断言标题等于什么都没测。
    const nextButton = page.locator('button:has-text("下一步")').first()
    await expect(nextButton, '第 1 步内容编辑必须真的渲染出来').toBeVisible({ timeout: 15000 })
    await nextButton.click()
    await expect(page.locator('button:has-text("立即发布")').first(), '第 2 步必须出现发布时间按钮').toBeVisible({ timeout: 15000 })
    expect(pageErrors, '打开发布弹窗不应有 JS 异常').toEqual([])
  })

  test('账号日历入口打开的是同一个实例（不会多出一份）', async ({ page }) => {
    await openRoute(page, '#/calendar', 9000)
    // 登录流程用这个自定义事件请求打开发布弹窗（CalendarTiming 监听）。
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('openPublishDialog', { detail: { fromSignIn: true } }))
    })
    await expect.poll(async () => page.locator(DIALOG_TITLE).count(), { timeout: 25000 }).toBe(1)
    await expect(page.locator('button:has-text("下一步")').first(), '日历入口打开的也必须是同一个可交互弹窗').toBeVisible({ timeout: 15000 })
  })
})
