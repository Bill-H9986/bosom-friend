#!/usr/bin/env node
/**
 * 数据指纹门禁（G6：「升级前后数据指纹一致」）。
 *
 * 为什么需要：G6 的判据是「陌生人在干净机器上走通主链路，**升级前后数据指纹一致**」。
 * 装机版会反复升级（0.3.0 → 0.3.4 → …），但「升级有没有弄坏/弄丢用户数据」此前没有任何检查——
 * 升级脚本万一覆盖了数据根，用户是察觉不到的（草稿变少、账号掉登录，都不会报错）。
 *
 * 做法：把用户数据根里**业务实体的条数**抽成一份指纹（只数条数，不读内容、不改数据）。
 *   --save    记一份基线（升级前跑）
 *   --check   与基线比对（升级后跑），不一致就红
 *   默认     只打印当前指纹
 *
 * 判据：升级只应改代码，不应改条数。**条数变化必须能解释**（用户自己新增的除外）。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const ROOT = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')
const SNAP = join(PRODUCT, 'qa', 'data-fingerprint.json')

/** 业务实体清单：文件 → 容器字段 → 实体名。只数条数。 */
/** 实体清单：文件名以数据根实际存在的为准（2026-10-12 按 `Get-ChildItem *.json` 校正）。 */
const ENTITIES = [
  ['contents.json', 'value', '内容(草稿/图文/视频)'],
  ['agent-tasks.json', 'value', '任务'],
  ['publish-records.json', 'value', '发布记录'],
  ['accounts.json', 'value', '账号'],
  ['draft-generations.json', 'value', '生成记录'],
  ['knowledge.json', 'value', '知识库条目'],
  ['long-video-tasks.json', 'value', '长视频任务'],
  ['digital-humans.json', 'value', '数字人形象'],
  ['metrics.json', 'value', '指标'],
  ['users.json', 'value', '用户'],
]

function fingerprint() {
  const out = {}
  for (const [file, , label] of ENTITIES) {
    const p = join(ROOT, file)
    if (!existsSync(p)) { out[label] = null; continue }
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const arr = Array.isArray(j.value) ? j.value : (Array.isArray(j) ? j : [])
      out[label] = arr.length
    } catch { out[label] = 'parse-error' }
  }
  return out
}

const fp = fingerprint()
const mode = process.argv[2] ?? ''

if (mode === '--save') {
  mkdirSync(dirname(SNAP), { recursive: true })
  writeFileSync(SNAP, JSON.stringify({ at: new Date().toISOString(), fp }, null, 2))
  console.log('DATA_FINGERPRINT_SAVED ' + JSON.stringify(fp))
  process.exit(0)
}

if (mode === '--check') {
  if (!existsSync(SNAP)) {
    console.log('DATA_FINGERPRINT_SKIP 没有基线（先跑一次 --save），本次不下结论')
    process.exit(0)
  }
  const base = JSON.parse(readFileSync(SNAP, 'utf8'))
  const diffs = []
  for (const k of Object.keys(base.fp)) {
    if (base.fp[k] !== fp[k]) diffs.push(k + '：' + String(base.fp[k]) + ' → ' + String(fp[k]))
  }
  if (diffs.length === 0) {
    console.log('DATA_FINGERPRINT_OK 升级前后一致（' + Object.keys(base.fp).length + ' 类实体）')
    process.exit(0)
  }
  console.log('DATA_FINGERPRINT_DIFF 有 ' + diffs.length + ' 类变化：')
  for (const d of diffs) console.log('  ' + d)
  console.log('（条数变化必须能解释：用户自己新增的算正常；无法解释的即为升级事故）')
  process.exit(1)
}

console.log('当前数据指纹：' + JSON.stringify(fp, null, 2))
console.log('用法：--save 记基线 / --check 与基线比对')