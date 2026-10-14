import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { perfTier } from '../../src/perf.ts'
import { securityHardening } from '../../src/security.ts'

/**
 * 性能档位契约：档位只由桌面壳探测写入，未探测时一律标准档。
 *
 * 这里钉住三件容易出错的事：没探测就降载（所有机器被拖慢）、上限串损坏连档位一起丢
 * （低配机器退回 30 份备份 + 10 分钟轮询）、以及低配上限真的作用到备份轮转上。
 */
const roots: string[] = []
const ENV_KEYS = ['BF_PERF_PROFILE', 'BF_PERF_CAPS'] as const
const saved = new Map<string, string | undefined>()

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function makeRoot(backupCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'bf-perf-'))
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

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('性能档位', () => {
  it('没有探测结果时按标准档运行（不擅自降载）', () => {
    setEnv({ BF_PERF_PROFILE: undefined, BF_PERF_CAPS: undefined })
    const tier = perfTier()
    expect(tier.tier).toBe('standard')
    expect(tier.source).toBe('default')
    expect(tier.caps.backupKeep).toBe(30)
    expect(tier.caps.receptionIntervalMinutes).toBe(10)
    expect(tier.caps.heavyEffects).toBe(true)
  })

  it('低配档位的上限来自桌面壳实测值', () => {
    setEnv({
      BF_PERF_PROFILE: 'low',
      BF_PERF_CAPS: JSON.stringify({ backupKeep: 8, maxOldSpaceMb: 900, receptionIntervalMinutes: 25, heavyEffects: false, startupWaitSeconds: 240, slowAfterMs: 240000 }),
    })
    const tier = perfTier()
    expect(tier.tier).toBe('low')
    expect(tier.source).toBe('env')
    expect(tier.caps.backupKeep).toBe(8)
    expect(tier.caps.maxOldSpaceMb).toBe(900)
    expect(tier.caps.receptionIntervalMinutes).toBe(25)
    expect(tier.caps.heavyEffects).toBe(false)
  })

  it('上限串损坏时仍按低配档默认上限运行，不退回标准档', () => {
    setEnv({ BF_PERF_PROFILE: 'low', BF_PERF_CAPS: '{ this is not json' })
    const tier = perfTier()
    expect(tier.tier).toBe('low')
    expect(tier.caps.backupKeep).toBe(10)
    expect(tier.caps.heavyEffects).toBe(false)
  })

  it('字段类型不对的单项被忽略，其余项仍然生效', () => {
    setEnv({ BF_PERF_PROFILE: 'low', BF_PERF_CAPS: JSON.stringify({ backupKeep: '10', maxOldSpaceMb: 768 }) })
    const tier = perfTier()
    expect(tier.caps.backupKeep, '字符串不是合法份数，按低配默认 10 处理').toBe(10)
    expect(tier.caps.maxOldSpaceMb).toBe(768)
  })

  it('低配档下备份轮转真的只保留 10 份', () => {
    setEnv({ BF_PERF_PROFILE: 'low', BF_PERF_CAPS: JSON.stringify({ backupKeep: 10 }) })
    const root = makeRoot(12)
    const report = securityHardening(root)
    expect(report.backupAt).not.toBe('')
    // 12 份历史 + 本轮新增 1 份 = 13，超出 10 需清 3 份
    expect(report.backupPruned).toBe(3)
    expect(readdirSync(join(root, 'backups')).length).toBe(10)
  })
})
