#!/usr/bin/env node
/**
 * Pre-build check: the kernel bundle must be newer than every source file it embeds.
 *
 * Why: products/bosom-friend/kernel bundles its dependencies from SOURCE
 * (`@deepseek-ai/dsh-bosom-friend-server/src/store.ts`), not from the package's lib/.
 * pnpm injects the workspace packages as HARD LINKS into node_modules/.pnpm; rewriting a
 * file (what an editor does) replaces the inode and breaks that link, so the injected copy
 * keeps the OLD bytes. A subsequent pnpm install sees an unchanged length/mtime and does NOT
 * repair it.
 *
 * Measured 2026-09-21: the injected store.ts was 19703 B (2026-09-17) while the workspace
 * source was 26397 B (2026-09-21). esbuild therefore emitted a 36.2 kB bundle without the
 * fixes; the correct bundle is 39.8 kB. Nothing failed -- only a byte-level probe of the
 * artifact revealed it.
 *
 * This check compares timestamps instead of content so it needs no generated marker file:
 * a build that read stale sources leaves a bundle OLDER than the sources.
 *
 * Usage: node products/bosom-friend/desktop/verify-kernel-bundle-freshness.mjs
 * Exit: 0 = fresh; 1 = stale or missing.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = join(here, '..')
const bundle = join(productRoot, 'kernel', 'lib', 'index.js')

/** 递归收集目录下的 .ts 文件（跳过测试与构建产物）。 */
function collectSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      collectSources(full, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

if (!existsSync(bundle)) {
  console.log('FAIL kernel bundle missing: ' + bundle)
  console.log('KERNEL_BUNDLE FRESHNESS FAIL reason=bundle-missing')
  process.exit(1)
}

const bundleMtime = statSync(bundle).mtimeMs
const sources = [
  ...collectSources(join(productRoot, 'kernel', 'src')),
  // The kernel imports the server's store/drafts helpers straight from source.
  join(productRoot, 'server', 'src', 'store.ts'),
]

const stale = sources.filter(file => existsSync(file) && statSync(file).mtimeMs > bundleMtime)

console.log('bundle  ' + bundle)
console.log('  mtime ' + new Date(bundleMtime).toISOString())
console.log('sources ' + String(sources.length) + ' file(s) checked')
for (const file of stale) {
  console.log('  STALE ' + file + '  (' + new Date(statSync(file).mtimeMs).toISOString() + ')')
}

if (stale.length > 0) {
  console.log('')
  console.log('kernel/lib/index.js is OLDER than its sources: the bundle was built from stale inputs.')
  console.log('Fix: run `pnpm install` (to re-inject workspace packages as hard links), then')
  console.log('     `pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build`, and re-run this check.')
  console.log('KERNEL_BUNDLE FRESHNESS FAIL stale=' + String(stale.length))
  process.exit(1)
}

console.log('KERNEL_BUNDLE FRESHNESS PASS checked=' + String(sources.length))
