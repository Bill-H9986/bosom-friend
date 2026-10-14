/**
 * 草稿删除的三处一致：删掉一条生成记录时，挂靠在它下面的草稿与素材必须一起消失。
 *
 * 为什么这条测试必须自己也能跑通：它此前读 `store.files.promotions` / `store.files.materials`——
 * 这两个文件在数据店里**根本不存在**（草稿与素材都住在 contents 里，靠 kind 区分），
 * 于是它每次都以 TypeError 结束，而且没有任何门禁在跑它，
 * "删除级联是对的"这件事就一直是自说自话。
 *
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
  // 草稿与素材同一个文件、同一个数组，只有 kind 不同——这正是这个用例要守住的形状。
  store.files.contents.save([
    { _id: 'p1', kind: 'draft', metadata: { generationId: 'g1' } },
    { _id: 'p2', kind: 'draft', metadata: { generationId: 'g2' } },
    { _id: 'm1', kind: 'asset', metadata: { generationId: 'g1' } },
    { _id: 'm2', kind: 'asset', metadata: {} },
  ])

  const result = removeDraftWithArtifacts(tempRoot, new Set(['g1']))
  assert.deepEqual(result, { removedDrafts: 1, removedPromotions: 1, removedMaterials: 1 })

  const reloaded = openProductStore(tempRoot)
  assert.deepEqual(reloaded.files.generations.load().map((g) => g.id), ['g2'])
  const keptIds = reloaded.files.contents.load().map((item) => item._id).sort()
  assert.deepEqual(keptIds, ['m2', 'p2'], '只该删掉挂在 g1 下的那两条')

  // 没命中任何一条时不许写盘（写一次会平白刷新 mtime，让别的进程读到"刚变过"）。
  assert.deepEqual(removeDraftWithArtifacts(tempRoot, new Set(['no-such-generation'])),
    { removedDrafts: 0, removedPromotions: 0, removedMaterials: 0 })

  // 保存新草稿后仍可正常读回（schema 信封格式）。
  const saved = saveDraftRecord(tempRoot, { title: '新草稿', content: '正文', prompt: '测试', kind: 'image-text' })
  assert.equal(openProductStore(tempRoot).files.generations.load().some((g) => g.id === saved.id), true)

  console.log('DRAFTS_CONSISTENCY_OK')
}
finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
