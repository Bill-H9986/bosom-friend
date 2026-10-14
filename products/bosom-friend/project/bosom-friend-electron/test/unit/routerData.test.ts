import { describe, expect, it } from 'vitest'
// 用 @web 别名而不是相对路径（DEF-069：改名后裸相对路径静默失效）。
import { routerData } from '@web/app/layout/routerData'

/** 产品现有的导航入口：改名/合并/新增都要在这里同步，缺一个就判红。 */
const EXPECTED_PATHS = [
  '/draft-box',
  '/ai-interaction',
  '/tasks-history',
  '/calendar',
  '/data-statistics',
  '/monitor',
  '/knowledge',
]

describe('侧边栏导航配置', () => {
  it('每个导航项都有路径和翻译键', () => {
    for (const item of routerData) {
      expect(item.path).toBeTruthy()
      expect(item.translationKey).toBeTruthy()
    }
  })

  // 原先断言"共 4 项"，产品长到 9 项后它必然失效——条数不是契约，**有哪些入口**才是。
  // 2026-09-30：长视频创作与我的数字人并入「内容创作」页的两个标签，导航从 9 项变 7 项。
  it('七大功能入口都在导航里，且不重复', () => {
    const paths = routerData.map(item => item.path)
    for (const path of EXPECTED_PATHS) expect(paths).toContain(path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  // 原先这条里混进了 /data-statistics——它现在是**在用的**「数据中心」入口，
  // 于是断言自相矛盾。退休入口清单要跟着产品走，冲突时以产品现状为准。
  it('已合并页面不再出现在导航（系统介绍/账号矩阵/自动接待/热点内容/设置/素材库/一键发布/个人账号/长视频/数字人）', () => {
    const paths = routerData.map(item => item.path)
    for (const p of ['/', '/accounts', '/reception', '/hot-content', '/settings', '/agent-assets', '/publish/video', '/account', '/long-video', '/digital-humans']) {
      expect(paths, '退休入口不该回到导航：' + p).not.toContain(p)
    }
  })
})
