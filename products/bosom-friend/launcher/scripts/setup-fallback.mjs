/**
 * 为 products/bosom-friend/launcher/config 建立插件解析回退目录（junction 链接）。
 * 组合解析（loader）从配置目录走 Node 解析：先查配置目录的 node_modules，
 * 再向上逐级查找。把产品层引用的全部 @deepseek-ai/* 包链接到
 * config/node_modules/@deepseek-ai 下，保证与 dsh CLI 相同的全插件可解析性。
 * 用法：node scripts/setup-fallback.mjs（或 npm run setup）
 */

import { existsSync, mkdirSync, readdirSync, symlinkSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dest = join(appRoot, 'config', 'node_modules', '@deepseek-ai')
const sources = [
  join(appRoot, 'node_modules', '@deepseek-ai'),
  join(appRoot, '..', '..', '..', 'packages', 'bundle', 'base', 'node_modules', '@deepseek-ai'),
  join(appRoot, '..', '..', '..', 'packages', 'bundle', 'web-app', 'node_modules', '@deepseek-ai'),
]

const seen = new Map()
for (const source of sources) {
  if (!existsSync(source)) continue
  for (const name of readdirSync(source)) {
    if (!seen.has(name)) seen.set(name, join(source, name))
  }
}

mkdirSync(dest, { recursive: true })
let created = 0
for (const [name, target] of seen) {
  const link = join(dest, name)
  if (existsSync(link)) {
    // 死链接（目标失效）清理后重建
    if (statSync(link, { throwIfNoEntry: false }) === undefined) { rmSync(link, { recursive: true, force: true }) }
    else continue
  }
  try {
    symlinkSync(target, link, 'junction')
    created += 1
  } catch (error) {
    console.warn('link ' + name + ' failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}
console.log('bosom-friend: fallback links ready (' + seen.size + ' candidates, created ' + created + ')')
