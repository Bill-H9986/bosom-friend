#!/usr/bin/env node
/**
 * 平台规则一致性门禁：**站内规则表**（agent-rules.ts，教给模型的教案）与
 * **权威上限表**（platform-catalog.ts，只登记有出处的数字）必须是同一个真相。
 *
 * 为什么需要它（2026-10-11 实测教训）：两处各写了一个抖音标题上限，教案写 ≤30（编的），
 * 引擎实测是 20——模型照着 30 写字、引擎按 20 拒收，撞了很久的墙才被发现（DEF-253）。
 * 数字可以有第二处，但不能有两个真相：这里逐行比对，并且**权威表没登记的平台，教案里也不许出现数字**。
 *
 * 用法：node qa/verify-platform-rules.mjs [--selftest]
 *   --selftest  负向自测：构造一组不一致的数据，必须判 FAIL（否则门禁本身不可信）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = join(here, '..', 'server', 'src')

/** 权威表：平台 id -> 标题上限（未登记则无）。 */
function parseTruth(text) {
  const out = new Map()
  const re = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{([^}]*)\}/gm
  for (const m of text.matchAll(re)) {
    const id = m[1]
    const body = m[2]
    const title = /title:\s*(\d+)/.exec(body)
    out.set(id, { title: title === null ? undefined : Number(title[1]) })
  }
  return out
}

/** 教案表：平台 id -> 标题列里出现的数字（无则 undefined）。 */
function parseLesson(text) {
  const out = new Map()
  const re = /^\|\s*([^|]*?)\s+([A-Za-z][A-Za-z0-9]*)\s*\|([^|]*)\|/gm
  for (const m of text.matchAll(re)) {
    const id = m[2]
    const cell = m[3]
    const num = /≤\s*(\d+)\s*字/.exec(cell)
    out.set(id, { title: num === null ? undefined : Number(num[1]) })
  }
  return out
}

/** 比对两表；返回问题列表（空数组 = 一致）。 */
function compare(truth, lesson) {
  const problems = []
  for (const [id, t] of truth) {
    const l = lesson.get(id)
    if (l === undefined) {
      problems.push('教案里找不到平台 ' + id + ' 的规则行（权威表有登记）')
      continue
    }
    if (t.title !== undefined && l.title !== t.title) {
      problems.push('抖音/平台 ' + id + ' 标题上限不一致：权威表 ' + String(t.title) + ' 字 vs 教案 '
        + (l.title === undefined ? '未写数字' : String(l.title) + ' 字'))
    }
    if (t.title === undefined && l.title !== undefined) {
      problems.push('平台 ' + id + ' 的标题上限在权威表里没有登记，教案却写了 ' + String(l.title) + ' 字（无出处的数字）')
    }
  }
  return problems
}

if (process.argv.includes('--selftest')) {
  const truth = new Map([['douyin', { title: 20 }], ['xhs', { title: undefined }]])
  const good = new Map([['douyin', { title: 20 }], ['xhs', { title: undefined }]])
  const bad1 = new Map([['douyin', { title: 30 }], ['xhs', { title: undefined }]])
  const bad2 = new Map([['douyin', { title: 20 }], ['xhs', { title: 1000 }]])
  const ok = compare(truth, good).length === 0
  const caughtMismatch = compare(truth, bad1).length > 0
  const caughtUnsourced = compare(truth, bad2).length > 0
  console.log('负向自测：一致数据判 PASS=' + String(ok) + '；数值不一致判 FAIL=' + String(caughtMismatch)
    + '；无出处数字判 FAIL=' + String(caughtUnsourced))
  if (ok && caughtMismatch && caughtUnsourced) {
    console.log('SELFTEST_OK 门禁本身可信（三条判据都按预期工作）')
    process.exit(0)
  }
  console.log('SELFTEST_FAIL 门禁判据不工作，不能用于验收')
  process.exit(1)
}

const truthText = readFileSync(join(serverSrc, 'platform-catalog.ts'), 'utf8')
const lessonText = readFileSync(join(serverSrc, 'agent-rules.ts'), 'utf8')
const truth = parseTruth(truthText)
const lesson = parseLesson(lessonText)
const problems = compare(truth, lesson)

console.log('权威表登记平台：' + (truth.size === 0 ? '（无）' : [...truth.keys()].join(', ')))
for (const [id, t] of truth) {
  console.log('  ' + id + '：标题上限 ' + (t.title === undefined ? '未登记' : String(t.title) + ' 字'))
}
if (problems.length > 0) {
  console.log('PLATFORM_RULES FAIL 共 ' + String(problems.length) + ' 处：')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('PLATFORM_RULES OK 教案与权威表一致（' + String(truth.size) + ' 个平台）')
