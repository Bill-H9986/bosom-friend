/**
 * 修完配置后的最小真实调用验证：读产品自己的 llm-user.json，用里边生效的 imageModel 打一次真图。
 * 判据是"厂商 200 + 拿到图片 URL"，不是"文件改对了"。
 * @module qa/probes/verify-image-model
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const cfgPath = join(homedir(), '.bosom-friend', 'bosom-friend', 'llm-user.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const model = cfg.imageModel ?? ''
const base = (cfg.imageBaseUrl || cfg.baseUrl || '').replace(/\/+$/, '')
const key = cfg.imageApiKey || cfg.apiKey || ''
console.log('imageModel=' + model + ' base=' + base + ' keyLen=' + key.length)
if (model === '' || key === '') { console.error('配置不完整'); process.exit(2) }

const endpoint = /\/v\d+$/.test(base) ? base + '/images/generations' : base + '/v1/images/generations'
const resp = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
  body: JSON.stringify({ model, prompt: '竖屏产品图：一支白色磨砂玻璃面霜瓶放在米色台面上，柔和自然光，极简构图', n: 1, size: '1080x1920' }),
  signal: AbortSignal.timeout(120000),
})
const text = await resp.text()
console.log('HTTP ' + resp.status)
console.log(text.slice(0, 700))
if (resp.status === 200) {
  const url = (() => { try { return JSON.parse(text)?.data?.[0]?.url ?? '' } catch { return '' } })()
  if (url !== '') {
    const img = await fetch(url, { signal: AbortSignal.timeout(90000) })
    const buf = Buffer.from(await img.arrayBuffer())
    const out = 'C:/Users/Jay/Desktop/Bosom friend APP/.dsh-build/model-fix-verify'
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'image-after-fix.png'), buf)
    console.log('IMAGE_OK bytes=' + buf.length + ' -> ' + join(out, 'image-after-fix.png'))
  }
}
