import { describe, expect, it } from 'vitest'
import { routerData } from '../../../aitoearn-web/src/app/layout/routerData'

describe('侧边栏导航配置', () => {
  it('导航共 4 项（重复功能已合并）', () => {
    expect(routerData.length).toBe(4)
  })

  it('每个导航项都有路径和翻译键', () => {
    for (const item of routerData) {
      expect(item.path).toBeTruthy()
      expect(item.translationKey).toBeTruthy()
    }
  })

  it('路径不重复', () => {
    const paths = routerData.map(item => item.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('核心入口齐全', () => {
    const paths = routerData.map(item => item.path)
    for (const p of ['/draft-box', '/ai-interaction', '/tasks-history', '/knowledge']) {
      expect(paths).toContain(p)
    }
  })

  it('已合并页面不再出现在导航（系统介绍/账号矩阵/自动接待/热点内容/数据统计/设置/素材库/一键发布/个人账号）', () => {
    const paths = routerData.map(item => item.path)
    for (const p of ['/', '/accounts', '/reception', '/hot-content', '/data-statistics', '/settings', '/agent-assets', '/publish/video', '/account']) {
      expect(paths).not.toContain(p)
    }
  })
})
