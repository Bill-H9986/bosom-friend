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
import { resolve } from 'node:path'

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
const TEST_ID = 'bf-verify'
const TEST_ROUTE = 'bf-bf-verify'
const TEST_MODEL = 'agnes-2.5-flash'

const failures = []
const note = (ok, label, detail = '') => {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + label + (detail === '' ? '' : ' — ' + detail))
  if (!ok) failures.push(label + (detail === '' ? '' : ': ' + detail))
}

const backup = existsSync(LLM_USER) ? readFileSync(LLM_USER, 'utf8') : null
const settingsBackup = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : null
const credentialsBackup = existsSync(CREDENTIALS) ? readFileSync(CREDENTIALS, 'utf8') : null

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
  const packagedDir = resolve(process.cwd(), 'products/bosom-friend/desktop/electron')
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
    dshBin: resolve(process.cwd(), 'products/bosom-friend/bundle/kernel/runtime/bin-kernel.mjs'),
    profile: 'bosom-friend-kernel',
    processCwd: process.cwd(),
    env: { ...process.env, DSH_HOME },
  })
  try {
    const info = await client.initialize({ cwd: process.cwd(), provider: TEST_ROUTE, model: TEST_MODEL })
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
  console.log('== 已恢复运行前的模型配置 ==')
}

if (failures.length > 0) {
  console.log('LLM_CONFIG_GATE FAIL (' + failures.length + ')')
  process.exit(1)
}
console.log('LLM_CONFIG_GATE PASS')
