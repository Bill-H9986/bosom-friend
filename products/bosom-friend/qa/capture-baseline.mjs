#!/usr/bin/env node
/**
 * 源码哈希基线：对产品关键源码目录逐文件计算 SHA256，
 * 写 qa/baseline/source-hash-manifest.json（只读基准，用于改动追溯与回滚对照）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const productRoot = resolve(scriptDir, '..')
const baselineDir = join(scriptDir, 'baseline')
const manifestPath = join(baselineDir, 'source-hash-manifest.json')
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'lib', '.git', '__pycache__'])
const roots = [
  'launcher/src',
  'server/src',
  'kernel/src',
  'bundle/app/src',
  'shim',
  'project/bosom-friend-electron/electron',
  'project/bosom-friend-electron/src',
  'project/bosom-friend-harness/src',
  'project/bosom-friend-web/src',
]

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

async function collect(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) await collect(p, out)
    else if (SOURCE_EXTS.has(extname(entry.name).toLowerCase())) out.push(p)
  }
  return out
}

const files = []
for (const root of roots) {
  const abs = join(productRoot, root)
  if (!(await import('node:fs')).existsSync(abs)) continue
  files.push(...(await collect(abs)))
}
const entries = files
  .map((f) => {
    const hash = createHash('sha256').update(readFileSync(f)).digest('hex')
    return { path: relative(productRoot, f).replace(/\\/g, '/'), sha256: hash }
  })
  .sort((a, b) => a.path.localeCompare(b.path))

mkdirSync(baselineDir, { recursive: true })
writeFileSync(
  manifestPath,
  JSON.stringify({ capturedAt: new Date().toISOString(), git: gitHead(), fileCount: entries.length, files: entries }, null, 2) + '\n',
  'utf8',
)
console.log(`已写入源码哈希基线：${manifestPath}（${entries.length} 个文件）`)
