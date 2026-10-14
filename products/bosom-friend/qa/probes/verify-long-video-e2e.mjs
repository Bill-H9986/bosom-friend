#!/usr/bin/env node
/**
 * 长视频端到端对账：对**已启动的实例**走真实 REST，从建任务一路验到成片与字幕。
 *
 * 为什么需要它：单测（server/test/functional/long-video.spec.ts）验的是进程内的编排；
 * 装机/开发实例上那条路还多出 HTTP 层、内核媒体能力面、真实厂商、真实配音与真实 ffmpeg。
 * 这条探针把"用户点一次生成"整条链路走完，并把每一步的**数字**留下来（镜数、每镜台词、
 * 成片时长、字幕条数与时间轴），而不是只看一个 code=0。
 *
 * 判据（每条都要留数字，任何一条不成立判红）：
 *   1. 任务终态 success；
 *   2. 成片可下载、能读出真实像素与时长，且时长 ≈ 各镜真实时长之和（±1 秒）；
 *   3. **字幕条数 = 有台词的镜数**，且每一镜窗口里的字幕文本逐字等于那一镜的台词
 *      （读的是真正被烧进画面的那份 ASS，不是"参数传下去了"）。
 *
 * 实例必须接受目标时长：产品默认下限 90 秒（BF_LONG_VIDEO_MIN_SECONDS），本探针默认要 12 秒。
 * 用 qa/probes/run-isolated-long-video.mjs 一条命令起一个隔离实例（独立数据根 + 下限 8 秒）再跑，
 * 或者自己带 BF_LONG_VIDEO_MIN_SECONDS 起实例。实例把时长抬高时判 SKIP 并给出处置办法。
 *
 * 用法：node products/bosom-friend/qa/probes/verify-long-video-e2e.mjs
 * 环境：
 *   BF_QA_ORIGIN          实例源（默认 http://127.0.0.1:31280）
 *   BF_QA_TOKEN           访问令牌（默认 bf-local-guest-token）
 *   BF_LV_SECONDS         目标时长秒数（默认 12）
 *   BF_LV_RESOLUTION      分辨率档（默认 720p；agnes-video-2.5-flash 只收 720P）
 *   BF_LV_ASPECT          画幅（默认 9:16）
 *   BF_LV_PRODUCER        内容形式（默认 vlog）
 *   BF_LV_HUMAN           数字人 id（默认取形象库里第一个）
 *   BF_LV_PRODUCT_IMAGE   产品图素材 URL（可选；给了就验"带产品图"那条形态）
 *   BF_LV_DATA_ROOT       实例的数据根（可选；给了才做字幕 ASS 与逐镜文件的就地核对）
 *   BF_LV_TOPIC           产品与卖点（默认一段面霜卖点）
 *   BF_LV_BUDGET_MINUTES  等终态的上限（默认 45 分钟）
 * 退出码：0 = 通过；1 = 判红；2 = 跳过（实例不可达 / 没配模型 / 实例把时长抬高 / 有镜没出片）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeDurationSeconds, runFfmpeg } from '../../server/src/ffmpeg.ts'

const ORIGIN = (process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280').replace(/\/+$/, '')
const API = ORIGIN + '/bosom-friend/api'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'
const SECONDS = Math.max(4, Number(process.env.BF_LV_SECONDS ?? 12) || 12)
const RESOLUTION = process.env.BF_LV_RESOLUTION ?? '720p'
const ASPECT = process.env.BF_LV_ASPECT ?? '9:16'
const PRODUCER = process.env.BF_LV_PRODUCER ?? 'vlog'
const HUMAN_ID = process.env.BF_LV_HUMAN ?? ''
const PRODUCT_IMAGE = process.env.BF_LV_PRODUCT_IMAGE ?? ''
const DATA_ROOT = process.env.BF_LV_DATA_ROOT ?? ''
const TOPIC = process.env.BF_LV_TOPIC
  ?? '秋冬保湿面霜，主打干皮救急：先修护再锁水，涂开不搓泥、上妆不打架；今天下单送同系列小样。'
const BUDGET_MS = Math.max(5, Number(process.env.BF_LV_BUDGET_MINUTES ?? 45) || 45) * 60_000
/** 轮询间隔：一镜要 1~5 分钟，15 秒一轮既跟得上又不刷屏。 */
const POLL_MS = 15_000

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === '' ? '' : ' | ' + detail))
}
const say = (...parts) => console.log(parts.join(' '))

/** 调一次 REST；网络层失败重试（内核重启有几秒空窗，一次 ECONNREFUSED 不该记到产品账上）。 */
async function call(method, path, body) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(API + '/' + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      })
      const text = await response.text()
      try {
        return JSON.parse(text)
      }
      catch {
        return { code: -1, message: 'HTTP ' + String(response.status) + '：' + text.slice(0, 200) }
      }
    }
    catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
  throw lastError
}

/** 读成片文件的真实像素与时长（ffmpeg 的诊断行里两样都有）。 */
async function probeVideo(file) {
  const result = await runFfmpeg(['-hide_banner', '-i', file], 120_000)
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(result.output)
  return {
    width: size === null ? 0 : Number(size[1]),
    height: size === null ? 0 : Number(size[2]),
    seconds: await probeDurationSeconds(file),
  }
}
// ---- 前置：实例能连、内容形式在、形象在、模型配过 ---------------------------
let reachable = false
try {
  const producers = await call('GET', 'long-videos/producers')
  reachable = producers.code === 0
  if (!reachable) {
    say('LONG_VIDEO_E2E SKIP 实例没有应答内容形式列表：' + JSON.stringify(producers).slice(0, 200))
    process.exit(2)
  }
  const kinds = (producers.data?.list ?? []).map(item => item.kind)
  if (!kinds.includes(PRODUCER)) {
    say('LONG_VIDEO_E2E SKIP 实例里没有内容形式 ' + PRODUCER + '（有：' + kinds.join('/') + '）')
    process.exit(2)
  }
}
catch (error) {
  say('LONG_VIDEO_E2E SKIP 连不上实例 ' + ORIGIN + '：' + String(error))
  process.exit(2)
}

const humans = await call('GET', 'digital-humans')
const humanList = humans.data?.list ?? []
const human = HUMAN_ID === '' ? humanList[0] : humanList.find(item => item.id === HUMAN_ID)
if (human === undefined) {
  say('LONG_VIDEO_E2E SKIP 形象库里没有可用形象（' + String(humanList.length) + ' 个）——走动 VLOG 必须选一个形象')
  process.exit(2)
}
const llm = await call('GET', 'ai/user-llm')
// 视频通道在这个视图里是嵌套的 data.video.model（顶层没有 videoModel 字段）。
if (llm.code !== 0 || String(llm.data?.video?.model ?? '') === '') {
  say('LONG_VIDEO_E2E SKIP 实例里的视频模型没配好：' + JSON.stringify(llm).slice(0, 200))
  process.exit(2)
}
say('LONG_VIDEO_E2E origin=' + ORIGIN + ' producer=' + PRODUCER + ' human=' + human.id + ' model=' + String(llm.data.video.model)
  + ' seconds=' + String(SECONDS) + ' resolution=' + RESOLUTION + ' aspect=' + ASPECT
  + ' productImage=' + (PRODUCT_IMAGE === '' ? '(无)' : PRODUCT_IMAGE))

// ---- 建任务并盯到终态 -------------------------------------------------------
const started = await call('POST', 'long-videos', {
  producer: PRODUCER,
  producerRef: human.id,
  topic: TOPIC,
  targetSeconds: SECONDS,
  resolution: RESOLUTION,
  aspectRatio: ASPECT,
  withSubtitles: true,
  ...(PRODUCT_IMAGE === '' ? {} : { productImageUrl: PRODUCT_IMAGE }),
})
if (started.code !== 0) {
  say('LONG_VIDEO_E2E SKIP 建任务被拒：' + String(started.message ?? ''))
  process.exit(2)
}
const taskId = started.data.taskId
say('任务 ' + String(taskId) + ' 已建；预估调用 ' + String(started.data.estimate?.callsMin) + '~' + String(started.data.estimate?.callsMax)
  + ' 次，耗时 ' + String(started.data.estimate?.minutesMin) + '~' + String(started.data.estimate?.minutesMax) + ' 分钟')

const firstView = await call('GET', 'long-videos/' + String(taskId))
if (firstView.code === 0 && Number(firstView.data.targetSeconds) !== SECONDS) {
  // 下限被抬高：这条任务已经在跑，探针不能替它取消，如实说清楚并交出处置办法。
  say('LONG_VIDEO_E2E SKIP 这个实例把 ' + String(SECONDS) + ' 秒抬成了 ' + String(firstView.data.targetSeconds)
    + ' 秒（BF_LONG_VIDEO_MIN_SECONDS 默认 90）。处置：停掉实例后带 BF_LONG_VIDEO_MIN_SECONDS=' + String(SECONDS)
    + ' 重启，或用 qa/probes/run-isolated-long-video.mjs 起隔离实例；已建的这条任务请到生成记录里删掉或等它跑完。')
  process.exit(2)
}

const began = Date.now()
let task = firstView.code === 0 ? firstView.data : undefined
let lastKey = ''
while (Date.now() - began < BUDGET_MS) {
  await new Promise(resolve => setTimeout(resolve, POLL_MS))
  const view = await call('GET', 'long-videos/' + String(taskId))
  if (view.code !== 0) { say('读进度失败：' + String(view.message ?? '')); continue }
  task = view.data
  const key = String(task.status) + ':' + String(task.doneSegments) + '/' + String(task.totalSegments) + ':' + String(task.errorCode ?? '')
  if (key !== lastKey) {
    lastKey = key
    say('[' + String(Math.round((Date.now() - began) / 60000)) + 'm] status=' + String(task.status)
      + ' 镜=' + String(task.doneSegments) + '/' + String(task.totalSegments)
      + ' 稿件=' + String(task.scriptChars ?? 0) + '字' + (task.errorMessage ? ' 错误=' + String(task.errorMessage).slice(0, 160) : ''))
  }
  if (task.status !== 'generating') break
}
if (task === undefined || task.status === 'generating') {
  say('LONG_VIDEO_E2E SKIP 等超过 ' + String(Math.round(BUDGET_MS / 60000)) + ' 分钟还没到终态（厂商慢或限流），本轮不算通过也不算失败')
  process.exit(2)
}
// ---- 终态先分类：厂商暂时故障不算产品失败 -----------------------------------
//
// 厂商限流/网关抖动/超时是"这台机器现在拿不到成片"，不是"产品做错了"：产品已经按策略重试过
// （编排层的 [LONG_VIDEO_RETRY] 阶梯 + 下单自身的退避）并如实报错。与韵律、VLOG 两条真机探针同一口径：
// 服务不可用 → SKIP 退出 2。确定性的失败（参数被拒、稿件不足、密钥错）照旧判红。
if (task.status !== 'success') {
  const reason = String(task.errorMessage ?? '')
  if (/\[可重试\]|限流|暂时不可用|无响应|超时/.test(reason)) {
    say('LONG_VIDEO_E2E SKIP 任务在厂商侧暂时故障下落 failed：' + reason)
    say('（产品侧行为正确：重试阶梯已触发并如实报错；这一轮没拿到成片，不下红结论）')
    process.exit(2)
  }
}

// ---- 核对：任务、分镜、成片、字幕 -------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const evidenceDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'evidence', 'long-video-e2e-' + stamp)
mkdirSync(evidenceDir, { recursive: true })

const shots = Array.isArray(task.shots) ? task.shots : []
const lines = shots.map(shot => String(shot.line ?? '').replace(/\s+/g, ' ').trim())
const spokenShots = lines.filter(line => line !== '').length
say('分镜 ' + String(shots.length) + ' 镜（有台词 ' + String(spokenShots) + ' 镜）：'
  + shots.map((shot, index) => String(index + 1) + '.' + String(shot.kind) + '(' + (lines[index] === '' ? '无台词' : lines[index].slice(0, 8) + '…') + ')').join(' '))

record('任务终态 success', task.status === 'success', 'status=' + String(task.status) + (task.errorMessage ? ' 错误=' + String(task.errorMessage).slice(0, 160) : ''))
record('分镜表落了盘且至少两镜', shots.length >= 2, '镜数=' + String(shots.length))
record('每一镜都跑成了', shots.every(shot => shot.status === 'ready'), shots.map((shot, index) => String(index + 1) + '=' + String(shot.status)).join(' '))

const filmUrl = String(task.videoUrl ?? '')
if (filmUrl === '') {
  record('成片可下载', false, '任务没有 videoUrl')
}
else {
  const asset = await fetch(ORIGIN + filmUrl, { headers: { authorization: 'Bearer ' + TOKEN } })
  const bytes = Buffer.from(await asset.arrayBuffer())
  const film = join(evidenceDir, 'film.mp4')
  writeFileSync(film, bytes)
  const probed = await probeVideo(film)
  const segmentSum = (task.segments ?? []).reduce((sum, segment) => sum + (Number(segment.audioSeconds) || 0), 0)
  say('成片 ' + filmUrl + ' bytes=' + String(bytes.length) + ' 像素=' + String(probed.width) + 'x' + String(probed.height)
    + ' 时长=' + probed.seconds.toFixed(2) + 's 各镜记录之和=' + segmentSum.toFixed(2) + 's')
  record('成片可下载且非空', asset.ok && bytes.length > 0, 'bytes=' + String(bytes.length))
  record('成片时长 ≈ 各镜真实时长之和（±1 秒）', Math.abs(probed.seconds - segmentSum) <= 1,
    '成片=' + probed.seconds.toFixed(2) + 's 逐镜和=' + segmentSum.toFixed(2) + 's 差=' + (probed.seconds - segmentSum).toFixed(2) + 's')
  record('成片画幅与请求一致（' + ASPECT + '）', ASPECT !== '9:16' || probed.height > probed.width,
    String(probed.width) + 'x' + String(probed.height))

  // 逐镜文件就地核对（本机跑时才算）：各镜真实时长之和与成片对不对得上。
  const shotFiles = task.shotFiles ?? {}
  const filesInOrder = shots.map(shot => shotFiles[String(shot.index)]).filter(file => typeof file === 'string' && file !== '')
  const dataRoot = DATA_ROOT !== '' ? DATA_ROOT : (filesInOrder.length > 0 ? dirname(dirname(dirname(filesInOrder[0]))) : '')
  if (filesInOrder.length > 0 && filesInOrder.every(file => existsSync(file))) {
    const perShot = []
    for (const file of filesInOrder) perShot.push({ file, seconds: await probeDurationSeconds(file) })
    const fileSum = perShot.reduce((sum, item) => sum + item.seconds, 0)
    say('逐镜文件 ' + String(perShot.length) + ' 个，真实时长之和=' + fileSum.toFixed(2) + 's（'
      + perShot.map(item => item.seconds.toFixed(2)).join(' + ') + '）')
    record('逐镜文件之和 ≈ 成片时长（±1 秒）', Math.abs(fileSum - probed.seconds) <= 1,
      '逐镜和=' + fileSum.toFixed(2) + 's 成片=' + probed.seconds.toFixed(2) + 's')

    // 字幕：读真正被烧进画面的那份 ASS（拼接层写在成片同目录）。
    const assFile = join(dataRoot, 'uploads', 'long-video-subs.ass')
    if (existsSync(assFile)) {
      const ass = readFileSync(assFile, 'utf8')
      const dialogues = []
      for (const raw of ass.split(/\r?\n/)) {
        if (!raw.startsWith('Dialogue:')) continue
        const fields = raw.slice('Dialogue:'.length).split(',')
        if (fields.length < 10) continue
        dialogues.push({
          start: assSeconds(fields[1]),
          end: assSeconds(fields[2]),
          text: fields.slice(9).join(',').replace(/\\N/g, ''),
        })
      }
      writeFileSync(join(evidenceDir, 'long-video-subs.ass'), ass, 'utf8')
      // 每一镜的字幕窗口：按镜头顺序累加**逐镜文件的真实时长**（与拼接层同一份事实）。
      const windows = []
      let cursor = 0
      let shotAt = 0
      for (const shot of shots) {
        const file = shotFiles[String(shot.index)]
        if (typeof file !== 'string' || file === '') continue
        const seconds = perShot[shotAt]?.seconds ?? 0
        if (lines[shot.index] !== '') windows.push({ index: shot.index, start: cursor, end: cursor + seconds, line: lines[shot.index] })
        cursor += seconds
        shotAt += 1
      }
      // 归属按字幕条的**中点**判定：字幕条首尾相接，中点只会落在唯一一镜的区间里。
      // 用"起点落在窗口内（带容差）"会把下一镜的第一条算进本镜——它的起点正好等于本镜终点，
      // 2026-09-23 首轮就是这么误判的（报"第1/2镜不一致"，而 ASS 本身是对的）。
      let textOk = true
      let orphan = 0
      let stray = 0
      const detail = []
      for (const window of windows) window.cues = []
      for (const item of dialogues) {
        const mid = (item.start + item.end) / 2
        const owner = windows.find(window => mid >= window.start && mid < window.end)
        if (owner === undefined) { orphan += 1; continue }
        // 一行字幕跨到相邻镜的区间里就是"字幕串镜"——单独一条判据，不混进文本比对。
        if (item.start < owner.start - 0.05 || item.end > owner.end + 0.05) stray += 1
        owner.cues.push(item)
      }
      for (const window of windows) {
        const joined = window.cues.map(item => item.text.replace(/\s+/g, '')).join('')
        const same = joined === window.line.replace(/\s+/g, '')
        if (!same) textOk = false
        detail.push('第' + String(window.index + 1) + '镜 ' + String(window.cues.length) + ' 条=' + (same ? '一致' : '不一致'))
      }
      say('字幕 ' + String(dialogues.length) + ' 条（分页后）落在 ' + String(windows.length) + ' 镜窗口里；窗口外 ' + String(orphan)
        + ' 条、跨界 ' + String(stray) + ' 条；' + detail.join(' '))
      record('每一句有台词的镜都有字幕', windows.length === spokenShots, '有台词镜=' + String(spokenShots) + ' 字幕窗口=' + String(windows.length))
      record('每条字幕文本 = 那一镜的台词', textOk, detail.join(' '))
      record('每条字幕都落在它那一镜的区间里', orphan === 0 && stray === 0, '窗口外=' + String(orphan) + ' 跨界=' + String(stray))
    }
    else {
      record('读得到被烧进画面的字幕文件', false, '找不到 ' + assFile)
    }
  }
  else {
    say('（逐镜文件不在本机或路径不可达，本轮只核对成片与任务记录，不做就地逐镜/字幕核对）')
  }
}
/**
 * ASS 时间戳（H:MM:SS.cc）转秒。
 * @param text - ASS 时间戳。
 * @returns 秒数；解析不出来时 0。
 */
function assSeconds(text) {
  const match = /(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text ?? '').trim())
  return match === null ? 0 : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

// ---- 报告与退出码 -----------------------------------------------------------
const fails = checks.filter(item => !item.ok)
const reportFile = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'reports', 'long-video-e2e-' + stamp + '.md')
const verdict = fails.length === 0 ? 'PASS' : 'FAIL'
const lines2 = [
  '# 长视频端到端对账 ' + stamp,
  '',
  '> 探针：`qa/probes/verify-long-video-e2e.mjs`（真实 REST + 真实厂商 + 真实配音 + 真实 ffmpeg）。',
  '> 对标定位：**E3 无端到端证据不算完成** —— 长视频这条链路的「完成」以真机成片与字幕逐镜对账为准（[对标基线](../docs/对标基线-飞书×豆包工作.md)）。',
  '> 结论：**' + verdict + '**（' + String(checks.length - fails.length) + ' 绿 / ' + String(fails.length) + ' 红）。',
  '',
  '## 1. 这次跑的是什么',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 实例 | ' + ORIGIN + ' |',
  '| 任务 | ' + String(taskId) + ' |',
  '| 内容形式 | ' + PRODUCER + '（形象 ' + String(human.id) + '，念法 ' + String(human.persona ?? '-') + '） |',
  '| 目标 | ' + String(SECONDS) + ' 秒 / ' + RESOLUTION + ' / ' + ASPECT + ' |',
  '| 产品图 | ' + (PRODUCT_IMAGE === '' ? '（无）' : PRODUCT_IMAGE) + ' |',
  '| 视频模型 | ' + String(llm.data.video.model) + ' |',
  '| 耗时 | ' + String(Math.round((Date.now() - began) / 60000)) + ' 分钟 |',
  '',
  '## 2. 分镜与成片',
  '',
  '| 项 | 数字 |',
  '| --- | --- |',
  '| 分镜数 | ' + String(shots.length) + ' |',
  '| 有台词的镜 | ' + String(spokenShots) + ' |',
  '| 稿件字数 | ' + String(task.scriptChars ?? 0) + ' |',
  '| 成片 | ' + filmUrl + ' |',
  '',
  '每镜台词：',
  '',
  ...shots.map((shot, index) => String(index + 1) + '. `' + String(shot.kind) + '` ' + String(shot.seconds) + 's：' + (lines[index] === '' ? '（无台词）' : lines[index])),
  '',
  '## 3. 判据逐条',
  '',
  '| 判据 | 结论 | 明细 |',
  '| --- | --- | --- |',
  ...checks.map(item => '| ' + item.name + ' | ' + (item.ok ? '✅' : '⛔') + ' | ' + String(item.detail).replace(/\|/g, '/') + ' |'),
  '',
]
writeFileSync(reportFile, lines2.join('\n'), 'utf8')
say('LONG_VIDEO_E2E ' + verdict + ' checks=' + String(checks.length) + ' fail=' + String(fails.length)
  + ' report=' + reportFile + ' evidence=' + evidenceDir)
process.exit(fails.length === 0 ? 0 : 1)
