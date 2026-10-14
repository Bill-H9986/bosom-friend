import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'

/**
 * 走真实路由的级联验证：删除生成记录必须同时带走它的蒸馏样本。
 *
 * 这是 E2E 自清是否成立的关键——E2E 的 cleanupGenerations 调 DELETE ai/draft-generation，
 * 若该路由不级联清蒸馏，靶子提示词就会永久留在知识库（2026-09-22 实测累积 47 次）。
 *
 * 注意：两条删除路由都要求**生成记录本身存在**才会触发级联（findIndex >= 0），
 * 所以靶子必须同时种生成记录与样本，否则测的是早退分支。
 */
let h: Harness

afterEach(() => { h?.dispose() })

/** 落盘生成记录与它们的蒸馏样本。 */
function seed(d: Harness, ids: string[]) {
  const envelope = (value: unknown) => JSON.stringify({ schemaVersion: 1, value }, null, 2) + '\n'
  writeFileSync(join(d.dataRoot, 'draft-generations.json'), envelope(ids.map(id => ({
    id, status: 'success', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: { groupId: 'mg-persist', kind: 'image-text', prompt: '靶子 ' + id },
    response: { title: '靶子 ' + id, description: '', imageUrls: [] },
  }))), 'utf8')
  writeFileSync(join(d.dataRoot, 'knowledge.json'), envelope({
    notes: {},
    distillations: ids.map(id => ({
      id: 'dist-' + id, sourceId: id, task: 'image-text', instruction: '靶子 ' + id,
      output: '', model: 'test', knowledgePaths: [], knowledgeChars: 0,
      status: 'success', rating: 0, createdAt: new Date().toISOString(),
    })),
  }), 'utf8')
}

/** 从盘上读回蒸馏样本的 sourceId。 */
function persistedSourceIds(d: Harness): string[] {
  return (d.disk<{ distillations?: { sourceId: string }[] }>('knowledge.json').distillations ?? []).map(i => i.sourceId)
}

describe('删除生成记录级联清理蒸馏样本（走路由）', () => {
  it('DELETE ai/draft-generation 带走指定样本，其他样本保留', async () => {
    h = createHarness()
    seed(h, ['gen-keep', 'gen-drop'])
    const res = await h.call('DELETE', 'ai/draft-generation', { body: { taskIds: ['gen-drop'] } })
    expect(res.code).toBe(0)
    expect(persistedSourceIds(h)).toEqual(['gen-keep'])
  })

  it('DELETE ai/draft-generation/:id 同样级联', async () => {
    h = createHarness()
    seed(h, ['gen-x', 'gen-y'])
    await h.call('DELETE', 'ai/draft-generation/gen-x')
    expect(persistedSourceIds(h)).toEqual(['gen-y'])
  })

  it('生成记录不存在时不误删任何样本（早退分支）', async () => {
    h = createHarness()
    seed(h, ['gen-a'])
    await h.call('DELETE', 'ai/draft-generation/gen-missing')
    expect(persistedSourceIds(h)).toEqual(['gen-a'])
  })
})
