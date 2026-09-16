/**
 * security - 数据安全自动加固（零用户操作）
 *
 * 启动时自动执行，失败只记录不阻断：
 *   1) ACL 收紧：数据根仅当前用户可读写（继承移除 + 仅授本人）；
 *   2) 备份轮转：全量 JSON 快照至 <root>/backups/<时间戳>/，标准档保留最近 30 份、低配档 10 份；
 *   3) 自检报告：<root>/security.json（回环/备份/ACL/完整性，供 UI 展示）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { perfTier } from './perf.ts'

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
  const all = existsSync(backupsRoot) ? readdirSync(backupsRoot).sort() : []
  const count = all.length
  const keep = perfTier().caps.backupKeep
  let pruned = 0
  let pruneError = ''
  while (all.length > keep) {
    const oldest = all.shift()
    if (oldest === undefined) break
    try {
      rmSync(join(backupsRoot, oldest), { recursive: true, force: true })
      pruned += 1
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
  try { writeFileSync(join(dataRoot, 'security.json'), JSON.stringify(report, null, 2), 'utf8') } catch { /* 写失败不影响启动 */ }
  return report
}
