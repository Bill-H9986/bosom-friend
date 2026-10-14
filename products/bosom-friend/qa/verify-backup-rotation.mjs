#!/usr/bin/env node
/**
 * 备份轮转的行为验收：产品自己的备份按修改时间轮转，用户手工放的目录一律不动（DEF-109）。
 *
 * 背景：现场一次手工备份 `backups/手工删数据前的全量/` 在下次启动时被当成"最旧的一份"删掉
 * ——旧实现把 `readdirSync(backups).sort()` 的第一项直接 rmSync，字符串排序让非数字开头的目录排最前，
 * 用户手里唯一的退路就此消失，而且没有任何日志留下是谁删的。
 *
 * 断言（真跑构建产物、用临时数据根，不碰真实数据）：
 *   1. 手工命名的备份目录在多轮轮转后仍然存在，且内容原样；
 *   2. 产品自己命名的时间戳备份超上限时被清掉，**先删修改时间最旧的那一份**；
 *   3. 被删掉的那一份在 stderr 上有记录（备份是用户的退路，删了必须留痕）。
 *
 * 用法：node products/bosom-friend/qa/verify-backup-rotation.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 缺少构建产物（环境未就绪）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const built = join(productRoot, 'server', 'lib', 'types', 'security.js')
if (!existsSync(built)) {
  console.error('BACKUP_ROTATION SKIP missing=' + built)
  process.exit(2)
}

const mod = await import(pathToFileURL(built).href)
const checks = []
/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) { checks.push({ name, ok, detail: detail ?? '' }) }

const root = mkdtempSync(join(tmpdir(), 'bf-backup-'))
const backups = join(root, 'backups')
mkdirSync(backups, { recursive: true })
// 数据根里放一份全量 JSON：轮转的输入；密钥文件不该被复制进备份。
writeFileSync(join(root, 'contents.json'), JSON.stringify({ list: [] }), 'utf8')
writeFileSync(join(root, 'llm-user.json'), JSON.stringify({ apiKey: 'secret' }), 'utf8')

// 用户手工备份：字母开头（旧实现里排最前、最容易被删），且修改时间最旧。
const manual = join(backups, 'AAA-手工删数据前的全量')
mkdirSync(manual, { recursive: true })
writeFileSync(join(manual, 'contents.json'), JSON.stringify({ manual: true }), 'utf8')
const ancient = new Date(Date.now() - 40 * 24 * 3600 * 1000)
utimesSync(manual, ancient, ancient)

// 31 份产品命名的备份（超过低配档 10 份、标准档 30 份两个上限），时间戳按序号递增。
const stamp = index => '2026-09-' + String(10 + index).padStart(2, '0') + 'T00-00-00-000Z'
for (let i = 0; i < 31; i += 1) {
  const dir = join(backups, stamp(i))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'contents.json'), JSON.stringify({ index: i }), 'utf8')
  const when = new Date(Date.now() - (31 - i) * 3600 * 1000)
  utimesSync(dir, when, when)
}

const originalError = console.error
const logged = []
console.error = (...args) => { logged.push(args.map(String).join(' ')) }
const report = mod.securityHardening(root)
console.error = originalError

check('手工备份目录还在', existsSync(manual), manual)
check(
  '手工备份里的内容原样',
  existsSync(join(manual, 'contents.json')) && readFileSync(join(manual, 'contents.json'), 'utf8').includes('manual'),
  '',
)
check('产品备份份数收敛到保留上限以内', report.backupCount > 0 && report.backupCount <= 30, String(report.backupCount))
check('确实清理掉了一部分（31 份超过上限）', report.backupPruned > 0, String(report.backupPruned))
check(
  '先删的是修改时间最旧的那一份（0 号）',
  !existsSync(join(backups, stamp(0))) && existsSync(join(backups, stamp(30))),
  readdirSync(backups).join(','),
)
check(
  '被删掉的那一份在 stderr 留痕',
  logged.some(line => line.includes('备份轮转已删除')),
  JSON.stringify(logged).slice(0, 300),
)
check(
  '轮转一次都没碰手工目录',
  !logged.some(line => line.includes('AAA-手工删数据前的全量')),
  JSON.stringify(logged).slice(0, 300),
)
check(
  '密钥文件不进备份快照',
  readdirSync(backups).every(name => !existsSync(join(backups, name, 'llm-user.json'))),
  '',
)

rmSync(root, { recursive: true, force: true })
const failed = checks.filter(c => !c.ok)
for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('BACKUP_ROTATION ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
