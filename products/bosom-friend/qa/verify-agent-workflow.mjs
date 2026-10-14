#!/usr/bin/env node
/**
 * AI 智能体动作链路的契约门禁：把"已申请 / 已执行 / 已核验"从提示词里的一句叮嘱
 * 变成**可执行断言**，并锁住"写稿 → 出片 → 发布"的交接件。
 *
 * 为什么必须有这条：
 * - 申请类工具原先返回 `'（待前端执行）'` 这种占位串：下游无法引用、门禁无法断言，
 *   模型只能靠复述提示词避免说错话（DEF-201 / DEF-239 的同源问题）；
 * - 出片与发布之间靠"去素材库里再找一遍"接续，链路上没有可交接的 id；
 * - 规则文本承诺的参数，可能在内核里被 `void` 掉（DEF-239）：承诺与能力各说各话。
 *
 * 断言分三类：① 运行时跑真工具看返回值；② 读构建产物的参数/输出契约；③ 读服务端源码的一致性。
 *
 * ## 铁律：本门禁不得写真实数据根（2026-10-13 立）
 *
 * 它验的三个工具（publish / create_draft / update_draft）都会经**回环 HTTP 打到产品服务端**，
 * 而服务端写的是它自己的数据根——**本脚本的临时 DSH_HOME 管不到它**。历史事故：每跑一次就往
 * 真实 publish-records.json 写一条假记录（acc-1/mat-1/coverUrl=/a.jpg），把不相干的 qa-guard
 * 变成随机红，且排查方向会被带偏（去看日历页与渲染，永远查不到是门禁自己写的）。
 *
 * 因此本脚本把**回环出口本身**桩掉（globalThis.fetch），未登记的服务端调用直接抛错：
 * 断言只验「内核拿到响应后怎么转成 state/handle」这一层契约，真实链路交给
 * verify-one-sentence-e2e / verify-multistep。**新增断言时不要绕过这个桩。**
 *
 * 用法：node products/bosom-friend/qa/verify-agent-workflow.mjs
 * 退出码：0 = 全绿；1 = 存在失败。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const LIB = process.env.BF_KERNEL_LIB ?? join(PRODUCT, 'kernel', 'lib', 'index.js')
const RULES = join(PRODUCT, 'server', 'src', 'agent-rules.ts')
const API = join(PRODUCT, 'server', 'src', 'api.ts')

const results = []
/** 记录一条断言结果；失败也继续跑，最后统一汇总。 */
function check(ok, id, detail) {
  results.push({ ok: !!ok, id, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' | ' + detail)
}

if (!existsSync(LIB)) {
  console.log('FAIL kernel-lib-exists | 找不到内核构建产物：' + LIB)
  console.log('结论：请先 pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'bf-agent-workflow-'))
const dataRoot = join(home, 'bosom-friend')
mkdirSync(dataRoot, { recursive: true })

/** 写一个带 schemaVersion 信封的数据文件。 */
function seed(file, value) {
  writeFileSync(join(dataRoot, file), JSON.stringify({ schemaVersion: 1, value }, null, 2), 'utf8')
}

seed('accounts.json', [{ id: 'acc-1', type: 'xhs', nickname: '验收账号', status: 1, loginState: 'valid' }])
seed('contents.json', [
  { _id: 'mat-1', kind: 'asset', type: 'video', title: '验收素材', url: '/a.mp4', thumbUrl: '/a.jpg', useCount: 0 },
  { _id: 'dft-1', kind: 'draft', title: '验收草稿', status: 0 },
])
seed('llm-user.json', { model: 'stub-model', baseUrl: 'http://127.0.0.1:1/v1' })

process.env.DSH_HOME = home

/** 模型桩：只吐一段确定文本，让写稿工具走到真实返回路径。 */
function stubLlm() {
  return {
    async *stream() {
      yield { type: 'text-delta', text: '# 验收稿件标题\n这是模型桩产出的稿件正文，用于断言稿件编号的确定性。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

// ---- 回环出口隔离（2026-10-13 立，**本门禁不得写真实数据根**）----
//
// 为什么光靠 DSH_HOME 不够：本脚本验的是**内核工具**，而 publish / create_draft / update_draft
// 现在都经**回环 HTTP 打到另一个进程（产品服务端）**——服务端写的是**它自己的数据根**，
// 本脚本的临时 DSH_HOME 管不到它。实测后果：每跑一次就往真实 publish-records.json 写一条假记录
// （acc-1 / mat-1 / coverUrl=/a.jpg），把**不相干的 qa-guard** 变成随机红——排查的人会去查
// 日历页、查渲染、查脏数据，**永远查不到是门禁自己写的**。
//
// 所以这里把**回环出口本身**桩掉：断言验的是「内核拿到服务端响应之后，怎么把它转成 state/handle」，
// 这本来就是内核的契约；真实的端到端链路由 verify-one-sentence-e2e / verify-multistep 负责。
// **副作用：零出站**——服务端、真实数据根都碰不到。
const realFetch = globalThis.fetch
const outbound = []
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === 'string' ? input : (input?.url ?? input))
  const method = String(init?.method ?? 'GET').toUpperCase()
  outbound.push(method + ' ' + url.replace(/^https?:\/\/[^/]+/, ''))
  /** 产品信封：{ code, data, message }，与 callProductApi 的解析口径一致。 */
  const envelope = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, message: 'ok', data }) })
  if (url.includes('/v2/channels/publish/flows')) return envelope({ tasks: [{ id: 'rec-verify01' }] })
  if (url.includes('/bosom-friend/api/contents/drafts')) return envelope({ _id: 'cnt-verify01' })
  if (/\/bosom-friend\/api\/contents\/[^/]+$/.test(url)) return envelope({ ok: true })
  // 未登记的回环出口**直接抛错**：宁可让断红，也不让它悄悄打到真实服务（那正是这次污染的来源）。
  throw new Error('本门禁已隔离回环出口，未登记的服务端调用被拒绝：' + method + ' ' + url)
}

const registered = []
const ctx = { tools: { register: tool => { registered.push(tool); return () => {} } }, llm: stubLlm() }
const mod = await import(pathToFileURL(LIB).href)
mod.apply(ctx)

const byName = new Map(registered.map(tool => [tool.name, tool]))
const paramNames = name => Object.keys(byName.get(name)?.parameters?.properties ?? {}).sort()

// ① 申请类工具：必须给「三态 + 句柄」，且句柄不是占位串
const publish = byName.get('bosom_publish_content')
if (publish === undefined) check(false, 'publish-registered', '没有注册 bosom_publish_content')
else {
  const value = await publish.execute({ accountId: 'acc-1', materialId: 'mat-1', title: '验收标题', body: '验收正文', topics: 'a,b' })
  // **契约变更，2026-10-12**（内核改造：申请类工具从「只登记申请、交给前端执行」→ **真写库**）：
  // 三态因此直接落到 `executed`，handle 也换成**真实产物 id**（发布记录 `rec-*`、草稿 `cnt-*`），
  // 不再是 `pub-*` / `draft-*` 那种申请号。**断言语义随之变强**：旧断言只要内核说「我登记了」就过，
  // 新断言要求它交回的是**盘上真实存在的产物 id**。
  check(value.state === 'executed', 'publish-state-executed', 'state=' + String(value.state))
  check(/^rec-[0-9a-z]{8}$/.test(String(value.handle)), 'publish-handle-is-real-record', 'handle=' + String(value.handle))
  const text = publish.output.render({}, value).map(part => part.text ?? '').join('')
  check(text.includes(String(value.handle)) && !text.includes('（待前端执行）'), 'publish-render-carries-handle', '渲染里带申请号，且不再出现占位串')
}

const draft = byName.get('bosom_content_create_draft')
if (draft === undefined) check(false, 'draft-registered', '没有注册 bosom_content_create_draft')
else {
  const value = await draft.execute({ title: '验收草稿', desc: '验收正文', topics: '', platform: '' })
  // 同上：建草稿现在也真写库，handle 是**真实草稿 id**（cnt-*），不是 draft-* 申请号。
  check(value.state === 'executed' && /^cnt-[0-9a-z]{8}$/.test(String(value.handle)), 'draft-state-real-handle', 'state=' + String(value.state) + ' handle=' + String(value.handle))
}

const update = byName.get('bosom_content_update_draft')
if (update === undefined) check(false, 'update-registered', '没有注册 bosom_content_update_draft')
else {
  const value = await update.execute({ id: 'dft-1', title: '改后标题', desc: '' })
  // 改写同样真写库（旧实现 return { state: 'requested' } 把改写交给前端执行，见 kernel/src/index.ts:1082 的改造说明）；
  // handle 仍是 upd-* 申请号（这条没变），变的是 state。
  check(value.state === 'executed' && /^upd-/.test(String(value.handle)), 'update-state-executed-handle', 'state=' + String(value.state) + ' handle=' + String(value.handle))
}

// ② 写稿 → 出片：稿件编号必须存在、稳定（内容寻址），出片能吃下稿件
const gen = byName.get('bosom_content_generate_script')
if (gen === undefined) check(false, 'script-registered', '没有注册 bosom_content_generate_script')
else {
  const first = await gen.execute({ prompt: '写一句话', kind: 'image-text' })
  const second = await gen.execute({ prompt: '写一句话', kind: 'image-text' })
  check(/^script-[0-9a-f]{12}$/.test(String(first.scriptId)), 'script-id-format', 'scriptId=' + String(first.scriptId))
  check(first.scriptId === second.scriptId, 'script-id-deterministic', '同一份稿件两次得到同一个编号')
}

const videoParams = paramNames('bosom_content_create_video')
check(videoParams.includes('scriptText') && videoParams.includes('scriptId'),
  'video-accepts-script', '出片参数：' + videoParams.join(', '))
const videoOut = Object.keys(byName.get('bosom_content_create_video')?.output?.schema?.properties ?? {}).sort()
check(['handle', 'scriptId', 'state', 'taskId'].every(key => videoOut.includes(key)),
  'video-output-contract', '出片输出字段：' + videoOut.join(', '))

// 免费档唯一走得通的出片路径：单次调用（前端那条路），AI 必须也有这个工具
const shortMedia = byName.get('bosom_content_create_short_media')
check(shortMedia !== undefined, 'short-media-tool-exists', 'AI 有「单次调用」的短视频/图文工具（免费档可用路径）')
if (shortMedia !== undefined) {
  const sp = Object.keys(shortMedia.parameters?.properties ?? {}).sort()
  check(['aspectRatio', 'duration', 'kind', 'prompt', 'resolution'].every(k => sp.includes(k)), 'short-media-params', sp.join(', '))
  const so = Object.keys(shortMedia.output?.schema?.properties ?? {}).sort()
  check(['handle', 'kind', 'state', 'taskId'].every(k => so.includes(k)), 'short-media-contract', so.join(', '))
}

const statusOut = Object.keys(byName.get('bosom_content_video_status')?.output?.schema?.properties ?? {}).sort()
check(statusOut.includes('materialId'), 'status-exposes-material-id', '进度输出字段：' + statusOut.join(', '))

// ③ 工具面与规则一致：承诺的参数必须真在链路上（DEF-239）
const publishParams = paramNames('bosom_publish_content')
check(JSON.stringify(publishParams) === JSON.stringify(['accountId', 'body', 'materialId', 'title', 'topics']),
  'publish-tool-face-exact', '发布参数：' + publishParams.join(', ') + '（位置/标注不得留在工具面上）')

const lib = readFileSync(LIB, 'utf8')
const devoured = [...lib.matchAll(/void\s+(location|declaration)\b/g)].map(m => m[1])
check(devoured.length === 0, 'no-voided-advertised-params', devoured.length === 0 ? '没有被 void 掉的已声明参数' : '仍被丢弃：' + devoured.join(', '))

const rules = existsSync(RULES) ? readFileSync(RULES, 'utf8') : ''
const mentioned = [...new Set([...rules.matchAll(/bosom_[a-z_]+/g)].map(m => m[0]))].sort()
const unknown = mentioned.filter(name => !byName.has(name))
check(unknown.length === 0, 'rules-tools-exist', '规则提到的 ' + mentioned.length + ' 个工具' + (unknown.length === 0 ? '全部在注册表里' : '有未知：' + unknown.join(', ')))
check(!/内容标注可填/.test(rules), 'rules-no-declaration-promise', '规则不再承诺"内容标注可填"')

// ④ 回填通道存在：前端执行完要有地方写回（executed / verified）
const api = existsSync(API) ? readFileSync(API, 'utf8') : ''
check(/p:\s*'agent\/tasks\/:taskId\/action-result'/.test(api), 'action-result-route', '服务端有动作回填路由')
check(/actionResults/.test(api), 'action-results-persisted', '回填结果落库字段存在')

// ⑤ 前端真的在回填：通道建好而没人调用，等于没有（DEF-245）
// 前端源码根可由 BF_FRONTEND_SRC_OVERRIDE 覆盖：负向对照要在备用目录里造"去掉 taskId"的源码，
// 不去动真实前端文件（前端线正在改同一片区域）。
const WEB_SRC = process.env.BF_FRONTEND_SRC_OVERRIDE ?? join(PRODUCT, 'project', 'bosom-friend-web', 'src')
const EXEC = join(WEB_SRC, 'components', 'Chat', 'ActionCard', 'executePublishAction.ts')
const PANEL = join(WEB_SRC, 'components', 'AIAssistantPanel', 'index.tsx')
const CARD = join(WEB_SRC, 'components', 'Chat', 'ActionCard', 'index.tsx')

/**
 * 取源码里某个函数的全部调用实参（按括号配平切，不用正则硬啃嵌套）。
 *
 * @param source - 源码全文。
 * @param fnName - 函数名（不含左括号）。
 * @returns 每次调用的实参数组（已 trim）；没有调用则空数组。
 */
function callArgsOf(source, fnName) {
  const calls = []
  let at = source.indexOf(fnName + '(')
  while (at >= 0) {
    let depth = 0
    let current = ''
    const args = []
    for (let i = at + fnName.length; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '(') { depth += 1; if (depth === 1) continue }
      if (ch === ')') { depth -= 1; if (depth === 0) { args.push(current); break } }
      if (ch === ',' && depth === 1) { args.push(current); current = ''; continue }
      current += ch
    }
    if (args.length > 0) calls.push(args.map(item => item.trim()))
    at = source.indexOf(fnName + '(', at + fnName.length + 1)
  }
  return calls
}

/**
 * 第二个实参能不能拿到 taskId：**存在、非空、且不是字面 undefined（恒空）**。
 *
 * 这里刻意**不要求**它等于某个写法（例如 pathTaskId()）。判据要的是"回填带得上 taskId"这个语义，
 * 而不是某一种字面：合法形态有三种——pathTaskId()（只从 URL 拿）、taskId ?? pathTaskId()（聊天页现状，
 * props 优先 + URL 回退，比前者更强）、currentTaskId ?? undefined（首页侧栏）。
 * 反过来，只传一个参数、或第二参写死 undefined，都会让 reportAction 因 taskId 为空**静默跳过**，
 * 卡片永停「已申请 · 未回填」——那才是要判红的。
 *
 * 为什么必须这样写：字面匹配会逼实现写成 (action, pathTaskId())，也就是**删掉 props 那半截**；
 * 而**管家团队页不在 chat 路由上、URL 里根本没有 taskId**，删了那条路径的回填就真的断了——
 * 为了过门禁而功能降级。判据不能制造这种激励（2026-10-13 前端线给的规格）。
 */
const taskArgUsable = (args) => args.length >= 2 && args[1] !== '' && !/^undefined$/.test(args[1])
const execSource = existsSync(EXEC) ? readFileSync(EXEC, 'utf8') : ''
const panelSource = existsSync(PANEL) ? readFileSync(PANEL, 'utf8') : ''
const cardSource = existsSync(CARD) ? readFileSync(CARD, 'utf8') : ''
check(/agentApi\.reportActionResult/.test(execSource), 'frontend-reports-action-result', '前端执行器调用回填接口')
// 语义等价判据（2026-10-13 改）：解析调用实参，第二个实参必须存在且不是恒空值。
const cardCalls = callArgsOf(cardSource, 'executeAgentSaveDraftAction')
const panelCalls = callArgsOf(panelSource, 'executeAgentSaveDraftAction')
const cardHasTaskId = cardCalls.some(taskArgUsable)
const panelHasTaskId = panelCalls.some(taskArgUsable)
check(cardHasTaskId && panelHasTaskId, 'frontend-passes-task-id',
  '两条执行路径都把 taskId（或它的回退来源）传进回填：聊天页 ' + (cardHasTaskId ? '✓ ' + String(cardCalls.length) + ' 处调用' : '✗ 第二参缺失或恒空')
  + '、首页侧栏 ' + (panelHasTaskId ? '✓ ' + String(panelCalls.length) + ' 处调用' : '✗ 第二参缺失或恒空'))

// ⑥ 动作台账的诚实性：未回填（state='requested' 或缺失）的动作，回复不得无凭据地说成"已完成"（D2②）
//
// 为什么加：动作卡是「内核登记申请 → 前端执行 → 回填台账」的两段式（本文件开头那三态）。
// 2026-10-13 夜实测落库：13 个任务带着未回填动作，其中 7 条的助手回复写了「已改好 / 已存回草稿箱」，
// 而台账里那条**始终没有回填**——用户看到的是"做完了"，能核验的凭据却是「已申请 · 未回填」。
// （同批另有 3 条写成「已提交改写申请」，那是两段式的正确说法，放行。）
// 判据：未回填的动作，其任务最后一条助手回复出现完成态强措辞、且没有如实/待确认措辞 → 判红。
// 数据源只读落库，零联网零写入；用 BOSOM_FRIEND_HOME 指向隔离数据根即可做正反双向对照。
const LEDGER_DIR = process.env.BOSOM_FRIEND_HOME ?? join(homedir(), '.bosom-friend', 'bosom-friend')
const LEDGER = join(LEDGER_DIR, 'agent-tasks.json')
if (!existsSync(LEDGER)) {
  check(false, 'action-ledger-readable', '读不到落库任务 ' + LEDGER + '（无法核对动作回填诚实性）')
} else {
  const SETTLED = new Set(['executed', 'verified'])
  /**
   * 历史豁免的时间界（**落库当场实测**，2026-10-13 与 e2e-mainchain 复核一致）。
   *
   * 实测依据（agent-tasks.json 的卡，createdAt 为 UTC）：
   *   · `updateDraft:requested` 的最后一条 = **2026-10-12T15:11:18.538Z**（task-e50c7f1e）；
   *   · `updateDraft:executed` 最早 = 15:03:01.001Z，其后 15:12:34.611Z 起**再没出现过 requested**。
   * 取 15:12:35Z（= 北京 23:12:35）作界：最后一条历史 requested 之后 1 秒。
   *
   * **为什么不取「内核改造时刻」**：内核当晚已改成真写库并返回 executed，但**服务端发卡逻辑当时
   * 仍硬编码 requested**（e2e-mainchain 稍后才改）。按内核时刻切，会把 22:16（北京）之后、
   * 服务端修好之前产生的那批 requested 卡算成"新问题"——那是**假红**。
   */
  const HISTORIC_BOUNDARY = '2026-10-12T15:12:35Z'
  /** 历史既成事实的**条数基线**（落库实测 14 条任务）。只许变少，不许变多。 */
  const HISTORIC_BASELINE = 14
  /**
   * 这条未回填卡是不是**历史既成事实**（代码修好之前就躺在库里的）。
   *
   * 两个条件**同时**成立才算，缺一不可：
   *   ① `action === 'updateDraft'`——只有这一类被实测确认"时间界之前全是历史"。别的 action
   *      （`navigateTo*` 那批）**不进豁免**：它们现在没判红只是因为回复如实；将来若它们的回复
   *      无凭据声称完成，就该红。
   *   ② 任务 `createdAt` 早于 {@link HISTORIC_BOUNDARY}。
   *
   * **绝不能扩大成「所有 updateDraft:requested 都算历史」**（这是这条豁免的真正入口）：
   * 新代码下**内核没写库也会产生 requested 卡**，那是**设计意图、不是历史**。实测：对同一张草稿
   * 改一个 32 字超长标题 → 内核本地校验拒绝（工具结果原文「标题不能超过 30 个字（当前 32 个字）」）
   * **没写库** → 卡就是 requested，助手如实回「改不了，内核拦住了」→ 判据走 HONEST_WORDS 不判红。
   * 将来若出现「**内核没写库、助手却声称完成**」，那一条**必须**判红——按 action 一刀切就会把它吞掉，
   * 那才是把判据修瞎。
   *
   * @param action - 动作卡的动作名。
   * @param createdAt - 所属任务的创建时刻（ISO）。
   * @returns 是否属于历史豁免范围。
   */
  const isHistoric = (action, createdAt) => action === 'updateDraft' && String(createdAt) < HISTORIC_BOUNDARY
  const DONE_WORDS = /已改好|已经改好|改好了|已存回|已经存回|已写入|已保存|已完成|已发布成功|已经发布|已发布到|已删除|已经生成|已创建/
  const HONEST_WORDS = /尚未|未发布|还没|待确认|请你|需要你|等你|去页面|确认后|已提交|提交给前端|提交了申请|申请已提交|不代表|未回填|没有执行/
  const replyOf = (task) => {
    const list = (task.messages ?? []).filter((m) => m !== null && typeof m === 'object' && m.type === 'assistant')
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const text = typeof list[i].message === 'string' && list[i].message.trim() !== '' ? list[i].message : list[i].content
      if (typeof text === 'string' && text.trim() !== '') return text
    }
    return ''
  }
  let tasks = []
  try { tasks = JSON.parse(readFileSync(LEDGER, 'utf8')).value ?? [] } catch { tasks = [] }
  const pending = []
  const historic = []
  let settledCards = 0
  for (const task of tasks) {
    const cards = []
    for (const m of task.messages ?? []) for (const r of Array.isArray(m?.result) ? m.result : []) if (r !== null && typeof r === 'object') cards.push(r)
    const open = cards.filter((r) => !SETTLED.has(String(r.state)))
    settledCards += cards.length - open.length
    if (open.length === 0) continue
    const reply = replyOf(task).replace(/\s+/g, ' ')
    const row = {
      id: task.id,
      createdAt: String(task.createdAt ?? ''),
      open: open.map((r) => String(r.action) + ':' + String(r.state)).join(','),
      claims: DONE_WORDS.test(reply) && !HONEST_WORDS.test(reply),
      reply: reply.slice(0, 56),
    }
    // 全部未回填卡都是"历史既成事实"才进豁免清单；只要有一张不是，整个任务按新问题判。
    if (open.every((r) => isHistoric(String(r.action), task.createdAt))) historic.push(row)
    else pending.push(row)
  }
  const liars = pending.filter((p) => p.claims)
  check(liars.length === 0, 'action-requested-not-claimed-done',
    '未回填动作 ' + pending.length + ' 个任务（已回填动作 ' + settledCards + ' 个）；其中回复无凭据声称完成的 ' + liars.length + ' 个'
    + (liars.length === 0 ? '' : '：' + liars.map((p) => p.id + '（' + p.open + '）').join('、')))
  // 历史清单**不得增长**（用 <= 而不是 !=：变少是好事——有人重跑那些对话把历史修掉了）。
  // 这条锁的作用：防止有人为了让它变绿，把新产生的 requested 卡也塞进历史豁免里。
  const historicLiars = historic.filter((p) => p.claims)
  check(historic.length <= HISTORIC_BASELINE, 'historic-liars-not-growing',
    '历史既成事实 ' + historic.length + ' 条（基线 ' + HISTORIC_BASELINE + '；其中当时无凭据声称完成的 ' + historicLiars.length + ' 条）'
    + (historic.length > HISTORIC_BASELINE ? '——**比基线多了，说明有新的问题被当成历史**，请查时间界与豁免条件' : ''))
  for (const p of pending) console.log('     · [新] ' + p.id + ' [' + p.open + '] ' + (p.claims ? '⚠ 回复声称完成：' : '回复：') + p.reply)
  for (const p of historic) console.log('     · [历史 ' + p.createdAt + '] ' + p.id + ' [' + p.open + '] ' + (p.claims ? '⚠ 当时回复声称完成：' : '回复：') + p.reply)
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter(item => !item.ok)
console.log('')
console.log('AI 智能体动作链路门禁：' + (results.length - failed.length) + '/' + results.length + ' 通过' + (failed.length ? '，失败：' + failed.map(item => item.id).join(', ') : ''))
console.log('被验产物：' + LIB)
// 用 exitCode 而不是 process.exit()：本脚本末尾刚做过 rmSync，立即 exit 会让 libuv 在收尾时
// 撞上「句柄正在关闭」的断言（2026-10-13 实测退出码变成 -1073740791，调用方会把它当成崩溃而不是判红）。
// 设 exitCode 让 Node 自己走完收尾流程——本脚本零联网、无挂起句柄，自然退出是安全的。
process.exitCode = failed.length === 0 ? 0 : 1
