/**
 * Bosom Friend 内核工具包：在官方 DSH 运行时上注册产品业务工具，不提供任何 UI。
 * 组合方式：dsh-base（基础）→ 本包 cordis.patch.yml（挂 dsh-sdk-jsonrpc-server + 本插件），
 * 由 launcher/src/bin-kernel.ts 启动；前端经官方 SDK 客户端 DeepSeekHarness 驱动。
 * 保持命名导出（无 default export），使 Loader 的 unwrapExports 保留 name/inject/apply。
 *
 * 当前已迁入 5 个工具：存活探针 + 4 个只读业务工具（账号列表/待接待/素材列表/数据看板）。
 * 其余写操作与发布类工具按 REQ/AC 逐条迁移，S 级前端验收通过一条再切一条。
 *
 * @module @deepseek-ai/dsh-bosom-friend-kernel
 */

import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { asRecords, num, openProductStore, readUserLlm, resolveDataRoot, str } from './data.ts'
import { generatedTools } from './generated-tools.ts'
import { JobQueue } from './jobs.ts'

export const name = 'bosom-friend-kernel'
/** 工具注册依赖官方工具运行时；业务工具经 ctx.tools.register 挂载。 */
export const inject = ['tools', 'llm']

/**
 * 内核插件配置。
 *
 * tools 是**工具面即权限边界**（ADR-005-AGENT §3.3 / BFS-102）的落点：管家 preset 用它声明
 * 「我能看到并调用哪些工具」，面之外的工具有意对该管家不存在。省略或空数组 = 全部注册
 * （未配置的调用方与总管的全量视图保持兼容）。
 */
export interface Config {
  /**
   * 允许注册的工具：完整工具名，或以星号结尾的前缀（如 bosom_content_ 星号）。
   * 省略 = 全部注册。
   */
  tools?: string[]
}

/**
 * 内容形式：模型在界面上看到的是中文名（producers 清单的 name），服务端要的是 kind。
 * 不映射就会以「未知的内容形式」被拒 —— 2026-09-30 监考实测：模型连试四种说法都被拒，出片一步都走不到。
 * 已经是英文 kind 的原样透传；新增形式时这里与 producers 清单一起加。
 */
/** 出镜类内容形式：服务端在形象库不止一个形象时要求显式指定形象 id。 */
const ON_CAMERA_KINDS = new Set(['digital-human', 'vlog', 'short-talk', 'unboxing', 'tutorial'])

const PRODUCER_KINDS: Record<string, string> = {
  '数字人口播': 'digital-human',
  '走动VLOG': 'vlog',
  '走动 VLOG': 'vlog',
  '口播短视频': 'short-talk',
  '开箱测评': 'unboxing',
  '步骤教程': 'tutorial',
  '场景呈现': 'scene',
  '场景种草': 'scene-seeding',
}

/** 标题的字数门槛：与平台侧一致，写进去就要能发出去。 */
const MAX_DRAFT_TITLE_CHARS = 30
/** 正文字数上限：与发布侧同量级，避免一次写回把正文撑到不可用。 */
const MAX_DRAFT_DESC_CHARS = 2000

/**
 * 动作三态：一个动作在链路上只有这三种合法状态。
 *
 * - `requested`：内核已登记申请（**还没有产生副作用**），等前端页面执行；
 * - `executed`：执行方（前端页面）已经做完，拿到真实产物或 id；
 * - `verified`：平台/接口回执可核验（例如发布记录里出现真实作品 ID）。
 *
 * 有了它，"已申请"与"已完成"不再靠提示词里的一句叮嘱区分，模型与门禁读的是同一个字段。
 */
type ActionState = 'requested' | 'executed' | 'verified'

/**
 * 申请句柄：内核登记申请时就发一个编号，前端执行完据此回填真实 id。
 *
 * 为什么不能返回 `'（待前端执行）'` 这种占位串：占位串无法被下游引用、也无法被门禁断言，
 * 模型只能靠复述提示词来避免说错话（DEF-201/239 的同源问题）。
 *
 * @param prefix - 业务前缀（pub / draft / upd）。
 * @returns 形如 `pub-m1x2y3-a1b2c3d4` 的句柄。
 */
function requestHandle(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
}

/**
 * 内容寻址编号：同一份产出永远算出同一个 id，不需要落库也能被下游引用。
 *
 * 用于"写完脚本 → 出片"这类交接：脚本不落产品数据（只读工具），但下游必须能引用它。
 *
 * @param prefix - 业务前缀（script）。
 * @param text - 产出正文。
 * @returns 形如 `script-9f2c1d4e7a30` 的稳定编号。
 */
function contentAddressedId(prefix: string, text: string): string {
  return prefix + '-' + createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12)
}

/** 把 limit 参数归一化为 1..50 的整数。 */
function limitOf(value: unknown): number {
  const parsed = Number.parseInt(str(value), 10)
  if (!Number.isFinite(parsed)) return 20
  return Math.min(Math.max(parsed, 1), 50)
}

/**
 * 注册内核工具。只读工具直接投影产品数据；写操作工具（发布、回复等）后续按
 * “前端页面发起 → 内核执行 → 前端可见结果”的 S 级链路迁入。
 * @param ctx - Cordis 上下文（工具运行时服务由 inject 注入）。
 */
/**
 * 把内核归一化的失败事实翻成"用户能直接照做"的一句话。
 *
 * 依据 Agnes 官方《常见错误码》（AgnesAI-Labs/AgnesAI-Models 的 `docs/ERROR_CODES.md`）：
 * 402 余额/额度不足、429 限流、401/403 鉴权与权限、404 路径或模型名错、
 * 400 参数非法（含图片尺寸/画幅/时长）、超时。原则是**保留厂商原文**（排查要用），
 * 前面加一句人话说明"这是什么、你能怎么办"——早先只有一句"模型请求失败"，连余额不足和限流都分不出。
 *
 * @param failure - 内核 finish 分片上携带的失败事实。
 * @returns 可直接展示给用户的失败说明。
 */
function describeLlmFailure(failure: { message?: string, code?: string } | undefined): string {
  const raw = String(failure?.message ?? '').trim()
  const haystack = raw + ' ' + String(failure?.code ?? '')
  const hint = ((): string => {
    if (/402|balance|quota|insufficient|额度|余额/i.test(haystack))
      return '账户余额或额度不足：请到服务商平台充值，或降低分辨率 / 时长等规格后重试。'
    if (/429|rate.?limit|too many|限流/i.test(haystack))
      return '请求太频繁被厂商限流：等 1 分钟再试。视频免费档每分钟只能出 1 个镜头，长片请耐心等待。'
    if (/401|403|unauthor|forbidden|permission|鉴权/i.test(haystack))
      return '鉴权失败或没有该模型的权限：请检查「设置 → 配置大模型」里的 API Key 是否有效、这个模型是否已开通。'
    if (/404|not found|不存在/i.test(haystack))
      return '接口地址或模型名不对：请检查设置里的接口地址（注意不要重复拼 /v1）与模型名称。'
    if (/400|invalid|parameter|参数/i.test(haystack))
      return '请求参数被厂商拒绝：常见于图片尺寸 / 画幅 / 时长超出该模型支持的范围。'
    if (/timeout|timed out|ETIMEDOUT|超时/i.test(haystack))
      return '请求超时：网络较慢或厂商排队中，稍后重试即可。'
    return '请稍后重试；若持续失败，把括号里的厂商原文发给技术支持。'
  })()
  return '大模型调用失败：' + hint + (raw === '' ? '' : '（厂商原文：' + raw.slice(0, 180) + '）')
}

export function apply(ctx: Context, config: Config = {}): void {
  // 工具面即权限边界：preset 通过 config.tools 声明本管家可见的工具（完整名或前缀）。
  // 面之外的工具**不注册**——对那个管家来说它们根本不存在，比「注册了再叮嘱别用」可靠。
  const allowList = resolveAllowList(config)
  // 真正注册成功的条数：收尾要用它做「声明了面却一条都没注册」的自检（见 apply 末尾）。
  let registeredCount = 0
  const register = (tool: unknown): void => {
    const toolName = (tool as { name?: unknown }).name
    if (allowList !== undefined) {
      if (typeof toolName !== 'string') return
      const hit = allowList.some((pattern) => pattern.endsWith('*')
        ? toolName.startsWith(pattern.slice(0, -1))
        : toolName === pattern)
      if (!hit) return
    }
    ctx.tools.register(tool as Parameters<typeof ctx.tools.register>[0])
    registeredCount += 1
  }
  const dataRoot = resolveDataRoot()
  const store = openProductStore(dataRoot)

  register(defineTool({
    name: 'bosom_kernel_ping',
    description: '检查 Bosom Friend 官方 DSH 内核运行时是否存活，返回运行信息。',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: '要回显的一段文字',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          now: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `内核存活：${value.ok ? '是' : '否'}；回显：${value.message}；时间：${value.now}` },
      ],
    },
    timeoutMs: 5000,
    execute: async (args) => ({
      ok: true,
      message: args.message,
      now: new Date().toISOString(),
    }),
  }))

  register(defineTool({
    name: 'bosom_platform_list_accounts',
    description: '列出已绑定的平台账号（含平台、昵称、粉丝数、状态与登录态；登录态 invalid 表示需要重新扫码），数据来自产品数据根。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                nickname: { type: 'string', required: true },
                uid: { type: 'string', required: true },
                fansCount: { type: 'number', required: true },
                status: { type: 'number', required: true },
                /** 平台侧登录态：valid=可用，invalid=需重新扫码；缺失表示尚未判定。 */
                loginState: { type: 'string', required: true },
                /** 登录失效时平台返回的原因原文（无则为空串）。 */
                loginNote: { type: 'string', required: true },
              },
            },
          },
        },
      },
      // render 才是**模型真正看到的文字**：schema 里有 id 不等于模型拿得到它。
      // 少了这一行，模型只能拿"昵称/平台名"去当 accountId 试，必然报"找不到账号"
      // （2026-09-29 现场：模型连试两次后按纪律停下来汇报，AI 驱动卡死在这一个字段上）。
      render: (_args, value) => [
        {
          type: 'text',
          text: `共 ${value.count} 个平台账号（发布时把 id 原样传给 bosom_publish_content 的 accountId）：\n` + value.items
            .map((a) => `- id=${a.id} | ${a.platform} ${a.nickname}（粉丝 ${a.fansCount}，状态 ${a.status}${a.loginState === 'invalid' ? '，登录已失效：' + (a.loginNote || '需重新扫码') : ''}）`)
            .join('\n'),
        },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = asRecords(store.files.accounts.load())
      return {
        count: rows.length,
        items: rows.slice(0, limit).map((a) => ({
          id: str(a.id),
          platform: str(a.type),
          nickname: str(a.nickname),
          uid: str(a.uid),
          fansCount: num(a.fansCount),
          status: num(a.status),
          loginState: str(a.loginState),
          loginNote: str(a.loginNote),
        })),
      }
    },
  }))

  register(defineTool({
    name: 'bosom_reception_list_pending',
    description: '列出 7×24 自动接待当前待处理的评论/私信（含来源平台、内容、匹配规则与拟回复）。' + '【什么时候必须用我】用户问「有哪些待回复的评论 / 私信」时用它。【什么时候不要用我】翻历史记录不要用它——它只列待处理；历史互动用 bosom_reception_list_interactions。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                accountId: { type: 'string', required: true },
                text: { type: 'string', required: true },
                matched: { type: 'boolean', required: true },
                ruleName: { type: 'string', required: true },
                reply: { type: 'string', required: true },
                /** 以下定位字段是回复时**必须原样回传**的：平台按这些字段在页面上找目标，编一个就找不到。 */
                workId: { type: 'string', required: true },
                commentText: { type: 'string', required: true },
                username: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                peerName: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `共 ${value.count} 条待接待：\n` + value.items.map((p) => `- [${p.platform}/${p.kind}] ${p.text}（来自 ${p.username || p.peerName || '未知'}） → 规则 ${p.ruleName || '无'}，拟回复：${p.reply || '无'}\n  定位（回复时原样回传）：workId=${p.workId || '无'} username=${p.username || '无'} sessionId=${p.sessionId || '无'} peerName=${p.peerName || '无'}`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = asRecords(store.files.receptionPending.load())
      return {
        count: rows.length,
        items: rows.slice(0, limit).map((p) => ({
          id: str(p.id),
          kind: str(p.kind),
          platform: str(p.platform),
          accountId: str(p.accountId),
          text: str(p.commentText) || str(p.peerName) || str(p.username),
          matched: p.matched === true,
          ruleName: str(p.ruleName),
          reply: str(p.reply),
          // 回复接口要的定位字段：列表不带出来，模型就只能凭空编一个（2026-10-11 实测的断链）。
          workId: str(p.workId),
          commentText: str(p.commentText),
          username: str(p.username),
          sessionId: str(p.sessionId),
          peerName: str(p.peerName),
        })),
      }
    },
  }))

  register(defineTool({
    name: 'bosom_material_list',
    description: '列出素材库中的图片/视频素材（含类型、标题、使用次数与创建时间）。' + '【什么时候必须用我】用户问「素材库有哪些图 / 视频」时用它。【什么时候不要用我】草稿不要用它，换 bosom_content_list_drafts。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                type: { type: 'string', required: true },
                title: { type: 'string', required: true },
                useCount: { type: 'number', required: true },
                createdAt: { type: 'string', required: true },
                /** 素材内容描述：这条片子拍的是什么（用户或创作流程写的）。 */
                desc: { type: 'string', required: true },
                /** 卖点摘要：来自创作任务的「产品与卖点」，写发布文案的依据。 */
                contentBrief: { type: 'string', required: true },
                /** 建议的位置标签；空串表示不指定。 */
                location: { type: 'string', required: true },
              },
            },
          },
        },
      },
      // render 是模型唯一看得到的文字：schema 里有 id 不等于模型拿得到它。
      // 少了 id，模型只能拿素材标题去当 materialId 试，发布工具直接报"找不到素材"
      // （2026-09-29 现场：AI 驱动就是卡在这一类字段上）。
      render: (_args, value) => [
        {
          type: 'text',
          text: `共 ${value.count} 个素材（发布时把 id 原样传给 bosom_publish_content 的 materialId）：\n`
            + value.items.map((m) => {
              const head = `- id=${m.id} [${m.type}] ${m.title}（使用 ${m.useCount} 次，${m.createdAt}）`
              const detail: string[] = []
              if (m.desc !== '') detail.push('    内容：' + m.desc)
              if (m.contentBrief !== '') detail.push('    卖点：' + m.contentBrief)
              if (m.location !== '') detail.push('    位置：' + m.location)
              return detail.length > 0 ? head + '\n' + detail.join('\n') : head
            }).join('\n'),
        },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      // 素材住在 contents 里，靠 kind 区分；store.files 没有 materials 这个文件，
      // 直接 load 会抛「Cannot read properties of undefined (reading 'load')」。
      const rows = asRecords(store.files.contents.load()).filter(item => item.kind === 'asset')
      return {
        count: rows.length,
        items: rows.slice(0, limit).map((m) => {
          // 内容/卖点/位置随列表一起给模型：写发布文案的依据在这里，
          // 不在素材文件名里（少了它们，模型只能从"第17版·夜间终版"猜内容）。
          const meta = (m.metadata ?? {}) as Record<string, unknown>
          return {
            id: str(m._id),
            type: str(m.type),
            title: str(m.title),
            useCount: num(m.useCount),
            createdAt: str(m.createdAt),
            desc: str(m.desc),
            contentBrief: str(meta.contentBrief),
            location: str(meta.location),
          }
        }),
      }
    },
  }))

  register(defineTool({
    name: 'bosom_data_dashboard',
    description: '汇总数据中心概况：账号数、素材数、待接待数、发布记录数与数据指标行数，并给出最近 3 条发布记录。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: { type: 'number', required: true },
          materials: { type: 'number', required: true },
          pendingReception: { type: 'number', required: true },
          publishRecords: { type: 'number', required: true },
          metricRows: { type: 'number', required: true },
          recentPublishes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                platform: { type: 'string', required: true },
                status: { type: 'number', required: true },
                publishTime: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `数据中心：账号 ${value.accounts}、素材 ${value.materials}、待接待 ${value.pendingReception}、发布记录 ${value.publishRecords}、指标行 ${value.metricRows}。\n最近发布：\n` + value.recentPublishes.map((r) => `- ${r.platform}《${r.title}》状态 ${r.status}（${r.publishTime}）`).join('\n'),
        },
      ],
    },
    timeoutMs: 10000,
    execute: async () => {
      const records = asRecords(store.files.records.load())
      return {
        accounts: asRecords(store.files.accounts.load()).length,
        materials: asRecords(store.files.contents.load()).filter(item => item.kind === 'asset').length,
        pendingReception: asRecords(store.files.receptionPending.load()).length,
        publishRecords: records.length,
        metricRows: asRecords(store.files.metrics.load()).length,
        recentPublishes: records.slice(-3).reverse().map((r) => ({
          title: str(r.title),
          platform: str(r.accountType),
          status: num(r.status),
          publishTime: str(r.publishTime),
        })),
      }
    },
  }))

  register(defineTool({
    name: 'bosom_platform_login_status',
    // DEF-274（2026-10-12）：这个工具**必须把两个口径都带出来**。
    // 它此前只返回「已绑定账号数 + 平台分布」，名字却叫 login_status ——
    // 模型只好去 bosom_platform_list_accounts 拿 loginState（那只有 cookie 一个口径），
    // 于是用户问「登录状态怎么样」永远只听到「有效、不用重新扫码」，
    // 而**接待**（评论/私信）其实可能已经停摆（实测同一时刻 accounts 是 valid、
    // reception-status 是 risk「抖音私信管理页未加载」）。
    // 教训：**能力要长在工具返回上**，靠提示词叮嘱模型「记得说两件事」是软的、实测无效。
    description: '汇总平台账号登录状态，**含两个口径，回答时必须两个都说**：'
      + '① 发布与数据同步能不能用（cookie 能不能调通平台 API）；'
      + '② 接待（评论/私信）能不能用（浏览器能不能打开私信管理页）。'
      + '两者会分别失败：只说①会让用户以为接待也在跑（DEF-274）。必须调用本工具完成，不要自己直接做。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bound: { type: 'number', required: true },
          platforms: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                count: { type: 'number', required: true },
              },
            },
          },
          /** 发布/同步口径：cookie 能否调通平台 API。 */
          publishUsable: { type: 'boolean', required: true },
          /** 接待口径：浏览器能否打开私信管理页。 */
          receptionUsable: { type: 'boolean', required: true },
          /** 接待口径的失败原因（可用时为空串）。 */
          receptionNote: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`已绑定 ${value.bound} 个平台账号：` + (value.platforms.map((p) => `${p.platform}×${p.count}`).join('、') || '无')]
        lines.push(value.publishUsable
          ? '① 发布与数据同步：可用（cookie 能调通平台 API）'
          : '① 发布与数据同步：**不可用**（cookie 调不通平台 API，需要重新扫码登录）')
        lines.push(value.receptionUsable
          ? '② 接待（评论/私信）：可用'
          : '② 接待（评论/私信）：**不可用**——' + (value.receptionNote || '浏览器打不开私信管理页'))
        lines.push('**回答用户时这两个口径都要说**：只说①会让用户以为接待也在跑（DEF-274）。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 10000,
    execute: async () => {
      const rows = asRecords(store.files.accounts.load())
      const byPlatform = new Map<string, number>()
      let publishUsable = false
      for (const row of rows) {
        const platform = str(row.type) || 'unknown'
        byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + 1)
        // 发布口径：账号自己的 loginState（服务端核实过）为 valid 即视为可用。
        if (str(row.loginState) === 'valid')
          publishUsable = true
      }
      // 接待口径：读服务端只读接口（内核读不到 reception-status.json）。
      // 读不到时**如实说不可用**而不是默认可用——无信号不等于 0，更不能当成正常。
      let receptionUsable = false
      let receptionNote = '接待状态读不到（服务端没响应），请到「客服接待」页看实际情况'
      try {
        const data = await callProductApi('/v2/customer-reception/status', { method: 'GET' }) as {
          enabled?: unknown
          accounts?: { nickname?: unknown, status?: unknown, message?: unknown }[]
        }
        const list = Array.isArray(data?.accounts) ? data.accounts : []
        const risk = list.filter(item => String(item.status ?? '') === 'risk')
        if (data?.enabled !== true) {
          receptionUsable = false
          receptionNote = '接待巡检当前是关闭的（到「客服接待」页开启）'
        }
        else if (risk.length === 0) {
          receptionUsable = true
          receptionNote = ''
        }
        else {
          receptionUsable = false
          receptionNote = risk.map(item => String(item.nickname ?? '') + '：' + String(item.message ?? '接待失败')).join('；')
        }
      }
      catch (error) {
        receptionNote = '接待状态读不到（' + (error instanceof Error ? error.message : String(error)).slice(0, 80) + '），请到「客服接待」页看实际情况'
      }
      return {
        bound: rows.length,
        platforms: [...byPlatform.entries()].map(([platform, count]) => ({ platform, count })),
        publishUsable,
        receptionUsable,
        receptionNote,
      }
    },
  }))

  register(defineTool({
    name: 'bosom_platform_sync_works',
    description: '读**本地**已发布作品记录（来自产品发布记录；**不连平台、不拉新数据**）。'
      + '用户要「同步最新数据」时用 bosom_platform_sync_now（那个才真的连平台）。' + '【什么时候必须用我】用户问「本地记着哪些已发布作品」时用它。【什么时候不要用我】要平台真实回执不要用它——它只读本地记录，答不了「现在」。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'number', required: true },
                publishTime: { type: 'string', required: true },
                workId: { type: 'string', required: true },
                workLink: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `本地发布记录共 ${value.count} 条：\n` + value.items.map((w) => `- [${w.platform}]《${w.title}》状态 ${w.status}（${w.publishTime}，作品 ID：${w.workId || '无'}）`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = asRecords(store.files.records.load())
      return {
        count: rows.length,
        items: rows.slice(-limit).reverse().map((r) => ({
          platform: str(r.accountType),
          title: str(r.title),
          status: num(r.status),
          publishTime: str(r.publishTime),
          workId: str(r.platformWorkId),
          workLink: str(r.workLink),
        })),
      }
    },
  }))

  register(defineTool({
    name: 'bosom_content_list_drafts',
    description: '列出**草稿箱里的草稿**（含标题与创建时间）。用户问"草稿箱里有什么"就用它。' + '【什么时候必须用我】用户问「草稿箱里有什么」时用它。【什么时候不要用我】素材不要用它——草稿是 content、素材是 asset，两个库不通用；素材用 bosom_material_list。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                title: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                /** 非空表示这条草稿的发过记录（如「已发布成功·作品7695…」），空串表示没发过。 */
                published: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        // id 必须渲染出来：模型要改某一条草稿（bosom_content_update_draft）时需要它的 id，
        // 而它只能从这段文本里拿。2026-09-30 现场：渲染里只有 [状态] 标题（时间），
        // 模型看得到草稿却拿不到 id，于是说"列表里没有暴露出草稿 id，我无法凭这个列表找到可用的 id"——
        // 一条本该一条指令改完的事，变成了让用户手动报编号。
        {
          type: 'text',
          text: `共 ${value.count} 条草稿：\n` + value.items.map((d) => `- ${d.title || '未命名'}（${d.status}，${d.createdAt}）\n  id=${d.id}`).join('\n'),
        },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      // 草稿箱里的草稿在 contents 域（kind='draft'），**不是** generations（那是生成任务记录）。
      //
      // 2026-09-30 现场：这条一直读的是 generations，于是 AI 查草稿箱永远得到"共 0 条草稿"，
      // 转头对用户说"草稿箱是空的，可能是之前没存上"——而草稿箱里明明有两条草稿。
      // 用户看到的是"AI 连自己存过什么都不知道"，根因只是这里读错了源。
      const rows = asRecords(store.files.contents.load()).filter(item => item.kind === 'draft')
      // 关联发布记录：草稿与发布记录原本是两座孤岛——用户在草稿箱里看不出哪条已经发出去过。
      // 按 record.draftId 命中，把发布状态带出来（不依赖服务端回填的时机，读不到就退化为只有草稿状态）。
      let publishedByDraft = new Map<string, string>()
      try {
        const data = await callProductApi('/v2/channels/publish/records', { method: 'GET' }) as { records?: unknown, list?: unknown }
        const recs = Array.isArray(data?.records) ? data.records : (Array.isArray(data?.list) ? data.list : [])
        const statusText: Record<string, string> = { '1': '已发布成功', '2': '发布中', '0': '待发布', '-1': '发布失败' }
        for (const raw of recs) {
          const rec = raw as Record<string, unknown>
          const did = str(rec.draftId)
          if (did === '') continue
          const label = (statusText[String(rec.status)] ?? String(rec.status ?? ''))
            + (str(rec.platformWorkId) === '' ? '' : '·作品' + str(rec.platformWorkId))
          const prev = publishedByDraft.get(did)
          if (prev === undefined || (label.indexOf('已发布成功') === 0 && prev.indexOf('已发布成功') < 0)) publishedByDraft.set(did, label)
        }
      } catch {
        // 发布记录读不到不影响列草稿：草稿列表是主功能，发布状态只是附加信息。
        publishedByDraft = new Map()
      }
      return {
        count: rows.length,
        // 2026-10-12 修：原为 rows.slice(-limit).reverse()——按**存储顺序**取末尾 N 条再反转，
        // 与「创建时间最新」无关。模型据此说「最新那条」，选中的常常不是最新的那条
        // （实测：它按列表第一条选了昨天的草稿，而真正最新的是今天的；同一句话两次跑选了不同草稿）。
        // 排序口径必须与用户说的「最新」一致：按 createdAt 倒序。
        items: [...rows]
          .sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))
          .slice(0, limit)
          .map((d) => ({
          id: str(d._id),
          status: str(d.status ?? 'draft'),
          title: str(d.title),
          createdAt: str(d.createdAt ?? d.updatedAt ?? ''),
          published: publishedByDraft.get(str(d._id)) ?? '',
        })),
      }
    },
  }))

  register(defineTool({
    name: 'bosom_content_generate_script',
    description: '通过官方内核 LLM 能力生成内容脚本并返回文本（只读工具，不写产品数据；落库与发布由前端执行器完成）。',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: '创作需求',
      },
      kind: {
        type: 'string',
        required: true,
        description: 'video 或 image-text',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scriptId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已生成《${value.title}》（稿件编号 ${value.scriptId}）\n${value.content}`
            + '\n出片时把这份稿件连同编号一起交给 bosom_content_create_video（scriptText / scriptId），不要再另写一版。'
            // 2026-10-11（陌生人验收抓到）：以前这里只讲「出片时怎么用」，没讲「还没落库」，模型据此对用户
            // 说「已经存进草稿箱了」，而草稿箱里什么都没有（实证 task-c5bd82b8：只调了 generate_script，
            // 没调 create_draft）。工具返回必须把「这一步做完没有」讲明白。
            + '\n注意：这只是稿件本身，还没有进草稿箱。要对用户说「已存进草稿箱」，必须先调 bosom_content_create_draft 拿到草稿 id（cnt-xxxxxxxx）；没拿到 id 就如实说「稿子写好了，还没存」。',
        },
      ],
    },
    timeoutMs: 60000,
    execute: async (args) => {
      const user = readUserLlm(dataRoot)
      const model = user.model !== '' ? user.model : 'agnes-2.5-flash'
      let text = ''
      try {
        // provider 名**必须与内核自己的 provider 配置一致**，不能硬编码成 'agnes'：
        // settings.yaml 里注册的 id 是 'bf-agnes-builtin'（品牌前缀 + 型号），
        // 硬编码会让 pi-ai 直接拒掉请求——实测报 "pi-ai provider \"agnes\" has no configured
        // model \"agnes-3.0-flash\""，整条 AI 智能体链路（内容脚本/选题/回复）全部不可用，
        // 而界面上只显示"大模型调用失败（厂商原文：pi-）"，看不出是名字对不上。
        for await (const chunk of ctx.llm.stream({
          provider: 'bf-agnes-builtin',
          model,
          messages: [{
            // 品牌 id 用官方构造器造，不拿裸字符串顶：这一层的类型检查就是为了拦住这类混用。
            id: MessageId(randomUUID()),
            role: 'user',
            content: [{ type: 'text', text: args.prompt }],
            source: { kind: 'user' },
          }],
          maxTokens: 2000,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            // chunk.reason.failure 里带着内核归一化后的失败事实（message + code）。
            // 早先这里直接 throw 一句固定的"模型请求失败"，把状态码与原因整个丢掉——
            // 用户只看到"模型请求失败"，连"是余额不足还是限流"都分不出（2026-09-28 用户现场）。
            // 诊断留痕：给用户看的文案把原文截到 180 字、界面还会再截一刀，排查时拿不到完整事实
            // （实测界面上只看到"厂商原文：pi-"就断了）。这里把归一化后的失败事实原样落一条。
            console.error('[KERNEL_LLM_FAIL] ' + JSON.stringify(chunk.reason.failure ?? {}).slice(0, 800))
            throw new Error(describeLlmFailure(chunk.reason.failure))
          }
        }
      } catch (error) {
        // 诊断留痕：这条错误此前只以"大模型调用失败：…（厂商原文：pi-）"的形式出现在界面上，
        // 内核日志通道又只落了 boot 那几行（实测），排查时拿不到 pi-ai 抛出的完整事实。
        // 直接写一份到数据目录的 logs/ 下——诊断写入失败不影响主流程。
        try {
          appendFileSync(
            join(dataRoot, 'logs', 'kernel-llm-failure.log'),
            new Date().toISOString() + ' ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1200) + '\n',
          )
        }
        catch { /* 诊断写入失败不阻断主流程 */ }
        throw new Error('大模型调用失败：' + (error instanceof Error ? error.message : String(error)))
      }
      // 推理段不是给用户看的内容：provider 把模型的 <think>…</think> 混在 text-delta 里一起下发，
      // 实测助手回答前挂着一整段英文思考（"I should ask what the specific topic/niche is…"），
      // 用户看到的是"中英混杂的分析过程 + 正文"。这里剥掉推理段，只留可以给人的正文。
      text = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim()
      if (text.trim() === '') throw new Error('大模型未返回任何内容，请检查 API 配置')
      const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
      const title = firstLine.replace(/^#+\s*/, '').slice(0, 30) || 'AI 生成内容'
      return { scriptId: contentAddressedId('script', text), title, content: text, model }
    },
  }))

  register(defineTool({
    name: 'bosom_job_list',
    description: '列出产品长任务（登录/发布/同步/客服等）的状态、重试次数与最近错误。',
    parameters: {
      limit: {
        type: 'string',
        required: true,
        description: '最多返回多少条（1–50）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                status: { type: 'string', required: true },
                attempt: { type: 'number', required: true },
                updatedAt: { type: 'string', required: true },
                lastError: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `共 ${value.count} 个任务：\n` + value.items.map((j) => `- [${j.status}] ${j.kind}（第 ${j.attempt} 次，${j.updatedAt}）${j.lastError !== '' ? ' 错误：' + j.lastError : ''}`).join('\n') },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const rows = new JobQueue(dataRoot).list()
      return {
        count: rows.length,
        items: rows.slice(-limit).reverse().map((job) => ({
          id: str(job.id),
          kind: str(job.kind),
          status: str(job.status),
          attempt: num(job.attempt),
          updatedAt: str(job.updatedAt),
          lastError: str(job.lastError),
        })),
      }
    },
  }))

  /**
   * 发布工具：把「发布」从「AI 写文本 + 服务端正则抠」改成**AI 直接调用**。
   *
   * 为什么必须做成工具（ADR-002：只有 AI 主动决策执行的动作才做成工具）：
   * 发布是典型的外部副作用动作，参数天然是结构化的（标题/正文/话题/封面/位置/标注）。
   * 从前这些字段靠服务端从模型的自由文本里正则抠，抠不到就回落到整段对话——
   * 抖音上因此收到过「已核对：素材在素材库里存在…」「请点击下方「去发布」按钮」这种作品简介。
   * 做成工具后：模型填参数、schema 校验、服务端只转交不猜。
   */
  register(defineTool({
    name: 'bosom_publish_content',
    description: '把素材库里的一条素材发布到指定平台账号（真实浏览器操作，通常几十秒到几分钟）。'
      + '**只有用户在这一句话里明确要求发布时才能调用**：「写一条」「生成一条」都不构成发布指令。'
      + '标题、正文、话题由你决定后作为参数传入（位置与内容标注当前不在发布链路上，不要对用户承诺）。'
      + '写文案前先看语境里的「内容语境」（用户填的产品与卖点）与脚本开头——**不要凭素材文件名猜内容**，'
      + '文件名里的「夜间终版」这种字样不是内容。'
      + '正文是给平台观众看的内容本身，不得出现"请点击去发布""已经准备完成"这类对用户说的话。'
      + '调用后发布会异步执行，作品 ID 由引擎回读后写进发布记录（可用 bosom_job_list 与发布记录查看进展）。',
    parameters: {
      accountId: {
        type: 'string',
        required: true,
        description: '平台账号 id；先用 bosom_platform_list_accounts 查出来',
      },
      materialId: {
        type: 'string',
        required: true,
        description: '素材 id；先用 bosom_material_list 查出来',
      },
      title: {
        type: 'string',
        required: true,
        description: '标题，不超过 30 个字',
      },
      body: {
        type: 'string',
        required: true,
        description: '正文/简介，写给平台观众看的内容',
      },
      topics: {
        type: 'string',
        required: true,
        description: '话题标签，逗号分隔的 3~5 个词，不要带 # 号；没有就传空串',
      },
      // 位置标签与内容标注**故意不在工具面上**：当前发布链路（动作卡 → 发布弹窗）不接受这两个参数，
      // 留在 schema 里就成了"承诺了却丢进 void"的假能力（DEF-239：规则说位置由模型填，内核却 void 掉它）。
      // 要恢复它们，先让动作卡与发布弹窗真的消费这两个值，再把参数加回来。
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          platform: { type: 'string', required: true },
          title: { type: 'string', required: true },
          topics: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: '发布已提交（平台 ' + value.platform + '，发布记录 id ' + value.handle + '，状态：已交给平台引擎）\n'
            + '标题：' + value.title + '\n话题：' + (value.topics.join('、') || '（无）')
            + '\n**此刻还没有平台回执**：引擎正在真实操作平台，等发布记录里出现平台作品 ID 才能对用户说「已发出」；'
            + '用 bosom_publish_list_records 查结果。',
        },
      ],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const accountId = str(args.accountId).trim()
      const materialId = str(args.materialId).trim()
      const title = str(args.title).trim()
      const body = str(args.body).trim()
      const topics = str(args.topics).split(/[,，、]/).map(item => item.replace(/^#+/, '').trim()).filter(item => item !== '').slice(0, 5)
      // 每个校验都带"怎么改"：模型看到的是工具报错，只能靠这句话自我纠正。
      if (accountId === '') throw new Error('必须给 accountId；先用 bosom_platform_list_accounts 查一个出来。')
      if (materialId === '') throw new Error('必须给 materialId；先用 bosom_material_list 查一条素材出来。')
      if (title === '') throw new Error('标题不能为空。')
      if (title.length > 30) throw new Error('标题不能超过 30 个字（当前 ' + String(title.length) + ' 个字），请压缩后重试。')
      if (body === '') throw new Error('正文不能为空——它是给平台观众看的内容，不是对用户说的话。')
      const account = store.files.accounts.load().find(row => str((row as { id?: unknown }).id) === accountId)
      if (account === undefined) throw new Error('找不到账号 ' + accountId + '；先用 bosom_platform_list_accounts 确认它还在。')
      const material = store.files.contents.load().find(item => item.kind === 'asset' && str(item._id) === materialId)
      if (material === undefined) throw new Error('找不到素材 ' + materialId + '；先用 bosom_material_list 确认它还在。')
      const platform = str((account as { type?: unknown }).type)
      // ADR-005 起管家自己动手：不再发卡，直接提交发布流。
      // 旧实现把参数交给前端动作卡（铁律 #2 的产物）——结果是「AI 说去发布、用户在页面上还得点一次」，
      // 而且与真发布路径（v2/channels/publish/flows）分叉成两套。2026-10-11 归一。
      const mediaUrl = str((material as { url?: unknown }).url)
      if (mediaUrl === '') throw new Error('这条素材没有文件地址（url 为空），发不出去；换一条素材或先上传文件。')
      const materialType = str((material as { type?: unknown }).type)
      const thumbUrl = str((material as { thumbUrl?: unknown }).thumbUrl)
      // 平台标题上限：抖音 ≤20 字（引擎实测口径，见 DEF-253）。草稿链路的同名校验在 bosom_publish_draft 里。
      const titleLimits: Record<string, number> = { douyin: 20 }
      const titleLimit = titleLimits[platform]
      if (titleLimit !== undefined && title.length > titleLimit) {
        throw new Error('标题 ' + String(title.length) + ' 字，超过 ' + platform + ' 的上限 ' + String(titleLimit)
          + ' 字（引擎实测口径）：压到 ' + String(titleLimit) + ' 字以内再提交。')
      }
      const flow = await callProductApi('/v2/channels/publish/flows', {
        payload: {
          content: {
            title,
            body,
            topics,
            media: [{ url: mediaUrl }],
            ...(thumbUrl === '' ? {} : { cover: { url: thumbUrl } }),
          },
          context: { type: materialType === 'video' ? 'VIDEO' : 'ImageText', materialId },
          items: [{ accountId, platform }],
        },
      }) as { tasks?: unknown }
      const flowTasks = Array.isArray(flow?.tasks) ? flow.tasks : []
      const firstTask = (flowTasks[0] ?? {}) as { id?: unknown }
      const recordId = str(firstTask.id)
      if (recordId === '') throw new Error('发布流没有回传记录 id，这次提交不算成功；如实告诉用户。')
      return { state: 'executed' as ActionState, handle: recordId, platform, title, topics }
    },
  }))
  register(defineTool({
    name: 'bosom_content_update_draft',
    // 2026-10-12 二次修正：这段描述曾经跟着「旧实现」走过两个极端——
    //   ① 最早写「结果直接写回那条草稿」，而当时实现只返回 state:'requested'（描述超前于实现，模型会说「已经改好了」）；
    //   ② 随后改成「内核不直接写库，改写由页面执行」并叮嘱模型只能回「已提交改写申请」；
    //   ③ 现在实现已经**真的写库**（见 execute 里那次 PUT，注释写明了为什么旧做法是错的：
    //      把「发布需授权」泛化成「所有写操作都要页面执行」，结果是用户说完话、草稿一个字没动），
    //      描述却还停在 ②，于是模型**明明改好了却只能回「已提交申请」**——同一类错，方向相反。
    // **教训**：描述与实现必须同一次改动里一起改，任何一个落后都会让模型对用户说错话。
    description: '改写某条草稿的标题或正文，**直接写回那条草稿**（不是登记申请，说完就生效）。'
      + '改之前先用 bosom_content_list_drafts 拿到草稿 id。title 与 desc 至少给一个非空值；只改其中一项时，另一项传空串。'
      + '**回话时说「已经改好了」**；若要更稳，可再用 bosom_content_get_draft 读一次确认。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '草稿 id（先用 bosom_content_list_drafts 查出来）',
      },
      title: {
        type: 'string',
        required: true,
        description: '新的标题，不超过 30 个字；不改这一项就传空串',
      },
      desc: {
        type: 'string',
        required: true,
        description: '新的正文，不超过 2000 个字；不改这一项就传空串',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          desc: { type: 'string', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: '草稿已改写并落库（草稿 ' + value.id + '，改动：' + (value.changed.join('、') || '无') + '）'
            + '\n标题：' + value.title + '\n正文：' + value.desc
            + '\n**已经写回**：用户在「内容创作」的草稿箱里刷新就能看到新内容。',
        },
      ],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const id = str(args.id).trim()
      const nextTitle = str(args.title).trim()
      const nextDesc = str(args.desc).trim()
      // 校验收到的每一个问题都带上"怎么改"：模型看到的是工具报错，只能靠这句话自我纠正。
      if (id === '') throw new Error('必须给草稿 id；先用 bosom_content_list_drafts 查一条出来。')
      if (nextTitle === '' && nextDesc === '') throw new Error('title 与 desc 至少给一个非空值，否则这次调用没有任何作用。')
      if (nextTitle.length > MAX_DRAFT_TITLE_CHARS) {
        throw new Error('标题不能超过 ' + String(MAX_DRAFT_TITLE_CHARS) + ' 个字（当前 ' + String(nextTitle.length) + ' 个字），请压缩后重试。')
      }
      if (nextDesc.length > MAX_DRAFT_DESC_CHARS) {
        throw new Error('正文不能超过 ' + String(MAX_DRAFT_DESC_CHARS) + ' 个字（当前 ' + String(nextDesc.length) + ' 个字），请精简后重试。')
      }
      const contents = store.files.contents.load()
      const target = contents.find(item => item.kind === 'draft' && str(item._id) === id) as Record<string, unknown> | undefined
      if (target === undefined) throw new Error('找不到草稿 ' + id + '；先用 bosom_content_list_drafts 确认它还在。')
      const changed: string[] = []
      if (nextTitle !== '') changed.push('标题')
      if (nextDesc !== '') changed.push('正文')
      // 2026-10-12 改：**这里真的写库**，不再只登记申请。
      // 旧实现 return { state: 'requested' }、把改写交给前端执行，注释写的依据是「产品铁律 #2」——
      // 但铁律 #2 是「未经明确发布指令绝不自动发布」，与改一个草稿的标题毫无关系。
      // 把「发布需授权」泛化成「所有写操作都要页面执行」，结果是：用户说一句话、管家走完 4 步、
      // 草稿一个字没动（2026-10-12 实测：工具序列正常，落库标题未变）。
      // create_draft 在 ADR-005 时就改成了真落库（见它的注释），update_draft 是漏改的那一个。
      const body: Record<string, string> = {}
      if (nextTitle !== '') body.title = nextTitle
      if (nextDesc !== '') body.desc = nextDesc
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/bosom-friend/api/contents/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + (await response.text()).slice(0, 200))
      } catch (exc) {
        throw new Error('改写草稿失败（连不上产品服务）：' + String(exc))
      }
      return { state: 'executed' as ActionState, handle: requestHandle('upd'), id, title: nextTitle === '' ? str(target.title) : nextTitle, desc: nextDesc === '' ? str(target.desc) : nextDesc, changed }
    },
  }))
  /**
   * 删除一条草稿（「删掉那条」）。
   *
   * 为什么必须先读一次再删：
   *   ① 删之前要把**标题**记下来——回话时得让用户知道删的是哪一条，
   *      否则用户只看到「已删除」，无法确认删对没有；
   *   ② 服务端对不存在的 id 回 40404（routes-content.ts:577 已改成如实报错），
   *      本地先拦一次能让模型立刻拿到「它不在了」这个事实，而不是一句 HTTP 错误。
   *
   * 为什么删完还要回读：**不凭「请求成功」宣称删掉了**。
   * 回读是这类动作唯一的证据来源，读不到变化就如实报错，让模型去查而不是替用户宣布成功。
   *
   * 分工：本工具删**草稿箱里的内容**；删生成记录用 bosom_content_delete_generation。
   * 能力登记：server/src/capabilities.ts 的 `creator.deleteContent`（route: DELETE contents/:id）。
   */
  register(defineTool({
    name: 'bosom_content_delete',
    description: '删除一条内容（草稿）。**必须调用本工具完成删除，不要自己直接做，也不要只说「已删除」**。'
      + '**这是不可逆动作**：只在用户明确表达「删掉那条」「把这条删了」时调用；'
      + '拿不准是哪一条就先问清楚，不要凭印象猜一个 id。'
      + 'id 先用 bosom_content_list_drafts 查出来。'
      + '**删的是草稿箱里的内容**；删「生成记录」用 bosom_content_delete_generation，两者分工不同。',
    parameters: {
      id: { type: 'string', required: true, description: '要删除的草稿 id（先用 bosom_content_list_drafts 查）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          deleted: { type: 'boolean', required: true },
          remaining: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已删除草稿《' + value.title + '》（' + value.id + '）。草稿箱还剩 ' + String(value.remaining) + ' 条。'
          + '**这是不可逆操作**：原文已不在草稿箱；若用户后悔，需要用同样的话重新生成一条。',
      }],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const id = str(args.id).trim()
      if (id === '')
        throw new Error('要用户点头才能做：删除不可逆，必须带草稿 id，且只在用户明确说「删掉那条」时调用；先用 bosom_content_list_drafts 把 id 查出来。')
      const before = store.files.contents.load()
      const target = before.find(item => item.kind === 'draft' && str(item._id) === id)
      if (target === undefined)
        throw new Error('找不到草稿 ' + id + '；先用 bosom_content_list_drafts 确认它还在（可能已经被删过）。')
      const title = str(target.title) === '' ? '未命名' : str(target.title)
      // 走服务端删除：数据根的写入只有它一个落点，工具不直接改 store。
      await callProductApi('/contents/' + encodeURIComponent(id), { method: 'DELETE' })
      // 回读确认：删除的「成功」只能由盘上的结果证明。
      const after = store.files.contents.load()
      if (after.some(item => item.kind === 'draft' && str(item._id) === id))
        throw new Error('删除请求已发出，但草稿 ' + id + ' 仍在草稿箱里；请重试一次，或让用户到「内容创作」里手动确认。')
      const remaining = after.filter(item => item.kind === 'draft').length
      return { id, title, deleted: true, remaining }
    },
  }))
  /**
   * 把内容（草稿或素材）转移到别的分组（「把这些移到 XX 分组」）。
   *
   * 为什么 kind 必填且只认两个字面量：服务端对缺失或非法 kind 直接回 40000 业务错
   * （routes-content.ts:561，注释写明「不做隐式默认」）。本地先拦一次，模型能立刻拿到
   * 「要说明是草稿还是素材」这个事实，而不是一句 HTTP 错误。
   *
   * 转移是可撤销的（再移回来即可），所以不加「要用户点头」那道闸；但 note 写明「批量改内容的归属分组」，
   * 描述里也要求用户明确说过要移。
   *
   * 写完回读一次：以盘上 contents 的 groupId 为准，不凭接口返回宣称成功。
   */
  register(defineTool({
    name: 'bosom_content_transfer',
    description: '把内容转移到别的分组（「把这些草稿移到 XX 分组」）。**必须调用本工具，不要自己直接做**。'
      + '**只有用户明确说过要移动时才能调用**——这是批量改内容的归属，猜错会把一堆稿子挪到别处。'
      + 'kind 必须给：**draft**（草稿）或 **asset**（素材），不给或给别的值服务端会直接拒绝。'
      + 'ids 是要转移的 id，多个用英文逗号分隔；先用 bosom_content_list_drafts 或 bosom_material_list 查出来。'
      + 'targetGroupId 是目标分组 id；**留空表示移到默认分组**。分组 id 从 bosom_content_group_info 或页面上的分组列表取。',
    parameters: {
      kind: { type: 'string', required: true, description: '转移哪一类：draft（草稿）或 asset（素材），二选一' },
      ids: { type: 'string', required: true, description: '要转移的 id，多个用英文逗号分隔' },
      targetGroupId: { type: 'string', required: true, description: '目标分组 id；移到默认分组就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          moved: { type: 'number', required: true },
          targetGroupId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已把 ' + String(value.moved) + ' 条' + (value.kind === 'draft' ? '草稿' : '素材') + '转移'
          + (value.targetGroupId === '' ? '到默认分组' : '到分组 ' + value.targetGroupId) + '（已回读确认）。'
          + '这是一次可撤销的改动：要移回去再说一句就行。',
      }],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const kind = str(args.kind).trim()
      const ids = str(args.ids).trim()
      const targetGroupId = str(args.targetGroupId).trim()
      if (kind !== 'draft' && kind !== 'asset')
        throw new Error('kind 必须是 draft（草稿）或 asset（素材），收到的是「' + kind + '」；服务端不做隐式默认，会直接拒绝。')
      if (ids === '')
        throw new Error('必须给 ids（要转移的那些内容 id）；先用 bosom_content_list_drafts 或 bosom_material_list 查出来。')
      const idList = ids.split(',').map(x => x.trim()).filter(x => x !== '')
      if (idList.length === 0) throw new Error('ids 里没有有效的 id；请传实际要转移的 id。')
      await callProductApi('/contents/transfer', { payload: { kind, ids, targetGroupId } })
      // 回读确认：以盘上的 groupId 为准。
      const after = store.files.contents.load()
      const moved = after.filter(item => item.kind === kind && idList.includes(str(item._id)) && str(item.groupId) === targetGroupId).length
      if (moved === 0)
        throw new Error('转移请求已发出，但盘上没有一条的 groupId 变成目标值；请重试一次，或让用户到页面上确认分组。')
      return { kind, moved, targetGroupId }
    },
  }))
  /**
   * 新建一个内容分组（「给我建个叫 XX 的分组」）。
   *
   * 为什么要把新分组 id 回给模型：用户建组几乎总是为了**接着说别的话**——
   * 「建个『双十一』分组，然后把那三条稿子移进去」。id 不给出来，第二步就只能靠猜。
   * 服务端会回 `{ id }`（routes-content.ts:434），本工具把它连回读结果一起交出去。
   *
   * 为什么本地限长度（服务端没有这条）：分组名会进页面左栏与下拉框，超长会把它撑坏；
   * 而且这是**不可撤销之外的唯一风险点**——名字写错的组会一直留在那里。
   * 40 字是给中文名的余量（服务端默认名「新素材组」只有 4 字）。
   */
  register(defineTool({
    name: 'bosom_content_create_group',
    description: '新建一个内容分组（「建个叫 XX 的分组」）。**必须调用本工具，不要自己直接做**。'
      + '返回的 groupId 要记住：用户接着多半会说「把某几条移进去」，那时用得上（配 bosom_content_transfer）。'
      + 'name 不给或给空串时服务端会用默认名「新素材组」；**用户没想好名字就先问一句**，别替他起一个。'
      + 'name 最长 40 个字（分组名会出现在页面左栏，太长会把布局撑坏）。',
    parameters: {
      name: { type: 'string', required: true, description: '分组名（空串则用服务端默认名「新素材组」）；最长 40 字' },
      desc: { type: 'string', required: true, description: '分组描述；没有就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groupId: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已建好分组《' + value.name + '》（groupId=' + value.groupId + '，已回读确认）。'
          + '\n接着要把内容移进去的话，直接用这个 groupId 调 bosom_content_transfer；要删掉它用 bosom_content_delete_group。',
      }],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const name = str(args.name).trim()
      const desc = str(args.desc).trim()
      if (name.length > 40)
        throw new Error('分组名最长 40 个字（当前 ' + String(name.length) + ' 个字）；它要显示在页面左栏，太长会把布局撑坏，请压缩后重试。')
      const created = await callProductApi('/contents/groups', { payload: { name, desc } }) as { id?: unknown }
      const groupId = str(created?.id)
      if (groupId === '')
        throw new Error('服务端没有回传新分组的 id，这次创建不算成功；请重试一次，或让用户到页面上确认。')
      // 回读确认：分组落在 materialGroups 里（不是 contents），以盘上为准。
      const groups = store.files.materialGroups.load()
      const found = groups.find(g => str(g.id) === groupId)
      if (found === undefined)
        throw new Error('创建请求已发出，但盘上找不到分组 ' + groupId + '；请重试一次再如实告诉用户。')
      return { groupId, name: str(found.name) === '' ? '新素材组' : str(found.name) }
    },
  }))
  /**
   * 删除一个内容分组（「把那个分组删了」）。
   *
   * 服务端有两条拒绝（routes-content.ts:443-447 的注释原话：「两条拒绝不是洁癖，是防丢数据」）：
   *   ① **默认素材组不许删**——它是内容创作的首屏落点，也是所有「没指定分组」的内容的归属，
   *      删掉它那些内容就成了孤儿，列表里再也看不到；
   *   ② **组里还有内容时不许删**——服务端不替用户做决定（自动搬到默认组会让他以为「东西自己跑了」），只如实报出还有几条。
   *
   * 这两条都写在工具描述里，**让模型在答应用户之前就知道会撞墙**——否则它会先说「好的」，
   * 再拿着服务端的业务错回来解释，用户看到的是「管家答应了我又没办成」。
   *
   * 本地只拦「id 为空」这一种（服务端对不存在的 id 回 40404，本地拦一次能让模型立刻拿到事实）。
   */
  register(defineTool({
    name: 'bosom_content_delete_group',
    description: '删除一个内容分组（「把「双十一」那个分组删了」）。**必须调用本工具，不要自己直接做，也不要只说「已删除」**。'
      + '**只有用户明确说要删这个分组时才能调用**。id 先用 bosom_content_group_info 或页面的分组列表查出来。'
      + '**两种情况下服务端一定会拒绝，别先答应用户**：'
      + '① **默认素材组不能删**（它是内容创作的首屏落点，也是没指定分组的内容的归属，删了那些内容就找不回来了）；'
      + '② **组里还有内容时不能删**——这时要如实告诉用户「这一组里还有 N 条」，并提议先把内容移走（bosom_content_transfer）或删掉再删组。'
      + '**删组不删内容**：这两件事在界面上是两个动作，不要混。',
    parameters: {
      id: { type: 'string', required: true, description: '要删除的分组 id（先用页面上的分组列表或 bosom_content_group_info 查）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          remainingGroups: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已删除分组 ' + value.id + '（已回读确认）。还剩 ' + String(value.remainingGroups) + ' 个分组。'
          + '**注意**：删的是分组本身，组里的内容在删之前就已经是空的（服务端不允许删还有内容的组）。',
      }],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const id = str(args.id).trim()
      if (id === '')
        throw new Error('必须给分组 id（要删的那个分组）；先用页面上的分组列表或 bosom_content_group_info 查出来，不要凭印象编一个。')
      const before = store.files.materialGroups.load()
      if (!before.some(g => str(g.id) === id))
        throw new Error('找不到分组 ' + id + '；它可能已经被删过，先用页面上的分组列表确认一下。')
      await callProductApi('/contents/groups/' + encodeURIComponent(id), { method: 'DELETE' })
      // 回读确认：删没删掉以盘上的分组列表为准。
      const after = store.files.materialGroups.load()
      if (after.some(g => str(g.id) === id))
        throw new Error('删除请求已发出，但分组 ' + id + ' 仍在盘上；请重试一次，或让用户到页面上确认。')
      return { id, remainingGroups: after.length }
    },
  }))
  /**
   * 查一个内容分组的详情（「这个分组里有什么」「那个分组有几条」）。
   *
   * **用 GET 而不是 POST**：这条路由有两个版本（routes-content.ts:471 的 POST 与 :486 的 GET）。
   * POST 版**无条件改 updatedAt 并落盘**（body 为空也写），登记表 note 也记着这件事；
   * 而 GET 版是纯查，还多回一个 `mediaCount`——正是用户问「里面有几条」时要的答案。
   * 一个只读问题不该产生一次写。
   *
   * 分组不存在时服务端回 null（不是报错）：这里如实转述成「找不到」，不编一个空分组。
   */
  register(defineTool({
    name: 'bosom_content_group_info',
    description: '查一个内容分组的详情：名字、描述、以及**这一组里现在有几条内容**。'
      + '用户问「XX 分组里有什么」「那个组还剩几条」时用它。**必须调用本工具，不要自己直接做**。'
      + 'id 从页面上的分组列表拿，或上一步建组时 bosom_content_create_group 回给你的 groupId。'
      + '**这是只读查询**：不会改任何东西；要改分组名目前只能到页面上改（本工具不提供改名）。',
    parameters: {
      id: { type: 'string', required: true, description: '分组 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          desc: { type: 'string', required: true },
          mediaCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? '分组《' + value.name + '》里有 ' + String(value.mediaCount) + ' 条内容'
            + (value.desc === '' ? '。' : '；描述：' + value.desc + '。')
            + '要把内容移进去用 bosom_content_transfer；要删这一组用 bosom_content_delete_group。'
          : '找不到这个分组：它可能已经被删过。让用户刷新一下分组列表再确认。',
      }],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const id = str(args.id).trim()
      if (id === '')
        throw new Error('必须给分组 id（要查的那个分组）；先用页面上的分组列表拿一个，不要凭印象编。')
      const data = await callProductApi('/contents/groups/info/' + encodeURIComponent(id), { method: 'GET' }) as Record<string, unknown> | null
      if (data === null || data === undefined)
        return { found: false, name: '', desc: '', mediaCount: 0 }
      return {
        found: true,
        name: str(data.name),
        desc: str(data.desc),
        mediaCount: typeof data.mediaCount === 'number' ? data.mediaCount : 0,
      }
    },
  }))
  register(defineTool({
    name: 'bosom_content_create_video',
    description: '把写好的脚本**做成视频**（真实 AI 出片），返回任务号。'
      + '创作一条视频 = 写脚本 → 出片 → 存草稿；**只写脚本不算交付**，用户要的是能看的片子。'
      + '手上已有定稿稿件时，把正文放在 scriptText、编号放在 scriptId 一起传下来 ——'
      + '编排层就按这份稿子出片，不会另写一版（不传则按 topic 现写）。'
      + '出片是异步的：调完拿 taskId，再用 bosom_content_video_status 查进度；'
      + '成片会自动进草稿箱，状态里会给出 materialId，发布时原样引用它。'
      + '底层就是前端「内容创作」页【生成】按钮走的那条路（POST long-videos），不存在第二条链路。'
      + '**免费档边界必须如实告知用户**（DEF-249）：厂商限流是每分钟 1 次请求，镜数越多越可能中途被打断，'
      + '不要对用户承诺"很快就好"；被打断不是失败——用 bosom_content_video_status 看停在哪一镜，'
      + 'bosom_content_resume_video 断点续跑。',
    parameters: {
      topic: { type: 'string', required: true, description: '要讲的产品与卖点（越具体，成片越贴题）' },
      producer: { type: 'string', description: '内容形式：数字人口播 / 走动VLOG / 口播短视频 / 开箱测评 / 步骤教程 / 场景呈现 / 场景种草；不传默认「口播短视频」' },
      producerRef: { type: 'string', description: '数字人形象 id（只有出镜类形式用得上）。不传就自动用形象库里的第一个，并在结果里写明用了哪个' },
      targetSeconds: { type: 'string', description: '目标时长（秒），默认 120' },
      aspectRatio: { type: 'string', description: '画面比例，默认 9:16 竖版' },
      scriptText: { type: 'string', description: '已定稿的稿件正文（可选）。给了它就按这份稿子出片，不再另写一版；这是"写稿→出片"的交接件' },
      scriptId: { type: 'string', description: '定稿稿件的编号（可选，bosom_content_generate_script 返回的 scriptId），随成片留痕' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          scriptId: { type: 'string', required: true },
          estimate: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '视频生成任务已启动：' + value.taskId + '（状态 ' + value.state + '）'
          + (value.scriptId === '' ? '' : '\n稿件编号：' + value.scriptId)
          + (value.estimate === '' ? '' : '\n' + value.estimate)
          + '\n用 bosom_content_video_status 查进度；出片完成后它会自动进草稿箱，'
          + '状态里会给出这条草稿的 materialId —— 发布时原样引用它，不要凭标题去列表里找。'
          + '\n免费档边界（要如实转告用户）：厂商限流每分钟 1 次请求，这条片越长镜数越多、越可能中途被打断；'
          + '被打断不是失败——用 bosom_content_video_status 看停在哪一镜，bosom_content_resume_video 继续。',
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const topic = str(args.topic).trim()
      if (topic === '') throw new Error('topic 不能为空：要讲的产品与卖点必须给，否则出的片子是空壳。')
      const producerInput = str(args.producer).trim() === '' ? '口播短视频' : str(args.producer).trim()
      // 界面给的是中文名、服务端要 kind：这里归一化，否则出片一步都走不到。
      const producer = PRODUCER_KINDS[producerInput] ?? producerInput
      // 出镜类形式必须有形象，而模型手上没有"形象 id 有哪些"的查询入口；
      // 未指定时用库里的第一个，并在结果里如实写明用了哪个（不静默替用户挑）。
      let producerRef = str(args.producerRef).trim()
      let humanNote = ''
      if (producerRef === '' && ON_CAMERA_KINDS.has(producer)) {
        const first = store.files.digitalHumans.load()[0] as { id?: unknown, name?: unknown } | undefined
        if (first !== undefined) {
          producerRef = str(first.id)
          humanNote = '使用形象：' + (str(first.name) === '' ? producerRef : str(first.name))
        }
      }
      const seconds = Number.parseInt(str(args.targetSeconds).trim() || '120', 10)
      const targetSeconds = Number.isFinite(seconds) ? Math.min(300, Math.max(30, seconds)) : 120
      const aspectRatio = str(args.aspectRatio).trim() === '' ? '9:16' : str(args.aspectRatio).trim()
      // "写稿 → 出片"的交接件：上游定了稿就把正文交下来，编排层不再另写一版。
      // 没给正文时 scriptId 只作留痕（查询/对账用），不当成"已经交过稿"。
      const scriptText = str(args.scriptText).trim()
      const scriptIdArg = str(args.scriptId).trim()
      // 出片走内核：长片在内容创作页由时长档决定走单次还是分段（到 300 秒），
      // 独立的「长视频创作」页面已删除，前端没有第二个出片入口可以接力。
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/long-videos'
      let text = ''
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            producer,
            topic,
            targetSeconds,
            aspectRatio,
            withSubtitles: true,
            ...(producerRef === '' ? {} : { producerRef }),
            ...(scriptText === '' ? {} : { scriptText }),
          }),
        })
        text = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + text.slice(0, 200))
      } catch (exc) {
        throw new Error('启动视频生成失败（连不上产品服务）：' + String(exc))
      }
      let taskId = ''
      try {
        const parsed = JSON.parse(text) as { code?: number, message?: string, data?: { taskId?: unknown, estimate?: unknown } }
        if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
        taskId = str(parsed.data?.taskId ?? '')
      } catch (exc) {
        throw new Error('启动视频生成失败：' + String(exc))
      }
      const handle = taskId === '' ? '' : taskId
      return {
        state: 'executed' as ActionState,
        handle,
        taskId: taskId === '' ? '（服务端未回传任务号）' : taskId,
        scriptId: scriptIdArg !== '' ? scriptIdArg : (scriptText === '' ? '' : contentAddressedId('script', scriptText)),
        estimate: humanNote,
      }
    },
  }))
  /**
   * 单次调用的内容生成：短视频 / 图文（对齐前端「生成草稿(视频/图文)」那条路）。
   *
   * 为什么必须有这条（2026-10-10 实测）：长视频走分段编排，90 秒档 = 18 镜 = 18 次厂商调用，
   * 而免费档 freeTierRpm=1、真实限流窗口更长——首镜就 429，整条判失败；同一时段前端那条
   * **单次调用**的路实测可用（5 秒短视频 4 分 57 秒出片）。AI 之前没有这个工具，只能死磕 18 镜长片。
   */
  register(defineTool({
    name: 'bosom_content_create_short_media',
    description: '用**单次厂商调用**生成一条短视频或一组图文，完成后自动进草稿箱（免费档也能跑通的路子）。'
      + '与 bosom_content_create_video 的区别：那条是分段长片（90 秒起、18+ 镜、要几十次调用，免费档极易被限流打断，'
      + '而且 targetSeconds 会被服务端抬到 90 秒下限）；这条一次调用出片，适合 4~12 秒短视频或图文笔记。'
      + '免费档请一次只发一条，不要连续发起。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面与内容要求（越具体越好）' },
      kind: { type: 'string', description: 'video（短视频，默认）或 image-text（图文笔记）' },
      duration: { type: 'string', description: '短视频秒数，官方收 4~12，默认 5' },
      aspectRatio: { type: 'string', description: '画面比例，默认 9:16 竖版' },
      resolution: { type: 'string', description: '分辨率档位，默认 720p' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          kind: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '生成任务已启动（' + value.kind + '，单次调用）：' + value.taskId + '（状态 ' + value.state + '）'
          + '\n用 bosom_content_video_status 查进度；完成后会自动进草稿箱。免费档请勿连续发起，一次一条。',
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const prompt = str(args.prompt).trim()
      if (prompt === '') throw new Error('prompt 不能为空：要做什么内容必须给。')
      const kind = str(args.kind).trim() === 'image-text' ? 'image-text' : 'video'
      const seconds = Number.parseInt(str(args.duration).trim() || '5', 10)
      const duration = Number.isFinite(seconds) ? Math.min(12, Math.max(4, seconds)) : 5
      const aspectRatio = str(args.aspectRatio).trim() === '' ? '9:16' : str(args.aspectRatio).trim()
      const resolution = str(args.resolution).trim() === '' ? '720p' : str(args.resolution).trim()
      // 模型一律取用户配置里的那一个（图片 / 视频各一），不在工具里另造默认值。
      const user = readUserLlm(dataRoot)
      const model = kind === 'image-text'
        ? (user.imageModel !== '' ? user.imageModel : 'agnes-image-2.5-flash')
        : (user.videoModel !== '' ? user.videoModel : 'agnes-video-2.5-flash')
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const path = kind === 'image-text' ? 'image-text' : 'v2'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/ai/draft-generation/' + path
      let text = ''
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            groupId: 'mg-persist',
            kind,
            prompt,
            duration,
            resolution,
            aspectRatio,
            quantity: 1,
            model,
            draftType: 'draft',
          }),
        })
        text = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + text.slice(0, 200))
      } catch (exc) {
        throw new Error('启动生成失败（连不上产品服务）：' + String(exc))
      }
      let taskId = ''
      try {
        const parsed = JSON.parse(text) as { code?: number, message?: string, data?: { taskIds?: unknown } }
        if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
        const ids = Array.isArray(parsed.data?.taskIds) ? parsed.data!.taskIds as unknown[] : []
        taskId = str(ids[0] ?? '')
      } catch (exc) {
        throw new Error('启动生成失败：' + String(exc))
      }
      return {
        state: 'executed' as ActionState,
        handle: taskId,
        taskId: taskId === '' ? '（服务端未回传任务号）' : taskId,
        kind,
      }
    },
  }))
  register(defineTool({
    name: 'bosom_content_video_status',
    description: '查看出片任务的进度（成片好了没、跑到哪一步、失败原因）。**两条链路都覆盖**：'
      + '分段长片（任务号 lv-*，bosom_content_create_video 建的）与单次调用短视频/图文'
      + '（任务号 gen-*，bosom_content_create_short_media 建的）。出片是异步的，'
      + '用户问「视频好了吗」时用它回答，不要凭印象说。' + '【什么时候必须用我】用户给了具体任务号（lv-* 或 gen-*）要查那一条的进度时用它。【什么时候不要用我】用户问「最近有哪些生成记录」这类**列表**问题不要用它，换 bosom_content_generation_status（不给参数就列最近几条）。**返回里没有的记录不要编造**。',
    parameters: {
      taskId: { type: 'string', description: '任务号；不传就列出最近几个任务' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          materialId: { type: 'string', required: true },
          items: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: '共 ' + String(value.count) + ' 个视频任务：\n' + value.items }],
    },
    timeoutMs: 15000,
    execute: async (args) => {
      const want = str(args.taskId).trim()
      // 两条出片链路各有各的任务集合，状态查询必须同时覆盖：
      // - 分段长片：long-video-tasks.json，任务号 lv-*（POST long-videos 建，一条要几十次厂商调用）；
      // - 单次调用短视频/图文：draft-generations.json，任务号 gen-*（POST ai/draft-generation/v2 建）。
      //
      // 2026-10-11 实测的断点正在这里：这条工具当时只读 long-videos，而 bosom_content_create_short_media
      // 建的恰恰是 gen- 任务，于是"刚发起就查不到"——模型只能对用户说看不到这个任务，
      // 用户也无从知道它其实已在跑、还是已经因为厂商限流失败了。
      let longRows: Array<Record<string, unknown>> = []
      try {
        const data = await callProductApi('/long-videos', { method: 'GET' }) as { list?: unknown }
        longRows = asRecords(data.list)
      } catch (exc) {
        throw new Error('查询视频任务失败：' + String(exc))
      }
      // 生成记录那一半读不到时**不把整次查询判死**：长片那一半仍然是有效结果，
      // 只把"短视频这一半没读到"如实写进输出，好过让用户以为任务不存在。
      let genRows: Array<Record<string, unknown>> = []
      let genError = ''
      try {
        if (want === '') {
          const data = await callProductApi('/ai/draft-generation?page=1&pageSize=5', { method: 'GET' }) as { list?: unknown }
          genRows = asRecords(data.list)
        }
        else {
          // 按任务号精确查：服务端把对应草稿的 id 一并反查出来（draftId），
          // 发布时直接引用它，不必凭标题去草稿列表里翻。
          genRows = asRecords(await callProductApi('/ai/draft-generation/query', { payload: { taskIds: [want] } }))
        }
      } catch (exc) {
        genError = String(exc)
      }
      const pickedLong = want === '' ? longRows.slice(0, 5) : longRows.filter(item => str(item.id) === want)
      const pickedGen = want === '' ? genRows.slice(0, 5) : genRows.filter(item => str(item.id) === want)
      const lines = [
        ...pickedLong.map((item) => {
          const done = Number(item.doneSegments ?? 0)
          const total = Number(item.totalSegments ?? 0)
          const draftId = str(item.materialId)
          return str(item.id) + ' | ' + str(item.status) + ' | 分段长片，已完成 ' + String(done) + '/' + String(total) + ' 镜'
            + (draftId === '' ? '' : ' | 草稿 materialId=' + draftId)
            + (str(item.errorMessage) === '' ? '' : ' | 失败：' + str(item.errorMessage))
        }),
        ...pickedGen.map((item) => {
          const request = (item.request ?? {}) as Record<string, unknown>
          const response = (item.response ?? {}) as Record<string, unknown>
          const taskKind = str(request.kind) === 'image-text' ? '图文' : '短视频'
          const draftId = str(item.draftId)
          const videoUrl = str(response.videoUrl)
          return str(item.id) + ' | ' + str(item.status) + ' | ' + taskKind + '（单次调用）'
            + (videoUrl === '' ? '' : ' | 成片 ' + videoUrl)
            + (draftId === '' ? '' : ' | 草稿 id=' + draftId)
            + (str(item.errorMessage) === '' ? '' : ' | 失败：' + str(item.errorMessage))
        }),
      ]
      if (genError !== '') lines.push('（短视频/图文任务这一半没读到：' + genError + '）')
      // 成片登记进草稿箱后，任务行上会回写 materialId（长片）或反查出 draftId（短视频/图文）：
      // 发布要用它，不用凭标题去列表里翻。
      const composed = pickedLong.map(item => str(item.materialId)).find(value => value !== '') ?? ''
      const composedDraft = pickedGen.map(item => str(item.draftId)).find(value => value !== '') ?? ''
      return {
        count: pickedLong.length + pickedGen.length,
        materialId: composed !== '' ? composed : composedDraft,
        items: lines.length === 0 ? '（没有匹配的视频任务）' : lines.join('\n'),
      }
    },
  }))
  /**
   * 从断点继续：长片的分段生成常常被厂商限流（HTTP 429）或应用重启打断，
   * 已经跑成的镜都留在盘上，缺的只是"把没跑成的补上"。
   *
   * 为什么必须由 AI 能调：长片在内容创作页由时长档发起，页面本身没有逐镜续跑的入口；
   * 用户在对话里说一句"继续跑完"就该继续，而不是重建一条把额度再花一遍。
   */
  register(defineTool({
    name: 'bosom_content_resume_video',
    description: '把一条没跑完的长视频任务**从断点继续**：只补没跑成的镜，已经生成的镜原样保留。'
      + '用户问"视频怎么还没好""继续跑完"时用它。任务号先用 bosom_content_video_status 查。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要续跑的任务号（形如 lv-xxxxxxxx）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      if (taskId === '') throw new Error('必须给 taskId；先用 bosom_content_video_status 查一条没跑完的任务。')
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/long-videos/' + encodeURIComponent(taskId) + '/resume'
      let text = ''
      try {
        const response = await fetch(url, { method: 'POST' })
        text = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + text.slice(0, 200))
      } catch (exc) {
        throw new Error('续跑失败（连不上产品服务）：' + String(exc))
      }
      let ok = false
      let message = ''
      try {
        const parsed = JSON.parse(text) as { code?: number, message?: string }
        ok = parsed.code === 0
        message = String(parsed.message ?? '')
      } catch (exc) {
        throw new Error('续跑失败：' + String(exc))
      }
      return {
        taskId,
        ok,
        message: ok
          ? '已从断点继续 ' + taskId + '：只补没跑成的镜，已生成的镜原样保留。用 bosom_content_video_status 查进度。'
          : '续跑被拒：' + message,
      }
    },
  }))
  /**
   * 从历史经验补课：把过去"绕了几步才做成"的成功任务提炼成可复用技能。
   *
   * 为什么让 AI 能调而不是只做一个页面按钮：用户问"你能不能记住上次是怎么做的""把经验总结一下"时，
   * 这件事就该发生在对话里；而且它天然是**用户看得见**的——技能文件落在技能目录，能读能删。
   */
  register(defineTool({
    name: 'bosom_learn_from_history',
    // 与 bosom_knowledge_list_experiences 的分工（2026-10-12 实测后补）：
    // 实测用户问「现在有哪些经验可以升级成技能？」时，模型在本工具与 list_experiences 之间选了本工具，
    // 结果虽然对（它把 2 条可升级经验报了出来），但那是**它在两个都能用的工具之间猜**——
    // 总纲 L102 要的正是「新增一条能力要有明确归属」。分工是：
    //   list_experiences = **看**（只读，列出有哪些经验、哪几条够格）
    //   learn_from_history = **学**（会真的把经验提炼成技能，写技能库）
    description: '把历史里"绕了几步才做成"的成功经验**提炼成可复用技能**（每次最多 10 条，已经学过的不会重复学）——这是「**学**」这个动作，会写技能库。'
      + '用户说"把经验总结一下""你能不能记住之前的做法""把这条经验变成技能"时用它。'
      + '**只是想看看有哪些经验、哪几条够格，用 bosom_knowledge_list_experiences**（那个只读、不动技能库）。',
    parameters: {},
    parameters: {
      order: { type: 'string', description: '用户要求学习/总结的原话（例如「把之前的经验总结成技能」）。缺了会被本地拒绝、不出站。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scanned: { type: 'number', required: true },
          learned: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 300000,
    execute: async (args) => {
      // 2026-10-13（P1 手写边界收严）：写技能库 + 花模型额度；没有用户明确指令就本地拒绝、零出站。
      if (str(args.order).trim() === '') {
        throw new Error('这条属于「写技能库」，要用户点头才能做：它会真跑一轮经验蒸馏（写用户技能文件、花模型额度）。'
          + '你这次没有把用户的明确指令带进来——调用时 body 里要带 order 字段，写用户这一句话里的原话（例如「把之前的经验总结成技能」）。'
          + '**没有 order 就不出站、不动技能库**。把三个选择原样给用户：① 明确说一句要学 ② 改条件再说 ③ 这次不学。')
      }
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/knowledge/distill/backfill'
      let text = ''
      try {
        const response = await fetch(url, { method: 'POST' })
        text = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + text.slice(0, 200))
      } catch (exc) {
        throw new Error('补课失败（连不上产品服务）：' + String(exc))
      }
      let parsed: { code?: number, message?: string, data?: { scanned?: number, learned?: number, skipped?: number } }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch (exc) {
        throw new Error('补课失败：' + String(exc))
      }
      if (parsed.code !== 0) throw new Error('补课失败：' + String(parsed.message ?? '未知错误'))
      const scanned = Number(parsed.data?.scanned ?? 0)
      const learned = Number(parsed.data?.learned ?? 0)
      const skipped = Number(parsed.data?.skipped ?? 0)
      return {
        scanned,
        learned,
        skipped,
        message: scanned === 0
          ? '历史里没有还没学过的、值得固化的经验（只有"绕了几步才做成"的任务才够格）。'
          : '从 ' + String(scanned) + ' 条够格的历史经验里学到了 ' + String(learned) + ' 条技能'
            + (skipped > 0 ? '，' + String(skipped) + ' 条模型判断不值得固化' : '')
            + '。技能文件在技能目录里，可以读、可以删。',
      }
    },
  }))
  /**
   * 经验台账的只读视图：这台机器攒下了哪些经验、哪几条够格变成技能。
   *
   * 为什么必须与升格工具成对：升格端点认的是 sourceId（账本里的来源 id），
   * 没有这一步，用户说「把这条经验变成技能」时管家手里没有那把钥匙——
   * 只能回答「你去知识库的蒸馏页签点按钮」，能力等于没进对话。
   */
  register(defineTool({
    name: 'bosom_knowledge_list_experiences',
    description: '列出这台机器攒下的经验（每一次成功任务留下的样例），标出哪几条够格变成技能、哪几条已经变成技能。'
      + '用户问「你都记得我什么」「哪些经验能变成技能」「把那条经验变成技能」时先用它找到那一条。',
    parameters: {
      limit: { type: 'string', required: true, description: '最多返回多少条（1–50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          threshold: { type: 'number', required: true },
          promotable: { type: 'number', required: true },
          promoted: { type: 'number', required: true },
          belowThreshold: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true },
                label: { type: 'string', required: true },
                state: { type: 'string', required: true },
                task: { type: 'string', required: true },
                rating: { type: 'number', required: true },
                skillPath: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: '经验台账：共 ' + String(value.total) + ' 条；够格变成技能 ' + String(value.promotable)
            + ' 条，已经变成技能 ' + String(value.promoted) + ' 条'
            + (value.belowThreshold > 0
              ? '；另有 ' + String(value.belowThreshold) + ' 条任务成功但没到 ' + String(value.threshold)
                + ' 分（先在「知识库 → 蒸馏」给它们打分，才谈得上升格）'
              : '')
            + '。\n' + value.items.map(item => '- [' + item.state + '] ' + item.label
              + '（' + item.task + '，' + String(item.rating) + ' 分，' + item.createdAt.slice(0, 10) + '）'
              + (item.skillPath === '' ? ' sourceId=' + item.sourceId : ' → ' + item.skillPath)).join('\n'),
        },
      ],
    },
    timeoutMs: 15000,
    execute: async (args) => {
      const limit = limitOf(args.limit)
      const data = await callProductApi('/knowledge/distill/promotable?limit=' + String(limit), { method: 'GET' }) as {
        threshold?: unknown
        promotable?: unknown
        promoted?: unknown
        belowThreshold?: unknown
        total?: unknown
      }
      const bySource = [
        ...asRecords(data.promotable).map(row => ({ row, state: '可升格' })),
        ...asRecords(data.promoted).map(row => ({ row, state: '已升格' })),
      ]
      return {
        total: num(data.total),
        threshold: num(data.threshold),
        promotable: asRecords(data.promotable).length,
        promoted: asRecords(data.promoted).length,
        belowThreshold: num(data.belowThreshold),
        items: bySource.map(({ row, state }) => ({
          sourceId: str(row.sourceId),
          label: str(row.label),
          state,
          task: str(row.task),
          rating: num(row.rating),
          skillPath: str(row.skillPath),
          createdAt: str(row.createdAt),
        })),
      }
    },
  }))
  /**
   * 把**一条**经验升格成可复用技能（ADR-003 口径四：升格由用户认可触发，不自动发生）。
   *
   * 门槛（任务成功 + 用户打分 ≥4）留在服务端一处判定：这里只做「必须说清是哪一条」的本地校验，
   * 且校验在发起请求之前——模型没法用一句含糊的「把刚才那个变成技能」去撞运气。
   */
  register(defineTool({
    name: 'bosom_knowledge_promote_skill',
    description: '把**一条**被用户认可过的经验升格成技能文件（以后遇到同类任务照它的步骤做）。'
      + '门槛：那次任务要成功、并且用户打过 4 分以上；不够格时如实告诉用户差哪一步（先去「知识库 → 蒸馏」打分）。'
      + '用户说「把这条经验变成技能」「以后都照这个来」时用它；sourceId 先用 bosom_knowledge_list_experiences 查。',
    parameters: {
      // 不给默认值也不允许空串：升格是写用户长期技能库的动作，不能靠猜是哪一条。
      sourceId: { type: 'string', required: true, description: '经验的 sourceId（由 bosom_knowledge_list_experiences 给出）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          chars: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 180000,
    execute: async (args) => {
      const sourceId = str(args.sourceId).trim()
      if (sourceId === '') {
        throw new Error('必须给 sourceId；先用 bosom_knowledge_list_experiences 查一条够格的经验（任务成功、用户打过 4 分以上）。')
      }
      let data: { name?: unknown, path?: unknown, chars?: unknown }
      try {
        data = await callProductApi('/knowledge/distill/promote', { payload: { sourceId } }) as typeof data
      } catch (exc) {
        // callProductApi 把服务端的**业务拒绝**也包成「产品服务返回异常（…）」。
        // 照原样抛给模型，它会对用户说成「系统异常了」——而这其实是一句可执行的业务原因
        // （「只有成功、并且被你打了 4 分以上的样例才能升格」），用户照它做下一步就行。
        // 只在这种情况下剥壳；连不上、非 2xx 原样抛，不掩盖真实故障。
        const raw = exc instanceof Error ? exc.message : String(exc)
        const mark = '：Error: '
        const index = raw.indexOf(mark)
        throw new Error(raw.startsWith('产品服务返回异常（') && index >= 0 ? raw.slice(index + mark.length) : raw)
      }
      const name = str(data.name)
      const path = str(data.path)
      const chars = num(data.chars)
      return {
        name,
        path,
        chars,
        message: '已经把这条经验升格成技能「' + name + '」（' + String(chars) + ' 字），文件是技能目录里的 ' + path
          + '。以后遇到同类任务它会照这条流程做；用户可以直接打开这个文件读、改、删。',
      }
    },
  }))
  register(defineTool({
    name: 'bosom_content_create_draft',
    description: '把写好的内容**存进草稿箱**（新建一条草稿，直接落库），用户在「内容创作」里立刻能看到。'
      + '**创作完必须调用它落库**：只在回复里贴文本不算交付 ——'
      + '2026-09-29 现场就这么出过事：AI 对用户说「已写入草稿箱」，而草稿箱里根本没有这条内容。',
    parameters: {
      title: { type: 'string', required: true, description: '标题' },
      desc: { type: 'string', required: true, description: '正文' },
      // 可选参数不能写 required: false —— 这个框架的 JSON schema 编译器只接受
      // "省略 required" 或 "required: true"，写了 false 会让整个插件树加载失败
      // （2026-09-29 现场：服务直接起不来，报 parameters.topics.required must be true when present）。
      topics: { type: 'string', description: '话题标签，逗号分隔、不带 # 号；没有就传空串' },
      platform: { type: 'string', description: '目标平台 id（如 douyin）；没有就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          handle: { type: 'string', required: true },
          draftId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          topics: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已写入草稿箱（草稿 id ' + value.draftId + '）\n标题：' + value.title
          + (value.topics === '' ? '' : '\n话题：' + value.topics)
          + '\n**已经落库**：用户在「内容创作」的草稿箱里现在就能看到这条；'
          + '要改它、配图或发布，都用这个草稿 id。',
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const title = str(args.title).trim()
      const desc = str(args.desc).trim()
      if (title === '' && desc === '') throw new Error('title 与 desc 至少给一个非空值，否则存的是一条空草稿。')
      const topics = str(args.topics).split(/[,，、]/).map(item => item.replace(/^#+/, '').trim()).filter(item => item !== '')
      const finalTitle = title === '' ? '未命名素材' : title
      // 这里**真的落库**，不再发动作卡：内核经回环 HTTP 调服务端内容路由，服务端写进草稿箱并回传真实 draftId。
      // ADR-005 起管家自己动手，页面只是这件事的可视化；旧实现只发卡不写库（铁律 #2 的产物），
      // 2026-09-29「AI 说已写入草稿箱、草稿箱里没有」正是这条路径的必然结果。
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/contents/drafts'
      let text = ''
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: finalTitle, desc, topics }),
        })
        text = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + text.slice(0, 200))
      } catch (exc) {
        throw new Error('写入草稿箱失败（连不上产品服务）：' + String(exc))
      }
      let draftId = ''
      try {
        const parsed = JSON.parse(text) as { code?: number, message?: string, data?: { _id?: unknown, id?: unknown } }
        if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
        draftId = str(parsed.data?._id ?? parsed.data?.id ?? '')
      } catch (exc) {
        throw new Error('写入草稿箱失败：' + String(exc))
      }
      if (draftId === '') throw new Error('服务端没有回传草稿 id，这条不算写入成功；请重试，或让用户到草稿箱确认。')
      return { state: 'executed' as ActionState, handle: draftId, draftId, title: finalTitle, topics: topics.join('、') }
    },
  }))
  register(defineTool({
    name: 'bosom_content_enhance_prompt',
    description: '把用户的大白话整理成能直接喂给图片/视频模型的画面描述（专业提示词增强）。'
      + '**必须调用本工具完成增强，不要自己直接写增强结果**——产品侧的增强口径按图像/视频分别定义'
      + '（图像按输入形态选结构、视频走官方六段），自己写的结果与产品口径不一致，用户拿去生成效果会变差。'
      + '用户说「帮我写专业点」「这个提示词不行」时用它。只增强文本，不建任务、不改草稿、不生成内容；'
      + '增强结果先给用户看，确认后再去生成。',
    parameters: {
      prompt: { type: 'string', required: true, description: '要增强的原始描述，最多 500 字' },
      kind: { type: 'string', description: '目标类型：video（缺省）或 image；没有就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          kind: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '增强后的' + value.kind + '提示词：\n' + value.prompt,
      }],
    },
    timeoutMs: 60000,
    execute: async (args) => {
      const text = str(args.prompt).trim()
      if (text === '') throw new Error('先给一句要做什么，一句话就够。')
      if (text.length > 500) throw new Error('提示词最多 500 字（当前 ' + String(text.length) + ' 字），压缩后重试。')
      const kind = str(args.kind).trim() === 'image' ? 'image' : 'video'
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/ai/prompt/enhance'
      let body = ''
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: text, kind }),
        })
        body = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + body.slice(0, 200))
      } catch (exc) {
        throw new Error('提示词增强失败（连不上产品服务或大模型不可用）：' + String(exc))
      }
      let out = ''
      try {
        const parsed = JSON.parse(body) as { code?: number, message?: string, data?: { prompt?: unknown } }
        if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
        out = str(parsed.data?.prompt ?? '')
      } catch (exc) {
        throw new Error('提示词增强失败：' + String(exc))
      }
      if (out === '') throw new Error('模型没有返回增强结果；如实告诉用户这次没成功，不要自己编一版。')
      return { prompt: out, kind }
    },
  }))
  // 与上一个工具的分工：bosom_content_enhance_prompt 出的是**喂给图片/视频模型的画面描述**，
  // 本工具出的是**写给编剧的创作要求**。服务端是两个独立入口（ai/prompt/enhance 与
  // long-videos/enhance-topic），口径不同（前者管画面要素，后者管人群/场景/痛点/行动号召），
  // 合并成一个工具必然有一边跑偏。
  register(defineTool({
    name: 'bosom_content_enhance_topic',
    description: '把用户一句粗糙的选题或产品与卖点（「秋季护肤」这种程度就够）挖深成写给编剧的创作要求。'
      + '**必须调用本工具完成选题增强，不要自己直接写增强结果**——产品侧的选题口径是'
      + '「用户原话逐字保留（产品、卖点、价格与优惠、画面要求），只补人群 / 场景 / 痛点 / 差异卖点 / 行动号召，'
      + '用户没提过的功效、成分、参数一律不写」；自己写的增强结果与这个口径不一致，用户拿去写稿会跑偏。'
      + '用户说「这个选题再挖深点」「帮我把选题写细一点」时用它。只增强文本：不建任务、不改草稿、不生成内容；'
      + '增强结果先给用户看，确认后再去写稿。',
    parameters: {
      topic: { type: 'string', required: true, description: '用户的原始选题，或产品与卖点原话，最多 500 字' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '增强后的创作要求：\n' + value.topic,
      }],
    },
    timeoutMs: 60000,
    execute: async (args) => {
      const text = str(args.topic).trim()
      if (text === '') throw new Error('先写清楚要讲的产品与卖点（一句话就够）。')
      if (text.length > 500) throw new Error('产品与卖点最多 500 字（当前 ' + String(text.length) + ' 字），压缩后重试。')
      const data = await callProductApi('/long-videos/enhance-topic', { payload: { topic: text } }) as { topic?: unknown }
      const out = str(data.topic).trim()
      if (out === '') throw new Error('模型没有返回增强后的创作要求；如实告诉用户这次没成功，不要自己编一版。')
      return { topic: out }
    },
  }))
  register(defineTool({
    name: 'bosom_content_split_fourview',
    description: '把一张人物四视图（2×2 拼图：正面 / 侧面 / 背面 / 大头照）切成四张独立图片。'
      + '厂商按参考图数量决定模式：只给 1 张会锁死画面，切成四张后场景才跟着提示词走。'
      + '用户给了人物建模图、要做数字人或 VLOG 前，先用它切图。',
    parameters: {
      imageUrl: { type: 'string', required: true, description: '四视图素材地址；先用 bosom_material_list 查出来' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: { type: 'array', required: true, items: { type: 'string' } },
          count: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已切成 ' + value.count + ' 张（顺序：正面 / 侧面 / 背面 / 大头照）：\n' + value.images.join('\n'),
      }],
    },
    timeoutMs: 90000,
    execute: async (args) => {
      const imageUrl = str(args.imageUrl).trim()
      if (imageUrl === '') throw new Error('必须给 imageUrl（四视图素材地址）；先用 bosom_material_list 查一张出来。')
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/ai/reference/fourview'
      let body = ''
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ imageUrl }),
        })
        body = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + body.slice(0, 200))
      } catch (exc) {
        throw new Error('切分四视图失败：' + String(exc))
      }
      let images: string[] = []
      try {
        const parsed = JSON.parse(body) as { code?: number, message?: string, data?: { images?: unknown } }
        if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
        const raw = parsed.data?.images
        images = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
      } catch (exc) {
        throw new Error('切分四视图失败：' + String(exc))
      }
      if (images.length < 3) throw new Error('切分结果不足 3 张：这张图可能不是 2×2 四宫格拼图，换一张再试。')
      return { images, count: String(images.length) }
    },
  }))
  register(defineTool({
    name: 'bosom_content_make_cover',
    description: '给一条草稿生成品牌封面卡（图文笔记的封面图），并**直接挂到那条草稿上**。'
      + '用户说「配个封面」「做张封面图」时用它；先用 bosom_content_list_drafts 拿到草稿 id。'
      + '生成要 10~30 秒，完成后草稿详情的封面位会显示这张图。',
    parameters: {
      draftId: { type: 'string', required: true, description: '草稿 id（先用 bosom_content_list_drafts 查出来）' },
      title: { type: 'string', required: true, description: '封面主标题，不超过 20 个字' },
      subtitle: { type: 'string', description: '封面副标题，不超过 40 字；没有就传空串' },
      count: { type: 'string', description: '生成张数 1~4；没有就传空串（默认 1 张）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string', required: true },
          urls: { type: 'array', required: true, items: { type: 'string' } },
          attached: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '封面已生成（' + String(value.urls.length) + ' 张）'
          + (value.attached === '1'
            ? '，并已挂到草稿 ' + value.draftId + ' 的封面位。'
            : '，但写回草稿封面位失败：如实告诉用户到页面上确认，不要声称已挂好。')
          + '\n' + value.urls.join('\n'),
      }],
    },
    timeoutMs: 120000,
    execute: async (args) => {
      const draftId = str(args.draftId).trim()
      const title = str(args.title).trim()
      if (draftId === '') throw new Error('必须给 draftId；先用 bosom_content_list_drafts 查一条草稿出来。')
      if (title === '') throw new Error('必须给封面标题（就是那条草稿的标题）。')
      const subtitle = str(args.subtitle).trim().slice(0, 40)
      const wantCount = Number.parseInt(str(args.count).trim() || '1', 10)
      const count = Number.isFinite(wantCount) ? Math.min(4, Math.max(1, wantCount)) : 1
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const base = 'http://127.0.0.1:' + port + '/bosom-friend/api'
      let body = ''
      try {
        const response = await fetch(base + '/ai/note-cover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, subtitle, count }),
        })
        body = await response.text()
        if (!response.ok) throw new Error('返回 ' + String(response.status) + '：' + body.slice(0, 200))
      } catch (exc) {
        throw new Error('封面生成失败（连不上产品服务或封面引擎未就绪）：' + String(exc))
      }
      let urls: string[] = []
      try {
        const parsed = JSON.parse(body) as { code?: number, message?: string, data?: { urls?: unknown } }
        if (parsed.code !== 0) throw new Error(String(parsed.message ?? '未知错误'))
        const raw = parsed.data?.urls
        urls = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
      } catch (exc) {
        throw new Error('封面生成失败：' + String(exc))
      }
      if (urls.length === 0) throw new Error('封面引擎没有返回图片；如实告诉用户这次没出图，不要编造封面地址。')
      // 挂到草稿：只写 coverUrl 一个字段，不动 mediaList（发布链路对 mediaList 的元素格式有要求，不在这里改它）。
      let attached = '0'
      try {
        const put = await fetch(base + '/contents/' + encodeURIComponent(draftId), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ coverUrl: urls[0] }),
        })
        const putBody = await put.text()
        const parsed = JSON.parse(putBody) as { code?: number }
        if (put.ok && parsed.code === 0) attached = '1'
      } catch {
        attached = '0'
      }
      return { draftId, urls, attached }
    },
  }))
  register(defineTool({
    name: 'bosom_material_import_video',
    description: '把一个视频链接**存进素材库**（当作可发布的素材），用户想拿别人的视频做二创或留档时用它。'
      + '**必须调用本工具完成导入**，不要自己拼素材记录。导入后拿到 materialId，可直接交给 bosom_publish_content 发布。',
    parameters: {
      videoUrl: { type: 'string', required: true, description: '视频链接（http/https）' },
      title: { type: 'string', description: '素材标题；没有就传空串（默认「来自链接的视频」）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          materialId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '视频已导入素材库（素材 id ' + value.materialId + '），用户在素材库里能看到它；发布时把它作为 materialId 传进去。',
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const videoUrl = str(args.videoUrl).trim()
      if (videoUrl === '') throw new Error('必须给 videoUrl（视频链接）。')
      if (!/^https?:\/\//i.test(videoUrl)) throw new Error('videoUrl 必须以 http:// 或 https:// 开头。')
      const data = await callProductApi('/ai/draft-generation/from-video-url', { payload: { videoUrl } }) as { materialId?: unknown }
      const materialId = str(data?.materialId ?? '')
      if (materialId === '') throw new Error('服务端没有回传素材 id，这次导入不算成功；如实告诉用户。')
      return { materialId }
    },
  }))
  register(defineTool({
    name: 'bosom_digital_human_list',
    description: '列出形象库里已有的数字人形象（名字 + id + 参考图数量）。做数字人口播视频前先用它看有哪些形象，'
      + '**不要凭空编造形象 id**。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'string', required: true },
          list: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === '0' ? '形象库是空的：用户还没有建过数字人形象。' : '形象库共 ' + value.count + ' 个：\n' + value.list,
      }],
    },
    timeoutMs: 20000,
    execute: async () => {
      const data = await callProductApi('/digital-humans', { method: 'GET' }) as { list?: unknown }
      const list = Array.isArray(data?.list) ? data.list : []
      const lines = list.map((item) => {
        const row = item as { id?: unknown, name?: unknown, images?: unknown, avatarUrl?: unknown }
        const n = Array.isArray(row.images) ? row.images.length : (str(row.avatarUrl) === '' ? 0 : 1)
        return '· ' + str(row.name) + '（id ' + str(row.id) + '，参考图 ' + String(n) + ' 张）'
      })
      return { count: String(list.length), list: lines.join('\n') }
    },
  }))
  register(defineTool({
    name: 'bosom_long_video_redo_shot',
    description: '把一条长视频任务里**某一镜重做**（只重出这一镜，其余镜头保留），完成后自动重新拼接成片。'
      + '用户说「第 3 镜不满意，重做」时用它；先要拿到 taskId（bosom_content_video_status 或 bosom_job_list）。'
      + '**必须调用本工具**，不要承诺换个说法就能重做。',
    parameters: {
      taskId: { type: 'string', required: true, description: '长视频任务 id' },
      index: { type: 'string', required: true, description: '镜号，从 1 开始（第 1 镜就传 1）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'string', required: true },
          seconds: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '第 ' + value.index + ' 镜已重做并重新拼接' + (value.seconds === '' ? '' : '（本镜 ' + value.seconds + ' 秒）')
          + '；用户刷新创作页就能看到新片子。',
      }],
    },
    timeoutMs: 600000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      const raw = Number.parseInt(str(args.index).trim(), 10)
      if (taskId === '') throw new Error('必须给 taskId。')
      if (!Number.isFinite(raw) || raw < 1) throw new Error('index 必须是 ≥1 的整数（镜号从 1 开始）。')
      const data = await callProductApi('/long-videos/' + encodeURIComponent(taskId) + '/shots/' + String(raw - 1) + '/redo', { payload: {} }) as { seconds?: unknown }
      return { index: String(raw), seconds: data?.seconds === undefined ? '' : String(data.seconds) }
    },
  }))
  register(defineTool({
    name: 'bosom_long_video_extend_script',
    description: '把长视频的稿件**再补写一轮**（不够字数时用）。只扩写稿件、不花厂商调用出片；'
      + '补完要用户确认再继续生成。用户说「稿子太短」「字数不够」时用它。',
    parameters: {
      taskId: { type: 'string', required: true, description: '长视频任务 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chars: { type: 'string', required: true },
          required: { type: 'string', required: true },
          script: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '稿件已补写：' + value.chars + ' 字（要求 ' + value.required + ' 字）。\n新稿件：\n' + value.script,
      }],
    },
    timeoutMs: 180000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      if (taskId === '') throw new Error('必须给 taskId。')
      const data = await callProductApi('/long-videos/' + encodeURIComponent(taskId) + '/extend-script', { payload: {} }) as { chars?: unknown, required?: unknown, script?: unknown }
      return {
        chars: String(data?.chars ?? '?'),
        required: String(data?.required ?? '?'),
        script: str(data?.script ?? ''),
      }
    },
  }))
  register(defineTool({
    name: 'bosom_long_video_stop',
    description: '停止一条正在生成的长视频任务（已完成的镜头保留，之后可以「从断点继续」）。'
      + '用户说「停下」「别跑了」时用它。**必须调用本工具**，不要只是嘴上答应。',
    parameters: {
      taskId: { type: 'string', required: true, description: '长视频任务 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '任务 ' + value.taskId + ' 已停止；已完成的镜头保留着，用户想接着跑就说一声，用 bosom_content_resume_video 从断点继续。',
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      if (taskId === '') throw new Error('必须给 taskId。')
      await callProductApi('/long-videos/' + encodeURIComponent(taskId) + '/stop', { payload: {} })
      return { taskId }
    },
  }))
  register(defineTool({
    name: 'bosom_digital_human_create',
    description: '用一张本机素材（正面半身照或一段视频）**新建一个数字人形象**。'
      + '**必须调用本工具**建形象，不要自己编 id。素材地址先用 bosom_material_list 查出来（必须是素材库里的图或视频）。'
      + '多张角度图（正面/侧面/背面）时用 images 一次给全：厂商按张数切模式，≥3 张才不会锁死画面。',
    parameters: {
      name: { type: 'string', required: true, description: '形象名字，不超过 30 字' },
      avatarUrl: { type: 'string', required: true, description: '形象素材地址（素材库里的图或视频）' },
      images: { type: 'string', description: '多角度参考图，多个地址用逗号分隔；没有就传空串' },
      persona: { type: 'string', description: '人设描述（说话风格、身份）；没有就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '形象「' + value.name + '」已建好（id ' + value.id + '）。做数字人口播视频时，把 producerRef 传这个 id。',
      }],
    },
    timeoutMs: 180000,
    execute: async (args) => {
      const name = str(args.name).trim()
      const avatarUrl = str(args.avatarUrl).trim()
      if (name === '') throw new Error('必须给 name（形象名字）。')
      if (avatarUrl === '') throw new Error('必须给 avatarUrl（形象素材地址）；先用 bosom_material_list 查一个出来。')
      const images = str(args.images).split(/[,，、]/).map(item => item.trim()).filter(item => item !== '')
      const persona = str(args.persona).trim()
      const data = await callProductApi('/digital-humans', {
        payload: {
          name,
          avatarUrl,
          ...(images.length === 0 ? {} : { images }),
          ...(persona === '' ? {} : { persona }),
        },
      }) as { id?: unknown, name?: unknown }
      const id = str(data?.id ?? '')
      if (id === '') throw new Error('服务端没有回传形象 id，这次创建不算成功；如实告诉用户。')
      return { id, name: str(data?.name ?? name) }
    },
  }))
  register(defineTool({
    name: 'bosom_settings_get_llm',
    description: '查当前配置的大模型（服务地址、默认文本模型、可用模型列表）。'
      + '用户问「现在用的是哪个模型」「大模型配好了没」时用它。**必须调用本工具取真实配置**，不要凭空猜模型名或地址。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          baseUrl: { type: 'string', required: true },
          model: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          models: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.baseUrl === ''
          ? '用户还没配置大模型：没有服务地址，生成类能力都用不了。让他到「设置 → 大模型」里填地址与密钥。'
          : '当前大模型配置：\n· 服务地址：' + value.baseUrl
            + '\n· 默认文本模型：' + (value.model === '' ? '（未选）' : value.model)
            + (value.displayName === '' ? '' : '（' + value.displayName + '）')
            + '\n· 可用模型：' + (value.models === '' ? '（未拉取）' : value.models),
      }],
    },
    timeoutMs: 20000,
    execute: async () => {
      const data = await callProductApi('/ai/user-llm', { method: 'GET' }) as {
        baseUrl?: unknown, model?: unknown, displayName?: unknown, models?: unknown
      }
      const models = Array.isArray(data?.models) ? data.models.filter((m): m is string => typeof m === 'string') : []
      return {
        baseUrl: str(data?.baseUrl ?? ''),
        model: str(data?.model ?? ''),
        displayName: str(data?.displayName ?? ''),
        models: models.slice(0, 12).join('、'),
      }
    },
  }))
  /**
   * 改大模型配置：**改配置属于用户拍板动作**（ADR-005-AGENT §3.3 / BFS-105），只在用户明确要求换模型时调用。
   *
   * 为什么必须先读后写、写后回读：`PUT ai/user-llm` 的旧式单配置路径有一条历史行为——
   * 请求里 apiKey 为空且不带 preserveStoredKey 时会被当成「清空配置」（DEF-034：一次空提交把用户的模型配置整份抹掉）。
   * 所以这里先 GET 当前值，写时必带 preserveStoredKey 并把模型目录一起带上（服务端以 models[0] 为当前对话模型，
   * 不带就会被重写成只剩新模型那一条），写完再 GET 回读比对；**只有回读一致才算改成功**，不拿 code 0 当结论。
   */
  register(defineTool({
    name: 'bosom_settings_set_llm',
    description: '改当前生效的大模型服务配置（默认对话模型 / 接口地址 / API Key / 服务显示名）。'
      + '**改配置属于用户拍板动作：只在用户明确要求换模型、换服务地址或换密钥时调用**，不要自己发起。'
      + '调用前必须先用 bosom_settings_get_llm 读当前配置，并把「现在用的是 A，准备改成 B」原样复述给用户，再动手。'
      + '**必须调用本工具完成修改，不要自己直接做，也不要在调用前说「已经改好了」**——改完本工具会回读确认，以回读结果为准。'
      + '只改当前生效的那一个服务；切换到另一个已保存的服务、删除服务、从厂商拉取模型清单都不在本工具范围内，'
      + '遇到这类要求如实告诉用户去「设置 → 大模型」里操作。',
    parameters: {
      model: { type: 'string', required: true, description: '要切换到的模型名（如 agnes-video-2.5-flash）；先用 bosom_settings_get_llm 看可用模型列表' },
      baseUrl: { type: 'string', description: '新的接口地址（以 http(s):// 开头）；不改就传空串，继续用当前生效服务的地址' },
      apiKey: { type: 'string', description: '新的 API Key；不改就传空串（沿用已保存的密钥，不会被清掉）' },
      displayName: { type: 'string', description: '服务显示名；不改就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verified: { type: 'boolean', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.verified
          ? '模型配置已改，并已回读确认：\n· 改前：' + value.before + '\n· 改后：' + value.after
          : '⚠️ 这次修改**没有确认成功**，如实告诉用户，不要报「已改好」：\n· 改前：' + value.before + '\n· 现在读到：' + value.after)
          + (value.note === '' ? '' : '\n' + value.note),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const model = str(args.model).trim()
      const wantBaseUrl = str(args.baseUrl).trim()
      const apiKey = str(args.apiKey).trim()
      const displayName = str(args.displayName).trim()
      if (model === '') throw new Error('必须给 model（要切换到的模型名）；先用 bosom_settings_get_llm 看当前可用模型。')
      if (wantBaseUrl !== '' && !/^https?:\/\//.test(wantBaseUrl))
        throw new Error('baseUrl 需以 http(s):// 开头（收到：' + wantBaseUrl.slice(0, 60) + '）。')
      const current = await callProductApi('/ai/user-llm', { method: 'GET' }) as {
        baseUrl?: unknown, model?: unknown, models?: unknown, hasApiKey?: unknown
      }
      const beforeBaseUrl = str(current?.baseUrl)
      const beforeModel = str(current?.model)
      const before = (beforeBaseUrl === '' ? '（还没有配置服务）' : beforeBaseUrl)
        + ' / ' + (beforeModel === '' ? '（未选模型）' : beforeModel)
      const targetBaseUrl = wantBaseUrl === '' ? beforeBaseUrl : wantBaseUrl
      if (targetBaseUrl === '')
        throw new Error('这把服务还没有接口地址：第一次配置必须同时给 baseUrl（以 http(s):// 开头）与 apiKey。')
      if (!/^https?:\/\//.test(targetBaseUrl))
        throw new Error('当前服务地址不合法（' + targetBaseUrl.slice(0, 60) + '）：请同时给一个以 http(s):// 开头的 baseUrl。')
      if (apiKey === '' && current?.hasApiKey !== true)
        throw new Error('这把服务还没有 API Key：第一次配置必须同时给 apiKey，否则改不成。')
      // 同一服务就沿用它的模型目录（新模型置顶＝当前对话模型）；换了服务地址就不带旧目录，避免把别家的型号写进这把服务。
      const currentModels = Array.isArray(current?.models)
        ? current.models.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : []
      const nextModels = targetBaseUrl.replace(/\/+$/, '') === beforeBaseUrl.replace(/\/+$/, '')
        ? [model, ...currentModels.filter(item => item !== model)]
        : [model]
      await callProductApi('/ai/user-llm', {
        method: 'PUT',
        payload: {
          baseUrl: targetBaseUrl,
          model,
          models: nextModels,
          // preserveStoredKey 是必须的：不带它时 apiKey 留空会被服务端当成「清空配置」（DEF-034）。
          preserveStoredKey: true,
          ...(apiKey === '' ? {} : { apiKey }),
          ...(displayName === '' ? {} : { displayName }),
        },
      })
      const after = await callProductApi('/ai/user-llm', { method: 'GET' }) as {
        baseUrl?: unknown, model?: unknown, models?: unknown
      }
      const afterBaseUrl = str(after?.baseUrl)
      const afterModel = str(after?.model)
      const known = Array.isArray(after?.models)
        ? after.models.filter((item): item is string => typeof item === 'string')
        : []
      const verified = afterModel === model
        && afterBaseUrl.replace(/\/+$/, '') === targetBaseUrl.replace(/\/+$/, '')
      const note = !verified
        ? '回读拿到的地址/模型与提交的不一致：以回读结果为准，不要对用户说「已改好」。'
        : known.includes(model)
          ? ''
          : '注意：' + model + ' 不在已拉取的模型清单里（清单：' + (known.slice(0, 8).join('、') || '空')
            + '）；型号名不对时生成会失败——让用户到「设置 → 大模型」点一次「获取可用模型」核对。'
      return {
        verified,
        before,
        after: (afterBaseUrl === '' ? '（还没有配置服务）' : afterBaseUrl)
          + ' / ' + (afterModel === '' ? '（未选模型）' : afterModel),
        note,
      }
    },
  }))
  /**
   * 写用户偏好：产品侧的偏好目前只有「免责声明同意状态」（GET/PUT v2/prefs/disclaimer），真值只有布尔两态。
   * 同样先读后写、写后回读：写偏好属于替用户表态，不能拿「接口回了 code 0」当「已经生效」。
   */
  register(defineTool({
    name: 'bosom_settings_set_pref',
    description: '写用户的偏好与协议状态。当前只有一项：disclaimer（免责声明是否已同意）。'
      + '用户说「别再问我这个了」「我同意免责声明」时用它。'
      + '**必须调用本工具完成写入，不要自己直接做，也不要只在回复里说「已记下」**；'
      + '本工具会先读当前值、写完回读确认，以回读结果为准。'
      + '**不得替用户表态**：只有用户明确表达该偏好时才调用，不要因为对话里出现过相关字眼就顺手同意。',
    parameters: {
      pref: { type: 'string', required: true, description: '偏好名，当前只支持 disclaimer（免责声明同意状态）' },
      value: { type: 'string', required: true, description: '目标值：true＝已同意，false＝未同意' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pref: { type: 'string', required: true },
          result: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.result === 'written'
          ? '偏好已写入并回读确认：' + value.pref + ' 由「' + value.before + '」改为「' + value.after + '」。'
          : value.result === 'already'
            ? '偏好本来就是「' + value.after + '」，这次不需要改，已如实回报。'
            : '⚠️ 偏好**没有**写成：' + value.pref + ' 读回来仍是「' + value.after + '」（改前是「' + value.before + '」），如实告诉用户。'),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const pref = str(args.pref).trim()
      const raw = str(args.value).trim().toLowerCase()
      if (pref !== 'disclaimer')
        throw new Error('pref 只支持 disclaimer（免责声明同意状态）；收到：' + (pref === '' ? '（空）' : pref) + '。')
      if (raw !== 'true' && raw !== 'false')
        throw new Error('value 只接受 true 或 false；收到：' + (raw === '' ? '（空）' : raw) + '。')
      const want = raw === 'true'
      const label = (value: boolean): string => (value ? '已同意' : '未同意')
      const current = await callProductApi('/v2/prefs/disclaimer', { method: 'GET' }) as { accepted?: unknown }
      const before = current?.accepted === true
      if (before === want) return { pref, result: 'already', before: label(before), after: label(before) }
      // 2026-10-12 修：这里原来没写 method，callProductApi 默认 POST，而服务端
      // /v2/prefs/disclaimer 只注册了 GET（api.ts:4176）与 PUT（api.ts:4183）——
      // 于是「写偏好」这一步必然 404，工具只能报 mismatch。写操作必须用 PUT。
      await callProductApi('/v2/prefs/disclaimer', { method: 'PUT', payload: { accepted: want } })
      const after = await callProductApi('/v2/prefs/disclaimer', { method: 'GET' }) as { accepted?: unknown }
      const now = after?.accepted === true
      return { pref, result: now === want ? 'written' : 'mismatch', before: label(before), after: label(now) }
    },
  }))
  register(defineTool({
    name: 'bosom_user_update_profile',
    description: '改用户的个人资料（昵称 name 与头像地址 avatar）。用户说「把昵称改成 XX」时用它。'
      + '两个参数至少给一个非空值；**必须调用本工具**完成修改，不要只是嘴上答应。',
    parameters: {
      name: { type: 'string', required: true, description: '新昵称；不改就传空串' },
      avatar: { type: 'string', required: true, description: '新头像地址；不改就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          changed: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '资料已更新（改动：' + value.changed + '）' + (value.name === '' ? '' : '，当前昵称：' + value.name)
          + '；用户在「个人资料」里能看到。',
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const name = str(args.name).trim()
      const avatar = str(args.avatar).trim()
      if (name === '' && avatar === '') throw new Error('name 与 avatar 至少给一个非空值，否则这次改动是空的。')
      const payload: Record<string, string> = {}
      if (name !== '') payload.name = name
      if (avatar !== '') payload.avatar = avatar
      const data = await callProductApi('/user/info/update', { method: 'PUT', payload }) as { name?: unknown }
      const changed = Object.keys(payload).map((k) => (k === 'name' ? '昵称' : '头像')).join('、')
      return { name: str(data?.name ?? name), changed }
    },
  }))
  /**
   * 给一条对话任务打分：读当前分 → 写 → 回读确认。
   *
   * 服务端 POST rating 不校验取值（任意 number 都落库），所以 1~5 的合法区间在本工具这一层守住：
   * 越界的分值写进去，用户看到的是"打过分了"，排名与蒸馏却拿到一个没意义的分。
   */
  register(defineTool({
    name: 'bosom_task_rate',
    description: '给一条对话任务打分（1~5 分，可附一句评语）。用户说「这次办得不错，给 5 分」「这条记 3 分」时用它。'
      + '**必须调用本工具完成打分，不要自己直接做，也不要只在回复里说「已记录」**；'
      + '打分前本工具会先读这条任务现在的分数，写完回读确认，以回读结果为准。'
      + 'taskId 必须是真实任务号：拿不准是哪一条就先问用户，不要凭印象编一个 id。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要打分的那条任务 id' },
      rating: { type: 'string', required: true, description: '分值，1~5 的整数' },
      comment: { type: 'string', description: '评语（为什么给这个分）；不写就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          verified: { type: 'boolean', required: true },
          comment: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.verified
          ? '评分已写入并回读确认：任务 ' + value.taskId + ' 由「' + value.before + '」改为「' + value.after + '」'
            + (value.comment === '' ? '。' : '，评语：' + value.comment)
          : '⚠️ 评分**没有**写进去：任务 ' + value.taskId + ' 读回来仍是「' + value.after + '」，如实告诉用户。'),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      const ratingText = str(args.rating).trim()
      const comment = str(args.comment).trim()
      if (taskId === '') throw new Error('必须给 taskId（要打分的那条任务）；拿不准是哪一条就先问用户。')
      if (!/^[1-5]$/.test(ratingText))
        throw new Error('rating 只能是 1~5 的整数；收到：' + (ratingText === '' ? '（空）' : ratingText) + '。')
      const rating = Number.parseInt(ratingText, 10)
      const path = '/agent/tasks/' + encodeURIComponent(taskId) + '/rating'
      const label = (value: unknown): string => (typeof value === 'number' ? String(value) + ' 分' : '未评分')
      const current = await callProductApi(path, { method: 'GET' }) as { rating?: unknown }
      const before = current?.rating
      await callProductApi(path, { payload: { rating, ...(comment === '' ? {} : { comment }) } })
      const after = await callProductApi(path, { method: 'GET' }) as { rating?: unknown, comment?: unknown }
      return {
        taskId,
        before: label(before),
        after: label(after?.rating),
        verified: after?.rating === rating,
        comment: str(after?.comment),
      }
    },
  }))
  /**
   * 收藏 / 取消收藏一条对话任务：服务端是两个动作（POST 收藏、DELETE 取消），
   * 由本工具的 favorite 参数收成一个入口，避免模型在「取消收藏」时误调 POST。
   */
  register(defineTool({
    name: 'bosom_task_favorite',
    description: '收藏或取消收藏一条对话任务。用户说「把这条收藏起来」「取消收藏」时用它。'
      + '**必须调用本工具完成，不要自己直接做，也不要只说「已收藏」**；'
      + '本工具会先读这条任务当前的收藏状态，写完回读确认，以回读结果为准。'
      + 'taskId 必须是真实任务号；拿不准是哪一条就先问用户，不要凭印象编一个 id。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要收藏/取消收藏的任务 id' },
      favorite: { type: 'string', required: true, description: 'true＝收藏，false＝取消收藏' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          result: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.result === 'written'
          ? '收藏状态已改并回读确认：任务 ' + value.taskId + ' 由「' + value.before + '」改为「' + value.after + '」。'
          : value.result === 'already'
            ? '任务 ' + value.taskId + ' 本来就是「' + value.after + '」，这次不需要改，已如实回报。'
            : '⚠️ 收藏状态**没有**改成：任务 ' + value.taskId + ' 读回来仍是「' + value.after + '」，如实告诉用户。'),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      const raw = str(args.favorite).trim().toLowerCase()
      if (taskId === '') throw new Error('必须给 taskId（要收藏/取消收藏的那条任务）；拿不准是哪一条就先问用户。')
      if (raw !== 'true' && raw !== 'false')
        throw new Error('favorite 只接受 true 或 false；收到：' + (raw === '' ? '（空）' : raw) + '。')
      const want = raw === 'true'
      const label = (value: unknown): string => (value === true ? '已收藏' : '未收藏')
      const path = '/agent/tasks/' + encodeURIComponent(taskId)
      // 读单条任务顺带确认它存在：不存在时服务端回 18100，不会静默成功（否则界面显示已收藏却没落库）。
      const current = await callProductApi(path, { method: 'GET' }) as { favorite?: unknown }
      const before = current?.favorite === true
      if (before === want) return { taskId, result: 'already', before: label(before), after: label(before) }
      await callProductApi(path + '/favorite', want ? { payload: {} } : { method: 'DELETE' })
      const after = await callProductApi(path, { method: 'GET' }) as { favorite?: unknown }
      const now = after?.favorite === true
      return { taskId, result: now === want ? 'written' : 'mismatch', before: label(before), after: label(now) }
    },
  }))
  /**
   * 分享一条对话任务：**对外沟通类动作**（BFS-105：评论、私信、分享都要用户拍板），只接受明确指令。
   *
   * 链接一旦生成就是对外可打开的（拿到链接的人不必登录即可看这条任务的对话），到期前无法作废，
   * 所以调用前必须先把「分享哪一条、有效期多久」复述给用户。生成后再用只读分享接口回读一次：
   * 拿不到这条任务就如实报失败，不发一条打不开的链接（DEF-003 的教训）。
   */
  register(defineTool({
    name: 'bosom_task_share',
    description: '把一条对话任务生成对外只读分享链接。**分享属于对外沟通类动作（BFS-105）：'
      + '只有用户在这一句话里明确要求分享时才调用**，不得自行决定分享哪一条、也不得"顺手"分享。'
      + '链接生成后**到期之前无法撤回**，拿到链接的人不用登录就能看到这条任务的对话——'
      + '所以调用前先把「分享哪一条、有效期多久」复述给用户。'
      + '**必须调用本工具完成分享，不要自己直接做，也不要在调用前说「已经分享好了」**；'
      + '生成后本工具会回读一次链接，确认真能打开才回报成功。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要分享的任务 id（必须是真实任务号）' },
      ttlSeconds: { type: 'string', description: '有效期（秒），范围 60 ~ 2592000（1 分钟 ~ 30 天）；不指定就传空串，按服务端缺省 7 天' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          expiresAt: { type: 'string', required: true },
          verified: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.verified
          ? '分享链接已生成并回读确认可打开：\n' + value.url
            + '\n有效期到 ' + value.expiresAt + '；到期前链接撤不回来，把这句话一并告诉用户。'
          : '⚠️ 链接生成了但**回读打不开**，不要给用户这个地址，如实说明这次分享没成功：\n' + value.url),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      const ttlText = str(args.ttlSeconds).trim()
      if (taskId === '') throw new Error('必须给 taskId（要分享的那条任务）；拿不准是哪一条就先问用户。')
      let ttlSeconds: number | undefined
      if (ttlText !== '') {
        const parsed = Number.parseInt(ttlText, 10)
        // 服务端对越界/非数字的有效期**静默按 7 天处理**（resolveShareTtlSeconds）：不在这里拦住，
        // 用户以为设了 1 小时、实际拿到 7 天的链接，而且他没法从结果里看出来。
        if (!/^\d+$/.test(ttlText) || !Number.isFinite(parsed) || parsed < 60 || parsed > 2592000)
          throw new Error('ttlSeconds 只能是 60 ~ 2592000 之间的整数秒（1 分钟 ~ 30 天）；收到：' + ttlText
            + '。服务端对越界值会静默按 7 天处理，所以这里直接拒绝。')
        ttlSeconds = parsed
      }
      const path = '/agent/tasks/' + encodeURIComponent(taskId)
      const created = await callProductApi(path + '/share', {
        payload: ttlSeconds === undefined ? {} : { ttlSeconds },
      }) as { token?: unknown, expiresAt?: unknown, urlPath?: unknown }
      const token = str(created?.token)
      if (token === '') throw new Error('分享接口没有回传 token，这次分享不算成功；如实告诉用户。')
      const shared = await callProductApi('/agent/tasks/shared/' + encodeURIComponent(token), { method: 'GET' }) as { id?: unknown }
      const verified = str(shared?.id) === taskId
      const port = process.env.BOSOM_SERVER_PORT ?? '31280'
      const urlPath = str(created?.urlPath)
      return {
        taskId,
        url: 'http://127.0.0.1:' + port + '/bosom-friend/'
          + (urlPath === '' ? '#/chat?token=' + token : urlPath),
        expiresAt: str(created?.expiresAt),
        verified,
      }
    },
  }))
  /**
   * 建任务：把用户那一句「帮我做这件事」变成一条**真的在办**的任务。
   *
   * 为什么走 SSE 通道而不是那条普通 JSON 分支：`POST agent/tasks` 在**不带**
   * `accept: text/event-stream` 时只落一条任务记录就返回 id（server/src/api.ts:2627-2631），
   * 一个字都不交给模型——用户会拿到一条永远停在「运行中」、没有任何进展的任务。
   * 带上这个头，服务端才真的把这一轮交给管家执行（见 {@link startTaskTurn}）。
   */
  register(defineTool({
    name: 'bosom_task_create',
    description: '替用户开一条新任务：把「帮我做这件事」变成一条真的在办的任务（管家在后台执行，用户到「我的任务」看进度与结果）。'
      + '**必须调用本工具完成任务创建，不要自己直接做，也不要在调用前说「已经开始了」**。'
      + '本工具只把任务交出去、不等它做完（一轮对话可能几分钟），所以不要替这条任务复述最终结果。'
      + 'prompt 尽量保留用户原话里的细节（做什么、对哪个平台或账号、标题与话题、什么时候要），别压成一句概括。',
    parameters: {
      prompt: { type: 'string', required: true, description: '要办的事：做什么、对哪个平台或账号、有哪些硬要求；尽量用用户原话' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          nextStep: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已开好一条任务并交给管家后台执行：' + value.taskId + '\n要办的事：' + value.prompt + '\n' + value.nextStep,
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const prompt = str(args.prompt).trim()
      if (prompt === '')
        throw new Error('必须给 prompt（要办的那件事）；用户这一句里没说清要做什么就先问清楚，不要建一条空任务。')
      const started = await startTaskTurn({ prompt })
      return {
        taskId: started.taskId,
        prompt,
        nextStep: '本工具不等它做完：用户问进度就到「我的任务」看这一条；要补话用 bosom_task_follow_up（带同一个 taskId），要停下用 bosom_task_abort。',
      }
    },
  }))
  /**
   * 追问：在**同一条任务**里接着说，而不是另起一条。
   *
   * 为什么不能照搬「POST agent/tasks/:taskId/messages」：那条路由写的是**快照消息**
   * （type=result，用于 AI 操作截图，见 api.ts:3332-3367），它不会把话交给模型、也不产生回答。
   * 真正的追问通道与建任务同一条：`POST agent/tasks` + `taskId`（api.ts:2597，命中的是续轮而非新建）。
   *
   * 为什么先读一次任务：服务端对**不存在的 taskId 会静默新建一条任务**（api.ts:2597-2598 的
   * `existing ?? 新建`）。不先拦，用户说「接着上一条说」就会凭空多出一条不相干的新对话，
   * 管家还会以为自己续上了上下文。
   */
  register(defineTool({
    name: 'bosom_task_follow_up',
    description: '在**同一条任务**里补一句，接着上文继续（不另起一条任务）。用户说「不对，我要的是…」「改成…」「再补一句」时用它。'
      + '**必须调用本工具完成追问，不要自己直接做，也不要新建一条任务来代替**——换了任务号就是换了会话，管家会失忆。'
      + 'taskId 只能是真实任务号：不确定用户指的是哪一条就先问，不要凭印象编一个。'
      + '本工具先确认这条任务真的存在，再把这一句交给它。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要接着说的那条任务 id（真实任务号）' },
      content: { type: 'string', required: true, description: '用户这一轮补的话；尽量用原话，不要替他概括' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          content: { type: 'string', required: true },
          nextStep: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已在同一条任务里接着说：' + value.taskId + '\n这一轮补的话：' + value.content + '\n' + value.nextStep,
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      const content = str(args.content).trim()
      if (taskId === '')
        throw new Error('必须给 taskId（要接着说下去的那条任务）；不确定是哪一条就先问用户，不要另建一条任务。')
      if (content === '')
        throw new Error('必须给 content（用户这一轮要补的话）；没有内容就不要发起追问。')
      const path = '/agent/tasks/' + encodeURIComponent(taskId)
      let found: { id?: unknown }
      try {
        found = await callProductApi(path, { method: 'GET' }) as { id?: unknown }
      } catch (exc) {
        throw new Error('读不到这条任务（' + taskId + '）：' + String(exc)
          + '。服务端对不存在的任务号会静默新建一条任务，所以这里直接拒绝——先跟用户确认是哪一条，不要另建一条顶替。')
      }
      if (str(found?.id) !== taskId)
        throw new Error('读回来的不是这条任务（要 ' + taskId + '，回来 ' + str(found?.id) + '）：不拿它当追问对象，先跟用户确认。')
      const started = await startTaskTurn({ prompt: content, taskId })
      return {
        taskId: started.taskId,
        content,
        nextStep: '本工具不等它答完：用户问结果就到「我的任务」看这条对话，或等这一轮自己写完。',
      }
    },
  }))
  /**
   * 取消：中断一条正在办的任务。**拍板类动作**（BFS-105：发布/删除/花钱/对外沟通四类要用户点头，
   * 取消任务接近「删除」）——只接受用户的明确取消指令，不得因为"等太久""看着没进展"自行停下。
   *
   * 服务端对不存在的任务回 18100（api.ts:3469），所以这里的失败是真实失败，不会静默成功。
   * 停止后回读一次 task.status：`interrupted` 只说"有没有落到正在生成的那一次"，
   * 记录终态以回读为准（正在收尾时可能还停在 running，几秒后才落成 aborted）。
   */
  register(defineTool({
    name: 'bosom_task_abort',
    description: '停掉一条正在办的任务（中断这一次生成，任务记录按「已中断」落库；**不删除任务记录**）。'
      + '这属于拍板类动作：**只在用户这一句话里明确说了「停下 / 别做了 / 取消这条」时才调用**，'
      + '不得因为等待久、看起来没进展、或你自己判断"没必要了"就自行停下，也不得顺手停掉别的任务。'
      + '不确定用户要停哪一条就先问。**必须调用本工具完成停止，不要自己直接做，也不要只说「已停止」**；'
      + '停完本工具会回读这条任务的状态，以回读结果为准。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要停下的任务 id（真实任务号）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          interrupted: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.interrupted === 'true'
          ? '已中断：任务 ' + value.taskId + ' 正在跑的那一次生成已经停下，任务按「已中断」落库（回读状态：' + value.status + '）。'
          : '任务 ' + value.taskId + ' 当前没有正在跑的生成（回读状态：' + value.status + '）：'
            + '如果它本来停在「运行中」，服务端已把它落成「已中断」；如果它已经办完，这次停止没有改动任何东西。如实告诉用户停在了哪一态。'),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      if (taskId === '')
        throw new Error('必须给 taskId（要停下的那条任务）；用户没说清停哪一条就先问，不要猜着停。')
      if (/[\s/?#]/.test(taskId))
        throw new Error('taskId 不能带空格、斜杠或问号（收到：' + taskId + '）；请用任务号本身（形如 task-xxxxxxxx）。')
      const path = '/agent/tasks/' + encodeURIComponent(taskId)
      const result = await callProductApi(path + '/abort', { payload: {} }) as { interrupted?: unknown }
      const interrupted = result?.interrupted === true
      const after = await callProductApi(path, { method: 'GET' }) as { status?: unknown }
      const status = str(after?.status)
      return {
        taskId,
        interrupted: interrupted ? 'true' : 'false',
        status: status === '' ? 'unknown' : status,
      }
    },
  }))

  /** 转交目标管家的中文说法（工具输出是给模型念给用户听的，用中文名而不是代号）。 */
  const DISPATCH_ROLE_LABELS: Record<string, string> = {
    creator: '创作管家',
    publisher: '发布管家',
    operator: '运营管家',
    device: '设备管家',
  }
  /**
   * 转交：把一条任务**改判给专业管家**，并让它在同一条任务里接着办这件事。
   *
   * 为什么必须有（BFS-105 / 2026-10-12）：工具面即权限边界——专业管家的面才带该职责的完整上下文，
   * 而总管的面是全量；「某个管家缺某能力时的正确做法是**转交**给持该能力的管家，不是放宽它的工具面」
   * （服务端取内核会话处的同一条纪律）。在此之前 51 个工具里没有任何一个能改判归属，
   * 所以「总管拆解 → 分派给专业管家」这条链是断的。
   *
   * 为什么先 GET 一次任务：服务端对不存在的 taskId 会静默新建一条任务
   * （POST agent/tasks 的 `existing ?? 新建`），不先拦就会把转交落到一条凭空出现的任务上
   * ——与 bosom_task_follow_up 同一道防线。
   *
   * 为什么改判之后还要再发起一轮：改判只影响**下一次**请求用哪个管家（服务端取会话时读
   * task.agentRole）；不接着发起，用户看到的就是「说转交了，但没人干活」。startTaskTurn 与追问
   * 走同一条通道（带 accept: text/event-stream，服务端开流即算开跑，拿到首帧就断开），
   * 不把这一轮卡在这里。
   */
  register(defineTool({
    name: 'bosom_steward_dispatch',
    description: '**把一件事转交给专业管家去办**：改判这条任务的归属管家，并把要办的事交给它接着做。'
      + '当用户的请求属于某个专业管家的职责时，**必须调用本工具转交，不要自己硬做**——'
      + '你是总管，负责拆解与分派：creator 管内容创作、publisher 管发布、operator 管运营数据与接待、device 管设置与账号登录。'
      + 'taskId 是**当前这条对话的任务号**：不确定就先问用户，不要猜一个，也不要新建一条任务顶替——'
      + '换了任务号就是换了会话，管家会失忆。',
    parameters: {
      role: { type: 'string', required: true, description: '转交给谁：creator（创作）/ publisher（发布）/ operator（运营）/ device（设备与账号）' },
      prompt: { type: 'string', required: true, description: '要那个管家办的事；用用户的原话，不要替他概括' },
      taskId: { type: 'string', required: true, description: '要转交的那条任务号（形如 task-xxxxxxxx）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          previousRole: { type: 'string', required: true },
          started: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已把任务 ' + value.taskId + ' 转交给' + (DISPATCH_ROLE_LABELS[value.role] ?? value.role)
          + (value.previousRole === '' ? '' : '（原归属：' + value.previousRole + '）')
          + '，它已经在同一条任务里接着办。\n这一轮不等它做完：用户问进度就到「我的任务」看这条对话。',
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const role = str(args.role).trim()
      const prompt = str(args.prompt).trim()
      const taskId = str(args.taskId).trim()
      if (!(role in DISPATCH_ROLE_LABELS))
        throw new Error('role 只支持 creator / publisher / operator / device（收到：' + (role === '' ? '空' : role)
          + '）；转交是交给专业管家，总管自己的面本来就是全量。')
      if (prompt === '')
        throw new Error('必须给 prompt（要那个管家办的事）；还没想清要办什么就先问用户，不要把空话转交出去。')
      if (taskId === '')
        throw new Error('必须给 taskId（当前这条对话的任务号）；不确定就先问用户，不要猜一个、也不要新建一条任务顶替。')
      if (/[\s/?#]/.test(taskId))
        throw new Error('taskId 不能带空格、斜杠或问号（收到：' + taskId + '）；请用任务号本身（形如 task-xxxxxxxx）。')
      const path = '/agent/tasks/' + encodeURIComponent(taskId)
      // 先确认这条任务真的存在：服务端对不存在的 taskId 会静默新建一条任务。
      let found: { id?: unknown }
      try {
        found = await callProductApi(path, { method: 'GET' }) as { id?: unknown }
      } catch (exc) {
        throw new Error('读不到这条任务（' + taskId + '）：' + String(exc)
          + '。先跟用户确认是哪一条，不要另建一条顶替。')
      }
      if (str(found?.id) !== taskId)
        throw new Error('读回来的不是这条任务（要 ' + taskId + '，回来 ' + str(found?.id) + '）：不拿它当转交对象，先跟用户确认。')
      const moved = await callProductApi(path + '/dispatch', { payload: { role } }) as { agentRole?: unknown, previousRole?: unknown }
      const applied = str(moved?.agentRole)
      if (applied !== role)
        throw new Error('服务端没有把归属改成 ' + role + '（回读：' + (applied === '' ? '空' : applied) + '）；这次转交不算成功，如实告诉用户。')
      // 改判只作用在**下一次**请求上：不接着发起一轮，用户看到的就是"说转交了，但没人干活"。
      const started = await startTaskTurn({ prompt, taskId })
      return {
        taskId: started.taskId,
        role,
        previousRole: str(moved?.previousRole),
        started: 'true',
      }
    },
  }))
  register(defineTool({
    name: 'bosom_publish_list_records',
    description: '查发布记录：某条内容到底发出去了没、发到哪个账号、平台作品 ID 是多少、什么时间发的。'
      + '用户问「我发出去了吗」「这周发了什么」「发布成功没」时**必须**用它，不要凭印象回答。'
      + '**发布状态以这里的记录为准**：记录里的作品 ID 才是平台回执，没有它就不算发布成功。' + '【什么时候必须用我】用户问「这条发出去了没 / 平台作品 ID / 什么时候发的」时用它。【什么时候不要用我】要「现在去平台拉最新数据」不要用它，换 bosom_platform_sync_now。',
    parameters: {
      accountId: { type: 'string', description: '只看某个账号；不筛就传空串' },
      platform: { type: 'string', description: '只看某个平台（如 douyin、xhs）；不筛就传空串' },
      limit: { type: 'string', description: '最多返回几条，默认 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'string', required: true },
          list: { type: 'string', required: true },
          hint: { type: 'string', required: true },
          spread: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.count === '0' ? '没有匹配的发布记录：' + value.hint : '发布记录共 ' + value.count + ' 条（最新在前）：\n' + value.list)
          + '\n平台分布：' + value.spread,
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const accountId = str(args.accountId).trim()
      const platform = str(args.platform).trim()
      const wantLimit = Number.parseInt(str(args.limit).trim() || '10', 10)
      const limit = Number.isFinite(wantLimit) ? Math.min(50, Math.max(1, wantLimit)) : 10
      const query: string[] = []
      if (accountId !== '') query.push('accountId=' + encodeURIComponent(accountId))
      if (platform !== '') query.push('accountType=' + encodeURIComponent(platform))
      const data = await callProductApi('/v2/channels/publish/records' + (query.length === 0 ? '' : '?' + query.join('&')), { method: 'GET' }) as { list?: unknown, records?: unknown }
      // 字段名以服务端实际返回为准：这条路由回的是 data.records（不是 list）。
      // 2026-10-11 实测踩过：只读 list 会把一条「已发布成功」的记录报成「0 条」——
      // 差一步就把真实发布成功误判成失败（三方交叉核对才发现）。
      const raw = Array.isArray(data?.records) ? data.records : (Array.isArray(data?.list) ? data.list : [])
      const rows = raw.slice(0, limit).map((item) => {
        const row = item as Record<string, unknown>
        // 标题里可能是整段正文（含换行）：不压成单行，一条记录就会占多行，
        // 「｜平台 x｜状态…」被挤到中间行——模型与按行读的门禁都会数错平台分布
        // （2026-10-12 门禁 case 8 实测：工具行里只解析出 xhs:1+douyin:2，落库是 xhs:1+douyin:5）。
        const title = (str(row.title) !== '' ? str(row.title) : (str(row.desc).slice(0, 24) || '（无标题）')).replace(/\s*[\r\n]+\s*/g, ' ')
        const work = str(row.workId) !== '' ? str(row.workId) : (str(row.platformWorkId) !== '' ? str(row.platformWorkId) : '')
        // 状态数值即对外协议（types.ts 的 PUBLISH_RECORD_STATUS），这里翻成人话给模型与用户看。
        const statusMap: Record<string, string> = {
          '-1': '发布失败', '0': '待发布', '1': '已发布成功', '2': '发布中',
          '6': '排队中', '7': '已排期', '9': '已取消',
        }
        const status = row.status === undefined ? '?' : (statusMap[String(row.status)] ?? String(row.status))
        // 失败原因必须带给模型：不给它就会自己编一个（2026-10-11 实测：真实原因是「标题 21 字超过抖音上限 20 字」，
        // 模型却对用户说成「封面生成超时」——编造因果与假成功同族，都是拿推测当事实）。
        const errMsg = str(row.errorMsg)
        return '· ' + title
          + '｜平台 ' + (str(row.accountType) || '?')
          + '｜状态 ' + status
          + '｜发布 ' + (str(row.publishTime) || '?')
          + '｜作品ID ' + (work === '' ? '（还没有平台回执）' : work)
          + (errMsg === '' ? '' : '｜失败原因（引擎原文，已去噪）：' + cleanEngineError(errMsg))
      })
      const hint = '可能这些内容还没发过，或发布流程还没跑到回填那一步（记录里没有平台作品 ID 时，就是对用户说「还没确认发出去」的时刻）。'
      // 平台分布**由工具自己算**并结构化输出：模型与门禁都不该去解析上面那段人类可读的行。
      // 2026-10-12 门禁 case 8 实测：模型按平台分两次问（platform=douyin、platform=xhs）时，
      // 按行统计只能看到最后一次的结果，于是把 6 条误判成 1 条——工具给结构化字段、下游累加，
      // 两种问法（一次全量 / 分平台多次）都能得到同一个全量分布。
      const spreadCounts: Record<string, number> = {}
      for (const item of raw) {
        const key = str((item as Record<string, unknown>).accountType) || '?'
        spreadCounts[key] = (spreadCounts[key] ?? 0) + 1
      }
      const spread = Object.keys(spreadCounts).length === 0
        ? '（无）'
        : Object.keys(spreadCounts).sort().map(key => key + ' ' + String(spreadCounts[key])).join(' / ')
      return { count: String(raw.length), list: rows.join('\n'), hint, spread }
    },
  }))
  register(defineTool({
    name: 'bosom_long_video_list',
    description: '列出长视频任务与各自进度（哪条在跑、跑到第几镜、哪条失败、哪条已完成）。'
      + '用户问「我的片子跑到哪了」「还有几条在生成」时**必须**用它。'
      + '拿到 taskId 后可用 bosom_content_video_status 看细节、bosom_content_resume_video 续跑、bosom_long_video_stop 停止。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'string', required: true },
          list: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === '0' ? '没有任何长视频任务。' : '长视频任务共 ' + value.count + ' 条（最新在前）：\n' + value.list,
      }],
    },
    timeoutMs: 30000,
    execute: async () => {
      const data = await callProductApi('/long-videos', { method: 'GET' }) as { list?: unknown }
      const raw = Array.isArray(data?.list) ? data.list : []
      const rows = raw.slice(0, 12).map((item) => {
        const row = item as Record<string, unknown>
        const shots = Array.isArray(row.shots) ? row.shots : []
        const done = shots.filter((s) => str((s as Record<string, unknown>).status) === 'accepted').length
        return '· ' + str(row.id)
          + '｜' + (str(row.status) || '?')
          + '｜' + String(done) + '/' + String(shots.length) + ' 镜已成'
          + '｜目标 ' + (row.targetSeconds === undefined ? '?' : String(row.targetSeconds)) + ' 秒'
          + '｜建于 ' + (str(row.createdAt).slice(0, 16) || '?')
          + (str(row.errorMessage) === '' ? '' : '｜错误：' + str(row.errorMessage).slice(0, 40))
      })
      return { count: String(raw.length), list: rows.join('\n') }
    },
  }))
  /**
   * 改一条**已排期**发布任务的时间（「把那条改到后天早上 9 点发」）。
   *
   * 与 bosom_publish_draft 的分工：那条是「新发布时直接带排期」，这条是「改已经排在队里的那一条」。
   * 用户改了时间却照旧发出去，是最伤信任的一类失败——服务端已经为此重装定时器
   * （routes-channels.ts:765-767 的注释写明：原来那个还按旧时刻在跑，改了时间等于没改），
   * 本工具要做的是**在那之前把入参挡住**：空 id、空时刻、非法时刻、以及**已经过去的时刻**。
   *
   * 为什么拒绝过去的时刻：把任务改到一个已经过去的时间，等于让它在下一轮巡检里立刻发出去——
   * 用户说「改到昨天」几乎一定是口误或算错；宁可让他确认一次，也不要替他发出去。
   *
   * 写完回读一次：**改期成功与否以盘上的 publishTime 为准**，不看接口返回。
   */
  register(defineTool({
    name: 'bosom_publish_reschedule',
    description: '改一条**已排期**发布任务的时间（「把那条改到后天早上 9 点发」）。**必须调用本工具，不要自己直接做**。'
      + '**只有用户明确要求改期时才能调用**：这是改一次真实发布的时间，改错了就是在那个人不该出现的时间发出去。'
      + 'taskId 先用 bosom_publish_list_records 查出来，不要凭印象编。'
      + 'publishAt 用 ISO 8601（如 2026-10-15T01:00:00.000Z），**必须是把用户的说法换算成的那一刻**；'
      + '用户只说「后天」没说几点时先问清几点，别替他挑。'
      + '**不接受已经过去的时刻**：那等于让它立刻发出去。'
      + '改完要如实告诉用户新时刻；若用户说的是本地时间，回话时也按本地时间说。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要改期的发布任务号（先用 bosom_publish_list_records 查）' },
      publishAt: { type: 'string', required: true, description: '新的发布时间，ISO 8601 带时区；必须是将来的时刻' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          publishAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已把发布任务 ' + value.taskId + ' 改期到 ' + value.publishAt + '（已回读确认）。'
          + '到点由服务端自动发布；要再改时间就再说一句，要取消请到「发布」页删掉这条任务。',
      }],
    },
    timeoutMs: 10000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      const publishAt = str(args.publishAt).trim()
      if (taskId === '')
        throw new Error('必须给 taskId（要改期的那条发布任务）；先用 bosom_publish_list_records 查一条出来。')
      if (publishAt === '')
        throw new Error('必须给 publishAt（新的发布时间，ISO 8601 带时区）；用户只说「后天」时先问清几点。')
      const when = Date.parse(publishAt)
      if (Number.isNaN(when))
        throw new Error('publishAt 不是可解析的时间：' + publishAt + '；请用 ISO 8601（例 2026-10-15T01:00:00.000Z）。')
      if (when <= Date.now())
        throw new Error('publishAt 已经是过去时刻（' + publishAt + '）；改到过去等于让它立刻发出去，请与用户确认一个将来的时间。')
      await callProductApi('/v2/channels/publish/tasks/' + encodeURIComponent(taskId) + '/publish-at', {
        method: 'PATCH',
        payload: { publishAt },
      })
      // 回读确认：改期成功与否只看盘上的 publishTime 是否变成新值。
      const records = store.files.records.load()
      const rec = records.find(r => str(r.id) === taskId || str(r.taskId) === taskId)
      if (rec === undefined)
        throw new Error('改期请求已发出，但在发布记录里找不到任务 ' + taskId + '；请让用户到「发布」页确认这条任务还在不在。')
      const onDisk = str(rec.publishTime)
      if (onDisk !== publishAt)
        throw new Error('改期未生效：盘上仍是 ' + (onDisk === '' ? '(空)' : onDisk) + '，而不是 ' + publishAt + '；请重试一次再如实告诉用户。')
      return { taskId, publishAt: onDisk }
    },
  }))
  register(defineTool({
    name: 'bosom_publish_draft',
    description: '把草稿箱里的一条草稿发到指定平台账号（图文笔记走这条）：既能**立即发**，也能**排到未来某个时间发**。'
      + '**只有用户在这一句话里明确要求发布时才能调用**：「写一条」「生成一条」都不构成发布指令。'
      + '用户带时间说这件事（「明天早上 9 点发」「今晚 8 点定时发」）要的就是**排期**：把那个时刻填进 publishAt，'
      + '**不要**改成立即发布——用户要的是那个点发出去，提前发和漏发一样违背指令。'
      + '只说了日子没说时刻（「明天发」）时先问清几点，别替他挑一个时间。'
      + '排期是一次**预定的真实发布**：到点由服务端自动拉起平台引擎，不会再回来问一遍，所以它和立即发布一样需要用户的明确指令。'
      + '草稿的封面会作为图文的第一张图提交；草稿既没有图也没有封面时**如实报错**，不要凭空造图、也不要声称已发布。'
      + '调用是异步的：成功只代表**已排上（排期）或已提交给平台引擎（立即发）**，作品 ID 要等引擎回读后写进发布记录（用 bosom_publish_list_records 查）。',
    parameters: {
      draftId: { type: 'string', required: true, description: '要发布的草稿 id（先用 bosom_content_list_drafts 查出来）' },
      accountId: { type: 'string', required: true, description: '发布账号 id（先用 bosom_platform_list_accounts 查出来）' },
      platform: { type: 'string', required: true, description: '平台标识，如 douyin、xhs' },
      publishAt: { type: 'string', description: '排期时刻（ISO 8601 字符串，**按本机时区**写，如 2026-10-13T09:00:00+08:00）；必须是**未来**时间，传过去的时间会被拒；立即发布就传空串' },
      title: { type: 'string', description: '发布时覆盖草稿标题（平台字数上限比草稿严时用）；不改就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          mediaCount: { type: 'string', required: true },
          state: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '发布已提交（发布记录 id ' + value.recordId + '，状态：已提交给平台引擎）\n'
          + '标题：' + value.title + '\n图片：' + value.mediaCount + ' 张\n'
          + '**此刻还没有平台回执**：引擎正在真实操作平台，等发布记录里出现平台作品 ID 才能对用户说「已发出」。'
          + '用 bosom_publish_list_records 查结果。',
      }],
    },
    timeoutMs: 60000,
    execute: async (args) => {
      const draftId = str(args.draftId).trim()
      const accountId = str(args.accountId).trim()
      const platform = str(args.platform).trim()
      const publishAt = str(args.publishAt).trim()
      // 排期必须是未来时间。2026-10-11 实测：模型把「明天早上 9 点」算成了 2026-06-05 09:00（过去），
      // 而服务端对过去时间取 delay = Math.max(0, …) = 0 → **立刻真实发布**：用户以为「明天发」，当场就发了（DEF-257）。
      // 这里在提交前拦住，并把**当前时间**回给模型——它算错日期的根因是没有可靠的时间基准。
      if (publishAt !== '') {
        const whenMs = Date.parse(publishAt)
        if (!Number.isFinite(whenMs)) {
          throw new Error('publishAt 不是合法时间：要 ISO 字符串（形如 2026-10-12T01:00:00.000Z）。')
        }
        const nowMs = Date.now()
        if (whenMs <= nowMs + 60_000) {
          throw new Error('publishAt 解析为 ' + new Date(whenMs).toISOString() + '，已经过去或就在一分钟内。'
            + '当前时间是 ' + new Date(nowMs).toISOString()
            + '（本地 ' + new Date(nowMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '）。'
            + '排期必须是**未来时间**：请按当前时间重新换算（「明天早 9 点」= 明天的日期 + 09:00 再转 ISO）；'
            + '如果要**立刻**发布，就明确把 publishAt 传空串，不要传一个过去的时间。')
        }
      }
      if (draftId === '') throw new Error('必须给 draftId；先用 bosom_content_list_drafts 查一条草稿出来。')
      if (accountId === '') throw new Error('必须给 accountId；先用 bosom_platform_list_accounts 查一个账号出来。')
      if (platform === '') throw new Error('必须给 platform（如 douyin）。')
      const draft = await callProductApi('/contents/' + encodeURIComponent(draftId), { method: 'GET' }) as Record<string, unknown> | null
      if (draft === null || typeof draft !== 'object') throw new Error('找不到草稿 ' + draftId + '；它可能已被删除。')
      const titleOverride = str(args.title).trim()
      const title = titleOverride !== '' ? titleOverride : str(draft.title).trim()
      const body = str(draft.desc).trim()
      if (title === '') throw new Error('这条草稿没有标题：抖音等平台必须有标题才能发布，先让用户补一个（或用 bosom_content_update_draft 补）。')
      // 平台标题上限：抖音 ≤20 字。来源是**引擎的真实拒绝**（2026-10-11 pub-xdo2q1qx：
      // 「标题不能超过20字符，当前 21字符」），不是编造——产品侧草稿上限是 30 字，两者口径不同。
      // 不在提交前拦住，用户就要等引擎跑完才知道失败，还得重来一遍。
      // 只登记有实测依据的平台；其余平台的上限**不报**（依 platform-catalog 的「无源不报」原则）。
      const titleLimits: Record<string, number> = { douyin: 20 }
      const titleLimit = titleLimits[platform]
      if (titleLimit !== undefined && title.length > titleLimit) {
        throw new Error('标题 ' + String(title.length) + ' 字，超过 ' + platform + ' 的上限 ' + String(titleLimit)
          + ' 字（引擎实测口径）：把标题压到 ' + String(titleLimit) + ' 字以内，用 title 参数重新提交这次发布——草稿本身不用改。')
      }
      const topicsRaw = Array.isArray(draft.topics) ? draft.topics : []
      const topics = topicsRaw.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.replace(/^#+/, '').trim())
      const mediaRaw = Array.isArray(draft.mediaList) ? draft.mediaList : []
      const media = mediaRaw
        .map((m) => str((m as Record<string, unknown>).url))
        .filter((u) => u !== '')
        .map((u) => ({ url: u }))
      const coverUrl = str(draft.coverUrl)
      if (media.length === 0 && coverUrl !== '') media.push({ url: coverUrl })
      if (media.length === 0) {
        throw new Error('这条草稿没有可发布的图片（mediaList 为空、也没有封面）：抖音图文必须有图。'
          + '先用 bosom_content_make_cover 给它生成封面，或让用户补图后再发布——**不要**声称已发布。')
      }
      const payload: Record<string, unknown> = {
        content: {
          title,
          body,
          topics,
          media,
          ...(coverUrl === '' ? {} : { cover: { url: coverUrl } }),
        },
        context: { type: 'ImageText', materialId: draftId },
        items: [{ accountId, platform }],
        ...(publishAt === '' ? {} : { publishAt }),
      }
      const flow = await callProductApi('/v2/channels/publish/flows', { payload }) as { tasks?: unknown }
      const tasks = Array.isArray(flow?.tasks) ? flow.tasks : []
      const first = (tasks[0] ?? {}) as { id?: unknown }
      const recordId = str(first.id)
      if (recordId === '') throw new Error('发布流没有回传记录 id，这次提交不算成功；如实告诉用户。')
      return { recordId, title, mediaCount: String(media.length), state: 'submitted' }
    },
  }))
  register(defineTool({
    name: 'bosom_reception_reply',
    description: '回复平台上的评论或私信（真实浏览器操作，通常几十秒到几分钟）。'
      + '**只有用户在这一句话里明确要求回复时才能调用**——对外沟通属拍板类动作，猜错就是以用户的名义发出去。'
      + '定位字段（platform / accountId / kind / workId / commentText / username / sessionId / peerName）'
      + '**必须从 bosom_reception_list_pending 的结果里原样取**，不要自己编：平台按这些字段在页面上找目标，编出来的值白跑一趟。'
      + '提交成功只代表**已交给平台引擎**，回复到底发出去没有要等任务状态回写——不要对用户说「已回复」。',
    parameters: {
      platform: { type: 'string', required: true, description: '平台标识，如 douyin、xhs' },
      accountId: { type: 'string', required: true, description: '账号 id' },
      kind: { type: 'string', required: true, description: 'comment（评论回复）或 dm（私信回复）' },
      replyText: { type: 'string', required: true, description: '要回复的正文' },
      workId: { type: 'string', description: '作品 id（评论回复需要）；没有就传空串' },
      commentText: { type: 'string', description: '被回复的评论原文，定位用；没有就传空串' },
      username: { type: 'string', description: '评论者用户名，定位用；没有就传空串' },
      sessionId: { type: 'string', description: '私信会话 id（私信回复需要）；没有就传空串' },
      peerName: { type: 'string', description: '私信对方昵称，定位用；没有就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          kind: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '回复已提交给平台引擎（任务 ' + value.taskId + '，类型 ' + value.kind + '）。'
          + '**此刻还没有发出**：引擎正在真实操作平台，结果会回写到接待记录里；'
          + '可用 bosom_reception_list_pending 或页面上的接待列表回看。不要对用户说「已回复」。',
      }],
    },
    timeoutMs: 60000,
    execute: async (args) => {
      const platform = str(args.platform).trim()
      const accountId = str(args.accountId).trim()
      const kind = str(args.kind).trim() === 'dm' ? 'dm' : 'comment'
      const replyText = str(args.replyText).trim()
      if (platform === '') throw new Error('必须给 platform；从 bosom_reception_list_pending 的结果里取。')
      if (accountId === '') throw new Error('必须给 accountId；从 bosom_reception_list_pending 的结果里取。')
      if (replyText === '') throw new Error('回复正文不能为空。')
      const payload: Record<string, string> = { platform, accountId, kind, replyText }
      const optionalKeys: string[] = ['workId', 'commentText', 'username', 'sessionId', 'peerName']
      for (const key of optionalKeys) {
        const value = str((args as Record<string, unknown>)[key]).trim()
        if (value !== '') payload[key] = value
      }
      const data = await callProductApi('/v2/customer-reception/interactions/reply', { payload }) as { taskId?: unknown }
      const taskId = str(data?.taskId ?? '')
      if (taskId === '') throw new Error('服务端没有回传任务号，这次回复不算提交成功；如实告诉用户。')
      return { taskId, kind }
    },
  }))
  register(defineTool({
    name: 'bosom_reception_poll_now',
    description: '立刻去平台拉取一次最新的评论与私信（真实浏览器操作，通常几十秒到几分钟）。'
      + '用户问「有没有新评论」「去看看最新消息」「刷新一下互动」时用它；'
      + '拉完之后用 bosom_reception_list_pending 看待接待列表。'
      + '引擎同一时刻只跑一轮：正在跑的时候这次调用**不会**启动新一轮（triggered=false），如实说明即可，'
      + '不要对用户说「已经拉到新内容了」。',
    parameters: {
      order: { type: 'string', description: '用户要求拉取的原话（例如「去看看最新评论」）。缺了会被本地拒绝、不出站。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          triggered: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.triggered === '1'
          ? '已启动一轮平台互动拉取；等几十秒后再用 bosom_reception_list_pending 看结果（此刻还没有新内容）。'
          : '这一轮拉取还在跑（引擎同时只跑一轮），**这次没有启动新的一轮**：稍后再问一次即可。',
      }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      // 2026-10-13（P1 手写边界收严）：真去平台拉取 = 对外动作；没有用户明确指令就本地拒绝、零出站。
      if (str(args.order).trim() === '') {
        throw new Error('这条属于「对外通道」，要用户点头才能做：它会真去平台拉一次评论与私信。'
          + '你这次没有把用户的明确指令带进来——调用时 body 里要带 order 字段，写用户这一句话里的原话（例如「去看看最新评论」）。'
          + '**没有 order 就不出站、不碰平台**。把三个选择原样给用户：① 明确说一句要拉 ② 改条件再说 ③ 这次不拉。')
      }
      const data = await callProductApi('/v2/customer-reception/poll-now', { payload: {} }) as { triggered?: unknown }
      return { triggered: data?.triggered === true ? '1' : '0' }
    },
  }))
  register(defineTool({
    name: 'bosom_data_works',
    description: '看作品数据表现：已发布作品数、各平台贡献、每条作品的播放/点赞/评论与作品链接，'
      + '以及**平台到底有没有把数据给过来**。用户问「我的作品表现怎么样」「哪条数据好」「涨了多少」时用它。'
      + '**关键口径**：标注「无信号」的指标表示**平台还没给到这项数据**，它不等于 0——'
      + '要如实告诉用户「平台还没采到」，**不要拿 0 当成真实播放量报**（0 次播放与「没采到」是两件不同的事）。'
      + '要主动去平台拉最新数据时，先用 bosom_platform_sync_works，再回来查。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          published: { type: 'string', required: true },
          availability: { type: 'string', required: true },
          works: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已发布作品：' + value.published + ' 条\n'
          + '数据可用性：' + value.availability + '\n'
          + '数据更新时间：' + value.updatedAt + '\n'
          + '作品：\n' + value.works,
      }],
    },
    timeoutMs: 30000,
    execute: async () => {
      const data = await callProductApi('/v2/statistics/published-content-summary/dashboard', { method: 'GET' }) as {
        overall?: { workCount?: unknown, publishedWorkCount?: unknown }
        metricAvailability?: Record<string, unknown>
        metricAvailabilityReason?: Record<string, unknown>
        topWorks?: { byViewGrowth?: unknown }
        dataUpdatedAt?: unknown
      }
      const overall = data?.overall ?? {}
      const avail = data?.metricAvailability ?? {}
      const reason = data?.metricAvailabilityReason ?? {}
      const names: Record<string, string> = { views: '播放', likes: '点赞', comments: '评论', shares: '分享', favorites: '收藏' }
      const availText = Object.keys(names).map((key) => {
        if (avail[key] === true) return names[key] + '：有数据'
        const why = str(reason[key])
        return names[key] + '：无信号（' + (why === '' ? '平台未提供' : why) + '）'
      }).join('；')
      const raw = (data?.topWorks as { byViewGrowth?: unknown } | undefined)?.byViewGrowth
      const list = Array.isArray(raw) ? raw : []
      const works = list.slice(0, 10).map((item) => {
        const w = item as Record<string, unknown>
        return '· ' + (str(w.title) || '（无标题）')
          + '｜' + (str(w.platform) || '?')
          + '｜播放 ' + String(num(w.viewGrowth)) + '｜赞 ' + String(num(w.likeGrowth)) + '｜评 ' + String(num(w.commentGrowth))
          + (str(w.url) === '' ? '' : '｜' + str(w.url))
      }).join('\n')
      return {
        published: String(num(overall.publishedWorkCount)) + ' / 共 ' + String(num(overall.workCount)),
        availability: availText,
        works: works === '' ? '（还没有已发布的作品）' : works,
        updatedAt: str(data?.dataUpdatedAt) || '（未知）',
      }
    },
  }))
  register(defineTool({
    name: 'bosom_content_get_draft',
    description: '读一条草稿的**完整内容**：标题、正文、话题、封面、素材数量。'
      + '用户说「这条讲的是什么」「把这条发出去」「照着这条改」时，**先用它把正文真的读出来**——'
      + '列表工具只给标题，不要凭标题猜内容，也不要拿记忆里的版本冒充草稿原文。',
    parameters: {
      id: { type: 'string', required: true, description: '草稿 id（先用 bosom_content_list_drafts 查出来）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          desc: { type: 'string', required: true },
          topics: { type: 'string', required: true },
          coverUrl: { type: 'string', required: true },
          mediaCount: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '标题：' + value.title + '\n正文：' + value.desc
          + '\n话题：' + (value.topics === '' ? '（无）' : value.topics)
          + '\n封面：' + (value.coverUrl === '' ? '（无）' : value.coverUrl)
          + '\n素材：' + value.mediaCount + ' 个',
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const id = str(args.id).trim()
      if (id === '') throw new Error('必须给草稿 id；先用 bosom_content_list_drafts 查一条出来。')
      const data = await callProductApi('/contents/' + encodeURIComponent(id), { method: 'GET' }) as Record<string, unknown> | null
      if (data === null || typeof data !== 'object') throw new Error('找不到草稿 ' + id + '；它可能已被删除。')
      const topicsRaw = Array.isArray(data.topics) ? data.topics : []
      const topics = topicsRaw.filter((item): item is string => typeof item === 'string' && item !== '')
      const media = Array.isArray(data.mediaList) ? data.mediaList : []
      return {
        title: str(data.title) || '（无标题）',
        desc: str(data.desc) || '（正文为空）',
        topics: topics.join('、'),
        coverUrl: str(data.coverUrl),
        mediaCount: String(media.length),
      }
    },
  }))
  /**
   * 草稿生成查询：生成记录是「用户发起过一次出片/图文」的账本，界面上只显示一行「生成中」。
   * 用户在对话里问「我那条片子好了没、落在哪条草稿上」时，管家要的是两样：
   * 实时进度（阶段 / 百分比 / 已出镜数）与这条任务落下的草稿 id。
   * 服务端 POST ai/draft-generation/query 两者都给（进度按整条片子的完成度算、draftId 由服务端反查），
   * 此前只有前端页面在用，工具面读不到。
   *
   * 为什么按草稿 id 也要能反查：用户说的是「那条草稿」而不是任务号；
   * 服务端列表路径同样带 draftId（draftIdIndex），逐页找即可，不必新开接口。
   */
  register(defineTool({
    name: 'bosom_content_generation_status',
    description: '查**草稿生成任务**（一次厂商调用出片/图文那条链路，任务号 gen-*）的进度与结果，'
      + '并给出这条任务落下的草稿 id（draftId）——拿到它就能用 bosom_content_get_draft 读内容、'
      + 'bosom_publish_draft 发布。taskId 与 draftId 至少给一个：给 taskId 精确查（带实时进度：阶段/百分比/已出镜数）；'
      + '给 draftId 反查是哪次生成落了这条草稿；都不给就列最近几条。'
      + '【什么时候必须用我】用户问「最近有哪些生成记录 / 生成任务 / 那条图文或短片跑完了没」时用它——**不给 taskId 就列最近几条**，这是回答「最近有哪些生成记录」的正确工具。【什么时候不要用我】只查某一条长片（lv-*）的进度、或要看两条链路合并视图时，换 bosom_content_video_status；**它的返回里有什么就说什么，没有 gen-* 记录就如实说没有，不许编造**。',
    parameters: {
      taskId: { type: 'string', description: '生成任务号（形如 gen-xxxxxxxx）；不按任务号查就传空串' },
      draftId: { type: 'string', description: '草稿 id（形如 cnt-xxxxxxxx）；不按草稿反查就传空串' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          draftId: { type: 'string', required: true },
          items: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '共 ' + String(value.count) + ' 条生成记录：\n' + value.items
          + (value.draftId === '' ? '' : '\n这条任务落下的草稿：' + value.draftId + '（用 bosom_content_get_draft 读内容，bosom_publish_draft 发布）'),
      }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const want = str(args.taskId).trim()
      const wantDraft = str(args.draftId).trim()
      let rows: Array<Record<string, unknown>> = []
      let note = ''
      if (want !== '') {
        // 精确查这一条：实时进度只在这条路径上算（服务端按长片任务的分镜就绪数换算整片完成度）。
        rows = asRecords(await callProductApi('/ai/draft-generation/query', { payload: { taskIds: [want] } }))
          .filter(item => str(item.id) === want)
      }
      else if (wantDraft !== '') {
        const perPage = 100
        for (let page = 1; page <= 5; page += 1) {
          const data = await callProductApi('/ai/draft-generation?page=' + String(page) + '&pageSize=' + String(perPage), { method: 'GET' }) as { list?: unknown, total?: unknown }
          const pageRows = asRecords(data.list)
          rows.push(...pageRows.filter(item => str(item.draftId) === wantDraft))
          if (rows.length > 0 || pageRows.length < perPage || page * perPage >= num(data.total)) break
        }
        note = '（按草稿反查走的是列表路径，没有实时进度；要看进度请把它的任务号交给 taskId 查。）'
      }
      else {
        const data = await callProductApi('/ai/draft-generation?page=1&pageSize=5', { method: 'GET' }) as { list?: unknown }
        rows = asRecords(data.list)
        note = '（没给 taskId / draftId，这里只列最近 5 条；查具体某条请给任务号或草稿 id。）'
      }
      const lines = rows.map((item) => {
        const request = (item.request ?? {}) as Record<string, unknown>
        const response = (item.response ?? {}) as Record<string, unknown>
        const taskKind = str(request.kind) === 'image-text' ? '图文' : '短视频'
        const progress = (item.progress ?? {}) as Record<string, unknown>
        const stage = str(progress.stage)
        const shotsTotal = num(progress.shotsTotal)
        const draftId = str(item.draftId)
        const videoUrl = str(response.videoUrl)
        const prompt = str(request.prompt)
        return str(item.id) + ' | ' + (str(item.status) || '?') + ' | ' + taskKind + '（单次调用）'
          + (prompt === '' ? '' : ' | 内容：' + prompt.slice(0, 30))
          + (stage === '' ? '' : ' | 进度 ' + stage + ' ' + String(num(progress.percent)) + '%'
            + (shotsTotal > 0 ? '（' + String(num(progress.shotsReady)) + '/' + String(shotsTotal) + ' 镜）' : ''))
          + (videoUrl === '' ? '' : ' | 成片 ' + videoUrl)
          + (draftId === '' ? '' : ' | 草稿 id=' + draftId)
          + (str(item.errorMessage) === '' ? '' : ' | 失败：' + str(item.errorMessage))
      })
      const draftId = rows.map(item => str(item.draftId)).find(value => value !== '') ?? ''
      return {
        count: rows.length,
        draftId,
        items: lines.length === 0 ? '（没有匹配的生成记录）' : lines.join('\n') + (note === '' ? '' : '\n' + note),
      }
    },
  }))
  /**
   * 草稿生成删除：把一条生成记录连同它落下的草稿一起删掉。
   *
   * 为什么必须由 AI 能调：用户在对话里说「把那条失败的删掉」，页面上要一层层翻到那条记录；
   * 而删除是**拍板类动作**（ADR-005-AGENT §3.3 / BFS-105：只有发布 / 删除 / 花钱 / 对外沟通要用户点头），
   * 所以这条工具只接受用户的明确删除指令，并且**删之前先把这条查出来**：查不到就不删，
   * 绝不拿"最近一条"或猜出来的 id 去删。
   *
   * 影响面（服务端 removeGenerationArtifacts 的既有行为，照实写进结果）：连带删掉这条任务落下的草稿
   * 与知识库里由它蒸馏出的样本，删了不可恢复。
   */
  register(defineTool({
    name: 'bosom_content_delete_generation',
    description: '删除一条草稿生成记录（**删除类动作，只接受用户的明确删除指令，不得自行决定删除**）。'
      + '用户明确说「把那条生成记录删了」时用它；taskId 必须先用 bosom_content_generation_status 查出来，'
      + '不要凭印象编一个 id。**会一起删掉**这条任务落下的草稿与由它蒸馏出的知识库样本，删了不可恢复。'
      + '查不到这条记录时什么都不删，如实告诉用户。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要删的生成任务号（形如 gen-xxxxxxxx；先用 bosom_content_generation_status 查出来）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          taskId: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 20000,
    execute: async (args) => {
      const taskId = str(args.taskId).trim()
      if (taskId === '') throw new Error('必须给 taskId；先用 bosom_content_generation_status 查出来，不要凭印象删。')
      // 删之前先查：既确认这条真的存在（查不到就不删，不做任何猜测），
      // 也把它落下的草稿 id 写进结果——用户要知道被一起带走的还有什么。
      const rows = asRecords(await callProductApi('/ai/draft-generation/query', { payload: { taskIds: [taskId] } }))
      const row = rows.find(item => str(item.id) === taskId)
      if (row === undefined) {
        return {
          deleted: false,
          taskId,
          message: '没有找到生成记录 ' + taskId + '，什么都没删。先用 bosom_content_generation_status 查一下真实的记录号，再让用户确认要删哪条。',
        }
      }
      const draftId = str(row.draftId)
      const deleted = await callProductApi('/ai/draft-generation/' + encodeURIComponent(taskId), { method: 'DELETE' }) === true
      return {
        deleted,
        taskId,
        message: deleted
          ? '已删除生成记录 ' + taskId + (draftId === '' ? '' : '（连同它落下的草稿 ' + draftId + ' 与相关蒸馏样本）') + '；删了不可恢复。'
          : '服务端没有删掉 ' + taskId + '（它可能已经被删过）。用 bosom_content_generation_status 复核一下，别对用户说删成功了。',
      }
    },
  }))
  register(defineTool({
    name: 'bosom_platform_sync_now',
    description: '**真的去平台拉一次最新数据**（作品列表、播放/点赞/评论、粉丝数；真实浏览器操作，约 1~2 分钟）。'
      + '用户说「同步一下数据」「看看最新播放量」「粉丝多少了」时用它。'
      + '**关键**：即使账号显示「登录已失效」，也值得先试一次——同步走的就是平台会话，'
      + '成功即证明登录态其实是好的，账号会自动恢复为正常；只有真失败才如实告诉用户需要重新扫码。'
      + '（只读本地已有记录用 bosom_platform_sync_works，那个不连平台。）',
    parameters: {
      accountId: { type: 'string', required: true, description: '账号 id（先用 bosom_platform_list_accounts 查出来）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === '1'
          ? '平台数据已同步完成。' + value.message + '\n（同步成功同时说明登录态是好的；账号若曾被标记失效，这次会自动恢复。）'
          : '这次同步没有成功：' + value.message
            + '\n（这是平台/引擎的原文，如实转述给用户，**不要编别的原因**；若确属登录失效，再请他重新扫码。）',
      }],
    },
    timeoutMs: 240000,
    execute: async (args) => {
      const accountId = str(args.accountId).trim()
      if (accountId === '') throw new Error('必须给 accountId；先用 bosom_platform_list_accounts 查一个出来。')
      try {
        const data = await callProductApi('/v2/channels/accounts/' + encodeURIComponent(accountId) + '/sync', { payload: {} }) as { message?: unknown, works?: unknown }
        const count = Array.isArray(data?.works) ? data.works.length : 0
        const note = str(data?.message)
        return { ok: '1', message: '拉到 ' + String(count) + ' 条作品的真实数据' + (note === '' ? '。' : '（' + note + '）') }
      } catch (exc) {
        // 同步失败是**正常业务结果**（如登录失效），不是异常：如实回给模型，别抛栈吓它。
        return { ok: '0', message: cleanEngineError(String(exc)) }
      }
    },
  }))
  register(defineTool({
    name: 'bosom_platform_login_start',
    description: '发起平台**扫码登录**（登录态失效、换号、首次绑定都走它）。'
      + '用户说「重新登录」「登录抖音」「换个号」时用它。'
      + '**二维码必须用户本人扫**：发起后请他去 App 的「添加频道 / 重新登录」入口扫码'
      + '（会话约 8 分钟内有效），扫完让他说一声，再用 bosom_platform_login_status 查真实结果——'
      + '**在他确认之前，不要声称已经登录成功**。',
    parameters: {
      platform: { type: 'string', required: true, description: '平台标识，如 douyin、xhs' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          qrPath: { type: 'string', required: true },
          expiresAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已发起扫码登录（会话 ' + value.sessionId + '，二维码有效期至 ' + value.expiresAt + '）。\n'
          + '请让用户**本人在 App 里扫码**：侧栏底部「添加频道 / 重新登录」入口。\n'
          + '二维码图片地址（如需直接打开）：' + value.qrPath + '\n'
          + '**在用户确认扫完之前不要说他已登录**：等他回话后，用 bosom_platform_login_status 查真实结果。',
      }],
    },
    timeoutMs: 180000,
    execute: async (args) => {
      const platform = str(args.platform).trim()
      if (platform === '') throw new Error('必须给 platform（如 douyin）；用户没说平台时先问他一句。')
      const data = await callProductApi('/v2/channels/accounts/auth/' + encodeURIComponent(platform), { method: 'GET' }) as {
        url?: unknown
        sessionId?: unknown
        expiresAt?: unknown
      }
      const sessionId = str(data?.sessionId)
      if (sessionId === '') throw new Error('服务端没有回传登录会话号，这次发起不算成功；如实告诉用户。')
      return {
        sessionId,
        qrPath: '/bosom-friend/api/platform-login/qr/' + sessionId,
        expiresAt: str(data?.expiresAt) || '（未知）',
      }
    },
  }))

  // P1 能力工具化流水线（BFS-902 T3）：把服务端侧登记的能力批量注册成模型可调的工具。
  // 位置有讲究——必须晚于 register 的定义，否则拿不到那个受 preset allowList 约束的统一入口，
  // 生成出来的工具会绕过「工具面即权限」。返回实际注册条数，便于门禁与日志对账。
  const generatedCount = generatedTools(register)
  if (generatedCount > 0) {
    // 只在真有生成时打一行：内核 stdout 只承载 JSON-RPC，这行走 stderr。
    process.stderr.write('[tools] generated ' + String(generatedCount) + ' capabilities from src/generated-tools.ts\n')
  }

  // 工具面自检（2026-10-12，ADR-006 的运行时兜底）：**声明了面却一条都没注册成功**时抛错。
  //
  // 为什么必须响亮：静默跑起来的后果是那个管家在用户面前一个工具都没有——用户只会看到
  // "它什么都不会干"，而日志里没有任何线索。会走到这里的情形有两种：
  //   ① $DSH_HOME/.agent-presets/roles.json 里该角色名下的工具名全部对不上内核实际工具名；
  //   ② preset 的 config.tools 与内核工具名脱节（改名字/删工具后没同步）。
  // 不能放宽成"没命中就全量"：那等于把权限边界悄悄拆掉，比零工具更糟。
  if (allowList !== undefined && allowList.length > 0 && registeredCount === 0) {
    throw new Error('工具面自检失败：这个角色声明了 ' + String(allowList.length) + ' 条工具/前缀（'
      + allowList.join(' / ') + '），却一条都没有注册成功——那个管家会在用户面前一个工具都没有。'
      + '请检查 $DSH_HOME/.agent-presets/roles.json 里该角色的工具名与内核实际注册的工具名是否对得上；'
      + '唯一事实源是 presets/roles.json，改完要同步到运行期副本。见 docs/adr/ADR-006。')
  }
}

/**
 * 解析本内核实例的工具面。
 *
 * 优先级：显式 config.tools > 环境变量 BF_AGENT_ROLE 对应的角色面 > 全量（undefined）。
 *
 * 为什么用环境变量而不是 agent-presets：产品的内核入口是 dsh-sdk-jsonrpc-server，
 * 而它**不做 preset 组装**（packages/sdk/server/src/server.ts 的 createSession 写着
 * No preset composition），preset 里的 config.tools 根本不会被挂载。真正把工具面
 * 切开的落点在这里。
 *
 * 角色面放在 $DSH_HOME/.agent-presets/roles.json，它是工具面的**唯一事实源**：
 * presets/roles.json 是仓库里的源，装机（或手工同步）复制到运行期副本，没有自动同步——
 * 改完仓库那份必须复制过去，否则运行期读到的还是旧工具面。
 * qa/verify-preset-parity.mjs 检查两边是否一致，并强制五份 preset 与前端镜像逐条跟随。
 *
 * @param config - 插件配置；config.tools 非空时直接采用。
 * @returns 允许的工具名或前缀（以星号结尾）；undefined 表示全量注册。
 */
function resolveAllowList(config: Config): string[] | undefined {
  if (Array.isArray(config.tools) && config.tools.length > 0) return config.tools
  const role = (process.env.BF_AGENT_ROLE ?? '').trim()
  if (role === '') return undefined
  try {
    const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.bosom-friend')
    const file = join(home, '.agent-presets', 'roles.json')
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const list = parsed[role]
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : undefined
  } catch {
    // 角色面读不到就退回全量：宁可多给工具，也不能因为一个配置文件读失败让管家变哑巴。
    return undefined
  }
}

/**
 * 调产品服务端能力（回环 HTTP）的唯一入口。
 *
 * 内核工具一律经它访问服务端：统一拼地址、统一解 code/message 信封、失败时抛出**带原因**的错误，
 * 让模型能照着错误自我纠正。每个工具各写一份 fetch + 解析会重复且容易漏判 code。
 *
 * @param path - 产品接口路径（形如 /long-videos/<id>/stop，不带 /bosom-friend/api 前缀）。
 * @param init - method 缺省 POST；payload 缺省不带请求体。
 * @returns 信封里的 data 字段（形态由调用方按接口约定断言）。
 * @throws 服务不可达、HTTP 非 2xx、code 非 0 时抛出带原因的错误。
 */
async function callProductApi(path: string, init?: { method?: string, payload?: unknown }): Promise<unknown> {
  const port = process.env.BOSOM_SERVER_PORT ?? '31280'
  const url = 'http://127.0.0.1:' + port + '/bosom-friend/api' + path
  const method = init?.method ?? 'POST'
  let text = ''
  try {
    const response = await fetch(url, {
      method,
      ...(init?.payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.payload) }),
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
 * 触发一轮管家对话：把这一句交给**服务端真实那条对话链路**，拿到任务号就断开。
 *
 * 必须带 `accept: text/event-stream`：`POST agent/tasks` 不带这个头时只落一条任务记录就返回 id
 * （api.ts:2627-2631），一个字都不交给模型——用户会拿到一条永远停在「运行中」、没有任何进展的任务。
 *
 * 拿到首帧就断开，不读整条流：一轮对话可能几分钟（调模型、跑工具），内核工具不能把模型的这一轮卡在这里。
 * 服务端开流后写的第一帧固定是 `{ type: 'init', taskId, sessionId }`（api.ts:2661），拿到它就是
 * 「任务已经开跑」的凭据。断开是安全的：所有 SSE 写入都经 safeSse 守卫（api.ts:2656-2659，流已关时静默跳过），
 * 正文与终态照常落库（api.ts:3173 / 3203 / 3241）；「停下」走的是 inFlightAgentTasks 控制位
 * （api.ts:3466-3471），与这条流是死是活无关。
 *
 * @param turn - prompt 是这一轮要交给管家的话；给了 taskId 就是续轮（追问），不给就是新建一条任务。
 * @returns 这条任务的 id。
 * @throws 服务不可达、非 2xx、或 20 秒内没等到开始帧时抛出带原因的错误。
 */
async function startTaskTurn(turn: { prompt: string, taskId?: string }): Promise<{ taskId: string }> {
  const port = process.env.BOSOM_SERVER_PORT ?? '31280'
  const url = 'http://127.0.0.1:' + port + '/bosom-friend/api/agent/tasks'
  const body = turn.taskId === undefined ? { prompt: turn.prompt } : { prompt: turn.prompt, taskId: turn.taskId }
  const controller = new AbortController()
  // 首帧在毫秒级写出；20 秒还没到说明服务端卡在建流之前，此时如实失败，不让模型干等。
  const timer = setTimeout(() => controller.abort(), 20_000)
  timer.unref?.()
  try {
    let response: Awaited<ReturnType<typeof fetch>>
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (exc) {
      throw new Error('产品服务调用失败（POST /agent/tasks）：' + String(exc))
    }
    if (!response.ok || response.body === null)
      throw new Error('产品服务调用失败（POST /agent/tasks）：返回 ' + String(response.status))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true })
        if (chunk.done === true) break
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const line = frame.split('\n').find(part => part.startsWith('data:'))
          if (line === undefined) continue
          let parsed: { type?: unknown, taskId?: unknown }
          try {
            parsed = JSON.parse(line.slice(5).trim()) as { type?: unknown, taskId?: unknown }
          } catch {
            continue // 保活注释帧（以冒号开头）不是 JSON：跳过，继续读下一帧。
          }
          if (parsed.type === 'init' && typeof parsed.taskId === 'string' && parsed.taskId !== '')
            return { taskId: parsed.taskId }
        }
      }
    } catch (exc) {
      throw new Error('没等到这条任务的开始帧（POST /agent/tasks）：' + String(exc)
        + '。若「我的任务」里已经出现这条任务，说明它其实已经开跑，以任务列表为准。')
    } finally {
      // 断开：服务端按「客户端走了」处理，这一轮在后台继续跑完并落库。
      void reader.cancel().catch(() => {})
    }
    throw new Error('产品服务没有回传任务开始帧（POST /agent/tasks）：这次任务没有确认开跑，如实告诉用户。')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把引擎/平台的错误原文清洗成模型能读懂的一句话。
 *
 * 引擎输出带 ANSI 颜色码与逐行日志，直接把原文塞给模型会被噪声淹没：2026-10-11 实测，
 * 一条真实原因是「标题不能超过20字符，当前: 21字符」的失败，因为关键行被截断、
 * 前面全是彩色码与「小人先检查 cookie、图片和发布时间」，模型据此对用户编出了
 * 「封面生成超时」这个假原因。**输入脏了，模型就会拿推测当事实。**
 *
 * 清洗规则：去 ANSI、按行切、去掉纯日志前缀行，只保留最后 3 行有信息量的内容。
 *
 * @param raw - 引擎/平台返回的错误原文。
 * @returns 单行、无颜色码、尽量保留关键信息的文本（最多 300 字）。
 */
function cleanEngineError(raw: string): string {
  const text = raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '')
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return ''
  // 去掉形如「2026-10-11 14:00:11 | INFO: …」的纯日志行——它们只说"走到哪一步"，不说"为什么失败"。
  const meaningful = lines.filter(line => !/^\d{4}-\d{2}-\d{2}.*\|\s*(INFO|DEBUG|TRACE)/.test(line))
  const picked = meaningful.length > 0 ? meaningful : lines
  return picked.slice(-3).join('；').slice(0, 300)
}
