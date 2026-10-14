import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordDistillation, removeDistillationsBySource } from '../../src/knowledge-distill.ts'
import { openStore } from '../../src/store.ts'

/**
 * 蒸馏样本的生命周期：源记录删除时，它的样本必须一起走。
 *
 * 缺陷背景（2026-09-22 实测）：recordDistillation 为每条生成记录追加一条样本
 * （sourceId = 生成记录 id），但删除生成记录只级联清素材与草稿——样本留在库里最多 2000 条，
 * 于是被删记录的提示词仍留在用户 knowledge.json（实测累积 47 次且无法回收）。
 */
const roots: string[] = []
function makeDeps() {
  const root = mkdtempSync(join(tmpdir(), 'bf-distill-'))
  roots.push(root)
  return { dataRoot: root, store: openStore(root) }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })
})

/** 造一条最小可用的蒸馏样本。 */
function seed(deps: ReturnType<typeof makeDeps>, sourceId: string) {
  recordDistillation(deps as never, {
    task: 'image-text',
    instruction: '靶子提示词 ' + sourceId,
    output: '正文',
    model: 'test',
    knowledgePaths: [],
    knowledgeChars: 0,
    status: 'success',
    rating: 0,
    sourceId,
  })
}

describe('蒸馏样本随源记录删除', () => {
  it('按 sourceId 删除只影响匹配项，其他样本完好', () => {
    const deps = makeDeps()
    seed(deps, 'gen-a')
    seed(deps, 'gen-b')
    seed(deps, 'gen-c')
    const removed = removeDistillationsBySource(deps as never, new Set(['gen-b']))
    expect(removed).toBe(1)
    const left = (deps.store.files.knowledge.load() as { distillations?: { sourceId: string }[] }).distillations ?? []
    expect(left.map(d => d.sourceId).sort()).toEqual(['gen-a', 'gen-c'])
  })

  it('删除不存在的 sourceId 不改动盘上内容（返回 0）', () => {
    const deps = makeDeps()
    seed(deps, 'gen-a')
    expect(removeDistillationsBySource(deps as never, new Set(['gen-zzz']))).toBe(0)
    const left = (deps.store.files.knowledge.load() as { distillations?: unknown[] }).distillations ?? []
    expect(left).toHaveLength(1)
  })

  it('空集合与空库都是无操作', () => {
    const deps = makeDeps()
    expect(removeDistillationsBySource(deps as never, new Set())).toBe(0)
    expect(removeDistillationsBySource(deps as never, new Set(['gen-a']))).toBe(0)
  })

  it('一次删除多条源记录时全部带走', () => {
    const deps = makeDeps()
    seed(deps, 'gen-1')
    seed(deps, 'gen-2')
    seed(deps, 'gen-3')
    expect(removeDistillationsBySource(deps as never, new Set(['gen-1', 'gen-3']))).toBe(2)
    const left = (deps.store.files.knowledge.load() as { distillations?: { sourceId: string }[] }).distillations ?? []
    expect(left.map(d => d.sourceId)).toEqual(['gen-2'])
  })
})
