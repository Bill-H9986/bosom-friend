import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const OUT = 'C:/Users/Jay/Desktop/Bosom friend APP/.dsh-build/agnes-probe'
mkdirSync(OUT, { recursive: true })
const apiKey = (process.env.AGNES_API_KEY ?? '').trim()
const origin = 'https://api.agnes-ai.cn'
const videoId = process.argv[2]
const model = process.argv[3] ?? 'agnes-video-2.5-flash'
const deadline = Date.now() + Number(process.env.POLL_MS ?? 420000)
let last = ''
for (;;) {
  if (Date.now() > deadline) { console.log('POLL_TIMEOUT last=' + last.slice(0, 800)); process.exit(1) }
  await new Promise(r => setTimeout(r, 6000))
  const url = origin + '/agnesapi?video_id=' + encodeURIComponent(videoId) + '&model_name=' + encodeURIComponent(model)
  const resp = await fetch(url, { headers: { authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(25000) })
  const text = await resp.text()
  last = text
  let status = ''
  try { status = String(JSON.parse(text)?.status ?? '') } catch { /* 非 JSON */ }
  console.log(new Date().toISOString().slice(11, 19) + ' status=' + JSON.stringify(status) + ' body=' + text.slice(0, 400))
  if (status === 'completed' || status === 'failed' || status === 'succeeded' || status === 'error') {
    writeFileSync(join(OUT, 'video-status.json'), text, 'utf8')
    process.exit(status === 'failed' || status === 'error' ? 1 : 0)
  }
}
