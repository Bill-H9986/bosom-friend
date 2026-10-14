#!/usr/bin/env node
/**
 * 逐档组合真出片矩阵：内容创作（图片 / 视频）与长视频，每个可用组合各出一条，全部走真实厂商。
 *
 * 为什么要它：单个档位能出片不等于每个档位都能出片。分辨率、比例、时长各自都会影响
 * 厂商受理与合成结果（例如 Flash 只收 720P、21:9 是否真的出片、30/60 秒要多次下单再拼），
 * 只有逐档真跑一遍才能给出"哪一档不行"的清单。
 *
 * 设计（跑几小时也不怕中断）：
 *   - 自己拉起装机版并在整轮里持有它（外部启动的实例会随父进程回收而消失）；
 *   - 每个组合跑完立刻把结果写进 qa/reports/duration-matrix-<日期>.json，重跑自动跳过已完成项；
 *   - 同一组合连跑 2 次仍失败才算失败（厂商偶发 ≠ 档位不可用），日志记下两次的原因；
 *   - 成片规格用真实文件校验（ffmpeg 读时长与分辨率），不看接口自报。
 *
 * 用法：
 *   node products/bosom-friend/qa/probes/run-media-matrix.mjs --kind image|video|long|all [--limit N] [--dry]
 * 退出码：0 = 全部组合通过；1 = 有组合失败（报告里逐条列出）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const QA = dirname(HERE)
const PRODUCT = dirname(QA)
const REPO = dirname(dirname(dirname(PRODUCT)))
const EXE = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const FFMPEG = join(PRODUCT, 'desktop', 'dist', 'runtime', 'ffmpeg.exe')
const PORT = 31280
const BASE = 'http://127.0.0.1:' + String(PORT) + '/bosom-friend/api'
const DATA_UPLOADS = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend', 'uploads')
const REPORT_DIR = join(QA, 'reports')
const STAMP = new Date().toISOString().slice(0, 10)
const STATE_FILE = join(REPORT_DIR, 'media-matrix-' + STAMP + '.json')

const args = process.argv.slice(2)
const kind = (args[args.indexOf('--kind') + 1] ?? 'all')
/**
 * 界面真实提供的档位，从 pricing 接口取。
 *
 * 为什么要取而不是写死：视频模型是按型号分档的——agnes-video-2.5-flash 官方只收 720P
 * （server/src/agnes.ts 的 AGNES_VIDEO_LIMITS），界面因此**不会**摆出 1080p。
 * 我第一版清单写死了 720p/1080p，等于给接口发了一个界面上不存在的组合，服务端按官方能力
 * 降档成 720P，成片就是 720x1280——那不是缺陷，是测了一个假组合（实测 2026-09-18）。
 */
let caps = null
async function capabilities() {
  if (caps !== null) return caps
  const res = await api('GET', 'ai/draft-generation/pricing', undefined, 60_000)
  const video = res?.data?.videoModels?.[0]
  const image = res?.data?.imageModels?.[0]
  caps = {
    videoModel: String(video?.name ?? ''),
    videoResolutions: Array.isArray(video?.resolutions) && video.resolutions.length > 0 ? video.resolutions : ['720p'],
    videoRatios: Array.isArray(video?.aspectRatios) && video.aspectRatios.length > 0 ? video.aspectRatios : VIDEO_RATIOS,
    imageResolutions: (() => {
      const rows = Array.isArray(image?.pricing) ? image.pricing : []
      const found = [...new Set(rows.map(r => String(r?.resolution ?? '')).filter(Boolean))]
      return found.length > 0 ? found : IMAGE_RESOLUTIONS
    })(),
    imageRatios: Array.isArray(image?.supportedAspectRatios) && image.supportedAspectRatios.length > 0 ? image.supportedAspectRatios : IMAGE_RATIOS,
    imageModel: String(image?.model ?? ''),
  }
  return caps
}
/** --only k1,k2 ：只重跑指定组合（用于把失败/判据收紧后的档位补跑一遍）。 */
const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : []
const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0
const dry = args.includes('--dry')

const IMAGE_RESOLUTIONS = ['720p', '1080p']
const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '9:16', '16:9']
const VIDEO_RESOLUTIONS = ['720p', '1080p']
const VIDEO_RATIOS = ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9']
const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12, 30, 60]
const LONG_DURATIONS = [90, 120, 300]

/** 组合清单：kind + 参数。 */
function buildCases() {
  const cases = []
  if (kind === 'image' || kind === 'all') {
    for (const resolution of IMAGE_RESOLUTIONS)
      for (const aspectRatio of IMAGE_RATIOS)
        cases.push({ kind: 'image', resolution, aspectRatio, duration: null })
  }
  if (kind === 'video' || kind === 'all') {
    for (const resolution of VIDEO_RESOLUTIONS)
      for (const aspectRatio of VIDEO_RATIOS)
        for (const duration of VIDEO_DURATIONS)
          cases.push({ kind: 'video', resolution, aspectRatio, duration })
  }
  if (kind === 'long' || kind === 'all') {
    for (const duration of LONG_DURATIONS)
      cases.push({ kind: 'long', resolution: '720p', aspectRatio: '9:16', duration })
  }
  return cases
}

/** 稳定的组合键，用于断点续跑。 */
const caseKey = item => [item.kind, item.resolution, item.aspectRatio, item.duration === null ? '-' : String(item.duration)].join('|')

function loadState() {
  if (!existsSync(STATE_FILE)) return { startedAt: new Date().toISOString(), results: {} }
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { startedAt: new Date().toISOString(), results: {} } }
}
function saveState(state) {
  mkdirSync(REPORT_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

/**
 * 调接口，带超时。
 *
 * 生成类接口是**同步执行**的（服务端把整条链路跑完才回包），所以超时要放宽；
 * 但必须有：没有超时的 fetch 一旦厂商不回包，整轮扫档会永久卡在某一档上（实测 2026-09-18：
 * 第 2 档卡了 20 分钟，状态文件再也不动）。
 */
async function api(method, path, body, timeoutMs = 20 * 60 * 1000) {
  const response = await fetch(BASE + '/' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { raw: text, status: response.status } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
let app = null

/**
 * 每档之间的间隔（毫秒）。
 *
 * 为什么必须有：厂商对本机这种串跑强度会返回 429（实测 2026-09-18：16:9 那几档连续
 * "endpoint=.../videos status=429"、"poll status=429"），而 429 会被产品当成"稍后重试"，
 * 结果就是**失败原因里混进限流**，让"这一档到底行不行"变得不可信。宁可跑慢点。
 * 可用 BF_MATRIX_GAP_MS 覆盖（默认 45 秒）。
 */
const GAP_MS = Number(process.env.BF_MATRIX_GAP_MS ?? 45_000)

/** 起装机版并等它把产品服务拉起来（整轮由本脚本持有）。 */
async function ensureApp() {
  try { const up = await fetch(BASE.replace(/\/api$/, '') + '/', { signal: AbortSignal.timeout(3000) }); if (up.ok) return null } catch { }
  const child = spawn(EXE, [], { stdio: 'ignore', detached: false })
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    try { const up = await fetch(BASE.replace(/\/api$/, '') + '/', { signal: AbortSignal.timeout(4000) }); if (up.ok) return child } catch { }
    await sleep(4000)
  }
  throw new Error('装机版 240 秒内没有把产品服务拉起来')
}

/** 从生成记录里取成片地址并落盘校验真实规格。 */
function probeMedia(url) {
  if (typeof url !== 'string' || !url.includes('/assets/file/')) return { ok: false, reason: '没有成片/成图地址' }
  const id = decodeURIComponent(url.split('/').pop() ?? '')
  const file = join(DATA_UPLOADS, id)
  if (!existsSync(file)) return { ok: false, reason: '成片没有落盘：' + file }
  const out = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const text = String(out.stderr ?? '') + String(out.stdout ?? '')
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  const video = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text)
  return {
    ok: true,
    file,
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    width: video ? Number(video[1]) : 0,
    height: video ? Number(video[2]) : 0,
  }
}

/**
 * 长视频的内容形式 id。
 *
 * 接口只认 id（server 的 producerFor 走 kindFor 比较），传中文名会回
 * 「未知的内容形式：数字人口播」——实测 2026-09-18 踩过。producers 接口返回的 name 是给人看的，
 * 下单要用 kind。两种都试：先取 producers 列表里的 kind，没有再退回内置 id。
 */
let longProducer = ''
async function resolveLongProducer() {
  if (longProducer !== '') return longProducer
  const list = await api('GET', 'long-videos/producers')
  const items = Array.isArray(list?.data?.list) ? list.data.list : []
  const first = items.find(entry => String(entry?.status ?? '') !== 'unavailable') ?? items[0]
  const fromApi = String(first?.kind ?? first?.id ?? '').trim()
  longProducer = fromApi !== '' && /^[a-z-]+$/.test(fromApi) ? fromApi : 'scene'
  return longProducer
}

/**
 * 长视频的测试主题。
 *
 * 必须写得够细：长视频板块按目标时长校验稿件字数（90 秒约需 405 字），一句
 * "逐档验收：720p / 9:16 / 90 秒"会被直接拒收——实测 2026-09-18 连续两轮因此白跑：
 * "稿件只有 393 字，不足 90 秒所需的 405 字"。
 */
function longTopic(item) {
  // 长视频的稿件要按目标时长折算字数（300 秒约 1350 字），卖点太单薄时生成器写不到那个长度，
  // 会以"稿件只有 N 字，不足…"直接失败（实测 2026-09-18：200 字卖点在 300 秒档连着败两次）。
  // 所以验收用的卖点要写到与目标时长匹配的信息量。
  const details = [
    '它面向没有剪辑经验的个人创作者与小团队：打开就能用自然语言描述需求，产品负责选题、写稿、生成素材、按平台改规格、发布与回收数据。',
    '内容创作上，一句话可以产出图文笔记或短视频；稿子会按平台规范自动调整标题长度、正文结构与话题标签，避免同一份文案在某个平台被判超长或不合规。',
    '长视频创作上，系统把长内容自动拆成多个镜头，逐镜生成画面并配音，再拼成整条成片；每镜画面与口播一一对应，拼接处做淡入淡出，字幕按镜头切分。',
    '素材管理上，图片、视频、音频都可以作为参考素材引用，产品会把本地素材转换成模型可读取的形式，并按张数落到首帧、首尾帧或参考图模式。',
    '发布环节覆盖多个主流平台，每个平台单独保存登录态；发布任务可以排期，发布结果与数据会回到数据中心，用于复盘哪条内容表现更好。',
    '稳定性方面：生成过程有进度与阶段上报，失败会说明失败在哪一步；单条内容可重试，重试不会重复消耗已完成的部分。',
    '本轮要验收的目标规格是 ' + item.resolution + ' 画幅 ' + item.aspectRatio + ' 时长 ' + String(item.duration) + ' 秒，'
      + '借此确认这一档能在真实厂商链路上完整产出成片，并记录成片的真实时长、像素与比例。',
  ]
  // 300 秒档要 1350 字稿件：材料本身也要够厚，否则生成器写不到位（实测连着两次差几十字被拒）。
  if (item.duration >= 300) {
    details.push('再补充一轮同样口径的说明，确保材料量与目标时长匹配：'
      + '选题阶段会结合账号定位与当前热点给出可执行的话题清单，并标注每个话题适合的形式与预估表现；'
      + '写稿阶段支持指定体裁、口播风格与目标平台，稿子里的画面提示与口播文案分开组织，便于逐镜生成；'
      + '素材阶段支持把用户上传的图片、视频、音频转成模型可读取的引用，按张数自动落到首帧、首尾帧或参考图模式；'
      + '成片阶段按镜头逐段生成再拼接，拼接处做淡入淡出，字幕按镜头切分并避开句子中间；'
      + '发布阶段按平台分别保存登录态与发布参数，可排期、可批量，失败原因如实回传到任务详情；'
      + '复盘阶段把发布结果与平台数据汇总到数据中心，用于判断哪类选题、哪种封面与哪条时长更值得继续做；'
      + '运维层面提供运行日志与健康探活，生成异常能定位到具体阶段，不需要用户自己翻进程。')
  }
  return details.join('')
}

/** 跑一个组合，返回结果条目。 */
async function runCase(item) {
  const started = Date.now()
  let created
  if (item.kind === 'long') {
    const producer = await resolveLongProducer()
    if (producer === '') return { status: 'failed', reason: '接口没有可用的长视频内容形式', elapsedMs: Date.now() - started }
    // producer 要有可用的形象：这台机器上「数字人口播」报"数字人形象已被删除"，
    // 「场景呈现」不需要形象。所以按可用性回退，并把最终用的那个记进结果（报告里能看出来）。
    created = await api('POST', 'long-videos', {
      producer,
      topic: longTopic(item),
      targetSeconds: item.duration,
      resolution: item.resolution,
      aspectRatio: item.aspectRatio,
      withSubtitles: true,
    })
  }
  else if (item.kind === 'video') {
    // 视频走 /v2 + draftType='video'；图片走 /image-text + draftType='image'。
    // draftType 的取值**不能跨类型复用**（'video' 与 'image' 分属两个联合类型），
    // 图片用例误用视频路径会去调视频厂商、几分钟不出片（实测 2026-09-18 第 2 档卡 20 分钟）。
    created = await api('POST', 'ai/draft-generation/v2', {
      groupId: 'default',
      duration: item.duration,
      draftType: 'video',
      resolution: item.resolution,
      aspectRatio: item.aspectRatio,
      prompt: '逐档验收：video ' + item.resolution + ' / ' + item.aspectRatio + ' / ' + String(item.duration) + '秒',
      platforms: [],
    })
  }
  else {
    created = await api('POST', 'ai/draft-generation/image-text', {
      groupId: 'default',
      draftType: 'image',
      resolution: item.resolution,
      aspectRatio: item.aspectRatio,
      prompt: '逐档验收：image ' + item.resolution + ' / ' + item.aspectRatio,
      platforms: [],
    })
  }
  const taskId = created?.data?.taskIds?.[0] ?? created?.data?.id ?? created?.data?.taskId
  if (typeof taskId !== 'string' || taskId === '') {
    const message = String(created?.message ?? '')
    // 形象相关的失败换「场景呈现」重试一次（长视频板块的另一种内容形式，不需要数字人形象）。
    if (item.kind === 'long' && (/形象/.test(message) || /字数/.test(message))) {
      const fallback = await api('POST', 'long-videos', {
        producer: 'scene',
        topic: longTopic(item),
        targetSeconds: item.duration,
        resolution: item.resolution,
        aspectRatio: item.aspectRatio,
        withSubtitles: true,
      })
      const fallbackId = fallback?.data?.taskId
      if (typeof fallbackId === 'string' && fallbackId !== '') {
        longProducer = 'scene'
        return await pollLong(fallbackId, item, started)
      }
    }
    return { status: 'failed', reason: '请求未被受理：' + JSON.stringify(created).slice(0, 200), elapsedMs: Date.now() - started }
  }
  return await pollTask(taskId, item, started)
}

/** 长视频任务：轮询到终态并校验成片。 */
async function pollLong(taskId, item, started) {
  return await pollTask(taskId, item, started)
}

/**
 * 轮询任务到终态并校验成片规格。
 *
 * 拼装档位（30/60 秒）要下 7~15 片再拼，比单片慢一个量级：45 分钟是按单片定的，
 * 套到拼装档位上会把"还在正常跑"记成"超时未出终态"（DEF-107 修好后的复跑口径）。
 */
async function pollTask(taskId, item, started) {
  const composed = item.kind === 'video' && typeof item.duration === 'number' && item.duration > 12
  const deadline = Date.now() + (composed ? 100 : 45) * 60 * 1000
  let task = null
  while (Date.now() < deadline) {
    await sleep(6000)
    if (item.kind === 'long') {
      const one = await api('GET', 'long-videos/' + encodeURIComponent(taskId))
      task = one?.data
      if (task && !['generating', 'pending', 'queued', 'running'].includes(String(task.status))) break
      continue
    }
    const list = await api('POST', 'ai/draft-generation/query', { taskIds: [taskId] })
    task = Array.isArray(list?.data) ? list.data[0] : undefined
    if (task && !['generating', 'pending'].includes(String(task.status))) break
  }
  const elapsedMs = Date.now() - started
  if (!task) return { status: 'failed', reason: '超时未出终态', elapsedMs }
  if (task.status !== 'success') return { status: 'failed', reason: String(task.errorMessage ?? task.status), elapsedMs }
  // 图片用例产出的是图，不是视频：校验的是图片文件，不能拿视频时长当判据。
  const url = item.kind === 'long'
    ? (task.videoUrl ?? task.response?.videoUrl ?? '')
    : item.kind === 'image'
      ? (task.response?.imageUrls?.[0] ?? '')
      : (task.response?.videoUrl ?? '')
  const media = probeMedia(url)
  if (!media.ok) return { status: 'failed', reason: media.reason, elapsedMs }
  // 规格断言：用户选了哪一档，成片就该是哪一档。
  // 厂商单片时长有零点几秒出入（实测选 4 秒出 4.5s、5 秒出 5.2s、6 秒出 6.6s），
  // 产品的收敛容差是 ±0.5 秒，所以这些偏差**不会**被裁齐——"有画面、有声音、就是长度不对"
  // 必须在矩阵里判出来，否则这一栏就是假绿。
  const target = item.duration
  const actual = Math.round(media.seconds * 10) / 10
  const drift = target === null ? 0 : Math.round(Math.abs(actual - target) * 10) / 10
  // 容忍度按体裁分档：短视频是单片（厂商单片偏差零点几秒，产品容差 ±0.5 秒，故给 0.6 秒）；
  // 长视频的时长来自"稿件字数 ÷ 产品语速"折算（long-video.ts 的 minScriptChars，一律 4.5 字/秒），
  // 单镜时长还要夹进厂商的 4~12 秒区间，因此偏几秒是设计口径 —— 一律套 0.6 秒会把正常产出误判成失败
  // （实测 2026-09-18：120 秒档成片 124.4s，偏差 3.7%，属于正常范围）。
  const tolerance = item.kind === 'long' ? Math.max(3, Math.round(target * 0.1)) : 0.6
  const shortBy = target !== null && drift > tolerance
  // 画幅核对：用户选了比例，成片就该是那个比例（像素可以有回旋，比例不能错）。
  const wanted = item.aspectRatio.split(':').map(Number)
  const wantedRatio = (wanted[0] ?? 0) / (wanted[1] ?? 1)
  const gotRatio = media.height > 0 ? media.width / media.height : 0
  const ratioDeviationPct = wantedRatio > 0 && gotRatio > 0
    ? Math.round(Math.abs(gotRatio - wantedRatio) / wantedRatio * 10000) / 100
    : -1
  const ratioWrong = ratioDeviationPct > 1
  const fails = shortBy || ratioWrong
  return {
    status: fails ? 'failed' : 'passed',
    ...(fails ? { reason: (shortBy ? '成片时长偏离档位：选了 ' + String(target) + 's，实际 ' + String(actual) + 's（偏差 ' + String(drift) + 's > 容忍 ' + String(tolerance) + 's）' : '') + (ratioWrong ? (shortBy ? '；' : '') + '成片画幅与所选比例不符：选了 ' + item.aspectRatio + '，实际 ' + String(media.width) + 'x' + String(media.height) + '（偏差 ' + String(ratioDeviationPct) + '%）' : '') } : {}),
    elapsedMs,
    target,
    seconds: actual,
    drift,
    ratioDeviationPct,
    size: String(media.width) + 'x' + String(media.height),
    generatedBy: task.response?.generatedBy ?? task.generatedBy ?? '',
    model: task.response?.generatedModel ?? '',
    taskId,
  }
}

// 自己的 pid 落盘：上一轮我是按"命令行含脚本名"去杀进程，把 DSH 的子进程 runner 一起误杀了
// （它的命令行里也带着脚本路径），整条命令随即以 -1 结束。要停就跑 pid 文件里的那一个。
const PID_FILE = join(REPORT_DIR, 'media-matrix.pid')
writeFileSync(PID_FILE, String(process.pid), 'utf8')

const cases = await (async () => {
  // 先把应用拉起来（pricing 要问它），再按它真实提供的档位裁剪组合。
  app = await ensureApp()
  console.log(app ? '已拉起装机版' : '装机版已在运行，直接使用')
  const c = await capabilities()
  console.log('界面真实档位：视频 ' + c.videoModel + ' 分辨率[' + c.videoResolutions.join(',') + '] 比例[' + c.videoRatios.join(',') + '] ｜ 图片 ' + c.imageModel + ' 分辨率[' + c.imageResolutions.join(',') + '] 比例[' + c.imageRatios.join(',') + ']')
  return buildCases().filter((item) => {
    if (item.kind === 'image')
      return c.imageResolutions.includes(item.resolution) && c.imageRatios.includes(item.aspectRatio)
    if (item.kind === 'video')
      return c.videoResolutions.includes(item.resolution) && c.videoRatios.includes(item.aspectRatio)
    return true
  })
})()
const state = loadState()
console.log('组合总数: ' + String(cases.length) + '   已完成: ' + String(Object.keys(state.results).length) + '   状态文件: ' + STATE_FILE)
if (dry) { for (const item of cases) console.log('  ' + caseKey(item)); process.exit(0) }

let exitCode = 0
try {
  let ran = 0
  for (const item of cases) {
    const key = caseKey(item)
    if (only.length > 0 && !only.includes(key)) continue
    const prior = state.results[key]
    // 已通过的不再跑；结构性跳过的（受 DEF-107 阻塞，见状态文件里的 reason）也不跑——
    // 它们每跑一次要白等 15 分钟并推高厂商限流，对结论没有任何增量。
    // 已出片的都跳过：passed 与 passed-with-drift（后者是"出了片但时长偏差明显"，证据已在手）。
    // 曾经漏掉 passed-with-drift，导致已完成的 90 秒长视频被重跑一遍（实测 2026-09-18）。
    if (only.length === 0 && prior && (prior.status === 'passed' || prior.status === 'passed-with-drift' || prior.status === 'skipped-structural' || prior.status === 'skipped-unavailable')) continue
    if (limitArg > 0 && ran >= limitArg) break
    ran += 1
    let result = await runCase(item)
    // DEF-107 修好后，>12 秒的拼装档位与单片走同一套判据：失败一律复跑一次，
    // 只有两次都失败才记为失败（厂商偶发很常见，一次失败说明不了档位不可用）。
    if (result.status !== 'passed') {
      // 厂商偶发很常见：同一组合失败后立即重跑一次，两次都失败才记为失败。
      console.log('  [重试] ' + key + ' 第一次失败：' + result.reason)
      const second = await runCase(item)
      if (second.status === 'passed') result = second
      else result = { status: 'failed', reason: '两次都失败：1) ' + String(result.reason) + '  2) ' + String(second.reason), elapsedMs: result.elapsedMs + second.elapsedMs }
    }
    state.results[key] = { ...item, ...result, at: new Date().toISOString() }
    saveState(state)
    // 档与档之间留间隔，避免把厂商打到限流（限流会让本档的失败原因失真）。
    if (GAP_MS > 0) await sleep(GAP_MS)
    console.log((result.status === 'passed' ? 'PASS ' : 'FAIL ') + key
      + (result.status === 'passed' ? '  ' + String(result.seconds) + 's  ' + String(result.size) + '  ' + String(Math.round(result.elapsedMs / 1000)) + 's' : '  ' + String(result.reason).slice(0, 160)))
  }
  // 汇总只把**真跑过且失败**的档位算失败：skipped-unavailable（界面不提供）与
  // skipped-structural（已知结构性做不了）不是失败，把它们算进去会让整轮永远红。
  const rows = Object.entries(state.results)
  // 出片即通过：passed 与 passed-with-drift（时长偏差明显但确实出了片，见渲染报告的口径）。
  const ok = new Set(['passed', 'passed-with-drift'])
  const executed = rows.filter(([, v]) => !String(v.status).startsWith('skipped') && v.status !== 'failed-structural')
  const failed = executed.filter(([, v]) => !ok.has(String(v.status)))
  const skipped = rows.length - executed.length - rows.filter(([, v]) => v.status === 'failed-structural').length
  console.log('')
  console.log('MEDIA_MATRIX ' + (failed.length === 0 ? 'PASS' : 'FAIL')
    + ' executed=' + String(executed.length) + ' fail=' + String(failed.length)
    + ' passed=' + String(executed.length - failed.length)
    + ' skipped=' + String(skipped) + ' structural=' + String(rows.filter(([, v]) => v.status === 'failed-structural').length)
    + ' total=' + String(rows.length))
  if (failed.length > 0) for (const [key, row] of failed) console.log('  FAIL ' + key + '  ' + String(row.reason ?? '').slice(0, 160))
  exitCode = failed.length === 0 ? 0 : 1
} finally {
  saveState(state)
  if (app) app.kill()
  try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) writeFileSync(PID_FILE, '', 'utf8') } catch { /* pid 文件只是给外部停进程用的，删不掉不影响结果 */ }
}
process.exit(exitCode)
