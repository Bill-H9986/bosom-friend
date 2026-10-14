// 隔离 QA：临时数据根 + 独立端口，绝不影响真实产品数据。
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PORT = process.env.BF_QA_PORT || '3095'
const ROOT = resolve(process.cwd())
const DATA = mkdtempSync(join(tmpdir(), 'bosom-friend-qa-'))
const BASE = `http://127.0.0.1:${PORT}/bosom-friend/`
const API = BASE + 'api/'
const APP = BASE + '?planId=mg-persist'
const ORIGIN = `http://127.0.0.1:${PORT}`
// 入口是构建产物 lib/bin-desktop.mjs（旧路径 lib/types/bin.js 随 src/bin.ts 一起没了；
// 构建：pnpm --filter @deepseek-ai/bosom-friend build:desktop）。
const bin = join(ROOT, 'products', 'bosom-friend', 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs')
const env = {
  ...process.env,
  DSH_HOME: DATA,
  BOSOM_FRIEND_HOME: DATA,
  BF_QA_BASE: BASE,
  BF_QA_API: API,
  BF_QA_APP: APP,
  BF_QA_ORIGIN: ORIGIN,
  BF_QA_PORT: PORT,
}

console.log('isolated data root:', DATA)
const child = spawn(process.execPath, [bin, '--port', PORT, '--no-open'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: true,
})

async function waitServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return true
    }
    catch {
      // wait
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  return false
}

const ready = await waitServer()
if (!ready) {
  console.error('isolated server failed to start')
  child.kill()
  process.exit(1)
}

const steps = [
  ['node', [join(ROOT, 'products', 'bosom-friend', 'qa', 'qa-all.mjs')], env],
  ['node', [join(ROOT, 'products', 'bosom-friend', 'qa', 'smoke-all.mjs')], env],
  ['node', [join(ROOT, 'products', 'bosom-friend', 'qa', 'smoke-edge.mjs')], env],
]

let pass = true
for (const [command, args] of steps) {
  const code = await new Promise(resolveCode => {
    const p = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' })
    p.on('exit', resolveCode)
  })
  if (code !== 0) {
    pass = false
    break
  }
}

spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
await new Promise(resolveWait => setTimeout(resolveWait, 3000))
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    rmSync(DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
    break
  }
  catch {
    await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  }
}
console.log(`ISOLATED_QA ${pass ? 'PASS' : 'FAIL'} port=${PORT}`)
process.exit(pass ? 0 : 1)
