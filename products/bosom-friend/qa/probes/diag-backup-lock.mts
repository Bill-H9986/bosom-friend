/** 诊断：为什么"最旧那份被占住"时轮转一次都没清。 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { securityHardening } from '../../server/src/security.ts'

const root = mkdtempSync(join(tmpdir(), 'bf-diag3-'))
writeFileSync(join(root, 'agent-tasks.json'), JSON.stringify({ schemaVersion: 1, value: [] }), 'utf8')
for (let i = 0; i < 31; i += 1) {
  const stamp = '2026-09-01T00-00-' + String(i).padStart(2, '0') + '-000Z'
  const dir = join(root, 'backups', stamp)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-tasks.json'), '{}', 'utf8')
  const seconds = 1_756_684_800 + i * 60
  utimesSync(dir, seconds, seconds)
}
const oldest = join(root, 'backups', '2026-09-01T00-00-00-000Z')
const before = readdirSync(join(root, 'backups')).sort((a, b) => statSync(join(root, 'backups', a)).mtimeMs - statSync(join(root, 'backups', b)).mtimeMs)
console.log('按 mtime 排序的前 3 份=' + JSON.stringify(before.slice(0, 3)))
const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setTimeout(() => {}, 8000)"], { cwd: oldest, stdio: ['ignore', 'pipe', 'ignore'] })
await new Promise<void>((resolve) => { child.stdout.once('data', () => resolve()); setTimeout(resolve, 2000) })
const report = securityHardening(root)
console.log('backupAt=' + String(report.backupAt !== '') + ' backupCount=' + report.backupCount + ' pruned=' + report.backupPruned + ' pruneError=' + JSON.stringify(report.backupPruneError))
const after = readdirSync(join(root, 'backups'))
console.log('后份数=' + after.length + ' 最旧还在=' + String(after.includes('2026-09-01T00-00-00-000Z')))
child.kill()
await new Promise((r) => setTimeout(r, 300))
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
