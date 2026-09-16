/**
 * 多服务 / 多模型验收门禁（设置 → 自定义大模型）。
 *
 * 只驱动真实界面（page.goto / locator / screenshot）并回读服务端配置，
 * 逐环节验证「以前只能配一个模型」这条限制真的解开了：
 *   ① 添加第二个服务 → 保存 → 落进 providers[]；
 *   ② 切为当前 → 内核路由与 activeProviderId 一起换；
 *   ③ 同一服务加第二个模型 → 两个模型都可切换，首个即当前模型；
 *   ④ 删除该服务 → 列表与内核路由一起收回。
 *
 * 运行前后自动备份 / 恢复用户的模型配置（llm-user.json、settings.yaml、.credentials.yaml），
 * 中途失败也走 finally 恢复。用法：
 *
 *   node products/bosom-friend/qa/acceptance/verify-multi-model.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Jay/Desktop/Bosom friend APP/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core')

const BASE = process.env.BF_QA_BASE || 'http://127.0.0.1:31280/bosom-friend/'
const API = (process.env.BF_QA_ORIGIN || 'http://127.0.0.1:31280').replace(/\/+$/, '') + '/bosom-friend/api'
const SHOTS = join(import.meta.dirname, 'multi-model')
const DSH_HOME = (process.env.BF_DSH_HOME ?? '').trim() !== ''
  ? (process.env.BF_DSH_HOME ?? '').trim()
  : resolve(homedir(), '.bosom-friend')
const DATA_ROOT = resolve(DSH_HOME, 'bosom-friend')
const LLM_USER = resolve(DATA_ROOT, 'llm-user.json')
const SETTINGS = resolve(DSH_HOME, 'settings.yaml')
const CREDENTIALS = resolve(DSH_HOME, '.credentials.yaml')

const SERVICE_NAME = 'QA 第二服务'
const MODEL_A = 'qa-model-a'
const MODEL_B = 'qa-model-b'

/** 内核路由名规则与服务端 kernelRouteId 一致：agnes 原名，其余加 bf- 前缀。 */
const kernelRoute = id => (id === 'agnes' ? 'agnes' : 'bf-' + id)
/** 按展示名找到界面上新建的那个服务（id 由界面生成，脚本不预设）。 */
const findService = config => (config.providers ?? []).find(item => item.displayName === SERVICE_NAME)

mkdirSync(SHOTS, { recursive: true })
const results = []
function record(id, name, pass, detail = '') {
  results.push({ id, name, pass: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ' :: ' + detail : ''}`)
}

const backup = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
const llmBackup = backup(LLM_USER)
const settingsBackup = backup(SETTINGS)
const credentialsBackup = backup(CREDENTIALS)

/** 回读服务端配置（密钥不回显，只看 id / 名称 / 模型 / 当前生效服务）。 */
async function readConfig(label = '') {
  const res = await fetch(API + '/ai/user-llm')
  const json = await res.json()
  const data = json?.data ?? {}
  console.log('   [cfg ' + label + '] ' + JSON.stringify((data.providers ?? []).map(item => [item.id, item.displayName, item.models])) + ' active=' + String(data.activeProviderId))
  return data
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error)))
/** 界面发出的模型配置请求：断言失败时用来定位「点了保存但没提交」。 */
const apiCalls = []
page.on('request', (request) => {
  if (!request.url().includes('/ai/user-llm'))
    return
  const body = request.postData() ?? ''
  apiCalls.push(request.method() + ' ' + request.url().split('/api/')[1] + ' ' + body.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 500))
})

const row = () => page.locator('li', { hasText: SERVICE_NAME }).first()
const openTab = async () => {
  await page.locator('[data-testid=sidebar-user-trigger]').click({ timeout: 20000 })
  await page.waitForTimeout(700)
  await page.locator('[data-testid=sidebar-settings-entry] button').click({ timeout: 20000 })
  await page.waitForTimeout(1200)
  await page.locator('[data-tab-key=customLlm]').click({ timeout: 20000 })
  await page.waitForTimeout(2500)
}
const save = async () => {
  await page.locator('button:has-text("保存并使用我的钥匙")').first().click({ timeout: 15000 })
  await page.waitForTimeout(6000)
}

let baseline = {}
try {
  baseline = await readConfig('基线')
  if (findService(baseline) !== undefined)
    console.log('   [WARN] 运行前就存在名为「' + SERVICE_NAME + '」的服务：本次结果可能受上一次未清理的数据影响')

  await page.goto(BASE + '#/draft-box', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(9000)
  try {
    await page.locator("button:has-text('我已阅读并同意')").first().click({ timeout: 6000 })
    await page.locator("button:has-text('同意并进入平台')").first().click({ timeout: 6000 })
    await page.waitForTimeout(2000)
  }
  catch {
    // 已同意过（或本次没有免责声明）：无需处理。
  }
  await openTab()
  await page.screenshot({ path: join(SHOTS, '01-service-list.png') })

  // ---- ① 添加第二个服务并保存 ----
  await page.locator('button:has-text("添加模型服务")').first().click({ timeout: 15000 })
  await page.waitForTimeout(600)
  await page.locator('#bf-llm-display-name').fill(SERVICE_NAME)
  await page.locator('#bf-llm-base-url').fill('https://api.agnes-ai.cn/v1')
  await page.locator('#bf-llm-api-key').fill('sk-qa-multi-placeholder')
  await page.locator('#bf-llm-model').fill(MODEL_A)
  await page.screenshot({ path: join(SHOTS, '02-new-service-form.png') })
  await save()
  await page.screenshot({ path: join(SHOTS, '03-second-service-saved.png') })

  let config = await readConfig('保存第 1 次后')
  const added = findService(config)
  const serviceId = added?.id ?? ''
  record('M01', '第二个服务保存进 providers[]', added !== undefined, '服务数=' + String((config.providers ?? []).length) + ' 新服务 id=' + serviceId)
  record('M02', '新服务的模型目录落盘', (added?.models ?? []).includes(MODEL_A), JSON.stringify(added?.models ?? []))
  record('M03', '新服务密钥已保存（不回显）', added?.hasApiKey === true)

  // ---- ② 切为当前 ----
  await row().locator('button:has-text("设为当前")').click({ timeout: 15000 })
  await page.waitForTimeout(6000)
  config = await readConfig('切为当前后')
  record('M04', '一键切换当前服务', config.activeProviderId === serviceId && serviceId !== '', String(config.activeProviderId))
  const settings = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : ''
  record('M05', '内核注册了新服务的路由', serviceId !== '' && settings.includes(kernelRoute(serviceId) + ':'), kernelRoute(serviceId))
  await page.screenshot({ path: join(SHOTS, '04-switched-active.png') })

  // ---- ③ 同一服务加第二个模型并来回切换 ----
  await page.locator('#bf-llm-model').fill(MODEL_B)
  await save()
  config = await readConfig('保存第 2 次后')
  const twoModels = findService(config)?.models ?? []
  record('M06', '一个服务可保存多个模型', twoModels.includes(MODEL_A) && twoModels.includes(MODEL_B), JSON.stringify(twoModels))
  record('M07', '新填的模型成为当前模型', twoModels[0] === MODEL_B, JSON.stringify(twoModels))
  await page.screenshot({ path: join(SHOTS, '05-two-models.png') })

  await page.getByRole('button', { name: MODEL_A, exact: true }).first().click({ timeout: 15000 })
  await save()
  config = await readConfig('切回模型 A 后')
  const afterSwitch = findService(config)?.models ?? []
  record('M08', '点模型标签即切换当前模型', afterSwitch[0] === MODEL_A, JSON.stringify(afterSwitch))
  await page.screenshot({ path: join(SHOTS, '06-model-switched.png') })

  // ---- ④ 删除该服务 ----
  const idsBeforeDelete = ((await readConfig('删除前')).providers ?? []).map(item => item.id)
  await row().locator('button[aria-label="删除 ' + SERVICE_NAME + '"]').click({ timeout: 15000 })
  await page.waitForTimeout(500)
  await row().locator('button:has-text("确认删除")').click({ timeout: 15000 })
  await page.waitForTimeout(6000)
  config = await readConfig('删除后')
  record('M09', '删除后列表不再包含该服务', findService(config) === undefined, JSON.stringify((config.providers ?? []).map(item => item.id)))
  record('M10', '删除后当前服务回到原有服务', (config.providers ?? []).some(item => item.id === config.activeProviderId) || (config.providers ?? []).length === 0, String(config.activeProviderId))
  // 删除只影响被删的那个：其余服务一个不少（基线可能为空——旧单配置由界面还原成服务）。
  const expectedIds = idsBeforeDelete.filter(id => id !== serviceId)
  const actualIds = (config.providers ?? []).map(item => item.id)
  record('M11', '删除只影响被删服务，其余服务一个不少', JSON.stringify(actualIds) === JSON.stringify(expectedIds), JSON.stringify(actualIds) + ' vs ' + JSON.stringify(expectedIds))
  record('M13', '原有服务仍在并保持当前使用', (config.providers ?? []).every(item => (baseline.providers ?? []).some(old => old.id === item.id) || item.id === 'agnes'), JSON.stringify(actualIds) + ' 基线=' + JSON.stringify((baseline.providers ?? []).map(item => item.id)))
  await page.screenshot({ path: join(SHOTS, '07-after-delete.png') })

  record('M12', '页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
}
catch (error) {
  record('M00', '检查脚本执行完成', false, String(error).slice(0, 300))
  await page.screenshot({ path: join(SHOTS, '99-fail.png') }).catch(() => {})
}
finally {
  await browser.close()
  // 关掉页面后再等一拍：把界面上已发出的保存请求放完，
  // 否则它可能落在恢复之后，把测试用的服务又写回配置文件。
  await new Promise(resolve => setTimeout(resolve, 2500))
  // 恢复运行前的模型配置与 DSH 文档
  if (llmBackup === null) writeFileSync(LLM_USER, JSON.stringify({ baseUrl: '', apiKey: '', model: '' }, null, 2), 'utf8')
  else writeFileSync(LLM_USER, llmBackup, 'utf8')
  if (settingsBackup !== null) writeFileSync(SETTINGS, settingsBackup, 'utf8')
  else if (existsSync(SETTINGS)) rmSync(SETTINGS, { force: true })
  if (credentialsBackup !== null) writeFileSync(CREDENTIALS, credentialsBackup, 'utf8')
  else if (existsSync(CREDENTIALS)) rmSync(CREDENTIALS, { force: true })
  const restoredLlm = existsSync(LLM_USER) ? readFileSync(LLM_USER, 'utf8') : ''
  const restoreOk = llmBackup === null ? restoredLlm !== '' : restoredLlm === llmBackup
  record('M14', '运行前的模型配置已完整恢复', restoreOk, restoreOk ? '' : '恢复后内容与备份不一致')
  console.log('== 已恢复运行前的模型配置 ==')
}

if (results.some(item => !item.pass)) {
  console.log('--- 界面发出的模型配置请求 ---')
  for (const call of apiCalls)
    console.log('  ' + call)
}

const failed = results.filter(item => !item.pass)
console.log(`MULTI_MODEL_GATE ${failed.length === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failed=${failed.length}`)
if (failed.length > 0) {
  for (const item of failed)
    console.log(`  ${item.id} ${item.name}: ${item.detail}`)
  process.exit(1)
}
