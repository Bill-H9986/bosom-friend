import { api, bodyText, expect, openRoute, test } from '../fixtures'

/**
 * AI 智能体（核心功能 C）任务 CRUD：创建 → 读取 → 评分/收藏 → 删除。
 * 走非 SSE 创建（只落任务，不触发模型），因此用例不依赖模型可用性；靶子任务自建自删。
 */
test.describe('AI 智能体任务 CRUD', () => {
  test('任务：创建 → 读取 → 评分/收藏 → 删除', async ({ page }) => {
    const prompt = 'E2E 任务 CRUD ' + Date.now()
    const created = await api('POST', 'agent/tasks', { prompt })
    const taskId = created.data?.id as string
    expect(taskId, '非 SSE 创建任务必须返回任务 id').toBeTruthy()

    try {
      const read = await api('GET', 'agent/tasks/' + taskId)
      expect(read.code, '任务详情可读').toBe(0)
      expect(read.data?.id, '读到的就是刚建的任务').toBe(taskId)
      expect(String(read.data?.title ?? '').startsWith('E2E 任务 CRUD'), '标题取提示词前 30 字').toBe(true)

      const rating = await api('POST', 'agent/tasks/' + taskId + '/rating', { rating: 5, comment: 'E2E 自检评分' })
      expect(rating.code, '评分写入成功').toBe(0)
      // DEF-018 回归：读接口只回一层 data。
      const ratingRead = await api('GET', 'agent/tasks/' + taskId + '/rating')
      expect(ratingRead.data?.rating, '评分回读为 5').toBe(5)
      expect(ratingRead.data?.data, '不得再出现 data.data 双包装').toBeUndefined()

      const favorite = await api('POST', 'agent/tasks/' + taskId + '/favorite')
      expect(favorite.code, '收藏成功').toBe(0)
      const favorites = await api('GET', 'agent/tasks?page=1&pageSize=50&favoriteOnly=true')
      expect((favorites.data?.list ?? []).some((item: { id: string }) => item.id === taskId), '收藏后出现在收藏筛选里').toBe(true)

      const keyword = await api('GET', 'agent/tasks?page=1&pageSize=50&keyword=' + encodeURIComponent('E2E 任务 CRUD'))
      expect((keyword.data?.list ?? []).some((item: { id: string }) => item.id === taskId), '关键词搜索能命中').toBe(true)

      // 页面可见性：任务历史页能打开且无 JS 异常。
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(String(error).slice(0, 160)))
      await openRoute(page, '#/tasks-history', 8000)
      expect((await bodyText(page)).length, '任务历史页必须渲染出内容').toBeGreaterThan(50)
      expect(pageErrors, '任务历史页不应有 JS 异常').toEqual([])
    }
    finally {
      const removed = await api('DELETE', 'agent/tasks/' + taskId)
      expect(removed.code, '清理靶子任务').toBe(0)
    }

    const gone = await api('GET', 'agent/tasks/' + taskId)
    expect(gone.code, '删除后任务不存在（18100）').toBe(18100)
  })
})
