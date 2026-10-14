#!/usr/bin/env node
/**
 * 运行日志落盘能力的验收脚本。
 *
 * 背景：打包版此前没有任何落盘日志，主进程与内核子进程的输出进了无人接收的管道，
 * 现场"网络连接失败/生成失败"事后无从还原（见缺陷台账 DEF-082/DEF-083）。
 *
 * 断言（全部为真实文件系统行为，不打桩）：
 *   1. 写入落在 <dir>/<YYYY-MM-DD>.log，行内含 ISO 时间与级别；
 *   2. 密钥形态字符串被遮蔽（sk- / Bearer）；
 *   3. 超过单份上限后自动续写 <日期>.1.log；
 *   4. 首次写入会清理超过保留期的旧日志；
 *   5. 目录不可写时静默降级，绝不抛出（日志不能拖垮 App）；
 *   6. teeConsole 把 console.error / console.log 抄进日志。
 *
 * 用法：node products/bosom-friend/qa/verify-run-log.mjs
 */

import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const { createRunLog, teeConsole, maskSecrets } = require(join(here, '..', 'desktop', 'electron', 'run-log.cjs'))

const checks = []
/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败时的证据。 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' })
}

/** @returns 新建的临时目录。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), 'bf-runlog-' + tag + '-'))
}

const day = new Date().toISOString().slice(0, 10)

// 1 + 2：写入、时间戳、密钥遮蔽
{
  const dir = tempDir('basic')
  const log = createRunLog({ dir })
  log.info('启动完成', { port: 31280 })
  log.warn('厂商网关 429：apiKey=sk-abc123DEF456ghi789')
  log.error(new Error('内核初始化握手超时'))
  const file = join(dir, day + '.log')
  const body = readFileSync(file, 'utf8')
  check('写入当日文件', body.includes('[info] 启动完成'), body.slice(0, 200))
  check('行含 ISO 时间', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\]/m.test(body), body.slice(0, 120))
  check('遮蔽 sk- 密钥', !body.includes('sk-abc123DEF456ghi789') && body.includes('sk-***'), body)
  check('错误对象落栈', body.includes('内核初始化握手超时'), body)
  check('path() 指向当天文件', log.path() === file, log.path())
  rmSync(dir, { recursive: true, force: true })
}

// 3：超过单份上限后续写
{
  const dir = tempDir('rotate')
  const log = createRunLog({ dir, maxBytes: 200 })
  log.info('A'.repeat(300))
  log.info('第二份')
  const files = readdirSync(dir).sort()
  check('超限后生成第二份', files.includes(day + '.log') && files.includes(day + '.1.log'), files.join(','))
  check('续写文件收到第二行', readFileSync(join(dir, day + '.1.log'), 'utf8').includes('第二份'), '')
  rmSync(dir, { recursive: true, force: true })
}

// 4：清理超过保留期的旧日志
{
  const dir = tempDir('prune')
  writeFileSync(join(dir, '2000-01-01.log'), 'old\n', 'utf8')
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  utimesSync(join(dir, '2000-01-01.log'), old, old)
  const log = createRunLog({ dir, keepDays: 7 })
  log.info('触发清理')
  check('过期日志被清理', !readdirSync(dir).includes('2000-01-01.log'), readdirSync(dir).join(','))
  rmSync(dir, { recursive: true, force: true })
}

// 5：目录不可写时静默降级
{
  const dir = tempDir('fail')
  writeFileSync(join(dir, 'blocker'), 'not a directory', 'utf8')
  const log = createRunLog({ dir: join(dir, 'blocker', 'logs') })
  let threw = false
  try {
    log.info('这行写不进去')
    log.error('这行也写不进去')
  }
  catch {
    threw = true
  }
  check('写失败不抛出', !threw, '')
  rmSync(dir, { recursive: true, force: true })
}

// 6：console 抄写
{
  const dir = tempDir('tee')
  const log = createRunLog({ dir })
  const fake = { log: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
  teeConsole(log, fake)
  fake.log('普通输出')
  fake.error('异常输出')
  const body = readFileSync(join(dir, day + '.log'), 'utf8')
  check('console.log 落盘', body.includes('[info] 普通输出'), body)
  check('console.error 落盘', body.includes('[error] 异常输出'), body)
  rmSync(dir, { recursive: true, force: true })
}

// 7：遮蔽函数的边界
{
  const masked = maskSecrets('key=sk-1234567890abcdef token=Bearer abc.def-ghi_123')
  check('边界遮蔽', !masked.includes('sk-1234567890abcdef') && !masked.includes('Bearer abc.def-ghi_123'), masked)
}

const failed = checks.filter(c => !c.ok)
for (const c of checks)
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('RUN_LOG ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
