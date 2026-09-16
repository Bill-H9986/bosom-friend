#!/usr/bin/env node
/** 验证随包 0.2.28 runtime/bin-desktop.mjs 在固定端口上能保持服务存活。 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const productRoot = join(root, 'products', 'bosom-friend')
const port = 31502
const home = join(root, 'products', 'bosom-friend', 'qa', 'evidence', 'parallel-2026-09-04', 'runtime-check-home')
mkdirSync(home, { recursive: true })
const runtimeNode = join(productRoot, 'desktop', 'release', '0.2.28', 'win-unpacked', 'resources', 'runtime', 'node.exe')
const runtimeBin = join(productRoot, 'desktop', 'dist', 'kernel-runtime-unpacked', 'runtime', 'bin-desktop.mjs')
const logs = []
const child = spawn(runtimeNode, [runtimeBin], {
  cwd: root,
  env: {
    ...process.env,
    BF_DESKTOP_PORT: String(port),
    BOSOM_FRIEND_HOME: home,
    BF_KERNEL_ROOT: join(productRoot, 'desktop', 'dist', 'kernel-runtime-unpacked'),
    BF_FRONTEND_DIST: join(productRoot, 'project', 'bosom-friend-electron', 'dist'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', (chunk) => logs.push('[stdout] ' + chunk.toString()))
child.stderr.on('data', (chunk) => logs.push('[stderr] ' + chunk.toString()))
let ok = false
try {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/bosom-friend/`)
      if (res.ok) {
        ok = true
        break
      }
    } catch {
      // wait
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  console.log(`RUNTIME_READY=${ok}`)
  if (!ok) process.exit(1)
  await new Promise((resolveWait) => setTimeout(resolveWait, 30000))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/bosom-friend/api/ai/draft-generation/pricing`)
    console.log(`RUNTIME_ALIVE=${res.ok} status=${res.status}`)
    if (!res.ok) process.exit(1)
  } catch (error) {
    console.log('RUNTIME_ALIVE=false err=' + String(error).slice(0, 300))
    process.exit(1)
  }
} finally {
  writeFileSync(join(root, 'products', 'bosom-friend', 'qa', 'evidence', 'parallel-2026-09-04', 'runtime-check.log'), logs.join(''), 'utf8')
  if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
