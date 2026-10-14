#!/usr/bin/env node
/**
 * 打包前置门禁（2026-10-12 立）。
 *
 * 产品负责人原话：「先测试！再打包！！！不然打包出来也是废物！一直反复打包浪费时间不说！
 * 还浪费我电脑的存储空间！！！！先用开发板测试完毕没问题了直接打包交付！！！！！」
 *
 * 背景事实：2026-10-12 凌晨连打十代包（0.3.0 → 0.3.9），每个 773 MB、约 10 分钟，
 * 打完还要装机再验一遍——而其中多数是把"本该在开发版上先发现的问题"带进了包里。
 * 本门禁把「先测后打」从自觉变成机制：任何出包动作之前跑它，红一项就拒绝打包。
 *
 * 三层判据：
 *   ① 静态层（秒级）：内核工具面 / 缺陷台账 / 重构进度 / preset 一致性 / S 级前端监考静态项；
 *   ② 实测层（需开发版在跑）：陌生人之眼 28 项 + 一句话端到端只读用例；
 *   ③ 新鲜度：前端 dist 必须比前端源码新——否则打进去的是旧界面。
 *
 * 用法：
 *   node qa/verify-before-package.mjs          默认：三层全跑
 *   node qa/verify-before-package.mjs --quick  只跑静态层 + 新鲜度（供 build-win.sh 复用）
 *   node qa/verify-before-package.mjs --full   追加 S 级监考真实执行版（慢、真调模型）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = resolve(HERE, '..')
const args = new Set(process.argv.slice(2))
const quick = args.has('--quick')
const full = args.has('--full')
const APP = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

function step(name, rel) {
  const file = join(PRODUCT, rel)
  if (!existsSync(file)) { record(name, false, 'missing ' + rel); return false }
  const r = spawnSync(process.execPath, [file], { cwd: PRODUCT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ')
  const ok = r.status === 0
  record(name, ok, (ok ? '' : `exit=${r.status} `) + tail.slice(0, 400))
  return ok
}

/** 递归取目录下最新改动时间；目录不存在时返回 0（由调用方判红）。 */
function newestMtime(dir, skip = /node_modules|[\\/]dist[\\/]|[\\/]\./ ) {
  let newest = 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (skip.test(p)) continue
      if (e.isDirectory()) walk(p)
      else { const m = statSync(p).mtimeMs; if (m > newest) newest = m }
    }
  }
  walk(dir)
  return newest
}

console.log('== 打包前置门禁：先测试，再打包 ==')
console.log(`   开发版地址：${APP}（可用 BF_QA_BASE 覆盖）`)

// ── ① 静态层 ────────────────────────────────────────────────
step('内核工具面（verify-kernel-tools）', 'qa/verify-kernel-tools.mjs')
step('缺陷台账格式与闭环（verify-defect-ledger）', 'qa/verify-defect-ledger.mjs')
step('重构进度六层（verify-refactor-progress）', 'qa/verify-refactor-progress.mjs')
step('管家工具面一致性（verify-preset-parity）', 'qa/verify-preset-parity.mjs')
// 2026-10-12 换：这一步原来跑 acceptance/frontend-supreme-gate.mjs ——《S 级前端监考》体系
// 已由 BFS-104-R 取代（qa/README.md:114 声明废止）。换成现行的第二份事实漂移门禁。
step('第二份事实漂移（verify-drift）', 'qa/verify-drift.mjs')

// ── ③ 产物新鲜度 ────────────────────────────────────────────
//
// 【前端固定模式 2026-10-13】产品负责人命令「固定使用 0.2.62 版前端」。
// 0.2.62 只留下**产物**、源码不在（git 停在 09-30，中间十天没版本控制），
// 所以 dist 里放的是**故意保留**的 0.2.62 产物，它当然比源码旧——
// 此时「新鲜度」这个判据不适用（它判的是"源码改了 dist 有没有跟上"）。
// 用一个**声明文件**把"固定"变成机制，而不是靠人记得"这次别重建"：
//   project/bosom-friend-electron/FRONTEND-FROZEN.md 存在 → 认固定模式。
// 打包本来就按 electron-builder.yml:52 直接从 dist 拷 frontend-dist，不再编译前端，
// 所以固定模式下包里嵌的就是那份产物——与"重新编译"彻底解耦。
const frozenMark = join(PRODUCT, 'project/bosom-friend-electron/FRONTEND-FROZEN.md')
const distIndex = join(PRODUCT, 'project/bosom-friend-electron/dist/index.html')
if (!existsSync(distIndex)) {
  record('前端 dist 存在', false, '缺 ' + distIndex + '：先跑 dev-web.ps1 -Frontend')
} else if (existsSync(frozenMark)) {
  record('前端 dist 固定（FRONTEND-FROZEN）', true,
    '已声明固定：dist 为保留的前端产物，打包直接嵌入、不重建（详见 FRONTEND-FROZEN.md）')
} else {
  const distM = statSync(distIndex).mtimeMs
  const webM = newestMtime(join(PRODUCT, 'project/bosom-friend-web/src'))
  const eleM = newestMtime(join(PRODUCT, 'project/bosom-friend-electron/src'))
  const srcM = Math.max(webM, eleM)
  const fresh = distM >= srcM
  const mins = Math.round((srcM - distM) / 60000)
  record('前端 dist 比源码新', fresh, fresh
    ? `dist=${new Date(distM).toLocaleString('zh-CN')}`
    : `源码比 dist 新 ${mins} 分钟：先 dev-web.ps1 -Frontend 重建，否则包里是旧界面`)
}

// ── ② 实测层（开发版） ──────────────────────────────────────
if (!quick) {
  let serviceOk = false
  try {
    const res = await fetch(APP, { signal: AbortSignal.timeout(15000) })
    serviceOk = res.status === 200
    record('开发版在跑', serviceOk, 'HTTP ' + res.status)
  } catch (e) {
    record('开发版在跑', false, '连不上（' + String(e.message).slice(0, 80) + '）：先起 launcher/scripts/dev-web.ps1')
  }
  if (serviceOk) {
    step('陌生人之眼 28 项（qa-guard2）', 'qa/qa-guard2.mjs')
    step('一句话端到端只读用例（verify-one-sentence-e2e）', 'qa/verify-one-sentence-e2e.mjs')
    // 2026-10-12 移除：S 级监考体系已废止（BFS-104-R 取代），qa/acceptance/ 已删除。
    // --full 不再执行废止体系；真实链路级用例（生成→出片→发布→失败恢复）待建后挂到这里。
  } else {
    record('实测层', false, '开发版没在跑 → 无法证明"测试过"，拒绝打包')
  }
} else {
  console.log('（--quick：跳过实测层，只做静态与新鲜度检查）')
}

const failed = results.filter(r => !r.ok)
console.log(`\n=== BEFORE_PACKAGE_GATE ${failed.length === 0 ? 'PASS' : 'FAIL'}（${results.length - failed.length}/${results.length}） ===`)
if (failed.length) {
  console.log('未通过项：')
  for (const f of failed) console.log('  · ' + f.name)
  console.log('先修完、在开发版上跑通再来打包——打包不是验证手段。')
}
process.exit(failed.length === 0 ? 0 : 1)
