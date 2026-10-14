#!/usr/bin/env node
/**
 * 厂商能力侦察：文生视频能不能按题材出画面（B-roll 融合创作的前置验证）。
 *
 * 为什么要有这条：长视频的数字人口播镜走参考模式，画面由形象图决定；要让"场地/设备"
 * 真的进画面，只能靠**文生视频的 B-roll**。所以先单独问厂商一句：给它一段无人机工位的
 * 描述，它画不画得出来。这是可研级别的验证，不写进产品链路。
 *
 * 只用本机已配置的厂商（读 llm-user.json，不打印密钥），产物落在 qa/evidence 下。
 *
 * Usage: node products/bosom-friend/qa/probes/vendor-broll-recon.mjs [--seconds 8] [--limit 3]
 * @module qa/probes/vendor-broll-recon
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const OUT = join(PRODUCT, 'qa', 'evidence', 'vendor-broll-recon-2026-09-20')
mkdirSync(OUT, { recursive: true })

const args = process.argv.slice(2)
const secondsArg = args.indexOf('--seconds')
const SECONDS = secondsArg >= 0 ? String(Number(args[secondsArg + 1])) : '8'
const limitArg = args.indexOf('--limit')
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 3

const cfg = JSON.parse(readFileSync(join(homedir(), '.bosom-friend', 'bosom-friend', 'llm-user.json'), 'utf8'))
// 视频通道是顶层平铺字段（videoBaseUrl / videoApiKey / videoModel），不是嵌套对象。
const base = String(cfg.videoBaseUrl ?? '').replace(/\/+$/, '')
const key = String(cfg.videoApiKey ?? '')
const model = String(cfg.videoModel ?? '')
if (base === '' || key === '' || model === '') { console.error('视频通道没配好'); process.exit(2) }
const endpoint = /\/v\d+$/.test(base) ? base + '/videos' : base + '/v1/videos'
const origin = new URL(base).origin

/** 三条题材化提示词：工位/设备/场地各一条。 */
const PROMPTS = [
  '无人机维修实训工位：白色多旋翼无人机放在金属维修台上，旁边是螺丝刀与拆下的螺旋桨，背景是明亮的培训教室，固定机位，画面里不出现任何文字与品牌标识',
  '无人机拆装特写：双手在维修台上拆开一台小型无人机的机臂，电机与电调露出，浅景深，固定机位，画面里不出现任何文字与品牌标识',
  '无人机培训教室全景：几排工位各放一台多旋翼无人机，学员在工位前操作，暖色顶光，固定机位，画面里不出现任何文字与品牌标识',
]
const say = (...parts) => console.log(parts.join(' '))

/** 提交一条生成任务。 @param prompt - 画面要求。 @returns 任务 id 或空串。 */
async function submit(prompt) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, prompt, seconds: SECONDS, size: '720P', aspect_ratio: '9:16', mode: 'text' }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  say('  submit status=' + String(res.status) + ' body=' + text.slice(0, 200))
  if (!res.ok) return ''
  try {
    const json = JSON.parse(text)
    return String(json.video_id ?? json.id ?? json.data?.video_id ?? json.data?.id ?? '')
  }
  catch { return '' }
}

/** 轮询取成品地址。 @param id - 任务 id。 @returns 成品 URL 或空串。 */
async function poll(id) {
  const deadline = Date.now() + 12 * 60_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 8000))
    const url = origin + '/agnesapi?video_id=' + encodeURIComponent(id) + '&model_name=' + encodeURIComponent(model)
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) }).catch(() => null)
    if (res === null) continue
    if (!res.ok) { if (res.status === 429) { say('  poll 429，继续等'); continue } continue }
    const json = await res.json().catch(() => null)
    const found = JSON.stringify(json ?? {})
    const match = /"(?:url|video_url|videoUrl|output)"\s*:\s*"([^"]+)"/.exec(found)
    if (match !== null && /^https?:/.test(match[1])) return match[1]
    const status = String(json?.status ?? '')
    if (status !== '' && status !== 'processing' && status !== 'pending') say('  poll status=' + status)
  }
  return ''
}

const results = []
for (const [index, prompt] of PROMPTS.entries()) {
  if (index >= LIMIT) break
  say('[' + String(index + 1) + '] ' + prompt.slice(0, 50) + '…')
  const id = await submit(prompt)
  if (id === '') { results.push({ prompt, ok: false, reason: 'submit failed' }); continue }
  say('  video_id=' + id)
  const url = await poll(id)
  if (url === '') { results.push({ prompt, id, ok: false, reason: 'no url' }); continue }
  const file = join(OUT, 'recon-' + String(index + 1) + '.mp4')
  const bytes = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120000) })).arrayBuffer())
  writeFileSync(file, bytes)
  say('  成品 ' + file + '  ' + String(Math.round(bytes.length / 1024)) + 'KB')
  results.push({ prompt, id, ok: true, file })
}
writeFileSync(join(OUT, 'recon.json'), JSON.stringify({ at: new Date().toISOString(), model, seconds: SECONDS, results }, null, 2), 'utf8')
say('DONE ok=' + String(results.filter(r => r.ok).length) + '/' + String(results.length))
