#!/usr/bin/env node
/**
 * 内核业务工具执行验收：9 个工具全部真跑一遍，断言「注册齐全 + execute 不炸 + render 出文本」。
 *
 * 为什么必须有这条：内核工具直接读共享数据店（store.files.*），写错集合名时
 * 注册阶段完全正常、只有真被模型调用才抛
 * 「Cannot read properties of undefined (reading 'load')」——静态门禁和页面冒烟都抓不到。
 * 这条把「工具能不能跑」变成可复现的确定性断言，且默认打在打包运行时里的那份 lib 上。
 *
 * 用法：
 *   node products/bosom-friend/qa/verify-kernel-tools.mjs
 *   BF_KERNEL_LIB="%APPDATA%/Bosom Friend/kernel-runtime/runtime/kernel/index.js" node .../verify-kernel-tools.mjs
 * 退出码：0 = 全绿；1 = 存在失败。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const REPO = dirname(dirname(PRODUCT))
const LIB = process.env.BF_KERNEL_LIB ?? join(PRODUCT, 'kernel', 'lib', 'index.js')

const results = []
/** 记录一条断言结果；失败也继续跑，最后统一汇总。 */
function check(ok, id, detail) {
  results.push({ ok: !!ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

/** 写一个带 schemaVersion 信封的数据文件。 */
function seed(root, file, value) {
  writeFileSync(join(root, file), JSON.stringify({ schemaVersion: 1, value }, null, 2), 'utf8')
}

if (!existsSync(LIB)) {
  console.log('FAIL kernel-lib-exists | 找不到内核构建产物：' + LIB)
  console.log('结论：请先 pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'bf-kernel-tools-'))
const dataRoot = join(home, 'bosom-friend')
mkdirSync(dataRoot, { recursive: true })

// 每个工具都要读到「非空且形状正确」的行，空数据会让投影 bug 悄悄溜过去。
seed(dataRoot, 'accounts.json', [{ id: 'acc-1', type: 'xhs', nickname: '验收账号', uid: 'u-1', status: 1, fansCount: 12, loginState: 'valid', createdAt: '2026-01-01T00:00:00.000Z' }])
seed(dataRoot, 'contents.json', [
  { _id: 'mat-1', kind: 'asset', type: 'image', title: '验收素材', useCount: 3, createdAt: '2026-01-01T00:00:00.000Z' },
  { _id: 'dft-1', kind: 'draft', title: '验收草稿', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z' },
])
seed(dataRoot, 'publish-records.json', [{ id: 'rec-1', title: '验收发布', accountType: 'xhs', type: 'ImageText', status: 2, publishTime: '2026-01-02T00:00:00.000Z' }])
seed(dataRoot, 'metrics.json', [{ id: 'met-1', recordId: 'rec-1', playCount: 7, collectedAt: '2026-01-02T00:00:00.000Z' }])
seed(dataRoot, 'reception-pending.json', [{ id: 'rp-1', accountId: 'acc-1', platform: 'xhs', content: '在吗', createdAt: '2026-01-02T00:00:00.000Z' }])
seed(dataRoot, 'draft-generations.json', [{ id: 'gen-1', status: 'completed', style: 'video', createdAt: '2026-01-03T00:00:00.000Z', response: { title: '验收生成', content: '正文' } }])
seed(dataRoot, 'job-queue.json', [{ id: 'job-1', kind: 'publish', params: {}, status: 'failed', attempt: 3, maxRetries: 2, lastError: '上游超时', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' }])
seed(dataRoot, 'llm-user.json', { model: 'stub-model', baseUrl: 'http://127.0.0.1:1/v1' })

process.env.DSH_HOME = home

/** 每个工具的最小可执行入参。 */
const ARGS = {
  bosom_kernel_ping: { message: 'ping' },
  bosom_platform_list_accounts: { limit: '10' },
  bosom_reception_list_pending: { limit: '10' },
  bosom_material_list: { limit: '10' },
  bosom_data_dashboard: {},
  bosom_platform_login_status: { limit: '10' },
  bosom_platform_sync_works: { limit: '10' },
  bosom_content_list_drafts: { limit: '10' },
  bosom_content_generate_script: { prompt: '写一句话', kind: 'image-text' },
  bosom_job_list: { limit: '10' },
}

/** 模型桩：只吐一段确定文本，让生成类工具走到落库/投影那段真实代码。 */
function stubLlm() {
  return {
    async *stream() {
      yield { type: 'text-delta', text: '# 验收标题\n这是模型桩产出的正文。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const registered = []
const ctx = { tools: { register: tool => { registered.push(tool); return () => {} } }, llm: stubLlm() }

let mod
try {
  mod = await import(pathToFileURL(LIB).href)
} catch (error) {
  console.log('FAIL kernel-lib-import | 载入 ' + LIB + ' 抛错：' + (error instanceof Error ? error.message : String(error)))
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

try {
  mod.apply(ctx)
} catch (error) {
  console.log('FAIL kernel-apply | apply() 抛错：' + (error instanceof Error ? error.message : String(error)))
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

const names = registered.map(tool => tool.name)
const missing = Object.keys(ARGS).filter(name => !names.includes(name))
check(missing.length === 0, 'kernel-tools-registered', '已注册 ' + names.length + ' 个：' + names.join(', ') + (missing.length ? '；缺 ' + missing.join(', ') : ''))

for (const tool of registered) {
  const args = ARGS[tool.name]
  if (args === undefined) {
    check(false, 'tool-args-' + tool.name, '验收脚本没有为该工具准备入参')
    continue
  }
  let value
  try {
    value = await tool.execute(args)
  } catch (error) {
    check(false, 'tool-exec-' + tool.name, 'execute 抛错：' + (error instanceof Error ? error.message : String(error)))
    continue
  }
  let text
  try {
    const parts = tool.output.render(args, value)
    text = parts.map(part => part.text ?? '').join('')
  } catch (error) {
    check(false, 'tool-render-' + tool.name, 'execute 成功但 render 抛错：' + (error instanceof Error ? error.message : String(error)))
    continue
  }
  check(text.trim() !== '', 'tool-exec-' + tool.name, 'execute + render 正常，渲染 ' + text.replace(/\s+/g, ' ').trim().slice(0, 70))
}

// 数据看板是真读盘的工具：断言它读到的是种子数据，而不是「一律 0」的假绿。
const dashboard = registered.find(tool => tool.name === 'bosom_data_dashboard')
if (dashboard !== undefined) {
  const value = await dashboard.execute({})
  check(value.accounts === 1 && value.publishRecords === 1 && value.metricRows === 1,
    'dashboard-reads-real-data', '账号 ' + value.accounts + ' / 发布记录 ' + value.publishRecords + ' / 指标行 ' + value.metricRows + '（种子各 1）')
  check(value.materials === 1, 'materials-from-contents', '素材数 ' + value.materials + '（contents 里 kind=asset 的 1 条）')
}

const materials = registered.find(tool => tool.name === 'bosom_material_list')
if (materials !== undefined) {
  const value = await materials.execute({ limit: '10' })
  check(value.count === 1 && value.items[0]?.title === '验收素材', 'material-list-projects-asset', '素材 ' + value.count + ' 条，首条《' + (value.items[0]?.title ?? '') + '》')
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter(item => !item.ok)
console.log('')
console.log('内核工具验收：' + (results.length - failed.length) + '/' + results.length + ' 通过' + (failed.length ? '，失败：' + failed.map(item => item.id).join(', ') : ''))
console.log('被验产物：' + LIB)
process.exit(failed.length === 0 ? 0 : 1)
