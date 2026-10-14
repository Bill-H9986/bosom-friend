/**
 * 生成式工具面：把服务端**写操作**（POST/PUT/PATCH/DELETE 路由）登记成内核工具，
 * 由 {@link generatedTools} 循环注册——**必须走 register() 统一入口**（那一层管 preset 工具面 allowList），
 * 不允许 ctx.tools.register 绕过（qa/verify-kernel-tools.mjs 盯着这条）。
 *
 * 为什么要有它：管家原本只有 51 个工具，服务端写路由有 119 条（server/src 实测，2026-10-12）——
 * 大部分能力用户只能自己在页面上点，管家调不到。本文件是**流水线**：登记表 → 工具定义。
 *
 * **唯一事实源是 `server/src/capabilities.ts`**（能力注册表）：下面的 {@link CAPABILITIES} 逐条来自它，
 * 一条不落（含 `toolizable: false` 的 12 条——跳过发生在 {@link generatedTools} 里，不在这里删行，
 * 登记表有多少条、跳了多少条一眼可对账）。工具名一律用登记表的 `tool` 字段，**不再由路由路径硬拼**：
 * 两份产物同名，覆盖率才算得出来（此前两套名字的交集只有 4 个）。
 *
 * 当前口径（2026-10-12 实测，登记表 120 条）：去重工具名 117 个；`exists: true` 35 条（32 个工具名，
 * 内核已有手写工具承接）与 `toolizable: false` 12 条（固定拒绝端点、登录鉴权、协议回调、埋点、
 * 对话入口本身）都在生成时跳过；实际注册 73 条，与手写工具**零重名**。
 *
 * **本文件由生成器维护**：`node qa/gen-kernel-tools.mjs` 读登记表、只重写下面这段 {@link CAPABILITIES}
 * （判据、闸门、函数、注释都不动）。别手改投影——手改会被 `node qa/gen-kernel-tools.mjs --check` 当场判红（exit 1），
 * 那条命令就是「投影过期」的判据；登记表改了就跑一次生成器，再
 * `pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build`。
 * description 末尾的「【挑工具·…】该用它 / 不该用它」也由生成器按登记表的 TOOL_SELECTION_GUIDE 拼上。
 * {@link capabilityDrift} 是库里的漂移断言（把登记表传进来返回逐条差异）；门禁 qa/verify-kernel-tools.mjs
 * 另有一条源码文本级的同口径对账（capability-drift-registry-to-projection），两条互为对照。
 *
 * **危险动作有统一前置闸**（2026-10-12 立，硬约束 2 的机制化）：判据 note 优先、路由语义兜底，
 * 覆盖「发布 / 删除 / 账号 / 对外通道 / 中断」五类；这些工具必须带 `body.order`（用户明确指令的原话），
 * 缺了就**本地拒绝、不出站**，并把三个选择给用户。只读类（kind: read）不加闸——它们不改数据，
 * 加闸只会让管家干不成活。判据见 {@link dangerOf}，拒绝对话见 {@link refusalOf}。
 *
 * **2026-10-13 收严（P1「无闸写操作补闸」收口）**：五类语义之外的非只读路由**不再裸代理**——
 * 判据降到「非只读 = 必须有用户明确指令」，标签用「改用户数据」。此前 `distill/rate`、
 * `assets/uploadSign` 等 4 条落在这里（无闸、只验注册），现在全部进闸；五类仍是标签与判据来源。
 *
 * 接线锚点见文件末尾注释（index.ts 已接线，见那一节）。
 *
 * @module @deepseek-ai/dsh-bosom-friend-kernel/generated-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 内核统一注册入口（index.ts:152 的 register：受 preset 工具面 allowList 约束）。 */
export type RegisterFn = (tool: unknown) => void

/** 一个入参的登记：字段与 server/src/capabilities.ts 的 CapabilityParam 逐项对齐（登记侧是唯一事实源）。 */
export interface CapabilityParam {
  /** 服务端 handler 读的字段名（body 里的键）。 */
  name: string
  /** 字段类型。 */
  type: string
  /** 必填：缺了服务端会拒绝或办不成。 */
  required: boolean
  /** 给模型看的说明。 */
  description: string
  /** 只读验证用的示例值。 */
  sample: string | number | boolean
  /** 该字段是路由模板里的 `:name` 占位符。 */
  inPath?: boolean
}

/** 一条能力登记：字段与 server/src/capabilities.ts 的 Capability 逐项对齐，另加从 route 拆出的 method/path。 */
export interface CapabilityRow {
  /** 稳定 id（能力登记表主键，形如 steward.cleanupRunningTasks）。 */
  id: string
  /** 内核工具名（登记表的 tool 字段原样，不由路由路径拼）。 */
  tool: string
  /** 归属管家（登记表词表：creator / publisher / operator / device / steward）。 */
  role: string
  /** 给模型看的说明（登记表原文，逐字保留；纪律后缀在注册时补，见 {@link describeOf}）。 */
  description: string
  /** 内核里是否已有手写工具承接（true = 跳过生成，同一个服务端接口只留一个工具给模型）。 */
  exists: boolean
  /** 服务端出处：METHOD 路由模板。 */
  route: string
  /** 出处文件与行号（server/src 内相对路径）。 */
  source: string
  /** 路由语义：write 落数据 / read 只读 / reject 固定拒绝。 */
  kind: string
  /** 是否建议补成内核工具；false = 固定拒绝、安全动作或系统内部协议（生成侧跳过）。 */
  toolizable: boolean
  /** 服务端路由方法（从 route 拆出）。 */
  method: string
  /** 服务端路由路径（从 route 拆出，不带 /bosom-friend/api 前缀）。 */
  path: string
  /** 登记表里的补充约束（删除类只接受明确指令、发布类要用户点头等），注册时并入 description。 */
  note?: string
  /** 入参登记（已逐条核过服务端 handler 的字段名与必填）；缺省 = 尚未核过，模型只能按 body 自由传。 */
  params?: CapabilityParam[]
}

/** 危险动作的判据命中：label 是给用户看的类别，why 说明这条判据从哪来（登记表 note 还是路由语义）。 */
interface DangerVerdict {
  /** 动作类别（发布 / 删除 / 账号 / 对外通道 / 中断 / 对外沟通 / 通用动作）。 */
  label: string
  /** 判据来源，进拒绝对话与日志，便于以后复核为什么被拦。 */
  why: string
}

/** 登记表 note 里表示「要用户点头」的字样——note 是能力作者写下的现成判据，优先用它。 */
const NOTE_DANGER = /明确指令|高风险|对外通道/

/**
 * 路由兜底判据：note 没写到时按服务端语义判。**一条具体工具名都不硬编码**——
 * 登记表加了新路由，只要语义命中就自动进闸；只读类（kind: read）在 {@link dangerOf} 里先放行，
 * 所以查询 / 检索 / 预览 / 校验不会被误伤。
 */
const ROUTE_DANGER: readonly { pattern: RegExp, label: string, why: string }[] = [
  { pattern: /(^|\/)publish\//i, label: '发布', why: '路径是发布流程' },
  { pattern: /delete|clear|cleanup|unbind|remove/i, label: '删除', why: '路径含删除语义' },
  { pattern: /accounts\/(browser-)?register|accounts$|accounts\/:id$|accounts\/:id\/logout|account-groups|login|logout|miniapp-auth/i, label: '账号', why: '路径是账号增删 / 登录鉴权' },
  { pattern: /abort|stop/i, label: '中断', why: '路径是中止 / 停止动作' },
  { pattern: /tunnel/i, label: '对外通道', why: '路径是远程访问隧道' },
  { pattern: /feedback/i, label: '对外沟通', why: '路径是对外提交' },
  // 2026-10-12 拍板补的两条：仍不按工具名硬编码，按服务端语义判——
  // 通用动作入口的动作类型由请求体决定（可能含删除/发布），自动接待总开关一开就会自动回复用户（对外动作）。
  { pattern: /object-action/i, label: '通用动作', why: '路径是通用动作入口，动作类型由请求体决定（可能含删除/发布）' },
  { pattern: /customer-reception\/config/i, label: '对外通道', why: '自动接待总开关：开启后会自动回复用户（对外动作）' },
  // 2026-10-12 能力对账发现：这条原先登记为只读，实际 handler 只要分组存在就**无条件**改 updatedAt 并落盘
  // （body 为空也写）——只读短路（dangerOf 开头那行）会让它绕过所有闸。按服务端语义补判据，不硬编码工具名。
  { pattern: /contents\/groups\/info/i, label: '改分组', why: '分组详情写入口：分组存在时无条件改 updatedAt 并落盘（2026-10-12 读 handler 实测）' },
  // ---- 2026-10-12 通宵 E1 补闸（按服务端语义判，**一条工具名都不硬编码**）----
  // 判据：这一步被真跑时会不会**改用户数据**。
  // 判据必须落在**生成式工具真正会走的路径**上——第一版我按"对外回复 / 账号同步 / 改资料"写，
  // 负向对照（去掉规则再数闸门）当场证明那三条**一条都没生效**：它们对应的工具都是**手写工具**
  // （exists: true，生成器直接跳过），规则再好也作用不到。所以改按生成式登记表里**确实会生成**的
  // 写路由来判——这也是"判据要能被负向对照证伪"的价值：写错了它不会假装生效。
  { pattern: /pending\/:[A-Za-z]+\/status/i, label: '改接待状态', why: '改某条待接待记录的处置状态（改用户数据）' },
  { pattern: /agent\/tasks\/:taskId$/i, label: '改任务', why: '直接改任务记录（标题 / 归属管家）——改用户数据' },
]

/** 从 note 里读一个能给用户看的类别；读不出就笼统叫「危险动作」。 */
function labelOfNote(note: string): string {
  if (/发布|再发一次/.test(note)) return '发布'
  if (/删除/.test(note)) return '删除'
  if (/对外/.test(note)) return '对外通道'
  return '危险动作'
}

/**
 * 这条能力是不是**危险动作**（要用户明确指令才能做）。
 *
 * 判序：登记表 note 优先（能力作者写下的约束就是判据），note 没写到时按路由语义兜底；
 * 只读类（kind: read）一律放行——它们不改数据，加闸只会让管家干不成活。
 *
 * @param row - 一条能力登记。
 * @returns 命中时给出类别与判据来源；不危险时为 undefined。
 */
function dangerOf(row: CapabilityRow): DangerVerdict | undefined {
  if (row.kind === 'read') return undefined
  const note = row.note ?? ''
  if (NOTE_DANGER.test(note)) return { label: labelOfNote(note), why: '登记表 note：' + note }
  for (const rule of ROUTE_DANGER) {
    if (rule.pattern.test(row.route)) return { label: rule.label, why: '路由语义：' + rule.why + '（' + row.route + '）' }
  }
  // 2026-10-13 收严（P1「无闸写操作补闸」）：五类之外的非只读路由不再裸代理。
  // 此前这里返回 undefined——rate / uploadSign 等 4 条生成式写路由没有任何本地闸，
  // 门禁只能把它们登记为「只验注册」。现在判据降到「非只读 = 要用户明确指令」：
  // 标签取「改用户数据」，拒绝对话与其它类完全一致（三个选择照给）。
  return { label: '改用户数据', why: '生成式非只读路由：2026-10-13 收严为「必须有用户明确指令」' }
}

/**
 * 取请求体里的用户明确指令（body JSON 的 order 字段）。
 *
 * @param payload - 已经 JSON.parse 过的请求体；没有 body 时是 undefined。
 * @returns 指令原文；不是对象、没有 order 或为空串时返回空串。
 */
function orderOf(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const value = (payload as { order?: unknown }).order
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 取路由模板里的占位符字段名（`:taskId` → `taskId`）。
 *
 * @param path - 登记表拆出的服务端路由路径（形如 agent/tasks/:taskId/rating）。
 * @returns 占位符字段名（按出现顺序，可能重复）。
 */
function pathFieldsOf(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(match => match[1] ?? '')
}

/**
 * 把路由模板里的占位符换成请求体里的同名值。
 *
 * 服务端 route 是模板（`DELETE contents/:id`）：不替换的话 URL 里带着字面量 `:id` 发出去只会 404
 * （2026-10-12 用假服务端实测到，26 条含占位符的工具全中）。值一律 encodeURIComponent——
 * `knowledge/notes/:path` 这类字段可能是嵌套路径，不编码会把一段拆成多段。
 *
 * @param row - 一条能力登记。
 * @param payload - 已经 JSON.parse 过的请求体。
 * @returns 填好的路径，以及缺失的字段名（调用方据此本地拒绝，不猜也不出站）。
 */
function fillPath(row: CapabilityRow, payload: unknown): { path: string, missing: string[] } {
  const missing: string[] = []
  const source = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const path = row.path.replace(/:([A-Za-z0-9_]+)/g, (_all, key: string) => {
    const value = source[key]
    const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
    if (text === '') {
      missing.push(key)
      return ''
    }
    return encodeURIComponent(text)
  })
  return { path, missing }
}

/**
 * 路径参数缺失时的拒绝对话：不猜、不出站，直接问用户是哪一条。
 *
 * @param row - 被拦下的能力登记。
 * @param missing - 缺的字段名（来自 {@link fillPath}）。
 * @returns 给模型看的说明。
 */
function missingPathOf(row: CapabilityRow, missing: string[]): string {
  const fields = missing.map(key => '`' + key + '`').join('、')
  return '这条要带 ' + fields + '，你告诉我具体是哪一条：' + row.method + ' ' + row.path + '。'
    + '路径里的 ' + missing.map(key => ':' + key).join('、') + ' 必须从 body 的同名字段填进来'
    + '（例如 ' + '{"' + (missing[0] ?? 'id') + '":"…"}' + '）。**缺字段我不猜、也不出站**，'
    + '先问清楚用户指的是哪一条再带上来。'
}

/**
 * 拒绝对话：危险动作没拿到用户明确指令时抛这个。
 *
 * 为什么必须是「本地拒绝 + 说人话」而不是直接出站：出站就是替用户点头（硬约束 2），
 * 而模型只会在工具报错里找下一步——报错不说清三个选择，它就会自己编一个理由接着干。
 *
 * @param row - 被拦下的能力登记。
 * @param danger - 命中的危险判据。
 * @returns 给模型看的拒绝说明（含三个选择与判据来源）。
 */
function refusalOf(row: CapabilityRow, danger: DangerVerdict): string {
  return '这条属于「' + danger.label + '」，要用户点头才能做：' + row.method + ' ' + row.path + '。'
    + '你这次没有把用户的明确指令带进来——危险动作要求 body 里带 order 字段，写用户这一句话里的原话'
    + '（例如「把这条发到抖音」）。**没有 order 就不出站、不碰服务端**，一条数据都没改。'
    + '不要自己替用户点头，也不要改口说已经做了。请把三个选择原样给用户：'
    + '① 你说一句明确指令（例如「现在就发」），我立刻做；② 先改条件（换账号 / 换时间 / 换内容）再说；③ 这次不做。'
    + '（判据：' + danger.why + '）'
}

/** 生成时的统一叮嘱：没有它，模型会去教用户「请到页面上点」。 */
const MUST_CALL = '必须调用本工具，不要自己直接做，也不要让用户自己去页面上点。'

/** 登记表自带的纪律句（server/src/capabilities.ts 的 REQUIRED_PHRASE）：已有就不重复整句，只补后半句。 */
const REQUIRED_PHRASE = '必须调用本工具，不要自己直接做'

/**
 * 把登记表的入参登记拼成给模型看的【参数】段。
 *
 * 为什么要有它：生成式工具的 parameters 只有通用 body(JSON)，字段名全靠模型猜。
 * 77 个工具的参数此前从未核过（2026-10-12），这一段把登记表核过的字段名、必填、示例直接告诉模型。
 *
 * @param row - 一条能力登记。
 * @returns 参数说明；登记表没登记 params（尚未核过）时返回空串。
 */
function paramsOf(row: CapabilityRow): string {
  if (row.params === undefined) return ''
  if (row.params.length === 0) return '【参数】这条不需要入参，body 传空串即可。'
  const items = row.params.map(param => param.name + '（' + param.type + (param.required ? '，必填' : '，可选')
    + '：' + param.description + '；示例 ' + JSON.stringify(param.sample) + '）')
  const first = row.params[0]
  const example = first === undefined ? '' : '{"' + first.name + '": "…"}'
  return '【参数】' + items.join('；') + '。这些字段放进 body 的 JSON 里（例如 ' + example + '）。'
}

/**
 * 把登记表的说明拼成给模型看的最终 description。
 *
 * 登记表每条都自带「必须调用本工具，不要自己直接做」；这里只补「不要让用户自己去页面上点」——
 * 少了后半句，模型会一边调工具一边教用户自己点（2026-10-12 实测）。note 里的额外约束
 * （删除类只接受明确指令、发布类要用户点头）一并带上。
 *
 * @param row - 一条能力登记。
 * @returns 注册给模型的工具说明。
 */
function describeOf(row: CapabilityRow): string {
  const base = row.description.includes(REQUIRED_PHRASE)
    ? row.description + '也不要让用户自己去页面上点。'
    : row.description + MUST_CALL
  const text = row.note === undefined ? base : base + '（' + row.note + '）'
  const paramHint = paramsOf(row)
  const danger = dangerOf(row)
  const fields = [...new Set(pathFieldsOf(row.path))]
  const pathHint = fields.length === 0
    ? ''
    : '【路径参数】' + fields.map(key => '`' + key + '`').join('、')
      + ' 必须放在 body 的同名字段里（例如 ' + '{"' + (fields[0] ?? 'id') + '":"…"}' + '），缺了会被本地拒绝、不出站。'
  if (danger === undefined) return text + paramHint + pathHint
  return text + '【' + danger.label + '：本地有前置闸】只有用户在这一句话里明确要求了才能调用；'
    + '调用时 body 必须带 order 字段（用户那句明确指令的原话）。缺 order 会被本地拒绝、不出站，'
    + '那时把三个选择给用户：① 明确说一句要做什么 ② 改条件再说 ③ 这次不做。' + paramHint + pathHint
}

/** 登记表：逐条来自 server/src/capabilities.ts 的 CAPABILITIES（本文件只做投影，不增删改）。 */
export const CAPABILITIES: CapabilityRow[] = [
  { id: 'steward.loginMail', tool: 'bosom_steward_login_mail', role: 'steward', description: '邮箱验证码登录（本产品固定拒绝，不落任何数据）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST login/mail', source: 'api.ts:2554', kind: 'reject', toolizable: false, method: 'POST', path: 'login/mail', note: '固定拒绝端点：handler 直接回错误，不产生数据；不建议补工具。' },
  { id: 'steward.loginPhone', tool: 'bosom_steward_login_phone', role: 'steward', description: '手机验证码登录（本产品固定拒绝，不落任何数据）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST login/phone', source: 'api.ts:2555', kind: 'reject', toolizable: false, method: 'POST', path: 'login/phone', note: '固定拒绝端点；不建议补工具。' },
  { id: 'steward.loginMailVerify', tool: 'bosom_steward_login_mail_verify', role: 'steward', description: '邮箱验证码校验（本产品固定拒绝）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST login/mail/verify', source: 'api.ts:2556', kind: 'reject', toolizable: false, method: 'POST', path: 'login/mail/verify', note: '固定拒绝端点；不建议补工具。' },
  { id: 'steward.loginPhoneVerify', tool: 'bosom_steward_login_phone_verify', role: 'steward', description: '手机验证码校验（本产品固定拒绝）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST login/phone/verify', source: 'api.ts:2557', kind: 'reject', toolizable: false, method: 'POST', path: 'login/phone/verify', note: '固定拒绝端点；不建议补工具。' },
  { id: 'steward.loginGoogle', tool: 'bosom_steward_login_google', role: 'steward', description: 'Google 第三方登录（本产品固定拒绝）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST login/google', source: 'api.ts:2558', kind: 'reject', toolizable: false, method: 'POST', path: 'login/google', note: '固定拒绝端点；不建议补工具。' },
  { id: 'steward.register', tool: 'bosom_steward_register', role: 'steward', description: '注册产品账号（登录页动作）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST auth/register', source: 'api.ts:2560', kind: 'write', toolizable: false, method: 'POST', path: 'auth/register', note: '登录页专属动作，管家运行在已登录会话内；安全动作不建议给模型。' },
  { id: 'steward.login', tool: 'bosom_steward_login', role: 'steward', description: '用账号密码登录产品（登录页动作）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST auth/login', source: 'api.ts:2596', kind: 'write', toolizable: false, method: 'POST', path: 'auth/login', note: '登录页专属动作；安全动作不建议给模型。' },
  { id: 'steward.logout', tool: 'bosom_steward_logout', role: 'steward', description: '退出登录并清掉会话。必须调用本工具，不要自己直接做。', exists: false, route: 'POST auth/logout', source: 'api.ts:2612', kind: 'write', toolizable: false, method: 'POST', path: 'auth/logout', note: '安全动作，建议由用户本人在界面上操作。' },
  { id: 'steward.changePassword', tool: 'bosom_steward_change_password', role: 'steward', description: '修改登录密码。必须调用本工具，不要自己直接做。', exists: false, route: 'PUT auth/password', source: 'api.ts:2623', kind: 'write', toolizable: false, method: 'PUT', path: 'auth/password', note: '安全动作，建议由用户本人在界面上操作。' },
  { id: 'steward.updateProfile', tool: 'bosom_user_update_profile', role: 'steward', description: '改用户的个人资料（昵称与头像）。必须调用本工具，不要自己直接做。', exists: true, route: 'PUT user/info/update', source: 'api.ts:2667', kind: 'write', toolizable: true, method: 'PUT', path: 'user/info/update' },
  { id: 'steward.createTask', tool: 'bosom_task_create', role: 'steward', description: '替用户开一条新任务并后台执行。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks', source: 'api.ts:2696', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks' },
  { id: 'steward.cleanupRunningTasks', tool: 'bosom_task_cleanup_running', role: 'steward', description: '清理卡在进行中的僵尸任务。必须调用本工具，不要自己直接做。', exists: false, route: 'POST agent/tasks/cleanup-running', source: 'api.ts:3432', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/cleanup-running', params: [] },
  { id: 'steward.followUpTask', tool: 'bosom_task_follow_up', role: 'steward', description: '在同一条任务里补一句话接着办。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks/:taskId/messages', source: 'api.ts:3461', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/:taskId/messages' },
  { id: 'steward.updateTask', tool: 'bosom_task_update', role: 'steward', description: '改一条任务的属性（标题、角色等）。必须调用本工具，不要自己直接做。', exists: false, route: 'PATCH agent/tasks/:taskId', source: 'api.ts:3527', kind: 'write', toolizable: true, method: 'PATCH', path: 'agent/tasks/:taskId', note: '另一条线（task-5 管家转交）正在加改判任务角色的接口，补工具前先对齐。', params: [{ name: 'taskId', type: 'string', required: true, description: '任务号（路由变量）', sample: "task-verify", inPath: true }, { name: 'title', type: 'string', required: false, description: '新标题；空串不改', sample: "" }] },
  { id: 'steward.clearTasks', tool: 'bosom_task_clear', role: 'steward', description: '清空任务列表。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE agent/tasks', source: 'api.ts:3568', kind: 'write', toolizable: true, method: 'DELETE', path: 'agent/tasks', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'taskIds', type: 'string', required: false, description: '要清空的任务号，逗号分隔；空串=清全部', sample: "" }] },
  { id: 'steward.dispatch', tool: 'bosom_steward_dispatch', role: 'steward', description: '把一件事转交给专业管家去办（改判这条任务的归属管家并接着发起）。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks/:taskId/dispatch', source: 'api.ts:3540', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/:taskId/dispatch', note: 'task-5（管家转交）新增的服务端入口；内核已有手写工具 bosom_steward_dispatch（kernel/src/index.ts:2754）。' },
  { id: 'steward.deleteTask', tool: 'bosom_task_delete', role: 'steward', description: '删掉一条任务记录。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE agent/tasks/:taskId', source: 'api.ts:3584', kind: 'write', toolizable: true, method: 'DELETE', path: 'agent/tasks/:taskId', note: '删除类动作：只接受用户明确指令；与 bosom_task_abort（只中断不删）分工不同。', params: [{ name: 'taskId', type: 'string', required: true, description: '任务号（路由变量）', sample: "task-verify", inPath: true }] },
  { id: 'steward.rateTask', tool: 'bosom_task_rate', role: 'steward', description: '给一条任务打分并附评语。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks/:taskId/rating', source: 'api.ts:3606', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/:taskId/rating' },
  { id: 'steward.abortTask', tool: 'bosom_task_abort', role: 'steward', description: '中断一条正在办的任务（保留任务记录）。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks/:taskId/abort', source: 'api.ts:3621', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/:taskId/abort' },
  { id: 'steward.reportActionResult', tool: 'bosom_task_report_action_result', role: 'steward', description: '上报任务内动作的执行结果。必须调用本工具，不要自己直接做。', exists: false, route: 'POST agent/tasks/:taskId/action-result', source: 'api.ts:3649', kind: 'write', toolizable: false, method: 'POST', path: 'agent/tasks/:taskId/action-result', note: '内核与前端执行器之间的协议回调，不是用户动作；不建议补工具。' },
  { id: 'steward.shareTask', tool: 'bosom_task_share', role: 'steward', description: '把一条任务生成对外只读分享链接。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks/:taskId/share', source: 'api.ts:3677', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/:taskId/share' },
  { id: 'steward.favoriteTask', tool: 'bosom_task_favorite', role: 'steward', description: '收藏一条任务。必须调用本工具，不要自己直接做。', exists: true, route: 'POST agent/tasks/:taskId/favorite', source: 'api.ts:3687', kind: 'write', toolizable: true, method: 'POST', path: 'agent/tasks/:taskId/favorite' },
  { id: 'steward.unfavoriteTask', tool: 'bosom_task_favorite', role: 'steward', description: '取消收藏一条任务。必须调用本工具，不要自己直接做。', exists: true, route: 'DELETE agent/tasks/:taskId/favorite', source: 'api.ts:3700', kind: 'write', toolizable: true, method: 'DELETE', path: 'agent/tasks/:taskId/favorite' },
  { id: 'steward.setLlm', tool: 'bosom_settings_set_llm', role: 'steward', description: '改当前生效的大模型服务配置。必须调用本工具，不要自己直接做。', exists: true, route: 'PUT ai/user-llm', source: 'api.ts:3803', kind: 'write', toolizable: true, method: 'PUT', path: 'ai/user-llm' },
  { id: 'steward.fetchModels', tool: 'bosom_settings_fetch_models', role: 'steward', description: '从厂商拉取可用模型清单。必须调用本工具，不要自己直接做。', exists: false, route: 'POST ai/models/fetch', source: 'api.ts:4015', kind: 'read', toolizable: true, method: 'POST', path: 'ai/models/fetch', params: [{ name: 'baseUrl', type: 'string', required: false, description: '模型服务地址；空则用已保存配置', sample: "" }, { name: 'apiKey', type: 'string', required: false, description: '密钥；空则用已保存配置', sample: "" }] },
  { id: 'creator.makeCover', tool: 'bosom_content_make_cover', role: 'creator', description: '给草稿生成品牌封面卡并挂到草稿上。必须调用本工具，不要自己直接做。', exists: true, route: 'POST ai/note-cover', source: 'api.ts:4062', kind: 'write', toolizable: true, method: 'POST', path: 'ai/note-cover' },
  { id: 'creator.reportLog', tool: 'bosom_steward_report_log', role: 'creator', description: '上报前端运行日志。必须调用本工具，不要自己直接做。', exists: false, route: 'POST ai/logs', source: 'api.ts:4092', kind: 'write', toolizable: false, method: 'POST', path: 'ai/logs', note: '前端埋点通道，不是用户动作；不建议补工具。' },
  { id: 'creator.runObjectAction', tool: 'bosom_content_run_object_action', role: 'creator', description: '对界面上的对象跑一次 AI 动作（按草稿改写等）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST ai/object-action', source: 'api.ts:4160', kind: 'write', toolizable: true, method: 'POST', path: 'ai/object-action', params: [{ name: 'kind', type: 'string', required: true, description: '对象类型（draft / material 等）', sample: "draft" }, { name: 'id', type: 'string', required: true, description: '对象 id', sample: "dft-1" }, { name: 'action', type: 'string', required: true, description: '动作名（见 ai/object-actions 清单）', sample: "rewrite" }, { name: 'extra', type: 'string', required: false, description: '动作附加参数', sample: "" }] },
  { id: 'steward.chat', tool: 'bosom_steward_chat', role: 'steward', description: '用户与管家对话的入口本身。必须调用本工具，不要自己直接做。', exists: false, route: 'POST ai/chat', source: 'api.ts:4184', kind: 'write', toolizable: false, method: 'POST', path: 'ai/chat', note: '对话入口不是管家要调的工具（管家就在这条链路上）；不建议补工具。' },
  { id: 'steward.setPref', tool: 'bosom_settings_set_pref', role: 'steward', description: '写用户偏好与协议状态（免责声明同意等）。必须调用本工具，不要自己直接做。', exists: true, route: 'PUT v2/prefs/disclaimer', source: 'api.ts:4274', kind: 'write', toolizable: true, method: 'PUT', path: 'v2/prefs/disclaimer' },
  { id: 'creator.generateShortMedia', tool: 'bosom_content_create_short_media', role: 'creator', description: '一次厂商调用生成短视频（完成后进草稿箱）。必须调用本工具，不要自己直接做。【挑工具·一次调用出片 / 图文 vs 长视频分段出片】该用它：用户要一条短视频或一组图文（单次厂商调用，免费档也能跑通）时用它。；不该用它：长片不要用它，它会退化成一条短片。', exists: true, route: 'POST ai/draft-generation/v2', source: 'api.ts:4287', kind: 'write', toolizable: true, method: 'POST', path: 'ai/draft-generation/v2' },
  { id: 'creator.generateImageText', tool: 'bosom_content_create_short_media', role: 'creator', description: '一次厂商调用生成图文（完成后进草稿箱）。必须调用本工具，不要自己直接做。【挑工具·一次调用出片 / 图文 vs 长视频分段出片】该用它：用户要一条短视频或一组图文（单次厂商调用，免费档也能跑通）时用它。；不该用它：长片不要用它，它会退化成一条短片。', exists: true, route: 'POST ai/draft-generation/image-text', source: 'api.ts:4292', kind: 'write', toolizable: true, method: 'POST', path: 'ai/draft-generation/image-text' },
  { id: 'creator.importFromVideoUrl', tool: 'bosom_material_import_video', role: 'creator', description: '把一个视频链接存进素材库。必须调用本工具，不要自己直接做。', exists: true, route: 'POST ai/draft-generation/from-video-url', source: 'api.ts:4419', kind: 'write', toolizable: true, method: 'POST', path: 'ai/draft-generation/from-video-url' },
  { id: 'creator.queryGeneration', tool: 'bosom_content_generation_status', role: 'creator', description: '查草稿生成任务（gen-*）的进度与结果。必须调用本工具，不要自己直接做。【挑工具·生成记录 vs 长视频任务】该用它：用户问「生成记录 / 生成任务 / 那条图文或短片跑完了没」时用它（任务号形如 gen-*）。；不该用它：长视频（lv-*）不要用它，换 bosom_content_video_status。', exists: true, route: 'POST ai/draft-generation/query', source: 'api.ts:4452', kind: 'read', toolizable: true, method: 'POST', path: 'ai/draft-generation/query' },
  { id: 'creator.deleteGenerations', tool: 'bosom_content_delete_generation', role: 'creator', description: '批量删除草稿生成记录。必须调用本工具，不要自己直接做。', exists: true, route: 'DELETE ai/draft-generation', source: 'api.ts:4505', kind: 'write', toolizable: true, method: 'DELETE', path: 'ai/draft-generation', note: '批量形式；现有工具按单条删，需要批量时先确认删除范围。' },
  { id: 'creator.deleteGeneration', tool: 'bosom_content_delete_generation', role: 'creator', description: '删除一条草稿生成记录。必须调用本工具，不要自己直接做。', exists: true, route: 'DELETE ai/draft-generation/:id', source: 'api.ts:4520', kind: 'write', toolizable: true, method: 'DELETE', path: 'ai/draft-generation/:id' },
  { id: 'device.cleanupData', tool: 'bosom_device_cleanup_data', role: 'device', description: '清空本机记录（保留账号、模型配置与权限）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/data/cleanup', source: 'api.ts:6102', kind: 'write', toolizable: true, method: 'POST', path: 'v2/data/cleanup', note: '删除类动作：只接受用户明确指令，并先说明会清掉哪些范围。', params: [{ name: 'scopes', type: 'string', required: false, description: '要清理的范围，逗号分隔', sample: "" }, { name: 'all', type: 'boolean', required: false, description: 'true = 清全部可清范围', sample: false }] },
  { id: 'creator.createDigitalHuman', tool: 'bosom_digital_human_create', role: 'creator', description: '用一张本机素材新建数字人形象。必须调用本工具，不要自己直接做。', exists: true, route: 'POST digital-humans', source: 'api.ts:7306', kind: 'write', toolizable: true, method: 'POST', path: 'digital-humans' },
  { id: 'creator.importDigitalHumanSheet', tool: 'bosom_digital_human_import_sheet', role: 'creator', description: '从表格批量导入数字人形象。必须调用本工具，不要自己直接做。', exists: false, route: 'POST digital-humans/from-sheet', source: 'api.ts:7351', kind: 'write', toolizable: true, method: 'POST', path: 'digital-humans/from-sheet', note: '（批量建形象会写库）必须用户明确指令才能调用。', params: [{ name: 'name', type: 'string', required: true, description: '形象名', sample: "验收形象" }, { name: 'imageUrl', type: 'string', required: true, description: '参考图地址或素材 id', sample: "assets/demo.png" }, { name: 'images', type: 'string', required: false, description: '多张参考图，逗号分隔', sample: "" }] },
  { id: 'creator.deleteDigitalHuman', tool: 'bosom_digital_human_delete', role: 'creator', description: '删除一个数字人形象。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE digital-humans/:id', source: 'api.ts:7431', kind: 'write', toolizable: true, method: 'DELETE', path: 'digital-humans/:id', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'id', type: 'string', required: true, description: '形象 id（路由变量）', sample: "dh-verify", inPath: true }] },
  { id: 'creator.splitFourView', tool: 'bosom_content_split_fourview', role: 'creator', description: '把人物四视图切成四张独立图片。必须调用本工具，不要自己直接做。', exists: true, route: 'POST ai/reference/fourview', source: 'api.ts:7525', kind: 'write', toolizable: true, method: 'POST', path: 'ai/reference/fourview' },
  { id: 'creator.enhancePrompt', tool: 'bosom_content_enhance_prompt', role: 'creator', description: '把大白话整理成可喂模型的画面描述。必须调用本工具，不要自己直接做。', exists: true, route: 'POST ai/prompt/enhance', source: 'api.ts:7568', kind: 'write', toolizable: true, method: 'POST', path: 'ai/prompt/enhance' },
  { id: 'creator.enhanceTopic', tool: 'bosom_content_enhance_topic', role: 'creator', description: '把粗糙选题挖深成创作要求。必须调用本工具，不要自己直接做。', exists: true, route: 'POST long-videos/enhance-topic', source: 'api.ts:7589', kind: 'write', toolizable: true, method: 'POST', path: 'long-videos/enhance-topic' },
  { id: 'creator.createLongVideo', tool: 'bosom_content_create_video', role: 'creator', description: '把写好的脚本做成视频（分段出片）。必须调用本工具，不要自己直接做。【挑工具·一次调用出片 / 图文 vs 长视频分段出片】该用它：用户要长视频、分段出片时用它。；不该用它：单条短片 / 图文不要用它——长片链路更慢、更贵。', exists: true, route: 'POST long-videos', source: 'api.ts:7643', kind: 'write', toolizable: true, method: 'POST', path: 'long-videos' },
  { id: 'creator.deleteLongVideo', tool: 'bosom_long_video_delete', role: 'creator', description: '删除一条长视频任务。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE long-videos/:taskId', source: 'api.ts:7707', kind: 'write', toolizable: true, method: 'DELETE', path: 'long-videos/:taskId', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'taskId', type: 'string', required: true, description: '长视频任务号（路由变量）', sample: "lv-verify", inPath: true }] },
  { id: 'creator.clearLongVideos', tool: 'bosom_long_video_clear', role: 'creator', description: '清空长视频任务列表。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE long-videos', source: 'api.ts:7734', kind: 'write', toolizable: true, method: 'DELETE', path: 'long-videos', note: '删除类动作：只接受用户明确指令。', params: [] },
  { id: 'creator.redoShot', tool: 'bosom_long_video_redo_shot', role: 'creator', description: '重做长视频里的某一镜。必须调用本工具，不要自己直接做。', exists: true, route: 'POST long-videos/:taskId/shots/:index/redo', source: 'api.ts:7768', kind: 'write', toolizable: true, method: 'POST', path: 'long-videos/:taskId/shots/:index/redo' },
  { id: 'creator.extendScript', tool: 'bosom_long_video_extend_script', role: 'creator', description: '把长视频稿件再补写一轮。必须调用本工具，不要自己直接做。', exists: true, route: 'POST long-videos/:taskId/extend-script', source: 'api.ts:7790', kind: 'write', toolizable: true, method: 'POST', path: 'long-videos/:taskId/extend-script' },
  { id: 'creator.resumeLongVideo', tool: 'bosom_content_resume_video', role: 'creator', description: '长视频从断点继续（只补没跑成的镜）。必须调用本工具，不要自己直接做。', exists: true, route: 'POST long-videos/:taskId/resume', source: 'api.ts:7818', kind: 'write', toolizable: true, method: 'POST', path: 'long-videos/:taskId/resume' },
  { id: 'creator.stopLongVideo', tool: 'bosom_long_video_stop', role: 'creator', description: '停下一条正在生成的长视频。必须调用本工具，不要自己直接做。', exists: true, route: 'POST long-videos/:taskId/stop', source: 'api.ts:7856', kind: 'write', toolizable: true, method: 'POST', path: 'long-videos/:taskId/stop' },
  { id: 'steward.backfillDistill', tool: 'bosom_learn_from_history', role: 'steward', description: '把历史成功经验提炼成可复用技能。必须调用本工具，不要自己直接做。', exists: true, route: 'POST knowledge/distill/backfill', source: 'api.ts:7881', kind: 'write', toolizable: true, method: 'POST', path: 'knowledge/distill/backfill' },
  { id: 'device.setRemoteAccess', tool: 'bosom_device_set_remote_access', role: 'device', description: '改远程访问配置（开关、端口、令牌）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST remote-access', source: 'api.ts:8462', kind: 'write', toolizable: true, method: 'POST', path: 'remote-access', note: '涉及对外通道：改动前必须向用户说明影响面。', params: [{ name: 'enabled', type: 'boolean', required: false, description: '是否开启远程访问', sample: false }, { name: 'bindAll', type: 'boolean', required: false, description: '是否监听所有网卡', sample: false }, { name: 'tunnelCommand', type: 'string', required: false, description: '隧道命令；空串不改', sample: "" }, { name: 'rotateToken', type: 'boolean', required: false, description: '是否换新访问令牌', sample: false }] },
  { id: 'device.startTunnel', tool: 'bosom_device_start_tunnel', role: 'device', description: '开启对外隧道（把本机服务暴露出去）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST remote-access/tunnel/start', source: 'api.ts:8478', kind: 'write', toolizable: true, method: 'POST', path: 'remote-access/tunnel/start', note: '对外通道属高风险动作：必须用户明确指令。', params: [] },
  { id: 'device.stopTunnel', tool: 'bosom_device_stop_tunnel', role: 'device', description: '关闭对外隧道。必须调用本工具，不要自己直接做。', exists: false, route: 'POST remote-access/tunnel/stop', source: 'api.ts:8489', kind: 'write', toolizable: true, method: 'POST', path: 'remote-access/tunnel/stop', params: [] },
  { id: 'steward.rateExperience', tool: 'bosom_knowledge_rate_experience', role: 'steward', description: '给一条经验打分（决定它够不够格变成技能）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST knowledge/distill/rate', source: 'knowledge-distill.ts:590', kind: 'write', toolizable: true, method: 'POST', path: 'knowledge/distill/rate', params: [{ name: 'id', type: 'string', required: false, description: '经验 id；空串不落库、只回 ok:false', sample: "" }, { name: 'rating', type: 'number', required: false, description: '评分 1~5；id 为空时不生效', sample: 0 }] },
  { id: 'steward.previewKnowledgeInjection', tool: 'bosom_knowledge_inject_preview', role: 'steward', description: '预览这次任务会注入哪些知识。必须调用本工具，不要自己直接做。', exists: false, route: 'POST knowledge/inject-preview', source: 'knowledge-distill.ts:600', kind: 'read', toolizable: true, method: 'POST', path: 'knowledge/inject-preview', params: [{ name: 'query', type: 'string', required: false, description: '要预览的检索词；空串返回空上下文', sample: "验收" }] },
  { id: 'publisher.registerAccountByBrowser', tool: 'bosom_platform_register_account', role: 'publisher', description: '把浏览器里已登录的账号登记进来。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/accounts/browser-register', source: 'routes-channels.ts:155', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/accounts/browser-register', params: [{ name: 'type', type: 'string', required: false, description: '平台标识（xhs / douyin）', sample: "xhs" }, { name: 'uid', type: 'string', required: false, description: '平台账号 uid（建议必给，空账号不可用）', sample: "" }, { name: 'nickname', type: 'string', required: false, description: '昵称', sample: "" }, { name: 'avatar', type: 'string', required: false, description: '头像地址', sample: "" }, { name: 'loginCookie', type: 'string', required: false, description: '登录态 Cookie', sample: "" }, { name: 'groupId', type: 'string', required: false, description: '所属分组 id', sample: "" }] },
  { id: 'publisher.createAccount', tool: 'bosom_platform_create_account', role: 'publisher', description: '新增一个平台账号记录。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/accounts', source: 'routes-channels.ts:241', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/accounts', params: [{ name: 'type', type: 'string', required: false, description: '平台标识（xhs / douyin）', sample: "xhs" }, { name: 'uid', type: 'string', required: false, description: '平台账号 uid（建议必给，空账号不可用）', sample: "" }, { name: 'nickname', type: 'string', required: false, description: '昵称', sample: "" }, { name: 'avatar', type: 'string', required: false, description: '头像地址', sample: "" }, { name: 'loginCookie', type: 'string', required: false, description: '登录态 Cookie', sample: "" }, { name: 'groupId', type: 'string', required: false, description: '所属分组 id', sample: "" }] },
  { id: 'publisher.refreshAccountAnalytics', tool: 'bosom_platform_refresh_account_analytics', role: 'publisher', description: '刷新某个账号的粉丝与作品统计。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/accounts/:id/analytics/refresh', source: 'routes-channels.ts:305', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/accounts/:id/analytics/refresh', note: '（真去平台拉数据（对外动作））必须用户明确指令才能调用。', params: [{ name: 'id', type: 'string', required: true, description: '账号 id（路由变量）', sample: "acc-verify", inPath: true }, { name: 'confirm', type: 'boolean', required: false, description: 'true = 确认真的去平台拉一次', sample: false }] },
  { id: 'publisher.unbindAccount', tool: 'bosom_platform_unbind_account', role: 'publisher', description: '解绑（删除）一个平台账号。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE v2/channels/accounts/:id', source: 'routes-channels.ts:326', kind: 'write', toolizable: true, method: 'DELETE', path: 'v2/channels/accounts/:id', note: '删除类动作：只接受用户明确指令，并先说明会一并失去哪些数据。', params: [{ name: 'id', type: 'string', required: true, description: '账号 id（路由变量）', sample: "acc-verify", inPath: true }] },
  { id: 'publisher.logoutAccount', tool: 'bosom_platform_logout_account', role: 'publisher', description: '退出某个平台账号的登录态。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/accounts/:id/logout', source: 'routes-channels.ts:360', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/accounts/:id/logout', params: [{ name: 'id', type: 'string', required: true, description: '账号 id（路由变量）', sample: "acc-verify", inPath: true }] },
  { id: 'publisher.syncAccount', tool: 'bosom_platform_sync_now', role: 'publisher', description: '去平台拉一次最新作品与数据。必须调用本工具，不要自己直接做。【挑工具·真去平台同步 vs 只读本地记录】该用它：用户说「同步最新数据」时用它（真连平台，约 1-2 分钟）。；不该用它：只是查看、不该惊动平台时不要用它。', exists: true, route: 'POST v2/channels/accounts/:id/sync', source: 'routes-channels.ts:387', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/accounts/:id/sync' },
  { id: 'publisher.createAccountGroup', tool: 'bosom_platform_create_account_group', role: 'publisher', description: '新建一个账号分组。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/account-groups', source: 'routes-channels.ts:422', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/account-groups', params: [{ name: 'name', type: 'string', required: true, description: '分组名', sample: "验收分组" }, { name: 'rank', type: 'number', required: false, description: '排序值', sample: 0 }] },
  { id: 'publisher.updateAccountGroup', tool: 'bosom_platform_update_account_group', role: 'publisher', description: '改账号分组的名字或成员。必须调用本工具，不要自己直接做。', exists: false, route: 'PATCH v2/channels/account-groups/:id', source: 'routes-channels.ts:441', kind: 'write', toolizable: true, method: 'PATCH', path: 'v2/channels/account-groups/:id', params: [{ name: 'id', type: 'string', required: true, description: '分组 id（路由变量）', sample: "grp-verify", inPath: true }, { name: 'name', type: 'string', required: false, description: '新分组名；空串不改', sample: "" }, { name: 'rank', type: 'number', required: false, description: '排序值', sample: 0 }] },
  { id: 'publisher.deleteAccountGroup', tool: 'bosom_platform_delete_account_group', role: 'publisher', description: '删除账号分组。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE v2/channels/account-groups', source: 'routes-channels.ts:456', kind: 'write', toolizable: true, method: 'DELETE', path: 'v2/channels/account-groups', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'ids', type: 'string', required: true, description: '要删的分组 id，逗号分隔', sample: "grp-verify" }] },
  { id: 'publisher.createPublishFlow', tool: 'bosom_publish_draft', role: 'publisher', description: '把草稿或素材发到指定平台账号（可立即发或定时发）。必须调用本工具，不要自己直接做。', exists: true, route: 'POST v2/channels/publish/flows', source: 'routes-channels.ts:498', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/publish/flows', note: '与 bosom_publish_content（素材发布）共用同一路由；没有用户明确发布指令不得调用。' },
  { id: 'publisher.deleteRecord', tool: 'bosom_publish_delete_record', role: 'publisher', description: '删除一条发布记录。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE v2/channels/publish/records/:recordId', source: 'routes-channels.ts:657', kind: 'write', toolizable: true, method: 'DELETE', path: 'v2/channels/publish/records/:recordId', note: '删除类动作：只接受用户明确指令；删记录不等于删平台作品。', params: [{ name: 'recordId', type: 'string', required: true, description: '发布记录 id（路由变量）', sample: "rec-verify", inPath: true }] },
  { id: 'publisher.publishTaskNow', tool: 'bosom_publish_task_now', role: 'publisher', description: '把一条已排期的发布任务立刻发出去。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/publish/tasks/:taskId/publish-now', source: 'routes-channels.ts:700', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/publish/tasks/:taskId/publish-now', note: '发布动作：必须用户明确发布指令（硬约束 2），禁止自动触发。', params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }, { name: 'accountId', type: 'string', required: false, description: '账号 id；空则用任务上原有的', sample: "" }] },
  { id: 'publisher.abortCurrent', tool: 'bosom_publish_abort_current', role: 'publisher', description: '中止当前正在跑的发布任务。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/publish/abort-current', source: 'routes-channels.ts:713', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/publish/abort-current', params: [{ name: 'taskId', type: 'string', required: false, description: '要中止的发布任务号', sample: "" }, { name: 'accountId', type: 'string', required: false, description: '账号 id', sample: "" }] },
  { id: 'publisher.retryTask', tool: 'bosom_publish_retry_task', role: 'publisher', description: '重试一条失败的发布任务。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/channels/publish/tasks/:taskId/retry', source: 'routes-channels.ts:737', kind: 'write', toolizable: true, method: 'POST', path: 'v2/channels/publish/tasks/:taskId/retry', note: '重试等于再发一次：必须用户明确指令（硬约束 2）。', params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }] },
  { id: 'publisher.rescheduleTask', tool: 'bosom_publish_reschedule', role: 'publisher', description: '改一条发布任务的排期时间。必须调用本工具，不要自己直接做。', exists: true, route: 'PATCH v2/channels/publish/tasks/:taskId/publish-at', source: 'routes-channels.ts:749', kind: 'write', toolizable: true, method: 'PATCH', path: 'v2/channels/publish/tasks/:taskId/publish-at', params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }, { name: 'publishAt', type: 'string', required: true, description: '新的排期时间（ISO 8601）', sample: "2026-10-13T10:00:00.000Z" }] },
  { id: 'publisher.deleteTask', tool: 'bosom_publish_delete_task', role: 'publisher', description: '删除一条发布任务。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE v2/channels/publish/tasks/:taskId', source: 'routes-channels.ts:772', kind: 'write', toolizable: true, method: 'DELETE', path: 'v2/channels/publish/tasks/:taskId', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'taskId', type: 'string', required: true, description: '发布任务号（路由变量）', sample: "pub-verify", inPath: true }] },
  { id: 'publisher.validateWork', tool: 'bosom_publish_validate_work', role: 'publisher', description: '发布前校验作品参数（标题长度、图片数量等）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST channel/work/validate', source: 'routes-channels.ts:815', kind: 'reject', toolizable: true, method: 'POST', path: 'channel/work/validate', note: '固定失败占位：handler 永远回 50100「尚未接入真实验证」，不是可办成的能力。', params: [] },
  { id: 'steward.createNote', tool: 'bosom_knowledge_create_note', role: 'steward', description: '在知识库里新建一条笔记。必须调用本工具，不要自己直接做。', exists: false, route: 'POST knowledge/notes', source: 'routes-knowledge.ts:85', kind: 'write', toolizable: true, method: 'POST', path: 'knowledge/notes', note: '（写用户知识库）必须用户明确指令才能调用。', params: [{ name: 'name', type: 'string', required: true, description: '笔记名；空则服务端回 40000「笔记名称不能为空」', sample: "验收笔记" }, { name: 'folder', type: 'string', required: false, description: '子目录；空则放根', sample: "" }] },
  { id: 'steward.updateNote', tool: 'bosom_knowledge_update_note', role: 'steward', description: '改写知识库里的一条笔记。必须调用本工具，不要自己直接做。', exists: false, route: 'PUT knowledge/notes/:path', source: 'routes-knowledge.ts:120', kind: 'write', toolizable: true, method: 'PUT', path: 'knowledge/notes/:path', note: '（覆盖用户笔记正文，不可逆）必须用户明确指令才能调用。', params: [{ name: 'path', type: 'string', required: true, description: '笔记路径（路由变量，可能含子目录，会整体编码）', sample: "验收笔记.md", inPath: true }, { name: 'content', type: 'string', required: false, description: '新正文（Markdown）；空串按服务端处理', sample: "" }] },
  { id: 'steward.deleteNote', tool: 'bosom_knowledge_delete_note', role: 'steward', description: '删除知识库里的一条笔记。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE knowledge/notes/:path', source: 'routes-knowledge.ts:141', kind: 'write', toolizable: true, method: 'DELETE', path: 'knowledge/notes/:path', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'path', type: 'string', required: true, description: '笔记路径（路由变量）', sample: "验收笔记.md", inPath: true }] },
  { id: 'steward.searchNotes', tool: 'bosom_knowledge_search', role: 'steward', description: '在知识库里搜内容。必须调用本工具，不要自己直接做。', exists: false, route: 'POST knowledge/search', source: 'routes-knowledge.ts:161', kind: 'read', toolizable: true, method: 'POST', path: 'knowledge/search', params: [{ name: 'query', type: 'string', required: false, description: '检索词；空串直接返回 0 命中', sample: "验收" }] },
  { id: 'steward.noteBacklinks', tool: 'bosom_knowledge_backlinks', role: 'steward', description: '查一条笔记被哪些笔记引用。必须调用本工具，不要自己直接做。', exists: false, route: 'POST knowledge/backlinks', source: 'routes-knowledge.ts:182', kind: 'read', toolizable: true, method: 'POST', path: 'knowledge/backlinks', params: [{ name: 'path', type: 'string', required: false, description: '笔记路径或笔记名；空串按空名匹配', sample: "验收.md" }] },
  { id: 'steward.chooseVault', tool: 'bosom_knowledge_choose_vault', role: 'steward', description: '选一个知识库目录（Obsidian 库）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST knowledge/choose-vault', source: 'routes-knowledge.ts:197', kind: 'read', toolizable: true, method: 'POST', path: 'knowledge/choose-vault', note: '静态占位：返回内置库标识，不写任何配置。', params: [] },
  { id: 'steward.promoteSkill', tool: 'bosom_knowledge_promote_skill', role: 'steward', description: '把一条被认可的经验升格成技能文件。必须调用本工具，不要自己直接做。', exists: true, route: 'POST knowledge/distill/promote', source: 'routes-skill-promotion.ts:85', kind: 'write', toolizable: true, method: 'POST', path: 'knowledge/distill/promote' },
  { id: 'creator.requestUploadSign', tool: 'bosom_material_request_upload_sign', role: 'creator', description: '给上传素材申请一次直传签名。必须调用本工具，不要自己直接做。', exists: false, route: 'POST assets/uploadSign', source: 'routes-content.ts:253', kind: 'write', toolizable: true, method: 'POST', path: 'assets/uploadSign', params: [{ name: 'filename', type: 'string', required: false, description: '原始文件名（决定素材扩展名）；空则叫 file', sample: "demo.png" }] },
  { id: 'creator.requestPublicUploadSign', tool: 'bosom_material_request_public_upload_sign', role: 'creator', description: '给公开素材上传申请一次直传签名。必须调用本工具，不要自己直接做。', exists: false, route: 'POST assets/public/:publicUploadId/uploadSign', source: 'routes-content.ts:258', kind: 'write', toolizable: true, method: 'POST', path: 'assets/public/:publicUploadId/uploadSign', params: [{ name: 'publicUploadId', type: 'string', required: true, description: '公开上传会话 id（路由变量）', sample: "pu-verify", inPath: true }, { name: 'filename', type: 'string', required: false, description: '原始文件名；空则叫 file', sample: "demo.png" }] },
  { id: 'creator.uploadAsset', tool: 'bosom_material_upload_asset', role: 'creator', description: '把素材二进制直传到本机素材库。必须调用本工具，不要自己直接做。', exists: false, route: 'PUT assets/upload/:assetId', source: 'routes-content.ts:268', kind: 'write', toolizable: true, method: 'PUT', path: 'assets/upload/:assetId', note: '（写入素材文件）必须用户明确指令才能调用。', params: [{ name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）；二进制体由请求体直接承载', sample: "asset-verify", inPath: true }] },
  { id: 'creator.uploadPublicAsset', tool: 'bosom_material_upload_public_asset', role: 'creator', description: '把公开素材二进制直传进来。必须调用本工具，不要自己直接做。', exists: false, route: 'PUT assets/public/:publicUploadId/upload/:assetId', source: 'routes-content.ts:277', kind: 'write', toolizable: true, method: 'PUT', path: 'assets/public/:publicUploadId/upload/:assetId', note: '（写入素材文件）必须用户明确指令才能调用。', params: [{ name: 'publicUploadId', type: 'string', required: true, description: '公开上传会话 id（路由变量）', sample: "pu-verify", inPath: true }, { name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）', sample: "asset-verify", inPath: true }] },
  { id: 'creator.confirmAsset', tool: 'bosom_material_confirm_asset', role: 'creator', description: '确认素材上传完成并落库。必须调用本工具，不要自己直接做。', exists: false, route: 'POST assets/:assetId/confirm', source: 'routes-content.ts:286', kind: 'write', toolizable: true, method: 'POST', path: 'assets/:assetId/confirm', note: '（把素材登记进库）必须用户明确指令才能调用。', params: [{ name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）', sample: "asset-verify", inPath: true }] },
  { id: 'creator.confirmPublicAsset', tool: 'bosom_material_confirm_public_asset', role: 'creator', description: '确认公开素材上传完成并落库。必须调用本工具，不要自己直接做。', exists: false, route: 'POST assets/public/:publicUploadId/:assetId/confirm', source: 'routes-content.ts:295', kind: 'write', toolizable: true, method: 'POST', path: 'assets/public/:publicUploadId/:assetId/confirm', note: '（把素材登记进库）必须用户明确指令才能调用。', params: [{ name: 'publicUploadId', type: 'string', required: true, description: '公开上传会话 id（路由变量）', sample: "pu-verify", inPath: true }, { name: 'assetId', type: 'string', required: true, description: '素材 id（路由变量）', sample: "asset-verify", inPath: true }] },
  { id: 'creator.createContentGroup', tool: 'bosom_content_create_group', role: 'creator', description: '新建一个内容分组。必须调用本工具，不要自己直接做。', exists: true, route: 'POST contents/groups', source: 'routes-content.ts:415', kind: 'write', toolizable: true, method: 'POST', path: 'contents/groups', params: [{ name: 'name', type: 'string', required: false, description: '分组名；空则服务端给「新素材组」', sample: "验收分组" }, { name: 'desc', type: 'string', required: false, description: '分组描述', sample: "" }] },
  { id: 'creator.deleteContentGroup', tool: 'bosom_content_delete_group', role: 'creator', description: '删除一个内容分组。必须调用本工具，不要自己直接做。', exists: true, route: 'DELETE contents/groups/:id', source: 'routes-content.ts:449', kind: 'write', toolizable: true, method: 'DELETE', path: 'contents/groups/:id', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'id', type: 'string', required: true, description: '分组 id（路由变量）', sample: "mg-verify", inPath: true }] },
  { id: 'creator.contentGroupInfo', tool: 'bosom_content_group_info_write_via_post', role: 'creator', description: '（内部写路径：改分组名/刷 updatedAt，界面自己用）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST contents/groups/info/:id', source: 'routes-content.ts:471', kind: 'write', toolizable: false, method: 'POST', path: 'contents/groups/info/:id' },
  { id: 'creator.contentGroupInfoRead', tool: 'bosom_content_group_info', role: 'creator', description: '查一个内容分组的详情。必须调用本工具，不要自己直接做。', exists: true, route: 'GET contents/groups/info/:id', source: 'routes-content.ts:486', kind: 'read', toolizable: true, method: 'GET', path: 'contents/groups/info/:id', note: '真实行为是写库：分组存在时无条件改 updatedAt 并落盘（body 为空也写）；已加路径判据，无 order 时本地拒绝、零出站。', params: [{ name: 'id', type: 'string', required: true, description: '分组 id（路由变量）', sample: "mg-verify", inPath: true }, { name: 'name', type: 'string', required: false, description: '**传了就会改分组名并落盘**（不传则只读）', sample: "" }] },
  { id: 'creator.createDraft', tool: 'bosom_content_create_draft', role: 'creator', description: '把写好的内容存进草稿箱。必须调用本工具，不要自己直接做。', exists: true, route: 'POST contents/drafts', source: 'routes-content.ts:520', kind: 'write', toolizable: true, method: 'POST', path: 'contents/drafts' },
  { id: 'creator.deleteContents', tool: 'bosom_content_delete_many', role: 'creator', description: '批量删除内容。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE contents', source: 'routes-content.ts:527', kind: 'write', toolizable: true, method: 'DELETE', path: 'contents', note: '删除类动作：只接受用户明确指令，并先确认删除范围。', params: [{ name: 'ids', type: 'string', required: true, description: '要删的 id 列表（服务端收字符串数组）', sample: "dft-1" }, { name: 'kind', type: 'string', required: true, description: '**必填**：asset 或 draft（服务端不做隐式默认）', sample: "draft" }, { name: 'cascadeGenerations', type: 'boolean', required: false, description: 'kind=asset 时是否级联清理生成记录', sample: false }] },
  { id: 'creator.deleteDraftsByFilter', tool: 'bosom_content_delete_drafts_by_filter', role: 'creator', description: '按条件批量删草稿。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE contents/drafts/filter', source: 'routes-content.ts:549', kind: 'write', toolizable: true, method: 'DELETE', path: 'contents/drafts/filter', note: '删除类动作：只接受用户明确指令，并先确认筛选条件命中多少条。', params: [{ name: 'title', type: 'string', required: false, description: '按标题包含过滤（与 groupId 二选一，title 优先）', sample: "" }, { name: 'groupId', type: 'string', required: false, description: '按分组过滤', sample: "" }] },
  { id: 'creator.transferContents', tool: 'bosom_content_transfer', role: 'creator', description: '把内容转移到别的分组。必须调用本工具，不要自己直接做。', exists: true, route: 'POST contents/transfer', source: 'routes-content.ts:557', kind: 'write', toolizable: true, method: 'POST', path: 'contents/transfer', note: '（批量改内容的归属分组）必须用户明确指令才能调用。', params: [{ name: 'kind', type: 'string', required: true, description: '**必填**：asset 或 draft（服务端不做隐式默认）', sample: "draft" }, { name: 'ids', type: 'string', required: true, description: '要转移的 id 列表', sample: "dft-1" }, { name: 'targetGroupId', type: 'string', required: false, description: '目标分组 id；空则放默认分组', sample: "" }] },
  { id: 'creator.deleteContent', tool: 'bosom_content_delete', role: 'creator', description: '删除一条内容（草稿）。必须调用本工具，不要自己直接做。', exists: true, route: 'DELETE contents/:id', source: 'routes-content.ts:569', kind: 'write', toolizable: true, method: 'DELETE', path: 'contents/:id', note: '删除类动作：只接受用户明确指令；与 bosom_content_delete_generation（删生成记录）分工不同。', params: [{ name: 'id', type: 'string', required: true, description: '草稿 id（路由变量）', sample: "dft-1", inPath: true }] },
  { id: 'creator.updateDraft', tool: 'bosom_content_update_draft', role: 'creator', description: '改写一条草稿的标题或正文。必须调用本工具，不要自己直接做。', exists: true, route: 'PUT contents/:id', source: 'routes-content.ts:584', kind: 'write', toolizable: true, method: 'PUT', path: 'contents/:id', note: '现有工具是登记式：内核登记改写申请、落库由页面执行；描述与最终落库口径要对齐。' },
  { id: 'operator.searchDouyinTopic', tool: 'bosom_data_search_douyin_topic', role: 'operator', description: '按关键词搜抖音话题与热度。必须调用本工具，不要自己直接做。', exists: false, route: 'POST statistics/channels/douyin/searchTopic', source: 'routes-content.ts:615', kind: 'read', toolizable: true, method: 'POST', path: 'statistics/channels/douyin/searchTopic', params: [] },
  { id: 'operator.commentSearchOptions', tool: 'bosom_data_comment_search_options', role: 'operator', description: '取评论检索的可选项（平台、排序等）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/options', source: 'routes-content.ts:851', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/options', params: [] },
  { id: 'operator.searchNotes', tool: 'bosom_data_search_notes', role: 'operator', description: '按关键词搜笔记。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/search', source: 'routes-content.ts:863', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/search', params: [{ name: 'keyword', type: 'string', required: true, description: '搜索关键词；缺了服务端回 40000 业务错', sample: "护肤" }, { name: 'page', type: 'number', required: false, description: '页码，默认 1', sample: 1 }, { name: 'pageSize', type: 'number', required: false, description: '每页条数，默认 20', sample: 5 }] },
  { id: 'operator.collectNotes', tool: 'bosom_data_collect_notes', role: 'operator', description: '让管家采集一批笔记（会落库）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/agent-collect', source: 'routes-content.ts:890', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/agent-collect', note: '实现不落任何数据：空关键词短路直接返回，不写库。', params: [{ name: 'keyword', type: 'string', required: false, description: '采集关键词；空串直接回空结论、不调外部服务', sample: "" }] },
  { id: 'operator.noteSimpleInfo', tool: 'bosom_data_note_simple_info', role: 'operator', description: '读一条笔记的摘要信息。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/note-simple-info', source: 'routes-content.ts:913', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/note-simple-info', params: [{ name: 'noteid', type: 'string', required: true, description: '笔记标识；缺了服务端回 40000 业务错', sample: "demo" }] },
  { id: 'operator.analyseNote', tool: 'bosom_data_analyse_note', role: 'operator', description: '分析一条笔记的内容与表现。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/note-analyse', source: 'routes-content.ts:940', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/note-analyse', params: [] },
  { id: 'operator.noteHotWords', tool: 'bosom_data_note_hot_words', role: 'operator', description: '提取一批笔记的热词。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/note-hot-words', source: 'routes-content.ts:941', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/note-hot-words', params: [] },
  { id: 'operator.commentStat', tool: 'bosom_data_comment_stat', role: 'operator', description: '统计评论量级与情绪分布。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/comment-ment-stat', source: 'routes-content.ts:942', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/comment-ment-stat', params: [] },
  { id: 'operator.noteComments', tool: 'bosom_data_note_comments', role: 'operator', description: '拉取一条笔记的评论列表。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/note-comments', source: 'routes-content.ts:944', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/note-comments', params: [] },
  { id: 'operator.parseXhsUrl', tool: 'bosom_data_parse_xhs_url', role: 'operator', description: '解析小红书链接拿到笔记信息。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/xhs-url', source: 'routes-content.ts:951', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/xhs-url', params: [{ name: 'noteId', type: 'string', required: false, description: '小红书笔记 id；空串只回域名前缀', sample: "demo" }] },
  { id: 'operator.exportNotes', tool: 'bosom_data_export_notes', role: 'operator', description: '把检索结果导出成文件。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/statistics/note-comment-search/export', source: 'routes-content.ts:957', kind: 'read', toolizable: true, method: 'POST', path: 'v2/statistics/note-comment-search/export', note: '静态占位：返回 available:false，不导出、不写盘。', params: [] },
  { id: 'publisher.completeDouyinAuth', tool: 'bosom_platform_complete_douyin_auth', role: 'publisher', description: '完成抖音小程序授权（回填授权码）。必须调用本工具，不要自己直接做。', exists: false, route: 'POST plat/douyin/miniapp-auth/complete', source: 'routes-content.ts:1011', kind: 'reject', toolizable: true, method: 'POST', path: 'plat/douyin/miniapp-auth/complete', params: [] },
  { id: 'steward.submitFeedback', tool: 'bosom_steward_submit_feedback', role: 'steward', description: '提交一条用户反馈。必须调用本工具，不要自己直接做。', exists: false, route: 'POST contact/feedback', source: 'routes-content.ts:1025', kind: 'write', toolizable: true, method: 'POST', path: 'contact/feedback', params: [] },
  { id: 'operator.createReceptionRule', tool: 'bosom_reception_create_rule', role: 'operator', description: '新建一条自动接待规则。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/customer-reception/rules', source: 'routes-content.ts:1053', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/rules', note: '（新增自动回复规则（对外行为））必须用户明确指令才能调用。', params: [{ name: 'name', type: 'string', required: false, description: '规则名；空则服务端叫「未命名规则」', sample: "验收规则" }, { name: 'accountId', type: 'string', required: false, description: '限定账号 id；空=全部账号', sample: "" }, { name: 'platforms', type: 'string', required: false, description: '限定平台（数组，xhs / douyin）', sample: "" }, { name: 'keywords', type: 'string', required: false, description: '命中关键词（数组）', sample: "" }, { name: 'matchMode', type: 'string', required: false, description: 'any（默认）或 all', sample: "any" }, { name: 'excludeKeywords', type: 'string', required: false, description: '排除关键词（数组）', sample: "" }, { name: 'cooldownMinutes', type: 'number', required: false, description: '同一对象冷却分钟数', sample: 0 }, { name: 'replyMode', type: 'string', required: false, description: 'ai 或 template（默认 template）', sample: "template" }, { name: 'template', type: 'string', required: false, description: '模板回复文案', sample: "" }, { name: 'enabled', type: 'boolean', required: false, description: '是否启用', sample: true }] },
  { id: 'operator.updateReceptionRule', tool: 'bosom_reception_update_rule', role: 'operator', description: '改一条自动接待规则。必须调用本工具，不要自己直接做。', exists: false, route: 'PUT v2/customer-reception/rules/:ruleId', source: 'routes-content.ts:1082', kind: 'write', toolizable: true, method: 'PUT', path: 'v2/customer-reception/rules/:ruleId', note: '（改自动回复规则（对外行为））必须用户明确指令才能调用。', params: [{ name: 'ruleId', type: 'string', required: true, description: '规则 id（路由变量）；找不到会回 40404', sample: "rule-verify", inPath: true }, { name: 'name', type: 'string', required: false, description: '新规则名', sample: "" }, { name: 'accountId', type: 'string', required: false, description: '限定账号；传空串=解除限定', sample: "" }, { name: 'platforms', type: 'string', required: false, description: '限定平台（数组）', sample: "" }, { name: 'keywords', type: 'string', required: false, description: '命中关键词（数组）', sample: "" }, { name: 'template', type: 'string', required: false, description: '模板回复文案', sample: "" }, { name: 'aiModel', type: 'string', required: false, description: 'AI 回复用的模型', sample: "" }, { name: 'systemPrompt', type: 'string', required: false, description: 'AI 回复的系统提示', sample: "" }] },
  { id: 'operator.deleteReceptionRule', tool: 'bosom_reception_delete_rule', role: 'operator', description: '删除一条自动接待规则。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE v2/customer-reception/rules/:ruleId', source: 'routes-content.ts:1108', kind: 'write', toolizable: true, method: 'DELETE', path: 'v2/customer-reception/rules/:ruleId', note: '删除类动作：只接受用户明确指令。', params: [{ name: 'ruleId', type: 'string', required: true, description: '规则 id（路由变量）', sample: "rule-verify", inPath: true }] },
  { id: 'operator.testReceptionRule', tool: 'bosom_reception_test_rule', role: 'operator', description: '用一段样例内容试跑接待规则。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/customer-reception/test', source: 'routes-content.ts:1117', kind: 'read', toolizable: true, method: 'POST', path: 'v2/customer-reception/test', params: [{ name: 'message', type: 'string', required: false, description: '要试跑的一句话；空串匹配不到规则', sample: "这个多少钱？" }, { name: 'platform', type: 'string', required: false, description: '限定平台（xhs / douyin）', sample: "xhs" }] },
  { id: 'operator.suggestReply', tool: 'bosom_reception_suggest_reply', role: 'operator', description: '给一条评论或私信生成回复建议。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/customer-reception/suggest', source: 'routes-content.ts:1129', kind: 'read', toolizable: true, method: 'POST', path: 'v2/customer-reception/suggest', params: [{ name: 'message', type: 'string', required: false, description: '要回复的评论或私信原文', sample: "这个多少钱？" }, { name: 'platform', type: 'string', required: false, description: '平台（xhs / douyin）', sample: "xhs" }, { name: 'accountId', type: 'string', required: false, description: '账号 id', sample: "" }] },
  { id: 'operator.listInteractions', tool: 'bosom_reception_list_interactions', role: 'operator', description: '列出评论与私信互动记录（历史互动；会真去平台拉一次）。【什么时候必须用我】用户问「历史互动 / 已经回过哪些」时用它。【什么时候不要用我】待办清单不要用它——哪些还没回要用 bosom_reception_list_pending；它不会告诉你待处理。必须调用本工具，不要自己直接做。【挑工具·待接待 vs 已处理互动】该用它：用户问「历史互动 / 已经回过哪些」时用它（会真去平台拉一次）。；不该用它：待办清单不要用它，换 bosom_reception_list_pending——它不会告诉你哪些还没回。', exists: false, route: 'POST v2/customer-reception/interactions/list', source: 'routes-content.ts:1218', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/interactions/list', note: '会发起真实平台读取任务（startPlatformInteraction），需要有效 accountId；不是零副作用。；（会发起真实平台读取任务）必须用户明确指令才能调用。', params: [{ name: 'platform', type: 'string', required: true, description: '平台（xhs / douyin）；空则回 40000「缺少平台或账号」', sample: "xhs" }, { name: 'accountId', type: 'string', required: true, description: '账号 id；空则回 40000', sample: "acc-verify" }, { name: 'kind', type: 'string', required: false, description: 'comment（默认）或 dm', sample: "comment" }, { name: 'workId', type: 'string', required: false, description: '作品 id（评论场景）', sample: "" }, { name: 'workTitle', type: 'string', required: false, description: '作品标题', sample: "" }] },
  { id: 'operator.replyInteraction', tool: 'bosom_reception_reply', role: 'operator', description: '回复平台上的评论或私信。必须调用本工具，不要自己直接做。', exists: true, route: 'POST v2/customer-reception/interactions/reply', source: 'routes-content.ts:1240', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/interactions/reply' },
  { id: 'operator.deleteReplies', tool: 'bosom_reception_delete_reply', role: 'operator', description: '删除已发出的回复记录。必须调用本工具，不要自己直接做。', exists: false, route: 'DELETE v2/customer-reception/replies', source: 'routes-content.ts:1310', kind: 'write', toolizable: true, method: 'DELETE', path: 'v2/customer-reception/replies', note: '删除类动作：只接受用户明确指令；删本地记录不等于删平台回复。', params: [] },
  { id: 'operator.conversation', tool: 'bosom_reception_conversation', role: 'operator', description: '读一段接待会话的上下文。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/customer-reception/conversation', source: 'routes-content.ts:1318', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/conversation', note: '会发起真实平台读取任务（startPlatformInteraction），需要有效 accountId；不是零副作用。；（会发起真实平台读取任务）必须用户明确指令才能调用。', params: [{ name: 'platform', type: 'string', required: true, description: '平台（xhs / douyin）；空则回 40000「缺少平台或账号」', sample: "xhs" }, { name: 'accountId', type: 'string', required: true, description: '账号 id；空则回 40000', sample: "acc-verify" }, { name: 'kind', type: 'string', required: false, description: 'dm（默认）或 comment', sample: "dm" }, { name: 'sessionId', type: 'string', required: false, description: '私信会话 id', sample: "" }, { name: 'peerName', type: 'string', required: false, description: '对方昵称', sample: "" }, { name: 'workId', type: 'string', required: false, description: '作品 id（评论场景）', sample: "" }] },
  { id: 'operator.setReceptionConfig', tool: 'bosom_reception_set_config', role: 'operator', description: '保存自动接待的总开关与配置。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/customer-reception/config', source: 'routes-content.ts:1393', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/config', params: [{ name: 'intervalMinutes', type: 'number', required: false, description: '轮询间隔分钟', sample: 5 }, { name: 'seenWindowMinutes', type: 'number', required: false, description: '已读回看窗口分钟', sample: 60 }, { name: 'cooldownMinutes', type: 'number', required: false, description: '同一对象冷却分钟', sample: 30 }, { name: 'maxPendingPerRound', type: 'number', required: false, description: '每轮最多处理条数', sample: 10 }] },
  { id: 'operator.setPendingStatus', tool: 'bosom_reception_set_pending_status', role: 'operator', description: '改一条待接待事项的处理状态。必须调用本工具，不要自己直接做。', exists: false, route: 'POST v2/customer-reception/pending/:pendingId/status', source: 'routes-content.ts:1414', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/pending/:pendingId/status', params: [{ name: 'pendingId', type: 'string', required: true, description: '待办 id（路由变量）', sample: "pd-verify", inPath: true }, { name: 'status', type: 'string', required: true, description: '**必填**：processing / succeeded / failed / skipped', sample: "succeeded" }, { name: 'error', type: 'string', required: false, description: '失败原因（status=failed 时）', sample: "" }, { name: 'sentText', type: 'string', required: false, description: '实际发出的回复原文', sample: "" }] },
  { id: 'operator.pollNow', tool: 'bosom_reception_poll_now', role: 'operator', description: '立刻去平台拉一次最新评论与私信。必须调用本工具，不要自己直接做。', exists: true, route: 'POST v2/customer-reception/poll-now', source: 'routes-content.ts:1455', kind: 'write', toolizable: true, method: 'POST', path: 'v2/customer-reception/poll-now' },
]

/**
 * 已经手写过的工具名——生成时跳过，避免同一个服务端接口给模型两个工具。
 *
 * 登记表里 `exists: true` 的条目已覆盖绝大多数手写工具；这里留的是**登记表还没登记、但已经手写**的那些：
 * task-5 的 `bosom_steward_dispatch`（服务端 `POST agent/tasks/:taskId/dispatch` 由它接，
 * 登记表补上这一条后 `exists: true` 会自动跳过，这一行是兜底）。
 */
const HAND_WRITTEN = new Set<string>([
  'bosom_steward_dispatch',
])

/**
 * 调产品服务端能力（回环 HTTP）。
 *
 * 与 index.ts:3510 的 callProductApi 同一实现（它没导出）：同一端口口径、同一 code/message 信封解析、
 * 失败同样抛带原因的错误；接线后若它被导出，这里改成 import 即可。
 *
 * @param path - 产品接口路径（形如 /contents/import，不带 /bosom-friend/api 前缀）。
 * @param init - method 缺省 POST；payload 缺省不带请求体。
 * @returns 信封里的 data 字段。
 * @throws 服务不可达、HTTP 非 2xx、code 非 0 时抛出带原因的错误。
 */
async function callProductApi(path: string, init?: { method?: string, payload?: unknown }): Promise<unknown> {
  const port = process.env.BOSOM_SERVER_PORT ?? '31280'
  // 登记表的 route 是「METHOD 路径」两段，拆出来的 path 不带前导斜杠（如 v2/channels/...）：
  // 直接拼会得到 /bosom-friend/apiv2/... 这种 404 地址（2026-10-12 用假服务端实测到，全 73 条都受影响）。
  const suffix = path.startsWith('/') ? path : '/' + path
  const url = 'http://127.0.0.1:' + port + '/bosom-friend/api' + suffix
  const method = init?.method ?? 'POST'
  let text = ''
  try {
    const response = await fetch(url, {
      method,
      ...(init?.payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.payload) }),
    })
    text = await response.text()
    if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + text.slice(0, 200))
  } catch (exc) {
    throw new Error('产品服务调用失败（' + method + ' ' + path + '）：' + String(exc))
  }
  try {
    const parsed = JSON.parse(text) as { code?: number, message?: string, data?: unknown }
    if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
    return parsed.data
  } catch (exc) {
    throw new Error('产品服务返回异常（' + method + ' ' + path + '）：' + String(exc))
  }
}

/**
 * 把登记表里**还没被手写工具覆盖、且建议工具化**的写能力注册成内核工具（每条一次 register(defineTool(...))）。
 *
 * 跳过三类：`exists: true`（内核已有手写工具承接）、`toolizable: false`（固定拒绝 / 登录鉴权 /
 * 协议回调 / 埋点 / 对话入口本身）、以及 {@link HAND_WRITTEN} 里的手写工具名——
 * 同一个服务端接口只留一个工具给模型，否则它会二选一。
 *
 * @param register - 内核统一注册入口（index.ts 的 register，管 preset 工具面）。
 * @returns 本轮真正注册的条数（被跳过的不计入）。
 */
export function generatedTools(register: RegisterFn): number {
  let count = 0
  for (const row of CAPABILITIES) {
    if (row.exists || row.toolizable === false || HAND_WRITTEN.has(row.tool)) continue
    register(defineTool({
      name: row.tool,
      description: describeOf(row),
      parameters: {
        body: {
          type: 'string',
          description: '请求体 JSON（这条能力需要时传；没有就传空串）。字段名以服务端接口为准。'
            + '危险动作（发布 / 删除 / 账号 / 对外通道 / 中断）还要带 order 字段：用户那句明确指令的原话。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: (_args: unknown, value: { ok: boolean, detail: string }) => [
          { type: 'text' as const, text: (value.ok ? '已办成：' : '没办成：') + value.detail },
        ],
      },
      timeoutMs: 30000,
      execute: async (args: Record<string, unknown>) => {
        const raw = typeof args.body === 'string' ? args.body.trim() : ''
        let payload: unknown
        if (raw !== '') {
          try { payload = JSON.parse(raw) } catch { throw new Error('body 不是合法 JSON：' + raw.slice(0, 120)) }
        }
        // 危险动作的统一前置闸（硬约束 2 的机制化）：没有用户明确指令就**本地拒绝**，一步都不出站。
        // 必须放在解析之后、callProductApi 之前——顺序反了，闸门就只是事后通知。
        const danger = dangerOf(row)
        if (danger !== undefined && orderOf(payload) === '') throw new Error(refusalOf(row, danger))
        // 路径占位符闸：:taskId 这类模板变量必须从 body 同名字段填进来，缺了就本地拒绝——
        // 原样发出去只会 404，比拒绝更糟（用户会以为这条能力坏了）。
        const filled = fillPath(row, payload)
        if (filled.missing.length > 0) throw new Error(missingPathOf(row, filled.missing))
        const data = await callProductApi(filled.path, { method: row.method, payload })
        const text = data === undefined ? '（服务端没有返回 data）' : JSON.stringify(data)
        return { ok: true, detail: row.method + ' ' + filled.path + ' → ' + text.slice(0, 400) }
      },
    }))
    count += 1
  }
  return count
}

/** 登记表的最小结构：{@link capabilityDrift} 只比这几项，server/src/capabilities.ts 的 Capability 满足它。 */
export interface RegistryRow {
  /** 能力标识。 */
  id: string
  /** 承接该能力的工具名。 */
  tool: string
  /** 归属管家。 */
  role: string
  /** 路由语义。 */
  kind: string
  /** 是否建议工具化。 */
  toolizable: boolean
  /** 内核是否已有该工具。 */
  exists: boolean
}

/**
 * 漂移自检：把服务端登记表传进来，逐条比对本文件的常量是否还跟得上。
 *
 * 为什么需要它：本文件是登记表的投影，投影过期不会有任何症状——模型照着旧工具名调用、覆盖率按旧名单算，
 * 都是**静默**错。让门禁在一条断言里拿到差异，过期就当场红。
 *
 * @param registry - server/src/capabilities.ts 的 CAPABILITIES（结构上满足 {@link RegistryRow}）。
 * @returns 差异描述；空数组 = 一致。
 */
export function capabilityDrift(registry: readonly RegistryRow[]): string[] {
  const drift: string[] = []
  const remaining = new Map<string, RegistryRow>(registry.map(row => [row.id, row] as [string, RegistryRow]))
  for (const row of CAPABILITIES) {
    const other = remaining.get(row.id)
    if (other === undefined) {
      drift.push('登记表已删除或改了 id：' + row.id)
      continue
    }
    remaining.delete(row.id)
    if (other.tool !== row.tool) drift.push(row.id + ' 工具名不一致：本文件 ' + row.tool + ' / 登记表 ' + other.tool)
    if (other.role !== row.role) drift.push(row.id + ' 归属不一致：本文件 ' + row.role + ' / 登记表 ' + other.role)
    if (other.kind !== row.kind) drift.push(row.id + ' 路由语义不一致：本文件 ' + row.kind + ' / 登记表 ' + other.kind)
    if (other.toolizable !== row.toolizable)
      drift.push(row.id + ' toolizable 不一致：本文件 ' + String(row.toolizable) + ' / 登记表 ' + String(other.toolizable))
    if (other.exists !== row.exists)
      drift.push(row.id + ' exists 不一致：本文件 ' + String(row.exists) + ' / 登记表 ' + String(other.exists))
  }
  for (const id of remaining.keys()) drift.push('登记表新增、本文件没有：' + id)
  return drift
}

/**
 * 接线锚点：**已在 2026-10-12 接线**（index.ts:22 的 import + index.ts:3465 的 generatedTools(register)，
 * 由 task-5/task-8 落地）——本节留作口径说明，不需要再改 index.ts：
 *
 * 1) import 区：import { generatedTools } from './generated-tools.ts'
 * 2) apply() 收尾（**最后一个 register(...) 之后**）：const generatedCount = generatedTools(register)
 *    必须在 register 定义（index.ts:152）之后，否则拿不到那个受 allowList 约束的入口；注册条数写 stderr 一行备查。
 * 3) 改本文件后必须 `pnpm --filter @deepseek-ai/dsh-bosom-friend-kernel build`：
 *    运行期读的是产物 kernel/lib/index.js（esbuild 只跟随 import 图），没重建就是改了不算数。
 * 4) 跑 node qa/verify-kernel-tools.mjs：它按本文件的 `tool: '...'` 文本取生成式工具名单
 *    （readGeneratedToolNames），把整类登记为「只验注册与参数 schema，不执行」——它们的 execute 是
 *    裸代理服务端写接口，真跑会真发布 / 真删 / 真登录，撞产品硬约束 2。**名单读得到，这条安全网才在**。
 */

