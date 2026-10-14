#!/usr/bin/env node
/**
 * Agnes 用量字段探针：回答"厂商到底给不给 token 用量"。
 *
 * 背景：产品成本账本需要区分「实测」与「估算」。内核链路只回文本，
 * 如果厂商响应里本来有 usage，那是我们没读；如果没有，就只能走本地估算。
 * 本探针直接打 Agnes 的 OpenAI 兼容端点，分别看「非流式」与「流式最后一帧」有没有 usage。
 *
 * 用法：node products/bosom-friend/qa/probes/agnes-usage-probe.mjs
 * 退出码：0 = 探针跑完（结论看输出）；2 = 缺 AGNES_API_KEY。
 */
const BASE = (process.env.AGNES_BASE_URL ?? 'https://api.agnes-ai.cn/v1').replace(/\/$/, '')
const KEY = (process.env.AGNES_API_KEY ?? '').trim()
const MODEL = process.env.AGNES_CHAT_MODEL ?? 'agnes-chat'
if (KEY === '') { console.error('缺少 AGNES_API_KEY'); process.exit(2) }

const PROMPT = '用一句话说明：为什么口播稿要有字数下限？'
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }

/** 提取响应里所有与用量相关的键，避免只盯着 usage 一个名字。 */
function usageKeys(text) {
  const found = new Set()
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (/usage|token|cost|price|credit|quota/i.test(key)) found.add(path + '.' + key + ' = ' + JSON.stringify(value).slice(0, 120))
      walk(value, path + '.' + key)
    }
  }
  try { walk(JSON.parse(text), '') } catch { /* 非 JSON 就跳过 */ }
  return [...found]
}

async function post(path, body) {
  const started = Date.now()
  const resp = await fetch(BASE + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
  const text = await resp.text()
  return { status: resp.status, ms: Date.now() - started, text }
}

// 1) 非流式
const plain = await post('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: 200 })
console.log('=== 非流式 /chat/completions ===')
console.log('status=' + plain.status + ' 耗时=' + plain.ms + 'ms 响应字节=' + plain.text.length)
console.log('顶层键=' + (() => { try { return Object.keys(JSON.parse(plain.text)).join(',') } catch { return '(非 JSON)' } })())
console.log('用量候选=' + JSON.stringify(usageKeys(plain.text), null, 1))

// 2) 流式（OpenAI 兼容：usage 通常在最后一帧或需要 stream_options.include_usage）
const streamed = await post('/chat/completions', { model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: 200, stream: true, stream_options: { include_usage: true } })
const frames = streamed.text.split('\n').filter(line => line.startsWith('data:'))
const lastFrames = frames.slice(-3).map(frame => frame.slice(0, 300))
console.log('\n=== 流式 /chat/completions（stream_options.include_usage） ===')
console.log('status=' + streamed.status + ' 耗时=' + streamed.ms + 'ms 帧数=' + frames.length)
console.log('末帧=' + JSON.stringify(lastFrames, null, 1))
console.log('用量候选=' + JSON.stringify(usageKeys(streamed.text), null, 1))
