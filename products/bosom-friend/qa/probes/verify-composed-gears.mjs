#!/usr/bin/env node
/**
 * Verify the two composed video gears (30s / 60s) end to end on the installed build.
 *
 * Why this orchestrator exists: the media budget fix (DEF-107) is only provable when the vendor is
 * slower than the old fixed 15-minute deadline. This starts an isolated installed instance
 * (BOSOM_FRIEND_HOME + BF_DESKTOP_PORT) so the product data root is never touched, then runs the composed
 * probe twice with an injected per-order vendor delay that pushes each run past 15 minutes.
 *
 * Usage: node products/bosom-friend/qa/probes/verify-composed-gears.mjs
 * Exit code: 0 = both gears pass; 1 = at least one failed; 2 = instance did not come up.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(dirname(HERE))
const REPO = dirname(dirname(PRODUCT))
const PROBE = join(PRODUCT, 'qa', 'probes', 'verify-composed-30s.mjs')
const INSTALLED = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const PORT = Number(process.env.BF_GEAR_PORT ?? '') || 31281
const ISO = join(tmpdir(), 'bf-iso-gears')
const DATA_ROOT = join(ISO, 'bosom-friend')

if (!existsSync(INSTALLED)) {
  console.error('installed app not found: ' + INSTALLED)
  process.exit(2)
}
rmSync(ISO, { recursive: true, force: true })
mkdirSync(ISO, { recursive: true })

const log = []
const app = spawn(INSTALLED, [], {
  detached: false,
  stdio: 'ignore',
  // BOSOM_FRIEND_HOME is the variable the packaged runtime actually honors (see
  // bundle/kernel/runtime/bin-desktop.mjs); DSH_HOME is derived from it inside the runtime.
  env: { ...process.env, BOSOM_FRIEND_HOME: ISO, BF_DESKTOP_PORT: String(PORT) },
})
log.push('launched pid=' + String(app.pid) + ' BOSOM_FRIEND_HOME=' + ISO + ' port=' + String(PORT))

/** Poll the app until it answers, or give up. */
async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + String(PORT) + '/bosom-friend/', { signal: AbortSignal.timeout(5000) })
      if (res.ok) return true
    }
    catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 4000))
  }
  return false
}

function runProbe(targetSeconds, vendorDelayMs, deadlineMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PROBE, String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BF_PROBE_VENDOR_DELAY_MS: String(vendorDelayMs),
        BF_PROBE_DEADLINE_MS: String(deadlineMs),
        BF_PROBE_TARGET_SECONDS: String(targetSeconds),
        BF_PROBE_DATA_ROOT: DATA_ROOT,
      },
    })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { out += String(chunk) })
    child.on('close', code => resolve({ code, out }))
  })
}

const ready = await waitReady(6 * 60 * 1000)
log.push('instance ready=' + String(ready))
if (ready) {
  const pricing = await fetch('http://127.0.0.1:' + String(PORT) + '/bosom-friend/api/ai/draft-generation/pricing', { signal: AbortSignal.timeout(20000) })
    .then(res => res.json()).catch(() => null)
  const model = (pricing?.data?.models ?? []).find(item => String(item.name).includes('video'))
  log.push('gears: durations=' + JSON.stringify(model?.durations ?? []) + ' longDurations=' + JSON.stringify(model?.longDurations ?? []))
  log.push('estimates: ' + JSON.stringify(model?.longDurationEstimates ?? {}))
}

/** Delays chosen so each run lasts longer than the retired fixed 15-minute media budget. */
const runs = [
  { seconds: 30, vendorDelayMs: 150_000 },
  { seconds: 60, vendorDelayMs: 70_000 },
]
const results = []
if (ready) {
  for (const run of runs) {
    log.push('')
    log.push('=== gear ' + String(run.seconds) + 's, vendor delay ' + String(run.vendorDelayMs) + ' ms per order ===')
    const result = await runProbe(run.seconds, run.vendorDelayMs, 45 * 60 * 1000)
    results.push({ ...run, code: result.code })
    log.push(result.out.trim())
    log.push('exit=' + String(result.code))
  }
}

try { app.kill() } catch { /* already gone */ }
const report = join(PRODUCT, 'qa', 'reports', 'composed-gears-2026-09-19.txt')
mkdirSync(dirname(report), { recursive: true })
writeFileSync(report, log.join('\n') + '\n', 'utf8')
const failed = results.filter(item => item.code !== 0)
console.log('COMPOSED_GEARS ' + (ready && failed.length === 0 ? 'PASS' : 'FAIL')
  + ' runs=' + String(results.length) + ' fail=' + String(failed.length) + ' report=' + report)
process.exit(ready && failed.length === 0 ? 0 : ready ? 1 : 2)
