#!/usr/bin/env node
/**
 * 开发文档索引门禁：让"总目"不会过期。
 *
 * 为什么需要它：docs 下有 80+ 份文档，没有索引时人和 AI 都只能靠翻目录猜该读哪一份；
 * 而**手工维护的索引一定会过期**——本仓库已经有过一次：`adr/README.md` 写着"暂无，待 Phase 1 立项"，
 * 而目录里已经躺着 5 篇 ADR。索引一旦说谎，比没有索引更糟。
 *
 * 它检查三件事：
 *   ① docs 下每一个 .md 都落在 `docs/README.md` 对象地图里登记过的目录（新增文档必须先登记）；
 *   ② 每一篇 ADR 都在 `adr/README.md` 的索引表里（并检查索引里链接的文件真的存在）；
 *   ③ 每一篇 ADR 的状态词是四态之一（提议 / 已接受 / 已废弃 / 被替代）。
 *
 * 用法：node products/bosom-friend/qa/verify-docs-index.mjs
 * 退出码：0 = 全部登记且合规；1 = 有未登记或不合规项。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const DOCS = join(PRODUCT, 'docs')
const INDEX = join(DOCS, 'README.md')
const ADR_DIR = join(DOCS, 'adr')
const ADR_INDEX = join(ADR_DIR, 'README.md')

/** ADR 允许的状态词（来自《工程化流程与可追溯体系规范》，规则写死在 `adr/README.md`）。 */
const ADR_STATES = ['提议', '已接受', '已废弃', '被替代']

const failures = []

/** 递归列出目录下的 .md（相对 docs 的 posix 路径）。 */
function listMarkdown(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      listMarkdown(full, base, out)
      continue
    }
    if (entry.endsWith('.md')) out.push(relative(base, full).replaceAll('\\', '/'))
  }
  return out
}

/**
 * 从总目里取出登记过的目录。
 *
 * 只认表格行（`| \`路径\` | …`）里反引号包起来的路径——正文里提到的路径不算登记，
 * 否则"提过一句"就成了"登记过"，索引会慢慢失去意义。
 */
function registeredDirs(text) {
  const dirs = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line.trim())
    if (match === null) continue
    const raw = match[1].trim()
    if (raw === '' || raw.includes('.md')) continue
    dirs.add(raw === '.' ? '' : raw.replace(/\/+$/, ''))
  }
  return dirs
}

const files = listMarkdown(DOCS)
const indexText = existsSync(INDEX) ? readFileSync(INDEX, 'utf8') : ''
if (indexText === '') failures.push('缺少 docs/README.md（开发文档总目）')
const dirs = registeredDirs(indexText)

// ① 每份文档都要落在登记过的目录里（含其子目录）。
const unregistered = []
for (const file of files) {
  if (file === 'README.md') continue
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const covered = [...dirs].some(entry => entry === '' ? dir === '' : dir === entry || dir.startsWith(entry + '/'))
  if (!covered) unregistered.push(file)
}
if (unregistered.length > 0) {
  failures.push('有 ' + unregistered.length + ' 份文档所在目录未在 docs/README.md 登记：' + unregistered.slice(0, 8).join('、')
    + (unregistered.length > 8 ? ' 等' : ''))
}

// ② / ③ ADR：索引覆盖 + 链接存在 + 状态词合规。
if (existsSync(ADR_DIR)) {
  const adrText = existsSync(ADR_INDEX) ? readFileSync(ADR_INDEX, 'utf8') : ''
  if (adrText === '') failures.push('缺少 adr/README.md（ADR 索引）')
  const adrFiles = readdirSync(ADR_DIR).filter(name => name.startsWith('ADR-') && name.endsWith('.md'))
  const notIndexed = adrFiles.filter(name => !adrText.includes(name))
  if (notIndexed.length > 0) failures.push('有 ' + notIndexed.length + ' 篇 ADR 没进索引：' + notIndexed.join('、'))

  for (const match of adrText.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const target = join(ADR_DIR, match[1])
    if (!existsSync(target)) failures.push('ADR 索引里的链接指向不存在的文件：' + match[1])
  }

  const badState = []
  for (const name of adrFiles) {
    // 模板里的状态是一行"四选一"的占位说明，不是真实状态。
    if (name.includes('模板')) continue
    const line = readFileSync(join(ADR_DIR, name), 'utf8').split(/\r?\n/).find(item => item.startsWith('> 状态：'))
    if (line === undefined) {
      badState.push(name + '（没有"状态："字段）')
      continue
    }
    const value = line.replace('> 状态：', '').trim()
    if (!ADR_STATES.includes(value)) badState.push(name + '（状态" ' + value + '" 不是四态之一）')
  }
  if (badState.length > 0) failures.push('ADR 状态不合规：' + badState.join('；'))
}

if (failures.length > 0) {
  console.log('DOCS_INDEX_FAIL')
  for (const item of failures) console.log('  - ' + item)
  console.log('  修法：在 products/bosom-friend/docs/README.md 的对象地图里登记该目录；ADR 另加一行索引。')
  process.exit(1)
}
console.log('DOCS_INDEX_OK files=' + files.length + ' dirs=' + dirs.size + ' adr=ok')
