#!/usr/bin/env node
/**
 * 前端产物新鲜度：`project/bosom-friend-electron/dist` 必须是**当前源码构建出来的**。
 *
 * 为什么需要它：内核与服务端的 lib 有 `verify-runtime-lib-freshness.mjs` 盯着，**前端产物没有任何检查
 * 看着**。改完前端源码不重建 dist，源码运行时与出包都会继续用旧界面，而所有门禁都是绿的——
 * 这与 DEF-160 是同一族（产物落后于源码，没有任何东西看得见）。
 * 现场（2026-09-22）：改完账号页共用的地址函数后，dist 里仍是改动前的 bundle。
 *
 * 判据：`dist` 里最新产物的时间 ≥ 前端源码里最新文件的时间。
 * 用时间而不是内容：产物是压缩过的，逐字节比对建立不起"哪个源文件对应哪段产物"的映射；
 * 这里要拦的是"改完没构建"，时间正是这件事的直接证据。
 *
 * 用法：node products/bosom-friend/qa/verify-web-bundle-freshness.mjs [repoRoot]
 * 退出码：0 = 新鲜（或从未构建过，跳过）；1 = 落后。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = process.argv[2] ? join(process.argv[2], 'products', 'bosom-friend') : join(here, '..')
const electronRoot = join(productRoot, 'project', 'bosom-friend-electron')
const distRoot = join(electronRoot, 'dist')

/** 递归找出目录里最新的文件。 */
function newestIn(dir, out = { file: '', mtimeMs: 0 }) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { newestIn(full, out); continue }
    const mtimeMs = statSync(full).mtimeMs
    if (mtimeMs > out.mtimeMs) { out.file = full; out.mtimeMs = mtimeMs }
  }
  return out
}

/** 前端源码：web 的 src（public 可有可无）+ 入口 HTML 与 vite 配置。 */
const sourceDirs = [join(productRoot, 'project', 'bosom-friend-web', 'src'), join(productRoot, 'project', 'bosom-friend-web', 'public')]
const sourceFiles = ['index.html', 'splash.html', 'vite.config.mts'].map(name => join(electronRoot, name))

if (!existsSync(join(distRoot, 'index.html'))) {
  console.log('WEB_BUNDLE_FRESHNESS SKIP reason=dist-not-built path=' + distRoot)
  console.log('（前端还没构建过：跑一次 vite build --mode=test 才有可验的产物。）')
  process.exit(0)
}

const source = newestIn(sourceDirs[0])
for (const dir of sourceDirs.slice(1)) { const other = newestIn(dir); if (other.mtimeMs > source.mtimeMs) { source.file = other.file; source.mtimeMs = other.mtimeMs } }
for (const file of sourceFiles) {
  if (!existsSync(file)) continue
  const mtimeMs = statSync(file).mtimeMs
  if (mtimeMs > source.mtimeMs) { source.file = file; source.mtimeMs = mtimeMs }
}

const artifact = newestIn(join(distRoot, 'assets'))
const indexHtml = statSync(join(distRoot, 'index.html'))
if (indexHtml.mtimeMs > artifact.mtimeMs) { artifact.file = join(distRoot, 'index.html'); artifact.mtimeMs = indexHtml.mtimeMs }

const rel = file => file.slice(productRoot.length + 1).replace(/\\/g, '/')
if (!source.file || !artifact.file) {
  console.log('WEB_BUNDLE_FRESHNESS SKIP reason=empty-side source=' + (source.file || '(none)') + ' artifact=' + (artifact.file || '(none)'))
  process.exit(0)
}

if (source.mtimeMs > artifact.mtimeMs) {
  console.log('WEB_BUNDLE_FRESHNESS FAIL 前端产物落后于源码（跑一次 vite build --mode=test 再出包）：')
  console.log('  - 源码最新：' + rel(source.file) + '  ' + new Date(source.mtimeMs).toISOString())
  console.log('  - 产物最新：' + rel(artifact.file) + '  ' + new Date(artifact.mtimeMs).toISOString())
  process.exit(1)
}
console.log('WEB_BUNDLE_FRESHNESS PASS 前端产物是当前源码构建出来的')
console.log('  - 源码最新：' + rel(source.file))
console.log('  - 产物最新：' + rel(artifact.file))
process.exit(0)
