/**
 * M3 存储一致性单测：schema 信封、fsync 原子写、旧格式迁移、
 * “生成记录→推广/素材”三处一致过滤。运行：
 * node --import tsx/esm products/bosom-friend/server/test/store-consistency.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterGenerationArtifacts, JsonFile } from '../src/store.ts'

const tempRoot = mkdtempSync(join(tmpdir(), 'bf-store-'))

try {
  // 1. 写入为 schema 信封，读取还原，无临时残留
  const file = join(tempRoot, 'a.json')
  const store = new JsonFile(file, () => [])
  const value = store.load()
  value.push({ id: '1' })
  store.save(value)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.deepEqual(raw.value, [{ id: '1' }])
  assert.equal(readdirSync(tempRoot).some((name) => name.includes('.tmp-')), false)

  // 2. 旧平铺格式读取，首次保存后升级为信封
  const legacy = join(tempRoot, 'legacy.json')
  writeFileSync(legacy, JSON.stringify([{ id: 'x' }], null, 2), 'utf8')
  const legacyStore = new JsonFile(legacy, () => [])
  assert.equal(legacyStore.load().length, 1)
  legacyStore.save(legacyStore.load())
  const migrated = JSON.parse(readFileSync(legacy, 'utf8'))
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.value[0].id, 'x')

  // 3. 三处一致：只移除被删生成记录挂靠的推广与素材
  const ids = new Set(['g1'])
  const promotions = [
    { id: 'p1', metadata: { generationId: 'g1' } },
    { id: 'p2', metadata: { generationId: 'g2' } },
  ]
  const materials = [
    { _id: 'm1', metadata: { generationId: 'g1' } },
    { _id: 'm2', metadata: {} },
  ]
  assert.deepEqual(filterGenerationArtifacts(ids, promotions).map((p) => p.id), ['p2'])
  assert.deepEqual(filterGenerationArtifacts(ids, materials).map((m) => m._id), ['m2'])

  console.log('STORE_CONSISTENCY_OK')
}
finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
