import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

/**
 * 造一个带 N 份历史备份的数据根。
 *
 * 目录名必须匹配产品自己的命名（`PRODUCT_BACKUP_NAME`），并且**显式设置修改时间**：
 * 轮转是按 mtime 排"谁最旧"的（同名次才回落到比较名字），而一秒内建出来的 31 个目录
 * mtime 会并列——那样"最旧的是哪一份"就变成看调度，用例随之抖动（实测 2026-09-20 夜）。
 *
 * @param backupCount - 历史备份份数。
 * @returns 数据根路径。
 */
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

/**
 * 显式把历史备份按名字排成"第 0 份最旧"，每份间隔一分钟。
 *
 * 必须**在占用之后**再调：Windows 上把某个目录设为子进程的当前工作目录会刷新它的目录修改时间，
 * 而轮转是按 mtime 排"谁最旧"的。先定序再占用，被占住的那份就会变成"最新"，轮转压根不会碰它——
 * 断言于是拿到空错误（实测 2026-09-20：六连跑失败六次，误以为是产品不报错）。
 *
 * @param root - 数据根路径。
 */
function orderBackupsByAge(root: string): void {
  const names = readdirSync(join(root, 'backups')).filter(name => name.startsWith('2026-09-01')).sort()
  for (const [index, name] of names.entries()) {
    const seconds = 1_756_684_800 + index * 60
    utimesSync(join(root, 'backups', name), seconds, seconds)
  }
}

/**
 * 真实占用注入：让一个子进程把该目录当作工作目录并**打开一个句柄**，保持 8 秒。
 *
 * 为什么必须等它回报 ready：spawn 是异步的，父进程会在子进程真正拿到 cwd 之前就继续跑。
 * 实测（2026-09-20 夜）这条用例因此时红时绿——子进程还没起来，轮转就把目录删掉了，
 * 于是"被拦下必须如实记录原因"断言拿到空串。这里让子进程在拿到 cwd 后写一行 ready，
 * 父进程等到那个字节再继续：占用是**确定的**，不再是抢时序。
 *
 * 占用方式也验证过：目录被某个进程当作 cwd 时，Windows 的 `rmSync` 必然 EPERM
 * （只读文件不拦——`force: true` 会先清只读位；打开文件句柄也不拦，实测 2026-09-20）。
 *
 * @param dir - 要被占住的目录。
 * @returns ready 时 resolve；2 秒内没等到也 resolve（不让用例挂死，但此时占用不保证）。
 */
function occupyDir(dir: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', "const fs=require('node:fs');try{fs.openSync('.occupied','w')}catch{};process.stdout.write('ready');setTimeout(() => {}, 8000)"],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  children.push(child)
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => { if (!settled) { settled = true; resolve() } }
    child.stdout?.once('data', done)
    child.once('exit', done)
    setTimeout(done, 2000)
  })
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

  it('删除被拦下时不抛异常、保留那份并如实记录原因', async () => {
    const root = makeRoot(31)
    const oldestDir = join(root, 'backups', OLDEST)
    await occupyDir(oldestDir)
    // 占用之后重新定序：被占住的那份必须是确定最旧的一份，轮转才会真的碰它。
    orderBackupsByAge(root)
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

  /**
   * DEF-109 回归：手工建的备份目录不能被轮转当成"最旧的一份"清掉。
   *
   * 旧实现按名字排序取最旧，字母开头的目录必然排最前，于是用户手工做的全量备份
   * （实测 `backups/手工删数据前的全量/`）在下一次启动时被无声删除。
   */
  it('手工命名的备份目录不参与轮转（哪怕它最旧）', () => {
    const root = makeRoot(31)
    const manual = join(root, 'backups', 'AAA-手工删数据前的全量')
    mkdirSync(manual, { recursive: true })
    writeFileSync(join(manual, 'contents.json'), '{"manual":true}', 'utf8')
    const ancient = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    utimesSync(manual, ancient, ancient)
    securityHardening(root)
    expect(existsSync(join(manual, 'contents.json')), '手工备份必须还在').toBe(true)
  })

  /**
   * DEF-109 回归：淘汰看修改时间，不看名字。
   *
   * 名字字典序在"产品自己的 ISO 时间戳"上恰好等于时间序，所以这条要造一个反例：
   * 字典序最小的一份其实最新——按名字删就会删错。
   */
  it('淘汰以修改时间为准（名字最小的那份如果最新，必须留下）', () => {
    const root = makeRoot(31)
    const newest = join(root, 'backups', OLDEST)
    const now = new Date()
    utimesSync(newest, now, now)
    securityHardening(root)
    expect(existsSync(newest), '最新的一份不能被名字序当成最旧').toBe(true)
  })
})
