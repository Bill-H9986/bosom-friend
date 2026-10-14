#!/usr/bin/env node
/**
 * 生成任务停滞判定的行为验收：卡住的任务必须能被判失败，且已生成的文案保留可用。
 *
 * 背景（DEF-083）：一次图文生成在 2026-09-18T04:17:55Z 之后再无进展，38 分钟后仍停在
 * generating——界面一直转圈，用户既不知道发生了什么，也拿不到已经生成好的文案。
 * 判定逻辑因此必须是可离线验证的纯函数，而不是埋在定时器里无法复现。
 *
 * 断言（真实执行编译产物，不打桩）：
 *   1. 预算：图文 10 分钟、视频 20 分钟、未声明类型回退图文预算；视频媒体预算按档位推导（DEF-107）；
 *   2. 只在 generating + 超过预算时判停滞，边界值（正好等于预算）不误杀；
 *   3. updatedAt 缺失时回退 createdAt；
 *   4. 判失败后保留 response 与 points，updatedAt 刷新，文案说明"已保留/请重新生成"。
 *
 * 用法：node products/bosom-friend/qa/verify-generation-watchdog.mjs
 * 退出码：0 = 通过；1 = 失败；2 = 缺少构建产物（环境未就绪）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const productRoot = join(qaDir, '..')
const built = join(productRoot, 'server', 'lib', 'types', 'generation-watchdog.js')

if (!existsSync(built)) {
  console.error('缺少构建产物，请先执行 pnpm --filter @deepseek-ai/dsh-bosom-friend-server build')
  console.error('GENERATION_WATCHDOG SKIP missing=' + built)
  process.exit(2)
}

const mod = await import(pathToFileURL(built).href)
const { generationBudgetMs, findStalledGenerations, markStalledGenerations, stalledErrorMessage, mediaBudgetMs, mediaTimeoutMessage } = mod
const checks = []

/** @param name - 断言名。 @param ok - 是否通过。 @param detail - 失败证据。 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail ?? '' })
}

const now = Date.parse('2026-09-18T05:00:00.000Z')
/** @param minutes - 距今多少分钟。 @returns ISO 时间。 */
const ago = minutes => new Date(now - minutes * 60_000).toISOString()
/** @param over - 覆盖字段。 @returns 生成记录。 */
const gen = over => ({
  id: 'gen-x',
  status: 'generating',
  createdAt: ago(30),
  updatedAt: ago(30),
  request: { kind: 'image-text' },
  ...over,
})

// 1) 预算
check('图文预算 10 分钟', generationBudgetMs('image-text') === 10 * 60_000, String(generationBudgetMs('image-text')))
check('视频预算 20 分钟', generationBudgetMs('video') === 20 * 60_000, String(generationBudgetMs('video')))
check('未知类型回退图文预算', generationBudgetMs(undefined) === generationBudgetMs('image-text'), String(generationBudgetMs(undefined)))

// 2) 停滞判定与边界
const stalled1 = findStalledGenerations([gen({ updatedAt: ago(11) })], now)
check('停滞 11 分钟判停滞', stalled1.length === 1, String(stalled1.length))
check('停滞 9 分钟不判', findStalledGenerations([gen({ updatedAt: ago(9) })], now).length === 0, '')
check('正好等于预算不判', findStalledGenerations([gen({ updatedAt: new Date(now - 10 * 60_000).toISOString() })], now).length === 0, '')
check('已完成任务不判', findStalledGenerations([gen({ status: 'success', updatedAt: ago(99) })], now).length === 0, '')
check('视频 15 分钟不判', findStalledGenerations([gen({ request: { kind: 'video' }, updatedAt: ago(15) })], now).length === 0, '')
check('视频 21 分钟判停滞', findStalledGenerations([gen({ request: { kind: 'video' }, updatedAt: ago(21) })], now).length === 1, '')

// 2b) 媒体硬预算：必须小于停滞预算，先由截止时间收尾，看门狗只兜底无主记录
check('图文媒体预算 8 分钟', mediaBudgetMs('image-text') === 8 * 60_000, String(mediaBudgetMs('image-text')))
check('视频媒体预算 15 分钟', mediaBudgetMs('video') === 15 * 60_000, String(mediaBudgetMs('video')))
check('未知类型按图文媒体预算', mediaBudgetMs(undefined) === mediaBudgetMs('image-text'), String(mediaBudgetMs(undefined)))
check(
  '媒体预算 < 停滞预算（图文）',
  mediaBudgetMs('image-text') < generationBudgetMs('image-text'),
  mediaBudgetMs('image-text') + ' vs ' + generationBudgetMs('image-text'),
)
check(
  '媒体预算 < 停滞预算（视频）',
  mediaBudgetMs('video') < generationBudgetMs('video'),
  mediaBudgetMs('video') + ' vs ' + generationBudgetMs('video'),
)
check('媒体超时文案说明已保留', mediaTimeoutMessage(8 * 60_000, true).includes('已保留'), mediaTimeoutMessage(8 * 60_000, true))
check('媒体超时文案含分钟', mediaTimeoutMessage(8 * 60_000, false).includes('8 分钟'), mediaTimeoutMessage(8 * 60_000, false))

// 2c) 媒体预算按档位推导（DEF-107）：定值 15 分钟会把 30 秒 / 1 分钟档的成片判死
check(
  '视频无档位时媒体预算仍是 15 分钟（行为不变）',
  mediaBudgetMs('video') === 15 * 60_000,
  String(mediaBudgetMs('video')),
)
check(
  '30 秒档（7 片）预算大于旧的 15 分钟定值',
  mediaBudgetMs('video', { duration: 30 }) > 15 * 60_000,
  String(mediaBudgetMs('video', { duration: 30 })),
)
check(
  '60 秒档（15 片）预算大于 30 秒档',
  mediaBudgetMs('video', { duration: 60 }) > mediaBudgetMs('video', { duration: 30 }),
  mediaBudgetMs('video', { duration: 60 }) + ' vs ' + mediaBudgetMs('video', { duration: 30 }),
)
check(
  '部署上限只收紧不放大（配 20 分钟就更短，配 0/非法等于没配）',
  mediaBudgetMs('video', { duration: 60, maxMs: 20 * 60_000 }) === 20 * 60_000
    && mediaBudgetMs('video', { duration: 60, maxMs: 0 }) === mediaBudgetMs('video', { duration: 60 })
    && mediaBudgetMs('video', { duration: 60, maxMs: Number.NaN }) === mediaBudgetMs('video', { duration: 60 }),
  String(mediaBudgetMs('video', { duration: 60, maxMs: 20 * 60_000 })),
)
check(
  '同档位的停滞预算比媒体截止时间更宽（正常拼接不会被看门狗判失败）',
  [30, 60, 300].every(seconds => generationBudgetMs('video', seconds) > mediaBudgetMs('video', { duration: seconds })),
  String(generationBudgetMs('video', 60)) + ' vs ' + String(mediaBudgetMs('video', { duration: 60 })),
)
check(
  '媒体超时文案里的分钟数跟着真实预算走（不再是固定 15 分钟）',
  mediaTimeoutMessage(mediaBudgetMs('video', { duration: 30 }), true).includes('34 分钟'),
  mediaTimeoutMessage(mediaBudgetMs('video', { duration: 30 }), true),
)

// 3) updatedAt 缺失回退 createdAt
check(
  'updatedAt 缺失回退 createdAt',
  findStalledGenerations([gen({ updatedAt: '', createdAt: ago(30) })], now).length === 1,
  '',
)

// 4) 判失败后的记录状态
{
  const list = [gen({ updatedAt: ago(12), response: { title: 'T', description: '已经写好的文案' } })]
  const marked = markStalledGenerations(list, now, '2026-09-18T05:00:00.000Z')
  const row = list[0]
  check('返回被判停滞的记录', marked.length === 1 && marked[0].id === 'gen-x', String(marked.length))
  check('状态改为 failed', row.status === 'failed', String(row.status))
  check('保留已生成文案', row.response?.description === '已经写好的文案', String(row.response?.description))
  check('更新时间刷新', row.updatedAt === '2026-09-18T05:00:00.000Z', String(row.updatedAt))
  check('文案说明已保留', String(row.errorMessage).includes('已保留'), String(row.errorMessage))
}
{
  const list = [gen({ updatedAt: ago(12) })]
  markStalledGenerations(list, now, '2026-09-18T05:00:00.000Z')
  check('无文案时提示重新生成', String(list[0].errorMessage).includes('请重新生成'), String(list[0].errorMessage))
}
check('停滞文案含分钟数', stalledErrorMessage(12 * 60_000, true).includes('12 分钟'), stalledErrorMessage(12 * 60_000, true))

// 5) 服务端接线（静态，但缺一即"看门狗不会被启动"）
const api = readFileSync(join(productRoot, 'server', 'src', 'api.ts'), 'utf8')
check('api 装载运行日志', api.includes('installRuntimeLog('), '')
check('api 启动看门狗', api.includes('startGenerationWatchdog()') && api.includes('markStalledGenerations('), '')
check('媒体生成有心跳', api.includes('心跳写失败不影响生成'), '')
check('媒体步骤有硬截止时间', api.includes('Promise.race([') && api.includes('媒体超时收尾'), '')
check('看门狗定时器随插件卸载清理', api.includes('clearInterval(generationWatchdog)'), '')
check('异常路径按 id 更新最新列表', api.includes('const fresh = d.store.files.generations.load()'), '')
const main = readFileSync(join(productRoot, 'desktop', 'electron', 'main.cjs'), 'utf8')
check('主进程注入 BF_LOG_DIR', main.includes('process.env.BF_LOG_DIR = runLog.dir'), '')
check('内核日志不碰 stdout', readFileSync(join(productRoot, 'server', 'src', 'runtime-log.ts'), 'utf8').includes('process.stderr.write'), '')

const failed = checks.filter(c => !c.ok)
for (const c of checks)
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : '  -> ' + c.detail))
console.log('GENERATION_WATCHDOG ' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' fail=' + failed.length)
process.exit(failed.length === 0 ? 0 : 1)
