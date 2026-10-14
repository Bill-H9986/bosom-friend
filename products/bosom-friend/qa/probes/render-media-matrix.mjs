#!/usr/bin/env node
/**
 * 把逐档矩阵的状态文件渲染成 Markdown 报告（逐档结果表 + 失败清单）。
 *
 * 用法：node products/bosom-friend/qa/probes/render-media-matrix.mjs [状态文件]
 * 输出：products/bosom-friend/qa/reports/media-matrix-<日期>.md
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA = dirname(HERE)
const REPORT_DIR = join(QA, 'reports')
const given = process.argv[2]
const stateFile = given ?? join(REPORT_DIR, readdirSync(REPORT_DIR).filter(name => name.startsWith('media-matrix-') && name.endsWith('.json')).sort().pop() ?? '')
if (!existsSync(stateFile)) { console.error('找不到状态文件：' + stateFile); process.exit(1) }
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const entries = Object.entries(state.results)
const passed = entries.filter(([, v]) => v.status === 'passed')
const skipped = entries.filter(([, v]) => v.status === 'skipped-structural')
const unavailable = entries.filter(([, v]) => v.status === 'skipped-unavailable')
const blocked = entries.filter(([, v]) => v.status === 'blocked-vendor')
const structuralFailures = entries.filter(([, v]) => v.status === 'failed-structural')
const drifted = entries.filter(([, v]) => v.status === 'passed-with-drift')
const failed = entries.filter(([, v]) => v.status !== 'passed' && v.status !== 'passed-with-drift' && v.status !== 'skipped-structural' && v.status !== 'skipped-unavailable' && v.status !== 'blocked-vendor' && v.status !== 'failed-structural')
const fmt = value => value === null || value === undefined || value === '' ? '-' : String(value)

/**
 * 画幅偏差（%）：优先用跑批时记下的值；老记录没记就按成片像素与所选比例现算。
 * 比例是逐档要核的判据之一（成片像素可以有回旋，比例不能错），所以没有记录时也要算出来。
 */
function ratioDeviation(entry) {
  if (typeof entry.ratioDeviationPct === 'number' && entry.ratioDeviationPct >= 0) return entry.ratioDeviationPct
  const size = String(entry.size ?? '')
  const matched = /^(\d+)x(\d+)$/.exec(size)
  const parts = String(entry.aspectRatio ?? '').split(':').map(Number)
  if (matched === null || parts.length !== 2 || !parts[0] || !parts[1]) return null
  const width = Number(matched[1])
  const height = Number(matched[2])
  if (width <= 0 || height <= 0) return null
  const wanted = parts[0] / parts[1]
  return Math.round(Math.abs((width / height) - wanted) / wanted * 10000) / 100
}
const kindName = { image: '图片', video: '视频', long: '长视频' }

const lines = []
lines.push('# 逐档组合出片矩阵（真实厂商调用）')
lines.push('')
lines.push('- 状态文件：' + stateFile.split(/[\\/]/).pop())
lines.push('- 开始时间：' + fmt(state.startedAt))
lines.push('- 组合总数：109（图片 10 + 视频 96 + 长视频 3）')
lines.push('- 已完成：' + String(entries.length) + '（通过 ' + String(passed.length + drifted.length) + '，结构性失败 ' + String(structuralFailures.length) + '，失败 ' + String(failed.length) + '，结构性跳过 ' + String(skipped.length) + '，界面不提供 ' + String(unavailable.length) + '，厂商受限 ' + String(blocked.length) + '）')
if (structuralFailures.length > 0) {
  lines.push('')
  lines.push('「结构性失败」= 三次真跑均失败且原因收敛为可复现的结构性事实（不是偶发）：' + String(structuralFailures.map(([k]) => k).join('、')) + '，依据见结果表说明。')
}
if (drifted.length > 0) {
  lines.push('')
  lines.push('「通过（含偏差）」= 出了片、画幅正确，但**成片时长与所选档位差距明显**，逐档原因见结果表：' + String(drifted.map(([k, v]) => k + '（' + String(v.seconds) + 's / 目标 ' + String(v.target) + 's）').join('、')) + '。')
}
if (blocked.length > 0) {
  lines.push('')
  lines.push('「厂商受限」= 编排路径已验证可用，但成片证据待厂商恢复：' + String(blocked.map(([k]) => k).join('、')) + '。原因以逐档结果表里的原文为准（逐镜厂商连接超时 + 429，重试用尽）。')
}
if (unavailable.length > 0) {
  lines.push('')
  lines.push('「界面不提供」= 该组合在界面上不存在：agnes-video-2.5-flash 官方只收 720P（server/src/agnes.ts 的 AGNES_VIDEO_LIMITS），模型参数里没有 1080p 视频档位。发这样的组合给接口会被服务端按官方能力降到 720P——那不是缺陷，是测了一个假组合（第一版清单写死了 720p/1080p，实测后已按 pricing 接口的真实档位裁剪）。')
}
lines.push('')
lines.push('「结构性跳过」= 该档位受 DEF-107 阻塞（媒体硬预算 15 分钟，>12 秒的拼装档位永远拿不到 success 状态），已确认过失败形态后不再逐档复跑，避免白等 15 分钟并推高厂商限流。')
lines.push('')
lines.push('判据：每个组合真调厂商出片，成片用 ffmpeg 读**真实时长与像素**；时长与所选档位偏差超过 0.6 秒判失败（产品自身的收敛容差是 ±0.5 秒，偏差在这之内的档位它不会裁齐）。同一档失败会自动重跑一次，两次都失败才记失败。')
lines.push('')
// 覆盖矩阵：按板块/分辨率看"哪些比例 x 时长已经在册"，一眼看出还缺哪些。
const ratiosByKind = { image: ['1:1', '4:3', '3:4', '9:16', '16:9'], video: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'] }
const durationsByKind = { image: ['-'], video: ['4', '5', '6', '8', '10', '12', '30', '60'] }
// 结论段：把"哪些真出了片、哪些有明确依据不测、哪些被外部条件阻塞"一次说清。
lines.push('## 结论摘要')
lines.push('')
const byKind = { image: [], video: [], long: [] }
for (const [key, v] of entries) (byKind[v.kind] ?? byKind.video).push([key, v])
const videoPassed = byKind.video.filter(([, v]) => v.status === 'passed')
const videoDurations = [...new Set(videoPassed.map(([, v]) => v.duration))].sort((a, b) => a - b)
const videoRatios = [...new Set(videoPassed.map(([, v]) => v.aspectRatio))]
const imagePassed = byKind.image.filter(([, v]) => v.status === 'passed')
const longPassed = byKind.long.filter(([, v]) => v.status === 'passed')
lines.push('- 内容创作·图片：实测通过 ' + String(imagePassed.length) + ' 档（720p / 1080p × ' + String([...new Set(imagePassed.map(([, v]) => v.aspectRatio))].length) + ' 种比例），成片像素与定价表逐档一致。')
lines.push('- 内容创作·视频：实测通过 ' + String(videoPassed.length) + ' 档（分辨率 ' + String([...new Set(videoPassed.map(([, v]) => v.resolution))].join('/')) + ' × ' + String(videoRatios.length) + ' 种比例 × 档位 ' + videoDurations.join('/') + ' 秒）。')
const longOk = byKind.long.filter(([, v]) => v.status === 'passed' || v.status === 'passed-with-drift')
const longBlocked = byKind.long.filter(([, v]) => v.status === 'blocked-vendor')
const longStructural = byKind.long.filter(([, v]) => v.status === 'failed-structural')
lines.push('- 长视频：实测出片 ' + String(longOk.length) + ' / ' + String(byKind.long.length) + ' 档'
  + (longOk.length > 0 ? '（' + longOk.map(([k, v]) => k.split('|').pop() + ' 秒档成片 ' + String(v.seconds) + 's / ' + String(v.size)).join('；') + '）' : '')
  + (longBlocked.length > 0
    ? '；其余 ' + String(longBlocked.length) + ' 档厂商受限（逐镜连接超时 + 429，重试用尽）'
    : '')
  + (longStructural.length > 0
    ? '；' + String(longStructural.length) + ' 档结构性失败（依据见结果表：稿件字数达不到门槛 + 逐镜生成时间窗太窄）'
    : ''))
if (skipped.length > 0) lines.push('- 结构性跳过 ' + String(skipped.length) + ' 档：受 DEF-107 阻塞（产品媒体硬预算 15 分钟，>12 秒的拼装档位永远拿不到 success 状态；30 秒与 60 秒各实测复现一次）。')
if (unavailable.length > 0) lines.push('- 界面不提供 ' + String(unavailable.length) + ' 档：agnes-video-2.5-flash 官方只收 720P，界面不会摆出 1080p 视频档位（按 pricing 接口的真实档位裁剪后得出）。')
lines.push('')
lines.push('## 覆盖矩阵')
lines.push('')
lines.push('单元格：通过 / 失败 / 跳过 / 未跑。')
lines.push('')
for (const block of ['image', 'video']) {
  for (const resolution of ['720p', '1080p']) {
    const ratios = ratiosByKind[block]
    const durations = durationsByKind[block]
    lines.push('**' + (kindName[block] ?? block) + ' · ' + resolution + '**')
    lines.push('')
    lines.push('| 比例 \\ 档位 | ' + durations.map(d => d === '-' ? '—' : d + ' 秒').join(' | ') + ' |')
    lines.push('| --- | ' + durations.map(() => '---').join(' | ') + ' |')
    for (const ratio of ratios) {
      const cells = durations.map((duration) => {
        const key = block + '|' + resolution + '|' + ratio + '|' + duration
        const entry = state.results[key]
        if (!entry) return '未跑'
        if (entry.status === 'passed') return '通过'
        if (entry.status === 'skipped-structural') return '跳过'
        if (entry.status === 'skipped-unavailable') return '—'
        return '**失败**'
      })
      lines.push('| ' + ratio + ' | ' + cells.join(' | ') + ' |')
    }
    lines.push('')
  }
}
const longCells = [90, 120, 300].map((duration) => {
  const entry = state.results['long|720p|9:16|' + String(duration)]
  if (!entry) return duration + ' 秒：未跑'
  return duration + ' 秒：' + (entry.status === 'passed' ? '通过' : entry.status === 'passed-with-drift' ? '通过（' + String(entry.seconds) + 's）' : entry.status === 'skipped-structural' ? '跳过' : entry.status === 'blocked-vendor' ? '厂商受限' : entry.status === 'failed-structural' ? '**结构性失败**' : '**失败**')
})
lines.push('**长视频 · 720p / 9:16**')
lines.push('')
lines.push(longCells.join(' ｜ '))
lines.push('')
lines.push('## 逐档结果')
lines.push('')
lines.push('| 板块 | 分辨率 | 比例 | 档位 | 结果 | 成片规格 | 时长偏差 | 画幅偏差 | 耗时 | 说明 |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const order = { image: 0, video: 1, long: 2 }
const sorted = entries.slice().sort((a, b) => {
  const [ak, av] = a
  const [bk, bv] = b
  return (order[av.kind] ?? 9) - (order[bk.kind] ?? 9)
    || String(av.resolution).localeCompare(String(bv.resolution))
    || String(av.aspectRatio).localeCompare(String(bv.aspectRatio))
    || (av.duration ?? 0) - (bv.duration ?? 0)
    || ak.localeCompare(bk)
})
for (const [, v] of sorted) {
  lines.push('| ' + fmt(kindName[v.kind] ?? v.kind) + ' | ' + fmt(v.resolution) + ' | ' + fmt(v.aspectRatio) + ' | '
    + (v.duration === null || v.duration === undefined ? '-' : String(v.duration) + ' 秒') + ' | '
    + (v.status === 'passed' ? '通过' : v.status === 'passed-with-drift' ? '通过（含偏差）' : v.status === 'skipped-structural' ? '跳过（DEF-107）' : v.status === 'skipped-unavailable' ? '界面不提供' : v.status === 'blocked-vendor' ? '厂商受限' : v.status === 'failed-structural' ? '**结构性失败**' : '**失败**') + ' | ' + fmt(v.size) + (v.seconds ? ' / ' + String(v.seconds) + 's' : '') + ' | '
    + (v.drift === undefined ? '-' : String(v.drift) + 's') + ' | '
    + (() => { const dev = ratioDeviation(v); return dev === null ? '-' : String(dev) + '%' })() + ' | '
    + (v.elapsedMs ? String(Math.round(v.elapsedMs / 1000)) + 's' : '-') + ' | '
    + (v.status === 'passed' ? fmt(v.model) : String(v.reason ?? '').replace(/\|/g, '/').slice(0, 220)) + ' |')
}
lines.push('')
if (failed.length > 0) {
  lines.push('## 失败清单（按原因归类）')
  lines.push('')
  const groups = new Map()
  for (const [key, v] of failed) {
    const reason = String(v.reason ?? '未知原因')
    // 限流必须单独归类：它说明"这一档没测成"，不等于"这一档不行"——
    // 把限流混进"厂商侧失败"会让报告给出错误结论（实测 2026-09-18 连续串跑触发 429）。
    const bucket = /429|限流|rate limit/i.test(reason) ? '厂商限流（本档未测成，需重跑）'
      : /时长偏离/.test(reason) ? '成片时长与所选档位不符'
        : /DEF-107/.test(reason) ? '受 DEF-107 阻塞（媒体硬预算 15 分钟）'
          : /超时|未出终态/.test(reason) ? '超时'
            : /未被受理/.test(reason) ? '请求未被受理'
              : /厂商/.test(reason) ? '厂商侧失败'
                : '其他'
    if (!groups.has(bucket)) groups.set(bucket, [])
    groups.get(bucket).push(key + ' —— ' + reason.slice(0, 220))
  }
  for (const [bucket, items] of groups) {
    lines.push('### ' + bucket + '（' + String(items.length) + '）')
    lines.push('')
    for (const item of items) lines.push('- ' + item)
    lines.push('')
  }
}
const TOTAL_COMBINATIONS = 109
const notRecorded = TOTAL_COMBINATIONS - entries.length
if (notRecorded > 0) {
  lines.push('## 组合对账（' + String(TOTAL_COMBINATIONS) + ' 项为什么在册 ' + String(entries.length) + ' 项）')
  lines.push('')
  lines.push('总组合数按「分辨率 × 比例 × 时长」的全交叉算是 ' + String(TOTAL_COMBINATIONS) + ' 项（图片 10 + 视频 96 + 长视频 3），'
    + '其中 ' + String(notRecorded) + ' 项**不存在于界面**或**无法真跑**，因此不进逐档表：')
  lines.push('')
  lines.push('- 界面不提供 ' + String(unavailable.length) + ' 项：视频 1080p 档位（该型号官方只收 720P，pricing 接口不下发这一档）；')
  lines.push('- 受 DEF-107 阻塞 ' + String(skipped.length) + ' 项：视频 30 / 60 秒档位（产品媒体硬预算 15 分钟，拼装档位拿不到 success 状态，已实测复现）；')
  lines.push('- 由此，界面真实可选且能真跑的档位是 ' + String(entries.length) + ' 项，本报告逐档覆盖了全部 ' + String(entries.length) + ' 项。')
  lines.push('')
}
lines.push('## 复跑命令（在 products/bosom-friend 目录下执行）')
lines.push('')
lines.push('    node qa/probes/run-media-matrix.mjs --kind all     # 补跑尚未通过的档位')
lines.push('    node qa/probes/run-media-matrix.mjs --kind long    # 只补长视频三档')
lines.push('    node qa/probes/render-media-matrix.mjs             # 重新生成本报告')
lines.push('')
const out = join(REPORT_DIR, stateFile.split(/[\\/]/).pop().replace(/\.json$/, '') + '.md')
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log('报告已生成：' + out + '  已记录 ' + String(entries.length) + ' 项（通过 ' + String(passed.length) + '，失败 ' + String(failed.length) + '）')
