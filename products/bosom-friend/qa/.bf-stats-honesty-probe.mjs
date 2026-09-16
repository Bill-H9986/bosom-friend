#!/usr/bin/env node
/**
 * 账号数据诚实化探针（临时验证脚本）：
 * 用源码直接装载产品服务插件，在独立端口 + 独立数据根上验证
 *  - GET .../analytics 是纯读（不改写 lastStatsTime、不落盘）
 *  - POST .../analytics/refresh 如实回传"没刷新"的原因 / "已开始采集"
 *  - lastStatsTime 只在真实采集成功后前进
 * 真实平台采集是只读采集（拉作品/资料），不发布、不删账号。
 */
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const PORT = Number(process.env.BF_PROBE_PORT ?? 31281)
const REAL_HOME = join(homedir(), '.bosom-friend', 'bosom-friend')
const TEMP_ROOT = join(process.env.TEMP ?? process.env.TMP ?? '.', 'bf-stats-probe-' + Date.now())
mkdirSync(TEMP_ROOT, { recursive: true })

// 只复制账号/分组到临时根：真实数据根全程只读。
copyFileSync(join(REAL_HOME, 'accounts.json'), join(TEMP_ROOT, 'accounts.json'))
if (existsSync(join(REAL_HOME, 'account-groups.json')))
  copyFileSync(join(REAL_HOME, 'account-groups.json'), join(TEMP_ROOT, 'account-groups.json'))
writeFileSync(join(TEMP_ROOT, 'reception-status.json'), JSON.stringify({ enabled: false }), 'utf8')

const envelope = JSON.parse(readFileSync(join(TEMP_ROOT, 'accounts.json'), 'utf8'))
const accounts = Array.isArray(envelope) ? envelope : envelope.value
const real = accounts.find(a => a.type === 'douyin' && typeof a.loginCookie === 'string' && a.loginCookie !== '')
if (real === undefined) { console.log('SKIP: 临时根里没有带 cookie 的真实抖音账号'); process.exit(0) }
accounts.push({
  id: 'acc-probe-badcookie', type: 'douyin', uid: 'probe-badcookie', avatar: '', nickname: '探针·坏Cookie',
  loginCookie: 'this-is-not-json', fansCount: 7, followingCount: 1, workCount: 2, income: 0,
  status: 1, rank: 900, groupId: 'grp-default', clientType: 'plugin',
})
accounts.push({
  id: 'acc-probe-wxsph', type: 'wxSph', uid: 'probe-wxsph', avatar: '', nickname: '探针·未接入平台',
  loginCookie: '[]', fansCount: 3, followingCount: 1, workCount: 1, income: 0,
  status: 1, rank: 901, groupId: 'grp-default', clientType: 'plugin',
})
writeFileSync(join(TEMP_ROOT, 'accounts.json'), JSON.stringify({ ...(Array.isArray(envelope) ? {} : { schemaVersion: envelope.schemaVersion }), value: accounts }, null, 2), 'utf8')

const { apply } = await import('../server/src/api.ts')

const registrations = []
const ctx = {
  get: name => (name === 'webServer'
    ? { register: (entry) => { registrations.push(entry); return () => {} } }
    : undefined),
  effect: (fn) => { const disposer = fn(); return () => { disposer?.() } },
}
apply(ctx, { dataRoot: TEMP_ROOT, frontendDist: '', authEnabled: false, kernelAi: false })
if (registrations.length === 0) { console.log('FAIL: 插件没有注册任何 web 路由'); process.exit(1) }

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const entry = registrations
    .filter(item => item.kind !== 'prefix' || url.pathname.startsWith(item.path))
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0]
  if (entry === undefined) { res.writeHead(404); res.end('no route'); return }
  try { await entry.handler(req, res) }
  catch (error) { res.writeHead(500); res.end('handler error: ' + String(error)) }
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))

const BASE = 'http://127.0.0.1:' + PORT + '/bosom-friend/api/'
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data }
}
const accountsFile = join(TEMP_ROOT, 'accounts.json')
const accountsDigest = () => createHash('sha256').update(readFileSync(accountsFile)).digest('hex').slice(0, 16)
const disk = (id) => {
  const parsed = JSON.parse(readFileSync(accountsFile, 'utf8'))
  const list = Array.isArray(parsed) ? parsed : parsed.value
  return list.find(a => a.id === id) ?? {}
}
const out = { tempRoot: TEMP_ROOT, account: real.id, steps: [] }

// (1) 纯读：两次 GET 不得改写 lastStatsTime，也不得落盘
const digestBefore = accountsDigest()
const g1 = await call('GET', 'v2/channels/accounts/' + real.id + '/analytics')
await new Promise(r => setTimeout(r, 400))
const g2 = await call('GET', 'v2/channels/accounts/' + real.id + '/analytics')
out.steps.push({
  step: 'GET x2 纯读',
  http: [g1.http, g2.http], code: [g1.code, g2.code],
  lastStatsTime: [g1.data?.lastStatsTime, g2.data?.lastStatsTime],
  fans: [g1.data?.fansCount, g2.data?.fansCount],
  syncNote: [g1.data?.syncNote ?? '', g2.data?.syncNote ?? ''],
  accountsJsonChanged: digestBefore !== accountsDigest(),
})

// (2) 未接入平台的账号：必须回失败与原因，不能回 code 0
const bad = await call('POST', 'v2/channels/accounts/acc-probe-wxsph/analytics/refresh', {})
out.steps.push({ step: 'refresh 未接入平台', http: bad.http, code: bad.code, message: bad.message })

// (3) Cookie 损坏：失败必须如实回传
const broken = await call('POST', 'v2/channels/accounts/acc-probe-badcookie/analytics/refresh', {})
out.steps.push({ step: 'refresh Cookie 损坏', http: broken.http, code: broken.code, message: broken.message })

// (4) 真实账号：触发真实采集，失败或"已开始"，绝不谎报完成
const before = disk(real.id)
const t0 = Date.now()
const started = await call('POST', 'v2/channels/accounts/' + real.id + '/analytics/refresh', {})
out.steps.push({
  step: 'refresh 真实账号',
  http: started.http, code: started.code,
  refreshStatus: started.data?.refreshStatus, message: started.message ?? started.data?.message,
  diskFansBefore: before.fansCount, diskLastStatsBefore: before.lastStatsTime,
  elapsedMs: Date.now() - t0,
})

// (5) 立刻再触发：必须如实说在刷新间隔内
const again = await call('POST', 'v2/channels/accounts/' + real.id + '/analytics/refresh', {})
out.steps.push({ step: 'refresh 立刻重试', code: again.code, refreshStatus: again.data?.refreshStatus, message: again.data?.message })

// (6) 轮询纯读接口等真实采集落盘：只有真实采集成功，lastStatsTime 才前进
let advanced = null
const digestDuring = accountsDigest()
for (let i = 0; i < 24; i += 1) {
  await new Promise(r => setTimeout(r, 2500))
  const read = await call('GET', 'v2/channels/accounts/' + real.id + '/analytics')
  const row = disk(real.id)
  if (row.lastStatsTime !== before.lastStatsTime) {
    advanced = { atMs: Date.now() - t0, viaRead: read.data?.lastStatsTime, disk: row.lastStatsTime, fans: row.fansCount, works: row.workCount, error: row.lastStatsError ?? '' }
    break
  }
  if (typeof row.lastStatsError === 'string' && row.lastStatsError !== '') {
    advanced = { atMs: Date.now() - t0, failed: row.lastStatsError }
    break
  }
}
out.steps.push({ step: '真实采集结果', advanced, accountsJsonChangedSinceBeforePolling: digestDuring !== accountsDigest() })

// (7) 采集结束后：连续 GET 既不能落盘，也不能再触发平台采集
const syncDir = join(TEMP_ROOT, 'platform-login', 'sync')
const syncTasks = () => (existsSync(syncDir) ? readdirSync(syncDir).length : 0)
const readProof = []
for (let i = 0; i < 3; i += 1) {
  const digestPre = accountsDigest()
  const tasksPre = syncTasks()
  const read = await call('GET', 'v2/channels/accounts/' + real.id + '/analytics')
  readProof.push({
    code: read.code, lastStatsTime: read.data?.lastStatsTime,
    accountsJsonChanged: digestPre !== accountsDigest(),
    syncTasksBefore: tasksPre, syncTasksAfter: syncTasks(),
  })
  await new Promise(r => setTimeout(r, 1200))
}
out.steps.push({ step: '采集后 GET x3 纯读', readProof })
const finalRow = disk(real.id)
out.steps.push({
  step: '最终落库',
  lastStatsTime: finalRow.lastStatsTime, lastStatsAttemptTime: finalRow.lastStatsAttemptTime ?? '',
  lastStatsError: finalRow.lastStatsError ?? '', fansCount: finalRow.fansCount, workCount: finalRow.workCount,
})
console.log(JSON.stringify(out, null, 2))
server.close()
await new Promise(r => setTimeout(r, 500))
process.exit(0)
