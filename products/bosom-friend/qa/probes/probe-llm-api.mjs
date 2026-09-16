// probe-llm-api.mjs - 直测 ai/chat override 分支
const H = { Authorization: 'Bearer x', 'Content-Type': 'application/json' }
for (const [label, body] of [
  ['override-unreachable', { messages: [{ role: 'user', content: '测试一句话' }], llm: { baseUrl: 'https://127.0.0.1:1', apiKey: 'test-key', model: 'm' } }],
  ['system', { messages: [{ role: 'user', content: '测试一句话' }] }],
]) {
  try {
    const res = await fetch('http://127.0.0.1:3081/bosom-friend/api/ai/chat', { method: 'POST', headers: H, body: JSON.stringify(body) })
    const text = await res.text()
    console.log(label, 'status=', res.status, 'body=', text.slice(0, 300))
  } catch (e) {
    console.log(label, 'ERR', String(e))
  }
}
