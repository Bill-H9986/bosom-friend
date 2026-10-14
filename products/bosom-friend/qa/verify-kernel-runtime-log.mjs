#!/usr/bin/env node
/**
 * 内核运行日志的行为验收：stderr 必须落盘，stdout 必须一字不动。
 *
 * 为什么单独验收：桌面内核的 stdout 是 SDK 的 JSON-RPC 独占通道，任何写进去的日志都会污染协议；
 * 而业务诊断（厂商 429、轮询超时、图片被拒）全部走 stderr。接管 stderr 的同时必须保证 stdout
 * 原封不动，这条约束只能靠真实执行来证明。
 *
 * 断言：
 *   1. stderr 的整行落盘；
 *   2. 分片写入（半行）被拼成一行，不丢内容；
 *   3. stdout 的 write 函数在安装前后**同一个引用**（绝不被接管）；
 *   4. 密钥形态字符串被遮蔽；
 *   5. 目录不可写时静默降级，不抛出；
 *   6. 文件按 <前缀>-<日期>.log 命名。
 *
 * 用法：node products/bosom-friend/qa/verify-kernel-runtime-log.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 缺少构建产物。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const built = join(productRoot, 'server', 'lib', 'types', 'runtime-log.js')

if (!existsSync(built)) {
  console.error('缺少构建产物，请先执行 pnpm --filter @deepseek-ai/dsh-bosom-friend-server build')
  console.error('KERNEL_RUNTIME_LOG SKIP missing=' + built)
  process.exit(2)
}

const { installRuntimeLog } = await import(pathToFileURL(built).href)
const checks = []

/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' })
}

/** @returns 临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), 'bf-klog-' + tag + '-'))
}

const stdoutBefore = process.stdout.write
const stderrBefore = process.stderr.write
const day = new Date().toISOString().slice(0, 10)

// 1 + 2 + 3 + 4 + 6
{
  const dir = tempDir('basic')
  const log = installRuntimeLog({ dir })
  log.line('[boot] 装载完成')
  process.stderr.write('厂商 429：apiKey=sk-abcdef1234567890\n')
  process.stderr.write('半行内容')
  process.stderr.write('拼起来\n')
  log.close()
  const file = join(dir, 'kernel-' + day + '.log')
  const body = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check('文件按前缀与日期命名', existsSync(file), readdirSync(dir).join(','))
  check('stderr 整行落盘', body.includes('厂商 429'), body.slice(0, 200))
  check('分片拼成一行', body.includes('半行内容拼起来'), body.slice(0, 300))
  check('遮蔽密钥', !body.includes('sk-abcdef1234567890') && body.includes('sk-***'), body.slice(0, 300))
  check('自写行落盘', body.includes('[boot] 装载完成'), body.slice(0, 200))
  check('stdout 未被接管', process.stdout.write === stdoutBefore, '')
  check('stderr 原函数仍被调用（可回滚验证）', process.stderr.write !== stderrBefore, '')
  rmSync(dir, { recursive: true, force: true })
}

// 5：目录不可写时静默降级
{
  const dir = tempDir('fail')
  writeFileSync(join(dir, 'blocker'), 'x', 'utf8')
  const log = installRuntimeLog({ dir: join(dir, 'blocker', 'logs') })
  let threw = false
  try {
    log.line('写不进去')
    process.stderr.write('也写不进去\n')
  }
  catch {
    threw = true
  }
  check('写失败不抛出', !threw, '')
  rmSync(dir, { recursive: true, force: true })
}

const failed = checks.filter(c => !c.ok)
for (const c of checks)
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('KERNEL_RUNTIME_LOG ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
