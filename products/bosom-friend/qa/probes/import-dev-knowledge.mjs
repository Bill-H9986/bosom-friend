#!/usr/bin/env node
/**
 * 把本机的开发过程与经验导入产品知识库（knowledge.json）。
 *
 * 背景：产品知识库不只是内容素材库，它同时是这个项目全部"过程与经验"的沉淀地——
 * 工作日志、缺陷台账、复盘报告、规范、以及整理出来的经验条目。旧版本安装包与历史备份
 * 会被清理，但这些经验必须留下（2026-09-14 的决定）。
 *
 * 设计约束：
 *  - **只增不改**：不删除任何已有笔记，也不碰应用自己写的 \`自动沉淀/\` 目录；
 *  - **写入前必备份**：knowledge.json 先复制成 knowledge.json.bak-<时间戳>；
 *  - **按内容去重**：SHA256 相同的文件只收第一份，其余在清单里标为重复；
 *  - **可复核**：清单同时落 知识库笔记（工程经验/清单.md）与 qa/reports/knowledge-import-*.json；
 *  - **可重跑**：同名笔记按最新原文覆盖；\`--dry-run\` 只统计不写盘。
 *
 * 用法：
 *   node products/bosom-friend/qa/probes/import-dev-knowledge.mjs --dry-run
 *   node products/bosom-friend/qa/probes/import-dev-knowledge.mjs --apply
 *   node products/bosom-friend/qa/probes/import-dev-knowledge.mjs --dry-run --include-dsh
 *
 * 退出码：0 = 成功；1 = 失败（知识库不可解析 / 备份失败 / 无素材）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = resolve(HERE, '..', '..')
const REPO = resolve(PRODUCT, '..', '..')
const HOME = homedir()

const APPLY = process.argv.includes('--apply')
const INCLUDE_DSH = process.argv.includes('--include-dsh')
const KB_FILE = join(HOME, '.bosom-friend', 'bosom-friend', 'knowledge.json')
const NOTE_ROOT = '知识库'
const MAX_NOTE_BYTES = 80 * 1024
const MIN_NOTE_BYTES = 200
/** 生成型目录/参考目录不是经验，收进来只会稀释检索。 */
const SKIP_PATH = /(^|[\\/])(node_modules|\.git|vendor|dist|lib|legacy-archive|evidence|acceptance|website|release)([\\/]|$)|config-catalog|module-graph|tool-catalog|\.i18n\.yaml$/
/** 仓库根目录里属于"门面"而不是"过程"的文件。 */
const SKIP_ROOT = /^(README|CONTRIBUTING|BRAND_GUIDELINES|LICENSE|THIRD_PARTY_NOTICES|CLAUDE)/

/**
 * 素材分组：每组把一棵目录树收进一个知识库文件夹。
 * @returns 分组定义数组（名称、根目录、包含规则）。
 */
function groups() {
  const list = [
    {
      name: '条目',
      root: join(PRODUCT, 'docs', '知识库', '条目'),
      match: file => file.endsWith('.md'),
      flatten: true,
    },
    {
      name: '原文/本仓库',
      root: REPO,
      match: file => {
        if (file.endsWith('.md') === false) return false
        if (SKIP_PATH.test(file)) return false
        const rel = relative(REPO, file).replace(/\\/g, '/')
        if (rel.startsWith('products/bosom-friend/docs/知识库/')) return false
        if (rel.startsWith('products/bosom-friend/qa/')) return true
        if (rel.startsWith('products/bosom-friend/')) return true
        if (rel.startsWith('工作日志-')) return true
        if (rel.includes('/')) return false
        const name = basename(file)
        return SKIP_ROOT.test(name) === false
      },
      flatten: false,
    },
    {
      name: '原文/另一份副本',
      root: join(HOME, 'Desktop', 'bosom-friend-app'),
      match: file => file.endsWith('.md') && SKIP_PATH.test(file) === false,
      flatten: false,
    },
    {
      name: '原文/历史备份',
      root: join(HOME, 'Documents', '项目历史备份'),
      match: file => file.endsWith('.md') && SKIP_PATH.test(file) === false,
      flatten: false,
    },
  ]
  if (INCLUDE_DSH) {
    list.push({
      name: '原文/DSH内核',
      root: REPO,
      match: file => file.endsWith('.md') && SKIP_PATH.test(file) === false
        && (relative(REPO, file).replace(/\\/g, '/').startsWith('.agents/notes/')
          || relative(REPO, file).replace(/\\/g, '/').startsWith('docs/')),
      flatten: false,
    })
  }
  return list
}

/** 递归列出目录下的全部文件（跳过符号链接与不可读目录）。 */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')
const norm = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

/** 收集素材：过滤尺寸、按内容去重、超限切片。 */
function collect() {
  const seen = new Map()
  const items = []
  const duplicates = []
  const skipped = []
  for (const group of groups()) {
    if (!existsSync(group.root)) {
      skipped.push({ group: group.name, reason: '目录不存在：' + group.root })
      continue
    }
    for (const file of walk(group.root)) {
      if (!group.match(file)) continue
      const size = statSync(file).size
      if (size < MIN_NOTE_BYTES) { skipped.push({ path: file, reason: '过小' }); continue }
      const text = norm(readFileSync(file, 'utf8'))
      const hash = sha(text)
      if (seen.has(hash)) { duplicates.push({ path: file, of: seen.get(hash) }); continue }
      const rel = relative(group.root, file).replace(/\\/g, '/')
      const noteBase = group.flatten ? NOTE_ROOT + '/' + group.name + '/' + basename(file) : NOTE_ROOT + '/' + group.name + '/' + rel
      seen.set(hash, file)
      if (Buffer.byteLength(text, 'utf8') <= MAX_NOTE_BYTES) {
        items.push({ note: noteBase, source: file, group: group.name, bytes: Buffer.byteLength(text, 'utf8'), content: text, hash })
        continue
      }
      const chunks = []
      let rest = text
      while (rest.length > 0) {
        let cut = Math.min(rest.length, MAX_NOTE_BYTES)
        const nextBreak = rest.lastIndexOf('\n', cut)
        if (nextBreak > MAX_NOTE_BYTES / 2) cut = nextBreak + 1
        chunks.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      chunks.forEach((chunk, index) => {
        items.push({
          note: noteBase.replace(/\.md$/, '-part' + (index + 1) + '.md'),
          source: file,
          group: group.name,
          bytes: Buffer.byteLength(chunk, 'utf8'),
          content: chunk,
          hash,
        })
      })
    }
  }
  return { items, duplicates, skipped }
}

/** 把导入结果渲染成人类可读清单（也作为知识库里的「清单」笔记）。 */
function renderManifest(items, duplicates, skipped, stamp) {
  const byGroup = new Map()
  for (const item of items) {
    const list = byGroup.get(item.group) ?? []
    list.push(item)
    byGroup.set(item.group, list)
  }
  const lines = [
    '# 工程经验导入清单',
    '',
    '- 导入时间：' + stamp,
    '- 素材分组与篇数：' + [...byGroup.entries()].map(([group, list]) => group + ' ' + list.length + ' 篇').join('；'),
    '- 重复（同内容只留一份）：' + duplicates.length + ' 篇',
    '- 跳过：' + skipped.length + ' 条',
    '',
    '## 逐篇对应（知识库笔记 ← 来源文件）',
    '',
  ]
  for (const [group, list] of byGroup) {
    lines.push('### ' + group, '')
    for (const item of list.sort((a, b) => a.note.localeCompare(b.note))) {
      lines.push('- \`' + item.note + '\` ← \`' + item.source.replace(HOME, '~') + '\`（' + item.bytes + ' B，sha256 ' + item.hash.slice(0, 12) + '）')
    }
    lines.push('')
  }
  if (duplicates.length > 0) {
    lines.push('## 重复（未导入）', '')
    for (const dup of duplicates) lines.push('- \`' + dup.path.replace(HOME, '~') + '\` 与 ' + (dup.of ?? '').replace(HOME, '~') + ' 内容相同')
    lines.push('')
  }
  if (skipped.length > 0) {
    lines.push('## 跳过', '')
    for (const skip of skipped) lines.push('- ' + (skip.path ? '\`' + skip.path.replace(HOME, '~') + '\`：' : skip.group + '：') + skip.reason)
    lines.push('')
  }
  return lines.join('\n')
}

const stamp = new Date().toISOString()
const { items, duplicates, skipped } = collect()
if (items.length === 0) {
  console.log('FAIL 没有收集到任何素材，检查路径与过滤规则。')
  process.exit(1)
}
const bytes = items.reduce((sum, item) => sum + item.bytes, 0)
console.log('收集：' + items.length + ' 篇 / ' + (bytes / 1024 / 1024).toFixed(2) + ' MB；重复 ' + duplicates.length + '；跳过 ' + skipped.length)
for (const [group, count] of Object.entries(items.reduce((acc, item) => ({ ...acc, [item.group]: (acc[item.group] ?? 0) + 1 }), {}))) {
  console.log('  ' + group + '：' + count + ' 篇')
}
if (process.argv.includes('--list')) {
  for (const item of items) console.log('  ' + item.note + '  ←  ' + item.source.replace(HOME, '~'))
}

if (!existsSync(KB_FILE)) {
  console.log('FAIL 找不到知识库文件：' + KB_FILE)
  process.exit(1)
}
let envelope
try {
  envelope = JSON.parse(readFileSync(KB_FILE, 'utf8'))
}
catch (error) {
  console.log('FAIL 知识库不可解析：' + error.message)
  process.exit(1)
}
const value = envelope.value ?? {}
value.notes = value.notes ?? {}
const before = Object.keys(value.notes).length
const manifest = renderManifest(items, duplicates, skipped, stamp)
value.notes[NOTE_ROOT + '/清单.md'] = { name: '清单', content: manifest, protected: true }
let added = 0
let updated = 0
for (const item of items) {
  if (value.notes[item.note]) updated += 1
  else added += 1
  value.notes[item.note] = { name: basename(item.note).replace(/\.md$/, ''), content: item.content, protected: true }
}
const after = Object.keys(value.notes).length
console.log('知识库笔记：' + before + ' → ' + after + '（新增 ' + added + '，覆盖 ' + updated + '，含清单 1 篇）')

if (!APPLY) {
  console.log('DRY-RUN 未写盘。加 --apply 才会写入（写入前自动备份）。')
  process.exit(0)
}
const backup = KB_FILE + '.bak-' + stamp.replace(/[:.]/g, '-')
copyFileSync(KB_FILE, backup)
const reportDir = join(PRODUCT, 'qa', 'reports')
mkdirSync(reportDir, { recursive: true })
const report = join(reportDir, 'knowledge-import-' + stamp.replace(/[:.]/g, '-') + '.json')
writeFileSync(report, JSON.stringify({
  importedAt: stamp,
  knowledgeFile: KB_FILE,
  backup,
  counts: { items: items.length, duplicates: duplicates.length, skipped: skipped.length, notesBefore: before, notesAfter: after, added, updated },
  items: items.map(item => ({ note: item.note, source: item.source, bytes: item.bytes, sha256: item.hash })),
  duplicates,
  skipped,
}, null, 2), 'utf8')
const tmp = KB_FILE + '.tmp'
writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8')
renameSync(tmp, KB_FILE)
console.log('APPLIED 备份：' + backup)
console.log('APPLIED 报告：' + report)
console.log('APPLIED 知识库：' + KB_FILE + '（' + after + ' 篇笔记）')
