/**
 * 内核工具的数据访问层：全部经共享产品数据店（server/src/store.ts 的 openStore），
 * 与服务端/前端同一实现、同一 schema 信封；不再复制第二套文件读写。
 * @module @deepseek-ai/dsh-bosom-friend-kernel/data
 */

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { openStore } from '@deepseek-ai/dsh-bosom-friend-server/src/store.ts'

/** 产品数据根：DSH_HOME/bosom-friend（与旧后端 openStore 的 dataRoot 一致）。 */
export function resolveDataRoot(): string {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.bosom-friend')
  return join(home, 'bosom-friend')
}

/** 打开共享产品数据店（唯一数据实现）。 */
export function openProductStore(dataRoot: string) {
  return openStore(dataRoot)
}

/** 用户自定义大模型配置（与前端同一文件，防御性读取）。 */
export interface UserLlm {
  model: string
  baseUrl: string
}

/** 读取 llm-user.json；缺失或损坏返回空配置。 */
export function readUserLlm(dataRoot: string): UserLlm {
  try {
    const file = join(dataRoot, 'llm-user.json')
    if (!existsSync(file)) return { model: '', baseUrl: '' }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { model?: unknown; baseUrl?: unknown }
    return {
      model: typeof parsed.model === 'string' ? parsed.model : '',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
    }
  } catch {
    return { model: '', baseUrl: '' }
  }
}

/** 把未知 JSON 归一化为对象数组（坏行丢弃）。 */
export function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

/** 字符串字段安全投影。 */
export const str = (value: unknown): string => typeof value === 'string' ? value : ''

/** 数字字段安全投影。 */
export const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
