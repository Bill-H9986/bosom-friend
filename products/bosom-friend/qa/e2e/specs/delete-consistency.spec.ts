import { api, bodyText, expect, openRoute, test } from '../fixtures'

/**
 * 删除一致性不变量：**任何删除动作之后，界面必须在同一屏与服务端一致**。
 *
 * 为什么单独一条 spec：既有用例只断言"删除请求发出去了 + 服务端少了一条"，界面有没有立刻
 * 跟着变、留下的卡片会不会等到切页才消失、被生成记录引用的素材到底删没删，全都没人管——
 * 于是「删完卡片还在、切页才消失」（DEF-127）、「选了生成产出的图片点删除等于没点」（DEF-128）
 * 这类缺陷一次次漏到用户手里。这里把这条不变量机器化。
 *
 * 规矩沿用 qa/e2e/README.md：靶子自建自删，不碰用户既有数据；全局性动作（清空全部）在
 * 发现库里还有别人的记录时直接跳过，避免用例把用户的东西删掉。
 */

const CARD = 'div.mb-4.cursor-pointer.group.relative'
const TAG = 'E2E 删除一致性靶子'

/** 页签徽标里的数字；没有徽标即 0。 */
async function tabCount(page: import('@playwright/test').Page, label: string): Promise<number> {
  const tab = page.getByRole('tab', { name: new RegExp(label) }).first()
  const text = ((await tab.innerText().catch(() => '')) as string).replace(/\s+/g, ' ')
  const m = /(\d+)\s*$/.exec(text)
  return m === null ? 0 : Number(m[1])
}

/** 服务端权威计数。 */
async function serverCounts() {
  const [drafts, assets, gens] = await Promise.all([
    api('GET', 'contents/drafts/1/50'),
    api('GET', 'contents/assets/1/50?type=img'),
    api('GET', 'ai/draft-generation/?page=1&pageSize=50'),
  ])
  return {
    drafts: Number(drafts.data?.total ?? 0),
    assets: Number(assets.data?.total ?? 0),
    generations: ((gens.data?.list ?? []) as unknown[]).length,
  }
}

/**
 * 建一条可删的图文生成（真实厂商出图），返回记录 id。
 * @param prompt - 提示词（带靶子标记，便于在页面上定位卡片）。
 * @param imageCount - 要几张图（靶子至少 1 张）。
 */
async function createGeneration(prompt: string, imageCount: number) {
  // 厂商的图片接口会成阵地 429/503（2026-09-24 实测：门禁一轮里它直接产出 0 张图）。
  // 厂商没出图时这条用例**没有靶子**——那是外部不可用，该如实跳过，不该记成产品缺陷
  // （与 AC-011-2 同一种口径）。所以这里重试 3 次，仍没有图就返回 null 交给用例 skip。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const created = await api('POST', 'ai/draft-generation/image-text', {
      groupId: 'mg-persist',
      kind: 'image-text',
      prompt,
      resolution: '720p',
      aspectRatio: '3:4',
      quantity: 1,
      imageModel: 'agnes-image-2.5-flash',
      captionPrompt: '标题不超过30字。',
      style: '写实',
      draftType: 'draft',
      imageCount,
      imageSize: '720p',
      platforms: ['xhs'],
    })
    const id = created.data?.taskIds?.[0] as string
    if (!id) {
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 15_000))
      continue
    }
    let urls: string[] = []
    await expect.poll(async () => {
      const list = await api('GET', 'ai/draft-generation/?page=1&pageSize=50')
      const row = (list.data?.list ?? []).find((t: { id: string }) => t.id === id)
      urls = (row?.response?.imageUrls ?? []) as string[]
      return row?.status ?? 'missing'
      // 第一次给足 120 秒（厂商出图正常要 30~120 秒）；只有"跑完了但 0 张图"才重试，
      // 重试那次 60 秒就够——它通常是快速失败。
    }, { timeout: attempt === 1 ? 120_000 : 60_000, intervals: [3000] }).not.toBe('generating')
    if (urls.length > 0) return { id, urls, images: urls.length }
    // 这一单没出图：先清掉它再重试，免得失败靶子污染后面的断言
    await cleanupGenerations([id])
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 15_000))
  }
  return null
}

/**
 * 清掉历史遗留的靶子记录（每个用例开跑前）。
 *
 * 为什么必须有：靶子标记（{@link TAG}）是固定字符串，而**失败过的那几轮**会把记录留在库里
 * （生成失败时用例自己的 finally 也只是尽力删）。留着就污染后来的断言——实测 2026-09-23：
 * 三条"生成失败"的历史靶子让「页面上不应再留着这条记录」永远红（页面里确实还有**别的**靶子）。
 *
 * @returns 删掉的记录数。
 */
async function purgeStaleTargets(): Promise<number> {
  const list = await api('GET', 'ai/draft-generation/?page=1&pageSize=50')
  const stale = ((list.data?.list ?? []) as Array<{ id: string, request?: { prompt?: unknown }, prompt?: unknown }>)
    .filter(row => String(row.request?.prompt ?? row.prompt ?? '').includes(TAG))
    .map(row => row.id)
  if (stale.length > 0) await cleanupGenerations(stale)
  return stale.length
}

/** 兜底清理：删记录会级联带走它产出的素材与草稿。 */
async function cleanupGenerations(ids: string[]) {
  const list = ids.filter(id => id !== '')
  if (list.length === 0)
    return
  await api('DELETE', 'ai/draft-generation', { taskIds: list }).catch(() => undefined)
}

test.describe('删除一致性：同屏必须与服务端一致', () => {
  // 每个用例都要真调厂商出图（靶子），而厂商瞬时失败时 `createGeneration` 会重试——
  // 默认 120 秒预算装不下（2026-09-24 实测：重试把用例顶到 120 秒超时）。这里给足预算，
  // 断言一条没动；DEF-167 给依赖真模型的那条用例放宽预算时用的是同一个理由。
  test.describe.configure({ timeout: 240_000 })
  // 每个用例开跑前先扫掉历史靶子：靶子标记固定，上一轮失败留下的记录会让这一轮的断言永不成立。
  test.beforeEach(async () => { await purgeStaleTargets() })

  test('批量移除「生成产出的素材」：卡片同屏消失，生成记录一并级联', async ({ page }) => {
    const created = await createGeneration(TAG + '：一杯冷萃咖啡。', 2)
    if (created === null) {
      test.skip(true, '厂商连续 2 次没有产出图片（外部不可用），这条用例没有靶子（如实跳过）')
      return
    }
    try {
      await openRoute(page, '#/draft-box', 9000)
      const before = await serverCounts()

      await page.locator('button:has-text("批量管理"):visible').first().click()
      await page.waitForTimeout(800)
      // 必须选中**素材卡片**（按生成出来的图片文件名定位），而不是同名的草稿卡片：
      // 草稿走的 kind=draft 在服务端本来就会级联删记录，用它当靶子会让「素材被保护」这条
      // 永远测不到（负向对照实测：拿掉 cascadeGenerations 后用例照样绿）。
      const fileId = decodeURIComponent(created.urls[0]!.split('/').pop() ?? '')
      const card = page.locator(CARD).filter({ has: page.locator('img[src*="' + fileId + '"]') }).first()
      await expect(card, '生成的素材卡片必须出现在库里（否则用例没有靶子）').toBeVisible()
      await card.click()
      await page.waitForTimeout(500)
      await page.locator('button:has-text("移除"):visible').last().click()
      await page.waitForTimeout(800)
      await page.locator('[role=alertdialog] button:has-text("确定")').last().click()

      // 不刷新、不切页：界面上这张卡片必须消失（DEF-127 的机器化版本）
      await expect(page.locator(CARD).filter({ hasText: TAG }), '删除后卡片必须立刻消失，不能等到切页').toHaveCount(0, { timeout: 20_000 })
      // 级联删除在服务端是异步的：计数要**等它落定**再断言，一次性读会读到中间态
      // （2026-09-24 门禁实测：期望 17 实得 18，就是读早了）。断言强度不变，只是允许它排队落定。
      await expect.poll(async () => (await serverCounts()).assets, { timeout: 20_000, message: '被生成记录引用的素材必须真的删掉，而不是"点了等于没点"' })
        .toBe(before.assets - 2)
      await expect.poll(async () => (await serverCounts()).generations, { timeout: 20_000, message: '生成记录必须随素材删除被级联清掉' })
        .toBe(before.generations - 1)
      // 页签计数必须与服务端落定后的素材数一致（丢弃级联删掉的素材正是漏点）
      await expect.poll(async () => tabCount(page, '图片'), { timeout: 20_000, message: '图片页签计数必须等于服务端素材数' })
        .toBe(before.assets - 2)
    }
    finally {
      await cleanupGenerations([created.id])
    }
  })

  test('生成记录弹层里单条删除：同屏消失，素材与服务端一致', async ({ page }) => {
    const created = await createGeneration(TAG + '：桌上一杯拿铁。', 1)
    if (created === null) {
      test.skip(true, '厂商连续 2 次没有产出图片（外部不可用），这条用例没有靶子（如实跳过）')
      return
    }
    try {
      await openRoute(page, '#/draft-box', 9000)
      const before = await serverCounts()

      await page.locator('button:has-text("生成记录"):visible').first().click()
      await page.waitForTimeout(1500)
      const row = page.locator('div').filter({ hasText: TAG }).last()
      await expect(row, '生成记录弹层必须列出这条记录').toBeVisible()
      // 只点弹层里的那一颗：页面上的卡片（生成失败的记录）自己也带"删除生成记录"按钮，
      // 不限定范围时 .first() 取到的是弹层**背后**那颗，会被模态遮罩挡住直到超时（2026-09-23 实测）。
      await page.locator('[role=dialog] [aria-label="删除生成记录"]').first().click()
      await page.waitForTimeout(800)
      await page.locator('[role=alertdialog] button:has-text("删除")').last().click()
      await page.waitForTimeout(3000)

      // 同上：等服务端落定再断言（一次性读会读到中间态）
      await expect.poll(async () => (await serverCounts()).generations, { timeout: 20_000, message: '删除后服务端记录数必须 -1' })
        .toBe(before.generations - 1)
      const settled = await serverCounts()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1200)
      await expect.poll(async () => tabCount(page, '图片'), { timeout: 20_000, message: '素材页签计数必须同步到服务端' }).toBe(settled.assets)
      expect(await bodyText(page), '页面上不应再留着这条记录的卡片').not.toContain(TAG)
    }
    finally {
      await cleanupGenerations([created.id])
    }
  })

  test('清空全部生成记录：记录与素材同屏清空（库里若有他人记录则跳过）', async ({ page }) => {
    const before = await serverCounts()
    test.skip(before.generations > 0, '库里已有非本用例的生成记录，清空全部是全局动作，跳过以免删除用户数据')

    const created = await createGeneration(TAG + '：窗外晨光下的咖啡杯。', 1)
    if (created === null) {
      test.skip(true, '厂商连续 2 次没有产出图片（外部不可用），这条用例没有靶子（如实跳过）')
      return
    }
    try {
      await openRoute(page, '#/draft-box', 9000)
      await page.locator('button:has-text("生成记录"):visible').first().click()
      await page.waitForTimeout(1500)
      await page.locator('button:has-text("清空全部"):visible').first().click()
      await page.waitForTimeout(800)
      await page.locator('[role=alertdialog] button:has-text("清空")').last().click()
      await page.waitForTimeout(4000)

      // 断言"清空带走了我这条记录产出的一切"，而不是"库里归零"：
      // 本用例只在已有生成记录时跳过，却不断言素材/草稿是否本来就有库存。
      // 实测（2026-09-22）：先前失败的运行留下了 2 个孤儿素材，于是"必须清掉"这条
      // 拿别人的残留当自己的欠账，稳定误报。同文件的另外两个用例本来就用增量断言
      // （before.assets - 2 / before.generations - 1），这里与它们对齐。
      // 清空同样是异步级联：三条计数都等落定（断言强度不变）
      await expect.poll(async () => (await serverCounts()).generations, { timeout: 20_000, message: '清空后不应还有生成记录' }).toBe(0)
      await expect.poll(async () => (await serverCounts()).assets, { timeout: 20_000, message: '本条记录产出的素材必须被一起清掉' })
        .toBe(before.assets + created.images - created.urls.length)
      await expect.poll(async () => (await serverCounts()).drafts, { timeout: 20_000, message: '本条记录产出的草稿必须被一起清掉' }).toBe(before.drafts)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1500)
      await expect.poll(async () => (await bodyText(page)).includes(TAG), { timeout: 20_000 }).toBe(false)
    }
    finally {
      await cleanupGenerations([created.id])
    }
  })
})
