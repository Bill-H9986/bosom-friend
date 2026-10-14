#!/usr/bin/env node
/**
 * 数据完整性门禁：扫描产品数据根的 JSON 文件，命中「编码损坏」即红灯。
 * 判定：字符串值里出现连续 3 个以上 '?'（U+003F）或整串只由 '?' 组成，
 * 或文件带 UTF-8 BOM。用法：node products/bosom-friend/qa/check-data-integrity.mjs [数据根]
 * 退出码：0 = 干净；1 = 发现损坏（禁止交付）。
 *
 * 2026-09-14 细化：判定正文前先剥掉行内代码与围栏代码块。项目铁律 #9.5 用 `?`／`??????`
 * 这样的片段**举例说明**损坏长什么样；知识库把该文档收进产品数据根之后，原来的判据会把这段
 * 说明当成真损坏（DATA_INTEGRITY FAIL，1 处误报）。真损坏（正文里的长问号串）仍然必须判红——
 * 负向对照见 qa/reports/gate-20260914-*.md 与 qa/reports/cleanup-2026-09-14-retired-rollback-net.md。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.argv[2] ?? join(homedir(), '.bosom-friend', 'bosom-friend')
const hits = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['uploads', 'backups', 'backups-held', 'platform-login', 'node_modules'].includes(entry.name)) continue
      walk(p)
      continue
    }
    if (!entry.name.endsWith('.json')) continue
    const bytes = readFileSync(p)
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
      hits.push({ file: p, path: '<file>', value: 'UTF-8 BOM' })
    let text
    try { text = bytes.toString('utf8') } catch { continue }
    let data
    try { data = JSON.parse(text) } catch { continue }
    scan(data, p, '')
  }
}

/**
 * 判断一个字符串值是否属于「编码损坏」。
 *
 * 先剥掉行内代码与围栏代码块：文档会用代码片段举例说明损坏长什么样（项目铁律 #9.5 就是），
 * 那不是损坏。剥离后仍出现 3 个以上连续 '?'，或整串只剩 '?'，才判损坏。
 *
 * @param value - 待判定的字符串值。
 * @returns 命中损坏判据时返回 true。
 */
function corrupt(value) {
  const prose = value.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  return /\?{3,}/.test(prose) || (prose.length > 1 && /^\?+$/.test(prose))
}

function scan(node, file, path) {
  if (typeof node === 'string') {
    if (corrupt(node))
      hits.push({ file, path, value: node.slice(0, 60) })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => scan(item, file, path + '[' + index + ']'))
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) scan(value, file, path === '' ? key : path + '.' + key)
  }
}

if (!existsSync(root)) {
  console.log('DATA_INTEGRITY SKIP root=' + root + ' (不存在)')
  process.exit(0)
}
walk(root)
if (hits.length === 0) {
  console.log('DATA_INTEGRITY PASS root=' + root)
  process.exit(0)
}
console.log('DATA_INTEGRITY FAIL root=' + root + ' hits=' + hits.length)
for (const hit of hits.slice(0, 40)) console.log('  ' + hit.file.replace(root, '.') + ' :: ' + hit.path + ' = "' + hit.value + '"')
process.exit(1)
