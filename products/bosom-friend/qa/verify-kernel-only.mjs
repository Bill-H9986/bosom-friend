#!/usr/bin/env node
/**
 * 内核唯一性检查（ADR-001 / 项目铁律「DSH 唯一运行时」）
 *
 * 事实：文本走官方内核（streamLlmWithDeltas → kernel.prompt），图片与视频都走内核媒体能力面
 * （`ctx.media` ＋ `packages/media/media-pi-ai`）——能力面只有出图 / 视频下单 / 视频轮询三个操作，
 * 语音由厂商在出片时按提示词里的台词自己念（`ctx.media` 已无语音合成），产品服务端不再持有任何厂商端点。
 * 这条检查把"直连红灯"从感觉变成可判红的清单：服务端源码里出现的厂商端点必须逐条登记，未登记的一律判红。
 *
 * 用法：node products/bosom-friend/qa/verify-kernel-only.mjs
 * 退出码：0 = 只剩已登记的直连；1 = 出现未登记的直连（回归）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = resolve(here, '..')
const srcRoot = join(productRoot, 'server', 'src')

/** 厂商端点特征（直连即命中）。 */
const VENDOR_PATTERNS = [
  { id: 'chat/completions', re: /\/chat\/completions/ },
  { id: 'images/generations', re: /\/images\/generations/ },
  { id: 'videos', re: /['`"]\/videos(\/|['`"])|\/videos\/generations/ },
  { id: 'audio/speech', re: /\/audio\/speech/ },
  { id: 'agnesapi', re: /agnesapi/ },
  { id: 'agnes base url', re: /AGNES_BASE_URL\s*=\s*['`"]https?:/ },
]

/**
 * 已登记的直连（每条都必须写清楚"为什么现在还直连"）。新增直连不加登记就判红。
 * 目标：这份清单只减不增——收一条删一条。
 */
const REGISTERED = [
  {
    file: 'agnes.ts',
    match: 'agnes base url',
    reason: '厂商基址常量（配置而非调用）：设置页据此判定"这家服务是不是 Agnes"，并写出 media-pi-ai 路由的方言字段',
  },
]

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(srcRoot)
const direct = []
const kernel = []
for (const file of files) {
  const rel = relative(srcRoot, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    // 注释里写端点名是在讲契约，不是发请求：注释行不计入直连。
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const pattern of VENDOR_PATTERNS) {
      if (pattern.re.test(line)) direct.push({ file: rel, line: index + 1, id: pattern.id, text: line.trim().slice(0, 120) })
    }
  })
  const text = lines.join('\n')
  if (/createKernelClient\(|kernel\.prompt\(/.test(text)) kernel.push(rel)
}

const registeredHits = new Set()
const unregistered = []
for (const hit of direct) {
  const entry = REGISTERED.find(r => hit.file.endsWith(r.file) && hit.id === r.match)
  if (entry === undefined) unregistered.push(hit)
  else registeredHits.add(entry.file + '|' + entry.match)
}

// 其它出网面（平台集成、网关等）：当前允许，但同样要看得见——"各干各的"之所以说不清，
// 就是因为没人把出网点列全。这里只统计，不判红（判红的是模型端点未登记）。
const EGRESS_RE = /fetch\(\s*['`"]https?:\/\/(?!127\.0\.0\.1|localhost)/

console.log('=== 走官方内核（文本） ===')
for (const f of kernel) console.log('  ' + f)
console.log('')
console.log('=== 厂商直连（共 ' + direct.length + ' 处，已登记 ' + registeredHits.size + '/' + REGISTERED.length + ' 条规则）===')
for (const hit of direct) console.log('  ' + hit.file + ':' + hit.line + '  [' + hit.id + ']  ' + hit.text)
console.log('')
for (const entry of REGISTERED) {
  const used = registeredHits.has(entry.file + '|' + entry.match)
  console.log((used ? '  已登记  ' : '  已失效  ') + entry.file + ' :: ' + entry.match + ' —— ' + entry.reason)
}
const otherEgress = []
for (const file of files) {
  const rel = relative(srcRoot, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (EGRESS_RE.test(line) && !VENDOR_PATTERNS.some(p => p.re.test(line)))
      otherEgress.push({ file: rel, line: index + 1, text: trimmed.slice(0, 110) })
  })
}
console.log('=== 其它外网出口（平台集成等，当前允许但必须看得见，共 ' + otherEgress.length + ' 处）===')
for (const hit of otherEgress) console.log('  ' + hit.file + ':' + hit.line + '  ' + hit.text)
console.log('')
if (unregistered.length > 0) {
  console.log('红灯：出现未登记的厂商直连（要么登记理由，要么改成经内核调用）：')
  for (const hit of unregistered) console.log('  ' + hit.file + ':' + hit.line + '  [' + hit.id + ']  ' + hit.text)
  process.exit(1)
}
console.log('绿灯：没有未登记的厂商直连（已登记的 ' + registeredHits.size + ' 条仍待收编进内核）')
