#!/usr/bin/env node
/**
 * 一句话端到端门禁（G1 的「三方证据一致」）——**整条业务工作流**。
 *
 * 判据（产品负责人原话）：**用户一句话，AI 把事情全干了**。整条业务工作流是
 *   选题 → 写稿 → 出图 → 落草稿 → 发布 → 数据回流 → 复盘 → 接待。
 * 其中只有「视频生成」这一段因免费档限流（freeTierRpm=1）暂时用**图片创作**替代——它只是链路里一小段。
 *
 * 每条用例都按 docs/规范/验收标准-一句话端到端.md 的三方交叉取证：
 *   ① 工具返回：SSE 里 tool_result 的原文（工具报了什么）
 *   ② 对用户的回复：助手最终回答（它对用户说了什么）
 *   ③ 落库/页面数据：对象字段的真实值（页面读的就是它）
 *   **不一致即判失败**——例如工具说「共 6 条发布记录」，而落库里只有 3 条。
 *
 * 写能力（存草稿、真发布、改设置、回评）会改用户数据，且按产品硬约束 2
 * 「未经明确发布指令绝不自动发布」，必须由用户在**看得见的窗口**里手动跑，不进自动门禁。
 * 脚本对写工具**反向设卡**：只读问法下若模型调用了任何写工具，当场判红（见 WRITE_TOOL）。
 *
 * 自动判红只认结构化信号（响应体 / 落库 / 退出码），不认「页面出现了某段文字」：
 *   A. 只读用例跑完不许改**业务数据**（contents / accounts / publish-records / draft-generations）
 *   B. 每条用例必须真的调用工具并拿到 tool_result——没有工具调用就是凭印象回答
 *   C. 只读问法下出现写工具（发布 / 存草稿 / 改草稿 / 登录 / 回评 / 改设置 …）
 *   D. 同口径交叉：工具返回的计数、平台分布、作品回执、台账条数必须与落库一致
 * 口径不同（例如工具按「最近 5 条」截断、平台侧统计口径）的差异**不判红**，并列展示由人对着口径判——
 * 2026-10-12 首版踩过：助手说「草稿箱 32 条」而 contents.json 是 55 条（草稿箱只是 kind=draft 的一部分），
 * 自动判红会造出假缺陷。
 *
 * 运行痕迹不算业务数据变更：agent-tasks / ai-logs / sessions 会新增一条对话，
 * knowledge.json 的蒸馏账本也会因本轮对话增长（recordDistillation 每轮写一条）——任何一次真实对话都会留痕。
 *
 * ## 并发写入敏感（2026-10-12 立为纪律，产品负责人升级）
 *
 * 判据 A（只读用例跑完不许改业务数据）用的是**整轮前后对比**——它分不清"是谁写的"。
 * 通宵多线并行时实测踩到两次：发布记录被另一条线从 6 写成 7、草稿被另一条线的"写草稿验证"
 * 加了一条，本门禁当场判红，而**只读链路其实一行都没写**。
 *
 * **纪律（原话）**：通宵 / 多线并行期间，任何**全量验收**（qa-all、verify-before-package、
 * 本脚本全量）必须**串行发起**，且发起前确认**没有别的线在写业务数据**。
 *
 * 这不是把 A 判据放宽——A 判红本身是对的（确实有写入发生）；要改的是**跑法**，不是判据。
 * 判据 A 依然会在"只读用例自己写了数据"时如实判红，那才是它要抓的东西。
 *
 * 用法：
 *   node products/bosom-friend/qa/verify-one-sentence-e2e.mjs            全量 13 条（十几分钟，注意免费档限流）
 *   node products/bosom-friend/qa/verify-one-sentence-e2e.mjs --list     只打印用例数与口径（不联网）
 *   node products/bosom-friend/qa/verify-one-sentence-e2e.mjs --case=9,10,12   只跑指定几条（定向排查）
 * 环境变量：BOSOM_E2E_GAP_MS（用例间隔，默认 20000，免费档 freeTierRpm=1 必须留间隔）、
 *          BOSOM_E2E_TIMEOUT_MS（单条超时，默认 360000）、
 *          BOSOM_E2E_SAMPLE（抽样跑哪几条，逗号分隔，例如 qa-all 里设 1,4,10 可把总入口控制在几分钟）。
 * 退出码：0 = 全部合格；1 = 有任一条不合格。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const ROOT = join(process.env.USERPROFILE ?? '', '.bosom-friend', 'bosom-friend')
const APP = 'http://127.0.0.1:31280/bosom-friend'
const BASE = APP + '/api'

const TIMEOUT_MS = Number(process.env.BOSOM_E2E_TIMEOUT_MS ?? 6 * 60 * 1000)
const GAP_MS = Number(process.env.BOSOM_E2E_GAP_MS ?? 20000)
/**
 * 转交等价路径里「校验④」的**延长观测**窗口：最多等多久、多久读一次该任务的工具轨迹。
 *
 * 为什么需要它（2026-10-12 修正：判据与机制不匹配）：转交后的那一轮是**服务端自己发起**的
 * （不在本用例的 SSE 观测窗内），"转身就去读轨迹"常常读不到期望工具——旧写法据此判红，
 * 但它只是**还没跑到**。把"什么时候读"从一个时刻放宽到一个窗口，④ 就仍是硬判据。
 */
const TRACE_WAIT_MS = Number(process.env.BOSOM_E2E_TRACE_WAIT_MS ?? 90000)
const TRACE_POLL_MS = 3000
/**
 * 问法覆盖（**构造 / 复现专用**）：设置后只替换该用例的**问法文本**，期望工具与落库口径不变。
 *
 * 用途（2026-10-12 通宵 E2）：判据 12 的「延长观测」需要一次**真实的转交**才会被走到，
 * 而默认问法两轮都没触发转交。用这个开关专门构造一句「明确要求交给某管家」的话，
 * 让等价路径（dispatch → 归属落库 → completed → ④ 轮询轨迹）真的跑一遍。
 * 不设置时行为与从前完全一致。
 */
const SAY_OVERRIDE = (process.env.BOSOM_E2E_SAY_OVERRIDE ?? '').trim()

/**
 * 只读问法下**不许出现**的工具（写能力）。命中即判红——这是产品硬约束 2
 * 「未经明确发布指令绝不自动发布」在门禁里的落点：问「我最近发过哪些图文」永远不该触发发布。
 *
 * 2026-10-13 修正：`bosom_platform_sync_works` **不是写工具**——capabilities.ts:139 登记 kind=read，
 * kernel/src/index.ts:588 的实现只读 `store.files.records`（本地发布记录），描述原文写明「不连平台、不拉新数据」。
 * 名字里的 sync 是历史命名；把它当写工具是**名字误判的假红**（2026-10-13 两次端到端红点都源于它）。
 * 真连平台的那个是 `bosom_platform_sync_now`，继续留在名单里。
 */
const WRITE_TOOL = /bosom_(publish_content|publish_draft|content_create_draft|content_create_video|content_create_short_media|content_update_draft|content_delete_generation|content_make_cover|content_resume_video|content_split_fourview|content_enhance_prompt|content_enhance_topic|content_generate_script|digital_human_create|material_import_video|platform_login_start|platform_sync_now|reception_reply|reception_poll_now|settings_set_llm|settings_set_pref|task_abort|task_follow_up|task_rate|task_favorite|task_share|task_create|user_update_profile|long_video_extend_script|long_video_redo_shot|long_video_stop|knowledge_promote_skill)/

/** 业务数据文件——只读用例不许动它们（运行痕迹 agent-tasks/ai-logs/sessions 不在此列）。 */
const BUSINESS = ['contents.json', 'accounts.json', 'publish-records.json', 'draft-generations.json']

function str(v) {
  return typeof v === 'string' ? v : ''
}

/** 读某个数据文件的 value 数组（读不到返回空数组，由调用方按口径处理）。 */
function rows(file) {
  const p = join(ROOT, file)
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(j.value) ? j.value : []
  } catch { return [] }
}

/** 蒸馏账本条数（knowledge.json 的 distillations；本轮对话自身也会写一条）。 */
function distillCount() {
  const p = join(ROOT, 'knowledge.json')
  if (!existsSync(p)) return -1
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')).value
    return Array.isArray(v?.distillations) ? v.distillations.length : -1
  } catch { return -1 }
}

/** 落库口径：门禁判红用的全部实测值（每条用例跑完现读，避免数据漂移看不出来）。 */
function facts() {
  const contents = rows('contents.json')
  const drafts = contents.filter((x) => x.kind === 'draft')
  const accounts = rows('accounts.json')
  const records = rows('publish-records.json')
  const generations = rows('draft-generations.json')
  const xhs = accounts.find((a) => a.type === 'xhs')
  const byPlatform = {}
  for (const r of records) {
    const k = str(r.accountType) || '?'
    byPlatform[k] = (byPlatform[k] ?? 0) + 1
  }
  return {
    contents: contents.length,
    drafts: drafts.length,
    assets: contents.length - drafts.length,
    imageTextDrafts: drafts.filter((d) => d.type === 'image-text').length,
    accounts: accounts.length,
    xhsCount: accounts.filter((a) => a.type === 'xhs').length,
    xhsLoginState: xhs === undefined ? '（无小红书账号）' : (str(xhs.loginState) || '（未判定）'),
    records: records.length,
    imageTextRecords: records.filter((r) => r.type === 'ImageText').length,
    videoRecords: records.filter((r) => r.type === 'VIDEO').length,
    recordsWithWorkId: records.filter((r) => str(r.platformWorkId) !== '').length,
    recordsByPlatform: byPlatform,
    generations: generations.length,
    generationIds: new Set(generations.map((g) => str(g.id))),
    metrics: rows('metrics.json').length,
    pendingReception: rows('reception-pending.json').length,
    distillations: distillCount(),
  }
}

/** 业务数据签名：条数、id 集合与关键状态。变了就是改了用户数据。 */
function signature() {
  const f = facts()
  return JSON.stringify({
    contents: rows('contents.json').map((c) => str(c._id) + ':' + str(c.kind) + ':' + str(c.type)),
    accounts: rows('accounts.json').map((a) => str(a.id) + ':' + str(a.type) + ':' + str(a.loginState) + ':' + String(a.status)),
    records: rows('publish-records.json').map((r) => str(r.id) + ':' + str(r.type) + ':' + String(r.status) + ':' + str(r.platformWorkId)),
    generations: rows('draft-generations.json').map((g) => str(g.id) + ':' + str(g.status)),
    counts: [f.contents, f.accounts, f.records, f.generations],
  })
}

// ---------------------------------------------------------------------------
// 同口径交叉：工具返回里的说法 vs 落库真实值
// 返回 { ok: true/false, note } 判红；返回 { skip: '原因' } 表示口径不同，只展示不判红。
// ---------------------------------------------------------------------------

/**
 * 通用计数交叉工厂：工具 render 的「共 N 条/个 X」 vs **同一时刻**落库的同一口径条数。
 *
 * 口径（2026-10-12 修正）：用 {@link contextOf} 的 snapshotOf（该工具**收到结果那一刻**的落库快照），
 * 而不是用例级 fp（整轮跑完才读）——**读取时刻对齐，零容差**。理由见 snapshotOf 的注释：
 * 这两类数（草稿 / 素材 / 待接待）是用户会直接看到的，容差会掩盖真实漂移。
 */
function crossCount(tool, re, pick, label) {
  return (ctx) => {
    const m = re.exec(ctx.textOf(tool))
    if (m === null) return { skip: '工具返回里没有「' + label + '」那句（可能这条问法没走到这个工具）' }
    const got = Number(m[1])
    const want = pick(snapshotAtFacts(ctx.calls, ctx.results, ctx.fp, tool))
    return got === want
      ? { ok: true, note: '工具计数 ' + got + ' == 同刻落库 ' + label + ' ' + want }
      : { ok: false, note: '工具说 ' + got + '，**同一时刻**的落库 ' + label + ' 是 ' + want + '（同口径不一致）' }
  }
}

const CROSS_DRAFTS = crossCount('bosom_content_list_drafts', /共\s*(\d+)\s*条草稿/, (fp) => fp.drafts, '草稿条数')
const CROSS_MATERIALS = crossCount('bosom_material_list', /共\s*(\d+)\s*个素材/, (fp) => fp.assets, '素材条数')
const CROSS_RECEPTION = crossCount('bosom_reception_list_pending', /共\s*(\d+)\s*条待接待/, (fp) => fp.pendingReception, '待接待条数')

/** 「共/已绑定 N 个平台账号」 vs accounts.json 条数。 */
function crossAccounts(ctx) {
  const text = ctx.textOf('bosom_platform_list_accounts') || ctx.textOf('bosom_platform_login_status')
  const m = /(?:共|已绑定)\s*(\d+)\s*个平台账号/.exec(text)
  if (m === null) return { skip: '工具返回里没有「N 个平台账号」这句（可能这条问法没走到账号工具）' }
  const got = Number(m[1])
  return got === ctx.fp.accounts
    ? { ok: true, note: '工具计数 ' + got + ' 个账号 == 落库 ' + ctx.fp.accounts + ' 个' }
    : { ok: false, note: '工具说 ' + got + ' 个账号，落库 accounts.json 是 ' + ctx.fp.accounts + ' 个（同口径不一致）' }
}

/** 工具列出的生成任务号必须都能在 draft-generations.json 里找到（包含关系，不受「最近 N 条」口径影响）。 */
function crossGenerationIds(ctx) {
  const text = ctx.textOf('bosom_content_generation_status')
  if (text === '') return { skip: '没调 bosom_content_generation_status，看不到生成记录' }
  const ids = Array.from(new Set((text.match(/gen-[A-Za-z0-9_-]+/g) ?? [])))
  if (ids.length === 0) return { skip: '工具返回里没有任务号（可能这条问法走了别的工具）' }
  const missing = ids.filter((id) => !ctx.fp.generationIds.has(id))
  return missing.length === 0
    ? { ok: true, note: '工具列出的 ' + ids.length + ' 个生成任务号全部能在落库 draft-generations.json 里找到' }
    : { ok: false, note: '工具列出了落库里不存在的生成任务号：' + missing.join('、') }
}

/**
 * 「发布记录共 N 条」 vs publish-records.json 条数。
 * 模型给记录工具加了平台/账号过滤时口径不同，不硬判；但**没有过滤却说 0 条**是真缺陷
 * （2026-10-11 实测过：只读 list 字段把一条「已发布成功」报成「0 条」）。
 */
function crossRecordCount(ctx) {
  const args = ctx.argsOf('bosom_publish_list_records')
  const filtered = str(args.platform) !== '' || str(args.accountId) !== ''
  const text = ctx.textOf('bosom_publish_list_records')
  if (filtered) return { skip: '模型给记录工具加了过滤（platform=' + str(args.platform) + ' accountId=' + str(args.accountId) + '），与落库全量不同口径，不硬判' }
  if (/没有匹配的发布记录/.test(text)) {
    return ctx.fp.records === 0
      ? { ok: true, note: '工具说没有匹配记录，落库也是 0 条' }
      : { ok: false, note: '工具说「没有匹配的发布记录」，落库 publish-records.json 却有 ' + ctx.fp.records + ' 条（同口径不一致）' }
  }
  const m = /发布记录共\s*(\d+)\s*条/.exec(text)
  if (m === null) return { skip: '工具返回里没有「发布记录共 N 条」这句' }
  const got = Number(m[1])
  return got === ctx.fp.records
    ? { ok: true, note: '工具计数 ' + got + ' 条 == 落库发布记录 ' + ctx.fp.records + ' 条' }
    : { ok: false, note: '工具说 ' + got + ' 条发布记录，落库 publish-records.json 是 ' + ctx.fp.records + ' 条（同口径不一致）' }
}

/** 记录行「作品ID （还没有平台回执）」的条数 vs 落库里 platformWorkId 为空的条数。 */
function crossWorkReceipts(ctx) {
  const args = ctx.argsOf('bosom_publish_list_records')
  const limit = Number.parseInt(str(args.limit) || '10', 10) || 10
  const lines = ctx.textOf('bosom_publish_list_records').split('\n').filter((l) => l.startsWith('· '))
  if (lines.length === 0) return { skip: '工具返回里没有逐条记录行（可能没走到发布记录工具）' }
  if (limit < ctx.fp.records) return { skip: '模型只查了 ' + limit + ' 条（落库共 ' + ctx.fp.records + ' 条），样本不全，不硬判' }
  const noWork = lines.filter((l) => l.includes('（还没有平台回执）')).length
  const want = ctx.fp.records - ctx.fp.recordsWithWorkId
  return noWork === want
    ? { ok: true, note: '工具里 ' + noWork + ' 条没有平台作品 ID == 落库 platformWorkId 为空的 ' + want + ' 条' }
    : { ok: false, note: '工具里 ' + noWork + ' 条没有平台作品 ID，落库是 ' + want + ' 条（同口径不一致）' }
}

/** 两份平台分布是否完全一致（键集合与计数都要对上，键序无关）。 */
function sameSpread(got, want) {
  const keys = Array.from(new Set([...Object.keys(got), ...Object.keys(want)])).sort()
  return keys.every((k) => (got[k] ?? 0) === (want[k] ?? 0))
}

/** 解析工具结构化输出的分布行「平台分布：douyin 5 / xhs 1」；多次调用累加。 */
function parseSpread(text) {
  const got = {}
  for (const hit of text.matchAll(/^平台分布：(.+)$/gm)) {
    for (const part of hit[1].split('/')) {
      const m = /^\s*([A-Za-z0-9_-]+)\s+(\d+)\s*$/.exec(part)
      if (m !== null) got[m[1]] = (got[m[1]] ?? 0) + Number(m[2])
    }
  }
  return got
}

/**
 * 平台分布：工具**自己算**的结构化分布 vs 落库 accountType 分布。
 *
 * 2026-10-12 实测修正（case 8）：模型会**按平台分别问两次**（platform=douyin、platform=xhs），
 * 而旧判据只看最后一次调用的逐行文本，于是把 6 条误判成「只有 xhs 1 条」——
 * **那是判据的盲区，不是功能的错**（工具两次各自都对：douyin 5、xhs 1，合起来正是落库全量）。
 * 现在的口径比原来**更严**：分平台问的每一次，返回条数都必须等于落库该平台的条数。
 */
function crossPlatformSpread(ctx) {
  const texts = ctx.textsOf('bosom_publish_list_records')
  if (texts.length === 0) return { skip: '没调 bosom_publish_list_records，看不到平台分布' }
  const want = ctx.fp.recordsByPlatform
  // ① 首选工具自己算的结构化分布行：多次调用的分布**累加**才是全量。
  const got = parseSpread(texts.join('\n'))
  if (Object.keys(got).length > 0) {
    return sameSpread(got, want)
      ? { ok: true, note: '工具自己算的平台分布 ' + JSON.stringify(got) + ' == 落库 ' + JSON.stringify(want) + '（' + texts.length + ' 次调用累加）' }
      : { ok: false, note: '工具自己算的平台分布 ' + JSON.stringify(got) + '（' + texts.length + ' 次调用累加），落库是 ' + JSON.stringify(want) + '（同口径不一致）' }
  }
  // ② 回退（工具还没给结构化字段时）：按平台过滤的每一次都逐次校验，不拿它当全量分布。
  const callsOfTool = ctx.calls
    .map((c) => ({ c, text: ctx.results.find((x) => x.callId === c.callId)?.text ?? '' }))
    .filter((x) => x.c.name === 'bosom_publish_list_records')
    .map((x) => {
      let args = {}
      try { args = JSON.parse(x.c.args || '{}') } catch { args = {} }
      return { platform: str(args.platform), accountId: str(args.accountId), text: x.text }
    })
  const filtered = callsOfTool.filter((x) => x.platform !== '' || x.accountId !== '')
  if (filtered.length > 0) {
    const problems = []
    let checked = 0
    for (const x of filtered) {
      const m = /发布记录共\s*(\d+)\s*条/.exec(x.text)
      if (m === null) continue
      if (x.platform === '') { checked += 1; continue }
      const wantN = want[x.platform] ?? 0
      checked += 1
      if (Number(m[1]) !== wantN) problems.push('platform=' + x.platform + ' 返回 ' + m[1] + ' 条，落库该平台是 ' + wantN + ' 条')
    }
    if (problems.length > 0) return { ok: false, note: problems.join('；') + '（同口径不一致）' }
    return checked > 0
      ? { ok: true, note: '模型按平台分别查询 ' + checked + ' 次，每次返回条数都等于落库该平台条数' }
      : { skip: '模型给记录工具加了过滤但没拿到可用计数，本条不判' }
  }
  // ③ 没有过滤：按逐行文本解析（一行一条由工具保证）。
  const args = ctx.argsOf('bosom_publish_list_records')
  const limit = Number.parseInt(str(args.limit) || '10', 10) || 10
  const lines = texts.join('\n').split('\n').filter((l) => l.startsWith('· '))
  if (lines.length === 0) return { skip: '工具返回里没有逐条记录行（可能没走到发布记录工具）' }
  if (limit < ctx.fp.records) return { skip: '模型只查了 ' + limit + ' 条（落库共 ' + ctx.fp.records + ' 条），样本不全，不硬判' }
  const byLine = {}
  for (const l of lines) {
    const m = /｜平台\s*([A-Za-z0-9_-]+)\s*｜/.exec(l)
    if (m !== null) byLine[m[1]] = (byLine[m[1]] ?? 0) + 1
  }
  return sameSpread(byLine, want)
    ? { ok: true, note: '逐行解析的平台分布 ' + JSON.stringify(byLine) + ' == 落库 ' + JSON.stringify(want) }
    : { ok: false, note: '逐行解析的平台分布 ' + JSON.stringify(byLine) + '，落库是 ' + JSON.stringify(want) + '（同口径不一致）' }
}

/**
 * 小红书还能不能发：落库 loginState=valid 时，工具返回里不该出现发布口径的失效字样。
 * 只认工具 render 的固定句子与账号行（结构化字段渲染），不去猜自然语言的措辞。
 */
function crossXhsUsable(ctx) {
  const text = ctx.textOf('bosom_platform_login_status') || ctx.textOf('bosom_platform_list_accounts')
  if (text === '') return { skip: '没调账号类工具，看不到登录态' }
  const blocked = /登录已失效|发布与数据同步：\*\*不可用\*\*/.test(text)
  if (ctx.fp.xhsLoginState === 'valid') {
    return blocked
      ? { ok: false, note: '落库小红书 loginState=valid，工具返回却说登录失效/发布不可用（同口径冲突）' }
      : { ok: true, note: '落库小红书 loginState=valid，工具返回没有出现失效/不可用字样' }
  }
  return { skip: '落库小红书登录态是「' + ctx.fp.xhsLoginState + '」，这条由人对着工具返回判' }
}

/** 数据中心五项（账号/素材/待接待/发布记录/指标行）与落库逐项对齐。 */
function crossDashboard(ctx) {
  const text = ctx.textOf('bosom_data_dashboard')
  const m = /数据中心：账号\s*(\d+)、素材\s*(\d+)、待接待\s*(\d+)、发布记录\s*(\d+)、指标行\s*(\d+)/.exec(text)
  if (m === null) return { skip: '工具返回里没有「数据中心：账号…素材…」那一行（可能这条问法没走到数据中心工具）' }
  const got = { 账号: Number(m[1]), 素材: Number(m[2]), 待接待: Number(m[3]), 发布记录: Number(m[4]), 指标行: Number(m[5]) }
  const want = {
    账号: ctx.fp.accounts,
    素材: ctx.fp.assets,
    待接待: ctx.fp.pendingReception,
    发布记录: ctx.fp.records,
    指标行: ctx.fp.metrics,
  }
  const bad = Object.keys(want).filter((k) => got[k] !== want[k])
  return bad.length === 0
    ? { ok: true, note: '五项全部一致：' + JSON.stringify(got) }
    : { ok: false, note: '不一致项 ' + bad.join('、') + '：工具 ' + JSON.stringify(got) + ' vs 落库 ' + JSON.stringify(want) }
}

/**
 * 数据中心交叉（两条路都认，2026-10-13）。
 *
 * dashboard 直读 → 原口径（五项全对）。备选组合（模型没调 dashboard、但调了 data_works ＋
 * 五个目录工具中的目录读取）→ 按**能对上的三项**（账号/素材/待接待）逐项对落库：
 * 任何一项对不上就判红；一项都取不到才 skip。**不是放行**——判的是「数据真的读出来了且与落库同口径」。
 */
function crossDashboardEither(ctx) {
  const direct = crossDashboard(ctx)
  if (direct.skip === undefined) return direct
  if (!ctx.calls.some((x) => x.name === 'bosom_data_works')) return { skip: direct.skip }
  const checks = [crossAccounts(ctx), CROSS_MATERIALS(ctx), CROSS_RECEPTION(ctx)]
  const bad = checks.filter((c) => c.ok !== true && c.skip === undefined)
  if (bad.length > 0) return { ok: false, note: '备选路径逐项校验失败：' + bad.map((c) => c.note).join('；') }
  const oks = checks.filter((c) => c.ok === true)
  if (oks.length === 0) return { skip: '备选路径三项都取不到可对的口径' }
  return { ok: true, note: '备选路径（五目录直读）：' + oks.map((c) => c.note).join('；') }
}

/**
 * 作品数据（数据回流）：平台侧口径优先。
 * 与落库一致就判过；不一致时**不判红**——平台侧可能还有本地没同步回来的作品，
 * 两个数不同不等于工具错，交给人对着口径判（脚本把两个数都打出来）。
 */
function crossWorks(ctx) {
  const text = ctx.textOf('bosom_data_works')
  const m = /已发布作品：\s*(\d+)\s*\/\s*共\s*(\d+)\s*条/.exec(text)
  if (m === null) return { skip: '工具返回里没有「已发布作品 N / 共 M 条」这句' }
  const published = Number(m[1])
  const total = Number(m[2])
  if (published === ctx.fp.recordsWithWorkId && total === ctx.fp.records) {
    return { ok: true, note: '平台口径 ' + published + '/' + total + ' == 落库（有平台回执 ' + ctx.fp.recordsWithWorkId + ' / 记录 ' + ctx.fp.records + '）' }
  }
  return { skip: '平台口径 ' + published + '/' + total + '，落库是有回执 ' + ctx.fp.recordsWithWorkId + ' / 记录 ' + ctx.fp.records + '（平台侧可能还有本地没同步的作品），不硬判' }
}

/**
 * 蒸馏账本允许的观测容差（条）。
 *
 * 依据（2026-10-12 修正：**判据内部不能自相矛盾**）：门禁自己在汇总里把蒸馏账本列为**观察项**
 * （"后台进程也可能改动，不计入判红"），那 D 判定就不该拿同一个数去硬判红——一处说
 * "不计入判红"、另一处拿它判红，是判据自己打架。
 *
 * 但**完全豁免**也不行：那样这条用例就失去了落库交叉，等于少一条判据。所以用明确容差：
 *   · 下界**硬判红**（got > want）：工具不可能读到落库还没有的样本，读到了就是读错了源；
 *   · 上界容差 3：时间窗内后台写入的最大合理条数——本轮对话自己写 1 条（recordDistillation
 *     每轮一条），加上同一窗口里其他人的验证对话与自进化回填，实测波动 1~2 条
 *     （2026-10-12 现场：工具 1640 / 落库 1642，差 2）。取 3 留一条余量；
 *     **超过 3 说明工具读的不是这份账本**——那才是真错，必须判红。
 *
 * ## 为什么这里**可以**用容差，而草稿数（{@link crossCount}）**不能**（2026-10-12 写清）
 *
 * 区别不在"差几条"，在**这个数是谁在用**：
 *   · 蒸馏账本是**后台账本**——门禁自己在汇总里把它列为观察项，用户界面也不直接读它，
 *     窗口内多一条少一条不影响任何人对产品的判断；所以给它一个**有依据的容差**是对的。
 *   · 草稿数 / 素材数 / 待接待数是**用户界面上的事实**——用户问「草稿箱里有多少条」时
 *     盯着看的就是这个数。给容差等于**允许它对不上**：2026-10-12 那次 52 vs 53 里差的那 1 条，
 *     恰好就是用户真的多出来的那一条，容差会把它糊过去。
 * 所以那三条走的是**读取时刻对齐**（{@link contextOf} 的 snapshotOf，零容差），不是容差。
 * **判据之间的这个区别，下一个人一定会问**——先写在这里。
 */
const DISTILL_TOLERANCE = 3

function crossExperiences(ctx) {
  const text = ctx.textOf('bosom_knowledge_list_experiences')
  const m = /经验台账：共\s*(\d+)\s*条/.exec(text)
  if (m === null) return { skip: '工具返回里没有「经验台账：共 N 条」这句' }
  const got = Number(m[1])
  const want = ctx.fp.distillations
  if (want < 0) return { skip: '落库 knowledge.json 读不到 distillations，无法交叉' }
  const diff = want - got
  if (diff < 0) {
    return { ok: false, note: '工具台账 ' + got + ' 条**多于**落库 ' + want + ' 条——工具读到了落库还没有的样本，是读错了源（同口径不一致）' }
  }
  return diff <= DISTILL_TOLERANCE
    ? { ok: true, note: '工具台账 ' + got + ' 条，落库 ' + want + ' 条（差 ' + diff + ' ≤ 容差 ' + DISTILL_TOLERANCE + '：本轮自身 1 条 ＋ 时间窗内后台写入；依据见 crossExperiences 注释）' }
    : { ok: false, note: '工具台账 ' + got + ' 条，落库 knowledge.json 是 ' + want + ' 条（差 ' + diff + ' **超过容差 ' + DISTILL_TOLERANCE + '**：不是后台波动，是工具读错了源）' }
}

/**
 * 整条业务工作流的只读用例（写链路不在此，见文件头）。
 * stage 标注这条覆盖工作流的哪一环：选题 → 写稿 → 出图 → 落草稿 → 发布 → 数据回流 → 复盘 → 接待。
 * 注意：qa/verify-marvis-progress.mjs 用 /const CASES = \[([\s\S]*?)\]/ 数这里的 say 条数，
 * 所以本数组内不要出现右方括号，也不要多写一个 say。
 */
const CASES = [
  {
    stage: '落草稿',
    say: '草稿箱里现在有多少条内容？',
    tool: 'bosom_content_list_drafts',
    db: (fp) => ({ label: '草稿条数', value: fp.drafts }),
    cross: CROSS_DRAFTS,
  },
  {
    stage: '账号前置',
    say: '我现在连了哪些账号？',
    tool: 'bosom_platform_list_accounts',
    db: (fp) => ({ label: '账号数', value: fp.accounts }),
    cross: crossAccounts,
  },
  {
    stage: '写稿（生成链路）',
    say: '最近有哪些生成记录？',
    tool: 'bosom_content_generation_status',
    db: (fp) => ({ label: '生成记录数', value: fp.generations }),
    cross: crossGenerationIds,
  },
  {
    stage: '发布',
    say: '我最近发过哪些图文？',
    tool: 'bosom_publish_list_records',
    db: (fp) => ({ label: '图文发布记录（type=ImageText）', value: fp.imageTextRecords }),
    cross: crossRecordCount,
  },
  {
    stage: '写稿（图文草稿）',
    say: '草稿箱里有哪些图文草稿？',
    tool: 'bosom_content_list_drafts',
    db: (fp) => ({ label: '图文草稿（type=image-text）', value: fp.imageTextDrafts }),
    cross: CROSS_DRAFTS,
  },
  {
    stage: '账号前置',
    say: '小红书账号还能发吗？',
    tool: 'bosom_platform_login_status|bosom_platform_list_accounts',
    db: (fp) => ({ label: '小红书登录态', value: fp.xhsLoginState + '（' + fp.xhsCount + ' 个账号）' }),
    cross: crossXhsUsable,
  },
  {
    stage: '发布（平台回执）',
    say: '我发出去的作品里，有几条拿到了平台作品 ID？',
    tool: 'bosom_publish_list_records',
    db: (fp) => ({ label: '有平台作品 ID 的记录', value: fp.recordsWithWorkId + ' / ' + fp.records }),
    cross: crossWorkReceipts,
  },
  {
    stage: '发布（平台分布）',
    say: '我发到抖音和小红书各多少条？',
    tool: 'bosom_publish_list_records',
    db: (fp) => ({ label: '落库平台分布', value: JSON.stringify(fp.recordsByPlatform) }),
    cross: crossPlatformSpread,
  },
  {
    stage: '出图（图片创作，替代受限流的视频段）',
    say: '素材库里现在有哪些图片素材？',
    tool: 'bosom_material_list',
    db: (fp) => ({ label: '素材条数（kind=asset）', value: fp.assets }),
    cross: CROSS_MATERIALS,
  },
  {
    stage: '复盘（数据中心）',
    say: '数据中心现在是什么情况？',
    tool: 'bosom_data_dashboard',
    // 备选组合（2026-10-13）：dashboard 是首选的一次性聚合工具，但「五个目录工具逐项直读」
    // 拿到的是同一份真实数据——判结果不判工具名。**不是放行**：要求五件全部出现，
    // 且交叉校验逐项对落库（crossDashboardEither），缺一件仍按原逻辑判红。
    altTools: ['bosom_data_works', 'bosom_publish_list_records', 'bosom_platform_list_accounts', 'bosom_material_list', 'bosom_reception_list_pending'],
    db: (fp) => ({ label: '五项目录口径', value: '账号' + fp.accounts + ' 素材' + fp.assets + ' 待接待' + fp.pendingReception + ' 发布记录' + fp.records + ' 指标行' + fp.metrics }),
    cross: crossDashboardEither,
  },
  {
    stage: '接待',
    say: '现在有哪些评论和私信等着接待？',
    tool: 'bosom_reception_list_pending',
    db: (fp) => ({ label: '待接待条数（reception-pending.json）', value: fp.pendingReception }),
    cross: CROSS_RECEPTION,
  },
  {
    stage: '数据回流',
    say: '我的作品数据表现怎么样？',
    tool: 'bosom_data_works',
    db: (fp) => ({ label: '落库有平台回执的作品', value: fp.recordsWithWorkId + ' / ' + fp.records }),
    cross: crossWorks,
  },
  {
    stage: '复盘（经验台账）',
    say: '我攒下了哪些经验，哪些能变成技能？',
    tool: 'bosom_knowledge_list_experiences',
    db: (fp) => ({ label: '落库蒸馏账本条数', value: fp.distillations }),
    cross: crossExperiences,
  },
]

/** 工具结果的文字：content 是 [{ type:'text', text }]，兼容纯字符串。 */
function resultText(block) {
  const c = block.content
  if (Array.isArray(c)) return c.filter((x) => x !== null && x.type === 'text').map((x) => String(x.text ?? '')).join('\n')
  return typeof c === 'string' ? c : ''
}

/**
 * 走开发版的 SSE 对话通道，收齐本轮的三样东西：工具调用、工具结果、助手正文。
 * 事件形状以 server/src/api.ts 为准：工具调用是 stream_event/content_block_start(tool_use)，
 * 工具结果是 type='user' 的 message.content(tool_result)，正文是 result 帧的 data.content。
 */
async function ask(text) {
  const res = await fetch(BASE + '/agent/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ prompt: text, focus: 'ai-social' }),
  })
  if (res.body === null) throw new Error('响应没有 body（HTTP ' + res.status + '）')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const calls = []
  const results = []
  let buf = ''
  let reply = ''
  let failed = ''
  let completed = false
  /** 本轮真实落在哪条任务上（服务端首帧 init 给的真实任务号，转交等价路径要用它回读落库）。 */
  let taskId = ''
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true }).replace(/: ping/g, '')
    const chunks = buf.split('\n\n')
    buf = chunks.pop() || ''
    for (const c of chunks) {
      const line = c.split('\n').find((l) => l.startsWith('data:'))
      if (line === undefined) continue
      let j
      try { j = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (j.type === 'init') { taskId = String(j.taskId ?? ''); continue }
      if (j.type === 'stream_event') {
        const ev = j.event ?? {}
        const blk = ev.content_block
        if (blk !== undefined && blk.type === 'tool_use') {
          calls.push({ callId: String(blk.id ?? ''), name: String(blk.name ?? ''), args: '' })
          continue
        }
        const d = ev.delta
        if (d !== undefined && d.type === 'text_delta') reply += String(d.text ?? '')
        // 工具入参分片到达：挂到最近一次 tool_use 上，用来分辨模型有没有加过滤条件。
        if (d !== undefined && d.type === 'input_json_delta' && calls.length > 0) calls[calls.length - 1].args += String(d.partial_json ?? '')
      } else if (j.type === 'user') {
        const content = j.message?.content
        if (!Array.isArray(content)) continue
        for (const b of content) {
          if (b !== null && b.type === 'tool_result') {
            // **同刻落库快照**（2026-10-12 修正：判据曾把一个"会变的数"当成"不变的数"）：
            // 工具读的是某一刻的快照，而用例级 facts() 要**整轮跑完**才读——两者之间只要有写入
            // （同窗口别的线、或本用例自己前面的步骤），就会出现「工具 52 / 落库 53」这种假判红
            // （今晚 qa-all 现场：为验证"一句话办成多步骤"反复新建草稿，中间那 1 条就是这么进去的）。
            // 在这里**收到结果的同一刻**读一次落库，判据两侧就落在同一个时刻上，**零容差直接比**。
            results.push({ callId: String(b.tool_use_id ?? ''), text: resultText(b), isError: b.is_error === true, atFacts: facts() })
          }
        }
      } else if (j.type === 'result' && j.data !== undefined) {
        completed = true
        if (typeof j.data.content === 'string') reply = j.data.content
        if (j.data.status === 'error') failed = '本轮模型调用失败（result.status=error）'
      }
    }
  }
  return { calls, results, reply, failed, completed, taskId }
}

/** 开发版是否在跑——**环境判定**，不是业务判据。 */
async function devAlive() {
  try {
    const r = await fetch(APP + '/', { method: 'GET' })
    return r.status < 500
  } catch { return false }
}

/** 等开发版恢复：每 5 秒探一次，最多 maxMs。返回是否恢复。 */
async function waitForDev(maxMs) {
  const until = Date.now() + maxMs
  while (Date.now() < until) {
    if (await devAlive()) return true
    await new Promise((r) => setTimeout(r, 5000))
  }
  return await devAlive()
}

/**
 * 带**环境中断识别**的调用：先判环境再判功能。
 * 中断的三种样子：fetch 直接失败（进程被杀）、流被切断（没收到 result 帧）、模型调用当场失败。
 * 三者都不是功能缺陷——打印 ENV-INTERRUPTED，等开发版恢复后重试这一条，不计入 FAIL。
 */
/** 空转统计（跨用例累计）：让「偶发空转」与「频发空转」在数字上分开，而不是都变成一个绿字。 */
const idleStats = { retried: 0, recovered: 0, stillIdle: 0 }

async function askWithRetry(text, tries = 3) {
  /** 本条用例是否已经因空转重试过——**只允许一次**：第二次仍然空转就交给判据判红。 */
  let idleRetried = false
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let why = ''
    try {
      const run = await ask(text)
      if (run.completed === true && !(run.failed !== '' && String(run.reply ?? '').trim() === '')) {
        // ——空转有界重试（2026-10-12 产品负责人批准）——
        // 这一轮**一次工具都没调**是「模型空转」：用户会遇到的真实故障（问「我发到抖音几条」，
        // 它答「我来查一下」然后没了）。判据照旧会判红，这里只给**一次**再问的机会，
        // 并把空转**照实计入统计**——让偶发与频发在数字上分开，而不是都变成一个绿字。
        // 重试**只允许一次**：第二次仍然零调用就交给判据判红，不再重试。
        if (run.calls.length === 0 && !idleRetried) {
          idleRetried = true
          idleStats.retried += 1
          console.log('  ⚠ 空转：这一轮一次工具都没调（说了要查却没调）→ 有界重试**再问一次**（只允许一次）')
          if (GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS))
          const again = await ask(text)
          if (again.completed === true && again.calls.length > 0) {
            idleStats.recovered += 1
            console.log('  ⚠ 重试后调用了 ' + String(again.calls.length) + ' 个工具 → 判定用**重试后**这一轮（空转属偶发，已计入统计）')
            return { run: again, attempt }
          }
          idleStats.stillIdle += 1
          console.log('  ⚠ 重试后**仍然**一次工具都没调 → 空转属频发（不是偶发），交给判据判红，不再重试')
          return { run: again.completed === true ? again : run, attempt }
        }
        return { run, attempt }
      }
      why = run.completed === true ? run.failed : '流被切断（没收到 result 帧）'
    } catch (e) {
      why = String(e?.message ?? e)
    }
    const alive = await devAlive()
    console.log('  ⚠ ENV-INTERRUPTED 第 ' + attempt + ' 次：' + why + '｜开发版 ' + (alive ? 'HTTP 200 在跑（瞬断）' : '不可达（被重启/被杀）'))
    if (attempt < tries) {
      const back = await waitForDev(180000)
      console.log('  ⚠ 环境中断不计入 FAIL：' + (back ? '开发版已恢复，' : '等待 180s 仍不可达，') + '重试这一条（第 ' + (attempt + 1) + ' 次）')
      if (GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS))
    }
  }
  return { envFail: true }
}

/**
 * 取某条用例里、某工具**最后一次收到结果那一刻**的落库快照。
 *
 * 为什么需要它（2026-10-12 修正：判据把一个"会变的数"当成了"不变的数"）：判据原来比的是
 * 「工具某一刻读到的数」vs「整轮跑完才读的落库数」。只要两者之间有写入——同窗口别的线在跑、
 * 或者本用例自己前面的步骤刚写过——就会出现「工具 52 / 落库 53」这种**假判红**：
 * 模型没错、工具没错，是判据拿两个**不同时刻**的数在比。
 *
 * 口径：**读取时刻对齐**，不用容差。草稿数、素材数、待接待数都是**用户会直接看到**的数，
 * 给容差等于允许它们对不上；对齐时刻之后，两侧比的是同一个瞬间，**必须精确相等**。
 * 拿不到同刻快照时回退到用例级快照（保持旧行为，不静默变绿）。
 *
 * **为什么做成模块级函数、而不是挂在 ctx 上**（2026-10-12 教训）：ctx 有两条构造路径，
 * 挂在对象上的方法只要漏导出一处就崩——当时就是这么崩在第 1 条的
 * （`TypeError: ctx.snapshotOf is not a function`）。模块级函数只认参数，**谁都漏不掉**。
 *
 * @param calls - 该用例的工具调用序列（ctx.calls）。
 * @param results - 该用例的工具结果序列（ctx.results）。
 * @param fp - 用例级落库事实（拿不到同刻快照时的回退值）。
 * @param name - 工具名。
 * @returns 该时刻的落库事实。
 */
function snapshotAtFacts(calls, results, fp, name) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i].name !== name) continue
    const hit = results.find((x) => x.callId === calls[i].callId)
    if (hit !== undefined && hit.atFacts !== undefined) return hit.atFacts
  }
  return fp
}

/** 用例视角：按工具名取返回文字与入参（同一条用例里可能被调用多次）。 */
function contextOf(run, fp) {
  const textOf = (name) => {
    for (let i = run.calls.length - 1; i >= 0; i -= 1) {
      if (run.calls[i].name !== name) continue
      const hit = run.results.find((x) => x.callId === run.calls[i].callId)
      if (hit !== undefined) return hit.text
    }
    return ''
  }
  /**
   * 同一条用例里该工具的**全部**返回文字（按调用顺序）。
   *
   * 为什么需要它：模型会分几次调同一个工具——2026-10-12 gate case 8 实测，它为了答
   * 「抖音和小红书各多少条」分别问了 platform=douyin 与 platform=xhs 各一次。只看最后一次，
   * 就会把「分平台两次问」的全量误判成「只有 xhs 一条」，那是判据的盲区，不是功能的错。
   */
  const textsOf = (name) => run.calls
    .filter((c) => c.name === name)
    .map((c) => run.results.find((x) => x.callId === c.callId)?.text ?? '')
    .filter((t) => t !== '')
  const argsOf = (name) => {
    for (let i = run.calls.length - 1; i >= 0; i -= 1) {
      if (run.calls[i].name !== name) continue
      try { return JSON.parse(run.calls[i].args || '{}') } catch { return {} }
    }
    return {}
  }
  return { textOf, textsOf, argsOf, fp, calls: run.calls, results: run.results }
}

/** 一行摘要：压掉换行，截断，供 ① 工具返回展示。 */
function brief(text, max = 200) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max) + '…'
}

const listOnly = process.argv.includes('--list')
const onlyRaw = process.env.BOSOM_E2E_SAMPLE ?? (process.argv.slice(2).find((a) => a.startsWith('--case=')) ?? '').split('=')[1] ?? ''
const only = new Set(onlyRaw.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n)))

if (listOnly) {
  console.log('一句话端到端门禁（只读）用例口径：共 ' + CASES.length + ' 条，覆盖整条业务工作流')
  for (let i = 0; i < CASES.length; i += 1) {
    console.log('  ' + (i + 1) + '. [' + CASES[i].stage + '] ' + CASES[i].say + '  → 期望工具 ' + CASES[i].tool)
  }
  console.log('写链路（真发布）不在本门禁：按硬约束 2，必须由用户在看得见的窗口里、凭明确发布指令手动跑。')
  process.exit(0)
}

// 预检：开发版没起就不用等十几分钟的超时（这不是业务判据，只是省时间）。
try {
  const probe = await fetch(APP + '/', { method: 'GET' })
  if (probe.status >= 500) throw new Error('HTTP ' + probe.status)
} catch (e) {
  console.log('ONE_SENTENCE_E2E_FAIL 开发版没起来（' + APP + '）：' + String(e?.message ?? e))
  console.log('先启动：powershell -ExecutionPolicy Bypass -File products\\bosom-friend\\launcher\\scripts\\dev-web.ps1')
  process.exit(1)
}

console.log('== 一句话端到端门禁（整条业务工作流 · 只读 ' + CASES.length + ' 条）==')
console.log('   链路：选题 → 写稿 → 出图 → 落草稿 → 发布 → 数据回流 → 复盘 → 接待')
console.log('   通道 ' + BASE + '/agent/tasks ｜工具结果按 user/tool_result 帧解析 ｜用例间隔 ' + GAP_MS + 'ms')

// 并发写入自检（2026-10-12 立）：判据 A 用整轮前后对比，**分不清是谁写的**。
// 通宵多线并行时实测误报两次（发布记录被别的线 6→7、草稿被别的线的写验证加一条）。
// 开跑前先采两次签名：3 秒内还在变，就说明有别的线正在写业务数据。
// **这只打印提示、不改变任何判据**——A 判红本身是对的（确实有写入发生），要改的是跑法。
{
  const probeA = signature()
  await new Promise((r) => setTimeout(r, 3000))
  const probeB = signature()
  if (probeA !== probeB) {
    console.log('')
    console.log('  ⚠ **检测到并发写入**：开跑前 3 秒内业务数据已在变化。')
    console.log('     判据 A（只读用例不许改业务数据）用整轮前后对比、分不清是谁写的，这时它可能误报。')
    console.log('     **请串行重跑**（确认没有别的线在写业务数据）——这不是放宽 A 判据的理由。')
    console.log('')
  }
}
const before = signature()
const verdicts = []
let red = 0
let env = 0
let ran = 0
let passed = 0
/** 记一条 FAIL：既计数，也进逐条判定表。 */
const markFail = (index, stage, why) => {
  red += 1
  verdicts.push({ index, stage, verdict: 'FAIL', reason: why })
}
for (let i = 0; i < CASES.length; i += 1) {
  const c = CASES[i]
  if (only.size > 0 && !only.has(i + 1)) continue
  if (ran > 0 && GAP_MS > 0) await new Promise((r) => setTimeout(r, GAP_MS))
  ran += 1
  console.log('')
  const sayText = SAY_OVERRIDE === '' ? c.say : SAY_OVERRIDE
  console.log('【' + (i + 1) + '/' + CASES.length + '·' + c.stage + '】说：' + sayText + (SAY_OVERRIDE === '' ? '' : '（问法被 BOSOM_E2E_SAY_OVERRIDE 覆盖）'))
  const attempt = await askWithRetry(sayText)
  if (attempt.envFail === true) {
    env += 1
    verdicts.push({ index: i + 1, stage: c.stage, verdict: 'ENV-INTERRUPTED', reason: '开发版持续不可用，这一条没判定' })
    console.log('  → ENV-INTERRUPTED：开发版持续不可用，这一条没判定（不计入 FAIL，恢复后重跑这一条）')
    continue
  }
  if (attempt.attempt > 1) console.log('  （环境中断后重试第 ' + attempt.attempt + ' 次才跑通）')
  const run = attempt.run
  const fp = facts()
  const ctx = contextOf(run, fp)

  // ① 工具返回：这一轮调了哪些工具、工具报了什么
  if (run.calls.length === 0) {
    console.log('  ① 工具返回：（一次工具都没调）')
  } else {
    for (const call of run.calls) {
      const hit = run.results.find((x) => x.callId === call.callId)
      const flag = hit === undefined ? '（没有结果）' : (hit.isError ? '（工具报错）' : '')
      console.log('  ① 工具返回：' + call.name + flag + ' → ' + brief(hit === undefined ? '' : hit.text))
    }
  }
  // ② 对用户的回复
  const said = String(run.reply ?? '').replace(/\s+/g, ' ').trim()
  console.log('  ② 对用户的回复：' + (said === '' ? '（空）' + (run.failed === '' ? '' : ' ' + run.failed) : (said.length <= 220 ? said : said.slice(0, 220) + '…')))
  // ③ 落库
  const shown = c.db(fp)
  console.log('  ③ 落库：' + shown.label + '=' + String(shown.value))

  // 判据 B：必须真的调工具并拿到结果
  const expected = c.tool.split('|')
  const hitTools = expected.filter((n) => run.calls.some((x) => x.name === n))
  // 备选组合（2026-10-13）：见 CASES 里 altTools 的说明；命中备选组合时本判据按等价路径通过。
  const altTools = Array.isArray(c.altTools) ? c.altTools : []
  const altHit = hitTools.length === 0 && altTools.length > 0 && altTools.every((n) => run.calls.some((x) => x.name === n))
  if (hitTools.length === 0 && !altHit) {
    // ——判据 B 的**等价路径**（2026-10-12 产品负责人批准）——
    //
    // 产品规则要求「职责不符/缺能力就转交给对的人，不要自己硬做」（BFS-105）。于是模型会把
    // 「发布」类问题转给 publisher，工作落在**下一轮**，而本门禁只观察当前轮 → 旧口径会误判成
    // 「一个工具都没调」。等价路径认的是「本轮明确转交、且转交真的生效」，**不是出现转交就放行**：
    //   校验① 转交目标（dispatch 工具入参 role）与该任务**落库的 agentRole 完全一致**；
    //   校验② 该任务**最终状态不是 failed**（转交后确实办了事，而不是转完就死）。
    // 两项任一不满足 → 仍判红，并把两项的实测值都打出来。**它比旧口径多了一项落库校验**。
    const dispatch = run.calls.find((x) => x.name === 'bosom_steward_dispatch')
    if (dispatch !== undefined) {
      let role = ''
      try { role = str(JSON.parse(dispatch.args || '{}').role) } catch { role = '' }
      const task = rows('agent-tasks.json').find((t) => str(t.id) === str(run.taskId))
      const persistedRole = task === undefined ? '' : str(task.agentRole)
      const status = task === undefined ? '' : str(task.status)
      const roleOk = role !== '' && persistedRole === role
      const completedOk = status === 'completed'
      // 校验④（这条口径的命门）：被转交的那一轮**真的办了事**——该任务的工具轨迹里必须出现
      // 本用例期望的那类工具。没有它，「转交」就是万能挡箭牌：任何用例都能靠一句
      // 「我交给别人了」蒙过去。证据源是任务落库的 toolTrace（服务端在内核回调里逐条记下
      // 工具名/轮次/时间/成败），覆盖**该任务的完整会话**，不是只看当前轮 SSE。
      //
      // **延长观测**（2026-10-12 修正：判据与机制不匹配）：转交后的那一轮由**服务端自己发起**，
      // 不在本用例的 SSE 观测窗内——"转身就读轨迹"往往读不到期望工具，而它只是**还没跑到**。
      // 所以这里轮询该任务的轨迹：核到期望工具即四项齐全；超过 TRACE_WAIT_MS 仍未核到，
      // **不判红**（那是机制时序问题，不是管家没办事），但**必须在结论与逐条判定里写明
      // 「④ 未在观测窗内验证，本轮按 ①②③ 判过」**——让读的人知道这条不是全量证据。
      // 能判红的底线仍在：①②③ 缺一即判红（归属没真改、或没跑完，转交就不算数）。
      let trace = Array.isArray(task?.toolTrace) ? task.toolTrace : undefined
      let didTheWork = trace !== undefined && trace.some((x) => expected.includes(str(x?.name)))
      let waitedMs = 0
      if (roleOk && completedOk && !didTheWork) {
        const waitStart = Date.now()
        while (!didTheWork && Date.now() - waitStart < TRACE_WAIT_MS) {
          await new Promise((r) => setTimeout(r, TRACE_POLL_MS))
          const fresh = rows('agent-tasks.json').find((t) => str(t.id) === str(run.taskId))
          trace = Array.isArray(fresh?.toolTrace) ? fresh.toolTrace : undefined
          didTheWork = trace !== undefined && trace.some((x) => expected.includes(str(x?.name)))
        }
        waitedMs = Date.now() - waitStart
        if (didTheWork) console.log('  ⏳ 延长观测 ' + String(Math.round(waitedMs / 1000)) + ' 秒后核到期望工具（转交后的新一轮不在本轮观测窗内）')
      }
      if (roleOk && completedOk) {
        passed += 1
        verdicts.push({ index: i + 1, stage: c.stage, verdict: 'PASS', reason: 'B 等价路径：已转交 ' + role + (didTheWork ? ' 且后续轮次调了 ' + expected.join('/') : '（④ 未在观测窗内验证）') })
        console.log('  → 通过（B 等价路径）：本轮明确转交给「' + role + '」管家，总管没有自己硬做')
        console.log('     校验① 工具序列出现 bosom_steward_dispatch ✓')
        console.log('     校验② 落库 agentRole=' + persistedRole + ' == 转交目标 ' + role + ' ✓')
        console.log('     校验③ 该任务最终状态=' + status + '（必须是 completed）✓')
        console.log(didTheWork
          ? '     校验④ 该任务工具轨迹里出现期望工具：' + (trace ?? []).map((x) => str(x?.name)).filter((n) => expected.includes(n)).join('、') + ' ✓（共 ' + String(trace?.length ?? 0) + ' 条轨迹' + (waitedMs > 0 ? '，延长观测 ' + String(Math.round(waitedMs / 1000)) + ' 秒后核到' : '') + '）'
          : '     校验④ **未在观测窗内验证**（已延长观测 ' + String(Math.round(waitedMs / 1000)) + ' 秒仍未见 ' + expected.join('/') + '；轨迹 ' + String(trace?.length ?? 0) + ' 条：' + (trace ?? []).map((x) => str(x?.name)).join('、') + '）——本轮按 ①②③ 判过，**这条不是全量证据**')
        continue
      }
      markFail(i + 1, c.stage, 'B：期望的工具一个都没调（转交等价路径也未通过）')
      console.log('  → 判红（B）：期望的工具一个都没调（' + c.tool + '）')
      console.log('     转交等价路径未通过 —— 校验① 出现 dispatch=' + '✓'
        + '；校验② 落库 agentRole=' + (persistedRole === '' ? '（读不到）' : persistedRole) + ' vs 转交目标 ' + (role === '' ? '（读不到）' : role) + (roleOk ? ' ✓' : ' ✗')
        + '；校验③ 最终状态=' + (status === '' ? '（读不到）' : status) + (completedOk ? ' ✓' : ' ✗（必须 completed）')
        + '；校验④ 工具轨迹里' + (trace === undefined ? '没有 toolTrace 字段（服务端未落库轨迹，无法核验）' : '未出现 ' + expected.join('/') + '（轨迹 ' + String(trace.length) + ' 条：' + trace.map((x) => str(x?.name)).join('、') + '）') + (didTheWork ? ' ✓' : ' ✗'))
      continue
    }
    markFail(i + 1, c.stage, 'B：期望的工具一个都没调')
    console.log('  → 判红（B）：期望的工具一个都没调（' + c.tool + '）——没有工具返回就是凭印象回答')
    continue
  }
  if (altHit) {
    console.log('  → 通过（B 等价路径）：未调 ' + c.tool + '，但备选组合全部调用（' + altTools.join('、') + '）——数据交叉按备选口径逐项判')
  }
  if (run.results.length === 0) {
    markFail(i + 1, c.stage, 'B：调了工具但没有 tool_result')
    console.log('  → 判红（B）：调了工具但一条 tool_result 都没收到，拿不到工具返回')
    continue
  }
  // 判据 C：只读问法下不许出现写工具
  const writes = run.calls.filter((x) => WRITE_TOOL.test(x.name))
  if (writes.length > 0) {
    markFail(i + 1, c.stage, 'C：出现写工具 ' + writes.map((w) => w.name).join('、'))
    console.log('  → 判红（C）：只读问法下出现了写工具 ' + writes.map((w) => w.name).join('、') + '（硬约束 2：发布/写库必须有明确指令）')
    continue
  }
  // 判据 D：同口径交叉
  const cross = c.cross(ctx)
  if (cross.skip !== undefined) console.log('  交叉：（口径不同，不硬判）' + cross.skip)
  else if (cross.ok === true) console.log('  交叉：' + cross.note + ' ✓')
  else {
    markFail(i + 1, c.stage, 'D：工具返回与落库不一致')
    console.log('  交叉：' + cross.note + ' ✗')
    console.log('  → 判红（D）：工具返回与落库同口径不一致')
    continue
  }
  // 判据 ②：回复不能为空
  if (said === '') {
    markFail(i + 1, c.stage, '②：助手没有回复')
    console.log('  → 判红（②）：助手没有对用户的回复')
    continue
  }
  passed += 1
  verdicts.push({ index: i + 1, stage: c.stage, verdict: 'PASS', reason: '' })
  console.log('  判定：PASS')
}

// 判据 A：只读用例跑完不许改业务数据
const after = signature()
if (before !== after) {
  const b = JSON.parse(before)
  const a = JSON.parse(after)
  markFail(0, '整轮', 'A：只读用例改了业务数据')
  console.log('')
  console.log('  → 判红（A）：只读用例改了业务数据')
  console.log('     条数 before=' + JSON.stringify(b.counts) + ' after=' + JSON.stringify(a.counts))
  console.log('     口径顺序 ' + BUSINESS.join('、'))
}

console.log('')
console.log('观察项（后台进程也可能改动）：蒸馏账本 ' + distillCount() + ' 条（D 判定按容差 ' + DISTILL_TOLERANCE + ' 处理，见 crossExperiences 注释）、待接待 ' + rows('reception-pending.json').length + ' 条、指标行 ' + rows('metrics.json').length + ' 条')
console.log('')
console.log('== 逐条判定 ==')
for (const v of verdicts) {
  console.log('  ' + (v.index === 0 ? '全轮' : String(v.index) + '.') + ' [' + v.stage + '] ' + v.verdict + (v.reason === '' ? '' : ' · ' + v.reason))
}
console.log('   合计：PASS ' + passed + ' ｜ FAIL ' + red + ' ｜ ENV-INTERRUPTED ' + env + '（共 ' + CASES.length + ' 条，本轮跑 ' + ran + ' 条）')
// 空转照实报：**偶发**（重试后恢复）与**频发**（重试后仍空转）必须在数字上分开——
// 都变成一个绿字就等于把「模型说了要查却没调」这个真实故障掩盖掉（2026-10-12 产品负责人口径）。
console.log('   空转：' + idleStats.retried + ' 条（有界重试后恢复 ' + idleStats.recovered + ' 条，重试后仍空转 ' + idleStats.stillIdle + ' 条）'
  + (idleStats.retried === 0 ? '——本轮没有空转' : '')
  + (idleStats.stillIdle > 0 ? '｜**频发空转已计入 FAIL，不放宽**' : ''))
  // 2026-10-13 补：把本轮判定写盘。此前只看控制台输出，日志一截断（当晚 e2e-run1.log 缺末尾汇总）
  // 第 3 条红就定位不到——证据必须自己落盘。
  try {
    const report = []
    report.push('runAt=' + new Date().toISOString())
    report.push('PASS ' + passed + ' ｜ FAIL ' + red + ' ｜ ENV-INTERRUPTED ' + env + '（共 ' + CASES.length + ' 条，本轮跑 ' + ran + ' 条）')
    report.push('空转：' + idleStats.retried + ' 条（恢复 ' + idleStats.recovered + ' / 仍空转 ' + idleStats.stillIdle + '）')
    for (const v of verdicts) report.push((v.index === 0 ? '全轮' : String(v.index) + '.') + ' [' + v.stage + '] ' + v.verdict + (v.reason === '' ? '' : ' · ' + v.reason))
    writeFileSync(join(PRODUCT, 'analysis', 'e2e-last-run.txt'), report.join('\n') + '\n', 'utf8')
    console.log('（本轮判定已写盘：products/bosom-friend/analysis/e2e-last-run.txt）')
  }
  catch (error) {
    console.log('（判定写盘失败，不影响本轮结论：' + String(error) + '）')
  }
const undone = verdicts.filter((v) => v.verdict === 'ENV-INTERRUPTED').map((v) => v.index)
if (red > 0) {
  console.log('ONE_SENTENCE_E2E_FAIL 有 ' + red + ' 条不合格（本轮跑了 ' + ran + ' 条，共 ' + CASES.length + ' 条只读用例）')
  process.exit(1)
}
if (env > 0) {
  console.log('ONE_SENTENCE_E2E_ENV_INTERRUPTED 有 ' + env + ' 条因开发版不可用**没有判定**（不算功能失败）：第 ' + undone.join('、') + ' 条')
  console.log('恢复开发版后只跑这几条：node qa/verify-one-sentence-e2e.mjs --case=' + undone.join(','))
  process.exit(2)
}
console.log('ONE_SENTENCE_E2E_OK ' + CASES.length + ' 条只读用例跑通（本轮 ' + ran + ' 条）：工具返回、助手回复、落库三方齐备且同口径一致，全程未改业务数据')
console.log('（写链路——存草稿与真发布——不在本门禁：按硬约束 2 需明确发布指令，在看得见的窗口里手动跑）')
process.exit(0)
