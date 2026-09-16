// Bosom Friend 后端 SSE 冒烟脚本：验证 agent/tasks 流式对话闭环。
// 用法: node products/bosom-friend/qa/smoke-sse.mjs [baseUrl]
// 使用 node:http 而非 fetch：Windows + Node 24 下 undici 流句柄在退出期会触发
// UV_HANDLE_CLOSING 断言，原生 http 请求可在 done 事件后显式销毁，干净退出。
import http from 'node:http'

const base = process.argv[2] ?? process.env.BF_QA_BASE ?? 'http://127.0.0.1:3080'
const timeoutMs = 60000

async function ensureToken() {
  const login = async () => (await fetch(base + '/bosom-friend/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456' }) })).json()
  let r = await login()
  if (r.code !== 0) {
    await fetch(base + '/bosom-friend/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'qa-tester', password: 'qa-123456', name: 'QA' }) })
    r = await login()
  }
  return r.data.token
}

const authToken = await ensureToken()
const url = new URL(base + '/bosom-friend/api/agent/tasks')
const payload = JSON.stringify({ prompt: '帮我写一篇咖啡小红书笔记', includePartialMessages: true })
const timer = setTimeout(() => {
  console.log('TIMEOUT')
  process.exit(3)
}, timeoutMs)

const req = http.request({
  host: url.hostname,
  port: url.port,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: 'Bearer ' + authToken,
  },
}, (res) => {
  console.log('status', res.statusCode)
  if (res.statusCode !== 200) {
    res.setEncoding('utf8')
    res.on('data', chunk => process.stderr.write(chunk))
    res.on('end', () => process.exit(1))
    return
  }
  let buf = ''
  const types = []
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const dataLine = block.split(/\r?\n/).find(l => l.startsWith('data:'))
      if (!dataLine)
        continue
      try {
        const j = JSON.parse(dataLine.slice(5).trim())
        types.push(j.type)
        if (types.length <= 3 || j.type === 'done') {
          console.log('event', JSON.stringify({ type: j.type, taskId: j.taskId, delta: '' }))
        }
        if (j.type === 'done') {
          clearTimeout(timer)
          console.log('STREAM_OK events=' + types.length)
          req.destroy()
          process.exit(0)
        }
      }
      catch { /* 忽略无法解析的块 */ }
    }
  })
})

req.on('error', (error) => {
  clearTimeout(timer)
  console.error(error)
  process.exit(1)
})
req.end(payload)
