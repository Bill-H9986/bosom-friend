import { loadSources, loadUploaderFacts, loadConstraintFacts } from './sources.mjs'
import { buildEvidenceChain, judgeEvidenceRow, typesFromActions } from './evidence.mjs'
const base = loadSources({})
const u = loadUploaderFacts({})
const workerSrc = null
// engineKey -> CLI parser 名（与 product 同源）
const cliActionsByPlatform = {}
const rawActionsByEngineKey = {}
const engineToCli = {}
for (const [ek, cliName] of Object.entries(u.cliActionsByPlatform ?? {})) cliActionsByPlatform[ek] = cliName
// 原始 action 明细
import { readFileSync } from 'node:fs'
const cliSrc = readFileSync('../../engine/social-auto-upload/sau_cli.py', 'utf8')
let cur = null
const acts = {}
for (const line of cliSrc.split(/\r?\n/)) {
  const m = /^\s*[\w]+\s*=\s*([\w.]+)\.add_parser\(\s*["']([\w-]+)["']/.exec(line)
  if (!m) continue
  const b = m[1], n = m[2]
  if (b === 'platform_parsers') { cur = n; acts[cur] = []; continue }
  const o = /^(\w+)_actions$/.exec(b)?.[1]
  if (o && acts[o] && /^(upload|post|publish)/.test(n)) acts[o].push(n)
}
const workerSrc2 = readFileSync('../../engine/worker.py', 'utf8')
const mb = /CLI_PLATFORM_MAP\s*=\s*\{([^}]*)\}/s.exec(workerSrc2)?.[1] ?? ''
for (const m of mb.matchAll(/"([\w]+)"\s*:\s*"([\w]+)"/g)) { engineToCli[m[1]] = m[2]; rawActionsByEngineKey[m[2]] = acts[m[2]] ?? [] }
// 产品声明（从前端实际 modes 读到的口径，这里用同源推导：CLI action）
const declaredTypes = {}
for (const [dir, k] of Object.entries(base.keys)) declaredTypes[k.platform] = cliActionsByPlatform[k.engineKey] ?? []
const rows = buildEvidenceChain({
  uploaders: u, cliActionsByPlatform, rawActionsByEngineKey, engineToCli,
  keys: base.keys, declaredTypes, contractPlatforms: ['douyin','tencent','xiaohongshu','kuaishou'],
  dynamicMarkers: u.dynamicMarkers,
})
console.log('证据行数=' + rows.length)
for (const r of rows) {
  const j = judgeEvidenceRow(r)
  console.log([r.platformId.padEnd(10), r.contentType.padEnd(11), 'declared=' + (r.declaration.declared ? 'Y' : 'n'), 'action=' + (r.entry.actionExists ? 'Y' : 'n'), 'blocked=' + (r.implementation.blocked.length || 0)].join(' ') + '  => ' + j.status)
}