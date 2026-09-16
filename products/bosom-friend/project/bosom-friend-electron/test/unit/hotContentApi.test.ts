import { describe, expect, it, vi } from 'vitest'

describe('热点内容 API 数据防御', () => {
  it('接口返回非数组时降级为空数组（防止白屏）', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { code: 404, message: 'Cannot GET /v2/hot-content/categories' },
    })

    vi.doMock('@web/utils/request', () => ({
      default: { get: mockGet },
    }))

    const { listHotContentCategories, listHotContentHomeSources } = await import('../../../aitoearn-web/src/app/[lng]/hot-content/api')
    const categories = await listHotContentCategories()
    const sources = await listHotContentHomeSources()

    expect(Array.isArray(categories)).toBe(true)
    expect(Array.isArray(sources)).toBe(true)
    expect(categories.length).toBe(0)
    expect(sources.length).toBe(0)
  })
})
