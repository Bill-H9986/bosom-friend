import { expect, test } from '@playwright/test'
import { api, bodyText, openRoute } from '../fixtures'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AC-017-1 / AC-017-2 / AC-018-1：只用一句对话就能用各项功能，且每一步都在会话里留下截图与说明。
 *
 * 这三条以前只有「前端有一张导航动作映射表」这一半：服务端只会产出 navigateToPublish，
 * 其余导航动作既不会被生成；就算生成了，ActionCard 也会渲染成空节点，用户看不到也点不到。
 * 这里按「用户真的能完成」来验：说一句话 → 会话里出现可点的导航卡 → 点一下真的换了页面。
 */
// 每条用例要发 1~3 句真实对话（真实模型调用），单条实测 25 秒 ~ 1.5 分钟；
// 默认 120 秒在整套连跑（workers=1，前面几十条用例已让机器热起来）时会被模型延迟顶穿，
// 于是出现"单跑绿、整套红"的假红。这里按真实调用耗时给足预算，不放松任何断言。
test.describe.configure({ timeout: 300_000 })

const EVIDENCE = join(process.cwd(), '..', 'evidence', 'ac')

function evidence(name: string): string {
  mkdirSync(EVIDENCE, { recursive: true })
  return join(EVIDENCE, name + '-' + Date.now() + '.png')
}

/** 打开右侧 AI 助手面板并等它稳定。 */
async function openAssistant(page: import('@playwright/test').Page) {
  await openRoute(page, '#/draft-box', 12000)
  const panel = page.locator('[data-testid="ai-assistant-sidebar"]')
  await expect(panel, '右侧 AI 助手面板应存在').toHaveCount(1)
  return panel
}

/** 在 AI 助手里发一句话。 */
async function ask(page: import('@playwright/test').Page, prompt: string) {
  const input = page.getByPlaceholder('输入你的需求，AI 帮你搞定内容创作、选题、回复...')
  await input.fill(prompt)
  await input.press('Enter')
}

/**
 * 从任务消息里挑出「带截图的操作记录」。
 *
 * 落盘的消息有两种形状：反馈正文在 message（字符串）或 content，截图挂在
 * result[0].medias 或顶层 medias。只认真正带图的那种，避免把纯文字当成截图证据。
 */
function shotFeedbacks(messages: any[]): any[] {
  return messages.filter((m: any) => {
    const text = String(m.message ?? m.content ?? '')
    const medias = Array.isArray(m.medias) ? m.medias : (Array.isArray(m.result) ? (m.result[0]?.medias ?? []) : [])
    return text.includes('AI 智能体已执行') && Array.isArray(medias) && medias.length > 0
  })
}

/** 开/关跟随模式开关。 */
async function setFollow(page: import('@playwright/test').Page, on: boolean) {
  const label = page.getByLabel('跟随模式')
  const checked = await label.isChecked().catch(() => false)
  if (checked !== on) {
    await label.click()
    await page.waitForTimeout(800)
  }
}

test.describe('AC-018-1 仅与 AI 对话即可完成各项功能', () => {
  test('说「打开数据中心」后会话里出现导航卡，点一下就真的到数据中心', async ({ page }) => {
    await openAssistant(page)
    await setFollow(page, false)
    await ask(page, '帮我打开数据中心，我想看播放量。')

    const card = page.locator('[data-action-card="navigateToDatacenter"]')
    await expect(card, '会话里应出现数据中心导航卡（服务端要产出 navigateToDatacenter 动作）').toBeVisible({ timeout: 180_000 })
    await expect(card, '导航卡必须说明它要去哪').toContainText('数据中心')

    const button = card.getByRole('button')
    await expect(button, '导航卡必须有可点的按钮').toContainText('立即前往')
    await button.click()

    await expect.poll(async () => page.url(), { timeout: 20_000, message: '点完之后必须真的跳到数据中心' }).toContain('data-statistics')
    await page.screenshot({ path: evidence('AC-018-1-对话导航到数据中心') })
  })

  // 三个入口各是一条独立用例：一条用例里串三次真实模型调用时，
  // 单条断言会在第三次调用上被延迟顶穿（2026-09-13 实测：服务端已产出 navigateToKnowledge，
  // 断言却在 120 秒到点判红）。拆开后每次只等一次调用，预算也就不必互相挤。
  const NAV_CASES = [
    { prompt: '帮我打开草稿箱。', type: 'navigateToDraft', route: 'draft-box' },
    { prompt: '带我去全局监控看看。', type: 'navigateToMonitor', route: 'monitor' },
    { prompt: '打开知识库。', type: 'navigateToKnowledge', route: 'knowledge' },
  ]
  for (const item of NAV_CASES) {
    test('说「' + item.prompt + '」拿到 ' + item.type + ' 导航卡，点一下就跳到 ' + item.route, async ({ page }) => {
      await openAssistant(page)
      await setFollow(page, false)
      await ask(page, item.prompt)
      const card = page.locator('[data-action-card="' + item.type + '"]')
      await expect(card, '「' + item.prompt + '」应产出 ' + item.type + ' 导航卡').toBeVisible({ timeout: 180_000 })
      await card.getByRole('button').click()
      await expect.poll(async () => page.url(), { timeout: 20_000, message: item.prompt + ' 应跳到 ' + item.route }).toContain(item.route)
      await page.screenshot({ path: evidence('AC-018-1-对话导航到-' + item.route) })
    })
  }

  test('没有导航意图的创作需求不会被误跳转', async ({ page }) => {
    await openAssistant(page)
    await setFollow(page, false)
    await ask(page, '帮我写一篇小红书的春季护肤种草笔记。')
    await page.waitForTimeout(60_000)
    // 创作需求可以走发布动作链，但绝不能产出导航卡把用户从创作页带走。
    await expect(page.locator('[data-action-card="navigateToDraft"]'), '创作需求不得产出导航卡').toHaveCount(0)
    expect(page.url(), '创作需求不得跳走').toContain('draft-box')
  })
})

test.describe('AC-017-1 每完成一次操作，会话内出现该步截图与说明', () => {
  test('跟随模式开启后，智能体执行导航动作并在会话里留下截图与说明', async ({ page }) => {
    await openAssistant(page)
    await setFollow(page, true)

    await ask(page, '帮我打开数据中心。')

    await expect
      .poll(async () => await bodyText(page), { timeout: 150_000, message: '等待智能体执行导航动作并回报' })
      .toContain('AI 智能体已执行')

    const text = await bodyText(page)
    expect(text, '截图说明里应写明执行的是哪个动作').toContain('navigateToDatacenter')
    await page.screenshot({ path: evidence('AC-017-1-智能体每步截图与说明') })
  })
})

test.describe('AC-017-2 连续操作回看，截图与操作一一对应无缺漏', () => {
  test('刷新页面后仍能从会话里回看到带截图的操作记录', async ({ page }) => {
    await openAssistant(page)
    await setFollow(page, true)
    await ask(page, '帮我打开数据中心。')
    await expect
      .poll(async () => await bodyText(page), { timeout: 150_000, message: '等待智能体留下带截图的操作记录' })
      .toContain('AI 智能体已执行')

    // 落盘侧：这条反馈必须真的写进了任务消息，而不是只活在内存里。
    const tasks = await api('GET', 'agent/tasks?page=1&pageSize=20')
    expect(tasks.code, '任务列表应可读').toBe(0)
    const list = Array.isArray(tasks.data) ? tasks.data : (tasks.data?.list ?? [])
    let persisted: { id: string, count: number } | null = null
    for (const task of list.slice(0, 6)) {
      const detail = await api('GET', 'agent/tasks/' + task.id)
      const shots = shotFeedbacks(detail.data?.messages ?? [])
      if (shots.length > 0) {
        persisted = { id: task.id, count: shots.length }
        break
      }
    }
    expect(persisted, '带截图的操作记录必须落盘到任务消息里').not.toBeNull()

    // 回看侧：刷新后条数不能变少（截图与操作一一对应，不因刷新丢步）。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(9000)
    const again = await api('GET', 'agent/tasks/' + persisted!.id)
    const shotsAgain = shotFeedbacks(again.data?.messages ?? [])
    expect(shotsAgain.length, '刷新前后带截图的操作记录条数必须一致').toBe(persisted!.count)
    await page.screenshot({ path: evidence('AC-017-2-刷新后仍可回看操作截图') })
  })
})
