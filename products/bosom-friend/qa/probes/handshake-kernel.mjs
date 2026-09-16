#!/usr/bin/env node
/**
 * 内核握手探针：对一份**已经落到磁盘上**的内核运行时发 initialize，验证它真的能起来。
 *
 * 为什么需要它：出包链的最后一步是「把 zip 解压成 %APPDATA%\<产品>\kernel-runtime」。
 * zip 由 pnpm 部署产物重打而来，而部署产物里的依赖是 Windows 目录联接点，zip 存不了
 * （2026-09-16 实测：解压后顶层链接包下面只剩 .bin，内核报 Cannot find package 'js-yaml'）。
 * 「zip 里有多少条目」说明不了能不能跑，只有真的 spawn 起来并握手成功才算数。
 *
 * 走的是**装机路径**：安装版阅读的入口固定为 <运行根>/runtime/bin-kernel.mjs
 * （见 products/bosom-friend/server/src/kernel-client.ts 的 BF_KERNEL_ROOT 分支）。
 *
 * 用法：node handshake-kernel.mjs <内核运行时根目录> [超时毫秒]
 * 退出码：0 = 握手成功；1 = 失败（打印子进程 stderr 尾部）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const timeoutMs = Number(process.argv[3] ?? 180000)
const entry = join(root, 'runtime', 'bin-kernel.mjs')
const boot = join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')

if (!existsSync(entry)) {
  console.error('HANDSHAKE FAIL: 入口不存在 ' + entry)
  process.exit(1)
}
if (!existsSync(boot)) {
  console.error('HANDSHAKE FAIL: 运行时缺 @deepseek-ai/dsh-app-boot（部署产物没被展开成真实目录？）')
  process.exit(1)
}

// 产品数据根指向临时目录：握手不该碰用户的 ~/.bosom-friend。
const home = mkdtempSync(join(tmpdir(), 'bf-handshake-'))
const child = spawn(process.execPath, [entry, '--profile', 'bosom-friend-kernel'], {
  cwd: root,
  env: { ...process.env, BF_KERNEL_ROOT: root, BOSOM_FRIEND_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let settled = false
const finish = (code, message) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  child.kill()
  rmSync(home, { recursive: true, force: true })
  if (message !== undefined) console.log(message)
  process.exit(code)
}
const timer = setTimeout(() => {
  console.error('HANDSHAKE FAIL: ' + timeoutMs + 'ms 内没有收到 initialize 应答')
  console.error('stderr tail:\n' + stderr.split('\n').slice(-25).join('\n'))
  finish(1)
}, timeoutMs)

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
  let newline = stdout.indexOf('\n')
  while (newline >= 0) {
    const line = stdout.slice(0, newline).trim()
    stdout = stdout.slice(newline + 1)
    newline = stdout.indexOf('\n')
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== 1) continue
    if (message.error !== undefined) {
      console.error('HANDSHAKE FAIL: 内核回了错误 ' + JSON.stringify(message.error))
      console.error('stderr tail:\n' + stderr.split('\n').slice(-25).join('\n'))
      finish(1)
      return
    }
    const name = message.result?.serverInfo?.name
    if (name !== 'deepseek-harness-sdk-runtime') {
      console.error('HANDSHAKE FAIL: serverInfo 不是期望值 ' + JSON.stringify(message.result))
      finish(1)
      return
    }
    finish(0, 'HANDSHAKE PASS ' + root + ' -> ' + JSON.stringify(message.result.serverInfo))
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.on('exit', (code) => {
  console.error('HANDSHAKE FAIL: 内核进程提前退出 exit=' + String(code))
  console.error('stderr tail:\n' + stderr.split('\n').slice(-25).join('\n'))
  finish(1)
})

child.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }) + '\n',
)
