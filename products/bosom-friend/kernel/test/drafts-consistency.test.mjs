/**
 * M4b 草稿三处一致单测：删除草稿必须同步移除其挂靠的推广与素材。
 * 运行：node --import tsx/esm products/bosom-friend/kernel/test/drafts-consistency.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProductStore } from '../src/data.ts'
import { removeDraftWithArtifacts, saveDraftRecord } from '../src/drafts.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'bf-drafts-'))

try {
  const store = openProductStore(tempRoot)
  store.files.generations.save([
    { id: 'g1', status: 'success', points: 0, createdAt: 't1', updatedAt: 't1' },
    { id: 'g2', status: 'success', points: 0, createdAt: 't2', updatedAt: 't2' },
  ])
  store.files.promotions.save([
    { id: 'p1', metadata: { generationId: 'g1' } },
    { id: 'p2', metadata: { generationId: 'g2' } },
  ])
  store.files.materials.save([
    { _id: 'm1', metadata: { generationId: 'g1' } },
    { _id: 'm2', metadata: {} },
  ])

  const result = removeDraftWithArtifacts(tempRoot, new Set(['g1']))
  assert.deepEqual(result, { removedDrafts: 1, removedPromotions: 1, removedMaterials: 1 })

  const reloaded = openProductStore(tempRoot)
  assert.deepEqual(reloaded.files.generations.load().map((g) => g.id), ['g2'])
  assert.deepEqual(reloaded.files.promotions.load().map((p) => p.id), ['p2'])
  assert.deepEqual(reloaded.files.materials.load().map((m) => m._id), ['m2'])

  // 保存新草稿后仍可正常读回（信封格式）
  const saved = saveDraftRecord(tempRoot, { title: '新草稿', content: '正文', prompt: '测试', kind: 'image-text' })
  assert.equal(openProductStore(tempRoot).files.generations.load().some((g) => g.id === saved.id), true)

  console.log('DRAFTS_CONSISTENCY_OK')
}
finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
