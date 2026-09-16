/**
 * Agnes 能力边界探针（P0，第四发）：用真实 TTS 音频 + 两张参考图跑通 reference 模式口播，
 * 并回答"多参考图能否锁住同一个人"。
 *
 * 第三发用图片 URL 冒充音频被厂商拒绝（invalid_media），说明 audios 字段会被真正解析——
 * 这里换成 msedge-tts 真实合成的 mp3（内联为 data URI，与产品长视频链路同一做法）。
 *
 * 用法：node probe-agnes-capabilities-4.mjs
 * @module qa/probes/probe-agnes-capabilities
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

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

async function post(url, body, timeoutMs = 240000) {
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    return { status: resp.status, body: (await resp.text()).slice(0, 3000) }
  }
  catch (error) { return { status: -1, body: String(error).slice(0, 400) } }
}
const pickUrl = (text) => { try { return JSON.parse(text)?.data?.[0]?.url ?? '' } catch { return '' } }

// ---- 1. 真实配音（产品同一条链路：msedge-tts 中文女声） -----------------------
const tts = new MsEdgeTTS()
await tts.setMetadata('zh-CN-XiaoxiaoNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
const chunks = []
for await (const chunk of tts.toStream(LINE).audioStream) chunks.push(Buffer.from(chunk))
const mp3 = Buffer.concat(chunks)
tts.close()
const mp3File = join(OUT, 'line.mp3')
writeFileSync(mp3File, mp3)
record('tts.line', { bytes: mp3.length, file: mp3File, text: LINE })

// ---- 2. 两张参考图（同为"同一个人"，但图像侧没有图生图，只能各写一次提示词） ----
const person = '一位 28 岁中国女性带货主播，鹅蛋脸，黑色中长发披肩，穿米白色针织衫，米色墙面背景，柔和暖光，真实摄影质感，竖屏构图'
const front = await post(BASE + '/images/generations', { model: IMAGE_MODEL, n: 1, size: '1080x1920', prompt: person + '，正面半身，正对镜头，自然微笑' })
const side = await post(BASE + '/images/generations', { model: IMAGE_MODEL, n: 1, size: '1080x1920', prompt: person + '，侧身 30 度中景，视线看向镜头方向' })
const frontUrl = pickUrl(front.body)
const sideUrl = pickUrl(side.body)
record('anchors', { frontUrl, sideUrl })

// ---- 3. reference 模式口播：真实音频 + 两张参考图 -----------------------------
if (frontUrl !== '' && sideUrl !== '' && mp3.length > 0) {
  const created = await post(BASE + '/videos', {
    model: VIDEO_MODEL,
    prompt: LINE,
    seconds: '5',
    size: '720P',
    aspect_ratio: '9:16',
    mode: 'reference',
    images: [frontUrl, sideUrl],
    audios: ['data:audio/mpeg;base64,' + mp3.toString('base64')],
    seed: 20260916,
  })
  const videoId = (() => { try { return JSON.parse(created.body)?.video_id ?? '' } catch { return '' } })()
  record('video.reference.created', { ...created, videoId })
  if (videoId !== '') writeFileSync(join(OUT, 'video-task.txt'), videoId + '\n' + VIDEO_MODEL, 'utf8')
}

writeFileSync(join(OUT, 'results-4.json'), JSON.stringify(results, null, 2), 'utf8')
console.log('\n结果已落盘：' + join(OUT, 'results-4.json'))
