#!/usr/bin/env node
/**
 * Pre-build check: the packaged kernel runtime tree must not ship an OLDER build of the
 * product packages than the workspace.
 *
 * Why: this tree is what the installer packages. The build pipeline re-syncs `lib/` into it,
 * but **nothing detected a tree left stale** -- and two existing gates both look elsewhere:
 * `verify-runtime-config-drift.mjs` compares CONFIG (patch layers) only, and
 * `verify-kernel-bundle-freshness.mjs` compares the WORKSPACE bundle only.
 *
 * Measured 2026-09-22: the runtime tree's kernel lib was a day old (40,767 B, missing
 * `bosom_content_update_draft`) while the workspace was 44,946 B; the packaged app would have
 * shipped without a tool the feature list marks as done. A byte-level probe of the artifact
 * found it -- exactly the class DEF-052 / DEF-059 / DEF-061 warned about.
 *
 * Rule: every workspace `lib/` file must exist in the runtime copy with the same bytes.
 * Content, not timestamps: copies get new mtimes, so mtime comparisons cannot tell.
 *
 * Usage: node products/bosom-friend/desktop/verify-runtime-lib-freshness.mjs
 * Exit: 0 = fresh (or no runtime tree to check); 1 = stale or missing files.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 与兄弟脚本同一套调用风格：位置参数优先（出包脚本会传树路径），否则用默认的部署树。
const productRoot = process.argv[2] ? join(process.argv[2], 'products', 'bosom-friend') : join(here, '..')
const runtimeRoot = process.argv[3]
  ? process.argv[3]
  : process.env.BF_KERNEL_RUNTIME_ROOT
    ? process.env.BF_KERNEL_RUNTIME_ROOT
    : join(productRoot, 'desktop', 'dist', 'kernel-runtime-unpacked')

/** 递归收集目录下的全部文件（相对路径 + 绝对路径）。 */
function collect(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { collect(full, base, out); continue }
    out.push({ rel: full.slice(base.length + 1).replace(/\\/g, '/'), full })
  }
  return out
}

/** 文件内容的 sha256（前 16 位够用）。 */
function hashOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

if (!existsSync(runtimeRoot)) {
  console.log('RUNTIME_LIB_FRESHNESS SKIP reason=no-runtime-tree path=' + runtimeRoot)
  console.log('（没有可检查的运行时树：这一项只在出过包的工作区里有意义。）')
  process.exit(0)
}

/** 要对照的两个包：运行时里是 pnpm deploy 的副本，工作区里是刚构建出来的产物。 */
const packages = [
  { name: '@deepseek-ai/dsh-bosom-friend-server', lib: join(productRoot, 'server', 'lib') },
  { name: '@deepseek-ai/dsh-bosom-friend-kernel', lib: join(productRoot, 'kernel', 'lib') },
]

const stale = []
const missingTrees = []
let checked = 0
for (const pkg of packages) {
  const copyRoot = join(runtimeRoot, 'node_modules', pkg.name, 'lib')
  if (!existsSync(copyRoot)) { missingTrees.push(pkg.name); continue }
  for (const file of collect(pkg.lib)) {
    const copy = join(copyRoot, file.rel)
    checked += 1
    if (!existsSync(copy)) { stale.push(pkg.name + '/' + file.rel + '（运行时里没有这个文件）'); continue }
    const source = statSync(file.full)
    const target = statSync(copy)
    if (source.size !== target.size || hashOf(file.full) !== hashOf(copy)) {
      stale.push(pkg.name + '/' + file.rel + '（工作区 ' + source.size + ' B / 运行时 ' + target.size + ' B）')
    }
  }
}

if (missingTrees.length > 0) {
  console.log('RUNTIME_LIB_FRESHNESS SKIP reason=package-not-in-runtime packages=' + missingTrees.join(','))
  process.exit(0)
}
if (stale.length > 0) {
  console.log('RUNTIME_LIB_FRESHNESS FAIL 运行时树里是旧的构建产物（出包前必须重新同步 lib）：')
  for (const item of stale.slice(0, 12)) console.log('  - ' + item)
  if (stale.length > 12) console.log('  …还有 ' + String(stale.length - 12) + ' 个')
  process.exit(1)
}
console.log('RUNTIME_LIB_FRESHNESS PASS checked=' + String(checked) + ' root=' + runtimeRoot)
