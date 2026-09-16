#!/usr/bin/env node
/**
 * 验证同一套桌面运行时能否以不同端口 + 不同 BOSOM_FRIEND_HOME 并行启动。
 * 只做基础设施隔离验证：不操作产品页面、不读取业务数据。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const runtimeBin = join(repoRoot, 'products', 'bosom-friend', 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs')
const frontendDist = join(repoRoot, 'products', 'bosom-friend', 'project', 'bosom-friend-electron', 'dist')
const baseDir = mkdtempSync(join(tmpdir(), 'bf-parallel-iso-'))
const instances = []

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

async function waitForPort(port, timeoutMs = 90000) {
  const url = `http://127.0.0.1:${port}/bosom-friend/`
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // server not ready yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  return false
}

function launch(index, port) {
  const home = join(baseDir, `home-${index}`)
  mkdirSync(home, { recursive: true })
  const log = join(baseDir, `runtime-${index}.log`)
  const logs = []
  const child = spawn(process.execPath, [runtimeBin], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BF_DESKTOP_PORT: String(port),
      BOSOM_FRIEND_HOME: home,
      BF_FRONTEND_DIST: frontendDist,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))
  child.on('exit', (code) => {
    logs.push(`EXIT code=${code}`)
    writeFileSync(log, logs.join(''), 'utf8')
  })
  instances.push({ child, port, home, log })
}

launch(1, 31301)
launch(2, 31302)

let pass = true
const results = []
for (const instance of instances) {
  const ready = await waitForPort(instance.port)
  results.push({ port: instance.port, ready })
  console.log(`PORT_ISOLATION index=${instance.port} ready=${ready}`)
  if (!ready) pass = false
}

for (const instance of instances) {
  killTree(instance.child.pid)
}
await new Promise((resolveWait) => setTimeout(resolveWait, 1500))

writeFileSync(join(baseDir, 'results.json'), JSON.stringify({ pass, results }, null, 2), 'utf8')
console.log(`PARALLEL_PORT_ISOLATION ${pass ? 'PASS' : 'FAIL'} evidence=${baseDir}`)
process.exit(pass ? 0 : 1)
