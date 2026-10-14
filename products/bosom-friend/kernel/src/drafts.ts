/**
 * 草稿记录写入：经共享产品数据店（schema 信封原子写），与服务端完全一致。
 * @module @deepseek-ai/dsh-bosom-friend-kernel/drafts
 */

import { randomUUID } from 'node:crypto'
import { filterGenerationArtifacts } from '@deepseek-ai/dsh-bosom-friend-server/src/store.ts'
import { openProductStore } from './data.ts'

/** 与 ZyDraftGenerationTask 兼容的草稿记录（仅保留内核工具会写的字段）。 */
export interface DraftRecord {
  id: string
  status: 'success'
  points: number
  request?: {
    kind?: 'video' | 'image-text'
    prompt?: string
  }
  response?: {
    title?: string
    description?: string
    topics?: string[]
    imageTexts?: { title: string; content: string }[]
  }
  createdAt: string
  updatedAt: string
}

/**
 * 追加一条草稿记录并原子落盘。
 * @param dataRoot - 产品数据根（~/.bosom-friend/bosom-friend）。
 * @param input - 草稿内容。
 * @returns 已落盘的记录。
 */
export function saveDraftRecord(
  dataRoot: string,
  input: { title: string; content: string; kind: 'video' | 'image-text'; prompt: string },
): DraftRecord {
  const store = openProductStore(dataRoot)
  const rows = store.files.generations.load()
  const now = new Date().toISOString()
  const record: DraftRecord = {
    id: randomUUID(),
    status: 'success',
    points: 0,
    request: { kind: input.kind, prompt: input.prompt },
    response: {
      title: input.title,
      description: input.content,
      topics: [],
      imageTexts: [{ title: input.title, content: input.content }],
    },
    createdAt: now,
    updatedAt: now,
  }
  rows.push(record)
  store.files.generations.save(rows)
  return record
}

/** 删除草稿的结果统计（三处一致）。 */
export interface DraftRemovalResult {
  removedDrafts: number
  removedPromotions: number
  removedMaterials: number
}

/**
 * 删除草稿并同步移除其挂靠的推广与素材（生成/推广/素材三处一致）。
 * 未命中时不做任何写入。
 */
export function removeDraftWithArtifacts(dataRoot: string, ids: ReadonlySet<string>): DraftRemovalResult {
  const store = openProductStore(dataRoot)
  const generations = store.files.generations.load()
  const nextGenerations = generations.filter((item) => !ids.has(item.id))
  // 草稿与素材都住在 contents，靠 kind 区分（'draft' | 'asset'）；store.files 里
  // 没有 promotions / materials 这两个文件，此前直接 load 必抛
  // 「Cannot read properties of undefined (reading 'load')」。
  const contents = store.files.contents.load()
  const promotions = contents.filter(item => item.kind === 'draft')
  const nextPromotions = filterGenerationArtifacts(ids, promotions)
  const materials = contents.filter(item => item.kind === 'asset')
  const nextMaterials = filterGenerationArtifacts(ids, materials)
  const result: DraftRemovalResult = {
    removedDrafts: generations.length - nextGenerations.length,
    removedPromotions: promotions.length - nextPromotions.length,
    removedMaterials: materials.length - nextMaterials.length,
  }
  if (result.removedDrafts === 0 && result.removedPromotions === 0 && result.removedMaterials === 0) {
    return result
  }
  const dropped = new Set(
    [...promotions, ...materials]
      .filter(item => !nextPromotions.includes(item) && !nextMaterials.includes(item))
      .map(item => String(item._id ?? item.id ?? '')),
  )
  store.files.generations.save(nextGenerations)
  store.files.contents.save(contents.filter(item => !dropped.has(String(item._id ?? item.id ?? ''))))
  return result
}
