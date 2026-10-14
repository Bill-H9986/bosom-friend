#!/usr/bin/env node
/**
 * 路由黄金基线：抽取 server 全部 m/p 路由对，写 qa/golden/routes-master.txt。
 * 用法：node capture-routes.mjs        # 建立/刷新基线
 *       node capture-routes.mjs --verify # 只读比对当前路由与基线
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const serverSrc = join(scriptDir, '..', 'server', 'src')
const goldenDir = join(scriptDir, 'golden')
const goldenPath = join(goldenDir, 'routes-master.txt')
const routeFiles = ['api.ts', 'routes-channels.ts', 'routes-content.ts', 'routes-knowledge.ts']

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

function extractRoutes() {
  const entries = []
  for (const file of routeFiles) {
    const path = join(serverSrc, file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const m = /m:\s*'([^']+)'/.exec(lines[i])
      if (m === null) continue
      const p = /p:\s*'([^']+)'/.exec(lines[i + 1] ?? '')
      if (p !== null) entries.push(`${m[1]} ${p[1]}`)
    }
  }
  return [...new Set(entries)].sort()
}

const routes = extractRoutes()
const content = [
  `# Bosom Friend 后端路由黄金基线`,
  `# 捕获时间：${new Date().toISOString()}`,
  `# Git：${gitHead()}`,
  `# 总数：${routes.length}`,
  ...routes,
  '',
].join('\n')

if (process.argv.includes('--verify')) {
  if (!existsSync(goldenPath)) {
    console.error('缺少路由黄金基线，请先运行 capture-routes.mjs')
    process.exit(1)
  }
  const stored = readFileSync(goldenPath, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
  const current = routes
  const missing = stored.filter((r) => !current.includes(r))
  const added = current.filter((r) => !stored.includes(r))
  console.log(`基线 ${stored.length} 条；当前 ${current.length} 条；减少 ${missing.length} 条；新增 ${added.length} 条`)
  if (missing.length > 0) console.log('路由减少（可能破坏前端）：\n' + missing.join('\n'))
  process.exit(missing.length > 0 ? 1 : 0)
} else {
  mkdirSync(goldenDir, { recursive: true })
  writeFileSync(goldenPath, content, 'utf8')
  console.log(`已写入路由黄金基线：${goldenPath}（${routes.length} 条）`)
}
