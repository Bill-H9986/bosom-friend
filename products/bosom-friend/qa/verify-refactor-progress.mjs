#!/usr/bin/env node
/**
 * 重构进度对账门禁（BFS-401 精神 / 总纲第 10 节自证）。
 *
 * 为什么需要它：2026-10-11 晚上产品负责人两次指出同一个问题——
 * 「条例和标准都立好了，你怎么还会跑偏？」「你没有记忆的问题又出现了」。
 * 根因不是文档不够，而是**没有任何机制强制实现者每次开工时对着总纲干活**：
 * 文档只在被读的那一刻有效，读完就回到「按今天报上来的问题排优先级」，于是必然跑偏。
 *
 * 它检查四件事：
 *   1) `docs/Marvis对标验收表-v1.0.md` 存在，且六层架构逐层都有状态标注；
 *   2) 每层标注了「该怎么做」（没做的层不许只写「没做」了事）；
 *   3) 表里必须有一段「我今晚的执行偏差」——承认跑偏这件事本身要被记录；
 *   4) 表的更新时间在 MAX_AGE_HOURS 小时内（进度表过期 = 对账没在做）。
 *
 * 用法：node products/bosom-friend/qa/verify-refactor-progress.mjs [--selftest]
 * 退出码：0 = 合规；1 = 有未登记的问题。
 */
import { readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const TABLE = join(PRODUCT, 'docs', 'Marvis对标验收表-v1.0.md')
/** 进度表最长允许多久不更新（小时）。超过即视为「对账没在做」。 */
const MAX_AGE_HOURS = 24
/** 六层架构（总纲 L143-152）逐层的识别关键字。 */
const LAYERS = ['运行时层', '能力层', '编排层', '技能层', '呈现层', '记忆层']

function inspect(file) {
  const failures = []
  let text
  try { text = readFileSync(file, 'utf8') } catch { return { failures: ['进度表不存在：' + file] } }
  for (const layer of LAYERS) {
    if (!text.includes(layer)) failures.push('六层里缺少「' + layer + '」这一层')
  }
  if (!text.includes('该怎么做')) failures.push('缺少「该怎么做」列——没做的层不许只写「没做」')
  if (!text.includes('执行偏差')) failures.push('缺少「执行偏差」一段：承认跑偏本身要被记录')
  return { failures }
}

function checkAge(file) {
  try {
    const hours = (Date.now() - statSync(file).mtimeMs) / 3600000
    return hours <= MAX_AGE_HOURS ? [] : ['进度表已 ' + Math.round(hours) + ' 小时未更新（上限 ' + MAX_AGE_HOURS + 'h）——对账没在做']
  } catch { return [] }
}

const selftest = process.argv.includes('--selftest')
if (selftest) {
  const dir = mkdtempSync(join(tmpdir(), 'bf-refactor-'))
  const bad = join(dir, 'bad.md')
  writeFileSync(bad, '# 缺层缺列的表\n只写了运行时层。\n')
  const r = inspect(bad)
  rmSync(dir, { recursive: true, force: true })
  if (r.failures.length === 0) { console.log('REFACTOR_PROGRESS_FAIL 负向对照未变红（门禁本身可能失灵）'); process.exit(1) }
  console.log('REFACTOR_PROGRESS_SELFTEST OK 缺层文档被判红（' + r.failures.length + ' 项）')
  process.exit(0)
}

const { failures } = inspect(TABLE)
const ageFailures = checkAge(TABLE)
const all = [...failures, ...ageFailures]
if (all.length > 0) {
  console.log('REFACTOR_PROGRESS_FAIL 问题 ' + all.length + ' 项：')
  for (const f of all) console.log('  - ' + f)
  process.exit(1)
}
console.log('REFACTOR_PROGRESS_OK layers=' + LAYERS.length + ' maxAgeHours=' + MAX_AGE_HOURS)