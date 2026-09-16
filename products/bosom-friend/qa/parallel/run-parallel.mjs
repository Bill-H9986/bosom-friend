#!/usr/bin/env node
/**
 * 并行测试入口：严格隔离 4 个 worker，各自独立端口、userData、BOSOM_FRIEND_HOME。
 * 每个 worker 的真实页面证据、pageerror、报告都写入独立目录；不做任何后端调用。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const evidence = join(root, 'products', 'bosom-friend', 'qa', 'evidence', 'parallel-2026-09-04')
mkdirSync(evidence, { recursive: true })

const DEFAULT_WORKERS = [
  { name: 'nav-ui', file: 'worker-nav-ui.mjs', port: 31401 },
  { name: 'knowledge-restart', file: 'worker-knowledge-restart.mjs', port: 31402 },
  { name: 'monitor-publish', file: 'worker-monitor-publish.mjs', port: 31403 },
  { name: 'content', file: 'worker-content.mjs', port: 31404 },
]

const workers = process.env.BF_PARALLEL_WORKERS
  ? process.env.BF_PARALLEL_WORKERS.split(',').map((name) => DEFAULT_WORKERS.find((item) => item.name === name)).filter(Boolean)
  : DEFAULT_WORKERS

function runWorker(item) {
  return new Promise((resolve) => {
    const logFile = join(evidence, `${item.name}.log`)
    const stream = createWriteStream(logFile, { flags: 'w' })
    const child = spawn(process.execPath, [join(root, 'products', 'bosom-friend', 'qa', 'parallel', item.file)], {
      cwd: root,
      env: { ...process.env, BF_PARALLEL_NAME: item.name },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.pipe(stream)
    child.stderr.pipe(stream)
    child.on('error', (error) => {
      stream.write(`ERROR ${String(error)}\n`)
      stream.end()
      resolve({ name: item.name, code: 1, logFile })
    })
    child.on('exit', (code) => {
      stream.end()
      resolve({ name: item.name, code: code ?? 1, logFile })
    })
  })
}

console.log(`PARALLEL_START workers=${workers.map((item) => item.name).join(',')} ports=${workers.map((item) => item.port).join(',')}`)
const results = await Promise.all(workers.map(runWorker))
const summary = {
  generatedAt: new Date().toISOString(),
  exe: process.env.BF_DESKTOP_EXE || 'release/0.2.27/win-unpacked/Bosom Friend.exe',
  results,
  pass: results.every((item) => item.code === 0),
}
writeFileSync(join(evidence, 'PARALLEL_SUMMARY.json'), JSON.stringify(summary, null, 2), 'utf8')
for (const result of results) {
  console.log(`PARALLEL_DONE name=${result.name} code=${result.code} log=${result.logFile}`)
}
console.log(`PARALLEL_SUMMARY ${summary.pass ? 'PASS' : 'FAIL'}`)
process.exit(summary.pass ? 0 : 1)
