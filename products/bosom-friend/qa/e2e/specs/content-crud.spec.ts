import { API, api, bodyText, dismissDisclaimer, expect, openRoute, test } from '../fixtures'

/**
 * 内容创作（核心功能 A）的增删改查：素材组 CRUD + 素材上传/批量删除。
 * 全部靶子自建自删，不碰用户既有素材；每条用例结束都把数据还原。
 */
const CARD = 'div.mb-4.cursor-pointer.group.relative'

test.describe('内容创作 CRUD', () => {
  test('首屏落在默认素材组，列表可见（DEF-024 不变量）', async ({ page }) => {
    const groups = await api('GET', 'contents/groups/list/1/50')
    const defaultGroup = (groups.data?.list ?? []).find((item: { isDefault?: boolean }) => item.isDefault === true)
    expect(defaultGroup, '服务端必须返回 isDefault 的默认素材组').toBeTruthy()
    expect((groups.data?.list ?? [])[0]?.id, '默认素材组必须排第一，否则首屏会被后建的组顶成空组').toBe(defaultGroup.id)

    await openRoute(page, '#/draft-box', 9000)
    await expect(page).toHaveURL(new RegExp('planId=' + defaultGroup.id))
    await expect(page.locator(CARD).first()).toBeVisible()
  })

  test('素材组：新增 → 改名 → 删除，列表与服务端一致', async ({ page }) => {
    const name = 'E2E 素材组 ' + Date.now()
    const created = await api('POST', 'contents/groups', { name })
    const groupId = created.data?.id as string
    expect(created.code, '新建素材组必须成功').toBe(0)

    try {
      await openRoute(page, '#/draft-box', 9000)
      await expect.poll(async () => (await bodyText(page)).includes(name), { timeout: 20000 }).toBe(true)

      const renamed = name + '（已改名）'
      const updated = await api('POST', 'contents/groups/info/' + groupId, { name: renamed })
      expect(updated.code, '改名必须落库').toBe(0)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(7000)
      await dismissDisclaimer(page)
      // 刷新必须仍停在内容创作：路由丢过（URL 被改写成只剩 ?planId=），这里守住。
      expect(page.url(), '刷新后 URL 仍带内容创作路由').toContain('#/draft-box')
      await expect(page.locator('button:has-text("批量管理")').first()).toBeVisible()
      await expect.poll(async () => (await bodyText(page)).includes(renamed), { timeout: 20000 }).toBe(true)
    }
    finally {
      const removed = await api('DELETE', 'contents/groups/' + groupId)
      expect(removed.code, '删除素材组必须成功').toBe(0)
    }

    const after = await api('GET', 'contents/groups/list/1/50')
    expect((after.data?.list ?? []).some((item: { id: string }) => item.id === groupId), '删除后不应还在列表里').toBe(false)
  })

  test('素材：上传靶子 → 页面批量删除 → 服务端总数 -1 且不回魂', async ({ page }) => {
    const filename = 'e2e-batch-delete.png'
    const sign = await api('POST', 'assets/uploadSign', { filename })
    const assetId = sign.data?.id as string
    expect(assetId, '上传票据必须返回素材 id').toBeTruthy()
    const upload = await fetch(new URL(sign.data.uploadUrl, BASE_ORIGIN()), {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    })
    expect(upload.ok, '上传必须成功').toBe(true)
    const confirmed = await api('POST', 'assets/' + encodeURIComponent(assetId) + '/confirm')
    expect(confirmed.code, 'confirm 必须把素材登记进素材库').toBe(0)

    const before = await api('GET', 'contents/assets/1/50')
    const totalBefore = before.data?.total as number

    try {
      await openRoute(page, '#/draft-box', 9000)
      await page.locator('button:has-text("批量管理")').first().click()
      await page.waitForTimeout(800)
      const card = page.locator(CARD).filter({ hasText: assetId.replace(/\.[^.]+$/, '') }).first()
      await expect(card).toBeVisible()
      await card.click()
      await page.waitForTimeout(600)

      const deleteCalls: string[] = []
      page.on('request', request => {
        if (request.method() === 'DELETE' && request.url().includes('/bosom-friend/api/'))
          deleteCalls.push(request.postData() ?? '')
      })
      await page.locator('button:has-text("移除")').last().click()
      await page.waitForTimeout(900)
      await page.locator('button:has-text("确定"), button:has-text("确认")').last().click()
      await page.waitForTimeout(3500)

      expect(deleteCalls.some(body => body.includes(assetId) && body.includes('"kind":"asset"')),
        '页面必须发出删除这个靶子的 kind=asset 请求').toBe(true)
    }
    finally {
      // 用例失败也不能把靶子留在库里。
      await api('DELETE', 'contents', { ids: [assetId], kind: 'asset' })
    }

    const after = await api('GET', 'contents/assets/1/50')
    expect(after.data?.total, '删除后服务端总数应少 1').toBe(totalBefore - 1)
    expect((after.data?.list ?? []).some((item: { _id: string }) => item._id === assetId), '被删素材不应回到列表').toBe(false)
  })
})

/** 上传地址是 /bosom-friend/api/... 形式，这里补出 origin 供 fetch 使用。 */
function BASE_ORIGIN() {
  return new URL('/', API).toString().replace(/\/$/, '')
}
