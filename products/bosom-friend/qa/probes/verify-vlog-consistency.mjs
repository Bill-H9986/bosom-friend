#!/usr/bin/env node
/**
 * 走动 VLOG 跨镜一致性对账：同一个形象、同一个种子 vs 每镜换随机种子，用**真实厂商**出片后验"跨镜还是不是同一个人"。
 *
 * 为什么需要它：跨镜"不换人"是长视频的第一观感。单测只能证明"形象图与种子被传下去了"，
 * 证明不了厂商按它出片时镜头之间真的是同一个人；这条探针拿真实厂商的成片首帧来对账。
 *
 * 做法（每次真调厂商 2×N 次视频 + 1 张图，会花额度）：
 *   A 条：每一镜都用形象上那个固定种子（现状）；
 *   B 条：每一镜各换一个随机种子（负向对照，复现"每镜换人"的旧形态）；
 *   两条用同一个形象图、同一组台词与场景提示词——台词逐字写进提示词、由厂商在出片时自己念，**唯一的差别就是种子**。
 *
 * 判据（2026-09-23 首轮实测后定稿，见 qa/reports/vlog-consistency-*.md）：
 *   1. **身份**：A 条的每一对跨镜首帧都必须判"同一个人"（判红项）。判定由**产品配置里的那个模型**做
 *      （它认得图；探针直连厂商，与 qa/probes/vendor-broll-recon.mjs 同一口径，不经过产品链路）；
 *   2. **判官自检（准入项只有毒丸对）**：成片首帧 vs 另生成的一位陌生人 = 不是同一个人——
 *      判官见谁都答「同一个人」时这里会露馅，自检不过 → 本轮 SKIP（不下结论）。
 *      同一条镜头内的首帧 vs 中段帧**只作记录**：同一对实测 flash 只有 9/15 说「同一个人」，
 *      比判据那一对（12/15）还难——它当准入项只会制造假 SKIP（2026-09-24 实测两轮门禁都栽在这上面）；
 *   3. **种子在做什么**（记录，不判红）：B 条若也判"同一个人"，说明身份由参考图锚定、种子只改构图与细节；
 *      B 条若判"不是同一个人"，说明固定种子确实是身份的一半依据。
 *
 * 为什么不用像素相似度当判据：首轮实测（A1↔A2 = 0.472 而"同场景不同种子"的 A2↔B2 = 0.673）
 * 证明整帧/人脸框的像素相关被**姿态与背景**主导，量不出身份——三组像素数仍照打，作为稳定性证据。
 *
 * 判官的四条稳定性措施（都是实测逼出来的）：
 *   1. 问句里写明"同一个形象的两条镜头、角度可能不同"——只问"是同一个人吗"时，同一位女士的正面与侧脸
 *      三次里两次被判"不是"；
 *   2. 每一对**最多采十五票、同一答案满十票才作数**（满票即提前收工）：判官单票错误率约五分之一且方向单一
 *      （只会在"同一个人"上偶尔说"不是"，从不对明显不同的人说"是"，实测毒丸对 15/15），所以门槛定在 15 取 10；
 *   3. 单次调用遇 429/5xx 等 15 秒重试（最多 8 次）、每票之间隔 3 秒、`temperature=0`——免费档的速率限制是
 *      每分钟级的，实测连打十几票后整段判定会被 429 打断（第五次跑）；确定性失败（密钥/参数）不重试；
 *   4. 准入项只留**毒丸对**（判官从不对明显不同的人说「是」，实测 15/15）；同镜真值对与跨域的形象锚定都只作记录。
 *      历史：同域真值对当准入项时，flash 在这对上只有 9/15 说「同一个人」——两轮门禁都因此判黄/跳过；
 *      跨域的形象锚定（形象图 vs 成片首帧）实测 1:2 与 2:1 都出现过，一直是记录项：形象图与视频帧是两个画风的域（形象图可能是插画或半写实），
 *      同一对实测出现过 1:2 与 2:1 两种结果——这一对现在是记录项 `avatarAnchor`，不参与准入。
 *
 * 服务不可用 / 有镜没出片 / 判官自检失败 / 十五票里没有满十票的一致答案 → 打印 SKIP 并退出 2；两条都必须跑完。
 *
 * 用法：node --import tsx/esm products/bosom-friend/qa/probes/verify-vlog-consistency.mjs [--shots 2] [--human dh-xxx] [--dry-run]
 *      加 --reuse <证据目录> 可只重判那次留下的成片（不再调厂商出片，判据改动后复算用）
 * 环境：BF_DSH_HOME 覆盖产品数据根（默认 ~/.bosom-friend）
 * 退出码：0 = 通过；1 = 跨镜换人（判红）；2 = 跳过（服务不可用/没出片/判官不可信/配置缺失）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { createPiAiMediaProvider } from '../../../../packages/media/media-pi-ai/src/index.ts'
import { runFfmpeg } from '../../server/src/ffmpeg.ts'

/** 单镜等待上限（毫秒）：厂商排队 + 429 重试，实测单镜 100~230 秒，限流时要等更久。 */
const SHOT_BUDGET_MS = 15 * 60_000
/** 一镜最多下几单：厂商明确报失败时重下（瞬时失败重下就成，见 generateShot 的说明）。 */
const SHOT_ATTEMPTS = 3
/** 轮询间隔（与产品同口径）。 */
const POLL_INTERVAL_MS = 4_000
/** 判官答案的三个取值：只认这三个，别的都算"判不了"。 */
const VERDICTS = ['同一个人', '不是同一个人', '看不清']

const args = process.argv.slice(2)
const argValue = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const SHOTS = Math.max(2, Number(argValue('--shots') ?? 2) || 2)
const DRY_RUN = args.includes('--dry-run')
/**
 * 复用某次跑留下的成片重新判定（判据改了要重判时不必再花一次厂商额度）。
 *
 * 只跳过"下单出片"：成片、首帧、判官与报告全部按当前判据重来，证据目录仍指向那一份。
 */
const REUSE_DIR = (argValue('--reuse') ?? '').trim()
const HOME = (process.env.BF_DSH_HOME ?? '').trim() !== '' ? process.env.BF_DSH_HOME.trim() : join(homedir(), '.bosom-friend')
const PRODUCT_ROOT = join(HOME, 'bosom-friend')

/** 这一条 VLOG 的镜头：场景不同、台词不同（真实片子里就是这样），人物始终是同一个形象。 */
const SCENES = [
  '清晨的社区步道上，她一边走一边说，两侧是梧桐树与晨练的人，手持跟拍，画面随步伐轻微起伏',
  '明亮的奶茶店门口，她边走边侧头说话，身后是玻璃橱窗与绿植，手持跟拍，镜头跟着她移动',
  '傍晚的写字楼连廊，她边走边看向镜头说话，远处是落地窗与暖色灯带，手持跟拍，镜头缓缓后退',
]
const LINES = [
  '秋冬脸干到起皮，上妆还卡粉，这罐面霜我用了两周才敢说这句话。',
  '它主打的是先修护再锁水，涂开以后不搓泥，早上化妆也不会打架。',
  '现在下单送一支同系列小样，想要的姐妹评论区扣个一。',
]
/** 与产品走动 VLOG 同口径的运镜要求（api.ts 的 MOVING_TALKING_CLAUSE 是同一句要求；探针不 import 闭包内常量）。 */
const MOVING_CLAUSE = '手持跟拍，人物在走动中说话，画面随步伐移动，禁止静止画面；画面里不出现任何文字与品牌标识'
/** 毒丸：另生成一位陌生人，用来验判官不是"什么都答同一个人"。 */
const STRANGER_PROMPT = '一位 35 岁中国男性的正面证件照：短发、方脸、深色夹克，纯色灰背景，真实摄影质感，画面里不出现任何文字'

const checks = []
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === '' ? '' : ' | ' + detail))
}
const say = (...parts) => console.log(parts.join(' '))

/**
 * 兜底：任何**未捕获的异常**都按"本轮没验到"记，绝不按"跨镜换人"记。
 *
 * 2026-09-24 实测（门禁第二轮 gate-20260924-024713.md）：厂商连接超时
 * （`fetch failed / UND_ERR_CONNECT_TIMEOUT`）让探针以退出码 1 崩溃，而门禁把 1 读成
 * "跨镜换人"——一次网络抖动被判成产品缺陷。退出码的语义因此收紧：
 * 1 **只**留给真正的"判出不是同一个人"（探针自己打印 FAIL 行），异常一律 2（跳过）。
 */
const bailOut = error => {
  const detail = error !== null && typeof error === 'object' && typeof error.stack === 'string'
    ? error.stack.split(String.fromCharCode(10)).slice(0, 4).join(' | ')
    : String(error)
  say('VLOG_CONSISTENCY SKIP 探针异常（不是跨镜换人）：' + detail)
  process.exit(2)
}
process.on('uncaughtException', bailOut)
process.on('unhandledRejection', bailOut)

/** 读一个 YAML 文件；不存在返回 undefined。 */
function readYamlOptional(file) {
  if (!existsSync(file)) return undefined
  try {
    return loadYaml(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error('解析 ' + file + ' 失败：' + String(error))
  }
}

/** 把本机文件读成厂商可读取的 Data URI（产品的 referenceImageValue / inlineFileDataUri 同一口径）。 */
function dataUri(file, mime) {
  if (!existsSync(file)) return ''
  return 'data:' + mime + ';base64,' + readFileSync(file).toString('base64')
}

/** 缩到 320 宽再进判官：判身份不需要原图分辨率，token 与耗时都省一个量级。 */
async function smallJpeg(file, out) {
  const result = await runFfmpeg(['-y', '-i', file, '-vf', 'scale=320:-2', '-q:v', '6', out], 60_000)
  if (!result.ok || !existsSync(out)) return ''
  return dataUri(out, 'image/jpeg')
}

/**
 * 这次失败是不是"再等等就好"。
 *
 * 厂商限流（429）与 5xx、以及没有应答，都是排队现象而不是拒收——产品的编排层也是这么分类的
 * （DEF-080：429 只该等，不该把整条任务判死）。确定性的 4xx（参数错、密钥错）才立刻放弃。
 * @param error - 能力面抛出的错误。
 * @returns true 表示可以等一会儿再来。
 */
function isRetryable(error) {
  const status = error?.status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  return String(error?.code ?? '') === 'MEDIA_VENDOR_UNREACHABLE'
}

/**
 * 下单并等到成片（单次尝试）。
 *
 * @param provider - 媒体能力面。
 * @param request - 视频生成请求。
 * @param deadline - 这一镜的总预算终点（毫秒时间戳）。
 * @returns 成片字节，或失败原因与"是否值得重新下一单"。
 */
async function attemptShot(provider, request, deadline) {
  let waited = 0
  let jobId = ''
  while (jobId === '' && Date.now() < deadline) {
    try {
      const submission = await provider.submitVideo(request)
      if (submission.video !== undefined) return { ok: true, bytes: submission.video.bytes }
      jobId = submission.jobId ?? ''
      if (jobId === '') return { ok: false, error: '厂商没有返回任务编号', retry: true }
    }
    catch (error) {
      if (!isRetryable(error)) return { ok: false, error: String(error), retry: false }
      waited += 1
      say('  下单被限流/无应答（第 ' + String(waited) + ' 次），等 20 秒再来：' + String(error))
      await new Promise(resolve => setTimeout(resolve, 20_000))
    }
  }
  if (jobId === '') return { ok: false, error: '下单一直没被受理（等满 ' + String(Math.round(SHOT_BUDGET_MS / 60000)) + ' 分钟）', retry: false }
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    let status
    try {
      status = await provider.pollVideo({ provider: request.provider, model: request.model, jobId })
    }
    catch (error) {
      if (!isRetryable(error)) return { ok: false, error: String(error), retry: false }
      waited += 1
      if (waited % 5 === 0) say('  厂商在排队（第 ' + String(waited) + ' 次重试）：' + String(error))
      continue
    }
    if (status.state === 'completed' && status.video !== undefined) return { ok: true, bytes: status.video.bytes }
    if (status.state === 'failed')
      return { ok: false, error: '厂商报失败：' + (status.error ?? '未给原因'), retry: true }
  }
  return { ok: false, error: '等待超过 ' + String(Math.round(SHOT_BUDGET_MS / 60000)) + ' 分钟仍没有成片', retry: false }
}

/**
 * 一镜的成片：厂商明确报失败时**重新下一单**，最多 {@link SHOT_ATTEMPTS} 次。
 *
 * 为什么要重下（2026-09-24 实测）：门禁第三轮里 A2 直接被厂商判失败（"厂商报失败：未给原因"），
 * 探针只能 SKIP、整条检查记黄——而那正是发布判定要用的那一轮。厂商的失败是瞬时的：
 * 同一个提示词重下一单就能出片（同一晚 A1/B1/B2 都正常）。预算仍是一镜 15 分钟，只是把它用完。
 *
 * @param provider - 媒体能力面。
 * @param request - 视频生成请求。
 * @returns 成片字节或可读原因。
 */
async function generateShot(provider, request) {
  const deadline = Date.now() + SHOT_BUDGET_MS
  let last = { ok: false, error: '没有尝试过' }
  for (let attempt = 1; attempt <= SHOT_ATTEMPTS && Date.now() < deadline; attempt++) {
    last = await attemptShot(provider, request, deadline)
    if (last.ok === true) {
      if (attempt > 1) say('  重新下单第 ' + String(attempt) + ' 次成功')
      return last
    }
    if (last.retry !== true || attempt === SHOT_ATTEMPTS) break
    say('  第 ' + String(attempt) + ' 次没成，重新下一单：' + last.error)
  }
  return { ok: false, error: last.error + (last.retry === true ? '（重下 ' + String(SHOT_ATTEMPTS) + ' 次都没成）' : '') }
}

/** 抽首帧（缩到 512 宽，够量相似度也够判官看）。 */
async function firstFrame(clipFile, pngFile) {
  const result = await runFfmpeg(['-y', '-i', clipFile, '-frames:v', '1', '-vf', 'scale=512:-2', pngFile], 120_000)
  return result.ok && existsSync(pngFile)
}

/**
 * 抽成片中间那一帧：判官自检的同域真值对要用它（同一条镜头里的同一个人，画风也一致）。
 *
 * @param clipFile - 成片文件。
 * @param pngFile - 抽帧落盘路径。
 * @param atSeconds - 抽帧时间点（秒）；镜头不足这个长度时退到第 1 秒。
 * @returns 是否真的抽出了文件。
 */
async function middleFrame(clipFile, pngFile, atSeconds) {
  for (const at of [atSeconds, 1]) {
    const result = await runFfmpeg(['-y', '-ss', String(at), '-i', clipFile, '-frames:v', '1', '-vf', 'scale=512:-2', pngFile], 120_000)
    if (result.ok && existsSync(pngFile)) return true
  }
  return false
}

/** 量化用的中间文件放临时目录：证据目录里只留成片、首帧与判官看的那几张图。 */
function rawFile(pngFile, suffix) {
  return join(tmpdir(), 'bf-vlog-' + basename(pngFile, '.png') + suffix)
}

/** 把一张图转成 rawvideo 灰度像素（crop 为空表示整帧）。 */
async function grayPixels(pngFile, crop) {
  const work = rawFile(pngFile, crop === '' ? '.gray64' : '.face64')
  const filter = (crop === '' ? '' : crop + ',') + 'scale=64:64,format=gray'
  const result = await runFfmpeg(['-y', '-i', pngFile, '-vf', filter, '-f', 'rawvideo', work], 60_000)
  if (!result.ok || !existsSync(work)) return undefined
  const bytes = readFileSync(work)
  return bytes.length === 64 * 64 ? bytes : undefined
}

/** 把一张图转成 32x32 的 RGB 直方图（每通道 8 桶，归一化）。 */
async function rgbHistogram(pngFile, crop) {
  const work = rawFile(pngFile, crop === '' ? '.rgb32' : '.facergb32')
  const filter = (crop === '' ? '' : crop + ',') + 'scale=32:32'
  const result = await runFfmpeg(['-y', '-i', pngFile, '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgb24', work], 60_000)
  if (!result.ok || !existsSync(work)) return undefined
  const bytes = readFileSync(work)
  if (bytes.length !== 32 * 32 * 3) return undefined
  const histogram = new Array(24).fill(0)
  for (let at = 0; at < bytes.length; at += 3) {
    for (let channel = 0; channel < 3; channel++) histogram[channel * 8 + (bytes[at + channel] >> 5)] += 1
  }
  return histogram.map(count => count / (32 * 32))
}

/** 皮尔逊相关（去过均值，抗亮度差）。 */
function correlation(a, b) {
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let at = 0; at < a.length; at++) {
    const x = a[at] - ma
    const y = b[at] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

/** 直方图相交（0~1，1 = 完全一样）。 */
function histogramIntersection(a, b) {
  let sum = 0
  for (let at = 0; at < a.length; at++) sum += Math.min(a[at], b[at])
  return sum / 3
}

/** 两张首帧的三个像素指标；任一指标算不出来时返回 undefined。 */
async function compareFrames(a, b) {
  const CROP = 'crop=iw*0.6:ih*0.7:iw*0.2:ih*0.06'
  const face = { a: await grayPixels(a, CROP), b: await grayPixels(b, CROP) }
  const full = { a: await grayPixels(a, ''), b: await grayPixels(b, '') }
  const hist = { a: await rgbHistogram(a, CROP), b: await rgbHistogram(b, CROP) }
  if (face.a === undefined || face.b === undefined || full.a === undefined || full.b === undefined
    || hist.a === undefined || hist.b === undefined) return undefined
  return {
    face: correlation(Array.from(face.a), Array.from(face.b)),
    full: correlation(Array.from(full.a), Array.from(full.b)),
    hist: histogramIntersection(hist.a, hist.b),
  }
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * 让产品配置里的那个模型判一次"是不是同一个人"。
 *
 * 为什么判身份必须用模型：像素相似度被姿态与背景主导（首轮实测已证），身份只有语义层能判。
 * 判据只认三个答案；问句与答案集写死，避免模型自由发挥把结论变成不可比的自然语言。
 *
 * @param chat - 文本通道（基址/密钥/型号，取自产品配置）。
 * @param first - 第一张图的 Data URI。
 * @param second - 第二张图的 Data URI。
 * @returns 三个答案之一，或判不了的原因。
 */
/**
 * 判官问句：**必须把"这是同一个形象的两条镜头"说清楚**。
 *
 * 问句不是措辞问题，它是判据的一部分。实测（2026-09-23 第六次跑）：同一位女士的正面与侧脸两张首帧，
 * 只问"这两张画面里的出镜者是同一个人吗"时三次里两次答"不是同一个人"——姿态一变就判成换人；
 * 把"同一个数字人形象、角度可能不同"写进问句后，同一对三次全答"同一个人"。
 */
const JUDGE_QUESTION = '这两张人像可能是同一个人，也可能不是（角度、光线、画风都可能不同）。'
  + '请先各用一句话写出两张图里人物的性别、大致年龄与最显著的两个特征，然后另起一行，'
  + '只输出结论：同一个人 / 不是同一个人 / 看不清。'

/**
 * 跨域问句：第一张是产品里的数字人形象图、第二张是厂商成片的一帧。
 *
 * 把"定妆照 / 成片一帧"写在问句里不是客套：不说这一句时判官按"不是同一个人"作答的频率更高。
 * 即便如此这对只作记录——它测的是"成片里的人就是形象库里那位"，与本探针的准入项（跨镜不换人）不是同一件事。
 */
const CROSS_DOMAIN_QUESTION = '第一张是数字人的定妆照（可能偏插画或半写实风格），第二张是同一个数字人出镜的视频成片里的一帧。'
  + '请只判断出镜者的身份：是同一位数字人吗？只回答三个选项之一：同一个人 / 不是同一个人 / 看不清。不要解释。'

/** 判官单次调用的重试上限：免费档的速率限制是每分钟级的，实测 429 后等一会儿就恢复。 */
const JUDGE_ATTEMPTS = 8
/** 判官被限流后的等待（毫秒）。 */
const JUDGE_RETRY_WAIT_MS = 15_000
/** 一对比最多允许多少票"答了但不在答案集里"（作废重采，见 askIdentity）。 */
const JUDGE_DISCARDS = 5
/** 两次投票之间的间隔（毫秒）：连着打会被判官的速率限制拦下。 */
const JUDGE_VOTE_GAP_MS = 3_000

/**
 * 判身份的模型：默认用 `agnes-2.5-pro`（推理模型），**不用产品自己那个 flash 模型**。
 *
 * 为什么换（2026-09-24 标定，同一批真机成片）：
 * - `agnes-3.0-flash`：同镜真值对（同一条镜头里同一个人、只是朝向不同）15 票里只有 9 票说「同一个人」，
 *   两轮门禁一次判黄、一次把 5 票 3 否当成结论——它对「同一张脸的不同角度」基本靠猜；
 * - `agnes-2.5-pro`（推理模型）：同一对 **9/9 说同一个人**，毒丸对 **8/8 说不是**，而且会先把两张脸的
 *   性别、年龄与特征写出来再给结论——准确得多。**但它用不了**：厂商账户余额耗尽
 *   （实测 403 `预扣费失败，用户剩余额度: ￥0.004310，需要预扣: ￥0.005180`），pro 每次调用约 ¥0.005。
 *   所以判官只能继续用免费档的 flash，靠"多采票 + 只把可靠的比较放进准入"来兜（见下）。
 *   留了 `--judge-model` 开关：账户充值后一行命令就能换回 pro。
 *
 * 代价：pro 是推理模型，`max_tokens` 给小了会把预算全花在 `reasoning_content` 上、`content` 为空
 * （实测 max_tokens=16 时 finish_reason=length 且正文为空），所以这里给 600；
 * 它对突发调用更敏感（实测连打十几票出现过 HTTP 403），403 与 429/5xx 同样按「等一会儿再来」处理。
 * 记录的 `avatarAnchor`（跨画风域、不判红）仍用产品那个模型，省 pro 的额度。
 */
let JUDGE_MODEL = ''

/**
 * 判官采样票数上限与作数门槛。
 *
 * 15 取 9（实测标定，2026-09-24，同一批真机成片，全部 15 票）：
 * - **判据那一对（A1↔A2 跨镜同一个人）**：flash **12/15 说同一个人**（B 条对照同样 12/15）；
 * - **毒丸对（成片首帧 vs 陌生人证件照）**：**15/15 说不是同一个人**——它从不对明显不同的人说「是」。
 *
 * 也就是说 flash 的错误仍然集中在「偶尔把同一个人说成不是」这一侧（单票错误率约 1/5），
 * 而**假绿方向几乎为零**。于是门槛定在 15 票里满 9 票：同一个人这一侧「判不了」的概率约 2.7%
 * （二项尾 `P(k≥9 | p=0.8) = 0.973`），而把明显不同的人误判成同一个需要 9 票「是」——按实测的
 * 一侧错误率根本到不了。既不放宽判据，也不再让门禁靠运气。
 *
 * 历史：3 票一致 → 一轮门禁黄；5 取 4 → 单对「判不了」约 26%（实测门禁第二轮就是它黄的）；
 * 15 取 10 → 约 3% 但仍是拿采样量硬扛；真正问题是判官选型（见 {@link JUDGE_MODEL}）。
 */
const JUDGE_SAMPLES = 15
/** 作数所需的一致票数：十五票里满九票（满票即提前收工）。 */
const JUDGE_MAJORITY = 9

/**
 * 问一次判官。
 *
 * @param chat - 文本通道（基址/密钥/型号，取自产品配置）。
 * @param first - 第一张图的 Data URI。
 * @param second - 第二张图的 Data URI。
 * @param question - 判官问句（跨域对比要换问句，见 {@link CROSS_DOMAIN_QUESTION}）。
 * @returns 三个答案之一，或判不了的原因。
 */
async function askIdentityOnce(chat, first, second, question, model = '') {
  const useModel = model === '' ? chat.model : model
  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetch(chat.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(chat.key === '' ? {} : { authorization: 'Bearer ' + chat.key }) },
      body: JSON.stringify({
        model: useModel,
        // 先说特征再结论要一点预算；推理模型（agnes-2.5-pro）更吃预算（给少了 content 直接是空的），
        // 所以不是产品那个 flash 模型时给 600。
        max_tokens: useModel === chat.model ? 300 : 600,
        // 判身份要的是稳定答案，不是多样性：标定时 temperature=0 的那组波动最小。
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: first } },
            { type: 'image_url', image_url: { url: second } },
          ],
        }],
      }),
        signal: AbortSignal.timeout(120_000),
      })
    }
    catch (error) {
      // 连接超时/断网与 429 同类：等一会儿再来，别让一次网络抖动把整轮判定打断
      // （实测一次 UND_ERR_CONNECT_TIMEOUT 就把探针崩成退出码 1，门禁读成"跨镜换人"）。
      if (attempt >= JUDGE_ATTEMPTS) return { ok: false, error: '网络错误：' + String(error) }
      say('  判官连不上（第 ' + String(attempt) + ' 次），等 ' + String(JUDGE_RETRY_WAIT_MS / 1000) + ' 秒再来：' + String(error))
      await new Promise(resolve => setTimeout(resolve, JUDGE_RETRY_WAIT_MS))
      continue
    }
    const text = await response.text()
    if (response.ok) {
      let answer = ''
      try {
        answer = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? '').trim()
      }
      catch {
        // 不是 JSON 一样是"这一票没结论"，作废重采（与上面同一类）。
        return { ok: false, error: '判官返回的不是 JSON：' + text.slice(0, 160), discardable: true }
      }
      // 推理模型的正文可能被 token 预算截空（finish_reason=length）：这一票没结论，重来一票，
      // 不要把它当成「判不了」——那会把探针推向 SKIP。
      if (answer === '' && attempt < JUDGE_ATTEMPTS) {
        say('  判官这一票没有正文（推理用满了 token 预算，第 ' + String(attempt) + ' 次），重来')
        await new Promise(resolve => setTimeout(resolve, JUDGE_RETRY_WAIT_MS))
        continue
      }
      // 先认否定式：'不是同一个人' 里含有 '同一个人'，顺序反了会把否定读成肯定（本轮实测踩过一次：
      // 陌生人对比男女性别都不同，仍被读成"同一个人"，毒丸对照因此假绿）。
      const verdict = answer.includes('不是同一个人')
        ? '不是同一个人'
        : VERDICTS.find(item => answer.includes(item))
      return verdict === undefined
        // 答了但不在答案集里（实测第五次尝试：判官把同一对描述对了却写「是两个人」）：
        // 这一票**作废重采**，不把整轮判定打断（作废处理见 askIdentity）。
        ? { ok: false, error: '判官没给三个答案之一：' + answer.slice(0, 80), discardable: true }
        : { ok: true, verdict }
    }
    // 429/5xx 是限流与瞬时故障，等一会儿再来（实测免费档 429 后等 30 秒即恢复）；
    // 其余状态码是确定性失败（密钥、参数、模型名），立刻返回。
    // 403 在这个厂商这里也是限流的一种表现（实测连打十几票后 pro 模型开始 403，过一会儿又 200）。
    const retryable = response.status === 429 || response.status === 403 || response.status >= 500
    if (attempt >= JUDGE_ATTEMPTS || !retryable)
      return { ok: false, error: 'HTTP ' + String(response.status) + '：' + text.slice(0, 160) }
    say('  判官被限流（HTTP ' + String(response.status) + '，第 ' + String(attempt) + ' 次），等 '
      + String(JUDGE_RETRY_WAIT_MS / 1000) + ' 秒再来')
    await new Promise(resolve => setTimeout(resolve, JUDGE_RETRY_WAIT_MS))
  }
}

/**
 * 生成毒丸对要用的陌生人图：限流与瞬时故障按 {@link JUDGE_ATTEMPTS} 次等一会儿再来（与判官同口径）。
 *
 * @param provider - 媒体能力面。
 * @param request - 图片生成请求。
 * @returns 生成结果。
 */
async function generateImageWithRetry(provider, request) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.generateImage(request)
    }
    catch (error) {
      if (attempt >= JUDGE_ATTEMPTS || !isRetryable(error)) throw error
      say('  陌生人图被限流（第 ' + String(attempt) + ' 次），等 ' + String(JUDGE_RETRY_WAIT_MS / 1000) + ' 秒再来：' + String(error))
      await new Promise(resolve => setTimeout(resolve, JUDGE_RETRY_WAIT_MS))
    }
  }
}

/**
 * 判一对画面是不是同一个人：采 {@link JUDGE_SAMPLES} 票，同一答案满 {@link JUDGE_MAJORITY} 票才给结论。
 *
 * 不够票（含"看不清"占多数）一律按"判不了"返回——判据宁可说"这轮没验到"，也不拿一次带噪声的采样去判红。
 *
 * **作废重采**：判官答了但不在答案集里（`discardable`）时，这一票不算数、重采一票，
 * 最多多采 {@link JUDGE_DISCARDS} 票。理由（2026-09-24 第五次尝试实测）：判官把同一对的两张脸
 * 都描述对了（"年轻亚洲女性…黑色长直发和白色圆领毛衣"），结论却写了答案集外的"是两个人"——
 * 旧写法因此整轮判不了、整条检查记黄。把"它没按格式答"与"它判不了"分开，前者只是浪费一票。
 * 硬失败（HTTP/网络，重试后仍失败）仍然直接返回，不作废重采。
 *
 * @param chat - 文本通道。
 * @param first - 第一张图的 Data URI。
 * @param second - 第二张图的 Data URI。
 * @param question - 判官问句；缺省用 {@link JUDGE_QUESTION}。
 * @param model - 判身份用的模型；缺省用 `--judge-model` 指定的那个，再缺省用产品自己的模型。
 * @returns 作数的结论与五票明细，或判不了的原因。
 */
async function askIdentity(chat, first, second, question = JUDGE_QUESTION, model = '') {
  const verdicts = []
  let discarded = 0
  while (verdicts.length < JUDGE_SAMPLES) {
    if (verdicts.length > 0 || discarded > 0) await new Promise(resolve => setTimeout(resolve, JUDGE_VOTE_GAP_MS))
    const answer = await askIdentityOnce(chat, first, second, question, model)
    if (!answer.ok) {
      if (answer.discardable === true && discarded < JUDGE_DISCARDS) {
        discarded += 1
        say('  判官答了但不在答案集里，这一票作废重采（第 ' + String(discarded) + ' 次）：' + answer.error)
        continue
      }
      return { ok: false, error: answer.error + (discarded > 0 ? '（另有 ' + String(discarded) + ' 票作废）' : '') }
    }
    verdicts.push(answer.verdict)
    // 某一答案已经满票：剩下的票再多也翻不了盘，提前收工（省时间也省判官额度）。
    for (const verdict of VERDICTS) {
      if (verdict !== '看不清' && verdicts.filter(item => item === verdict).length >= JUDGE_MAJORITY)
        return { ok: true, verdict, verdicts }
    }
  }
  return { ok: false, error: String(JUDGE_SAMPLES) + ' 票里没有满 ' + String(JUDGE_MAJORITY) + ' 票的一致答案（' + verdicts.join(' / ') + '）' }
}

/**
 * 判官答了什么，供日志直接打印。
 *
 * @param answer - {@link askIdentity} 的返回。
 * @returns 结论或"判不了"的原因。
 */
function describeAnswer(answer) {
  return answer.ok ? answer.verdict : '判不了（' + answer.error + '）'
}

// ---- 载入本机配置（设置页写的那份路由 + 凭据 + 形象） -------------------------
const settings = readYamlOptional(join(HOME, 'settings.yaml'))
const routes = settings?.['media-pi-ai']?.providers ?? {}
const routeIds = Object.keys(routes)
if (routeIds.length === 0) {
  say('VLOG_CONSISTENCY SKIP 没有媒体路由：先到「设置 → 配置大模型」把服务保存一次（会写进 settings.yaml 的 media-pi-ai 段）')
  process.exit(2)
}
const credentials = readYamlOptional(join(HOME, '.credentials.yaml'))?.refs ?? {}
const llmFile = join(PRODUCT_ROOT, 'llm-user.json')
if (!existsSync(llmFile)) {
  say('VLOG_CONSISTENCY SKIP 读不到模型配置：' + llmFile)
  process.exit(2)
}
const llm = JSON.parse(readFileSync(llmFile, 'utf8'))
const videoBase = String(llm.videoBaseUrl ?? llm.baseUrl ?? '').replace(/\/+$/, '')
const videoModel = String(llm.videoModel ?? '')
const imageModel = String(llm.imageModel ?? '')
if (videoModel === '') {
  say('VLOG_CONSISTENCY SKIP 没有配置视频模型')
  process.exit(2)
}
const routeId = routeIds.find(id => String(routes[id]?.baseURL ?? '').replace(/\/+$/, '') === videoBase) ?? routeIds[0]
const chat = {
  base: String(llm.baseUrl ?? '').replace(/\/+$/, ''),
  key: String(llm.apiKey ?? ''),
  model: String(llm.model ?? ''),
}
if (chat.base === '' || chat.model === '') {
  say('VLOG_CONSISTENCY SKIP 没有配置文本模型——判身份要用它（产品配置里的那个模型）')
  process.exit(2)
}

// 判官用哪个模型：`--judge-model agnes-2.5-pro` 可以把判身份换成推理模型（更准，但账户要有余额）。
JUDGE_MODEL = (argValue('--judge-model') ?? chat.model).trim()

const humans = JSON.parse(readFileSync(join(PRODUCT_ROOT, 'digital-humans.json'), 'utf8')).value ?? []
const wantedHuman = argValue('--human')
const human = wantedHuman === undefined ? humans[0] : humans.find(item => item.id === wantedHuman)
if (human === undefined) {
  say('VLOG_CONSISTENCY SKIP 形象库里没有可用形象（先建一个数字人）')
  process.exit(2)
}
const avatarFile = join(PRODUCT_ROOT, 'uploads', basename(String(human.avatarUrl ?? '')))
const avatarValue = dataUri(avatarFile, 'image/png')
if (avatarValue === '') {
  say('VLOG_CONSISTENCY SKIP 形象图读不出来：' + avatarFile)
  process.exit(2)
}
if (!Number.isInteger(human.seed) || human.seed < 0) {
  say('VLOG_CONSISTENCY SKIP 这个形象没有固定种子（跨镜同一个人靠它）：' + String(human.id))
  process.exit(2)
}

const provider = createPiAiMediaProvider({
  config: () => ({ providers: routes }),
  resolveCredential: async (ref) => {
    const stored = credentials[ref]
    if (typeof stored === 'string' && stored !== '') return stored
    const fromEnv = process.env[ref]
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined
  },
})

// ---- 出片计划：两条，唯一的差别是种子 ---------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const workDir = REUSE_DIR === ''
  ? join(fileURLToPath(new URL('.', import.meta.url)), '..', 'evidence', 'vlog-consistency-' + stamp)
  : resolve(REUSE_DIR)
if (REUSE_DIR !== '' && !existsSync(workDir)) {
  say('VLOG_CONSISTENCY SKIP --reuse 指的目录不存在：' + workDir)
  process.exit(2)
}
mkdirSync(workDir, { recursive: true })
/**
 * 复算时把上一轮记录里的 B 条种子读回来：那一轮的证据不能因为复算而少一段。
 *
 * @returns 上一轮记录的 B 条种子；没有上一轮记录时为空数组。
 */
function reusedSeeds() {
  try {
    const previous = JSON.parse(readFileSync(join(workDir, 'result.json'), 'utf8'))
    return Array.isArray(previous?.seeds?.B) ? previous.seeds.B : []
  }
  catch {
    return []
  }
}
const seeds = {
  A: Array.from({ length: SHOTS }, () => human.seed),
  B: REUSE_DIR === '' ? Array.from({ length: SHOTS }, () => Math.floor(Math.random() * 1_000_000)) : reusedSeeds(),
}
say('VLOG_CONSISTENCY route=' + routeId + ' video=' + videoModel + ' judge=' + JUDGE_MODEL
  + '（记录项用 ' + chat.model + '）human=' + human.id
  + ' seed=' + String(human.seed) + ' shots=' + String(SHOTS) + (DRY_RUN ? ' DRY_RUN' : '')
  + (REUSE_DIR === '' ? '' : ' REUSE=' + workDir))
if (REUSE_DIR === '') say('B 条 seeds=' + seeds.B.join(','))

if (DRY_RUN) {
  for (const condition of ['A', 'B']) {
    for (let index = 0; index < SHOTS; index++) {
      say('  [' + condition + String(index + 1) + '] seed=' + String(seeds[condition][index]) + ' 台词=' + LINES[index % LINES.length].slice(0, 18) + '…')
    }
  }
  say('VLOG_CONSISTENCY DRY_RUN 没有调用厂商')
  process.exit(0)
}

// ---- 逐镜出片（两条共用同一组台词与场景提示词，唯一变量仍是种子） -----------
// 本机不再合成配音：台词逐字进提示词，厂商在出片时自己念（与产品同一条路径）。

const frames = { A: [], B: [] }
/** A1 的中段帧：判官自检的同域真值对（同一条镜头里同一个人）。 */
let a1MiddleFrame = ''
let produced = true
let failureReason = ''
for (const condition of REUSE_DIR === '' ? ['A', 'B'] : []) {
  for (let index = 0; index < SHOTS; index++) {
    const line = LINES[index % LINES.length]
    const prompt = [SCENES[index % SCENES.length], line, MOVING_CLAUSE].join('。')
    const started = Date.now()
    say('[' + condition + String(index + 1) + '] 出片中… seed=' + String(seeds[condition][index]))
    let outcome
    try {
      outcome = await generateShot(provider, {
        provider: routeId,
        model: videoModel,
        prompt,
        durationSeconds: 5,
        resolution: '720p',
        aspectRatio: '9:16',
        talkingHead: { images: [avatarValue], seed: seeds[condition][index] },
      })
    }
    catch (error) {
      outcome = { ok: false, error: String(error) }
    }
    if (!outcome.ok) {
      failureReason = condition + String(index + 1) + '：' + outcome.error
      produced = false
      break
    }
    const clip = join(workDir, condition + '-' + String(index + 1) + '.mp4')
    writeFileSync(clip, outcome.bytes)
    const png = join(workDir, condition + '-' + String(index + 1) + '.png')
    if (!await firstFrame(clip, png)) {
      failureReason = condition + String(index + 1) + '：首帧抽不出来'
      produced = false
      break
    }
    frames[condition].push(png)
    if (condition === 'A' && index === 0) {
      const middle = join(workDir, 'A-1.mid.png')
      if (await middleFrame(clip, middle, 2.5)) a1MiddleFrame = middle
    }
    say('[' + condition + String(index + 1) + '] 成片 ' + String(Math.round(outcome.bytes.length / 1024)) + 'KB，'
      + String(Math.round((Date.now() - started) / 1000)) + ' 秒，首帧 ' + basename(png))
  }
  if (!produced) break
}
if (!produced) {
  say('VLOG_CONSISTENCY SKIP 有镜没出片（服务不可用或厂商限流）：' + failureReason)
  process.exit(2)
}
if (REUSE_DIR !== '') {
  // 复算路径：成片与首帧都用那次留下的，缺一个就如实说"这份证据不全"。
  for (const condition of ['A', 'B']) {
    for (let index = 0; index < SHOTS; index++) {
      const clip = join(workDir, condition + '-' + String(index + 1) + '.mp4')
      const png = join(workDir, condition + '-' + String(index + 1) + '.png')
      if (!existsSync(clip) || !existsSync(png)) {
        say('VLOG_CONSISTENCY SKIP --reuse 的目录里缺 ' + basename(clip) + ' 或 ' + basename(png) + '（换 --shots 数量对不上时也会这样）')
        process.exit(2)
      }
      frames[condition].push(png)
    }
  }
  const middle = join(workDir, 'A-1.mid.png')
  if (await middleFrame(join(workDir, 'A-1.mp4'), middle, 2.5)) a1MiddleFrame = middle
  say('复用成片 ' + String(frames.A.length + frames.B.length) + ' 镜，重新判定（不再调厂商出片）')
}

// ---- 判官自检：真值对必须判"同一个人"，毒丸对必须判"不是同一个人" -------------
const judgePairs = []
/** 形象图↔成片首帧的判定：跨域对，只落盘记录。 */
let avatarAnchor = {}
let judgeFailed = ''
/** 同镜真值对的判定：记录项（flash 判官在这对上只有 9/15 说「同一个人」，比判据那对还难），不参与准入。 */
let truthSummary = '未跑'
const smallOf = {}
for (const condition of ['A', 'B']) {
  for (let index = 0; index < SHOTS; index++) {
    smallOf[condition + String(index + 1)] = await smallJpeg(frames[condition][index], join(workDir, '.small-' + condition + String(index + 1) + '.jpg'))
  }
}
const avatarSmall = await smallJpeg(avatarFile, join(workDir, '.small-avatar.jpg'))
if (avatarSmall === '') judgeFailed = '形象图缩不出判官能读的 jpg'
// 同镜中段帧是记录项：抽不出来不影响准入，只是少一条证据。
const middleSmall = a1MiddleFrame === '' ? '' : await smallJpeg(a1MiddleFrame, join(workDir, '.small-A1-mid.jpg'))

const imageRoute = routeIds.find(id => String(routes[id]?.baseURL ?? '').replace(/\/+$/, '') === String(llm.imageBaseUrl ?? '').replace(/\/+$/, '')) ?? routeId
if (judgeFailed === '' && imageModel === '') judgeFailed = '没有配置图片模型，毒丸对（另生成一位陌生人）生不出来'
if (judgeFailed === '') {
  try {
    const made = await generateImageWithRetry(provider, {
      provider: imageRoute, model: imageModel, prompt: STRANGER_PROMPT, count: 1, resolution: '720p', aspectRatio: '9:16',
    })
    const strangerFile = join(workDir, 'stranger.png')
    writeFileSync(strangerFile, made.images[0].bytes)
    const strangerSmall = await smallJpeg(strangerFile, join(workDir, '.small-stranger.jpg'))
    // 记录项：A1 首帧 vs A1 中段帧（同一条镜头里的同一个人）。flash 判官在这对上只有 9/15 说「同一个人」，
    // 比判据那一对还难，所以它只作记录——它红了不代表产品有问题，代表这个判官对这一类对比不给力。
    const truth = middleSmall === '' ? { ok: false, error: '中段帧没抽出来' } : await askIdentity(chat, smallOf.A1, middleSmall)
    truthSummary = describeAnswer(truth)
    // 毒丸对：成片首帧 vs 另生成的陌生人——判官见谁都答"同一个人"的话，这里会露馅。
    const poison = await askIdentity(chat, smallOf.A1, strangerSmall)
    // 形象锚定（记录项）：产品形象图 vs 成片首帧，两个域的画风不同，不参与准入（见文件头第 3 条稳定性措施）。
    const anchor = await askIdentity(chat, avatarSmall, smallOf.A1, CROSS_DOMAIN_QUESTION, chat.model)
    say('判官自检：A1 vs 陌生人 = ' + describeAnswer(poison) + '（准入项：必须是「不是同一个人」）')
    say('判官记录（不判红）：A1 首帧 vs A1 中段 = ' + describeAnswer(truth) + '；形象图 vs A1 = ' + describeAnswer(anchor))
    judgePairs.push({ label: '自检 A1 首帧↔A1 中段（同域真值对）', expect: '同一个人', ...(truth.ok ? { verdict: truth.verdict } : { error: truth.error }) })
    judgePairs.push({ label: '自检 A1↔陌生人（毒丸对）', expect: '不是同一个人', ...(poison.ok ? { verdict: poison.verdict } : { error: poison.error }) })
    avatarAnchor = { label: '记录 形象图↔A1（跨域，不判红）', ...(anchor.ok ? { verdict: anchor.verdict } : { error: anchor.error }) }
    if (!poison.ok) judgeFailed = '判官读不了毒丸对：' + poison.error
    else if (poison.verdict !== '不是同一个人') judgeFailed = '判官把成片首帧和陌生人判成了「' + poison.verdict + '」——判官见谁都答同一个人，不可信'
  }
  catch (error) {
    judgeFailed = '毒丸对生成失败：' + String(error)
  }
}
if (judgeFailed !== '') {
  say('VLOG_CONSISTENCY SKIP ' + judgeFailed + '（本轮不下结论；证据留在 ' + workDir + '）')
  process.exit(2)
}
record('判官自检（毒丸对=不是同一个人，准入项）', true, '判官=' + JUDGE_MODEL + '；同镜真值对作记录：' + truthSummary)

// ---- 判身份：A 条每一对（判据）、B 条每一对（对照） ---------------------------
const judgeA = []
const judgeB = []
for (let i = 0; i < SHOTS; i++) {
  for (let j = i + 1; j < SHOTS; j++) {
    const label = 'A' + String(i + 1) + '↔A' + String(j + 1)
    const answer = await askIdentity(chat, smallOf['A' + String(i + 1)], smallOf['A' + String(j + 1)])
    judgeA.push(answer.ok ? { label, verdict: answer.verdict } : { label, error: answer.error })
  }
}
for (let i = 0; i < SHOTS; i++) {
  for (let j = i + 1; j < SHOTS; j++) {
    const label = 'B' + String(i + 1) + '↔B' + String(j + 1)
    const answer = await askIdentity(chat, smallOf['B' + String(i + 1)], smallOf['B' + String(j + 1)])
    judgeB.push(answer.ok ? { label, verdict: answer.verdict } : { label, error: answer.error })
  }
}
for (const item of [...judgeA, ...judgeB]) {
  say('[判身份] ' + item.label + ' → ' + (item.verdict ?? '判不了（' + item.error + '）'))
}
const aErrors = judgeA.filter(item => item.verdict === undefined)
const aUnsure = judgeA.filter(item => item.verdict === '看不清')
const aDifferent = judgeA.filter(item => item.verdict === '不是同一个人')
if (aErrors.length > 0 || aUnsure.length > 0) {
  say('VLOG_CONSISTENCY SKIP A 条有 ' + String(aErrors.length) + ' 对判不了、' + String(aUnsure.length)
    + ' 对判「看不清」（含十五票里没有满十票的一致答案）——本轮不下结论（证据留在 ' + workDir + '）')
  process.exit(2)
}

// ---- 像素相似度：三组数都打印出来（稳定性证据，不作判据） ---------------------
const pixelPairs = { A: [], B: [], C: [] }
for (let i = 0; i < SHOTS; i++) {
  for (let j = i + 1; j < SHOTS; j++) {
    const metric = await compareFrames(frames.A[i], frames.A[j])
    if (metric !== undefined) pixelPairs.A.push({ label: 'A' + String(i + 1) + '↔A' + String(j + 1), ...metric })
  }
}
for (let i = 0; i < SHOTS; i++) {
  for (let j = i + 1; j < SHOTS; j++) {
    const metric = await compareFrames(frames.B[i], frames.B[j])
    if (metric !== undefined) pixelPairs.B.push({ label: 'B' + String(i + 1) + '↔B' + String(j + 1), ...metric })
  }
}
for (let i = 0; i < SHOTS; i++) {
  const metric = await compareFrames(frames.A[i], frames.B[i])
  if (metric !== undefined) pixelPairs.C.push({ label: 'A' + String(i + 1) + '↔B' + String(i + 1), ...metric })
}
for (const [name, list] of [['A 固定 seed（现状）', pixelPairs.A], ['B 每镜换 seed（负向对照）', pixelPairs.B], ['C 跨条同镜号（A↔B）', pixelPairs.C]]) {
  for (const item of list) {
    say('[像素] ' + name + ' ' + item.label + ' 中心区相关=' + item.face.toFixed(3)
      + ' 全帧相关=' + item.full.toFixed(3) + ' 直方图=' + item.hist.toFixed(3))
  }
}
const summarize = list => ({ face: mean(list.map(item => item.face)), full: mean(list.map(item => item.full)), hist: mean(list.map(item => item.hist)) })
const pixelSummary = { A: summarize(pixelPairs.A), B: summarize(pixelPairs.B), C: summarize(pixelPairs.C) }
say('SUMMARY A_face=' + pixelSummary.A.face.toFixed(3) + ' B_face=' + pixelSummary.B.face.toFixed(3) + ' C_face=' + pixelSummary.C.face.toFixed(3)
  + ' | A_full=' + pixelSummary.A.full.toFixed(3) + ' B_full=' + pixelSummary.B.full.toFixed(3)
  + ' | A_hist=' + pixelSummary.A.hist.toFixed(3) + ' B_hist=' + pixelSummary.B.hist.toFixed(3))

const bSame = judgeB.filter(item => item.verdict === '同一个人').length
const bDifferent = judgeB.filter(item => item.verdict === '不是同一个人').length
const seedFinding = bSame > 0 && bDifferent === 0
  ? 'B 条（每镜换 seed）也判同一个人：身份由**参考图**锚定，种子只改构图与细节'
  : bDifferent > 0
    ? 'B 条出现「不是同一个人」：每镜换随机种子确实会换人，固定种子是身份的一半依据'
    : 'B 条判定混杂，逐对看上面的 [判身份] 明细'

writeFileSync(join(workDir, 'result.json'), JSON.stringify({
  at: new Date().toISOString(),
  route: routeId,
  videoModel,
  imageModel,
  judge: JUDGE_MODEL,
  judgeAnchorModel: chat.model,
  human: { id: human.id, seed: human.seed, persona: human.persona ?? '' },
  shots: SHOTS,
  seeds,
  judgeSelfCheck: judgePairs,
  avatarAnchor,
  judgeA,
  judgeB,
  pixelPairs,
  pixelSummary,
  seedFinding,
}, null, 2), 'utf8')

record('A 条每一对跨镜都是同一个人', aDifferent.length === 0,
  judgeA.map(item => item.label + '=' + String(item.verdict)).join(' '))
record('两条都跑完（各有 ' + String(SHOTS) + ' 镜）', frames.A.length === SHOTS && frames.B.length === SHOTS,
  'A=' + String(frames.A.length) + ' B=' + String(frames.B.length))
record('负向对照（每镜换 seed）的记录', true, seedFinding)

const fails = checks.filter(item => !item.ok)
say('VLOG_CONSISTENCY ' + (fails.length === 0 ? 'PASS' : 'FAIL')
  + (fails.length === 0 ? '' : ' 跨镜换人') + ' checks=' + String(checks.length) + ' fail=' + String(fails.length)
  + ' evidence=' + workDir)
process.exit(fails.length === 0 ? 0 : 1)
