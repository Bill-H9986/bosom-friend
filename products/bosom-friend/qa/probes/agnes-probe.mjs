/**
 * Agnes 能力边界探针（P0，第五发）：纯提示词驱动的 reference 模式口播，并回答
 * "一张参考图 + 固定种子能不能让同一个人出镜说话"。
 *
 * 第四发用的本机 TTS 音频已经被产品删除：声音现在由厂商在出片时按**提示词里那句台词**自己念
 * （Agnes 原生声音，见 server/src/api.ts 的 digitalHumanProducer），产品也不再往 audios 里塞音频。
 * 所以这一发把台词逐字写进 prompt、只带一张参考图与固定种子——与产品当前发出的请求同形。
 *
 * 用法：node products/bosom-friend/qa/probes/agnes-probe.mjs
 * 环境：AGNES_API_KEY（必填）；结果落盘到 .dsh-build/agnes-probe/results-5.json
 * @module qa/probes/agnes-probe
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'C:/Users/Jay/Desktop/Bosom friend APP'
const BASE = 'https://api.agnes-ai.cn/v1'
const OUT = join(ROOT, '.dsh-build/agnes-probe')
const IMAGE_MODEL = 'agnes-image-2.1-flash'
const VIDEO_MODEL = 'agnes-video-2.5-flash'
const apiKey = (process.env.AGNES_API_KEY ?? '').trim()
if (apiKey === '') { console.error('缺少 AGNES_API_KEY'); process.exit(2) }
mkdirSync(OUT, { recursive: true })

const results = []
const record = (test, data) => { results.push({ test, ...data }); console.log('\n=== ' + test + ' ===\n' + JSON.stringify(data, null, 2)) }
const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }
const LINE = '这款面霜我自己用了三个月，干皮救急真的顶用，今天直播间直降一百。'
/** 与产品同一条要求：厂商不知道哪句是要说的话，不写进提示词就出无声画面。 */
const SPEECH_CLAUSE = '请让画面里的人用自然的口语说出下面这句话，语速平实、像真人在讲解，不要播音腔；这句话是：' + LINE

async function post(url, body, timeoutMs = 240000) {
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    return { status: resp.status, body: (await resp.text()).slice(0, 3000) }
  }
  catch (error) { return { status: -1, body: String(error).slice(0, 400) } }
}
const pickUrl = (text) => { try { return JSON.parse(text)?.data?.[0]?.url ?? '' } catch { return '' } }

// ---- 1. 参考图（形象图这一侧仍然是"这个人是谁"的锚） --------------------------
const person = '一位 28 岁中国女性带货主播，鹅蛋脸，黑色中长发披肩，穿米白色针织衫，米色墙面背景，柔和暖光，真实摄影质感，竖屏构图'
const front = await post(BASE + '/images/generations', { model: IMAGE_MODEL, n: 1, size: '1080x1920', prompt: person + '，正面半身，正对镜头，自然微笑' })
const frontUrl = pickUrl(front.body)
record('anchor', { frontUrl })

// ---- 2. reference 模式口播：一张参考图 + 固定种子 + 台词在提示词里 -------------
if (frontUrl !== '') {
  const created = await post(BASE + '/videos', {
    model: VIDEO_MODEL,
    prompt: SPEECH_CLAUSE,
    seconds: '5',
    size: '720P',
    aspect_ratio: '9:16',
    mode: 'reference',
    images: [frontUrl],
    seed: 20260916,
  })
  const videoId = (() => { try { return JSON.parse(created.body)?.video_id ?? '' } catch { return '' } })()
  record('video.reference.created', { ...created, videoId })
  if (videoId !== '') writeFileSync(join(OUT, 'video-task.txt'), videoId + '\n' + VIDEO_MODEL, 'utf8')
}

writeFileSync(join(OUT, 'results-5.json'), JSON.stringify(results, null, 2), 'utf8')
console.log('\n结果已落盘：' + join(OUT, 'results-5.json'))
