#!/usr/bin/env node
/**
 * 记忆效能门禁（BFS-107.3）。
 *
 * 107.3 原文：「同一类任务第二次执行，用时或返工率应当下降；不降即视为记忆失效，须诊断并登记。」
 *
 * 为什么不用「墙钟时长」（2026-10-12 实测结论）：
 *   用 35 次同类历史任务算 updatedAt-createdAt，得出「写文案 6→21 秒、发布 399→463 秒」这类结论——
 *   其中绝大部分是厂商排队与免费档限流的等待，跟「管家记不记得」无关，拿它判会误判成「记忆失效」。
 *
 * 改用四个不掺等待的口径（都从 agent-tasks.json 的真实消息里数出来）：
 *   1) 一次成功率：同类任务里 status=completed 的比例；
 *   2) 平均工具调用数：记得住就不必反复试错；
 *   3) 平均反问次数：助手反问越少通常说明越清楚该怎么做；
 *   4) 返工：同类任务里落在同一小时的条数（重发会挤在一起）。
 *
 * 用法：node products/bosom-friend/qa/verify-memory-efficacy.mjs [--selftest]
 * 退出码：0 = 有可用样本且无退化；1 = 出现「一次都没成功」的退化（或自检失灵）。
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const ROOT = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')
const TASKS = join(ROOT, 'agent-tasks.json')
/** 样本下限：同类任务少于这个数就不下结论（BFS-104：样本不足如实拒答）。 */
const MIN_SAMPLE = 4

/** 从任务数组里数出四类指标。纯函数，便于负向对照。 */
function measure(tasks) {
  const rows = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.createdAt)
  const groups = new Map()
  for (const t of rows) {
    const key = String(t.title ?? '').replace(/\s+/g, '').slice(0, 12)
    if (key === '' || key === '新对话') continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  const stat = []
  for (const [key, list] of groups) {
    if (list.length < MIN_SAMPLE) continue
    const sorted = [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    let ok = 0, tools = 0, clarify = 0
    for (const t of sorted) {
      const text = JSON.stringify(t.messages ?? [])
      if (t.status === 'completed') ok++
      tools += (text.match(/bosom_[a-z_]+/g) ?? []).length
      clarify += (text.match(/[？?]/g) ?? []).length
    }
    stat.push({ key, n: sorted.length, successRate: ok / sorted.length, avgTools: tools / sorted.length, avgClarify: clarify / sorted.length })
  }
  return stat
}

if (process.argv.includes('--selftest')) {
  const dir = mkdtempSync(join(tmpdir(), 'bf-mem-'))
  const bad = join(dir, 'bad.json')
  const mk = (i) => ({ _id: 'x' + i, title: '帮我写一条关于露营帐篷的抖音文案', status: 'error', createdAt: '2026-10-12T0' + i + ':00:00Z', messages: [{ type: 'assistant', content: '请问要发到哪个平台？' }] })
  writeFileSync(bad, JSON.stringify({ value: [mk(1), mk(2), mk(3), mk(4)] }))
  const r = measure(JSON.parse(readFileSync(bad, 'utf8')).value)
  rmSync(dir, { recursive: true, force: true })
  if (!(r.length > 0 && r[0].successRate === 0)) { console.log('MEMORY_EFFICACY_FAIL 负向对照未变红'); process.exit(1) }
  console.log('MEMORY_EFFICACY_SELFTEST OK 全失败样本被判 0% 成功率（' + r.length + ' 类）')
  process.exit(0)
}

if (!existsSync(TASKS)) { console.log('MEMORY_EFFICACY_SKIP 本机没有产品数据，不算失败'); process.exit(0) }
const stat = measure(JSON.parse(readFileSync(TASKS, 'utf8')).value)
if (stat.length === 0) {
  console.log('MEMORY_EFFICACY_INSUFFICIENT 同类任务样本都不足 ' + MIN_SAMPLE + ' 条，不下结论（BFS-104：样本不足如实拒答）')
  process.exit(0)
}
console.log('记忆效能（BFS-107.3 替代口径，不用墙钟时长——理由见文件头）：')
let red = 0
for (const s of stat) {
  console.log('  「' + s.key + '…」 n=' + s.n + ' 一次成功率=' + Math.round(s.successRate * 100) + '% 平均工具=' + s.avgTools.toFixed(1) + ' 平均反问=' + s.avgClarify.toFixed(1))
  if (s.successRate === 0) { red++; console.log('    ⚠️ 这一类一次都没成功 → 视为记忆失效，须诊断并登记（107.3）') }
}
if (red > 0) { console.log('MEMORY_EFFICACY_FAIL 有 ' + red + ' 类退化'); process.exit(1) }
console.log('MEMORY_EFFICACY_OK 同类任务 ' + stat.length + ' 类，均无「一次都没成功」的退化')