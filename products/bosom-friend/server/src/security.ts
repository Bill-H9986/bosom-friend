/**
 * security - 数据安全自动加固（零用户操作）
 *
 * 启动时自动执行，失败只记录不阻断：
 *   1) ACL 收紧：数据根仅当前用户可读写（继承移除 + 仅授本人）；
 *   2) 备份轮转：全量 JSON 快照至 <root>/backups/<时间戳>/，标准档保留最近 30 份、低配档 10 份；
 *   3) 自检报告：<root>/security.json（回环/备份/ACL/完整性，供 UI 展示）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { perfTier } from './perf.ts'
import { writeDataJson } from './store.ts'

export interface SecurityReport {
  at: string
  loopback: boolean
  acl: 'tightened' | 'not-tightened' | 'skipped'
  backupAt: string
  backupCount: number
  backupRoot: string
  integrity: 'ok' | 'warn'
  /** 本轮真正删除的旧备份份数（0 表示没超上限，或删除被外部拦下）。 */
  backupPruned: number
  /** 轮转被拦下时的原因（外部安全守卫/杀软/占用）；空串表示正常。 */
  backupPruneError: string
}

/** 数据完整性：所有根级 JSON 可解析（损坏即 warn，不阻断）。 */
function integrityOk(dir: string): boolean {
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.json')) {
        const p = join(dir, name)
        if (statSync(p).size > 0) JSON.parse(readFileSync(p, 'utf8'))
      }
    }
    return true
  } catch { return false }
}

/** ACL 收紧（Windows icacls）：移除继承并仅授当前用户；非 Windows/失败 → not-tightened。 */
function tightenAcl(dir: string): SecurityReport['acl'] {
  try {
    if (process.platform !== 'win32') return 'skipped'
    const user = process.env.USERNAME || ''
    if (user === '') return 'skipped'
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'], { stdio: 'pipe', timeout: 15000 })
    return 'tightened'
  } catch { return 'not-tightened' }
}

/**
 * 产品自己生成的备份目录名：`new Date().toISOString()` 把 `:` 与 `.` 换成 `-` 之后的形状。
 *
 * 它把"产品轮转出来的备份"与"用户/工具手工放的目录"分开：只有前者会被自动清理（DEF-109）。
 */
const PRODUCT_BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

/**
 * 这个路径是不是目录（用来排除同名的文件）。
 *
 * @param path - 绝对路径。
 * @returns 存在且是目录时为 true。
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

/**
 * 备份的新旧比较：以目录的修改时间为准，取不到时间才退回名字。
 *
 * 为什么不用名字排序：产品自己的名字是 ISO 时间戳，字典序恰好等于时间序，
 * 但只要有一份不是这个格式（历史版本、手工改名），字典序就会把它排到最前面当成最旧的一份。
 *
 * @param root - `<root>/backups` 目录。
 * @param a - 备份目录名。
 * @param b - 备份目录名。
 * @returns 可供 Array.sort 使用的比较值（旧的在前）。
 */
function compareBackupAge(root: string, a: string, b: string): number {
  const at = backupMtimeMs(root, a)
  const bt = backupMtimeMs(root, b)
  if (at !== bt) return at - bt
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 一份备份目录的修改时间（毫秒）。
 *
 * @param root - `<root>/backups` 目录。
 * @param name - 备份目录名。
 * @returns 毫秒时间戳；读不到时为 0（当作最旧的一份）。
 */
function backupMtimeMs(root: string, name: string): number {
  try {
    return statSync(join(root, name)).mtimeMs
  }
  catch {
    return 0
  }
}
/**
 * 备份轮转：<root>/backups/<ts>/ 快照 JSON，保留最近 N 份（N 由性能档位给出：
 * 低配机器磁盘紧张，30 份全量快照既占空间又拖慢启动）。
 *
 * 删除失败（外部安全守卫拦批量删除、杀软占用、目录被锁）**只保留那一份并如实记录**：
 * 多留几份备份的代价远小于启动失败。此前这里是无保护的 rmSync，与"失败不阻断启动"的契约相抵。
 *
 * @param dir - 产品数据根。
 * @returns 本轮快照时间、份数、实际清理份数与清理失败原因。
 */
function backupData(dir: string): { at: string; count: number; pruned: number; pruneError: string } {
  const backupsRoot = join(dir, 'backups')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(backupsRoot, ts)
  // 用户大模型 Key 是敏感凭据，不允许随普通 JSON 备份轮转复制扩散。
  const entries = readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'llm-user.json')
  try {
    mkdirSync(target, { recursive: true })
    for (const name of entries) cpSync(join(dir, name), join(target, name), { recursive: true })
  } catch { return { at: '', count: 0, pruned: 0, pruneError: '' } }
  const all = existsSync(backupsRoot) ? readdirSync(backupsRoot) : []
  const count = all.length
  const keep = perfTier().caps.backupKeep
  // 只轮转**产品自己按时间戳命名**的那些目录：手工建的备份（任意名字）不在清理范围内。
  // 实测踩过：一次手工备份 `backups/手工删数据前的全量/` 在下次启动时被当成"最旧的一份"删掉，
  // 用户手里唯一的退路就此消失。
  const ours = all.filter(name => PRODUCT_BACKUP_NAME.test(name) && isDirectory(join(backupsRoot, name)))
  ours.sort((a, b) => compareBackupAge(backupsRoot, a, b))
  let pruned = 0
  let pruneError = ''
  while (ours.length > keep) {
    const oldest = ours.shift()
    if (oldest === undefined) break
    try {
      rmSync(join(backupsRoot, oldest), { recursive: true, force: true })
      pruned += 1
      // 删了哪一份要留痕：备份是用户最后的退路，删掉却无人知晓是不可接受的。
      console.error('[security] 备份轮转已删除 ' + oldest + '（保留最近 ' + String(keep) + ' 份）')
    }
    catch (error) {
      pruneError = error instanceof Error ? error.message : String(error)
      break
    }
  }
  return { at: ts, count: Math.min(count, keep), pruned, pruneError }
}

/** 启动加固入口：备份 → ACL 收紧 → 完整性 → 写 security.json（失败均不阻断启动）。 */
export function securityHardening(dataRoot: string): SecurityReport {
  const backup = backupData(dataRoot)
  const acl = tightenAcl(dataRoot)
  const report: SecurityReport = {
    at: new Date().toISOString(),
    loopback: true,
    acl,
    backupAt: backup.at,
    backupCount: backup.count,
    backupRoot: join(dataRoot, 'backups'),
    integrity: integrityOk(dataRoot) ? 'ok' : 'warn',
    backupPruned: backup.pruned,
    backupPruneError: backup.pruneError,
  }
  try { writeDataJson(join(dataRoot, 'security.json'), report) } catch { /* 写失败不影响启动 */ }
  return report
}
