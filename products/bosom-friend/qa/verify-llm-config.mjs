/**
 * 模型配置端到端自检门禁：保存 → 落盘 → 内核注册 → 路由可用，逐环节验证。
 *
 * 为什么需要它：这一条链跨了前端、服务端、DSH 设置/凭据文档、内核注册表四个环节，
 * 任何一环没接通，表现都是"保存了但 AI 没反应"。只看构建成功或页面渲染无法发现，
 * 必须跑真实链路。用法：
 *
 *   node products/bosom-friend/qa/verify-llm-config.mjs
 *
 * 默认连开发版 http://127.0.0.1:31280；用 BF_QA_ORIGIN 覆盖。脚本用占位密钥验证
 * "路由注册"与"配置文件写入"，不做真实模型调用（密钥有效性与模型 id 由界面保存后的
 * 连接验证负责）。运行前后自动备份/恢复用户的模型配置。
 */
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORIGIN = (process.env.BF_QA_ORIGIN ?? 'http://127.0.0.1:31280').replace(/\/+$/, '')
const API = ORIGIN + '/bosom-friend/api'
// 注意：不要用 process.env.DSH_HOME —— 跑本脚本的 agent 自己的 DSH_HOME 指向 ~/.dsh，
// 而产品数据根固定是 ~/.bosom-friend（可用 BF_DSH_HOME 覆盖）。
const DSH_HOME = process.env.BF_DSH_HOME?.trim() !== undefined && (process.env.BF_DSH_HOME ?? '').trim() !== ''
  ? process.env.BF_DSH_HOME.trim()
  : resolve(homedir(), '.bosom-friend')
const DATA_ROOT = resolve(DSH_HOME, 'bosom-friend')
const SETTINGS = resolve(DSH_HOME, 'settings.yaml')
const CREDENTIALS = resolve(DSH_HOME, '.credentials.yaml')
const LLM_USER = resolve(DATA_ROOT, 'llm-user.json')
/**
 * 仓库根目录。
 *
 * 这一项有两处按"仓库根"解析路径：打包主进程目录（`products/bosom-friend/desktop/electron`）
 * 与内核入口（`products/bosom-friend/bundle/kernel/runtime/bin-kernel.mjs`）。
 * 原先直接用 `process.cwd()`，于是从产品目录手工跑就会报"打包主进程文件存在（0 个）"和
 * 内核 JSON-RPC 断开——看着像产品坏了，其实是站错了地方（实测 2026-09-20）。这里先试 cwd，
 * 不成立就用脚本自身位置回推，两种调用方式都能跑对。
 */
const REPO_ROOT = (() => {
  const fromCwd = resolve(process.cwd())
  if (existsSync(resolve(fromCwd, 'products/bosom-friend/desktop/electron'))) return fromCwd
  // qa/verify-llm-config.mjs → products/bosom-friend/qa → 仓库根
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
})()

const TEST_ID = 'bf-verify'
const TEST_ROUTE = 'bf-bf-verify'
const TEST_MODEL = 'agnes-2.5-flash'

const failures = []
const note = (ok, label, detail = '') => {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + label + (detail === '' ? '' : ' — ' + detail))
  if (!ok) failures.push(label + (detail === '' ? '' : ': ' + detail))
}

const backup = existsSync(LLM_USER) ? readFileSync(LLM_USER, 'utf8') : null
/** 运行前用户自己的提供方数量；用于确认恢复后应用看到的就是原来那份配置。 */
const providersBefore = (() => {
  try { return (JSON.parse(backup ?? '{}').providers ?? []).length }
  catch { return 0 }
})()
const settingsBackup = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : null
const credentialsBackup = existsSync(CREDENTIALS) ? readFileSync(CREDENTIALS, 'utf8') : null

/**
 * 确认"恢复后的配置"应用真的看得见：轮询应用自己的读接口，直到提供方数量回到运行前的值。
 *
 * 为什么需要：这一项会把用户配置临时换成占位提供方再恢复。恢复只写了文件，没人确认应用读到的
 * 是恢复后的那份——一旦没恢复成功，下一次调用会以"未接入任何大模型"失败，而现场看不出是这一项
 * 留下的（实测 2026-09-20 夜：同一轮里 AI 智能体任务动作被连坐判黄）。
 *
 * @returns 可见时 resolve true；3 秒内没等到 resolve false（由调用方决定怎么记）。
 */
async function restoreVisible() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const res = await fetch(API + '/ai/user-llm', { headers: { authorization: 'Bearer ' + (process.env.BF_QA_TOKEN ?? 'bf-local-guest-token') } })
      const json = await res.json()
      const count = Array.isArray(json?.data?.providers) ? json.data.providers.length : -1
      if (count === providersBefore) return true
    }
    catch {
      // 应用没在跑时这里读不到：不算失败，恢复本身已经写回文件。
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

try {
  console.log('== 1/5 保存一份测试提供方（占位密钥） ==')
  const put = await fetch(API + '/ai/user-llm', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providers: [{ id: TEST_ID, displayName: 'Verify Provider', baseUrl: 'https://api.agnes-ai.cn/v1', protocol: 'openai-completions', apiKey: 'sk-verify-placeholder', models: [TEST_MODEL] }],
      activeProviderId: TEST_ID,
    }),
  })
  const putJson = await put.json()
  note(putJson.code === 0 && putJson.data?.providerCount === 1, 'PUT 保存返回成功', JSON.stringify(putJson.data))

  console.log('== 2/5 产品配置落盘 ==')
  const stored = JSON.parse(readFileSync(LLM_USER, 'utf8'))
  note(Array.isArray(stored.providers) && stored.providers.some(p => p.id === TEST_ID), 'llm-user.json 含测试提供方')
  note(stored.activeProviderId === TEST_ID, 'activeProviderId 指向测试提供方', String(stored.activeProviderId))
  note(stored.model === TEST_MODEL, '顶层 model 镜像当前提供方模型', String(stored.model))

  console.log('== 3/5 写入 DSH 设置与凭据文档 ==')
  const settings = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : ''
  note(settings.includes('llm-pi-ai:'), 'settings.yaml 存在 llm-pi-ai 段')
  note(settings.includes(TEST_ROUTE + ':'), 'settings.yaml 注册了路由 ' + TEST_ROUTE)
  note(/baseURL:\s*https:\/\/api\.agnes-ai\.cn\/v1/.test(settings), 'settings.yaml 写入 baseURL')
  const credentials = existsSync(CREDENTIALS) ? readFileSync(CREDENTIALS, 'utf8') : ''
  note(credentials.includes('BF_BF_VERIFY_API_KEY'), '.credentials.yaml 写入密钥引用名')

  console.log('== 4/5 唯一权威：打包主进程不得再持有一份模型配置 ==')
  // 历史上有 4 份配置副本，其中一份在旧桌面壳的主进程（electron-store 'zhiyin-model-config' →
  // 注入 AGNES_* 环境变量）。打包版的主进程是 desktop/electron/{main,kernel-host,preload}.cjs，
  // 服务端经 kernel-client.ts 用 llm-user.json 注入密钥——所以那份副本既不在产物里，也不该被接回来。
  const packagedDir = resolve(REPO_ROOT, 'products/bosom-friend/desktop/electron')
  const packagedFiles = existsSync(packagedDir)
    ? readdirSync(packagedDir).filter(name => /\.(cjs|js|mjs)$/.test(name))
    : []
  const offenders = packagedFiles.filter((name) => {
    const text = readFileSync(resolve(packagedDir, name), 'utf8')
    return /zhiyin-model-config|userModelConfig|applyUserModelConfigToEnv|AGNES_[A-Z_]*API_KEY/.test(text)
  })
  note(packagedFiles.length > 0, '打包主进程文件存在（' + packagedFiles.length + ' 个）')
  note(offenders.length === 0, '打包主进程不持有第二份模型配置', offenders.join(', ') || '唯一权威：服务端 llm-user.json → kernel-client 注入 AGNES_API_KEY')

  console.log('== 5/5 内核真的注册了这条路由 ==')
  // 0.1.5 的客户端只认 dshBin/profile 契约（command/args/cwd 已不存在）；入口取
  // bundle/kernel/runtime（开发态与随包版同源，见 DEF-059）。
  const client = new HarnessClient({
    dshBin: resolve(REPO_ROOT, 'products/bosom-friend/bundle/kernel/runtime/bin-kernel.mjs'),
    profile: 'bosom-friend-kernel',
    processCwd: REPO_ROOT,
    env: { ...process.env, DSH_HOME },
  })
  try {
    const info = await client.initialize({ cwd: REPO_ROOT, provider: TEST_ROUTE, model: TEST_MODEL })
    note(typeof info?.serverInfo?.name === 'string', '内核接受路由 ' + TEST_ROUTE, JSON.stringify(info?.serverInfo ?? {}).slice(0, 80))
  }
  catch (error) {
    note(false, '内核接受路由 ' + TEST_ROUTE, String(error).slice(0, 160))
  }
  finally {
    await client.close().catch(() => {})
  }
}
finally {
  // 恢复用户原有配置与 DSH 文档
  if (backup === null) writeFileSync(LLM_USER, JSON.stringify({ baseUrl: '', apiKey: '', model: '' }, null, 2), 'utf8')
  else writeFileSync(LLM_USER, backup, 'utf8')
  if (settingsBackup !== null) writeFileSync(SETTINGS, settingsBackup, 'utf8')
  // 运行前没有 settings.yaml 时，本次生成的文档必须删掉：否则测试路由会变成内核里唯一的路由。
  else if (existsSync(SETTINGS)) rmSync(SETTINGS, { force: true })
  if (credentialsBackup !== null) writeFileSync(CREDENTIALS, credentialsBackup, 'utf8')
  else if (existsSync(CREDENTIALS)) rmSync(CREDENTIALS, { force: true })
  const restoredSettings = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : ''
  const restoredRoutes = [...restoredSettings.matchAll(/^ {4}([A-Za-z0-9_-]+):\s*$/gm)].map(m => m[1]).filter(id => id !== TEST_ROUTE)
  if (restoredSettings !== '' && restoredRoutes.length === 0) {
    console.log('  [WARN] settings.yaml 里没有用户自己的模型路由（只剩测试路由或为空）：请在「设置 → 自定义大模型」点一次保存，让内核重新注册真实提供方。')
  }
  // 恢复必须**对应用可见**，否则下一次调用会以"未接入任何大模型"失败，而故障现场看不出是这一项留下的。
  // 实测（2026-09-20 夜）：门禁连续三轮里有一轮把 AI 智能体任务动作连坐判黄，根因就在这里。
  const visible = await restoreVisible()
  console.log('  恢复后应用可见的提供方数量 = 运行前？' + (visible ? '是' : '否（3 秒内没对上，可能应用未运行）'))
  console.log('== 已恢复运行前的模型配置 ==')
}

if (failures.length > 0) {
  console.log('LLM_CONFIG_GATE FAIL (' + failures.length + ')')
  process.exit(1)
}
console.log('LLM_CONFIG_GATE PASS')
