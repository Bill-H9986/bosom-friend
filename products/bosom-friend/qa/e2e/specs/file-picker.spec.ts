import { expect, openRoute, test } from '../fixtures'

/**
 * 上传入口必须弹出系统文件选择框。
 *
 * DEF-097：入口原本是「按钮 + 脚本调用隐藏 input 的 click()」。浏览器只把真实用户手势算作激活，
 * 脚本合成的 click 会被直接丢弃，表现为「点上去毫无反应、选择框都不弹」。
 * 现在入口是原生 <label for>，由浏览器自己把这次点击转发给 input。
 */
test.describe('DEF-097 上传入口弹出文件选择框', () => {
  test('长视频创作页「加产品图（可选）」弹出选择框', async ({ page }) => {
    await openRoute(page, '#/long-video')
    const pick = page.getByTestId('long-video-product-image-pick')
    await expect(pick).toBeVisible()
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      pick.click(),
    ])
    // 只验证选择框真的弹了：不选文件，避免给用户数据留下上传记录。
    expect(chooser.isMultiple()).toBe(false)
  })

  test('我的数字人页「上传形象图」弹出选择框', async ({ page }) => {
    await openRoute(page, '#/digital-humans')
    const pick = page.getByTestId('digital-human-pick-avatar')
    await expect(pick).toBeVisible()
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      pick.click(),
    ])
    expect(chooser.isMultiple()).toBe(false)
  })
})
