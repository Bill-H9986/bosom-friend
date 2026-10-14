#!/usr/bin/env node
/**
 * api.ts 冻结增长门禁（总纲 L102 判据「路由文件不再增长」的落点）。
 *
 * 为什么需要：总纲 L102 的痛点原文是「页面写死执行器，**路由堆在单个大文件里**」，
 * 判据是「新增一条能力只改能力文件与 preset，不改页面执行器；**路由文件不再增长**」。
 * 现状（2026-10-12 实测）：`server/src/api.ts` 已经 **472 KB**，而且今晚还在长——
 * 自动任务接线、G4 的 taskUsageIndex、失败态三选择都往它里面加。
 *
 * **为什么先做行数冻结而不是先拆文件**：api.ts 承载对话链路与发布闸门，
 * 一次搬 472 KB 的风险极高（今晚刚因「按行号区间删代码」误删过 generationRecovery）；
 * 先立规矩阻止它继续长大，再分批搬到 capabilities/——这是风险最低的顺序。
 *
 * 需要真的加路由怎么办（三条路，都要可见）：
 *   ① 把能力放进 `capabilities/`（总纲 L197 的目标形态：一能力一文件）；
 *   ② 明确决策后跑 `--update` 放宽基线，**并在改动说明里写明为什么**；
 *   ③ 把已有代码搬出去——那是唯一能让基线**下调**的动作。
 *
 * 用法：node products/bosom-friend/qa/verify-api-size.mjs [--update]
 * 退出码：0 = 未增长；1 = 增长了（基线 与 现值 都会打印）。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
/** 被冻结的文件：路径 → 中文名（未来若要冻结更多大文件，往这里加）。 */
const FROZEN = [
  ['server/src/api.ts', 'server 主路由与对话链路'],
  ['server/src/long-video.ts', '长视频'],
  ['server/src/routes-content.ts', '内容路由'],
  ['server/src/routes-channels.ts', '频道路由'],
  // 【2026-10-13 增加】内核工具面也冻结。理由与上面四个同源，但形态不同：
  // 总纲 L197 的目标形态是「**一能力一文件**」（`capabilities/`），而内核的 58 个工具至今
  // 仍集中写在 `kernel/src/index.ts` 一个文件里（实测 3714 行）——这正是验收表里
  // 「代码组织：一能力一文件 ❌」那半句的落点。
  //
  // 同样先冻结、后分批搬：3714 行里 58 个工具互相引用（共享 store / register / 校验函数），
  // 一次性搬走的风险与 api.ts 同级。**冻结之后「新增一个工具」这件事就有了明确判据**：
  // 要么放进新的能力文件，要么明确决策后 --update 并写明理由。
  ['kernel/src/index.ts', '内核工具面（58 个工具集中于此）'],
]
const BASELINE = join(HERE, 'api-size-baseline.json')

const now = {}
for (const [rel] of FROZEN) {
  const p = join(PRODUCT, rel)
  now[rel] = existsSync(p) ? readFileSync(p, 'utf8').split('\n').length : null
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify({ at: new Date().toISOString(), lines: now }, null, 2))
  console.log('API_SIZE_BASELINE_UPDATED ' + JSON.stringify(now))
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.log('API_SIZE_NO_BASELINE 还没有基线；先跑一次 --update 记录（这不是失败）')
  process.exit(0)
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8')).lines ?? {}
const grown = []
const shrunk = []
for (const [rel, label] of FROZEN) {
  const b = base[rel]
  const n = now[rel]
  if (typeof b !== 'number' || typeof n !== 'number') continue
  if (n > b) grown.push(rel + '（' + label + '）：' + String(b) + ' → ' + String(n) + ' 行（+' + String(n - b) + '）')
  if (n < b) shrunk.push(rel + '：' + String(b) + ' → ' + String(n) + ' 行（-' + String(b - n) + '，好事）')
}

for (const s of shrunk) console.log('  ↓ ' + s)
if (grown.length > 0) {
  console.log('API_SIZE_FROZEN_VIOLATION 有 ' + String(grown.length) + ' 个被冻结的文件长大了：')
  for (const g of grown) console.log('  - ' + g)
  console.log('  三条允许的路：① 把能力放进 capabilities/（总纲 L197）；② 明确决策后 --update 并在说明里写明理由；③ 把已有代码搬出去。')
  process.exit(1)
}
console.log('API_SIZE_FROZEN_OK ' + String(FROZEN.length) + ' 个被冻结的文件都没有增长（总纲 L102「路由文件不再增长」＋ 内核工具面「一能力一文件」）')