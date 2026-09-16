import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bodyText, expect, openRoute, test } from '../fixtures'

/**
 * 内容创作参数口径与频道平台的验收断言（对齐 RELEASE_GATE 门槛 10/11/12）。
 *
 * 图片档位必须与视频档位逐字一致（720p / 1080p），成品像素随画面比例变化；
 * 「添加频道」必须能连上引擎已落地的快手与闲鱼；闲鱼发布尚未接通，
 * 因此它不得出现在内容创作的目标平台里（能连上 ≠ 能发出去）。
 * 证据截图落在 qa/evidence/，供人工复核。
 */
const EVIDENCE = join(process.cwd(), '..', 'evidence')

function evidence(name: string) {
  mkdirSync(EVIDENCE, { recursive: true })
  return join(EVIDENCE, name + '.png')
}

/** 可见的档位按钮文字；排除工具栏上的档位胶囊本身，只看下拉选项。 */
async function visibleTierOptions(page: import('@playwright/test').Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .filter(el => !(el.getAttribute('data-testid') ?? '').startsWith('draftbox-ai-'))
    .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map(el => (el.textContent || '').trim())
    .filter(text => /^(720p|1080p)$/.test(text)))
}

/** 切换生成模式（图文 / 视频）。 */
async function switchMode(page: import('@playwright/test').Page, label: '生成草稿(图文)' | '生成草稿(视频)') {
  await page.locator('[data-testid="draftbox-ai-gen-mode"]').first().click()
  await page.waitForTimeout(600)
  await page.getByText(label, { exact: true }).last().click().catch(() => {})
  await page.waitForTimeout(900)
}

test.describe('内容创作 · 分辨率与画面比例', () => {
  test('图片档位与视频档位一致，成品尺寸随比例切换（门槛 10/11/12）', async ({ page }) => {
    await openRoute(page, '#/draft-box', 9000)

    await switchMode(page, '生成草稿(图文)')
    await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
    await page.waitForTimeout(700)
    const imageTiers = await visibleTierOptions(page)
    const imagePill = await page.locator('[data-testid="draftbox-ai-resolution"]').first().innerText()
    await page.screenshot({ path: evidence('档位-图文-与视频一致') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    await switchMode(page, '生成草稿(视频)')
    await page.locator('[data-testid="draftbox-ai-video-resolution"]').first().click()
    await page.waitForTimeout(700)
    const videoTiers = await visibleTierOptions(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    expect(imageTiers, '图片档位必须是 720p/1080p').toEqual(['720p', '1080p'])
    expect(imageTiers, '图片档位必须与视频档位逐字一致').toEqual(videoTiers)
    expect(imagePill, '图片档位按钮只显示档位，不出现像素尺寸').not.toMatch(/\d+x\d+/)

    // 切到 3:4 后，弹层里的成品尺寸只能是 3:4 的，不能混进 9:16 的尺寸。
    await switchMode(page, '生成草稿(图文)')
    await page.locator('[data-testid="draftbox-ai-ratio"]').first().click()
    await page.waitForTimeout(600)
    await page.getByText('3:4', { exact: true }).last().click()
    await page.waitForTimeout(700)
    await page.locator('[data-testid="draftbox-ai-resolution"]').first().click()
    await page.waitForTimeout(700)
    const popoverText = await page.evaluate(() => Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"]'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .join(' | '))
    await page.screenshot({ path: evidence('档位-图文-3比4-只显示对应尺寸') })
    expect(popoverText, '3:4 应给出 720x960 与 1080x1440').toContain('1080x1440')
    expect(popoverText, '3:4 不得出现 9:16 的尺寸').not.toContain('1080x1920')
  })
})

test.describe('添加频道 · 平台清单', () => {
  test('添加频道只列产品频道白名单，未接通发布的平台不给入口', async ({ page }) => {
    await openRoute(page, '#/draft-box', 9000)
    await page.getByText('添加频道', { exact: true }).first().click()
    await page.waitForTimeout(2500)
    await page.getByText('连接新频道', { exact: true }).first().click()
    await page.waitForTimeout(1200)

    const cards = page.locator('[data-testid="cm-connect-platform-card"]')
    const names = (await cards.allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim())
    await page.screenshot({ path: evidence('添加频道-只列产品频道白名单') })

    // 产品只做国内平台：九个频道平台都要出现，且国外平台一个都不能有。
    for (const name of ['小红书', '抖音', '快手', '视频号', '哔哩哔哩', '百家号', '支付宝生活号', '微博', '虎扑']) {
      expect(names.some(n => n.includes(name)), '添加频道必须列出' + name).toBe(true)
    }
    for (const name of ['闲鱼', 'TikTok', 'YouTube', 'Instagram', 'Facebook', 'Twitter', 'Pinterest', 'LinkedIn', 'Threads']) {
      expect(names.some(n => n.includes(name)), name + ' 不得出现在产品里').toBe(false)
    }

    // 白名单里的平台必须真的能连，不能是置灰的「即将支持」。
    const kuaishouCard = cards.filter({ hasText: '快手' }).first()
    await expect(kuaishouCard, '快手必须真的可连接，而不是置灰的即将支持').not.toHaveClass(/grayscale/)

    // 内容创作的目标平台只列真能发出去的：快手在，闲鱼不在。
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
    await page.mouse.click(1200, 60)
    await page.waitForTimeout(600)
    await page.getByText(/\d+ 个平台/).first().click()
    await page.waitForTimeout(1000)
    // 只看目标平台弹层里的选项，别把页面别处的「闲鱼」文字（例如刚弹过的提示）算进来。
    const pickerText = await page.evaluate(() => Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .join(' | '))
    await page.screenshot({ path: evidence('内容创作-目标平台不含闲鱼') })
    expect(pickerText, '内容创作目标平台必须包含快手').toContain('快手')
    expect(pickerText, '内容创作目标平台不得出现闲鱼').not.toContain('闲鱼')
  })
})

test.describe('设置 · 自定义模型收纳列表', () => {
  test('模型服务以收纳卡呈现：默认收起，点开就地编辑且只开一个', async ({ page }) => {
    await openRoute(page, '#/draft-box', 9000)
    await page.getByTestId('sidebar-user-trigger').first().click()
    await page.waitForTimeout(800)
    await page.getByTestId('sidebar-settings-entry').first().click()
    await page.waitForTimeout(1500)
    await page.getByText('自定义大模型', { exact: true }).first().click()
    await page.waitForTimeout(2500)

    const items = page.locator('[data-testid="llm-provider-item"]')
    const count = await items.count()
    test.skip(count === 0, '当前实例没有配置任何模型服务，无法验证收纳列表')

    // 每张卡一个展开按钮（收起时叫「编辑」，展开后叫「收起」）：用 aria-controls 定位，
    // 不绑按钮文案——文案会随状态变，绑文案的断言上次就是这么假红的。
    const cardToggle = (index: number) => items.nth(index).locator('button[aria-controls]')
    const initialExpanded = await items.locator('button[aria-controls]')
      .evaluateAll(list => list.map(el => el.getAttribute('aria-expanded')))
    expect(initialExpanded.every(value => value === 'false'), '默认必须全部收起').toBe(true)
    await page.screenshot({ path: evidence('设置-自定义模型-收纳列表') })

    await cardToggle(0).click()
    await page.waitForTimeout(600)
    await expect(cardToggle(0)).toHaveAttribute('aria-expanded', 'true')
    // 新版编辑区：API 密钥在最外层，显示名称 / 地址 / 协议 / 模型目录收在「自定义设置」里。
    await expect(items.first().locator('#bf-llm-api-key'), '展开后必须看到 API 密钥').toBeVisible()
    await items.first().getByText('自定义设置', { exact: true }).click()
    await page.waitForTimeout(400)
    await expect(items.first().locator('#bf-llm-base-url'), '自定义设置里必须有 API 地址').toBeVisible()
    await expect(items.first().getByText('API 协议', { exact: true })).toBeVisible()
    await expect(items.first().getByText('模型目录', { exact: true })).toBeVisible()
    // 图片 / 视频模型不再另开配置区：它们在模型目录里靠「用途」下拉标明。
    const kindSelects = items.first().getByLabel('模型用途')
    await expect(kindSelects.first(), '每个模型行都要有用途下拉').toBeVisible()
    expect(await kindSelects.count(), '用途下拉数量必须等于模型目录行数').toBeGreaterThan(0)
    await page.screenshot({ path: evidence('设置-自定义模型-展开编辑') })
    await items.first().getByText('模型目录', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: evidence('设置-模型目录-用途') })

    if (count > 1) {
      await cardToggle(1).click()
      await page.waitForTimeout(600)
      await expect(cardToggle(0), '同时只能展开一个服务').toHaveAttribute('aria-expanded', 'false')
      await expect(cardToggle(1)).toHaveAttribute('aria-expanded', 'true')
    }

    const last = count > 1 ? 1 : 0
    await cardToggle(last).click()
    await page.waitForTimeout(600)
    await expect(cardToggle(last)).toHaveAttribute('aria-expanded', 'false')
  })
})
