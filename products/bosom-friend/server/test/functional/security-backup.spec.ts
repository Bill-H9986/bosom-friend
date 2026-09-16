import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { securityHardening } from '../../src/security.ts'

/**
 * 备份轮转的失败语义（security.ts 契约：失败只记录不阻断）。
 *
 * 现实触发面：外部安全守卫拦批量删除、杀软占用、目录被别的进程占住——
 * 此时**必须保留那一份备份并如实记录原因**，绝不能把启动拖死。
 */
const roots: string[] = []
const children: ReturnType<typeof spawn>[] = []
const OLDEST = '2026-09-01T00-00-00-000Z'

function makeRoot(backupCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'bf-sec-'))
  roots.push(root)
  writeFileSync(join(root, 'agent-tasks.json'), JSON.stringify({ schemaVersion: 1, value: [] }), 'utf8')
  for (let i = 0; i < backupCount; i += 1) {
    const stamp = '2026-09-01T00-00-' + String(i).padStart(2, '0') + '-000Z'
    const dir = join(root, 'backups', stamp)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-tasks.json'), '{}', 'utf8')
  }
  return root
}

/** 真实占用注入：让一个子进程把该目录当作工作目录（Windows 下目录被占用即无法删除）。 */
function occupyDir(dir: string): void {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { cwd: dir, stdio: 'ignore' })
  children.push(child)
}

afterEach(async () => {
  // 必须等占用目录的子进程真正退出，否则它会把临时数据根锁住，清理时 EPERM 反而掩盖真实结论。
  await Promise.all(children.splice(0).map(child => new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return }
    child.once('exit', () => resolve())
    child.kill()
    setTimeout(resolve, 3000)
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('备份轮转', () => {
  it('超过上限时清掉最老的，最终保留 30 份', () => {
    const root = makeRoot(31)
    const report = securityHardening(root)
    expect(report.backupAt).not.toBe('')
    expect(report.backupPruneError).toBe('')
    // 31 份历史 + 本轮新增 1 份 = 32，超出 30 需清 2 份
    expect(report.backupPruned).toBe(2)
    const backups = readdirSync(join(root, 'backups'))
    expect(backups.length).toBe(30)
    expect(backups.includes(OLDEST), '最老那份应被清掉').toBe(false)
  })

  it('删除被占用拦下时不抛异常、保留那份并如实记录原因', () => {
    const root = makeRoot(31)
    const oldestDir = join(root, 'backups', OLDEST)
    occupyDir(oldestDir)
    const report = securityHardening(root)
    expect(report.backupAt, '快照本身要写成功').not.toBe('')
    expect(report.backupPruneError, '被拦下必须如实记录原因').not.toBe('')
    expect(existsSync(oldestDir), '删不掉就留着，不许弄丢备份').toBe(true)
    expect(readdirSync(join(root, 'backups')).length).toBeGreaterThan(30)
  })

  it('备份里不含用户大模型密钥文件', () => {
    const root = makeRoot(1)
    writeFileSync(join(root, 'llm-user.json'), JSON.stringify({ apiKey: 'sk-secret' }), 'utf8')
    securityHardening(root)
    const newest = readdirSync(join(root, 'backups')).sort().at(-1)!
    expect(existsSync(join(root, 'backups', newest, 'llm-user.json'))).toBe(false)
  })
})
