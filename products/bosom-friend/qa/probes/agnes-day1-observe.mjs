#!/usr/bin/env node
/**
 * Day 1 观察脚本：把 Agnes 三类端点的"原始返回"摊开给你看。
 *
 * 你不需要写代码，只需要：
 *   1) 先写下你的预言（哪类端点会有 token 用量）
 *   2) 跑这个脚本
 *   3) 对照输出，看看预言错在哪、为什么
 *
 * 用法（在仓库根目录、PowerShell 里）：
 *   $env:AGNES_API_KEY = ((Get-Content .env | Where-Object { $_ -match '^AGNES_API_KEY=' }) -replace '^AGNES_API_KEY=','').Trim()
 *   node products/bosom-friend/qa/probes/agnes-day1-observe.mjs
 */
const BASE = 'https://api.agnes-ai.cn/v1'
const KEY = (process.env.AGNES_API_KEY ?? '').trim()
const CHAT_MODEL = process.env.AGNES_CHAT_MODEL ?? 'agnes-2.5-flash'
const IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL ?? 'agnes-image-2.1-flash'
if (KEY === '') { console.error('缺少 AGNES_API_KEY（见文件顶部用法）'); process.exit(2) }

const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }
const PROMPT = '用一句话说明：为什么口播稿要有字数下限？'

/** 打印一个返回体的"骨架"：顶层键 + 任何名字里带 usage/token/cost/credit 的字段（含路径）。 */
function describe(label, status, ms, text) {
  console.log('\n================ ' + label + ' ================')
  console.log('HTTP ' + status + '｜本机计时 ' + ms + 'ms｜返回 ' + text.length + ' 字节')
  let json
  try { json = JSON.parse(text) } catch { console.log('（不是 JSON，前 200 字）' + text.slice(0, 200)); return }
  console.log('顶层键：' + Object.keys(json).join(', '))
  const hits = []
  const walk = (node, path, depth) => {
    if (node === null || typeof node !== 'object' || depth > 4) return
    for (const [key, value] of Object.entries(node)) {
      const here = path === '' ? key : path + '.' + key
      if (/usage|token|cost|credit|quota/i.test(key)) hits.push(here + ' = ' + JSON.stringify(value).slice(0, 120))
      walk(value, here, depth + 1)
    }
  }
  walk(json, '', 0)
  console.log(hits.length === 0 ? '用量相关字段：**一个都没有**' : '用量相关字段：\n  ' + hits.join('\n  '))
}

async function call(label, path, body, timeoutMs) {
  const started = Date.now()
  try {
    const resp = await fetch(BASE + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    describe(label, resp.status, Date.now() - started, await resp.text())
  } catch (error) {
    console.log('\n================ ' + label + ' ================')
    console.log('调用失败：' + String(error).slice(0, 200))
  }
}

console.log('模型：chat=' + CHAT_MODEL + ' image=' + IMAGE_MODEL)
await call('① 文本 · 非流式', '/chat/completions', { model: CHAT_MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: 150 }, 120000)
// ② 会返回 SSE（很多行 `data: {...}`），本脚本不解析它——这正是要你看的地方：
//    结束前有没有一帧里带 usage？（提示：看最后几行，注意 `data: [DONE]`）
await call('② 文本 · 流式', '/chat/completions', { model: CHAT_MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: 150, stream: true }, 120000)
await call('③ 图片生成', '/images/generations', { model: IMAGE_MODEL, n: 1, size: '1024x1024', prompt: '一只白色的陶瓷杯，浅灰背景，柔和光线，产品照' }, 240000)
console.log('\n（视频端点会真的开始生成、耗时几分钟且要花钱，Day 1 先不打；它的返回体在 qa/evidence/agnes-probe-2026-09-16/ 里有留档）')
