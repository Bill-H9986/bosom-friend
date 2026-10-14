import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { PLATFORM_CONTENT_LIMITS, declaredBodyLimits, platformCatalog, platformContentLimits } from '../../src/platform-catalog.ts'
import { buildConstraintLines, CONSTRAINT_SOURCES } from '../../src/agent-context.ts'

/**
 * 平台上限只报**有出处的数字**（DEF-153）。
 *
 * 此前这里给所有平台发同一套（正文 5000、图片 9、话题 10）——谁也不是真的：
 * 模型侧的约束语境写的是「小红书正文不超过 1000 字」，而界面按 5000 放开，
 * **用户按 5000 写、平台按 1000 收**。修法是立一张"只登记有出处"的平台事实表，
 * 路由与约束语境都从它取数；没有出处的**不报**，界面据此显示"未声明"。
 */

let h: Harness

beforeAll(() => {
  h = createHarness()
})
afterAll(() => {
  h.dispose()
})

/** 平台元数据里某个平台的 contentLimits / topic。 */
async function limitsOf(platform: string): Promise<{ contentLimits: Record<string, unknown>, topic: Record<string, unknown> }> {
  // 这条路由回的是**数组**本身（不是 {list}）——照抄既有用例的形状。
  const res = await h.call<Array<{ platform: string, contentLimits: Record<string, unknown>, topic: Record<string, unknown> }>>(
    'GET',
    'v2/channels/platforms',
  )
  const item = res.data.find(row => row.platform === platform)
  expect(item, '平台目录里应该有 ' + platform).toBeDefined()
  return { contentLimits: item!.contentLimits, topic: item!.topic }
}

describe('平台事实表：有出处的才报', () => {
  it('小红书报出正文与话题上限（产品既定口径，唯一出处就是这张表）', async () => {
    const { contentLimits, topic } = await limitsOf('xhs')
    expect(contentLimits.maxBodyLength).toBe(1000)
    expect(topic.maxCount).toBe(10)
  })

  it('没有出处的平台**不报**正文与话题上限，而不是编一套给它', async () => {
    // 抖音：我们没有任何有出处的正文上限数字。
    const { contentLimits, topic } = await limitsOf('douyin')
    expect(contentLimits.maxBodyLength, '宁可不报，也不要报一个用户会照着写的假上限').toBeUndefined()
    expect(topic.maxCount).toBeUndefined()
    expect(contentLimits.maxTitleLength, '标题 30 字是**产品自己的**上限，如实报').toBe(30)
  })

  it('标题上限来自产品自己的常量，不是一个散落的字面量', async () => {
    const { contentLimits } = await limitsOf('weibo')
    expect(contentLimits.maxTitleLength).toBe(CONSTRAINT_SOURCES.titleChars)
  })

  it('事实表里的平台名与平台目录不漂移', () => {
    // 名字有两个来源（这张表是手写的，目录来自引擎扫描）：不一致就判红，
    // 而不是等用户在界面上看到两个名字。
    const catalogNames = new Map(platformCatalog().map(item => [item.platform, item.name]))
    for (const [platform, item] of Object.entries(PLATFORM_CONTENT_LIMITS)) {
      if (item.name === undefined) continue
      expect(catalogNames.get(platform), platform + ' 的名字要与平台目录一致').toBe(item.name)
    }
  })

  it('约束语境从同一张表渲染，数字只有一个家', () => {
    const text = buildConstraintLines(CONSTRAINT_SOURCES).join('\n')
    for (const item of declaredBodyLimits()) {
      expect(text, '约束语境要带上 ' + item.name + ' 的正文上限').toContain(item.name + ' ' + String(item.body) + ' 字')
    }
    expect(platformContentLimits('weibo'), '没登记的平台取到空对象').toEqual({})
  })
})
