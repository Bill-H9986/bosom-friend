#!/usr/bin/env node
/** 基础设施诊断：只用于定位内容生成后台；不参与产品验收 PASS。 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const productRoot = join(root, 'products', 'bosom-friend')
const evidence = join(productRoot, 'qa', 'evidence', 'parallel-2026-09-04', 'diagnose-content')
const baseDir = join(evidence, 'home')
const port = Number(process.env.BF_DIAG_PORT || 31500)
mkdirSync(join(baseDir, 'bosom-friend'), { recursive: true })
const osHome = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')
if (existsSync(join(osHome, 'llm-user.json'))) {
  copyFileSync(join(osHome, 'llm-user.json'), join(baseDir, 'bosom-friend', 'llm-user.json'))
}
const logFile = join(evidence, 'server.log')
const logs = []
const child = spawn(process.execPath, [join(productRoot, 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    BF_DESKTOP_PORT: String(port),
    BOSOM_FRIEND_HOME: join(evidence, 'home'),
    BF_FRONTEND_DIST: join(productRoot, 'project', 'bosom-friend-electron', 'dist'),
    BF_KERNEL_ROOT: join(productRoot, 'desktop', 'dist', 'kernel-runtime-unpacked'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', (chunk) => logs.push('[stdout] ' + chunk.toString()))
child.stderr.on('data', (chunk) => logs.push('[stderr] ' + chunk.toString()))

function flush() {
  writeFileSync(logFile, logs.join(''), 'utf8')
}

async function waitServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/bosom-friend/`)
      if (res.ok) return true
    } catch {
      // not ready
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  return false
}

const api = async (path, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/bosom-friend/api/${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

let taskId = ''
try {
  const ready = await waitServer()
  console.log(`READY=${ready}`)
  if (!ready) process.exit(1)
  const created = await api('ai/draft-generation/image-text', {
    method: 'POST',
    body: JSON.stringify({
      quantity: 1,
      groupId: 'mg-persist',
      prompt: '关于人社局无人机装调检修工程师就业免费培训',
      imageModel: 'agnes-image-2.5-flash',
      imageCount: Number(process.env.BF_DIAG_IMAGE_COUNT || 1),
      aspectRatio: '3:4',
      imageSize: '720p',
    }),
  })
  console.log('CREATED=' + JSON.stringify(created).slice(0, 500))
  taskId = created.body?.data?.taskIds?.[0] ?? ''
  if (!taskId) process.exit(1)
  for (let i = 0; i < 36; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10000))
    const state = await api('ai/draft-generation/query', {
      method: 'POST',
      body: JSON.stringify({ taskIds: [taskId] }),
    })
    const task = Array.isArray(state.body?.data) ? state.body.data[0] : state.body?.data
    console.log(`POLL ${i + 1} STATUS=${task?.status ?? '?'} IMG=${Array.isArray(task?.response?.imageUrls) ? task.response.imageUrls.length : '?'} MSG=${task?.errorMessage ?? ''}`)
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ created, state, logs: logs.slice(-100) }, null, 2), 'utf8')
    if (task?.status === 'success' || task?.status === 'partial' || task?.status === 'failed') break
  }
} catch (error) {
  console.log('DIAGNOSE_ERROR=' + String(error).slice(0, 2000))
} finally {
  flush()
  if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  console.log(`LOGS=${logFile}`)
}
