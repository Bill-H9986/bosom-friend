#!/usr/bin/env node
/**
 * 频道平台登录起点巡检：对每个白名单平台走一遍真实的产品链路
 * （v2/channels/accounts/auth/:platform → platform-login/qr/:sessionId），
 * 确认引擎真的能起来并交出一张可扫的二维码。
 *
 * 这一步不需要本人扫码：扫码是人的动作，但"点了没反应/报不支持/二维码出不来"是产品缺陷。
 * 二维码图落在 qa/evidence/二维码-<platform>.png，供人工扫码与复核。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORIGIN = process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280'
const API = ORIGIN + '/bosom-friend/api/'
const TOKEN = process.env.BF_QA_TOKEN ?? 'bf-local-guest-token'
const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, '..', 'evidence')

const platforms = (process.env.BF_PROBE_PLATFORMS ?? 'KWAI,wxSph,xianyu').split(',')

async function call(method, path) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
  })
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, message: text.slice(0, 200) } }
}

function pngInfo(buffer) {
  const ok = buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47
  return { png: ok, width: ok ? buffer.readUInt32BE(16) : 0, height: ok ? buffer.readUInt32BE(20) : 0 }
}

mkdirSync(EVIDENCE, { recursive: true })
const report = []

for (const platform of platforms) {
  const started = await call('GET', 'v2/channels/accounts/auth/' + platform)
  if (started.code !== 0 || !started.data?.sessionId) {
    report.push({ platform, ok: false, stage: 'start', message: started.message })
    console.log('PROBE ' + platform + ' START_FAIL ' + started.message)
    continue
  }
  const sessionId = started.data.sessionId
  const deadline = Date.now() + 120000
  let bytes = null
  let lastError = ''
  while (Date.now() < deadline) {
    const res = await fetch(API + 'platform-login/qr/' + encodeURIComponent(sessionId), {
      headers: { authorization: 'Bearer ' + TOKEN },
    })
    if (res.ok) {
      bytes = Buffer.from(await res.arrayBuffer())
      break
    }
    const body = await res.text().catch(() => '')
    lastError = body.slice(0, 160)
    await new Promise(r => setTimeout(r, 2000))
  }
  if (bytes === null) {
    report.push({ platform, ok: false, stage: 'qr', message: lastError })
    console.log('PROBE ' + platform + ' QR_FAIL ' + lastError)
    continue
  }
  const file = join(EVIDENCE, '二维码-' + platform + '.png')
  writeFileSync(file, bytes)
  const info = pngInfo(bytes)
  report.push({ platform, ok: info.png, bytes: bytes.length, ...info, file })
  console.log('PROBE ' + platform + ' OK bytes=' + bytes.length + ' ' + info.width + 'x' + info.height + ' -> ' + file)
}

console.log('PROBE_REPORT ' + JSON.stringify(report))
process.exit(report.every(item => item.ok) ? 0 : 1)
