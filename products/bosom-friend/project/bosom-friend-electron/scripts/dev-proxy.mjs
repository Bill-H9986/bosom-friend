/**
 * 知音本地开发代理
 * 模拟生产 nginx 路由：
 *  - /api/ai/*     -> aitoearn-ai:3010/ai/*
 *  - /api/agent/*  -> aitoearn-ai:3010/agent/*
 *  - /api/internal/* -> aitoearn-ai:3010/internal/*
 *  - /api/*        -> aitoearn-server:3002/api/*
 */
import http from 'node:http'

const PORT = Number(process.env.PROXY_PORT || 8080)
const AI_BASE = process.env.AI_BASE || 'http://127.0.0.1:3010'
const SERVER_BASE = process.env.SERVER_BASE || 'http://127.0.0.1:3002'

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  let target
  let path = url

  if (url.startsWith('/api/ai/') || url.startsWith('/api/agent/') || url.startsWith('/api/internal/')) {
    target = AI_BASE
    path = url.replace(/^\/api\//, '/')
  }
  else if (url.startsWith('/api/')) {
    target = SERVER_BASE
    // 本地后端无全局 /api 前缀（与生产 nginx 的 rewrite 一致），转发前剥离
    path = url.replace(/^\/api\//, '/')
  }
  else if (url.startsWith('/health')) {
    target = SERVER_BASE
    path = url
  }
  else {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: 404, message: 'Not Found' }))
    return
  }

  const targetUrl = new URL(path, target)
  const proxyReq = http.request(
    targetUrl,
    {
      method: req.method,
      headers: { ...req.headers, host: targetUrl.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    console.error('[dev-proxy]', err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    }
    res.end(JSON.stringify({ code: 502, message: '代理目标不可用: ' + err.message }))
  })
  req.pipe(proxyReq)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`知音开发代理已启动: http://127.0.0.1:${PORT}/api`)
})
