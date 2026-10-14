/**
 * Bosom Friend新后端 API 插件：在 dsh webServer 上承接Bosom Friend Web 前端的全部运行时 REST
 * 契约（挂载于 /bosom-friend/api），并托管 /bosom-friend 静态应用。
 *
 * 兼容约定（对齐前端 client.ts 与穷尽式契约清单）：
 * - 响应恒为 {code, data, message} 信封；code===0 成功；业务错也走 HTTP 200。
 * - 前端三处前导斜杠路径会产生 api// 双斜杠，路由前统一归一化。
 * - DELETE 可携带 JSON body；数组 query 用重复键 ids=a&ids=b。
 * - AI 对话走 POST agent/tasks 的 SSE 通道，事件结构对齐
 *   前端 store/agent/task-instance/sse.handler.ts 的消费逻辑。
 * @module @deepseek-ai/dsh-bosom-friend-server/api
 */

import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { accountFactKey, PUBLISH_RECORD_STATUS, type LongVideoEstimate, type ShareLinkRecord, type ZyAgentRole, type ZyContentRecord, type ZyDigitalHuman, type ZyDraftGenerationTask, type ZyLongVideoTask, type ZyMaterialMedia } from './types.ts'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BodyTooLargeError, MAX_BODY_BYTES, handleCors, mimeOfExt, readBody, serveSpa, tokenEquals, writeFail, writeOk } from './http.ts'
import { DEFAULT_MATERIAL_GROUP_ID, filterGenerationArtifacts, openStore, writeDataJson, writeDataText } from './store.ts'
import { securityHardening, type SecurityReport } from './security.ts'
import { generateNoteCover, ensureEngineDaemon, generateMediaCards, createSlideshow, cleanPlatformNickname, extractVideoThumbnail, sweepStalePublishTasks } from './platform-login.ts'
import { cropImageRegion, cropImageToSize, detectColumnBounds, imagePricingRows, IMAGE_RATIOS, padImageToMinAspect, parseSize, pixelFor, ratioPromptHint, readImageSize } from './image-ratio.ts'
import { appendChannelRoutes, resumeScheduledPublishes } from './routes-channels.ts'
import { appendContentRoutes } from './routes-content.ts'
import { appendKnowledgeRoutes } from './routes-knowledge.ts'
import { appendKnowledgeDistillRoutes, buildKnowledgeContext, buildQualityContext, distillStats, recordDistillation, removeDistillationsBySource, type DistillationRecord, type KnowledgeState } from './knowledge-distill.ts'
import { appendSkillPromotionRoutes } from './routes-skill-promotion.ts'
import { addMemoryEntry, buildMemoryContext, replaceMemoryEntries } from './memory-store.ts'
import {
  buildMemoryReviewPrompt,
  buildSkillReviewPrompt,
  buildUserReviewPrompt,
  bumpAndCheck,
  markReviewed,
  parseReviewEntries,
  parseSkillReview,
  SKILL_REVIEW_MIN_TOOL_CALLS,
  tailOf,
} from './self-evolution.ts'
import { skillName } from './agent-skills.ts'
import { buildAgentContext, buildFocusContext, buildNowContext, dshHomeOf, parseAgentFocus, writeAgentContext, type AgentContextFacts, type AgentFocus } from './agent-context.ts'
import { buildObjectActionPrompt, findObjectAction, looksLikeMetaReply, objectActionsFor } from './object-actions.ts'
import { rateSamplesFromEngagement } from './sample-rating.ts'
import type { ObjectActionValue } from './object-actions.ts'
import {
  curateSkillsByRole,
  normalizeProcedure,
  skillRoleOfRecord,
  skillSlug,
  writeSkill,
} from './agent-skills.ts'
import { platformCatalog } from './platform-catalog.ts'
import { perfTier } from './perf.ts'
import { startReceptionEngine, stopReceptionEngine } from './reception-engine.ts'
import { STALE_LOGIN_HOURS, autoTaskStatus, staleHoursOf, startAutoTasks, stopAutoTasks } from './auto-tasks.ts'
import { stopTrackedChildren } from './platform-processes.ts'
import { installRuntimeLog } from './runtime-log.ts'
import { markStalledGenerations, mediaBudgetMs, mediaTimeoutMessage, type GenerationRecord } from './generation-watchdog.ts'
import { COMPOSED_VIDEO_GEARS, PRODUCT_VIDEO_GEARS, VIDEO_DAILY_QUOTA_SECONDS, VIDEO_FREE_TIER_RPM, estimateMinutes, planClipSeconds } from './video-duration.ts'
import {
  TOKEN_COOKIE,
  findCloudflared,
  hasForwardedOrigin,
  isLocalHostHeader,
  isLoopbackAddress,
  lanUrls,
  newRemoteToken,
  readRemoteAccess,
  remoteTokenMatches,
  startTunnel,
  stopTunnel,
  tunnelStatus,
  writeRemoteAccess,
} from './remote-access.ts'
import type { RemoteAccessConfig } from './remote-access.ts'
import {
  chatTranscript,
  createKernelClient,
  replayFrames,
  type ChatTurn,
  type KernelAgentStep,
  type KernelClient,
  type KernelClientOptions,
  type KernelTextStreamPart,
} from './kernel-client.ts'
import {
  MEDIA_TIMEOUTS,
  describeMediaFailure,
  isRetryableMediaFailure,
  isUnreachableMediaFailure,
  mediaFailureStatus,
} from './media-gateway.ts'
import type { MediaReferenceVideo, MediaRuntime, MediaVideoSubmission } from '@deepseek-ai/dsh-media'
import { changelogNotifications } from './changelog.ts'
import {
  DEFAULT_DIGITAL_HUMAN_PERSONA,
  DIGITAL_HUMAN_PERSONAS,
  VOICE_PREVIEW_TEXT,
  personaPrompt,
  resolvePersona,
} from './digital-human.ts'
import {
  DEFAULT_RETRY_POLICY,
  MAX_LONG_VIDEO_TOPIC_CHARS,
  RETRYABLE_FAILURE_PREFIX,
  clampSegmentSeconds,
  enhanceSpokenTopic,
  enhanceVisualPrompt,
  estimateSeconds,
  extendLongVideoScript,
  normalizeSpokenText,
  readUploadedAsset,
  recoverInterruptedLongVideoTasks,
  redoShot,
  removeLongVideoArtifacts,
  resumeBlockedReason,
  resumeStartIndex,
  runLongVideoJob,
  splitScript,
  stopLongVideoTask,
} from './long-video.ts'
import type { LongVideoDeps, LongVideoProducer, LongVideoRetryPolicy } from './long-video.ts'
import { resolveDraftTitle } from './draft-title.ts'
import { IDLE_NEXT_TURN_HINT, IDLE_NUDGE, nudgeOnceIfIdle, previousTurnWasIdle } from './agent-idle-guard.ts'
import { NO_PERSON_CLAUSE, NO_RENDERED_TEXT, buildStoryboardPrompt, ensureBrollShots, fallbackShotPlan, fillMissingLines, fitScriptToShots, formSellsProduct, parseShotPlan, pinVisualBrief, planShotCount, shotsCoverTarget, stripPersonClauses, subjectFromTopic } from './storyboard.ts'
import { CHARS_PER_SECOND, SPOKEN_STYLE_RULES, beatSpeechHint, minScriptChars } from './speech.ts'
import {
  AGNES_BASE_URL,
  AGNES_DISPLAY_NAME,
  AGNES_PROVIDER_ID,
  AGNES_PROTOCOL,
  AGNES_VIDEO_RATIOS,
  AGNES_VIDEO_SECONDS_MAX,
  AGNES_VIDEO_SECONDS_MIN,
  agnesPictureReferenceClause,
  agnesVideoLimits,
  agnesVideoSizes,
  isAgnesVideoModel,
} from './agnes.ts'
import type { ZyShot, ZyShotRef } from './types.ts'
import { probeDurationSeconds, runFfmpeg } from './ffmpeg.ts'
import { traceMediaObservations } from './media-trace.ts'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 解析产品版本号（注入给前端的 __APP_VERSION__）。
 *
 * 桌面壳启动内核前设置 `BOSOM_FRIEND_VERSION=app.getVersion()`，这是打包环境的权威来源；
 * 纯服务端调试时回退到本仓库 desktop/package.json 的版本；两者都取不到时返回空串，
 * 由前端回退到构建期版本号——绝不写死某个历史版本，避免"前端显示旧版本"。
 *
 * @returns 产品版本号；无法解析时为空串。
 */
function resolveAppVersion(): string {
  const injected = process.env.BOSOM_FRIEND_VERSION?.trim()
  if (injected !== undefined && injected !== '') return injected
  // 源码态从 server/src 解析、构建态从 server/lib/types 解析、从仓库根启动时按 cwd 解析。
  // 三个位置都试，保证任何启动方式都能拿到产品版本，不再回落成前端构建期旧版本号。
  const candidates = [
    new URL('../../desktop/package.json', import.meta.url),
    new URL('../../../desktop/package.json', import.meta.url),
    new URL('products/bosom-friend/desktop/package.json', pathToFileURL(process.cwd() + '/')),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(fileURLToPath(candidate), 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    }
    catch {
      // 该位置没有 desktop/package.json：继续尝试下一个候选。
    }
  }
  return ''
}

export const name = 'bosom-friend-server-api'

export const inject = ['webServer']

/** 插件配置。 */
export interface Config {
  /** 数据根目录；由组合层以产品独立根（~/.bosom-friend，组合层注入 DSH_HOME）解析，缺省回退同构路径。 */
  dataRoot?: string
  /** Bosom Friend静态前端 dist 目录；缺省按仓库布局解析。 */
  frontendDist?: string
  /** 账号登录开关；false 时跳过会话守卫并回退单用户免登录（临时屏蔽登录页用）。 */
  authEnabled?: boolean
  /** AI 对话走官方内核（ADR-001 第一步）；默认关，开启后无 BYOK 覆盖的 ai/chat 经内核。 */
  kernelAi?: boolean
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  frontendDist: z.string().default(''),
  authEnabled: z.boolean().default(true),
  kernelAi: z.boolean().default(false),
})

/**
 * 厂商视频生成的结果。
 *
 * 失败必须带**原因**而不是一个 `null`：`null` 到了界面上只剩"厂商未返回可用成片"，
 * 而限流（429）与"参数被拒"该做的动作完全不同——用户至少要能从提示里决定是等一会儿再来还是改参数。
 */
export type VideoOutcome =
  | { ok: true, url: string, model: string }
  | { ok: false, reason: string }

/** index.html 注入引导所需的运行时值（apply 时填充）。 */
const runtime = {
  backendBaseUrl: '/bosom-friend/api',
  authToken: '',
}

/** 明确的「带我去某页」措辞；只有这类请求才走导航动作，创作需求不会因此被跳转掉。 */
const NAVIGATE_VERB = /(打开|进入|跳转|切换|切到|前往|带我去|去一下|调到|调出|看一下|看看|查看|展示)/

/**
 * 对话导航意图 → 动作卡类型，顺序即优先级（越具体的说法排越前）。
 *
 * 前端 NAVIGATE_ROUTES 支持这 7 个功能页；这里的类型必须与那份表逐字一致，
 * 否则动作卡会出现但点不动。实测产品此前只产出 navigateToPublish，
 * 「只用对话就能用各项功能」这条验收准则只落了一半。
 */
const AGENT_NAVIGATE_INTENTS: Array<{ type: string, label: string, pattern: RegExp }> = [
  { type: 'navigateToKnowledge', label: '知识库', pattern: /知识库|笔记库|素材库/ },
  { type: 'navigateToCalendar', label: '发布日历', pattern: /日历|排期|日程/ },
  { type: 'navigateToTasks', label: '任务历史', pattern: /任务历史|历史任务|我的任务/ },
  { type: 'navigateToReception', label: 'AI 互动接待', pattern: /接待|私信|客服|评论/ },
  { type: 'navigateToMonitor', label: '全局监控', pattern: /监控/ },
  { type: 'navigateToDatacenter', label: '数据中心', pattern: /数据中心|数据统计|数据看板|播放量|数据表现/ },
  { type: 'navigateToDraft', label: '草稿箱', pattern: /草稿/ },
]

/**
 * 无需会话即可访问的端点：登录/注册本身，以及历史上存在过的登录入口
 * （它们一律回 401 提示改用账号密码登录，不提供任何数据）。
 */
export const PUBLIC_PATHS = new Set(['auth/login', 'auth/register', 'login/mail', 'login/phone', 'login/mail/verify', 'login/phone/verify', 'login/google', 'auth-mock'])

/**
 * 判定本次请求是否必须携带有效会话（AC-002-3 未登录不得访问业务数据）。
 *
 * 三种放行：免登录模式（单机单用户，产品当前的有意配置）、公开端点、
 * 以及浏览器带不上 Authorization 头的资源与只读分享页。
 *
 * @param authEnabled - 是否启用账号体系。
 * @param publicPath - 去掉 /bosom-friend/api 前缀后的路径。
 * @param isResourcePublic - 是否属于资源/只读分享路径。
 * @param hasValidSession - 请求头里的 Bearer token 是否命中有效会话。
 * @returns true 表示必须拒绝（回 401 请先登录）。
 */
export function sessionRequired(
  authEnabled: boolean,
  publicPath: string,
  isResourcePublic: boolean,
  hasValidSession: boolean,
): boolean {
  if (!authEnabled) return false
  if (PUBLIC_PATHS.has(publicPath)) return false
  if (isResourcePublic) return false
  return !hasValidSession
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

/** 历史会话兼容：把字符串 message 归一化为前端转换器要求的 content 块数组（Claude 风格）。 */
function normalizeTaskMessages(task: { messages?: { type?: string; message?: unknown }[] }): void {
  if (!Array.isArray(task.messages)) return
  for (const msg of task.messages) {
    if (msg.type !== 'assistant') continue
    const raw = msg.message
    if (typeof raw === 'string') {
      msg.message = { content: [{ type: 'text', text: raw }] }
    }
    else if (raw && typeof raw === 'object') {
      const content = (raw as { content?: unknown }).content
      if (typeof content === 'string') {
        ;(raw as { content: unknown }).content = [{ type: 'text', text: content }]
      }
    }
  }
}

function uid(prefix: string): string {
  return prefix + '-' + randomUUID().slice(0, 8)
}

/**
 * 生成类成品落盘前确保 uploads/ 存在，并返回该目录。
 *
 * 这个目录此前只由上传链路按需创建，生成链路直接 writeFileSync —— 目录不存在时抛 ENOENT，
 * 在 fail-loud 启动下就是整个运行时进程退出：界面只会看到「连不上本地服务」（2026-09-21
 * 实测：图文生成打死服务进程，日志 'fatal load failure: ENOENT ... uploads\ai-img-raw-*.bin'）。
 *
 * @param dataRoot - 产品数据根。
 * @returns uploads 目录的绝对路径。
 */
function ensureUploadsDir(dataRoot: string): string {
  const dir = join(dataRoot, 'uploads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 图文生成张数的收敛范围，与前端选择器 `IMAGE_COUNT_LIMITS` 同口径。
 * 界面允许 1–9 张；服务端按同一范围收敛，避免旧请求或脚本传入超大值。
 */
const IMAGE_COUNT_LIMITS = { min: 1, max: 9 } as const

function sha8(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function segsOf(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

/**
 * 一条任务的模型用量（口径来源见 `taskUsageIndex`）。
 *
 * 界面据此回答"这个任务花了多少"；数字全部实测，没有的部分如实给 null。
 */
interface TaskUsage {
  /** 账本里这条任务的模型调用次数（每条样本 = 一次真实调用）。 */
  modelCalls: number
  /** 这些调用**已计到**的耗时合计（毫秒）。 */
  modelMs: number
  /** 这些调用里计到的工具调用次数合计。 */
  toolCalls: number
  /** 账本里记为非成功状态的调用次数。 */
  failedCalls: number
  /** 出现过的模型名，按调用次数降序。 */
  models: string[]
  /** 产品不记录 token 数（内核未回传用量）：恒为 null，界面显示"未记录"，不拿估算值顶替。 */
  tokens: null
}

interface ApiCall {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

interface RouteDef {
  m: string
  p: string
  h: (call: ApiCall) => void | Promise<void>
}

function matchRoute(routes: RouteDef[], method: string, segs: string[]): { route: RouteDef; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.m !== '*' && route.m !== method) continue
    const tpl = route.p.split('/').filter(Boolean)
    if (tpl.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < tpl.length; i++) {
      if (tpl[i]!.startsWith(':')) params[tpl[i]!.slice(1)] = decodeURIComponent(segs[i]!)
      else if (tpl[i] !== segs[i]) { ok = false; break }
    }
    if (ok) return { route, params }
  }
  return undefined
}

function readStr(call: ApiCall, key: string, fallback = ''): string {
  const value = (call.body as Record<string, unknown>)?.[key]
  return typeof value === 'string' ? value : fallback
}

function sse(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write('data: ' + JSON.stringify(payload) + '\n\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** prompt 支持字符串或 Claude Prompt 数组（前端两态）。 */
/**
 * 用户提示词的字数上限：与前端输入框的 `PROMPT_MAX_LENGTH` 同一个数。
 *
 * 为什么要显式对齐：后端曾静默截到 500 字而前端允许 2000，用户写长提示词时
 * 第 501 字之后的内容会凭空消失，且没有任何提示。
 */
const PROMPT_MAX_CHARS = 2000

function extractPrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt
      .map((item) => {
        if (typeof item === 'string') return item
        const rec = item as { text?: unknown; content?: unknown }
        if (typeof rec.text === 'string') return rec.text
        if (typeof rec.content === 'string') return rec.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 请求体里的字符串字段：非字符串或空串一律视为未提供，并按字段长度上限截断。 */
function readRequestString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

/** 请求体里的字符串列表字段（平台/素材 URL）：丢弃非字符串与空值，并按数量上限截断。 */
function readRequestStringList(value: unknown, maxCount: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .slice(0, maxCount)
}

/**
 * 读目标平台：**同时认数组与空格分隔的字符串**。
 *
 * 为什么两种都要认：老版本与某些客户端把多选结果拼成了 'xhs douyin KWAI wxSph' 这样的一个字符串
 * （实测盘上就有这样一条生成记录）。只认数组时这种记录的平台会被整条丢掉——生成时写通用文案、
 * 发布时也拿不到 `accountTypes`，"用户选了五个平台、结果什么都没作用到"。
 *
 * @param value - 请求体或记录里的 platforms 字段。
 * @param maxCount - 最多认几个平台。
 * @returns 平台 id 列表；两种形状都读不出来时为空数组。
 */
export function readPlatformList(value: unknown, maxCount = 20): string[] {
  const fromArray = readRequestStringList(value, maxCount)
  if (fromArray.length > 0) return fromArray
  if (typeof value !== 'string') return []
  return value.split(/[\s,，、]+/).map(item => item.trim()).filter(item => item !== '').slice(0, maxCount)
}

/**
 * 文案要求块：用户填写的文案要求（内含目标平台标题/正文/话题上限）作为最高优先级约束并入模型提示词。
 *
 * @param captionPrompt - 已解析的文案要求；空串表示用户未填写。
 * @returns 可直接拼接的提示词片段；未填写时为空串。
 */
function buildCaptionRequirementBlock(captionPrompt: string): string {
  return captionPrompt === '' ? '' : '\n\n【用户文案要求（最高优先级，必须逐条满足）】\n' + captionPrompt
}

/**
 * 从用户这句话里认出要发布到哪个平台。
 *
 * 判据是**平台名到平台 id 的映射**，不是一个三元判断：上一版是
 * `promptText.includes('抖音') ? 'douyin' : 'xhs'`——说"发布到快手"也会得到小红书的卡片，
 * 用户点「去发布」就到错的平台。认不出来时才回落到小红书（产品的默认发布平台）。
 *
 * @param text - 用户这一轮的原话。
 * @returns 平台 id。
 */
export function detectPublishPlatform(text: string): string {
  const known: Array<[RegExp, string]> = [
    [/抖音|douyin/i, 'douyin'],
    [/小红书|红薯|xhs/i, 'xhs'],
    [/快手|kuaishou|KWAI/i, 'KWAI'],
    [/视频号|微信视频|wxSph/i, 'wxSph'],
    [/哔哩哔哩|B ?站|bilibili/i, 'bilibili'],
  ]
  return known.find(([pattern]) => pattern.test(text))?.[1] ?? 'xhs'
}

/**
 * 平台块：把"这条内容要发到哪几个平台"写进提示词。
 *
 * 为什么必须有：`platforms` 原先只落进生成记录的 `accountTypes`（发布时用），**生成时完全没读**——
 * 于是选了抖音却写出一篇小红书图文（带 emoji 与分段）、选了 B 站却写"点下方链接"这类站外导流。
 * 各平台的字数上限由前端的文案要求（`captionPrompt`）单独带上来，这里补的是**平台本身的口径**：
 * 标题怎么写、正文给谁看、话题怎么用、哪些话不能写。
 *
 * 平台名直接用平台 id（`douyin`/`xiaohongshu`…）而不是中文名：中文名是界面文案，会随语言变；
 * 模型对这几个通用平台 id 的认识是稳的，而用户自己的额外要求走最高优先级的文案要求块。
 *
 * @param platforms - 本次选中的平台 id。
 * @returns 可直接拼接的提示词片段；没选平台时为空串。
 */
export function buildPlatformBlock(platforms: string[]): string {
  if (platforms.length === 0) return ''
  const lines = [
    '\n\n【目标平台：' + platforms.join('、') + '】\n',
    '按这些平台各自的习惯写，不要写成通用文案：',
    '标题按平台习惯（抖音/快手重钩子与口语，小红书重搜索词与真实感，B 站重信息量与正片感）；',
    '正文用平台的说话方式，不要出现"点下方链接""私信我"这类可能被限流的站外导流话术；',
    '话题标签按平台习惯给（抖音 3~5 个、小红书 5~8 个贴近搜索词的、B 站可以少）。',
  ]
  // 抖音的具体填写规范（平台 UI 实测 + 运营共识）：写文案时直接照着填，
  // 光说"重钩子"三个字模型抓不住重点——每一栏都有硬约束。
  if (platforms.includes('douyin')) {
    lines.push(
      '【抖音填写规范（逐条照做）】'
      + '标题 ≤30 字，最抓人的信息放**前 8 个字**（列表页只露这几个字），不放 emoji、不放话题、不写"求关注"；'
      + '正文 ≤1000 字，**前两行最关键**——抖音只展示前两行、其余折叠，钩子与结论必须放前面，'
      + '用平台口语和短句，写清"给谁看、能得到什么"；'
      + '话题标签 3~5 个（1 个大词 + 2~3 个精准词 + 1 个垂类词），只用平台里真实存在的话题词，'
      + '堆太多会被判"堆砌标签"反而限流；'
      + '封面竖版 9:16，核心文字与人物放画面**正中央**（顶部 200px、底部 350px、右侧 150px 会被平台 UI 遮住），'
      + '封面文字不超过 12 个字；'
      + '位置只在内容确实与某地相关时才加；AI 生成内容必须勾选「内容由AI生成」。',
    )
  }
  return lines.join('')
}

/**
 * 媒体提示词里的风格约束：图片/视频厂商接口只接受 prompt/model/n/size 等字段，
 * 没有独立的风格参数，风格只能作为提示词前缀下发。
 *
 * @param style - 已解析的风格名；空串表示未选择。
 * @returns 提示词前缀；未选择时为空串。
 */
function buildStyleDirective(style: string): string {
  return style === '' ? '' : '画面风格：' + style + '。\n'
}

// ---------------------------------------------------------------------------
// LLM 桥：一次补全；模型不可用时回退本地模板，链路永不悬死
// ---------------------------------------------------------------------------

/**
 * 纯文本生成约束：所有走 {@link streamLlmWithDeltas} 的用途都是「给要求、要正文」，
 * 没有任何一步需要模型动手。
 *
 * 为什么必须有这一段：内核会话带工具，而产品规则要求模型「先查后答」「用工具看清事实」，
 * 于是模型会把生成请求当成待办去调工具。实测（2026-09-16，
 * agnes-2.5-flash 经厂商网关）不约束时分镜表请求 180 秒仍未结束、正文为空，界面表现为
 * 「大模型没有返回可用的稿件：未知错误」；加上这一段后同一请求 12~14 秒返回完整正文。
 * 约束放在最前面，避免被后面的长要求冲淡。
 */
const TEXT_ONLY_GUARD = '【本次会话是纯文本生成任务：不要调用任何工具，也不要输出任何解释或前后缀，只输出正文】\n\n'

/**
 * 把设置页的模型覆盖解析成内核客户端选项。
 *
 * 为什么单独成一个函数：池化（一个任务一个会话）与一次性调用（写稿/分镜）必须用**同一套**
 * 路由解析口径，否则"助手走 A 路由、生成走 B 路由"这类问题会藏在两处各写一遍里。
 *
 * @param override - 设置页当前生效的提供方与型号。
 * @returns 内核客户端选项。
 */
function kernelOptionsOf(override: LlmOverride, options: { textOnly?: boolean, role?: string } = {}): KernelClientOptions {
  const activeProvider = override.providers?.find(item => item.id === override.activeProviderId) ?? override.providers?.[0]
  return {
    provider: activeProvider !== undefined ? kernelRouteId(activeProvider.id) : 'agnes',
    model: override.model,
    baseUrl: override.baseUrl,
    apiKey: override.apiKey,
    ...options.textOnly === true ? { textOnly: true } : {},
    ...options.role !== undefined && options.role !== '' ? { role: options.role } : {},
  }
}

/**
 * 这条任务归哪个管家办（ADR-005 呈现层改造方案 v1.0 的 S1 服务端判定）。
 *
 * 依据只有前端**如实送来**的焦点对象（页面 + 对象种类），服务端不推断别的东西：
 * 判不准时一律归总管——写错一个管家比写"未登记"更糟，用户会以为这件事已经交给了别人。
 *
 * 判序：先看对象种类（页面登记的具体对象比页面本身准，例如在内容创作页里打开一条发布记录，
 * 这件事归发布管家），再看页面，都不认识就是总管。
 *
 * @param focus - 请求体里的焦点对象；页面没送时为 undefined。
 * @returns 归属管家代号（值域见 {@link ZyAgentRole}）。
 */
export function agentRoleOfFocus(focus: AgentFocus | undefined): ZyAgentRole {
  if (focus === undefined) return 'steward'
  switch (focus.objectKind) {
    case '草稿':
      return 'creator'
    case '发布记录':
      return 'publisher'
    case '账号':
      return 'device'
    default:
      break
  }
  switch (focus.page) {
    case '内容创作':
    case '长视频创作':
    case '我的数字人':
    case '素材库':
      return 'creator'
    case '发布日历':
      return 'publisher'
    case '数据中心':
    case '全局监控':
    case 'AI互动':
      return 'operator'
    case '账号管理':
    case '系统设置':
      return 'device'
    // 「对话」「我的任务」「知识库」与任何未登记的页面都落这里：判不准不猜（见函数说明）。
    default:
      return 'steward'
  }
}

/**
 * 五个管家的词表：与 `presets/roles.json` 的键一一对应（由 `qa/verify-preset-parity.mjs` 守住）。
 *
 * 为什么服务端再列一遍而不是去读 roles.json：服务端只判「这件事归谁办」，
 * **工具面由内核按 BF_AGENT_ROLE 读 roles.json 决定**——两边共用同一个词表，
 * 服务端多读一次文件只会多一条「文件坏了整条对话起不来」的故障路径。
 */
const AGENT_ROLES: readonly ZyAgentRole[] = ['steward', 'creator', 'publisher', 'operator', 'device']

/**
 * 把任务归属收成管家代号；空值或词表外的值一律归总管。
 *
 * 判不准不猜（与 {@link agentRoleOfFocus} 同一条纪律）：写错一个管家比写「未登记」更糟——
 * 用户会以为这件事已经交给了别人。
 *
 * @param value - 任务归属字段（`task.agentRole`）或内核角色选项。
 * @returns 管家代号（值域见 {@link ZyAgentRole}）。
 */
function asAgentRole(value: string | undefined): ZyAgentRole {
  return AGENT_ROLES.find(role => role === value) ?? 'steward'
}

/** 复盘一次的结果：写了几条记忆、几条画像；skipped 表示这一轮没到阈值。 */
export interface EvolutionReviewResult {
  /** 是否真的跑了复盘（没到阈值就是 false）。 */
  ran: boolean
  /** 新写入的记忆条数。 */
  memory: number
  /** 新写入的画像条数。 */
  user: number
  /** 超限被拒的条数（模型需要在下一次整理，不是错误）。 */
  rejected: number
  /** 新固化的技能条数（0 表示这次没有值得固化的过程）。 */
  skill: number
  /**
   * 这次写下的技能文件路径（没学到就是空串）。
   *
   * 为什么必须交回给调用方：Curator 按**账本**决定技能目录该留哪些文件，
   * 而"这条样本升格过"的标志是 record.skillPath。不写回就意味着刚学会就被自己归档——
   * 技能文件躺在 skills/archive/ 里，模型在技能目录里看不到它（2026-09-30 实测）。
   */
  learnedPath: string
  /** 这次复盘时的累计回合数（未复盘时用于观察"还差几轮"）。 */
  turns: number
}

/**
 * 复盘：把刚才这几轮的经验提炼成记忆与画像（ADR-003 口径四 / Hermes 的 Nudge + Review）。
 *
 * 什么时候跑：计数到阈值时（{@link bumpAndCheck}）。调用方要在**回复发给用户之后**再调它，
 * 否则用户会白等两次模型调用。
 *
 * 为什么超限不当失败：`addMemoryEntry` 超限时返回现有条目，这里直接把它当作
 * "这次不记"——容量已满本身就是一个信号，下一次复盘时模型会带着"现有条目"进来做整理。
 * 在没有新的整理轮之前，硬塞只会把记忆变成噪声。
 *
 * @param dataRoot - 产品数据根。
 * @param recentTurns - 最近几轮的对话/任务要点。
 * @param recentUser - 用户最近的指令原文。
 * @param llm - 当前生效的模型（与其它调用同一口径）。
 * @returns 复盘结果；未到阈值时 `ran: false`。
 */
async function runEvolutionReview(
  dataRoot: string,
  recentTurns: string,
  recentUser: string,
  toolCalls: number,
  llm: LlmOverride | undefined,
): Promise<EvolutionReviewResult> {
  const dshHome = dshHomeOf(dataRoot)
  // 两种粒度分开计（照 Hermes）：回合看"聊了多少"，迭代看"真的动了多少手"——
  // 产生经验的是后者，只按回合算会让"聊了 8 轮但没干活"和"干了一堆活"被同等对待。
  const { shouldReview, state } = bumpAndCheck(dshHome, { turns: 1, iterations: toolCalls })
  if (!shouldReview) {
    return { ran: false, memory: 0, user: 0, rejected: 0, skill: 0, learnedPath: '', turns: state.turnsSinceReview }
  }
  let memory = 0
  let user = 0
  let rejected = 0
  // 两套审查提示词各跑一次：它们关注的不是同一种东西（事实 vs 偏好），
  // 合成一次调用会让模型在两种判据之间摇摆，更容易漏记。
  const jobs: Array<{ kind: 'memory' | 'user', prompt: string }> = [
    { kind: 'memory', prompt: buildMemoryReviewPrompt(tailOf(recentTurns, 4000)) },
    { kind: 'user', prompt: buildUserReviewPrompt(tailOf(recentUser, 2000)) },
  ]
  for (const job of jobs) {
    try {
      const out = await streamLlmWithDeltas(job.prompt, undefined, llm)
      const entries = parseReviewEntries(out.text)
      if (entries.length === 0) continue
      for (const entry of entries) {
        const result = addMemoryEntry(dshHome, job.kind, entry)
        if (result.ok) {
          if (job.kind === 'memory') memory += 1
          else user += 1
          continue
        }
        rejected += 1
        // 超限：把现有条目交给模型自己整理（它是唯一有资格判断"哪条过时"的一方）。
        // 整理失败的代价只是"这次没记上"，绝不能让整轮对话因此报错。
        const merged = await streamLlmWithDeltas([
          '你的' + (job.kind === 'memory' ? '记忆' : '画像') + '已满（上限 ' + String(result.limit) + ' 字符，现在 ' + String(result.used) + '）。',
          '请把下面这些条目整理成不超过 ' + String(result.limit) + ' 字符的一组条目：合并重复的、删掉过时的、保留仍然成立的事实。',
          '每行一条，不要编号、不要解释。',
          '',
          ...result.current.map(existing => '- ' + existing.text),
          '- ' + entry,
        ].join('\n'), undefined, llm)
        const tidied = parseReviewEntries(merged.text)
        if (tidied.length > 0) {
          const written = replaceMemoryEntries(dshHome, job.kind, tidied)
          if (job.kind === 'memory') memory += written
          else user += written
        }
        break
      }
    }
    catch {
      // 复盘是"额外收益"：模型不可用、超时、返回垃圾都不该影响用户已经拿到的结果。
      // 计数不归零，下一轮还会再试。
      continue
    }
  }
  // 第三步：技能复盘（Hermes 的 Skill Review）——"这次是怎么做成的"。
  // 门槛用**工具调用次数**：有过程的任务才值得建技能，一次问答不值得占技能位。
  let skill = 0
  let learnedPath = ''
  if (toolCalls >= SKILL_REVIEW_MIN_TOOL_CALLS) {
    try {
      const out = await streamLlmWithDeltas(buildSkillReviewPrompt(tailOf(recentUser, 1200), tailOf(recentTurns, 3000)), undefined, llm)
      const draft = parseSkillReview(out.text)
      if (draft !== null) {
        const body = draft.pitfalls.trim() === '' ? draft.body : draft.body + '\n\n## 坑\n\n' + draft.pitfalls.trim()
        learnedPath = writeSkill(dshHome, {
          slug: skillSlug('review-' + new Date().toISOString().slice(0, 10), draft.name === '' ? draft.description : draft.name),
          name: skillName(draft.name === '' ? draft.description : draft.name),
          description: draft.description.slice(0, 120),
          whenToUse: draft.whenToUse.slice(0, 200),
          body: normalizeProcedure(body),
        }, 'steward')
        skill = 1
      }
    }
    catch {
      // 技能复盘失败不影响记忆/画像那两步已经落下的成果。
    }
  }
  markReviewed(dshHome)
  return { ran: true, memory, user, rejected, skill, learnedPath, turns: 0 }
}

/**
 * 从历史经验补课：把账本里"成功且绕了几步（工具调用 ≥5）"的样本逐条提炼成技能。
 *
 * 为什么需要独立入口：日常复盘（{@link runEvolutionReview}）只看**最近**几轮，
 * 账本里更早的经验没有任何通道能进来——实测 1167 条样本里有 8 条够格，一直躺着。
 * 判据与当场复盘同一套（工具调用次数），所以"补课"和"当场学"学到的是同一种东西。
 *
 * 为什么封顶每次 10 条：一条一次模型调用，补课是**背景收益**，不该让用户等，
 * 也不该在用户没要求的时候烧掉几十次调用；剩下的下次再补。
 *
 * @param dataRoot - 产品数据根。
 * @param records - 蒸馏账本。
 * @param llm - 当前生效的模型。
 * @returns 学到的技能路径与跳过条数。
 */
async function backfillSkillsFromHistory(
  dataRoot: string,
  records: readonly DistillationRecord[],
  llm: LlmOverride | undefined, tasks: readonly { id: string, agentRole?: string }[],
): Promise<{ scanned: number, learned: Array<{ id: string, path: string }>, skipped: number }> {
  const dshHome = dshHomeOf(dataRoot)
  const candidates = records.filter(record =>
    record.status === 'success'
    && (record.toolCalls ?? 0) >= SKILL_REVIEW_MIN_TOOL_CALLS
    && (record.skillPath ?? '') === '')
  const learned: Array<{ id: string, path: string }> = []
  let skipped = 0
  for (const record of candidates.slice(0, 10)) {
    try {
      const out = await streamLlmWithDeltas(
        buildSkillReviewPrompt(tailOf(record.instruction, 1200), tailOf(record.output, 3000)),
        undefined,
        llm,
      )
      const draft = parseSkillReview(out.text)
      if (draft === null) {
        skipped += 1
        continue
      }
      const body = draft.pitfalls.trim() === '' ? draft.body : draft.body + '\n\n## 坑\n\n' + draft.pitfalls.trim()
      const path = writeSkill(dshHome, {
        slug: skillSlug('history-' + record.id, draft.name === '' ? draft.description : draft.name),
        name: skillName(draft.name === '' ? draft.description : draft.name),
        description: draft.description.slice(0, 120),
        whenToUse: draft.whenToUse.slice(0, 200),
        body: normalizeProcedure(body),
      }, skillRoleOfRecord(record, tasks))
      learned.push({ id: record.id, path })
    }
    catch {
      // 单条失败不中断整轮补课：它的价值只是"这一次没学到"，下次还有机会。
      skipped += 1
    }
  }
  return { scanned: candidates.length, learned, skipped }
}

/**
 * 数据根：路由表建立时注入一次，供 {@link streamLlmWithDeltas} 这类模块级函数定位记忆文件。
 *
 * 为什么用注入而不是加进签名：{@link streamLlmWithDeltas} 被 8 个调用点共用，
 * 而它本身不关心数据放在哪、只关心"有没有记住的事"。把它加进签名意味着 8 处全改一遍，
 * 且每加一个新调用点就多一次漏传的机会；启动时注入一次，全局只有一个事实源。
 */
let memoryDataRoot = ''

/**
 * 注入数据根（{@link buildRoutes} 建立路由表时调用一次）。
 *
 * @param dataRoot - 产品数据根（`%USERPROFILE%\.bosom-friend\bosom-friend`）。
 */
export function setMemoryDataRoot(dataRoot: string): void {
  memoryDataRoot = dataRoot
  // 启动落痕：自进化是否真的装进了这个进程，只靠日志判断会被日志通道本身的差异误导。
  // 写一个标记文件，问"这段代码有没有跑"就变成一个可以用眼睛看的事实。
  try {
    const dir = join(dshHomeOf(dataRoot), 'memory')
    mkdirSync(dir, { recursive: true })
    writeDataText(join(dir, 'boot-marker.txt'), new Date().toISOString() + ' 自进化已装载\n')
  }
  catch { /* 落痕失败不影响启动 */ }
}

/**
 * 流式补全：text-delta 到达即通过 onDelta 转发（SSE 秒级首字），
 * 同时聚合全文；超时/失败由调用方落入模板兜底。
 * @param deps - 模型依赖。
 * @param prompt - 用户输入。
 * @param onDelta - 增量回调（可为空）。
 * @param override - 用户模型覆盖（设置页当前生效提供方）。
 * @param knowledgeBlock - 知识库检索命中的「已知知识」块；空串表示本次没有命中。
 * @param shouldAbort - 返回 true 时中断本轮生成（内核停止等待并关闭），已送达客户端的增量不受影响。
 * @returns 聚合全文与模型名（无输出时 text 为空串）。
 */
async function streamLlmWithDeltas(
  prompt: string,
  onDelta?: (text: string) => void,
  override?: LlmOverride,
  knowledgeBlock = '',
  shouldAbort?: () => boolean,
  onStep?: (step: KernelAgentStep) => void,
  allowTools = false,
  reuse?: KernelClient,
): Promise<{
  text: string
  model?: string
  timedOut?: boolean
  error?: string
  stream?: KernelTextStreamPart[]
  /** 这一轮调了哪些工具（纯文本调用里出现它 = 产出不可信）。 */
  toolNames?: string[]
  /** 墙钟耗时（毫秒）："越用越省"的一半判据。 */
  elapsedMs?: number
  /** 这一轮拼进提示词的上下文总字符数（知识 + 质量样例）。 */
  contextChars?: number
  /** 这一轮调了几次工具（0 也是度量值：账本据此把它算进"有度量的样本"）。 */
  toolCalls?: number
}> {
  // 统一经官方内核（ADR-001）：把操作规则+用户需求送进官方内核，SSE 增量由内核客户端回调，
  // 再不经手 openai 兼容 /chat/completions（避免第二套会话状态，符合“DSH 唯一运行时”）。
  if (override) {
    // 路由 id 与模型都来自设置页的当前生效提供方；密钥由内核从 .credentials.yaml 解析。
    // reuse 给"一个任务一个会话"用：传进来就续这个会话，不再新建进程、也不在结束时关掉它。
    // 纯文本调用（allowTools=false）不挂任何工具：这一层才是**真正的禁用**，
    // 提示词里那句"不要调用工具"只是请求（DEF-155 的预防层）。
    const kernel = reuse ?? createKernelClient(kernelOptionsOf(override, { textOnly: !allowTools }))
    try {
      // 纯文本生成（写稿、分镜、翻译…）禁工具：那些用途只要正文，模型去调工具会让请求白等
      // （见 TEXT_ONLY_GUARD 的注释）。**助手对话不禁**——产品规则第四条明确要求
      // "涉及'有多少、状态如何'先用只读工具查再回答"，禁工具等于让它凭记忆编。
      const guard = allowTools ? '' : TEXT_ONLY_GUARD
      // 产品规则（领域语境）**不在这里拼**：它写进 $DSH_HOME/AGENTS.md，
      // 由官方 agent-instructions 通道在会话建立时注入（ADR-003 口径二）。
      // 这里只剩"本次调用的语义"（纯文本 guard）与"这一轮检索到的东西"。
      // 纯文本生成**不许调工具**，但内核会话是带工具的（见 TEXT_ONLY_GUARD 的注释）：
      // 提示词拦不住的时候就只能在事后认清它——把工具调用记下来，让调用方决定要不要这份产出。
      // 真机实测（2026-09-22，DEF-155）：模型去查了一下草稿箱，然后把
      // 「抱歉，当前草稿箱里没有…这条记录」当成新标题写了回去。
      const toolNames: string[] = []
      const stepSink = (step: KernelAgentStep): void => {
        if (step.kind === 'tool-call') toolNames.push(step.call.name)
        onStep?.(step)
      }
      const startedAt = Date.now()
      // 记忆与画像**无条件进上下文**（ADR-003 口径四）：它们不是"按相关度命中的知识"，
      // 而是"每一轮都成立的事实与偏好"。挂在检索后面就会出现"明明记过、这轮偏偏没命中"的隐形失忆。
      // 放在这一层而不是各调用方：与下面 contextChars 的度量同一口径——一处生效，全部调用点同时生效。
      const memoryBlock = memoryDataRoot === '' ? '' : buildMemoryContext(dshHomeOf(memoryDataRoot))
      const contextBlock = (memoryBlock === '' ? '' : memoryBlock + '\n\n') + knowledgeBlock
      const out = await kernel.prompt(guard + contextBlock + '\n\n[用户需求]\n' + prompt, onDelta, shouldAbort, stepSink)
      // 度量：耗时与"这一轮拼进提示词的上下文有多少字"。
      // 为什么在这一层量而不是各调用方自己量：口径必须只有一套，否则"越用越省"的账本里
      // 会出现几种互相不可比的数字（这也是 S5 审计发现的：只有助手那条路记了度量）。
      const elapsedMs = Date.now() - startedAt
      const contextChars = contextBlock.length
      // 只有"这次自己建的内核"才在结束时关掉：续轮的内核归调用方的池子管（关了会话就没了）。
      if (reuse === undefined) await kernel.close().catch(() => {})
      const text = (out.text || '').trim()
      // 增量流一并回给调用方：厂商不发增量时，助手对话按它回放（逐字出现，而不是整段蹦出）。
      const stream = out.stream === undefined || out.stream.length === 0 ? {} : { stream: out.stream }
      // 纯文本任务却调了工具：**这份产出整体作废**（规则只有这一处，所有调用方一视同仁）。
      // 为什么整份丢掉而不是"再问问它"：调过工具的正文是一段**对话回复**，它不是这次任务的结果——
      // 让它在各调用方自己判断，迟早有一个忘了判，把一段回复写进用户内容（DEF-155 真机实测）。
      const measures = { elapsedMs, contextChars, toolCalls: toolNames.length }
      if (toolNames.length > 0 && !allowTools) {
        return {
          text: '',
          ...stream,
          ...measures,
          toolNames,
          error: '模型这一轮去调工具了（这类任务不需要查询），请重试',
        }
      }
      return text !== ''
        ? { text, model: override.model, ...stream, ...measures, ...(out.error ? { error: out.error } : {}) }
        : { text: '', ...stream, ...measures, ...(out.error ? { error: out.error } : {}) }
    } catch (error) {
      return { text: '', error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { text: '' }
}

/**
 * 从"账号动作的 id"里解析出 `platform|uid` 寻址。
 *
 * 桌面端本机账号在服务端没有行，两边唯一共有的标识是 (平台, uid)——
 * 所以账号动作接受这种 id（DEF-147）。
 *
 * @param id - 动作传入的 id。
 * @returns 解析出的平台与 uid；不是这种形状时返回 undefined。
 */
function accountKeyFromId(id: string): { platform: string, uid: string } | undefined {
  const at = id.indexOf('|')
  if (at <= 0 || at === id.length - 1) return undefined
  return { platform: id.slice(0, at), uid: id.slice(at + 1) }
}

/**
 * 内容寻址的来源 id：**拿不到任务 id 的模型调用也要留得下痕**。
 *
 * 为什么不硬凑一个任务 id：这些调用点在编排层深处（有的连任务 id 都没有），
 * 为了让 id 好看而把参数层层透下来，接错的概率比接对还高。内容寻址的代价是
 * "同一段提示词重复跑会覆盖同一条"——对留痕与复利来说这恰恰是要的（账本不被重复撑爆）。
 *
 * @param prefix - 用途前缀（账本里一眼看出这条是哪条路留下的）。
 * @param seed - 用来寻址的原文（一般是提示词）。
 * @returns 来源 id。
 */
function tracedSourceId(prefix: string, seed: string): string {
  return prefix + '-h' + sha8(seed).slice(0, 10)
}

function templateReply(prompt: string): string {
  const topic = prompt.replace(/\s+/g, ' ').trim().slice(0, 40) || '你的选题'
  return [
    '围绕「' + topic + '」给你一套即用内容：',
    '',
    '**标题**（三选一）',
    '1. ' + topic.slice(0, 16) + '，看完我沉默了',
    '2. 关于' + topic.slice(0, 12) + '，没人告诉你的3件事',
    '3. 别再乱试了！' + topic.slice(0, 14) + '的正确姿势',
    '',
    '**正文**',
    '最近好多朋友问我「' + topic.slice(0, 18) + '」到底怎么做，今天一次说清楚👇',
    '',
    '第一步：明确目标。不贪多，把一件小事做透就是壁垒；',
    '第二步：选对工具。方法对了，效率直接翻倍；',
    '第三步：复盘迭代。数据不会骗人，别凭感觉坚持。',
    '',
    '**标签** #干货分享 #新手必看 #效率提升',
    '',
    '> 小贴士：到「设置 → 自定义大模型」填写你自己的 API 地址和密钥，这里就会替换为大模型的完整创作（以上内容为本地模板示例，非 AI 生成）。',
  ].join('\n')
}

/**
 * 规范化智能体回复：只做空白清理，原样保留模型内容。
 * 禁止把“无法执行/请手动操作”等模型声明改写成“已完成”，避免给用户虚假的能力承诺。
 */
function normalizeAgentReply(text: string, promptText: string): string {
  void promptText
  return text.trim()
}

/**
 * 从模型回复中提取可直接发布的标题、正文与话题。
 *
 * 两条硬规则（都是 2026-09-29 现场踩出来的）：
 * ① **只认行首字段**：`标题：`/`正文：`/`话题标签：` 必须出现在行首（可带 ** - | 装饰）
 *    且必须跟冒号。句中出现的"标题""正文"是对话里的词（如"标题、正文和话题标签都由你写"），
 *    按旧写法会把后半句当成标题——实测抠出过「、正文和话题标签，由前端完成发布并回读作品链接。」。
 * ② **取最后一次出现**：模型常先说一段（例如"在你重新扫码之前，我先按你的要求把文案写好备用"），
 *    再把正式文案附在后面；文案才是最后那一段，取第一处只会抓到对话。
 *
 * @param text - 模型这一轮的完整回复。
 * @returns 标题（≤30 字）、正文（≤5000 字）与话题标签。
 */
function extractPublishContent(text: string): { title: string, body: string, topics: string[] } {
  const titleRe = /(?:^|\n)[ \t]*(?:\*\*|-\s*|\|\s*)?(?:视频|图文|笔记)?\s*(?:标题|Title)\s*(?:\*\*)?\s*[：:]\s*([^\n|*]+)/gim
  const titleHits = [...text.matchAll(titleRe)]
  const title = titleHits.length > 0
    ? ((titleHits[titleHits.length - 1]?.[1]) ?? '').replace(/[*_`>]/g, '').trim()
    : ''
  const bodyRe = /(?:^|\n)[ \t]*(?:\*\*)?(?:视频|图文|笔记)?\s*(?:正文|内容|文案)\s*(?:\*\*)?\s*[：:]\s*/gim
  const bodyHits = [...text.matchAll(bodyRe)]
  let body = ''
  const lastBody = bodyHits.length > 0 ? bodyHits[bodyHits.length - 1] : undefined
  if (lastBody !== undefined) {
    const hit = lastBody
    const start = (hit.index ?? 0) + hit[0].length
    const after = text.slice(start)
    // 正文的结束位置：遇到下一个**小节标题**就停。少列一节就会把下面那节当正文发出去
    // ——实测把“封面与素材建议”整段当正文发到了平台（2026-09-29 用户现场）。
    const endMatch = after.search(/\n\s*(?:\*\*)?(?:封面|素材|配图|图片|话题|标签|同步账号|前端动作卡片|AI客服|AI 客服|注意事项?|提示|建议)[^\n]{0,12}[：:]?/)
    body = (endMatch >= 0 ? after.slice(0, endMatch) : after)
      .replace(/\n\s*[-—–]{3,}\s*\n[\s\S]*$/g, '')
      .replace(/[*_`>]/g, '')
      .trim()
  }
  // 正文兜底：逐行留下“像正文的话”，剥掉元信息行。拿不到正文时宁可少发，也不发对话原文。
  if (body === '') {
    body = text
      .split(/\n+/)
      .map(line => line.replace(/[*_`>|]/g, '').replace(/^\s*[-•]\s*/, '').trim())
      .filter(line => line.length >= 8 && !META_LINE.test(line))
      .join('\n')
      .trim()
  }
  const tagRe = /(?:^|\n)[ \t]*(?:\*\*)?(?:话题标签|话题|标签|Tags)\s*(?:\*\*)?\s*[：:]\s*([^\n]+)/gim
  const tagHits = [...text.matchAll(tagRe)]
  const tagLine = tagHits.length > 0 ? ((tagHits[tagHits.length - 1]?.[1]) ?? '') : ''
  const topics = Array.from(new Set(
    tagLine
      .split(/[#\s,，、|]+/)
      .map(part => part.replace(/[*_`>（）()【】\[\]]/g, '').trim())
      // 标签里不该出现句号/问号/逗号——那是句子不是标签
      // （实测抠出过「由前端完成发布并回读作品链接。」这种）。
      .filter(part => part.length >= 2 && part.length <= 12 && !/[。！？!?；;，,]/.test(part)),
  )).slice(0, 10)
  return {
    title: title.slice(0, 30),
    body: body.slice(0, 5000),
    topics,
  }
}

/**
 * 元信息行：助手对用户说的话、字段清单、风险提示。它们不是要发给平台看的正文。
 */
const META_LINE = /^(?:已核对|已确认|好的|收到|请点击|请查收|说明|注意|备注|风险提示|需要提醒|素材|内容标注|账号|平台|标题|封面|正文|话题|标签|发布)/

/** 明确要求把内容发布出去的说法。 */
const PUBLISH_REQUEST = /(发布|发出去|发到|发去|发一条|发个|发一篇|上传到|投稿|同步到)/

/**
 * 只是在打听发布相关的事，并不是在要求发布：命中这些说法一律不算发布指令。
 * 少了这道排除，「帮我看看发布记录」「发布频率怎么设置」都会被当成发布命令。
 */
const PUBLISH_TOPIC = /(发布日历|发布记录|发布数据|发布时间|发布规则|发布频率|发布失败|发布列表|发布历史|发布计划|发布任务|发布状态|发布效果|发布渠道|发布设置)/

/**
 * 否定式说法：用户明确表示不发，或用了表达「没这个打算」的说法。
 *
 * 2026-10-09 复现（DEF-240）：「我不打算发布，只是问问。」原列表只收「不要发布」这类直否定，
 * 漏掉「不打算 / 不想 / 无意」这种把否定加在**打算**上的说法，于是被判成发布指令。
 */
// 「不要发」后面跟「成/错」时是**质量约束**（"不要发成别的内容"＝只发这一条），不是拒发：
// 2026-10-13 真机考试现场，句中的"不要发成别的内容"让整句被判成否定 → 页脚错误地告诉用户
// "内容已生成，尚未发布"。真正的拒发说法（不要发这条 / 别发了）不受影响。
const PUBLISH_NEGATION = /(不要发布|不发布|先别发|别发布|不用发布|不需要发布|暂不发布|先不发布|不要发(?!成|错)|先别发布|不打算发|没打算发|不准备发|不想发|无意发|没想发|暂时不发|不用发|不发)/

/**
 * 疑问 / 假设 / 讨论语气：句中出现这些说法时，发布措辞属于**讨论发布**，而非要求发布。
 */
const PUBLISH_MENTION_ONLY = /(如果|假如|假设|要是|万一|是不是|是否|算不算|能不能|可不可以|可以吗|行不行|怎么|如何|为什么|什么|意思|区别|流程|了解一下|问一下|请问|咨询|问问|想知道|请教)/

/**
 * 句末疑问语气：以「吗 / 呢 / 么」或问号收尾的句子是在**问**，不是在**要求**。
 *
 * 2026-10-09 复现（DEF-240）：「你能帮我发布吗？」句中有发布措辞、无任何已收录的疑问词，
 * 被判成发布指令。仅靠词表列举问法无法穷尽，句末语气是更稳的判据。
 */
const PUBLISH_INTERROGATIVE_TAIL = /(吗|呢|么)[\s。.!！~]*$|[?？]\s*$/

/**
 * 引述 / 转述他人指令：发布措辞处在「他说 / 让我 / 要求我」的从属结构里，
 * 说话人是在**转述或求助**，不是在下达自己的发布指令。
 */
const PUBLISH_QUOTED_INSTRUCTION = /(他说|她说|老板说|客户说|同事说|领导说|对方说|让我|叫我|要求我|要求我们|转述|引用|别人说)/

/**
 * 判定用户这一句话是否明确要求把内容发布出去。
 *
 * 发布是对外且不可撤销的动作，默认不做：跟随模式下前端会自动执行「去发布」动作卡，
 * 没有这道判定，用户只是想写篇文案，成品就已经被发到平台上了。
 * 因此只认用户亲口说出的发布措辞，创作类请求（写、生成、做个脚本）一律不算。
 *
 * **判定顺序即优先级**：先要求出现发布动作措辞，再逐条排除否定 → 讨论 → 疑问语气 → 引述。
 * 任何一类命中都返回 false —— **判不出明确意图时按未授权处理**（fail-closed），
 * 用户仍可走人工确认路径发布。
 *
 * **本函数返回 true 只是启发式结论，不等于可靠的用户授权。** 它可能漏掉未收录的说法；
 * 调用方不得据此认为「未经授权的发布已被杜绝」，自动执行的最终依据是它算出的 `explicitPublishIntent`，
 * 该标记只是必要条件，不是充分的安全证明。
 *
 * @param prompt - 用户这一轮的原始输入。
 * @returns true 表示用户明确要求发布；false 表示未确认发布意图（含否定、讨论、疑问、引述）。
 */
export function detectPublishIntent(prompt: string): boolean {
  const text = prompt.trim()
  if (!PUBLISH_REQUEST.test(text)) return false
  if (PUBLISH_TOPIC.test(text)) return false
  if (PUBLISH_NEGATION.test(text)) return false
  if (PUBLISH_MENTION_ONLY.test(text)) return false
  if (PUBLISH_INTERROGATIVE_TAIL.test(text)) return false
  if (PUBLISH_QUOTED_INSTRUCTION.test(text)) return false
  return true
}

/**
 * 取出**当前轮用户消息**的文本，专供发布意图判定使用。
 *
 * 与 `extractPrompt` 的差别在数组输入：`extractPrompt` 把数组里所有文本项拼起来，
 * 客户端可以借此把历史对话里的发布指令混进判定；本函数只取**最后一个文本项**——
 * 客户端 `buildClaudePrompt` 固定把用户文本追加在数组末尾，此前的项都是媒体描述。
 * 数组里没有文本项、或类型不可识别时返回空串：**宁可判不出发布意图，也不拿旧文本当授权**。
 *
 * 2026-10-09（DEF-240）：原实现用 `extractPrompt(params.prompt)` 判定，存在上述混入路径。
 *
 * @param prompt - 请求体里的 `prompt`（字符串，或 Claude Prompt 格式数组）。
 * @returns 当前轮用户文本；无法可靠识别时为空串。
 */
export function extractCurrentTurnText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const item = prompt[i] as { text?: unknown; content?: unknown } | string
    if (typeof item === 'string') return item
    if (typeof item?.text === 'string') return item.text
    if (typeof item?.content === 'string') return item.content
  }
  return ''
}

/**
 * 从部署环境读长视频重试策略；没配（或配得不可解析）时用编排层的默认策略。
 *
 * 空串必须按"没配"处理：`Number('')` 是 0，而 `Number.isInteger(0)` 又为真，于是"没配"
 * 会被读成"一镜都不重试"——厂商一次网络抖动就把整条多镜任务判死（实测 2026-09-17：
 * 第 1 镜 20 秒超时后整条失败，三次重试一次都没发生）。延迟表同理：空串会解析成 `[0]`。
 *
 * @param env - 部署环境，默认 `process.env`；读 `BF_LONG_VIDEO_RETRY_ATTEMPTS` 与 `BF_LONG_VIDEO_RETRY_DELAYS_MS`。
 * @returns 本次部署使用的重试策略。
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): LongVideoRetryPolicy {
  const attemptsText = (env.BF_LONG_VIDEO_RETRY_ATTEMPTS ?? '').trim()
  const parsedAttempts = attemptsText === '' ? Number.NaN : Number(attemptsText)
  const delaysMs = (env.BF_LONG_VIDEO_RETRY_DELAYS_MS ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(part => Number(part))
    .filter(value => Number.isFinite(value) && value >= 0)
  return {
    attempts: Number.isInteger(parsedAttempts) && parsedAttempts >= 0 ? parsedAttempts : DEFAULT_RETRY_POLICY.attempts,
    delaysMs: delaysMs.length > 0 ? delaysMs : DEFAULT_RETRY_POLICY.delaysMs,
  }
}

/**
 * 从部署环境读媒体预算上限；没配（或配得不可解析）时返回 undefined，由看门狗用默认上限。
 *
 * 为什么要一个上限：预算按档位推导后，1 分钟档是 15 片 × 4 分 10 秒 ≈ 68 分钟，
 * 5 分钟长视频是 50 片 ≈ 3 小时 33 分——都远超旧的定值。上限是防止档位算错时任务无限挂住，
 * 不是用来压缩诚实等待时间的，因此默认给足 4 小时，只有部署方显式配置才收紧。
 *
 * 空串必须按"没配"处理：Number('') 是 0，会把上限读成 0 从而把每条视频立刻判超时。
 *
 * @param env - 部署环境，默认 process.env；读 BF_MEDIA_BUDGET_MAX_MS。
 * @returns 上限毫秒数；没配或不可解析时为 undefined。
 */
export function mediaBudgetMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const text = (env.BF_MEDIA_BUDGET_MAX_MS ?? '').trim()
  if (text === '')
    return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** 本地兜底模型的名字：选到它们时走本地排版/幻灯片，不调厂商（省钱也不至于报错）。 */
export const LOCAL_TEMPLATE_IMAGE_MODEL = 'zy-template-image'
export const LOCAL_TEMPLATE_VIDEO_MODEL = 'zy-template-video'

/** 用户级模型覆盖：请求携带 llm { baseUrl, apiKey, model } 时走各自厂商（OpenAI 兼容）；未配置则回退内置模板。 */
export interface LlmOverride {
  baseUrl: string
  apiKey: string
  model: string
  /** 图片生成模型（OpenAI 兼容 /images/generations）；缺省沿用对话配置尝试。 */
  imageBaseUrl?: string
  imageApiKey?: string
  imageModel?: string
  /** 视频生成模型（OpenAI 兼容 /videos/generations 或厂商扩展）；缺省用 AI 图片合成视频。 */
  videoBaseUrl?: string
  videoApiKey?: string
  videoModel?: string
  /** 展示名称（设置页卡片标题）；缺省由前端按 baseUrl 推断。 */
  displayName?: string
  /** API 协议标识（如 openai-completions）；当前仅用于设置页展示与后续扩展。 */
  protocol?: string
  /** 模型目录：可选模型 id 列表，第一个为当前对话模型。 */
  models?: string[]
  /** 模型显示名称：模型 id -> 展示名。 */
  modelLabels?: Record<string, string>
  /** 多提供方配置（设置页卡片列表）。 */
  providers?: LlmProviderEntry[]
  /** 当前生效的提供方 id；缺省取 providers 第一项。 */
  activeProviderId?: string
}

/** 设置页的单个模型提供方。 */
export interface LlmProviderEntry {
  id: string
  displayName: string
  /** 内置提供方不可删除（APP 内置的 Agnes AI 官方模型就是这种）。 */
  builtin?: boolean
  baseUrl: string
  apiKey: string
  protocol?: string
  models?: string[]
  modelLabels?: Record<string, string>
  /** 每个模型的完整配置：显示名称 / 上下文窗口 / 最大输出 tokens。 */
  modelOptions?: Record<string, LlmModelOption>
}

/** 单个模型的可编辑配置。 */
export interface LlmModelOption {
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** 模型用途（对话 / 图片 / 视频）；产品侧使用，不投影进内核 settings.yaml。 */
  kind?: string
}

/**
 * 接口地址是不是 Agnes（APP 内置的系统大模型厂商）。
 *
 * 空地址按内置处理：用户只填了一个 API Key 时，接口地址就是内置的官方基址。
 * 自建代理或其它厂商不会被误判成内置（否则会把 Agnes 的模型名塞进别人的服务）。
 *
 * @param baseUrl - 配置里的接口地址。
 * @returns true 表示走内置 Agnes 规格。
 */
export function isAgnesBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim().toLowerCase()
  if (trimmed === '') return true
  return /^https?:\/\/([a-z0-9-]+\.)*agnes-ai\.(cn|com)(\/|$)/.test(trimmed)
}

/** 从请求体提取合法覆盖（缺 apiKey 视为未配置；Agnes 内置服务允许只填 Key）。 */
export function parseLlmOverride(input: unknown): LlmOverride | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const o = input as Record<string, unknown>
  const rawBaseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : ''
  const model = typeof o.model === 'string' ? o.model.trim() : ''
  // 内置 Agnes：只填一个 API Key 就该能用文本/图片/视频——地址与三个通道的模型都由内置规格补齐。
  const builtin = apiKey !== '' && isAgnesBaseUrl(rawBaseUrl)
  const baseUrl = builtin && rawBaseUrl === '' ? AGNES_BASE_URL : rawBaseUrl
  if (builtin ? apiKey === '' : (!/^https?:\/\//.test(baseUrl) || apiKey === '' || model === '')) return undefined
  if (!builtin && model === '') return undefined
  const pick = (prefix: 'image' | 'video') => {
    const b = typeof o[prefix + 'BaseUrl'] === 'string' ? String(o[prefix + 'BaseUrl']).trim() : ''
    const k = typeof o[prefix + 'ApiKey'] === 'string' ? String(o[prefix + 'ApiKey']).trim() : ''
    const m = typeof o[prefix + 'Model'] === 'string' ? String(o[prefix + 'Model']).trim() : ''
    return { baseUrl: b, apiKey: k, model: m }
  }
  const image = pick('image')
  const video = pick('video')
  const displayName = typeof o.displayName === 'string' ? o.displayName.trim() : ''
  const protocol = typeof o.protocol === 'string' ? o.protocol.trim() : ''
  const models = Array.isArray(o.models)
    ? o.models.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    : []
  const modelLabels = typeof o.modelLabels === 'object' && o.modelLabels !== null
    ? Object.fromEntries(Object.entries(o.modelLabels as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
      .map(([key, value]) => [key, value.trim()]))
    : {}
  const providers = Array.isArray(o.providers)
    ? o.providers.flatMap((item): LlmProviderEntry[] => {
      if (typeof item !== 'object' || item === null) return []
      const entry = item as Record<string, unknown>
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (id === '') return []
      return [{
        id,
        displayName: typeof entry.displayName === 'string' ? entry.displayName.trim() : id,
        ...(entry.builtin === true ? { builtin: true } : {}),
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '',
        apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '',
        ...(typeof entry.protocol === 'string' && entry.protocol.trim() !== '' ? { protocol: entry.protocol.trim() } : {}),
        ...(Array.isArray(entry.models) ? { models: entry.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim()) } : {}),
        ...(typeof entry.modelLabels === 'object' && entry.modelLabels !== null ? { modelLabels: entry.modelLabels as Record<string, string> } : {}),
        ...(typeof entry.modelOptions === 'object' && entry.modelOptions !== null ? { modelOptions: entry.modelOptions as Record<string, LlmModelOption> } : {}),
      }]
    })
    : []
  const activeProviderId = typeof o.activeProviderId === 'string' ? o.activeProviderId.trim() : ''
  // 型号一律来自用户配置：产品只内置服务商（Agnes 的地址与协议），**不内置任何大模型**。
  // 没配型号就是没配——不拿一个"官方默认档"顶上，否则用户在界面上看不到自己选了什么，
  // 而实际请求发的是我们替他挑的那个型号。
  const imageModel = image.model
  const videoModel = video.model
  return {
    baseUrl,
    apiKey,
    model,
    ...(displayName !== '' ? { displayName } : (builtin ? { displayName: AGNES_DISPLAY_NAME } : {})),
    ...(providers.length > 0 ? { providers } : {}),
    ...(activeProviderId !== '' ? { activeProviderId } : {}),
    ...(protocol !== '' ? { protocol } : (builtin ? { protocol: AGNES_PROTOCOL } : {})),
    ...(models.length > 0 ? { models } : {}),
    ...(Object.keys(modelLabels).length > 0 ? { modelLabels } : {}),
    ...(imageModel !== '' ? { imageBaseUrl: image.baseUrl || baseUrl, imageApiKey: image.apiKey || apiKey, imageModel } : {}),
    ...(videoModel !== '' ? { videoBaseUrl: video.baseUrl || baseUrl, videoApiKey: video.apiKey || apiKey, videoModel } : {}),
  }
}

/** 读取本机服务端保存的用户大模型配置（浏览器 localStorage 的权威副本，供无 llm 覆写的请求使用）。 */
export function readStoredLlm(dataRoot: string): LlmOverride | undefined {
  try {
    return parseLlmOverride(JSON.parse(readFileSync(join(dataRoot, 'llm-user.json'), 'utf8')))
  } catch {
    return undefined
  }
}

/** 读取本机保存的原始大模型配置（含多提供方列表）；缺失或损坏返回 undefined。 */
export function readStoredLlmRaw(dataRoot: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dataRoot, 'llm-user.json'), 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * 记住"这家厂商的视频只收到哪一档"。
 *
 * 为什么值得记：实测厂商每次都用 `400 + data.valid_sizes` 拒收用户档位（1080P），
 * 于是**每一镜**都要多花一次被拒的下单——在限流（429）窗口里这等于把有限的额度
 * 白花三成，还多占一轮排队。记住结论之后，同一个模型直接用厂商认的档位下单。
 *
 * 键按模型分：不同模型的支持档位可能不同，用同一个键会把结论串味。
 *
 * @param dataRoot - 产品数据根。
 * @param baseUrl - 厂商基址（换端点后旧结论不适用）。
 * @param model - 视频模型名。
 * @returns 已记住的档位；没记过时为空串。
 */
function rememberedVideoSize(dataRoot: string, baseUrl: string, model: string): string {
  const raw = readStoredLlmRaw(dataRoot)
  const memory = raw?.videoSizeMemory
  if (typeof memory !== 'object' || memory === null) return ''
  const entry = (memory as Record<string, unknown>)[videoSizeKey(baseUrl, model)]
  return typeof entry === 'string' ? entry : ''
}

/**
 * 记下这家厂商这个模型认的档位。
 *
 * 只在**证实可用**之后写（下单成功或由厂商自报档位降级成功）：写进配置文件的是结论，
 * 不是猜测。写失败只记日志——少一条优化不能反过来影响出片。
 *
 * @param dataRoot - 产品数据根。
 * @param baseUrl - 厂商基址。
 * @param model - 视频模型名。
 * @param size - 厂商认的档位。
 */
function rememberVideoSize(dataRoot: string, baseUrl: string, model: string, size: string): void {
  try {
    const current = readStoredLlmRaw(dataRoot)
    if (current === undefined || typeof current.model !== 'string' || current.model === '') return
    const memory = typeof current.videoSizeMemory === 'object' && current.videoSizeMemory !== null
      ? current.videoSizeMemory as Record<string, unknown>
      : {}
    memory[videoSizeKey(baseUrl, model)] = size
    writeDataJson(join(dataRoot, 'llm-user.json'), { ...current, videoSizeMemory: memory })
  }
  catch (error) {
    console.error('[AI_VID_ERR] 记住厂商档位失败 ' + String(error))
  }
}

/**
 * 档位记忆的键：厂商基址 + 模型名。
 *
 * @param baseUrl - 厂商基址。
 * @param model - 视频模型名。
 * @returns 记忆键。
 */
function videoSizeKey(baseUrl: string, model: string): string {
  return baseUrl.replace(/\/+$/, '') + '|' + model
}

/**
 * 这把 Key 有没有这个模型的权限。
 *
 * Agnes 按 Key 白名单放行：`GET /v1/models` 列出全部模型，实际可用的只是一部分
 * （实测 `agnes-video-2.5` 与 `agnes-image-2.5-flash` 都回过 403 team_model_access_denied）。
 * 结论落盘有两个用处：生成时不再反复试一个注定 403 的模型；模型清单据此如实标注，
 * 而不是让用户选一个永远出不来东西的模型（DEF-067 的同一个坑）。
 *
 * @param dataRoot - 产品数据根。
 * @param baseUrl - 厂商基址。
 * @param model - 模型名。
 * @returns true 表示已记录为"该 Key 无权限"。
 */
function modelDenied(dataRoot: string, baseUrl: string, model: string): boolean {
  const raw = readStoredLlmRaw(dataRoot)
  const memory = raw?.modelDeniedMemory
  if (typeof memory !== 'object' || memory === null) return false
  return (memory as Record<string, unknown>)[videoSizeKey(baseUrl, model)] === true
}

/**
 * 记下"这把 Key 没有这个模型的权限"。
 *
 * 只在厂商真的回过 401/403 之后写：写进配置文件的是结论，不是猜测。
 *
 * @param dataRoot - 产品数据根。
 * @param baseUrl - 厂商基址。
 * @param model - 模型名。
 */
function rememberModelDenied(dataRoot: string, baseUrl: string, model: string): void {
  try {
    const current = readStoredLlmRaw(dataRoot)
    if (current === undefined) return
    const memory = typeof current.modelDeniedMemory === 'object' && current.modelDeniedMemory !== null
      ? current.modelDeniedMemory as Record<string, unknown>
      : {}
    memory[videoSizeKey(baseUrl, model)] = true
    writeDataJson(join(dataRoot, 'llm-user.json'), { ...current, modelDeniedMemory: memory })
  }
  catch (error) {
    console.error('[AI_VID_ERR] 记住模型无权限失败 ' + String(error))
  }
}

/**
 * 内核模型路由 id：设置页里的提供方 id 映射到 DSH `llm-pi-ai` 命名空间下的路由名。
 *
 * agnes 沿用内核补丁里已有的路由；其余加 `bf-` 前缀，避免与内置适配器（如 llm-deepseek）
 * 的路由重名。路由名必须满足 pi-ai 的标识符规则（小写字母开头、连字符分段）。
 *
 * @param providerId - 设置页里的提供方 id。
 * @returns 内核可用的路由 id。
 */
/**
 * 通道的接口地址 → 内核里的媒体路由 id。
 *
 * 设置页保存时把每个「服务」写成 `settings.yaml` 的 `media-pi-ai` 路由（id 同 {@link kernelRouteId}），
 * 而图片/视频通道只存了 baseUrl。这里按地址找回它属于哪个服务；找不到就返回 undefined——
 * 调用方据此如实报"请重新保存一次模型配置"，绝不悄悄换一条路由去下单。
 *
 * @param providers - 已保存的服务列表（旧式单配置时为空）。
 * @param baseUrl - 通道的接口地址。
 * @returns 内核可用的路由 id；对不上时 undefined。
 */
function mediaRouteFor(providers: readonly LlmProviderEntry[] | undefined, baseUrl: string): string | undefined {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base === '') return undefined
  const owner = (providers ?? []).find(item => item.baseUrl.trim().replace(/\/+$/, '') === base)
  return owner === undefined ? undefined : kernelRouteId(owner.id)
}

export function kernelRouteId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (normalized === '' || normalized === 'agnes') return 'agnes'
  return 'bf-' + normalized
}

/** 提供方 API 密钥在 DSH 凭据文档中的引用名。 */
export function kernelCredentialRef(providerId: string): string {
  return 'BF_' + providerId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
}

/** 把一个 YAML 标量安全地写成单行（必要时加引号）。 */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return JSON.stringify(value)
}

/**
 * 替换 `settings.yaml` 里的一个顶层段，其它命名空间原样保留。
 *
 * 逐行定位段首与段尾：段内是缩进行与空行，遇到下一个顶层键即结束。
 * （不用正则的 \z —— JS 不支持，之前因此把新段追加成重复键。）
 *
 * @param settingsPath - `settings.yaml` 路径。
 * @param key - 顶层段名（如 `llm-pi-ai`）。
 * @param sectionLines - 该段的完整行（首行是 `<key>:`）。
 */
function replaceSettingsSection(settingsPath: string, key: string, sectionLines: string[]): void {
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
  const lines = existing.split(/\r?\n/)
  const start = lines.findIndex(line => new RegExp('^' + key + ':\\s*$').test(line))
  if (start === -1) {
    const next = (existing.trim() === '' ? '' : existing.replace(/\s*$/, '') + '\n') + sectionLines.join('\n') + '\n'
    writeDataText(settingsPath, next)
    return
  }
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line === undefined || (line.trim() !== '' && !/^\s/.test(line))) break
    end += 1
  }
  let next = [...lines.slice(0, start), ...sectionLines, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
  if (!next.endsWith('\n')) next += '\n'
  writeDataText(settingsPath, next)
}

/**
 * 把设置页的模型配置写进 DSH 的用户设置与凭据文档，让内核真正使用这些提供方。
 *
 * 只替换 `settings.yaml` 里的 `llm-pi-ai:` 与 `media-pi-ai:` 两个顶层段，其它命名空间原样保留；
 * 凭据文档写 `version: 1` + `refs`，密钥按路由引用名存放。
 *
 * **配了自建配音来源时，它也被写成一条媒体路由**（`bf-voice`）：语音出网因此与其他媒体一样只经过
 * Provider——产品侧不再持有那个端点与密钥（0 号铁律第 2 条）。语音配置从磁盘读而不是当参数传：
 * 两个入口（保存模型配置、保存配音来源）都要写同一份段，参数化只会让其中一个忘了带上它。
 *
 * @param dataRoot - 产品数据根（DSH_HOME 下的 bosom-friend 目录）。
 * @param providers - 设置页提交的提供方列表。
 */
function writeKernelModelSettings(dataRoot: string, providers: LlmProviderEntry[]): void {
  const dshHome = dirname(dataRoot)
  const usable = providers.filter(item => item.baseUrl.trim() !== '' && (item.models ?? []).length > 0)

  const sectionLines: string[] = ['llm-pi-ai:', '  providers:']
  if (usable.length === 0) {
    sectionLines[1] = '  providers: {}'
  }
  for (const provider of usable) {
    sectionLines.push('    ' + kernelRouteId(provider.id) + ':')
    sectionLines.push('      displayName: ' + yamlScalar(provider.displayName))
    sectionLines.push('      apiKeyEnv: ' + kernelCredentialRef(provider.id))
    sectionLines.push('      api: ' + yamlScalar(provider.protocol ?? 'openai-completions'))
    sectionLines.push('      baseURL: ' + yamlScalar(provider.baseUrl.trim()))
    sectionLines.push('      models:')
    for (const model of provider.models ?? []) {
      const option = provider.modelOptions?.[model]
      sectionLines.push('        - id: ' + yamlScalar(model))
      if (option?.name !== undefined && option.name !== '') sectionLines.push('          name: ' + yamlScalar(option.name))
      if (option?.contextWindow !== undefined) sectionLines.push('          contextWindow: ' + String(option.contextWindow))
      if (option?.maxTokens !== undefined) sectionLines.push('          maxTokens: ' + String(option.maxTokens))
    }
  }

  // 图片/视频的路由与对话**同源**：同一个服务地址、同一份凭据 ref，只多声明一个方言。
  // 媒体能力面（packages/media 的 media-pi-ai 提供方）读的就是这一段。
  const mediaSectionLines: string[] = ['media-pi-ai:', '  providers:']
  if (usable.length === 0) mediaSectionLines[1] = '  providers: {}'
  for (const provider of usable) {
    mediaSectionLines.push('    ' + kernelRouteId(provider.id) + ':')
    mediaSectionLines.push('      displayName: ' + yamlScalar(provider.displayName))
    mediaSectionLines.push('      apiKeyEnv: ' + kernelCredentialRef(provider.id))
    mediaSectionLines.push('      api: ' + (isAgnesBaseUrl(provider.baseUrl.trim()) ? 'agnes' : 'openai'))
    mediaSectionLines.push('      baseURL: ' + yamlScalar(provider.baseUrl.trim()))
  }

  const settingsPath = join(dshHome, 'settings.yaml')
  try {
    mkdirSync(dshHome, { recursive: true })
    replaceSettingsSection(settingsPath, 'llm-pi-ai', sectionLines)
    replaceSettingsSection(settingsPath, 'media-pi-ai', mediaSectionLines)

    // 凭据文档：保留其它来源的引用，只重写本产品管理的 BF_*_API_KEY。
    const credentialsPath = join(dshHome, '.credentials.yaml')
    const existingCredentials = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : ''
    const keptRefs = existingCredentials
      .split(/\r?\n/)
      .filter(line => /^\s{2}[A-Z0-9_]+:/.test(line) && !/^\s{2}BF_[A-Z0-9_]+_API_KEY:/.test(line))
    const ourRefs = usable
      .filter(item => (item.apiKey ?? '').trim() !== '')
      .map(item => '  ' + kernelCredentialRef(item.id) + ': ' + yamlScalar((item.apiKey ?? '').trim()))
    const refs = [...keptRefs, ...ourRefs]
    if (refs.length > 0 || existingCredentials !== '') {
      writeDataText(credentialsPath, 'version: 1\n\nrefs:\n' + refs.join('\n') + '\n')
    }
  }
  catch {
    // 设置文件写失败不影响产品自身配置；内核下次启动仍用上一次成功的路由。
  }
}

/**
 * 模型配置写入审计：每次改动 llm-user.json 留一行，谁在什么时候写了几个服务、是不是清空。
 *
 * DEF-034（配置被整份清空）事后无法定位发起方，就是因为没有这行日志；
 * 下次再出现，翻 `<dataRoot>/logs/llm-config-audit.log` 就能对上是设置页、探针还是自动化。
 *
 * @param dataRoot - 产品数据根。
 * @param action - 触发写入的动作名（providers / legacy / cleanup）。
 * @param detail - 本次写入的关键事实（服务数量、是否清空、UA 等）。
 */
function auditLlmWrite(dataRoot: string, action: string, detail: Record<string, unknown>): void {
  try {
    const dir = join(dataRoot, 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'llm-config-audit.log'), JSON.stringify({ at: nowIso(), action, ...detail }) + '\n', 'utf8')
  }
  catch {
    // 审计写不进去（磁盘满/权限）不能反过来让配置保存失败。
  }
}

/**
 * 写入本机服务端用户大模型配置；传 null 表示清除。
 *
 * @param dataRoot - 产品数据根。
 * @param cfg - 要写入的配置；null 表示清空为默认空配置。
 * @returns 写入失败时的原因；成功返回 undefined。
 */
export function writeStoredLlm(dataRoot: string, cfg: LlmOverride | null): string | undefined {
  try {
    mkdirSync(dataRoot, { recursive: true })
    writeDataJson(join(dataRoot, 'llm-user.json'), cfg ?? { baseUrl: '', apiKey: '', model: '' })
    return undefined
  } catch (error) {
    // 以前这里静默吞掉，调用方照样回成功：用户以为模型配置保存了，实际没落盘，
    // 下次启动发现配置没了却无从解释。写失败必须让保存接口如实报错。
    return error instanceof Error ? error.message : String(error)
  }
}

/** 从平台登录 cookie 中提取创作者 UID（不回显 cookie 内容）。 */
function uidFromLoginCookie(loginCookie: string | undefined): string {
  if (typeof loginCookie !== 'string' || loginCookie === '')
    return ''
  try {
    const cookies = JSON.parse(loginCookie) as { name?: unknown; value?: unknown }[]
    const match = Array.isArray(cookies)
      ? cookies.find(cookie => typeof cookie?.name === 'string' && cookie.name.includes('x-user-id-creator'))
      : undefined
    return typeof match?.value === 'string' ? match.value : ''
  }
  catch {
    return ''
  }
}

/** 数据库曾因恢复误用默认昵称时，从本产品历史备份找回真实账号资料；只补资料，不改 cookie。 */
function restoreAccountProfilesFromBackups(dataRoot: string, files: ReturnType<typeof openStore>['files']): void {
  const accounts = files.accounts.load()
  let changed = false
  const backupsDir = join(dataRoot, 'backups')
  const backupDirs = existsSync(backupsDir)
    ? readdirSync(backupsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .reverse()
    : []

  for (const account of accounts) {
    if (account.nickname !== '小红书' && account.nickname !== '' && account.nickname !== '平台账号')
      continue
    const currentUid = uidFromLoginCookie(account.loginCookie)
    if (account.uid === '')
      account.uid = currentUid

    const candidateMatchesUid = (candidate: { uid?: string; loginCookie?: string }): boolean => {
      if (currentUid === '')
        return true
      return candidate.uid === currentUid || uidFromLoginCookie(candidate.loginCookie) === currentUid
    }

    for (const dirName of backupDirs) {
      const backupFile = join(backupsDir, dirName, 'accounts.json')
      if (!existsSync(backupFile))
        continue
      try {
        const backupAccounts = JSON.parse(readFileSync(backupFile, 'utf8')) as typeof accounts
        const recovered = backupAccounts.find(candidate =>
          candidate.type === account.type
          && candidate.nickname !== '小红书'
          && candidate.nickname !== ''
          && candidate.nickname !== '平台账号'
          && candidateMatchesUid(candidate),
        )
        if (recovered === undefined)
          continue
        account.nickname = recovered.nickname
        if (recovered.avatar)
          account.avatar = recovered.avatar
        if (account.uid === '')
          account.uid = recovered.uid || currentUid
        account.updateTime = nowIso()
        changed = true
        break
      }
      catch {
        // 备份损坏不影响启动
      }
    }
  }

  if (changed)
    files.accounts.save(accounts)
}

interface Deps {
  dataRoot: string
  store: ReturnType<typeof openStore>
  security: SecurityReport
  kernelAi: boolean
  /**
   * 内核媒体能力面（`ctx.media`）的取用口。
   *
   * 每次调用现取而不是在装载时抓一次：补丁层的挂载顺序不保证 media 先于本插件，
   * 而能力面缺席时必须**如实失败**（不许退回直连），所以"有没有"要在调用点判定。
   *
   * @returns 媒体服务；组合里没挂时 undefined。
   */
  media: () => MediaCaller | undefined
}

/**
 * 产品侧用到的媒体能力面：`ctx.media` 的三个操作。
 *
 * 只声明用得到的那部分，测试装置（`server/test/harness.ts`）才能拿一个直接构造的实现顶上来，
 * 而不必为了跑一条业务路径去起一整个 cordis 运行时。
 */
export type MediaCaller = Pick<MediaRuntime, 'generateImage' | 'submitVideo' | 'pollVideo'>

const uploadsMeta = new Map<string, string>()

/**
 * 视频素材登记：把抽出来的帧与音轨落盘为素材，返回可引用的地址。
 *
 * @param input.file - 已落盘的文件绝对路径。
 * @param input.id - 素材 id（含扩展名；MIME 由扩展名兜底，见 {@link uploadsMeta}）。
 * @param input.mime - 内容类型。
 * @param input.uploadsDir - uploads 目录。
 * @returns 素材地址。
 */
function registerAsset(input: { file: string, id: string, mime: string, uploadsDir: string }): string {
  uploadsMeta.set(input.id, input.mime)
  return '/bosom-friend/api/assets/file/' + encodeURIComponent(input.id)
}

/** 视频来源的形象素材扩展名：这几类文件走"抽首帧当形象 + 原视频当参考视频"这条路。 */
const DIGITAL_HUMAN_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']

/**
 * 参考视频的官方上限（秒）：Agnes 只收 2~12 秒的参考视频，长了直接拒收。
 *
 * 建形象时按它裁一段：用户传的多半是十几秒到几分钟的素材，原样送出去只会被厂商挡回来。
 */
const REFERENCE_VIDEO_MAX_SECONDS = 12
/** 参考视频时长下限（秒），与官方区间一致。 */
const REFERENCE_VIDEO_MIN_SECONDS = 2
/**
 * 参考视频内联成 Data URI 之前的字节上限。
 *
 * 官方限制是单个视频小于 50 MB；素材只在本机、厂商在公网侧取不到，只能把字节塞进请求体，
 * 而 base64 会把体积放大三分之一——留出余量按 32 MB 拦，超了如实报错而不是发一次注定被拒的请求。
 */
const REFERENCE_VIDEO_MAX_BYTES = 32 * 1024 * 1024

/**
 * 从一段视频素材里备出数字人要用的两样东西：形象帧与参考视频。
 *
 * 为什么是两样而不是一样：厂商把参考素材分成两条通道——`images` 锚定"长什么样"，
 * `videos` 锚定"怎么动、用什么声音说话"。只给首帧，成片里的动作与说话方式就全靠模型想象；
 * 把原视频按官方限制裁一段一起交出去，画面与声音才是从这个人的真实素材延续下来的。
 *
 * 裁一段而不是原样透传：官方只收 2~12 秒、单个小于 50 MB 的参考视频，长素材必然被拒。
 * 统一转成 720P 的 H.264 + AAC，避免用户素材的编码格式厂商读不了。
 *
 * @param dataRoot - 产品数据根。
 * @param file - 已落盘的视频文件绝对路径。
 * @returns 形象帧与参考视频的素材地址；失败给可读原因（由调用方决定怎么告知用户）。
 */
async function prepareDigitalHumanVideo(
  dataRoot: string,
  file: string,
): Promise<{ ok: true, frameUrl: string, referenceVideoUrl: string } | { ok: false, error: string }> {
  const uploadsDir = ensureUploadsDir(dataRoot)
  const sourceSeconds = await probeDurationSeconds(file)
  if (sourceSeconds <= 0) return { ok: false, error: '读不出这个视频的时长，请换一个视频或改用照片' }
  if (sourceSeconds < REFERENCE_VIDEO_MIN_SECONDS) {
    return { ok: false, error: '视频太短（厂商要求参考视频至少 ' + String(REFERENCE_VIDEO_MIN_SECONDS) + ' 秒），请换一段更长的人像视频' }
  }
  // 抽首帧：定位到 0.1 秒再取一帧，避开部分编码器首帧为空白/黑场的情况。
  const frameId = uid('dh-frame') + '.jpg'
  const frameFile = join(uploadsDir, frameId)
  const frameRun = await runFfmpeg(['-y', '-ss', '0.1', '-i', file, '-frames:v', '1', '-q:v', '2', frameFile])
  if (!frameRun.ok || !existsSync(frameFile)) {
    return { ok: false, error: '从视频里抽不出画面，请换一个视频或改用照片' }
  }
  const referenceId = uid('dh-ref') + '.mp4'
  const referenceFile = join(uploadsDir, referenceId)
  const referenceRun = await runFfmpeg([
    '-y', '-i', file,
    '-t', String(REFERENCE_VIDEO_MAX_SECONDS),
    // 统一到 720P 短边：参考视频只用于约束动作与声音，不做成片画质，压小才能内联进请求体。
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    referenceFile,
  ], { timeoutMs: 300_000 })
  if (!referenceRun.ok || !existsSync(referenceFile)) {
    return { ok: false, error: '这个视频转不成厂商要的参考视频格式，请换一个视频（建议 MP4 / H.264）' }
  }
  return {
    ok: true,
    frameUrl: registerAsset({ file: frameFile, id: frameId, mime: 'image/jpeg', uploadsDir }),
    referenceVideoUrl: registerAsset({ file: referenceFile, id: referenceId, mime: 'video/mp4', uploadsDir }),
  }
}

/**
 * 厂商视频任务的轮询预算。
 *
 * 实测（2026-09-14，agnes-video-2.5-flash）：一条 4~7 秒的成片，从建任务到 completed
 * 分别用了 33s / 125s / 160s；产品工作日志另记过一次 4m07s。原先写死 180000（3 分钟），
 * 比厂商常态耗时还短——超时即返回 null，调用方静默改用本地幻灯片兜底，
 * 用户拿到的"AI 视频"其实是图片拼的。给足 10 分钟，宁可等，也不把厂商成片丢掉。
 */
const VIDEO_POLL_BUDGET_MS = 600_000

function buildRoutes(deps: Deps): RouteDef[] {
  // 记忆与画像的落点（ADR-003 口径四）：模块级函数（streamLlmWithDeltas / runEvolutionReview）
  // 靠这一次注入定位数据根——路由表只建一次，注入也就只发生一次。
  // 自进化的落点（ADR-003 口径四）：模块级函数（streamLlmWithDeltas / runEvolutionReview）
  // 靠这一次注入定位数据根——路由表只建一次，注入也就只发生一次。
  //
  // 这里**不能**调 log()：它读的是本函数内部的 files，而 files 在这一行之后才初始化，
  // 会直接抛 "Cannot access 'files' before initialization" 让整个插件树装载失败
  // （不是日志缺失，是产品起不来）。装载痕迹写文件，见 setMemoryDataRoot。
  setMemoryDataRoot(deps.dataRoot)
  const { store } = deps
  const files = store.files

  /** 未配置用户钥匙时的引导回复（不含任何内置大模型；模板兜底 + 指引）。 */
  const unconfiguredReply = (prompt: string): string => {
    void prompt
    return [
      '未接入任何大模型。',
      '',
      '请先在「设置 → 配置大模型」中填写你的 API 地址和密钥，',
      '配置完成后我才能真实生成内容；当前没有任何可用的 AI 能力。',
    ].join('\n')
  }
  const routes: RouteDef[] = []
  /**
   * 正在生成的任务控制位。`abort` 到达时置 `aborted`，这次生成据此停止转发增量；
   * 正文、动作卡与终态一律以当下的控制位为准，落库为 `aborted`、只保留已送达客户端的部分正文、
   * 不再附带发布动作卡。生成结束即移除条目，`abort` 接口据此如实回报这次停止有没有落到
   * 正在生成的那一次；历史遗留的 `running` 状态不会把后续对话误判为已中断。
   */
  const inFlightAgentTasks = new Map<string, { aborted: boolean }>()
  /**
   * 助手对话的内核池：**一个任务 = 一个会话**（ADR-003 口径一的地基）。
   *
   * 为什么必须池化：不池化时每轮都新起一个内核进程、开一个新会话、用完即关——
   * 于是"上下文"只能是服务端把历史折成文本重发（上限 12000 字，每轮重发一次，长对话成本平方级），
   * 内核侧的压缩、标题、用量、技能注入全都用不上。池化之后同一个任务的第二轮只送**本轮这一句**，
   * 前几轮由会话承担。
   *
   * 三条边界（都是实测踩过的）：
   * - **进程换掉要换会话 id**：会话注册表在进程内，持久化日志已存在的 id 在新进程里创建会以
   *   `session "…" already exists` 整轮失败。所以池里没有这条任务时，用新的 id 冷启动，
   *   并把历史**喂一次**（{@link chatTranscript}），之后不再重发。
   * - **中断要真的停住模型**：中断仍然关掉这条任务的内核（沿用既有语义），条目随之移除，
   *   下一次提问走冷启动 + 喂历史。
   * - **有上限**：内核是子进程，无上限地攒会拖垮机器；超出上限时关掉最久未用的那条。
   */
  const AGENT_KERNEL_LIMIT = 4
  /**
   * 池键 = **任务 × 归属管家**，不是只有任务 id。
   *
   * 为什么必须带管家：工具面是**进程级**的（补丁层在进程启动时按 `BF_AGENT_ROLE` 决定挂哪些
   * 工具，见 kernel-client.ts 的 `role`）——同一条任务换了管家，旧进程的工具面就已经不对了，
   * 复用它等于让新管家拿着上一个管家的权限干活。键带管家之后，换管家自然走冷启动新进程。
   */
  const agentKernels = new Map<string, { client: KernelClient, sessionId: string, usedAt: number }>()

  /** 池键：任务 id ＋ 归属管家（分隔符用不可见字符，任务 id 里不会出现）。 */
  function agentKernelKey(taskId: string, role: ZyAgentRole): string {
    return taskId + '\u0000' + role
  }

  /** 关掉池里的某一条会话（按池键）。 */
  function closeAgentKernel(key: string): void {
    const entry = agentKernels.get(key)
    if (entry === undefined) return
    agentKernels.delete(key)
    void entry.client.close().catch(() => {})
  }

  /**
   * 关掉某条任务的**全部**会话（中断、删除任务时用）。
   *
   * 为什么按任务前缀而不是精确一条：同一条任务换过管家就会有多条（每管家一条，
   * 见 {@link agentKernels}），中断要求的是"这条任务的内核真的停住"，漏掉哪条都会留下
   * 一个还在跑模型的进程。
   */
  function dropAgentKernel(taskId: string): void {
    const prefix = taskId + '\u0000'
    for (const key of [...agentKernels.keys()]) {
      if (key.startsWith(prefix)) closeAgentKernel(key)
    }
  }

  /**
   * 取这条任务的会话；没有就新建一个（冷启动）。
   *
   * @param taskId - 任务 id（会话以任务为单位）。
   * @param options - 模型路由（提供方/型号/网关）。
   * @returns 内核客户端与"这一轮是不是冷启动"；冷启动时调用方要把历史喂一次。
   */
  function takeAgentKernel(
    taskId: string,
    options: KernelClientOptions,
  ): { client: KernelClient, coldStart: boolean } {
    // 管家取自这次调用的角色选项：调用方必须把**任务归属管家**放进来（见下方对话入口），
    // 缺省或词表外的值收成 steward——宁可用总管的全量面，也不能让一条对话没有工具面。
    const role = asAgentRole(options.role)
    const key = agentKernelKey(taskId, role)
    const existing = agentKernels.get(key)
    if (existing !== undefined) {
      existing.usedAt = Date.now()
      return { client: existing.client, coldStart: false }
    }
    while (agentKernels.size >= AGENT_KERNEL_LIMIT) {
      let oldestKey: string | undefined
      for (const [candidate, entry] of agentKernels) {
        if (oldestKey === undefined || entry.usedAt < agentKernels.get(oldestKey)!.usedAt) oldestKey = candidate
      }
      if (oldestKey === undefined) break
      closeAgentKernel(oldestKey)
    }
    // id 带一个进程内递增的后缀：进程重启后不会撞上日志里已存在的同名会话（那条路整轮失败）。
    agentKernelSeq += 1
    const sessionId = taskId + '-s' + String(agentKernelSeq)
    const client = createKernelClient({ ...options, sessionId })
    agentKernels.set(key, { client, sessionId, usedAt: Date.now() })
    return { client, coldStart: true }
  }

  /** 会话 id 的进程内序号（见 {@link takeAgentKernel} 的冷启动说明）。 */
  let agentKernelSeq = 0

  /**
   * 语境文件里最多列几条真实失败：列太少看不出模式，列太多会把上下文挤满。
   */
  /** 语境里最多带几条账号定位（与 MAX_AGENT_CONTEXT_FAILURES 同一类预算）。 */
const MAX_CONTEXT_POSITIONINGS = 6
const MAX_AGENT_CONTEXT_FAILURES = 6

  /**
   * 收集写进语境文件的事实。每一条都来自产品数据根，没有一条是推测——
   * 语境的全部价值就在于它描述的是**这台机器上真实发生过的事**。
   *
   * @returns 平台家底、最近真实失败与蒸馏账本的家底。
   */
  function collectAgentContextFacts(): AgentContextFacts {
    const displayNames = new Map(platformCatalog().map(item => [item.platform, item.name]))
    const platforms: string[] = []
    for (const row of files.accounts.load()) {
      const code = typeof row.type === 'string' ? row.type : ''
      if (code === '') continue
      const name = displayNames.get(code) ?? code
      if (!platforms.includes(name)) platforms.push(name)
    }
    const failures: string[] = []
    for (const job of files.jobs.load()) {
      const note = typeof job.lastError === 'string' ? job.lastError : ''
      if (note === '') continue
      failures.push(String(job.kind) + ' 任务失败：' + note)
    }
    for (const entry of files.logs.load()) {
      if (entry.kind !== 'agent_warning') continue
      failures.push('助手侧告警：' + entry.detail)
    }
    // 记忆：按平台聚合发布失败。流水在 failures 里，这里只留"同一个地方反复出问题"。
    const failureCounts = new Map<string, { count: number, lastMessage: string }>()
    const publishCounts = new Map<string, number>()
    for (const record of files.records.load()) {
      const code = typeof record.accountType === 'string' ? record.accountType : ''
      const platform = code === '' ? '未知平台' : (displayNames.get(code) ?? code)
      publishCounts.set(platform, (publishCounts.get(platform) ?? 0) + 1)
      const note = typeof record.errorMsg === 'string' ? record.errorMsg : ''
      if (note === '') continue
      const seen = failureCounts.get(platform)
      failureCounts.set(platform, { count: (seen?.count ?? 0) + 1, lastMessage: note.slice(0, 60) })
    }
    const failuresByPlatform = [...failureCounts.entries()]
      .map(([platform, item]) => ({ platform, count: item.count, lastMessage: item.lastMessage }))
      .sort((left, right) => right.count - left.count)
      .slice(0, MAX_AGENT_CONTEXT_FAILURES)

    // 画像：只统计事实。生成记录的类型字段来自 request.kind（防御性读取，坏行忽略）。
    const kindCounts = new Map<string, number>()
    for (const generation of files.generations.load()) {
      const kind = typeof (generation.request as { kind?: unknown } | undefined)?.kind === 'string'
        ? (generation.request as { kind: string }).kind
        : ''
      if (kind === '') continue
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
    }
    const knowledgeState = files.knowledge.load() as KnowledgeState
    const stats = distillStats(knowledgeState)
    const ratedCounts = new Map<string, number>()
    for (const sample of knowledgeState.distillations ?? []) {
      if (sample.rating < 4) continue
      ratedCounts.set(sample.task, (ratedCounts.get(sample.task) ?? 0) + 1)
    }
    const topRatedTask = [...ratedCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ''

    // 权限边界：账号现在能不能用。判据与界面一致（登录态失效 = 平台明说要重登）。
    const accountRows = files.accounts.load()
    const relogin = accountRows
      .filter(row => row.loginState === 'invalid')
      .map(row => ({
        platform: displayNames.get(String(row.type ?? '')) ?? String(row.type ?? '未知平台'),
        nickname: String(row.nickname ?? '') || '（未设置昵称）',
        note: String(row.loginNote ?? ''),
      }))
    // 与界面同一口径：可用 = 登录态正常**且**产品侧状态正常（status 1）；两者不是一回事，
    // 只按登录态算会把失效号也算进"可用"，那是在语境里给模型一个偏大的权限边界。
    const usableAccounts = accountRows.filter(row => row.loginState !== 'invalid' && row.status === 1).length
    const disabled = accountRows
      .filter(row => row.loginState !== 'invalid' && row.status !== 1)
      .map(row => ({
        platform: displayNames.get(String(row.type ?? '')) ?? String(row.type ?? '未知平台'),
        nickname: String(row.nickname ?? '') || '（未设置昵称）',
      }))
    // 登录态时效：这个号多久没被平台验证过了。只在"没被判失效"的号上算（失效的已在 relogin 里）。
    // 阈值与自动任务的主动提醒**同源**（auto-tasks.ts 的 STALE_LOGIN_HOURS）：一处定义两处生效，
    // 免得用户看到"语境说 24 小时、通知里说 12 小时"。从未验证过（loginCheckedAt 缺失）记 -1 一律计入。
    const stale = accountRows
      .filter(row => row.loginState !== 'invalid' && row.status === 1)
      .map(row => {
        return {
          platform: displayNames.get(String(row.type ?? '')) ?? String(row.type ?? '未知平台'),
          nickname: String(row.nickname ?? '') || '（未设置昵称）',
          hours: staleHoursOf(row.loginCheckedAt, Date.now()),
        }
      })
      .filter(item => item.hours < 0 || item.hours >= STALE_LOGIN_HOURS)

    // 账号定位（长期上下文）：从事实库取，昵称回账号行上找。
    const accountFacts = Object.values(files.accountFacts.load())
      .filter(fact => typeof fact.positioning === 'string' && fact.positioning !== '')
      .slice(0, MAX_CONTEXT_POSITIONINGS)
      .map((fact) => {
        const row = accountRows.find(item => String(item.type ?? '') === fact.platform && String(item.uid ?? '') === fact.uid)
        return {
          platform: displayNames.get(fact.platform) ?? fact.platform,
          nickname: String(row?.nickname ?? '') || String(fact.uid),
          positioning: String(fact.positioning),
        }
      })

    // 最近的内容创作：把用户填的「产品与卖点」和脚本开头带进语境。发布文案的依据在这里，
    // 不在素材文件名里——少了这一段，模型只能从"第17版·夜间终版"猜内容（2026-09-29 现场）。
    const creations = files.longVideoTasks.load()
      .slice()
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
      .map(task => ({
        topic: String(task.topic ?? '').slice(0, 240),
        scriptExcerpt: String(task.scriptText ?? '').slice(0, 320),
        status: String(task.status ?? ''),
      }))
      .filter(item => item.topic !== '' || item.scriptExcerpt !== '')
      .slice(0, 3)

    return {
      platforms,
      accountFacts,
      recentCreations: creations,
      recentFailures: failures.slice(-MAX_AGENT_CONTEXT_FAILURES).reverse(),
      successSamples: stats.success,
      ratedSamples: stats.rated,
      accountUsability: { usable: usableAccounts, relogin, disabled, stale },
      failuresByPlatform,
      profile: {
        accountCount: files.accounts.load().length,
        publishesByPlatform: [...publishCounts.entries()]
          .map(([platform, count]) => ({ platform, count }))
          .sort((left, right) => right.count - left.count),
        generationsByKind: [...kindCounts.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((left, right) => right.count - left.count),
        topRatedTask,
      },
    }
  }

  /**
   * 刷新产品的稳定语境文件（`$DSH_HOME/AGENTS.md`）。
   *
   * 时机是**冷启动之前**：内核会话只在建立时读一次指令文件，续轮不会再读。
   * 所以"让新会话看到最新的约束与历史"这件事，只能在新建会话的这一刻做。
   */
  function refreshAgentContext(): void {
    try {
      const dshHome = dshHomeOf(deps.dataRoot)
      writeAgentContext(dshHome, buildAgentContext(collectAgentContextFacts()))
      // 按真实表现给样本打分（ADR-004 附录 P1）：作品的播放/点赞 → 它的来源草稿 → 那条草稿上的 AI 样本。
      // 放在语境刷新这一刻，与 Curator 同一处：两者都是"账本的投影"，都必须发生在会话建立**之前**——
      // 会话只在这时候读一次指令文件，晚一刻这一轮的上下文就还是旧的。
      const scored = rateSamplesFromEngagement(deps)
      if (scored.rated > 0)
        log('sample_rating', '按真实表现给 ' + String(scored.rated) + ' 条样本打上了分（参与排名 ' + String(scored.rankedWorks) + ' 条作品）')
      // Curator：技能目录是账本的投影——超出上限或已被降格的技能在这一刻归档。
      // 只动本应用写的技能文件（见 curateSkills 的归属判断）。
      const knowledge = files.knowledge.load() as KnowledgeState
      curateSkillsByRole(dshHome, knowledge.distillations ?? [])
    }
    catch (error) {
      // 语境文件只是增强，不是对话的前置条件：磁盘满或权限不足时如实记一笔，
      // 让这一轮照常进行，而不是把用户挡在对话框外面。
      log('agent_context_warning', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 一种对象的读写适配：动作规格只说"改哪个字段、怎么整理"，怎么取一条、怎么落盘由这里负责。
   *
   * 为什么要这一层：动作规格是纯函数（可单测），而"草稿住在 contents 数组里、笔记住在
   * knowledge.notes 的映射里"是存储细节。两者混在一起，每加一种对象都要改一遍动作执行逻辑。
   */
  interface ObjectAdapter {
    /**
     * 取一条对象的**可变引用**，并带上这次动作的落盘动作。
     *
     * @param id - 对象 id（草稿是 `_id`，笔记是它在 knowledge.notes 里的路径键）。
     * @returns 记录、commit 与（可选）**与这条对象相关的其它事实**；对象不存在时为 undefined。
     *
     * facts 为什么由适配器给而不是由动作规格给：规格是**纯函数**（只有这条记录），
     * 而"这个号最近失败过几次"住在**别的文件**里——只有知道这条对象住在哪的适配器拿得到。
     */
    find: (id: string) => { record: Record<string, unknown>, commit: () => void, facts?: string } | undefined
  }

  const OBJECT_ADAPTERS: Record<string, ObjectAdapter> = {
    draft: {
      find: (id) => {
        const rows = files.contents.load()
        const record = rows.find(item => item.kind === 'draft' && item._id === id) as Record<string, unknown> | undefined
        if (record === undefined) return undefined
        // 与这条草稿相关的其它事实：**用户素材库里有什么**。
        // 「配图建议」必须落在自己的素材上——不看库就出建议，等于让用户去别处找图。
        const assets = rows.filter(item => item.kind === 'asset')
        const images = assets.filter(item => item.type === 'img')
        const videos = assets.filter(item => item.type === 'video')
        // 没命名的素材要**如实标成"未命名"**：直接把 id 当名字给模型，它会把 id 当成图的描述
        // （真机实测：模型拿一个叫 asset-xxxx 的图去当封面，还替它编了一句画面描述）。
        const names = (list: typeof assets): string => list.slice(0, 8)
          .map((item) => {
            const title = String(item.title ?? '').trim()
            const id = String(item._id ?? '')
            return title === '' || title === id ? '（未命名 ' + id + '）' : title
          })
          .join('、') + (list.length > 8 ? '…' : '')
        const library = assets.length === 0
          ? '素材库现在是空的（建议里不要假装从库里挑图，需要几张就说需要补拍几张）'
          : '素材库里可用：图片 ' + String(images.length) + ' 张'
            + (images.length > 0 ? '（' + names(images) + '）' : '')
            + '、视频 ' + String(videos.length) + ' 个'
            + (videos.length > 0 ? '（' + names(videos) + '）' : '')
        return { record, commit: () => files.contents.save(rows), facts: library }
      },
    },
    account: {
      find: (id) => {
        const rows = files.accounts.load()
        // 两种寻址（DEF-147）：
        // ① 服务端账号行的 id（浏览器模式、以及后端登记过的账号）；
        // ② `platform|uid`（**桌面端本机账号**——它在服务端根本没有行，只有这个键两边都有）。
        const key = accountKeyFromId(id)
        const row = rows.find(item => String(item.id ?? '') === id)
          ?? (key === undefined
            ? undefined
            : rows.find(item => String(item.type ?? '') === key.platform && String(item.uid ?? '') === key.uid))
        const platform = row === undefined ? key?.platform ?? '' : String(row.type ?? '')
        const uid = row === undefined ? key?.uid ?? '' : String(row.uid ?? '')
        if (platform === '' || uid === '')
          return undefined
        const factKey = accountFactKey(platform, uid)
        const facts = files.accountFacts.load()
        const fact = facts[factKey]
        // 合并视图：账号行 + 事实库（事实优先）。行上的旧值仍读得到——历史数据不需要迁移。
        const record = {
          ...(row ?? { type: platform, uid }),
          ...(fact?.positioning === undefined ? {} : { aiPositioning: fact.positioning }),
          ...(fact?.positioningAt === undefined ? {} : { aiPositioningAt: fact.positioningAt }),
          ...(fact?.risk === undefined ? {} : { aiRisk: fact.risk }),
          ...(fact?.riskAt === undefined ? {} : { aiRiskAt: fact.riskAt }),
        } as Record<string, unknown>
        // 与这条号相关的其它事实：**它的发布失败史**（风险评估最需要的那一条）。
        // 这不是推测：失败原文来自发布记录里的 errorMsg，是平台真的返回过的。
        const mine = files.records.load().filter(item =>
          String(item.accountId ?? '') === String(row?.id ?? '') && row !== undefined)
        const failures = mine.filter(item => typeof item.errorMsg === 'string' && item.errorMsg !== '')
        const published = mine.filter(item => item.status === PUBLISH_RECORD_STATUS.PUBLISHED)
        const lastFailure = failures[0] === undefined ? '' : String(failures[0].errorMsg).slice(0, 80)
        return {
          record,
          // 落盘只写事实库：账号级 AI 事实的家只有这一个（账号行不动）。
          commit: () => {
            const next = { ...facts }
            next[factKey] = {
              platform,
              uid,
              ...(typeof record.aiPositioning === 'string' && record.aiPositioning !== '' ? { positioning: record.aiPositioning } : {}),
              ...(typeof record.aiPositioningAt === 'string' && record.aiPositioningAt !== '' ? { positioningAt: record.aiPositioningAt } : {}),
              ...(typeof record.aiRisk === 'string' && record.aiRisk !== '' ? { risk: record.aiRisk } : {}),
              ...(typeof record.aiRiskAt === 'string' && record.aiRiskAt !== '' ? { riskAt: record.aiRiskAt } : {}),
            }
            files.accountFacts.save(next)
          },
          facts: [
            '这个号的发布记录：成功 ' + String(published.length) + ' 条，失败 ' + String(failures.length) + ' 次'
              + (failures.length === 0 ? '（没有失败记录）' : '（最近一次：' + lastFailure + '）'),
            published.length === 0 && failures.length === 0 ? '这个号还没有发布过任何内容' : '',
          ].filter(line => line !== '').join('\n'),
        }
      },
    },
    work: {
      find: (id) => {
        const rows = files.records.load()
        const record = rows.find(item => String(item.id ?? '') === id) as Record<string, unknown> | undefined
        if (record === undefined) return undefined
        return { record, commit: () => files.records.save(rows) }
      },
    },
    note: {
      find: (id) => {
        const state = files.knowledge.load() as KnowledgeState
        // 笔记是以路径为键的映射，不是数组：键不存在时索引给 undefined，必须自己判。
        const note = (state.notes as Record<string, unknown> | undefined)?.[id]
        if (typeof note !== 'object' || note === null) return undefined
        return { record: note as Record<string, unknown>, commit: () => files.knowledge.save(state) }
      },
    },
  }

  /**
   * 跑一条对象级 AI 动作，并把结果写回那条对象。
   *
   * 为什么不让模型自己决定写什么：动作是**用户点出来的确定性操作**（飞书的"字段捷径"），
   * 写哪个字段、写成什么样由 {@link ObjectActionSpec} 定死；模型只负责产出这个字段的新值。
   * 让模型选字段会让"点一次按钮"变成"抽一次奖"。
   *
   * @param input - 对象种类、对象 id、动作 id、界面上的额外要求与模型路由。
   * @returns 成功时的字段与新值（含旧值，便于前端回显），失败时的人话原因。
   */
  async function runObjectAction(input: {
    kind: string
    id: string
    action: string
    extra?: string
    llm: LlmOverride
  }): Promise<{ ok: true, field: string, value: ObjectActionValue, before: string } | { ok: false, message: string }> {
    // 先认对象再认动作：拿到的是"我们还不支持这种对象"而不是"这个对象上没有这个动作"——
    // 前者是产品还没做的能力，后者是调用方传错了动作名，给用户的话不该混成一句。
    const adapter = OBJECT_ADAPTERS[input.kind]
    if (adapter === undefined) return { ok: false, message: '还不支持对这类对象做 AI 动作：' + input.kind }
    const spec = findObjectAction(input.kind, input.action)
    if (spec === undefined) return { ok: false, message: '这个对象上没有这个动作：' + input.action }
    const found = adapter.find(input.id)
    if (found === undefined) return { ok: false, message: '这条内容不存在或已被删除' }
    const target = found.record
    const before = spec.current(target)
    const knowledgeState = files.knowledge.load() as KnowledgeState
    const knowledge = buildKnowledgeContext(knowledgeState, before === '' ? spec.label : before)
    // 质量语境与助手对话共用一份账本：动作的产出同样要能成为下一次的基准。
    const quality = buildQualityContext(knowledgeState, 'chat')
    // 对象的其他事实也进提示词：只给"被改字段的当前值"时，第一次做定位的账号对模型是个匿名对象。
    // 两路事实合起来给模型：规格给"这条对象自己身上的"（纯函数、可单测），
    // 适配器给"与它相关的其它记录"（只有它知道去哪找）。空的那一路不占位置。
    const facts = [spec.context?.(target) ?? '', found.facts ?? ''].filter(part => part !== '').join('\n')
    const prompt = buildObjectActionPrompt(spec, before, input.extra ?? '', facts)
    const out = await streamLlmWithDeltas(prompt, undefined, input.llm, knowledge.block + quality.block)
    // 先记诊断再判空：调过工具时产出**正是**被丢成空串的那一刻，
    // 排在判空之后这条日志永远不会执行（自己写完就踩了一次，2026-09-22 真机复核时发现）。
    if (out.toolNames !== undefined && out.toolNames.length > 0)
      log('object_action_tool_call', spec.id + ' 这一轮调了工具：' + [...new Set(out.toolNames)].join('、') + '，产出已作废')
    if (out.text === '') {
      return { ok: false, message: '大模型没有返回内容：' + (out.error ?? '未知原因') }
    }
    // 元回应不是字段值：模型偶尔会回"我理解…不过你没有提供具体需求"这类**关于任务本身的话**，
    // 把它写进标题/建议里就是污染（与 DEF-155 同类，只是没调工具而已）。
    if (looksLikeMetaReply(out.text)) {
      log('object_action_meta_reply', spec.id + ' 模型回的是关于任务本身的话，已拒绝写回：' + out.text.replace(/\s+/g, ' ').slice(0, 120))
      return { ok: false, message: '模型这次回的是"关于任务本身的话"，不是这条对象要的内容，请重试' }
    }
    const value = spec.normalize(out.text)
    // 整理不出内容时**绝不写空值**：那会用"空"覆盖用户已有的内容，比失败更糟。
    // 列表字段的"空"是空数组——只判空串会让一次模型跑偏把话题清空。
    if (value === '' || (Array.isArray(value) && value.length === 0)) {
      // 「模型什么都没给」与「给了但整理不出」是两件事：这句话本身分辨不了，
      // 不留原文就只能靠猜"是模型不行还是整理规则太严"（这次就是靠它定位到全角逗号切分）。
      log('object_action_unusable', spec.id + ' 输出 ' + String(out.text.length) + ' 字，整理后为空；原文前 120 字：' + out.text.replace(/\s+/g, ' ').slice(0, 120))
      return { ok: false, message: '模型这次没有给出可用的内容，请重试' }
    }
    target[spec.field] = value
    // 时间戳写哪个字段由规格说了算：靠"对象上恰好有没有 updatedAt"去猜，猜不中时静默不留痕。
    if (spec.stampField !== undefined) target[spec.stampField] = nowIso()
    found.commit()
    recordDistillation(deps, {
      sourceId: 'object-action-' + input.kind + '-' + input.id + '-' + spec.id,
      // 对象身份单独记：后面的"用真实表现给样本打分"要拿它跟发布记录对账。
      objectKind: input.kind,
      objectId: input.id,
      task: 'chat',
      instruction: prompt,
      // 人话版的"这次做的是什么"：技能名与技能目录里的说明都用它，别用那段带脚手架的提示词。
      instructionLabel: spec.label + '：' + (before === '' ? input.id : before.slice(0, 20)),
      // 账本记的是文本：列表字段按行写进去，读的人（与技能命名）拿到的仍是人话。
      output: Array.isArray(value) ? value.join('\n') : value,
      model: out.model ?? '',
      // 度量：对象动作也要能被"越用越省"统计到（此前只有助手那条路记）。
      toolCalls: out.toolCalls ?? 0,
      ...(out.elapsedMs === undefined ? {} : { elapsedMs: out.elapsedMs }),
      ...(out.contextChars === undefined ? {} : { contextChars: out.contextChars }),
      knowledgePaths: knowledge.paths,
      knowledgeChars: knowledge.chars,
      status: 'success',
      rating: 0,
      exampleIds: quality.ids,
    })
    return { ok: true, field: spec.field, value, before }
  }

  /** 只读分享页在应用内的路径：桌面端走 hash 路由，链接必须带 `#` 才能打开只读页。 */
  const SHARE_URL_PATH = '#/chat?token='
  /** 分享有效期缺省 7 天；请求值限定 1 分钟 ~ 30 天，非法值一律按缺省处理。 */
  const SHARE_TTL_DEFAULT_SECONDS = 7 * 86400
  const SHARE_TTL_MIN_SECONDS = 60
  const SHARE_TTL_MAX_SECONDS = 30 * 86400

  /** 解析请求的分享有效期（秒）；非数字或越界时返回缺省 7 天。 */
  function resolveShareTtlSeconds(requested: unknown): number {
    const seconds = typeof requested === 'number' ? Math.floor(requested) : Number.NaN
    if (!Number.isFinite(seconds) || seconds < SHARE_TTL_MIN_SECONDS || seconds > SHARE_TTL_MAX_SECONDS)
      return SHARE_TTL_DEFAULT_SECONDS
    return seconds
  }

  /** 新建分享链接并落盘：同一任务重复分享各自保留 token，直到各自过期。 */
  function createShareLink(taskId: string, requestedTtl: unknown): ShareLinkRecord {
    const link: ShareLinkRecord = {
      token: randomUUID().replaceAll('-', ''),
      taskId,
      expiresAt: Date.now() + resolveShareTtlSeconds(requestedTtl) * 1000,
      createdAt: nowIso(),
    }
    files.shareLinks.save([...files.shareLinks.load().filter(item => item.expiresAt > Date.now()), link])
    return link
  }

  /** 按 token 取分享链接（含已过期，便于区分"过期"与"不存在"）；顺带清掉过期记录。 */
  function findShareLink(token: string): ShareLinkRecord | undefined {
    const links = files.shareLinks.load()
    const alive = links.filter(item => item.expiresAt > Date.now())
    if (alive.length !== links.length) files.shareLinks.saveEmpty(alive)
    return links.find(item => tokenEquals(item.token, token))
  }

  /**
   * 删除任务及其分享链接。
   *
   * 分享链接必须一起清掉：任务没了、链接还在，会把用户带到一个永远打不开的只读页
   * （DEF-003 就是"不存在的任务也能生成分享链接"那一类）。
   *
   * @param ids - 要删除的任务 id 集合。
   * @returns 实际删掉的任务条数。
   */
  function removeAgentTasks(ids: Set<string>): number {
    const tasks = files.tasks.load()
    const kept = tasks.filter(task => !ids.has(task.id))
    const removed = tasks.length - kept.length
    if (removed > 0) {
      files.tasks.saveEmpty(kept)
      files.shareLinks.saveEmpty(files.shareLinks.load().filter(link => !ids.has(link.taskId)))
    }
    return removed
  }

  /**
   * 按任务归集模型用量，数据取自已有的知识库蒸馏账本——不新增埋点。
   *
   * 口径与依据：
   * - 账本每条样本就是一次**真实**模型调用，`elapsedMs` / `toolCalls` 由传输层统一实测
   *   （见本文件 `measures`），`sourceId` 形如 `<taskId>-<4位>`，可按任务归集；
   * - token 恒为 `null`：产品不记录 token 数（内核不回传），界面显示"未记录"，
   *   **不拿字符数乘系数估**——那是把估算值伪装成实测值；
   * - 账本里一条样本都没有的任务说明"未采集"，由调用方给 `null`，**不给 0**：
   *   没记账不等于没花过（无信号不等于 0）。
   *
   * @returns 任务 id → 该任务的用量；取不到即未采集。
   */
  function taskUsageIndex(): Map<string, TaskUsage> {
    const knowledge = files.knowledge.load() as { distillations?: unknown }
    const rows = Array.isArray(knowledge.distillations) ? knowledge.distillations : []
    const acc = new Map<string, { calls: number, totalMs: number, toolCalls: number, failedCalls: number, models: Map<string, number> }>()
    for (const item of rows) {
      const row = item as Record<string, unknown>
      const sourceId = String(row.sourceId ?? '')
      // `task-d9e17318-a344` → `task-d9e17318`。别的来源（gen-… / chat-… / text-call-…）
      // 不归属任何对话任务，直接跳过，不硬凑到某条任务头上。
      const cut = sourceId.lastIndexOf('-')
      const taskId = cut === -1 ? '' : sourceId.slice(0, cut)
      if (!taskId.startsWith('task-')) continue
      const stat = acc.get(taskId) ?? { calls: 0, totalMs: 0, toolCalls: 0, failedCalls: 0, models: new Map<string, number>() }
      stat.calls += 1
      const ms = Number(row.elapsedMs)
      if (Number.isFinite(ms) && ms > 0) stat.totalMs += ms
      const tools = Number(row.toolCalls)
      if (Number.isFinite(tools) && tools > 0) stat.toolCalls += tools
      if (String(row.status ?? '') !== 'success') stat.failedCalls += 1
      const model = String(row.model ?? '').trim()
      if (model !== '') stat.models.set(model, (stat.models.get(model) ?? 0) + 1)
      acc.set(taskId, stat)
    }
    const out = new Map<string, TaskUsage>()
    for (const [taskId, stat] of acc) {
      out.set(taskId, {
        modelCalls: stat.calls,
        modelMs: stat.totalMs,
        toolCalls: stat.toolCalls,
        failedCalls: stat.failedCalls,
        models: [...stat.models.entries()].sort((left, right) => right[1] - left[1]).map(([model]) => model),
        tokens: null,
      })
    }
    return out
  }

  function log(kind: string, detail: string): void {
    const logs = files.logs.load()
    logs.unshift({ date: nowIso(), kind, detail: detail.slice(0, 200) })
    files.logs.save(logs.slice(0, 500))
  }

  /** 新盐。 */
  function newSalt(): string {
    return randomBytes(16).toString('hex')
  }

  /** 新会话 token（256 位随机）。 */
  function newToken(): string {
    return randomBytes(32).toString('hex')
  }

  /** scrypt 加盐哈希，十六进制编码。 */
  function hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, 32).toString('hex')
  }

  /** 恒定时间密码校验。 */
  function verifyPassword(password: string, salt: string, expected: string): boolean {
    const actual = Buffer.from(hashPassword(password, salt), 'hex')
    const want = Buffer.from(expected, 'hex')
    return actual.length === want.length && timingSafeEqual(actual, want)
  }

  /** 从请求头取 Bearer token。 */
  function bearerToken(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const token = header.slice('Bearer '.length).trim()
    return token === '' ? undefined : token
  }

  /** 按请求 token 解析会话（无有效会话返回 undefined）。 */
  function sessionOf(req: IncomingMessage): { userId: string } | undefined {
    const token = bearerToken(req)
    if (token === undefined) return undefined
    const session = files.sessions.load().find(item => tokenEquals(item.token, token))
    return session === undefined ? undefined : { userId: session.userId }
  }

  /** 公开用户字段（永不返回哈希/盐）。 */
  function publicUserOf(userId: string): Record<string, unknown> | undefined {
    const u = files.users.load().find(item => item.id === userId)
    if (u === undefined) return undefined
    const rest: Record<string, unknown> = { ...u }
    delete rest.passwordHash
    delete rest.salt
    return rest
  }

  /** 免登录模式下的单用户资料（user.json，永不返回 token/密码/盐）。 */
  function legacyPublicUser(): Record<string, unknown> {
    const u = files.user.load()
    const rest: Record<string, unknown> = { ...u }
    delete rest.token
    delete rest.password
    delete rest.salt
    return rest
  }

  /** 为账号开新会话并落盘。 */
  function openSession(userId: string): string {
    const token = newToken()
    const sessions = files.sessions.load()
    sessions.unshift({ token, userId, createdAt: nowIso(), lastSeenAt: nowIso() })
    files.sessions.save(sessions.slice(0, 500))
    return token
  }

  // ---- 认证 & 用户 --------------------------------------------------------

  routes.push(
    // 这两个接口以前直接 writeOk(null)：调用方拿到 code:0 却什么都没发生
    // （没有验证码、没有会话），是假成功。本产品只做账号密码登录，如实拒绝。
    { m: 'POST', p: 'login/mail', h: ({ res }) => { writeFail(res, '本产品不提供邮箱验证码登录，请使用账号密码登录', 401) } },
    { m: 'POST', p: 'login/phone', h: ({ res }) => { writeFail(res, '本产品不提供手机验证码登录，请使用账号密码登录', 401) } },
    { m: 'POST', p: 'login/mail/verify', h: ({ res }) => { writeFail(res, '请使用账号密码登录', 401) } },
    { m: 'POST', p: 'login/phone/verify', h: ({ res }) => { writeFail(res, '请使用账号密码登录', 401) } },
    { m: 'POST', p: 'login/google', h: ({ res }) => { writeFail(res, '请使用账号密码登录', 401) } },
    {
      m: 'POST',
      p: 'auth/register',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { username?: unknown; password?: unknown; name?: unknown }
        const username = typeof params.username === 'string' ? params.username.trim() : ''
        const password = typeof params.password === 'string' ? params.password : ''
        if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) { writeFail(res, '用户名需为 3-32 位字母、数字或 _-', 40000); return }
        if (password.length < 6 || password.length > 128) { writeFail(res, '密码长度需在 6-128 位之间', 40000); return }
        const users = files.users.load()
        if (users.some(u => u.username === username)) { writeFail(res, '该用户名已被注册', 40000); return }
        const now = nowIso()
        const id = uid('u')
        const user = {
          id,
          _id: id,
          username,
          name: typeof params.name === 'string' && params.name.trim() !== '' ? params.name.trim() : username,
          mail: '',
          phone: '',
          salt: newSalt(),
          passwordHash: '',
          status: 1,
          avatar: '',
          score: 0,
          income: 0,
          createdAt: now,
          updateTime: now,
        }
        user.passwordHash = hashPassword(password, user.salt)
        users.push(user)
        files.users.save(users)
        const token = openSession(id)
        writeOk(res, { token, userInfo: publicUserOf(id) })
      },
    },
    {
      m: 'POST',
      p: 'auth/login',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { username?: unknown; password?: unknown }
        const username = typeof params.username === 'string' ? params.username.trim() : ''
        const password = typeof params.password === 'string' ? params.password : ''
        const user = files.users.load().find(u => u.username === username)
        if (user === undefined || !verifyPassword(password, user.salt, user.passwordHash)) {
          writeFail(res, '用户名或密码错误', 401)
          return
        }
        const token = openSession(user.id)
        writeOk(res, { token, userInfo: publicUserOf(user.id) })
      },
    },
    {
      m: 'POST',
      p: 'auth/logout',
      h: ({ req, res }) => {
        const token = bearerToken(req)
        if (token !== undefined) {
          files.sessions.save(files.sessions.load().filter(s => s.token !== token))
        }
        writeOk(res, { ok: true })
      },
    },
    {
      m: 'PUT',
      p: 'auth/password',
      h: ({ req, res, body }) => {
        const session = sessionOf(req)
        if (session === undefined) { writeFail(res, '请先登录', 401); return }
        const params = (body ?? {}) as { oldPassword?: unknown; newPassword?: unknown }
        const oldPassword = typeof params.oldPassword === 'string' ? params.oldPassword : ''
        const newPassword = typeof params.newPassword === 'string' ? params.newPassword : ''
        const users = files.users.load()
        const user = users.find(u => u.id === session.userId)
        if (user === undefined || !verifyPassword(oldPassword, user.salt, user.passwordHash)) {
          writeFail(res, '原密码不正确', 40000)
          return
        }
        if (newPassword.length < 6 || newPassword.length > 128) { writeFail(res, '新密码长度需在 6-128 位之间', 40000); return }
        user.salt = newSalt()
        user.passwordHash = hashPassword(newPassword, user.salt)
        user.updateTime = nowIso()
        // 2026-10-12（审计 W02）：改密要同时落 users.json 与 sessions.json——两步之间失败会留下
        // 「新密码已生效、旧会话没吊销」的半状态。包进事务：要么都生效，要么都不生效。
        store.transact(() => {
          files.users.save(users)
          files.sessions.save(files.sessions.load().filter(s => s.userId !== user.id || s.token === bearerToken(req)))
        })
        writeOk(res, { ok: true })
      },
    },
    {
      m: 'GET',
      p: 'user/security',
      h: ({ res }) => { writeOk(res, deps.security) },
    },
    {
      m: 'GET',
      p: 'user/mine',
      h: ({ req, res }) => {
        const session = sessionOf(req)
        if (session === undefined) { writeOk(res, legacyPublicUser()); return }
        const user = publicUserOf(session.userId)
        if (user === undefined) { writeFail(res, '账号不存在', 401); return }
        writeOk(res, user)
      },
    },
    {
      m: 'PUT',
      p: 'user/info/update',
      h: ({ req, res, body }) => {
        const session = sessionOf(req)
        if (session === undefined) {
          const legacy = files.user.load()
          const patch = body as { name?: unknown; avatar?: unknown }
          if (typeof patch.name === 'string' && patch.name.trim() !== '') legacy.name = patch.name.trim()
          if (typeof patch.avatar === 'string') legacy.avatar = patch.avatar
          legacy.updateTime = nowIso()
          files.user.save(legacy)
          writeOk(res, legacyPublicUser())
          return
        }
        const users = files.users.load()
        const u = users.find(item => item.id === session.userId)
        if (u === undefined) { writeFail(res, '账号不存在', 401); return }
        const patch = body as { name?: unknown; avatar?: unknown }
        if (typeof patch.name === 'string' && patch.name.trim() !== '') u.name = patch.name.trim()
        if (typeof patch.avatar === 'string') u.avatar = patch.avatar
        u.updateTime = nowIso()
        files.users.save(users)
        writeOk(res, publicUserOf(u.id))
      },
    },

    // ---- Agent 任务（SSE 对话主通道） -------------------------------------

    {
      m: 'POST',
      p: 'agent/tasks',
      h: async ({ req, res, body }) => {
        const params = body as { prompt?: unknown; taskId?: unknown; llm?: unknown; focus?: unknown }
        const promptText = extractPrompt(params.prompt)
        // 焦点对象：页面把"用户此刻在看哪一条"送进来（ADR-004 S1）。它每轮都在变，
        // 所以走每轮上下文而不是指令文件；页面没送时整块为空，模型不会凭空收到一个对象。
        // 解析放在本函数前段：任务归属管家（见 agentRoleOfFocus）与下面的上下文块共用它，
        // 而非流式分支在本函数中段就 return 了。
        const focus = parseAgentFocus(params.focus)
        const focusBlock = focus === undefined ? '' : buildFocusContext(focus)
        const llmOverride = parseLlmOverride(params.llm) ?? readStoredLlm(deps.dataRoot)
        const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream')
          || (params as { includePartialMessages?: unknown }).includePartialMessages === true

        const tasks = files.tasks.load()
        const existing = typeof params.taskId === 'string' ? tasks.find(t => t.id === params.taskId) : undefined
        const task = existing ?? {
          id: uid('task'),
          userId: 'zy-user-001',
          title: promptText.slice(0, 30) || '新对话',
          description: '',
          tags: [],
          status: 'running' as const,
          medias: [],
          errorMessage: '',
          prompt: promptText,
          messages: [],
          rating: null,
          ratingComment: null,
          favorite: false,
          favoritedAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        task.status = 'running'
        task.updatedAt = nowIso()
        // 归属管家：新建时按来源判定；早于本字段落地的旧任务在续轮时按同一规则补写一次。
        // 已经有归属的一律不改判——同一条对话中途换页，不该把这件事改判给另一个管家。
        if (task.agentRole === undefined) task.agentRole = agentRoleOfFocus(focus)
        if (!existing) tasks.unshift(task)

        if (promptText !== '') {
          task.messages.push({ type: 'user', uuid: uid('u'), message: promptText, createdAt: nowIso() })
        }

        if (!wantsSse) {
          files.tasks.save(tasks)
          writeOk(res, { id: task.id })
          return
        }

        const control = { aborted: false }
        inFlightAgentTasks.set(task.id, control)

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        // 客户端断开（前端 done/error 主动 abort）后不再写流：写已销毁的 socket
        // 会抛未捕获异常直接杀死进程，必须守卫。
        let streamClosed = false
        /**
         * SSE 心跳：长工具调用期间链路会**静默几分钟**（发布要跑平台、出片要等厂商、生成要轮询），
         * 而客户端 fetch/undici 的 bodyTimeout 默认 300 秒——收不到任何数据就把连接判死。
         * 2026-10-11 三次实测：任务在服务端都跑完了（发布甚至成功），前端流却断了，用户看到的是「对话突然中断」。
         * 每 20 秒写一个 SSE 注释帧（以冒号开头，客户端按规范忽略），只保活、不产生业务事件。
         */
        const sseHeartbeat = setInterval(() => {
          if (streamClosed) return
          try { res.write(': ping\n\n') } catch { streamClosed = true }
        }, 20_000)
        sseHeartbeat.unref?.()
        res.on('close', () => { streamClosed = true; clearInterval(sseHeartbeat) })
        const safeSse = (payload: Record<string, unknown>): void => {
          if (streamClosed) return
          try { sse(res, payload) } catch { streamClosed = true }
        }

        safeSse({ type: 'init', taskId: task.id, sessionId: task.id })

        // 上下文：**把这段对话真的交给模型**，而不是只告诉它"这是继续"。
        // 原先这里只拼一句「请接着上文自然延续」，而上文一个字都没发出去——模型看到的就是
        // 孤零零的最后一句话，于是每轮都重新开场（用户口径的"没有上下文功能"）。
        // 消息在进上下文前已经 push 过，所以这里最后一条就是本轮提问。
        const history: ChatTurn[] = task.messages
          .filter(item => (item.type === 'user' || item.type === 'assistant') && typeof item.message === 'string')
          .map(item => ({ role: item.type === 'user' ? 'user' : 'assistant', content: item.message as string }))
        const transcript = chatTranscript(history)
        const continuing = existing !== undefined && task.messages.filter(m => m.type === 'assistant').length > 0
        // DEF-292（B 方案）：上一轮空转（这条对话从未调用过工具）时，把提示挂到下一轮，逼它真的动手。
        const continuation = (continuing ? '（这是同一段对话的继续，请接着上文自然延续，不要重新开场、不要重复已经说过的内容。）' : '') + (previousTurnWasIdle(task.toolTrace, continuing) ? IDLE_NEXT_TURN_HINT : '')
        // 增量直转：模型输出以 text-delta 到达即转发（秒级首字）；
        // 模型不可达时同通道推送模板兜底文本（50 字/12ms 打字机）。
        let emitted = ''
        const emitDelta = (text: string): void => {
          if (text === '' || control.aborted) return
          emitted += text
          safeSse({
            type: 'stream_event',
            uuid: uid('e'),
            parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          })
        }
        safeSse({
          type: 'stream_event',
          uuid: uid('s'),
          parent_tool_use_id: null,
          event: { type: 'message_start', index: 0 },
        })

        // 仅用户自己的钥匙（BYOK）：未配置 → 模板兜底 + 指引（系统不内置任何模型）。
        // "配了地址密钥但没选型号"同样是**没配完**：不拿一个型号顶上，如实给引导。
        const chatReady = llmOverride !== undefined && llmOverride.model.trim() !== ''
        // 传给模型的是**整段对话**（末条即本轮提问）。多轮上下文只走这一条通道：内核会话是
        // 进程内的，而一个内核进程只服务一次请求，跨请求复用 session id 会整轮失败
        // （实测 `session "task-…" already exists`）。
        const contextualPrompt = (transcript === '' ? promptText : transcript.split('\n').slice(-40).join('\n')) + continuation

        // ---------------------------------------------------------------------------
        // 过程事件：智能体"在做什么"要看得见
        // ---------------------------------------------------------------------------
        // 为什么必须有这一段：内核会话里模型会真的调用产品工具（查账号、查素材、查数据看板…），
        // 而这条链路原先只把**最终正文**转发给界面——用户看到的就是"等半天，答案一下蹦出来"，
        // 或者干脆"失败"（用户口径："不要只有两种状态"）。
        // 这里把内核的工具调用与结果按前端**既有**的工作流事件形状转发 + 落盘：
        // 右侧助手实时显示每一步，"我的任务"里回看时能重放整条过程（convertMessages 已认这套形状）。
        const emitStep = (record: Record<string, unknown>): void => {
          // 先落盘再转发：进程被杀（关软件/断电）时已经跑过的步骤不会白跑，
          // "我的任务"那一页在轮询，用户不必等整轮结束才看到过程。
          task.messages.push(record as never)
          task.updatedAt = nowIso()
          files.tasks.save(tasks)
          safeSse(record)
        }
        // 度量：模型调了几次工具。它是"越用越省"的判据——耗时被网络与模型抖动淹没，轮数不是。
        let toolCalls = 0
        /**
         * 模型通过 `bosom_publish_content` 申请的发布。
         *
         * 发布必须由**前端页面**执行（产品铁律 #2）：内核只登记结构化参数、不调发布接口，
         * 服务端在这里把参数变成一张「去发布」动作卡（前端已有完整执行器：打开发布弹窗，
         * 跟随模式下自动提交）。这条路径同时取代了旧的"从回复文本里正则抠标题/正文/话题"。
         */
        let toolPublishRequest: {
          platform: string
          title: string
          description: string
          tags: string[]
          mediaUrl: string
          coverUrl: string
          mediaType: 'image' | 'VIDEO'
        } | undefined
        /** 建草稿申请（模型调 bosom_content_create_draft）：由前端写进草稿箱。 */
        let toolDraftRequest: { title: string, description: string, tags: string[] } | undefined
        /** 改草稿申请（模型调 bosom_content_update_draft）：由前端写回那条草稿。 */
        let toolDraftUpdateRequest: { id: string, title: string, description: string, executedId?: string } | undefined
        /**
         * 内核建草稿工具**已经落库**时回传的真实草稿 id（DEF-270）。
         *
         * 为什么要有它：`bosom_content_create_draft` 自 ADR-005 起自己经回环 HTTP 写进草稿箱并
         * 回传真实 draftId（kernel/src/index.ts），而这里仍按旧机制把它当成一张"申请卡"——
         * 于是助手回复说"已经存进草稿箱了"、同一条消息下面却挂着「已申请 · 未回填」，
         * 用户不知道该信哪一个。工具结果里的 id 是"这件事确实做完了"的唯一凭据。
         */
        let createdDraftId = ''
        /** 建草稿工具的 callId：工具结果里没有工具名，只能按 callId 关联回这一次调用。 */
        const draftToolCallIds = new Set<string>()
        /**
         * 本回合模型是否已走「管家直发」路径（调了 bosom_publish_draft）。
         *
         * ADR-005 之后直发是正路：这一回合里服务端**不得再生成任何发布动作卡或
         * 「尚未发布」话术**——两套发布入口同回合并存，轻则自相矛盾（助手说已提交、
         * 页脚却说尚未发布），重则重复发布（卡片被点/跟随模式自动执行 → 第二条记录，
         * DEF-303 现场的「卡片+弹窗」就是这条歧路）。工具失败也不回退到卡片：
         * 那条路径的文本提取正是 DEF-303 的危险面，结果一律交给模型的如实汇报。
         */
        let directPublishSubmitted = false
        const turnStartedAt = Date.now()
        /**
         * 工具轨迹（过程数据的地基）：每次工具调用逐条落进任务，随任务一起保存。
         *
         * 为什么要有它：「页面只做过程与结果的可视化」，而**过程 = 工具轨迹**——此前每次调用
         * 只累计一个计数（toolCalls），轮次、工具名、成败都不落盘：三方交叉与门禁只能看当前轮
         * 的 SSE，**转交之后的后续轮次更是无从核验**（2026-10-12 门禁 case 5/7 实测）。
         * `isError` 由 tool-result 步骤回填（两步不保证相邻，靠 callId 关联）。
         */
        const toolTrace: Array<{ turn: number, name: string, at: string, isError: boolean }> =
          Array.isArray(task.toolTrace) ? task.toolTrace : []
        task.toolTrace = toolTrace
        /** callId → 轨迹下标：tool-result 只带 callId，靠它把成败回填到对应的那一条。 */
        const traceIndexByCallId = new Map<string, number>()
        /** 本轮轮次号 = 该任务里用户消息的序号（本轮那句已在上面 push 过）。 */
        const toolTraceTurn = task.messages.filter(m => m.type === 'user').length
        const onKernelStep = (step: KernelAgentStep): void => {
          if (step.kind === 'tool-call') {
            toolCalls += 1
            traceIndexByCallId.set(step.call.callId, toolTrace.length)
            toolTrace.push({ turn: toolTraceTurn, name: step.call.name, at: nowIso(), isError: false })
          }
          if (step.kind === 'tool-result') {
            const at = traceIndexByCallId.get(step.result.callId)
            const entry = at === undefined ? undefined : toolTrace[at]
            if (entry !== undefined) {
              traceIndexByCallId.delete(step.result.callId)
              entry.isError = step.result.isError === true
            }
          }
          if (control.aborted) return
          if (step.kind === 'tool-call') {
            if (step.call.name === 'bosom_content_create_draft') {
              draftToolCallIds.add(step.call.callId)
              try {
                const raw = JSON.parse(step.call.arguments) as Record<string, unknown>
                toolDraftRequest = {
                  title: (typeof raw.title === 'string' ? raw.title : '').trim().slice(0, 30),
                  description: (typeof raw.desc === 'string' ? raw.desc : '').trim(),
                  tags: (typeof raw.topics === 'string' ? raw.topics : '')
                    .split(/[,，、]/).map(part => part.replace(/^#+/, '').trim()).filter(part => part !== '').slice(0, 10),
                }
              } catch { /* 同上 */ }
            }
            if (step.call.name === 'bosom_content_update_draft') {
              try {
                const raw = JSON.parse(step.call.arguments) as Record<string, unknown>
                toolDraftUpdateRequest = {
                  id: (typeof raw.id === 'string' ? raw.id : '').trim(),
                  title: (typeof raw.title === 'string' ? raw.title : '').trim().slice(0, 30),
                  description: (typeof raw.desc === 'string' ? raw.desc : '').trim(),
                }
              } catch { /* 同上 */ }
            }
            if (step.call.name === 'bosom_publish_draft') {
              // 管家直发路径：本回合不再生成发布卡/话术（见 directPublishSubmitted 的说明）。
              directPublishSubmitted = true
            }
            if (step.call.name === 'bosom_publish_content') {
              try {
                const raw = JSON.parse(step.call.arguments) as Record<string, unknown>
                const accountId = typeof raw.accountId === 'string' ? raw.accountId : ''
                const materialId = typeof raw.materialId === 'string' ? raw.materialId : ''
                const account = files.accounts.load().find(row => String((row as { id?: unknown }).id) === accountId)
                const material = files.contents.load().find(item => item.kind === 'asset' && String(item._id) === materialId)
                const topics = (typeof raw.topics === 'string' ? raw.topics : '')
                  .split(/[,，、]/).map(part => part.replace(/^#+/, '').trim()).filter(part => part !== '').slice(0, 10)
                toolPublishRequest = {
                  platform: String((account as { type?: unknown } | undefined)?.type ?? '') || detectPublishPlatform(promptText),
                  title: (typeof raw.title === 'string' ? raw.title : '').trim().slice(0, 30),
                  description: (typeof raw.body === 'string' ? raw.body : '').trim(),
                  tags: topics,
                  mediaUrl: String((material as { url?: unknown } | undefined)?.url ?? ''),
                  coverUrl: String((material as { thumbUrl?: unknown } | undefined)?.thumbUrl ?? ''),
                  mediaType: String((material as { type?: unknown } | undefined)?.type) === 'video' ? 'VIDEO' : 'image',
                }
              } catch {
                // 参数不是合法 JSON：当作没有申请过，继续走原来的文本解析路径。
              }
            }
            emitStep({
              type: 'stream_event',
              uuid: uid('e'),
              parent_tool_use_id: null,
              event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: step.call.callId, name: step.call.name } },
              createdAt: nowIso(),
            })
            if (step.call.arguments !== '') {
              emitStep({
                type: 'stream_event',
                uuid: uid('e'),
                parent_tool_use_id: null,
                event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: step.call.arguments } },
                createdAt: nowIso(),
              })
            }
            return
          }
          // 建草稿工具的结果里带着**真实草稿 id**（工具自己落库后回传）：这一步已经做完了，
          // 不是"申请"。不认它，卡片就会永远停在「已申请 · 未回填」（DEF-270）。
          if (draftToolCallIds.has(step.result.callId) && !step.result.isError) {
            const matched = /草稿 id\s*[:：]?\s*(cnt-[A-Za-z0-9_-]+)/.exec(step.result.text)
            if (matched?.[1] !== undefined) createdDraftId = matched[1]
          }
          if (toolDraftUpdateRequest !== undefined && !step.result.isError && step.result.text.includes('草稿已改写并落库')) toolDraftUpdateRequest.executedId = /草稿 (cnt-[A-Za-z0-9_-]+)/.exec(step.result.text)?.[1] ?? toolDraftUpdateRequest.id
          // 工具结果：以 user/tool_result 的形状落盘与转发，前端据此把结果挂回那一步。
          emitStep({
            type: 'user',
            uuid: uid('u'),
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: step.result.callId,
                content: [{ type: 'text', text: step.result.text }],
                ...(step.result.isError ? { is_error: true } : {}),
              }],
            },
            createdAt: nowIso(),
          })
        }
        // 知识库检索：助手对话与生成共用同一条检索链路（从前这里传空串，助手答什么都靠模型记忆）。
        const knowledgeState = files.knowledge.load() as KnowledgeState
        const chatKnowledge = buildKnowledgeContext(knowledgeState, promptText)
        // 质量语境：用户自己认可过的同类产出（评分 ≥4 或注入过知识）进上下文——
        // 语境的复利就发生在这里：上一次的好交付，成为这一次的基准。
        const chatQuality = buildQualityContext(knowledgeState, 'chat')
        // 时间基准：每轮都送（它每轮都在变）。没有它，模型会把「明天早 9 点」算成过去的日期（DEF-257）。
        const nowBlock = buildNowContext()
        // **一个任务 = 一个会话**：池里有这条任务就续轮，只送本轮这一句；池里没有才冷启动并喂一次历史。
        // 用哪个工具面，由**任务归属管家**决定（归属在本次请求前段判定，见 agentRoleOfFocus）：
        // 判给专业管家的任务就用那个管家的面；判不准的一律 steward（全量，仍是唯一面对的入口）。
        // 为什么不能继续写死 steward：steward 的面是 ["*"]，写死等于唯一入口上**没有权限边界**——
        // 「创作管家发不了布」这条判据在对话里永远不成立（工具面即权限边界，BFS-102）。
        // 某个管家缺某能力时的正确做法是**转交**给持该能力的管家，不是放宽它的工具面。
        const kernelTurn = chatReady ? takeAgentKernel(task.id, kernelOptionsOf(llmOverride, { role: asAgentRole(task.agentRole) })) : undefined
        // 冷启动前刷新稳定语境：内核只在会话建立时读一次指令文件，续轮不再读
        // （见 {@link refreshAgentContext}）。约束语境与历史语境就是这样进模型的。
        if (kernelTurn?.coldStart === true) refreshAgentContext()
        // 这一轮模型的产出。**失败也必须走出一个确定结果**：内核初始化超时（
        // `initialize timed out … waiting for dsh profile`）、运行时没起来、传输层异常，
        // 从前都会把异常抛出这一层——SSE 已经开了头，宿主只能把连接关掉（api.ts 的
        // 路由兜底在 res.headersSent 时直接 res.end()），用户因此看到"一直思考中…"、
        // 任务在列表里永远停在「运行中」（DEF-268 装机复现实测）。
        // 这里收成一次如实失败：正文照实说原因，任务随后落 failed，前端据此给出三个出口。
        let llmOut: {
          text: string
          model?: string
          timedOut?: boolean
          error?: string
          stream?: KernelTextStreamPart[]
          contextChars?: number
        } = { text: '' }
        if (kernelTurn !== undefined) {
          try {
            llmOut = await streamLlmWithDeltas(
              kernelTurn.coldStart ? contextualPrompt : promptText,
              emitDelta,
              llmOverride,
              chatKnowledge.block + chatQuality.block + focusBlock + nowBlock
                // 本条任务号：用户不会念任务号，而转交工具 bosom_steward_dispatch 需要它——
                // 与 bosom_task_follow_up 同一个约定（taskId 只能是真实任务号），放每轮上下文里模型才拿得到。
                + '\n\n[本条任务]\n- 任务号：' + task.id
                + '\n- 用户要办的事属于某个专业管家职责（创作 / 发布 / 运营 / 设备与账号）时，'
                + '用 bosom_steward_dispatch 转交，taskId 填上面这个任务号；不确定要转给谁就先问用户。\n[本条任务结束]',
              () => control.aborted,
              onKernelStep,
              true,
              kernelTurn.client,
            )
          }
          catch (error) {
            llmOut = { text: '', error: error instanceof Error ? error.message : String(error) }
          }
        }
        let fullText = ''
        if (!chatReady) {
          // 未配置大模型：固定提示，绝不编造内容
          fullText = unconfiguredReply(promptText)
          const chunkSize = 50
          for (let i = 0; i < fullText.length && !streamClosed && !control.aborted; i += chunkSize) {
            emitDelta(fullText.slice(i, i + chunkSize))
            await sleep(12)
          }
        }
        else if (llmOut.text !== '') {
          fullText = llmOut.timedOut
            ? llmOut.text + '\n\n> （模型响应超时，以上为已收到的内容）'
            : llmOut.text
          // 增量通道全程为空（厂商网关不发 text-delta）时，按**模型自己的增量时间戳**回放正文：
          // 用户看到的是一个字一个字出来，而不是等十几秒后整段蹦出来。
          // 只在这一轮没有被 emitDelta 送过字时才回放，真流式的那条路径一个字都不会重复。
          if (emitted === '' && !streamClosed && !control.aborted) {
            for (const frame of replayFrames(llmOut.stream ?? [])) {
              if (streamClosed || control.aborted) break
              if (frame.waitMs > 0) await sleep(frame.waitMs)
              emitDelta(frame.text)
            }
          }
        }
        else {
          // 已配置但调用失败：如实说明原因，不用模板文案冒充成功
          fullText = '大模型调用失败：' + (llmOut.error || '未知错误')
            + '。请检查 API 地址、密钥和模型名后重试。'
          const chunkSize = 50
          for (let i = 0; i < fullText.length && !streamClosed && !control.aborted; i += chunkSize) {
            emitDelta(fullText.slice(i, i + chunkSize))
            await sleep(12)
          }
        }
        fullText = normalizeAgentReply(fullText, promptText)
        const usedModel = llmOut.model ?? 'local-template'
        if (llmOut.text === '' && !control.aborted)
          log('agent_warning', 'AI 模型未返回有效文本，已使用模板兜底')
        /**
         * 这一轮**模型调用本身失败**（不是模型正常回答里提到"失败"）：配了大模型却一个字都没拿到。
         *
         * 判定只看两件事：这次对话本来就该走模型（`chatReady`），且这一轮没有任何正文。
         * 未配置模型时走的是引导语（不是失败），不能算进来。用它决定任务终态与是否给三个出口（DEF-268）。
         */
        const modelCallFailed = chatReady && llmOut.text === ''

        // 智能体“动手”入口：识别内容创作/发布意图，生成可预览封面并返回发布动作卡片。
        const wantsAction = /(小红书|抖音|发布|创作|生成|种草|笔记)/i.test(promptText)
        // 发布闸门：这一句话里没有明确的发布指令，就只交付内容，不准备发布素材、不给发布入口。
        // 跟随模式会自动执行动作卡，少了这道闸等于智能体替用户按了发布。
        // 意图判定只看**当前轮用户消息**：数组输入里更早的文本可能是历史对话，
        // 不能拿它当本轮发布授权（DEF-240-IMPLEMENT-2 阶段四）。
        const wantsPublish = detectPublishIntent(extractCurrentTurnText(params.prompt))
        // 导航意图：用户说「打开数据中心」这类话时，直接回一张导航动作卡，
        // 前端点击/跟随模式自动执行即可跳到目标功能页（AC-018-1 只靠对话就能用各功能）。
        // 只有带明确「带我去」动词的句子才算导航，避免把创作需求误判成跳转。
        const navigateIntent = NAVIGATE_VERB.test(promptText)
          ? AGENT_NAVIGATE_INTENTS.find(item => item.pattern.test(promptText))
          : undefined
        // 模型明确表示无法执行/需人工时，绝不伪造“内容已准备好/可去发布”的动作卡。
        const modelRefused = /^(我无法|我不能|我没有权限|无法直接|不能直接|只能手动|抱歉，我无法)/.test(fullText)
        // 模型调用失败/无返回文本时也绝不进入发布动作链：当前已经如实展示失败原因，
        // 不能让用户带着“大模型调用失败”的正文继续去发布。
        // 判定必须以「用户实际看到的正文」为准，而不是 llmOut.error：
        // 模型流式超时时 error 会被置位，但正文其实已完整送达客户端，
        // 若按 error 一律掐掉动作卡，用户看着完整文案却点不到「去发布」。
        const modelFailed = fullText === '' || /^大模型调用失败/.test(fullText)
        const nudge = modelFailed || control.aborted ? undefined : await nudgeOnceIfIdle({ toolCalls, reply: fullText, sink: log, retry: () => kernelTurn === undefined ? Promise.resolve(undefined) : streamLlmWithDeltas(IDLE_NUDGE, emitDelta, llmOverride, IDLE_NUDGE, () => control.aborted, onKernelStep, true, kernelTurn.client).then(out => out.error === undefined ? { text: out.text, toolCalls } : undefined) })
        if (nudge !== undefined) fullText = normalizeAgentReply(nudge.text, promptText)
        let actionable: Record<string, unknown> | undefined
        // 素材生成失败会掐掉动作卡；此时必须在正文里如实说明，
        // 否则用户看着"点击「去发布」"的文案却找不到按钮（实测发生过）。
        let actionNote = ''
        if (navigateIntent !== undefined && !control.aborted) {
          // 导航是纯前端跳转，不依赖模型答得上来：模型超时或拒答时照样把入口给出去，
          // 而且这张卡描述的正是 APP 真的会做的事，不是「内容已准备好」这类效果承诺。
          actionable = {
            type: 'navigate',
            action: navigateIntent.type,
            platform: '',
            title: navigateIntent.label,
            description: `已为你准备好入口：点击「立即前往」打开${navigateIntent.label}。`,
            tags: [],
            medias: [],
          }
        }
        else if (wantsAction && wantsPublish && !modelRefused && !modelFailed && !control.aborted && !directPublishSubmitted) {
          const marker = ['📝 小红书笔记文案', '小红书笔记文案', '### 📝 小红书笔记文案', '【正文】']
            .find(token => fullText.includes(token))
          const actionableText = marker === undefined ? fullText : fullText.slice(fullText.indexOf(marker))
          const cleanText = actionableText
            .replace(/```/g, '')
            .replace(/[*_#>`]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
          const parsed = extractPublishContent(fullText)
          // 兜底标题从前只回落到**用户原话**，实测把"把无人机…发布到我的抖音账号"整句当标题发到了抖音。
          // 用户指令不是标题；取不到就用正文首句（那才是要给人看的话）。
          const titleFallback = (parsed.body || cleanText)
            .split(/[。！？!?\n]/)[0]
            ?.replace(/[*_#>`]/g, '')
            .trim()
            .slice(0, 30) ?? ''
          const agentTitle = (parsed.title || titleFallback).slice(0, 30)
          // 正文取不到时**绝不再回落成整段对话**：2026-09-29 现场，抖音收到的简介里
          // 连"请点击下方「去发布」按钮，我会带你在前端完成发布"这种对用户说的话都发了出去。
          // 这里退一步只保留「像文案的句子」（剥掉元信息句）；若被剥光则留空并告警——
          // 宁可这次少发，也不把助手的工作汇报当作品简介。
          const bodyFallback = cleanText
            .split(/(?<=[。！？!?])\s*/)
            .map(sentence => sentence.trim())
            .filter(sentence => sentence.length >= 8 && !META_LINE.test(sentence))
            .join('')
            .trim()
          const agentBody = parsed.body !== '' ? parsed.body : bodyFallback
          // 严格口径：正文为空（模型这轮没给「正文：」段，且剥掉元信息后什么都不剩）时，
          // **不生成发布动作卡**。2026-09-29 现场：模型只回了「已经准备完成。请点击下方
          // 「去发布」按钮，我会带你在前端完成发布和账号同步。」这种对话，旧实现把它当简介
          // 发到了抖音。宁可这次不发，也绝不把助手对用户说的话发到平台。
          const bodyMissing = agentBody === ''
          if (bodyMissing)
            log('agent_warning', '缺少可发布的正文段，将不生成「去发布」动作卡')
          const agentSubtitle = agentBody.slice(0, 40)
          const cover = await generateNoteCover(deps, agentTitle, agentSubtitle, 1)
          if (!cover.ok)
            log('agent_warning', 'AI 动作封面生成失败：' + cover.error)
          const mediaUrl = cover.ok ? (cover.urls[0] ?? '') : ''
          // 标签只认"话题标签/话题/Tags"那一行。从前是全文抓 #：正文被截断或排版变化时，
          // 抓出来的是一堆碎片（实测抖音后台收到的是 "#技#术#职#青 无#免 费#航 空" 这种拼接）。
          const tagLine = /(?:话题标签|话题|标签|Tags)\s*[：:]?\s*([^\n]+)/i.exec(actionableText)?.[1] ?? ''
          // 优先用提取器解析出的标签（它容忍「话题标签：」「话题 a、b、c」等写法）；
          // 它为空时才退回只认标签行的旧口径。
          const rawTags = (parsed.topics.length > 0 ? parsed.topics : tagLine.split(/[#\s,，、]+/))
            .map(part => part.replace(/[*_`>（）()【】\[\]]/g, '').trim())
            .map(part => part.replace(/[*_>`（）()【】\[\]]/g, '').trim())
            .filter(part => part.length >= 2 && part.length <= 20)
          const tags = Array.from(new Set(rawTags)).slice(0, 10)
          // 发布动作卡上的平台必须来自**用户这句话说的平台**，而不是"不是抖音就算小红书"。
          // 上一句里说"发布到快手/视频号"，卡片却指着小红书，用户点下去就到错的平台去发布。
          const wantsVideo = /(抖音|视频)/i.test(promptText)
          const actionPlatform = detectPublishPlatform(promptText)
          let publishReady = !bodyMissing
          let agentMedia: Array<{ type: 'image' | 'VIDEO'; url: string; coverUrl?: string }> = []
          if (mediaUrl !== '') {
            agentMedia.push({ type: 'image', url: mediaUrl, coverUrl: mediaUrl })
          }
          if (wantsVideo) {
            // 先看素材库里有没有现成的视频（用户自己上传的、或已经验收过的成品）。
            // 现场生成要等几分钟、还要花掉一次视频额度，而用户的原话是"重新生成多浪费时间，
            // 就用已有的那条"——所以有成品就直接复用，没有才现场生成（2026-09-29 用户现场）。
            const libraryVideo = latestLibraryVideo(deps)
            if (libraryVideo !== null) {
              // 封面用**素材自带的那一帧**（视频真实画面），生成的文字卡片只作兜底。
              // 2026-09-29 用户现场：产品生成的封面是一张蓝色渐变文字卡，左上角还印着
              // "小红书笔记"——那是给图文笔记用的排版，拿它当抖音视频封面既不对味也不好看；
              // 视频本身的画面（学员在实训车间、带字幕）才是这条片子真实的样子。
              agentMedia = [{
                type: 'VIDEO',
                url: libraryVideo.url,
                coverUrl: (libraryVideo.coverUrl ?? '') !== '' ? libraryVideo.coverUrl : mediaUrl,
              }]
              log('agent_info', '复用素材库里的视频：' + libraryVideo.url)
            }
            else {
              const videoMedia = await generateAgentVideo(deps, promptText)
              if (videoMedia === null) {
                log('agent_warning', '抖音视频素材生成失败，已阻止发布动作卡')
                publishReady = false
              }
              else {
                agentMedia = [{ type: 'VIDEO', url: videoMedia.url, coverUrl: videoMedia.coverUrl }]
              }
            }
          }
          // 模型用工具申请发布时以工具参数为准（结构化，不经文本正则）；
          // 卡片照旧由前端执行 —— 内核与服务端都不再是发布方。
          if (toolPublishRequest !== undefined) {
            actionable = {
              type: 'fullContent',
              action: 'navigateToPublish',
              // 走到这里已经过发布闸门（wantsAction && wantsPublish）：
              // 标记为「用户明确要求发布」，前端才允许在跟随模式下自动执行。
              explicitPublishIntent: true,
              // 工单号 + 三态：前端执行完据此回填「已执行/已核验」，内核的申请号与之对应。
              requestId: uid('pub'),
              state: 'requested',
              platform: toolPublishRequest.platform,
              title: toolPublishRequest.title,
              description: toolPublishRequest.description,
              tags: toolPublishRequest.tags,
              medias: toolPublishRequest.mediaUrl === ''
                ? []
                : [{
                    type: toolPublishRequest.mediaType,
                    url: toolPublishRequest.mediaUrl,
                    coverUrl: toolPublishRequest.coverUrl === '' ? toolPublishRequest.mediaUrl : toolPublishRequest.coverUrl,
                  }],
            }
          }
          else if (publishReady) {
            actionable = {
              type: 'fullContent',
              action: 'navigateToPublish',
              // 同上游闸门：能到这里说明用户这一句话明确要求发布，标记授权供前端自动执行。
              explicitPublishIntent: true,
              requestId: uid('pub'),
              state: 'requested',
              platform: actionPlatform,
              title: agentTitle,
              description: agentBody,
              tags,
              medias: agentMedia,
            }
          }
          else {
            actionNote = bodyMissing
              ? '\n\n> （这次回复里没有可直接发布的正文段，暂未提供「去发布」按钮。请让 AI 按「**标题**：… / **正文**：… / **话题标签**：#a #b」重新给一版文案。）'
              : '\n\n> （本次视频素材生成未完成，暂未提供「去发布」按钮；可稍后重试，或到创作页手动上传素材后发布。）'
          }
        }
        // 创作意图但没说发布：只交付正文，并如实告诉用户发布入口从哪来。
        // 这里不生成封面/视频素材，避免"用户没要发布却先花掉一次视频生成额度"。
        else if (wantsAction && !wantsPublish && !modelRefused && !modelFailed && !control.aborted && !directPublishSubmitted) {
          actionNote = '\n\n> （内容已生成，尚未发布。需要发布时回一句「发布到抖音」或「发布到小红书」，我再准备素材并给出「去发布」入口。）'
        }

        // 建草稿 / 改草稿：同样是"执行申请"，同样由前端执行（产品铁律 #2）。
        // 内核只登记参数，动作卡由前端消费——与发布那条路径同一套机制。
        // （出片不走这条路：长片在内容创作页由时长档决定，前端没有第二个出片入口。）
        if (toolPublishRequest === undefined && !control.aborted) {
          if (toolDraftRequest !== undefined) {
            const draftRequestId = uid('draft')
            // 内核工具已经落库（createdDraftId 非空）时**不发"申请"**：这一步已经做完了。
            // 卡片带 state='executed' 与真实 id，前端据此不再显示"存进草稿箱"按钮
            // （再点一次会写第二条草稿），状态行显示「已执行 · 真实 id：cnt-xxx」（DEF-270）。
            const draftWritten = createdDraftId !== ''
            actionable = {
              type: 'fullContent',
              action: 'saveDraft',
              requestId: draftRequestId,
              state: draftWritten ? 'executed' : 'requested',
              ...(draftWritten ? { draftId: createdDraftId } : {}),
              title: toolDraftRequest.title,
              description: toolDraftRequest.description,
              tags: toolDraftRequest.tags,
              medias: [],
            }
            // 台账与卡片同一口径：这一步的"做完了"由服务端自己记账——前端那条路常常拿不到
            // taskId（助手面板是临时会话），回填静默跳过，卡片只能停在「未回填」。
            if (draftWritten) {
              const results = Array.isArray(task.actionResults) ? task.actionResults : []
              if (!results.some(item => item.requestId === draftRequestId)) {
                results.push({
                  requestId: draftRequestId,
                  state: 'executed',
                  realId: createdDraftId,
                  note: '草稿已写入草稿箱',
                  at: nowIso(),
                })
              }
              task.actionResults = results
            }
          }
          else if (toolDraftUpdateRequest !== undefined) {
            const updateRequestId = uid('upd')
            actionable = {
              type: 'fullContent',
              action: 'updateDraft',
              requestId: updateRequestId,
              state: toolDraftUpdateRequest.executedId === undefined ? 'requested' : 'executed',
              draftId: toolDraftUpdateRequest.executedId ?? toolDraftUpdateRequest.id,
              title: toolDraftUpdateRequest.title,
              description: toolDraftUpdateRequest.description,
            }
            if (toolDraftUpdateRequest.executedId !== undefined) task.actionResults = [...(Array.isArray(task.actionResults) ? task.actionResults : []).filter(item => item.requestId !== updateRequestId), { requestId: updateRequestId, state: 'executed', realId: toolDraftUpdateRequest.executedId, note: '草稿已改写并落库', at: nowIso() }] // 与 saveDraft 同源（DEF-295）：内核已真落库才记 executed；状态行读的就是这份台账。这里用 filter + 展开而不是 saveDraft 的 some + push，是净 0 行（api.ts 冻结）约束下的等价写法，别顺手统一
          }
        }

        // 中断可能在收尾（封面/动作卡生成，数秒）期间到达：正文、动作卡与终态一律以当下的控制位为准。
        // 只读一次快照会让 abort 刚写下的 aborted 在几秒后被下面的 completed 覆盖回去（DEF-022）。
        if (control.aborted) {
          const delivered = emitted.trim()
          fullText = delivered === ''
            ? '（已中断：本次没有生成出内容。）'
            : delivered + '\n\n（已中断，以上为已生成的部分。）'
          actionable = undefined
          actionNote = ''
        }

        if (actionNote !== '')
          fullText += actionNote
        task.messages.push({
          type: 'assistant',
          uuid: uid('a'),
          content: fullText,
          message: { content: [{ type: 'text', text: fullText }] },
          ...(actionable === undefined ? {} : { result: [actionable] }),
          // DEF-268（2026-10-12，违反产品硬约束第 3 条）：模型调用失败时这条不是「正常回复」而是「失败」。
          // 前端按 message.status === 'error' 渲染「断点继续 / 重新生成 / 放弃」（ChatMessageList:164）。
          // 此前这里不带 status，失败被当成普通回复——用户只看到一行「大模型调用失败：…」+ 一直转的「思考中…」，
          // 一个按钮也点不了，只能自己重发。装机复验在安装版上实测到了这个场景。二次空转（nudge.gaveUp）同理——硬约束 3 要的是可点的三个选择。
          ...(modelFailed || nudge?.gaveUp === true ? { status: 'error' } : {}),
          createdAt: nowIso(),
        })
        // 失败不能落成「已完成」：装机现场那条任务正是 completed + 正文写着"大模型调用失败"，
        // 任务列表与助手正文各说一套，用户不知道该信哪一边（DEF-268）。aborted 的语义不变。
        if (modelCallFailed) {
          // 失败态用既有的 'error'（服务端 ZyAgentTask 的状态值域只有
          // running/completed/requires_action/error/aborted，前端 AgentTaskStatus.Error 与它对齐）；
          // 新增一个 'failed' 会让前端落到未知状态、任务列表显示不出人话。
          task.status = 'error'
          task.errorMessage = llmOut.error !== undefined && llmOut.error !== ''
            ? llmOut.error
            : '大模型调用失败'
        }
        else {
          task.status = control.aborted ? 'aborted' : (nudge?.gaveUp === true ? 'error' : 'completed')
          task.errorMessage = ''
        }
        task.updatedAt = nowIso()
        // 终态先落盘、再推事件：反过来会出现"前端已经拿到三个出口，任务列表里那条还是运行中"。
        files.tasks.save(tasks)

        safeSse({
          type: 'result',
          data: {
            content: fullText,
            ...(actionable === undefined ? {} : { result: [actionable] }),
            // DEF-268：实时路径也要带失败标记，否则用户不刷新就看不到三个选择。二次空转同理。
            ...(modelFailed || nudge?.gaveUp === true ? { status: 'error' } : {}),
          },
          sessionId: task.id,
          taskId: task.id,
          model: usedModel,
        })
        safeSse({ type: 'done', taskId: task.id })

        log('chat', promptText)
        // 中断只停这一次：会话已经不可信（模型被我们掐断），关掉它，下一轮冷启动并把历史喂回来。
        if (control.aborted) dropAgentKernel(task.id)
        // 助手对话也是蒸馏来源：一问一答留一条样本，注入了哪些知识一并入账
        // （与 /ai/chat 同一条账本——自进化的原料必须来自每一次真实任务，而不是只有生成那几条）。
        recordDistillation(deps, {
          task: 'chat',
          instruction: promptText,
          toolCalls,
          elapsedMs: Date.now() - turnStartedAt,
          // 口径：用**实际拼进提示词**的长度，而不是各块相加——助手这条路还无条件拼了记忆与画像，
          // 漏掉它会让"越用越省"的账把记忆算成零成本（llmOut.contextChars 由传输层统一产出）。
          contextChars: llmOut.contextChars ?? (chatKnowledge.chars + chatQuality.block.length),
          output: fullText,
          model: usedModel,
          knowledgePaths: chatKnowledge.paths,
          knowledgeChars: chatKnowledge.chars,
          exampleIds: chatQuality.ids,
          status: fullText !== '' && !control.aborted ? 'success' : 'failed',
          rating: 0,
          sourceId: task.id + '-' + sha8(fullText).slice(0, 4),
        })
        files.tasks.save(tasks)
        inFlightAgentTasks.delete(task.id)
        // 自进化（ADR-003 口径四 / Hermes 的 Nudge）：回复**已经发给用户**了，现在才复盘——
        // 两次模型调用不该让用户白等。复盘失败不影响任何已交付的东西，所以只 catch 不冒泡。
        void runEvolutionReview(
          deps.dataRoot,
          task.messages.slice(-12).map(message => String(message.content ?? '')).join('\n'),
          promptText,
          toolCalls,
          llmOverride,
        ).then((result) => {
          // 复盘是后台动作：只在真的跑了的时候留一条日志（这里已在 buildRoutes 内部，
          // files 早已初始化，log() 可用）。轨迹同时落在 memory/evolution-state.json。
          if (result.ran) log('evolution', '复盘完成：记忆 +' + String(result.memory) + ' 画像 +' + String(result.user) + ' 技能 +' + String(result.skill) + ' 超限 ' + String(result.rejected))
          // 把"这条已经升格过"写回账本：不写回，Curator 下一轮就把它当没升格过归档掉。
          if (result.learnedPath !== '') {
            const knowledge = files.knowledge.load() as KnowledgeState
            const target = (knowledge.distillations ?? []).find(record =>
              record.task === 'chat' && record.instruction === promptText && (record.skillPath ?? '') === '')
            if (target !== undefined) {
              target.skillPath = result.learnedPath
              files.knowledge.save(knowledge)
            }
          }
        }).catch((error: unknown) => {
          log('evolution', '复盘失败：' + String(error).slice(0, 200))
        })
        res.end()
      },
    },
    {
      m: 'GET',
      p: 'agent/tasks',
      h: ({ res, query }) => {
        const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
        const pageSize = Math.max(1, Number(query.get('pageSize') ?? 10) || 10)
        const keyword = (query.get('keyword') ?? '').trim()
        const favoriteOnly = query.get('favoriteOnly') === 'true'
        let list = files.tasks.load()
        if (keyword !== '') list = list.filter(t => t.title.includes(keyword) || t.prompt.includes(keyword))
        if (favoriteOnly) list = list.filter(t => t.favorite === true)
        const total = list.length
        const totalPages = Math.max(1, Math.ceil(total / pageSize))
        // 用量按任务归集：账本只扫一遍建索引，再逐条查（不逐条扫全表）。
        const usageIndex = taskUsageIndex()
        const slice = list.slice((page - 1) * pageSize, page * pageSize).map(t => ({
          id: t.id,
          userId: t.userId,
          title: t.title,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          status: t.status,
          rating: t.rating ?? null,
          ratingComment: t.ratingComment ?? null,
          favoritedAt: t.favoritedAt ?? null,
          // 归属管家：界面据此显示"这条是谁在办的"（呈现层改造方案 S1）。
          // 旧任务没有这个字段，用 null 表示"未登记"——不拿总管顶上（R5：缺失不许猜）。
          agentRole: t.agentRole ?? null,
          // 卡在哪：失败原因必须跟着列表一起出去。此前只有详情接口带它，于是任务卡上
          // 只有一个红色的"失败"，用户在列表里一眼看不出卡点，得逐条点进去才知道（G4）。
          errorMessage: t.errorMessage ?? '',
          // 花了多少：账本里没有这条任务的样本时给 null，界面显示"未采集"而不是 0。
          usage: usageIndex.get(t.id) ?? null,
        }))
        writeOk(res, { page, pageSize, totalPages, total, list: slice })
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/cleanup-running',
      h: ({ res }) => {
        const tasks = files.tasks.load()
        let updatedCount = 0
        for (const task of tasks) {
          if (task.status === 'running') { task.status = 'aborted'; updatedCount++ }
        }
        files.tasks.save(tasks)
        writeOk(res, { updatedCount })
      },
    },
    {
      m: 'GET',
      p: 'agent/tasks/:taskId/messages',
      h: ({ res, params, query }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        normalizeTaskMessages(task)
        const lastId = query.get('lastMessageId') ?? ''
        let messages = task.messages
        if (lastId !== '') {
          const idx = task.messages.findIndex(m => m.uuid === lastId)
          if (idx >= 0) messages = task.messages.slice(idx + 1)
        }
        writeOk(res, { messages, status: task.status })
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/:taskId/messages',
      h: ({ res, params, body }) => {
        const tasks = files.tasks.load()
        const task = tasks.find(t => t.id === params.taskId)
        if (task === undefined) {
          writeFail(res, 'task not found', 18100)
          return
        }
        const input = (body ?? {}) as { content?: unknown; medias?: unknown }
        const content = typeof input.content === 'string' ? input.content : ''
        const medias = Array.isArray(input.medias)
          ? input.medias
              .filter((item): item is { type?: unknown; url?: unknown; name?: unknown } => typeof item === 'object' && item !== null)
              .map(item => ({
                type: item.type === 'video' ? 'video' : 'image',
                url: typeof item.url === 'string' ? item.url : '',
                name: typeof item.name === 'string' ? item.name : 'AI 操作截图',
              }))
              .filter(item => item.url !== '')
          : []
        if (content === '' && medias.length === 0) {
          writeFail(res, '快照消息内容为空', 40000)
          return
        }
        const uuid = uid('snap')
        task.messages.push({
          type: 'result',
          uuid,
          message: content,
          result: [{ action: 'none', medias }],
          createdAt: nowIso(),
        })
        task.updatedAt = nowIso()
        files.tasks.save(tasks)
        writeOk(res, { uuid })
      },
    },
    {
      m: 'GET',
      p: 'agent/tasks/shared/:token',
      h: ({ res, params }) => {
        const link = findShareLink(params.token!)
        // 过期与不存在分开报：前端据此区分「链接已过期」与「链接无效」。
        if (link !== undefined && link.expiresAt <= Date.now()) { writeFail(res, 'shared task expired', 410, 410); return }
        const task = link === undefined ? undefined : files.tasks.load().find(t => t.id === link.taskId)
        if (task === undefined) { writeFail(res, 'shared task not found', 40404); return }
        const publicTask = { ...task, agentRole: task.agentRole ?? null, messages: task.messages.filter(m => m.type === 'assistant' || m.type === 'user') }
        normalizeTaskMessages(publicTask)
        writeOk(res, publicTask)
      },
    },
    {
      m: 'GET',
      p: 'agent/tasks/:taskId',
      h: ({ res, params }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        normalizeTaskMessages(task)
        // 归属管家随详情一起返回：旧任务没有该字段时显式补 null，界面显示"未登记"，
        // 而不是把"没有这个字段"当成"不归任何管家"。
        // 用量同源：与列表接口用同一个账本索引，两处对同一个任务必须给同一组数字。
        writeOk(res, { ...task, agentRole: task.agentRole ?? null, usage: taskUsageIndex().get(task.id) ?? null })
      },
    },
    {
      m: 'PATCH',
      p: 'agent/tasks/:taskId',
      h: ({ res, params, body }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        const patch = body as { title?: unknown }
        if (typeof patch.title === 'string' && patch.title.trim() !== '') task.title = patch.title.trim()
        task.updatedAt = nowIso()
        files.tasks.save(files.tasks.load())
        writeOk(res, { ok: true })
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/:taskId/dispatch',
      h: ({ res, params, body }) => {
        // 管家转交（BFS-105「总管拆解 → 分派给专业管家」）：把这条任务的**归属**改判给目标管家。
        // 这是产品里第一处能改判归属的入口——POST agent/tasks 的判定只在字段为空时写一次
        // （见 POST agent/tasks 里那次 agentRole 判定），「已经归 creator 的任务改判给 publisher」做不到。
        const task = files.tasks.load().find(t => t.id === params.taskId)
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        const input = (body ?? {}) as { role?: unknown }
        const wanted = typeof input.role === 'string' ? input.role.trim() : ''
        if (!AGENT_ROLES.includes(wanted as ZyAgentRole)) {
          writeFail(res, 'role 只支持 ' + AGENT_ROLES.join(' / ') + '（收到：' + (wanted === '' ? '空' : wanted) + '）', 40000)
          return
        }
        const role = wanted as ZyAgentRole
        const previousRole = task.agentRole ?? null
        task.agentRole = role
        task.updatedAt = nowIso()
        files.tasks.save(files.tasks.load())
        // 为什么不在这里关掉旧管家的会话（dropAgentKernel）：本接口是**内核进程自己**发起的调用
        // （总管在工具里调它），而这条任务的会话里就有发起者本人——关掉等于让工具执行到一半自杀，
        // 那一轮的正文与工具结果会一起丢。工具面是进程级的（kernel-client.ts 的 BF_AGENT_ROLE），
        // 而池键含管家（agentKernelKey）：改判后**下一次请求**用新管家取键必然取不到，自然是
        // 冷启动的新进程、带新管家的工具面；旧会话留在池里由 LRU 淘汰（AGENT_KERNEL_LIMIT）。
        writeOk(res, { taskId: task.id, agentRole: role, previousRole })
      },
    },
    {
      m: 'DELETE',
      p: 'agent/tasks',
      h: ({ res, body }) => {
        const input = (body ?? {}) as { taskIds?: unknown }
        const ids = Array.isArray(input.taskIds)
          ? input.taskIds.filter((item): item is string => typeof item === 'string' && item !== '')
          : []
        if (ids.length === 0) { writeFail(res, '没有选择要删除的任务', 40000); return }
        const removed = removeAgentTasks(new Set(ids))
        // 一条都没删掉时不许回成功：任务记录页此前没有任何删除入口，
        // 加批量删除时更不能让它变成"点了说成功、列表没变"。
        if (removed === 0) { writeFail(res, '这些任务不存在或已被删除', 40404); return }
        writeOk(res, { deleted: removed })
      },
    },
    {
      m: 'DELETE',
      p: 'agent/tasks/:taskId',
      h: ({ res, params }) => {
        if (removeAgentTasks(new Set([params.taskId!])) === 0) {
          writeFail(res, '任务不存在或已被删除', 18100)
          return
        }
        writeOk(res, { deleted: 1 })
      },
    },
    {
      m: 'GET',
      p: 'agent/tasks/:taskId/rating',
      h: ({ res, params }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        // 不存在的任务不能静默回 null：与 POST rating / share / abort 同规则（18100）。
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        // 单层 data：此前多包一层 data，调用方必须读 data.data 才能拿到评分（DEF-018）。
        writeOk(res, { rating: task.rating ?? null, comment: task.ratingComment ?? null })
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/:taskId/rating',
      h: ({ res, params, body }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        // 不存在的任务不能静默成功：评分没落库却回 code 0，用户以为打过分了。
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        const patch = body as { rating?: unknown; comment?: unknown }
        if (typeof patch.rating === 'number') task.rating = patch.rating
        if (typeof patch.comment === 'string') task.ratingComment = patch.comment
        task.updatedAt = nowIso()
        files.tasks.save(files.tasks.load())
        writeOk(res, null)
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/:taskId/abort',
      h: ({ res, params }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        const control = inFlightAgentTasks.get(params.taskId!)
        // 不存在的任务必须如实报错：回 code 0 时调用方无法区分「已中断」和「什么都没发生」
        // （share 分支同规则；实测过 zz-nonexistent 拿到 code 0）。
        if (task === undefined && control === undefined) { writeFail(res, 'task not found', 18100); return }
        // 先置控制位：正在生成的那一次立即停止转发增量与后续动作，并按「已中断」落库。
        if (control !== undefined) control.aborted = true
        if (task !== undefined && task.status === 'running') { task.status = 'aborted'; task.updatedAt = nowIso(); files.tasks.save(files.tasks.load()) }
        // 如实回报这次「停止」有没有落到正在生成的那一次：生成已经跑完时 interrupted=false，
        // 调用方据此区分「真的中断了」和「停晚了」，不用靠猜（验收脚本据此判红/跳过）。
        writeOk(res, { interrupted: control !== undefined })
      },
    },
    {
      /**
       * 动作执行回填：前端执行完一张动作卡后，把「工单号 → 执行结果」写回任务。
       *
       * 为什么必须回填：动作卡上的 requestId 由服务端发放，而**只有前端知道真实产物 id**
       * （新建草稿的 draftId、写回后的草稿、发布提交后的记录）。不回填的话，任务里只剩
       * "已申请"这一态，模型与用户都分不清这一步到底做完了没有——DEF-201/239 那类
       * "申请与结果分不清"的问题就出在这里。
       *
       * 状态只接受两态且不许倒退：`executed`（执行方已完成）可被 `verified`（平台回执可核验，
       * 例如发布记录里出现真实作品 ID）覆盖，反过来拒绝。
       */
      m: 'POST',
      p: 'agent/tasks/:taskId/action-result',
      h: ({ res, params, body }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        const input = (body ?? {}) as { requestId?: unknown, state?: unknown, realId?: unknown, note?: unknown }
        const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
        const state: 'executed' | 'verified' | '' = input.state === 'verified' ? 'verified' : input.state === 'executed' ? 'executed' : ''
        const realId = typeof input.realId === 'string' ? input.realId.trim() : ''
        const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : ''
        if (requestId === '') { writeFail(res, '缺少 requestId：回填必须指向具体的动作工单', 40000); return }
        if (state === '') { writeFail(res, 'state 只接受 executed 或 verified', 40000); return }
        const results = Array.isArray(task.actionResults) ? task.actionResults : []
        const previous = results.find(item => item.requestId === requestId)
        if (previous !== undefined && previous.state === 'verified' && state === 'executed') {
          writeFail(res, '这条工单已经核验通过，执行态不能倒退', 40000)
          return
        }
        const entry = { requestId, state, realId, note, at: nowIso() }
        if (previous === undefined) results.push(entry)
        else Object.assign(previous, entry)
        task.actionResults = results
        task.updatedAt = nowIso()
        files.tasks.save(files.tasks.load())
        writeOk(res, { requestId, state, realId })
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/:taskId/share',
      h: ({ res, params, body }) => {
        // 任务不存在就不发链接：否则用户拿到的是一条永远打不开的分享地址（实测过）。
        if (files.tasks.load().every(t => t.id !== params.taskId)) { writeFail(res, 'task not found', 18100); return }
        const link = createShareLink(params.taskId!, (body as { ttlSeconds?: unknown })?.ttlSeconds)
        writeOk(res, { token: link.token, expiresAt: new Date(link.expiresAt).toISOString(), urlPath: SHARE_URL_PATH + link.token })
      },
    },
    {
      m: 'POST',
      p: 'agent/tasks/:taskId/favorite',
      h: ({ res, params }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        // 与 rating/abort 同规则：不存在的任务不能静默成功，否则界面显示已收藏但没落库。
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        task.favorite = true
        task.favoritedAt = nowIso()
        files.tasks.save(files.tasks.load())
        writeOk(res, null)
      },
    },
    {
      m: 'DELETE',
      p: 'agent/tasks/:taskId/favorite',
      h: ({ res, params }) => {
        const task = files.tasks.load().find(t => t.id === params.taskId)
        if (task === undefined) { writeFail(res, 'task not found', 18100); return }
        task.favorite = false
        task.favoritedAt = null
        files.tasks.save(files.tasks.load())
        writeOk(res, null)
      },
    },

    // ---- AI 能力 ----------------------------------------------------------

    {
      m: 'GET',
      p: 'ai/models/chat',
      h: ({ res }) => {
        // 可选的对话模型 = **用户自己配的那些**。产品只内置服务商（Agnes），不内置任何大模型，
        // 所以没配置时这份清单就是空的——界面据此提示"去设置里配置"，而不是摆几个我们挑的型号。
        const cfg = readStoredLlm(deps.dataRoot)
        const configured = (cfg?.models !== undefined && cfg.models.length > 0
          ? cfg.models
          : (cfg?.model !== undefined && cfg.model !== '' ? [cfg.model] : []))
          .filter((id, index, list) => id.trim() !== '' && list.indexOf(id) === index)
        writeOk(res, configured.map((id, index) => ({
          name: id,
          description: cfg?.modelLabels?.[id] ?? id,
          logo: '',
          channel: 'user',
          scenes: ['comment', 'web'],
          inputModalities: ['text'],
          outputModalities: ['text'],
          pricing: {},
          fixedImagePricing: [],
          tags: index === 0 ? ['当前'] : [],
          mainTag: index === 0,
        })))
      },
    },
    {
      m: 'GET',
      p: 'ai/user-llm',
      h: ({ res }) => {
        const cfg = readStoredLlm(deps.dataRoot)
        const raw = readStoredLlmRaw(deps.dataRoot)
        const rawProviders = Array.isArray(raw?.providers) ? raw.providers as Record<string, unknown>[] : []
        writeOk(res, {
          baseUrl: cfg?.baseUrl ?? '',
          model: cfg?.model ?? '',
          displayName: cfg?.displayName ?? '',
          protocol: cfg?.protocol ?? '',
          models: cfg?.models ?? [],
          modelLabels: cfg?.modelLabels ?? {},
          activeProviderId: typeof raw?.activeProviderId === 'string' ? raw.activeProviderId : '',
          providers: (() => {
            const saved = rawProviders.map((item) => {
              const apiKey = typeof item.apiKey === 'string' ? item.apiKey : ''
              return {
                id: typeof item.id === 'string' ? item.id : '',
                displayName: typeof item.displayName === 'string' ? item.displayName : '',
                builtin: item.builtin === true,
                baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
                protocol: typeof item.protocol === 'string' ? item.protocol : '',
                models: Array.isArray(item.models) ? item.models : [],
                modelLabels: typeof item.modelLabels === 'object' && item.modelLabels !== null ? item.modelLabels : {},
                modelOptions: typeof item.modelOptions === 'object' && item.modelOptions !== null ? item.modelOptions : {},
                hasApiKey: apiKey !== '',
              }
            })
            // 内置 Agnes 系统大模型：这张卡永远在（用户只填一个 API Key 即可用文本/图片/视频），
            // 接口地址与模型清单都来自官方规格；用户自己配过 Agnes 服务时以他那份为准，不重复出卡。
            if (saved.some(item => item.id === AGNES_PROVIDER_ID || isAgnesBaseUrl(String(item.baseUrl))))
              return saved
            return [{
              id: AGNES_PROVIDER_ID,
              displayName: AGNES_DISPLAY_NAME,
              builtin: true,
              baseUrl: AGNES_BASE_URL,
              protocol: AGNES_PROTOCOL,
              // 模型目录从空开始：用户点「获取可用模型」从服务商读回真实清单再勾选。
              // 摆一份我们写死的目录，用户就会以为"这几个型号是产品带的"，而它们可能并不在他的 Key 里。
              models: [],
              modelLabels: {},
              modelOptions: {},
              hasApiKey: cfg !== undefined && cfg.apiKey !== '',
            }, ...saved]
          })(),
          hasApiKey: cfg !== undefined && cfg.apiKey !== '',
          image: {
            baseUrl: cfg?.imageBaseUrl ?? '',
            model: cfg?.imageModel ?? '',
            hasApiKey: cfg !== undefined && (cfg.imageApiKey ?? cfg.apiKey) !== '',
          },
          video: {
            baseUrl: cfg?.videoBaseUrl ?? '',
            model: cfg?.videoModel ?? '',
            hasApiKey: cfg !== undefined && (cfg.videoApiKey ?? cfg.apiKey) !== '',
          },
        })
      },
    },
    {
      m: 'PUT',
      p: 'ai/user-llm',
      h: ({ req, res, body }) => {
        const params = (body ?? {}) as { baseUrl?: unknown; apiKey?: unknown; model?: unknown; image?: unknown; video?: unknown; preserveStoredKey?: unknown; clear?: unknown; displayName?: unknown; protocol?: unknown; models?: unknown; modelLabels?: unknown; providers?: unknown; activeProviderId?: unknown; allowEmptyProviders?: unknown }
        const auditWho = String(req.headers['user-agent'] ?? '').slice(0, 120)
        const baseUrl = typeof params.baseUrl === 'string' ? params.baseUrl.trim() : ''
        const apiKeyInput = typeof params.apiKey === 'string' ? params.apiKey.trim() : ''
        const model = typeof params.model === 'string' ? params.model.trim() : ''
        const readNested = (value: unknown): { providerId?: string; baseUrl?: string; apiKey?: string; model?: string } => {
          const item = value as { providerId?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown } | undefined
          if (typeof item !== 'object' || item === null) return {}
          return {
            // providerId 让图片/视频通道跟着「模型所属的服务」走：前端拿不到别的服务的密钥，
            // 只能报"哪个服务 + 哪个模型"，由服务端补齐接口地址与密钥。
            ...(typeof item.providerId === 'string' && item.providerId.trim() !== '' ? { providerId: item.providerId.trim() } : {}),
            ...(typeof item.baseUrl === 'string' && item.baseUrl.trim() !== '' ? { baseUrl: item.baseUrl.trim() } : {}),
            ...(typeof item.apiKey === 'string' && item.apiKey.trim() !== '' ? { apiKey: item.apiKey.trim() } : {}),
            // model 允许空串：空串是"清掉这个通道"的显式表达，不能被当成"本次没提交"。
            ...(typeof item.model === 'string' ? { model: item.model.trim() } : {}),
          }
        }
        const image = readNested(params.image)
        const video = readNested(params.video)
        const existing = readStoredLlm(deps.dataRoot)
        const existingRaw = readStoredLlmRaw(deps.dataRoot)
        const displayName = typeof params.displayName === 'string' ? params.displayName.trim() : ''
        const protocol = typeof params.protocol === 'string' ? params.protocol.trim() : ''
        const models = Array.isArray(params.models)
          ? params.models.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
          : []
        const modelLabels = typeof params.modelLabels === 'object' && params.modelLabels !== null
          ? Object.fromEntries(Object.entries(params.modelLabels as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
            .map(([key, value]) => [key, value.trim()]))
          : {}

        // 已有多服务配置时，旧式单配置提交（应用启动时的浏览器副本同步等）只更新「当前生效服务」：
        // 其余服务原样保留，避免一次局部同步把设置页配好的多模型配置冲掉。
        if (!Array.isArray(params.providers) && params.clear !== true) {
          const priorProviders = Array.isArray(existingRaw?.providers) ? existingRaw.providers as Record<string, unknown>[] : []
          const priorActiveId = typeof existingRaw?.activeProviderId === 'string' ? existingRaw.activeProviderId.trim() : ''
          if (priorProviders.length > 0 && /^https?:\/\//.test(baseUrl) && model !== '') {
            const targetId = priorProviders.some(item => String(item.id ?? '') === priorActiveId)
              ? priorActiveId
              : String(priorProviders[0]?.id ?? '')
            params.providers = priorProviders.map((item) => {
              if (String(item.id ?? '') !== targetId) return item
              return {
                ...item,
                baseUrl,
                // 当前模型必须排在模型目录首位：服务端以首个模型为当前对话模型。
                models: [model, ...models.filter(id => id !== model)],
                ...(apiKeyInput !== '' ? { apiKey: apiKeyInput } : {}),
                ...(displayName !== '' ? { displayName } : {}),
                ...(protocol !== '' ? { protocol } : {}),
                ...(Object.keys(modelLabels).length > 0 ? { modelLabels } : {}),
              }
            })
            params.activeProviderId = targetId
          }
        }

        // 多提供方模式：设置页一次提交整张卡片列表。每个提供方留空密钥表示沿用已保存的密钥；
        // 当前生效提供方的字段同时镜像到顶层，保持既有单配置读取路径不变。
        if (Array.isArray(params.providers)) {
          const priorProviders = Array.isArray(existingRaw?.providers) ? existingRaw.providers as Record<string, unknown>[] : []
          // 把整份服务清空必须显式确认：设置页保存、脚本探针、自动化都可能提交空列表，
          // 一旦静默接受，用户的模型配置就整份消失（实测发生过：providers 变 [] 只剩图片/视频残留）。
          // 删除最后一个服务是合法操作，但要走 allowEmptyProviders 明确表达这个意图。
          const keepsSomeProvider = params.providers.length > 0
          const wipesExistingProviders = priorProviders.length > 0 && !keepsSomeProvider
          if (wipesExistingProviders && params.allowEmptyProviders !== true) {
            writeFail(res, '拒绝清空全部模型服务：该操作会删除已保存的 ' + String(priorProviders.length) + ' 个服务，需显式确认', 40000)
            return
          }
          const priorKey = new Map(priorProviders.map(item => [String(item.id ?? ''), typeof item.apiKey === 'string' ? item.apiKey : '']))
          // 旧式单配置升级：提供方列表还没有条目时，「当前生效服务」的密钥只能来自顶层镜像，
          // 按 baseUrl 匹配才补，避免把别的服务的密钥错配到新加的服务上。
          const legacyKey = typeof existingRaw?.apiKey === 'string' ? existingRaw.apiKey : ''
          const legacyBaseUrl = typeof existingRaw?.baseUrl === 'string' ? existingRaw.baseUrl.trim() : ''
          const providers = params.providers.flatMap((item): LlmProviderEntry[] => {
            if (typeof item !== 'object' || item === null) return []
            const entry = item as Record<string, unknown>
            const id = typeof entry.id === 'string' ? entry.id.trim() : ''
            if (id === '') return []
            const typed = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : ''
            const entryBaseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : ''
            const submittedModels = Array.isArray(entry.models)
              ? entry.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim())
              : []
            // 内置 Agnes 卡：前端只报「这张卡 + API Key」，**接口地址**由内置规格补齐（服务商是内置的）。
            // 模型目录一律用用户提交的那份：产品不内置任何大模型，替他补一份写死的目录
            // 等于让界面显示几个他并没有选过的型号。
            const builtinAgnes = id === AGNES_PROVIDER_ID || entry.builtin === true
            const resolvedBaseUrl = builtinAgnes && entryBaseUrl === '' ? AGNES_BASE_URL : entryBaseUrl
            const models = submittedModels
            const modelOptions = typeof entry.modelOptions === 'object' && entry.modelOptions !== null
              ? entry.modelOptions as Record<string, LlmModelOption>
              : undefined
            return [{
              id,
              displayName: typeof entry.displayName === 'string' && entry.displayName.trim() !== '' ? entry.displayName.trim() : (builtinAgnes ? AGNES_DISPLAY_NAME : id),
              ...(builtinAgnes ? { builtin: true } : {}),
              baseUrl: resolvedBaseUrl,
              apiKey: typed !== '' ? typed : (priorKey.get(id) ?? (resolvedBaseUrl !== '' && resolvedBaseUrl === legacyBaseUrl ? legacyKey : '')),
              ...(typeof entry.protocol === 'string' && entry.protocol.trim() !== ''
                ? { protocol: entry.protocol.trim() }
                : (builtinAgnes ? { protocol: AGNES_PROTOCOL } : {})),
              ...(models.length > 0 ? { models } : {}),
              ...(typeof entry.modelLabels === 'object' && entry.modelLabels !== null ? { modelLabels: entry.modelLabels as Record<string, string> } : {}),
              ...(modelOptions !== undefined ? { modelOptions } : {}),
            }]
          })
          const activeId = typeof params.activeProviderId === 'string' && params.activeProviderId.trim() !== ''
            ? params.activeProviderId.trim()
            : (providers[0]?.id ?? '')
          const active = providers.find(item => item.id === activeId) ?? providers[0]
          const keepImage = existing?.imageModel !== undefined && image.model === undefined
          const keepVideo = existing?.videoModel !== undefined && video.model === undefined
          // 图片/视频模型现在和对话模型一样挂在「服务」下面：模型属于哪个服务，就用哪个服务的
          // 接口地址与密钥。前端只报 providerId + model（它拿不到别的服务的密钥），这里补齐。
          const resolveChannel = (
            channel: { providerId?: string, baseUrl?: string, apiKey?: string, model?: string },
          ): { baseUrl: string, apiKey: string } => {
            const owner = channel.providerId !== undefined && channel.providerId !== ''
              ? providers.find(item => item.id === channel.providerId)
              : undefined
            return {
              baseUrl: channel.baseUrl ?? owner?.baseUrl ?? active?.baseUrl ?? '',
              apiKey: channel.apiKey ?? owner?.apiKey ?? active?.apiKey ?? '',
            }
          }
          const imageChannel = resolveChannel(image)
          const videoChannel = resolveChannel(video)
          // 图片/视频通道**只认用户显式选的那个型号**：没选就是没配，由界面提示去设置里选，
          // 不拿一个"官方默认档"顶上（顶上的后果是用户看到的是空的、实际请求却发着另一个型号）。
          const imageModel = image.model !== undefined ? image.model : undefined
          const videoModel = video.model !== undefined ? video.model : undefined
          const next: Record<string, unknown> = {
            baseUrl: active?.baseUrl ?? '',
            apiKey: active?.apiKey ?? '',
            model: active?.models?.[0] ?? '',
            ...(active?.displayName !== undefined ? { displayName: active.displayName } : {}),
            ...(active?.protocol !== undefined ? { protocol: active.protocol } : {}),
            ...(active?.models !== undefined ? { models: active.models } : {}),
            ...(active?.modelLabels !== undefined ? { modelLabels: active.modelLabels } : {}),
            ...(keepImage ? { imageBaseUrl: existing?.imageBaseUrl ?? '', imageApiKey: existing?.imageApiKey ?? '', imageModel: existing?.imageModel ?? '' } : {}),
            ...(imageModel !== undefined ? { imageBaseUrl: imageChannel.baseUrl, imageApiKey: imageChannel.apiKey, imageModel } : {}),
            ...(keepVideo ? { videoBaseUrl: existing?.videoBaseUrl ?? '', videoApiKey: existing?.videoApiKey ?? '', videoModel: existing?.videoModel ?? '' } : {}),
            ...(videoModel !== undefined ? { videoBaseUrl: videoChannel.baseUrl, videoApiKey: videoChannel.apiKey, videoModel } : {}),
            providers,
            activeProviderId: activeId,
          }
          auditLlmWrite(deps.dataRoot, 'providers', { providers: providers.length, activeId, wiped: wipesExistingProviders, ua: auditWho })
          const saveError = writeStoredLlm(deps.dataRoot, next as unknown as LlmOverride)
          if (saveError !== undefined) {
            writeFail(res, '模型配置未能保存：' + saveError, 50000)
            return
          }
          // 同步写进 DSH 用户设置与凭据文档，让内核的 llm-pi-ai 真正注册这些提供方与模型。
          writeKernelModelSettings(deps.dataRoot, providers)
          writeOk(res, { hasApiKey: (active?.apiKey ?? '') !== '', providerCount: providers.length })
          return
        }

        const preserveStoredKey = params.preserveStoredKey === true
        const apiKey = apiKeyInput || (preserveStoredKey && existing?.apiKey !== undefined ? existing.apiKey : '')
        if (params.clear === true || apiKey === '' || !/^https?:\/\//.test(baseUrl) || model === '') {
          // 旧式单配置路径的"缺字段即清空"同样会连多服务列表与图片/视频通道一起抹掉。
          // 已经配了多个服务时，这种清空必须显式（clear / allowEmptyProviders），
          // 否则一次不带 providers 的旧客户端请求就能把用户配置整份带走。
          const priorProviderCount = Array.isArray(existingRaw?.providers) ? existingRaw.providers.length : 0
          if (priorProviderCount > 0 && params.clear !== true && params.allowEmptyProviders !== true) {
            writeFail(res, '拒绝用旧式单配置请求清空已保存的 ' + String(priorProviderCount) + ' 个模型服务，需显式确认', 40000)
            return
          }
          auditLlmWrite(deps.dataRoot, 'legacy-clear', { providers: 0, reason: params.clear === true ? 'clear' : 'empty-payload', ua: auditWho })
          const clearError = writeStoredLlm(deps.dataRoot, null)
          if (clearError !== undefined) {
            writeFail(res, '模型配置未能清空：' + clearError, 50000)
            return
          }
          writeOk(res, { hasApiKey: false })
          return
        }
        // 合并保存：只更新本次提交的通道，保留已配置的图片/视频模型，
        // 避免前端仅同步对话配置时把多通道配置覆盖掉。
        const mergeError = writeStoredLlm(deps.dataRoot, {
          baseUrl,
          apiKey,
          model,
          ...(displayName !== '' ? { displayName } : (existing?.displayName !== undefined ? { displayName: existing.displayName } : {})),
          ...(protocol !== '' ? { protocol } : (existing?.protocol !== undefined ? { protocol: existing.protocol } : {})),
          ...(models.length > 0 ? { models } : (existing?.models !== undefined ? { models: existing.models } : {})),
          ...(Object.keys(modelLabels).length > 0 ? { modelLabels } : (existing?.modelLabels !== undefined ? { modelLabels: existing.modelLabels } : {})),
          ...(existing?.imageModel !== undefined && image.model === undefined
            ? { imageBaseUrl: existing.imageBaseUrl ?? baseUrl, imageApiKey: existing.imageApiKey ?? apiKey, imageModel: existing.imageModel }
            : {}),
          ...(image.model !== undefined ? { imageBaseUrl: image.baseUrl ?? baseUrl, imageApiKey: image.apiKey ?? apiKey, imageModel: image.model } : {}),
          ...(existing?.videoModel !== undefined && video.model === undefined
            ? { videoBaseUrl: existing.videoBaseUrl ?? baseUrl, videoApiKey: existing.videoApiKey ?? apiKey, videoModel: existing.videoModel }
            : {}),
          ...(video.model !== undefined ? { videoBaseUrl: video.baseUrl ?? baseUrl, videoApiKey: video.apiKey ?? apiKey, videoModel: video.model } : {}),
        })
        if (mergeError !== undefined) {
          writeFail(res, '模型配置未能保存：' + mergeError, 50000)
          return
        }
        writeOk(res, { hasApiKey: true })
      },
    },
    {
      m: 'POST',
      p: 'ai/models/fetch',
      h: async ({ res, body }) => {
        const params = (body ?? {}) as { baseUrl?: unknown; apiKey?: unknown }
        const stored = readStoredLlm(deps.dataRoot)
        const baseUrl = (typeof params.baseUrl === 'string' ? params.baseUrl.trim().replace(/\/+$/, '') : '') || stored?.baseUrl.trim().replace(/\/+$/, '') || ''
        const apiKey = (typeof params.apiKey === 'string' ? params.apiKey.trim() : '') || stored?.apiKey || ''
        if (!/^https?:\/\//.test(baseUrl)) {
          writeFail(res, '接口地址需以 http(s):// 开头', 500)
          return
        }
        // 兼容「/v1 结尾」与「不带 /v1」两类地址；多数 OpenAI 兼容厂商两种都支持
        const candidates = [...new Set([baseUrl + '/models', baseUrl + '/v1/models'])]
        let lastErr = '无法连接'
        for (const url of candidates) {
          try {
            const controller = new AbortController()
            const timer = setTimeout(() => { controller.abort() }, 20000)
            const resp = await fetch(url, {
              headers: apiKey !== '' ? { Authorization: 'Bearer ' + apiKey } : {},
              signal: controller.signal,
            })
            clearTimeout(timer)
            if (!resp.ok) {
              lastErr = 'HTTP ' + resp.status
              continue
            }
            const json = await resp.json() as { data?: { id?: unknown }[] }
            const models = (Array.isArray(json.data) ? json.data : [])
              .map(m => m?.id)
              .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
              .map(id => id.trim())
              .filter((id, index, arr) => arr.indexOf(id) === index)
              .sort()
            if (models.length > 0) {
              writeOk(res, { models, source: url })
              return
            }
            lastErr = '响应中没有模型列表'
          } catch (error) {
            lastErr = error instanceof Error && error.name === 'AbortError' ? '请求超时' : '网络错误'
          }
        }
        writeFail(res, '获取可用模型失败：' + lastErr + '（请检查接口地址与 API Key）', 500)
      },
    },
    {
      m: 'POST',
      p: 'ai/note-cover',
      h: async ({ res, body }) => {
        const params = (body ?? {}) as { title?: unknown; subtitle?: unknown; count?: unknown }
        const title = typeof params.title === 'string' ? params.title.trim() : ''
        if (title === '') {
          writeFail(res, '缺少笔记标题', 500)
          return
        }
        const subtitle = typeof params.subtitle === 'string' ? params.subtitle.trim().slice(0, 40) : ''
        const count = Math.max(1, Math.min(4, Number(params.count ?? 1) || 1))
        const result = await generateNoteCover(deps, title, subtitle, count)
        if (!result.ok) {
          writeFail(res, result.error, 500)
          return
        }
        writeOk(res, { urls: result.urls })
      },
    },
    {
      m: 'GET',
      p: 'ai/logs',
      h: ({ res, query }) => {
        const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
        const pageSize = Math.max(1, Number(query.get('pageSize') ?? 10) || 10)
        const all = files.logs.load()
        writeOk(res, { page, pageSize, totalPages: Math.max(1, Math.ceil(all.length / pageSize)), total: all.length, list: all.slice((page - 1) * pageSize, page * pageSize) })
      },
    },
    {
      m: 'POST',
      p: 'ai/logs',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { kind?: unknown; detail?: unknown }
        const kind = typeof params.kind === 'string' && params.kind !== '' ? params.kind : 'frontend'
        const detail = typeof params.detail === 'string' ? params.detail : ''
        log(kind, detail.slice(0, 300))
        writeOk(res, { ok: true })
      },
    },
    {
      m: 'GET',
      p: 'ai/video/generations',
      h: ({ res, query }) => {
        const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
        const pageSize = Math.max(1, Number(query.get('pageSize') ?? 10) || 10)
        const list = files.generations.load().slice((page - 1) * pageSize, page * pageSize).map(g => ({
          task_id: g.id,
          action: 'video',
          status: (g.status === 'success' || g.status === 'partial') ? 'SUCCESS' : g.status === 'generating' ? 'PROCESSING' : 'FAILED',
          prompt: g.response?.title ?? '',
          progress: g.status === 'success' ? 100 : 0,
          submit_time: g.createdAt,
          finish_time: g.updatedAt,
          data: {
            status: (g.status === 'success' || g.status === 'partial') ? 'succeeded' : 'pending',
            url: g.response?.coverUrl ?? g.response?.imageUrls?.[0] ?? '',
            video_url: g.response?.videoUrl ?? '',
            error: g.errorMessage ?? null,
          },
        }))
        writeOk(res, { list, total: files.generations.load().length, page, pageSize })
      },
    },
    {
      m: 'GET',
      p: 'ai/assets',
      h: ({ res, query }) => {
        const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
        const pageSize = Math.max(1, Number(query.get('pageSize') ?? 10) || 10)
        const assets = files.contents.load().filter(item => item.kind === 'asset')
        const list = assets.slice((page - 1) * pageSize, page * pageSize).map(item => ({
          id: 'asset-' + item._id,
          url: item.url,
          type: item.type === 'video' ? 'aiVideo' : item.type === 'img' ? 'aiImage' : 'aiChatImage',
          mimeType: String(item.metadata?.mimeType ?? (item.type === 'video' ? 'video/mp4' : 'image/png')),
          filename: item.title || item._id,
          metadata: {
            ...(item.thumbUrl ? { cover: item.thumbUrl } : {}),
            ...(item.metadata ?? {}),
          },
          status: 'done',
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
          userId: item.userId,
        }))
        writeOk(res, { list, total: assets.length, page, pageSize })
      },
    },
    {
      m: 'GET',
      p: 'ai/object-actions',
      h: ({ res, query }) => {
        // 前端据此渲染每个对象上的 AI 按钮：动作清单只有服务端知道，界面不写死。
        writeOk(res, { list: objectActionsFor(query.get('kind') ?? 'draft') })
      },
    },
    {
      m: 'POST',
      p: 'ai/object-action',
      h: async ({ res, body }) => {
        const params = body as { kind?: unknown, id?: unknown, action?: unknown, extra?: unknown, llm?: unknown }
        const llmOverride = parseLlmOverride(params.llm) ?? readStoredLlm(deps.dataRoot)
        if (llmOverride === undefined || llmOverride.model.trim() === '') {
          writeFail(res, '还没有配置大模型，请到 设置 → 自定义大模型 填好地址与密钥', 40401)
          return
        }
        const result = await runObjectAction({
          kind: typeof params.kind === 'string' ? params.kind : '',
          id: typeof params.id === 'string' ? params.id : '',
          action: typeof params.action === 'string' ? params.action : '',
          ...(typeof params.extra === 'string' ? { extra: params.extra } : {}),
          llm: llmOverride,
        })
        if (!result.ok) {
          writeFail(res, result.message, 40400)
          return
        }
        writeOk(res, { field: result.field, value: result.value, before: result.before })
      },
    },
    {
      m: 'POST',
      p: 'ai/chat',
      h: async ({ res, body }) => {
        const params = body as { messages?: { role: string; content: string }[]; llm?: unknown }
        const lastUser = [...params.messages ?? [].values()].reverse().find(m => m.role === 'user')
        // 多轮上下文：前端每次都把整段对话送上来，而这里原先只看最后一条用户消息——
        // 于是"接着说""把标题改短点"这类追问一律被当成第一次提问（用户口径的"没有上下文功能"）。
        const transcript = chatTranscript(params.messages)
        const llmOverride = parseLlmOverride(params.llm) ?? readStoredLlm(deps.dataRoot)
        let llmOut: { text: string; model?: string } = { text: '' }
        // 知识库注入：对话同样先检索知识笔记，命中即进上下文（对话与生成共用一条检索链路）。
        const chatKnowledge = buildKnowledgeContext(files.knowledge.load() as KnowledgeState, lastUser?.content ?? '')
        // 同智能体那条链路：没选型号等于没配完，走引导回复而不是拿空模型名去调内核。
        const chatReady = llmOverride !== undefined && llmOverride.model.trim() !== ''
        if (deps.kernelAi === true && chatReady) {
          // 路由 id 必须与设置页写入 settings.yaml 的那个一致（kernelRouteId），
          // 写死 'agnes' 会在提供方 id 不是 agnes 时找不到路由（DEF-072 同源）。
          const chatProvider = llmOverride?.providers?.find(item => item.id === llmOverride.activeProviderId) ?? llmOverride?.providers?.[0]
          const kernel = createKernelClient({
            provider: chatProvider !== undefined ? kernelRouteId(chatProvider.id) : 'agnes',
            model: llmOverride.model,
            baseUrl: llmOverride.baseUrl,
            apiKey: llmOverride.apiKey,
          })
          // 整段对话带进这一轮的提示词——上下文只走这一条通道（内核会话是进程内的，不能跨请求复用）。
          const out = await kernel.prompt(
            TEXT_ONLY_GUARD + chatKnowledge.block + '\n\n[对话]\n' + (transcript === '' ? lastUser?.content ?? '' : transcript) + '\n\n[请回复最后一条]',
          )
          await kernel.close()
          llmOut = out.error === undefined ? { text: out.text, model: 'dsh-kernel' } : { text: '' }
        } else if (chatReady) {
          llmOut = await streamLlmWithDeltas('请接着下面的对话回复最后一条：\n\n' + (transcript === '' ? lastUser?.content ?? '' : transcript), undefined, llmOverride, chatKnowledge.block)
        }
        const answer = llmOut.text !== '' ? llmOut.text : unconfiguredReply(lastUser?.content ?? '')
        // 对话也是蒸馏来源：一问一答留一条样本，注入了哪些知识同样入账。
        recordDistillation(deps, {
          task: 'chat',
          instruction: lastUser?.content ?? '',
          output: llmOut.text,
          model: llmOut.model ?? 'local-template',
          knowledgePaths: chatKnowledge.paths,
          knowledgeChars: chatKnowledge.chars,
          status: llmOut.text !== '' ? 'success' : 'failed',
          rating: 0,
          sourceId: 'chat-' + Date.now() + '-' + sha8(answer).slice(0, 4),
        })
        log('ai-chat', lastUser?.content ?? '')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          id: 'chatcmpl-' + sha8(answer),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: llmOut.model ?? 'local-template',
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }))
      },
    },

    // ---- 消息通知（公告 + 更新日志，动态真实时间，不再硬编码日期） -------------------------

    {
      m: 'GET',
      p: 'notification/list',
      h: ({ res }) => {
        // 公告只返回运营真实写入的（绝不播种虚假公告）；
        // 更新日志来自 changelog.ts 的真实发布记录——它此前只存在于仓库文档里，
        // 界面上那一栏因此永远是空的，用户看不到"这版改了什么"。
        const items = files.notifications.load()
        const announcements = items.filter(item => typeof item.id === 'string' && typeof item.title === 'string')
        writeOk(res, [...changelogNotifications(), ...announcements])
      },
    },
    {
      m: 'GET',
      p: 'v2/auto-task/status',
      h: ({ res }) => {
        // 自动任务的只读状态：跑了几轮、上次什么时候、各类发现多少、自己有没有出错。
        // 界面据此如实显示"上次检查"，不伪造"刚刚检查过"。它不触发任何扫描，也不碰平台。
        writeOk(res, autoTaskStatus(deps))
      },
    },
    {
      m: 'GET',
      p: 'v2/prefs/disclaimer',
      h: ({ res }) => {
        writeOk(res, { accepted: files.prefs.load().disclaimerAccepted === true })
      },
    },
    {
      m: 'PUT',
      p: 'v2/prefs/disclaimer',
      h: ({ res, body }) => {
        const accepted = (body as { accepted?: unknown })?.accepted === true
        const prefs = files.prefs.load()
        prefs.disclaimerAccepted = accepted
        files.prefs.save(prefs)
        writeOk(res, { accepted })
      },
    },
    // ---- 草稿生成 ---------------------------------------------------------

    {
      m: 'POST',
      p: 'ai/draft-generation/v2',
      h: ({ res, body }) => { writeOk(res, createDraftGeneration(deps, body, 'video')) },
    },
    {
      m: 'POST',
      p: 'ai/draft-generation/image-text',
      h: ({ res, body }) => { writeOk(res, createDraftGeneration(deps, body, 'image-text')) },
    },
    {
      m: 'GET',
      p: 'ai/draft-generation/pricing',
      h: ({ res }) => {
        const userCfg = readStoredLlm(deps.dataRoot)
        // 可选模型 = **用户在设置里配的那些型号**，一个都不多。
        //
        // 产品只内置服务商（Agnes 的地址与协议），不内置任何大模型：我们既不知道用户这把 Key
        // 能用哪些型号，也不该替他挑一个。所以这里没有"内置模型"可列——没配就是空清单，
        // 由界面提示"去设置里配置"（前端按空清单渲染那条提示）。
        //
        // 图片档位与视频一致（720p/1080p），成品像素由「档位 + 画幅」派生：
        // 定价行一一对应，前端切比例后下拉不会出现别家的尺寸（P-012/P-013）。
        const configuredImageModel = (userCfg?.imageModel ?? '').trim()
        // 这把 Key 用不了的模型（厂商回过 401/403 的结论）如实标出来，但**不隐藏**：
        // 这是用户唯一配置的型号，藏起来他就只剩一个空下拉，连"为什么不能生成"都看不到。
        const imageBaseForDenied = (userCfg?.imageBaseUrl || userCfg?.baseUrl || '').trim()
        const imageModelDenied = configuredImageModel !== ''
          && imageBaseForDenied !== ''
          && isAgnesBaseUrl(imageBaseForDenied)
          && modelDenied(deps.dataRoot, imageBaseForDenied, configuredImageModel)
        if (imageModelDenied) console.error('[AI_IMG_ERR] 模型 ' + configuredImageModel + ' 已被记为无权限，界面上会如实标注')
        const imageModels: unknown[] = configuredImageModel === ''
          ? []
          : [{
              model: configuredImageModel,
              displayName: configuredImageModel + '（已配置）' + (imageModelDenied ? '·你的 Key 无权限' : ''),
              pricing: imagePricingRows(),
              supportedAspectRatios: IMAGE_RATIOS,
              maxInputImages: 9,
              styles: ['写实', '插画', '水彩', '油画', '卡通', '赛博朋克', '电影感', '极简'],
              tags: ['user'],
            }]
        // 本地排版卡片（zy-template-image）同理不再摆进模型下拉：它不是模型，是本机排版兜底。
        // 能力本身保留——厂商调用失败时仍用它顶上，并如实标注"这是降级"。
        const videoModels: unknown[] = []
        // 唯一的那个视频模型 = 用户在设置里配的型号（没有就是空清单，界面提示去配置）。
        //
        // 档位/时长/画幅按**官方规格**下发（agnes.ts 的能力表）：Flash 只收 720P 是官方硬限制，
        // 界面因此不会摆出它做不到的 1080p——配了型号却选了出不来的档位，是本项目反复踩过的坑。
        const configuredVideoModel = (userCfg?.videoModel ?? '').trim()
        // 这把 Key 用不了的型号（厂商回过 401/403 的结论）如实标注但**不隐藏**（理由同图片通道）。
        const videoBaseForDenied = (userCfg?.videoBaseUrl || userCfg?.baseUrl || '').trim()
        const videoModelDenied = configuredVideoModel !== ''
          && videoBaseForDenied !== ''
          && isAgnesBaseUrl(videoBaseForDenied)
          && modelDenied(deps.dataRoot, videoBaseForDenied, configuredVideoModel)
        if (videoModelDenied) console.error('[AI_VID_ERR] 模型 ' + configuredVideoModel + ' 已被记为无权限，界面上会如实标注')
        for (const model of configuredVideoModel === '' ? [] : [configuredVideoModel]) {
          // 用户自带厂商的模型：没有官方规格可依据，沿用产品标准档位（720p/1080p、4~12 秒），
          // 真实档位由"下单被拒时按厂商自报降档"的既有机制在生成时收敛。
          if (!isAgnesVideoModel(model)) {
            videoModels.push({
              name: model,
              description: model + '（已配置）' + (videoModelDenied ? '·你的 Key 无权限' : ''),
              channel: 'user',
              creditsScope: 'general',
              modes: ['text2video'],
              resolutions: ['720p', '1080p'],
              durations: [...PRODUCT_VIDEO_GEARS],
              // 30 秒 / 1 分钟：官方单次只收 4~12 秒，这两档由多个 4 秒片段拼成（界面单独摆成档位按钮）。
              longDurations: [...COMPOSED_VIDEO_GEARS],
              maxInputImages: 9,
              aspectRatios: ['1:1', '9:16', '16:9'],
              inputConstraints: {
                images: { maxCount: 9 },
                videos: { maxCount: 1, maxDuration: 12, maxTotalDuration: 12 },
                audios: { maxCount: 1, maxDuration: 12, maxTotalDuration: 12 },
              },
              tags: ['user'],
              styles: ['写实', '电影感', '科技感'],
              defaults: { resolution: '720p', aspectRatio: '9:16', duration: 5 },
            })
            continue
          }
          const limits = agnesVideoLimits(model)
          // 产品只摆自己的两档（720p/1080p）：官方 1K/2K 是厂商口径，产品侧还没有对应的成品画布。
          // 官方能力仍决定这两档里哪些能用——Flash 只收 720P，界面就不会再摆出它做不到的 1080p。
          const officialSizes = agnesVideoSizes(model)
          // 判据是"这个档位**原生**在不在官方白名单里"，不是"降档后能不能用"：
          // Flash 拿到 1080p 会降成 720P，用它当判据会把 1080p 也摆出来——那就又回到"选了出不来"。
          const productTierSizes: Record<string, string> = { '720p': '720P', '1080p': '1080P' }
          const resolutions = Object.keys(productTierSizes).filter(tier => officialSizes.includes(productTierSizes[tier] ?? ''))
          videoModels.push({
            name: model,
            description: model + '（已配置）' + (videoModelDenied ? '·你的 Key 无权限' : ''),
            channel: 'user',
            creditsScope: 'general',
            // 参考素材能力分两条报：`multi-ref` = 收参考**图/音频**（前端据此决定「上传」按钮开不开），
            // `video2video` = 收参考**视频**。原先两条都绑在 limits.videos 上，于是 Flash（收 5 张参考图、
            // 但不收参考视频）被判成"纯文生视频"——视频档位下连图片都不给上传，只有换成收费的 2.5 才能传。
            modes: [
              'text2video',
              ...(limits.images > 0 ? ['multi-ref'] : []),
              ...(limits.videos > 0 ? ['video2video'] : []),
            ],
            resolutions,
            // 官方 seconds 是字符串 "4"~"12"，产品只摆官方区间内的整数档位。
            durations: Array.from({ length: AGNES_VIDEO_SECONDS_MAX - AGNES_VIDEO_SECONDS_MIN + 1 }, (_, i) => AGNES_VIDEO_SECONDS_MIN + i)
              .filter(seconds => PRODUCT_VIDEO_GEARS.includes(seconds)),
            // 30 秒 / 1 分钟：官方单次只收 4~12 秒，这两档必须多片段拼接（每片 4 秒，余数并入收尾片）。
            // 一起把诚实耗时预估带给界面，免得用户对着进度条猜（30 秒 ≈ 5~30 分钟、60 秒 ≈ 9~63 分钟）。
            longDurations: [...COMPOSED_VIDEO_GEARS],
            longDurationEstimates: Object.fromEntries(COMPOSED_VIDEO_GEARS.map(seconds => [String(seconds), estimateMinutes(seconds)])),
            maxInputImages: limits.images,
            aspectRatios: [...AGNES_VIDEO_RATIOS],
            inputConstraints: {
              images: { maxCount: limits.images },
              videos: { maxCount: limits.videos, maxDuration: AGNES_VIDEO_SECONDS_MAX, maxTotalDuration: AGNES_VIDEO_SECONDS_MAX },
              audios: { maxCount: limits.audios, maxDuration: AGNES_VIDEO_SECONDS_MAX, maxTotalDuration: AGNES_VIDEO_SECONDS_MAX },
            },
            tags: ['user'],
            styles: ['写实', '电影感', '科技感'],
            defaults: { resolution: resolutions[0] ?? '720p', aspectRatio: '9:16', duration: 5 },
          })
        }
        writeOk(res, {
          imageModels,
          videoModels,
        })
      },
    },
    {
      m: 'POST',
      p: 'ai/draft-generation/from-video-url',
      h: ({ res, body }) => {
        const videoUrl = readStr({ res, body, params: {}, query: new URLSearchParams() } as never, 'videoUrl')
        const contents = files.contents.load()
        const material = {
          kind: 'asset' as const,
          _id: uid('cnt'),
          userId: 'zy-user-001',
          groupId: readStr({ res, body, params: {}, query: new URLSearchParams() } as never, 'groupId', DEFAULT_MATERIAL_GROUP_ID),
          type: 'video' as const,
          url: videoUrl,
          thumbUrl: '',
          title: '来自链接的视频',
          desc: '',
          useCount: 0,
          metadata: {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        contents.unshift(material)
        files.contents.save(contents)
        writeOk(res, { materialId: material._id })
      },
    },
    {
      m: 'GET',
      p: 'ai/draft-generation/stats',
      h: ({ res }) => {
        writeOk(res, { generatingCount: files.generations.load().filter(g => g.status === 'generating').length })
      },
    },
    {
      m: 'POST',
      p: 'ai/draft-generation/query',
      h: ({ res, body }) => {
        const want = ((body as { taskIds?: unknown }).taskIds ?? []) as string[]
        const tasks = files.longVideoTasks.load()
        // 生成中的记录**带上实时进度**：内容创作界面上此前只有"生成中"三个字，
        // 用户不知道在写稿、排分镜还是逐镜出片，也不知道还剩多少（一条 1 分钟片要 20~60 分钟）。
        // 调用方（内核工具与界面）据此把"任务号 → 草稿"接上，不必再靠标题去草稿列表里翻。
        const draftIdByGeneration = draftIdIndex(deps)
        const rows = files.generations.load()
          .filter(g => want.includes(g.id))
          .map((g) => {
            const draftId = draftIdByGeneration.get(g.id) ?? ''
            const taskId = String((g.response as { longVideoTaskId?: unknown } | undefined)?.longVideoTaskId ?? '')
            const task = taskId === '' ? undefined : tasks.find(t => t.id === taskId)
            if (task === undefined || task.status !== 'generating') return { ...g, draftId }
            const shots = task.shots ?? []
            const ready = shots.filter(s => s.status === 'ready').length
            const total = shots.length
            // 进度按**整条片子的完成度**算，不是"镜头数除以镜头数"：
            // 镜头全出完还要合成、烧字幕、落盘，那时才 100%——否则用户看到 100% 却没有成片
            // （剪映那种导出进度条的口径：只有最终文件生成完才是 100%）。
            const planPercent = 8
            const composePercent = 88
            let stage = '写稿与排分镜'
            let percent = 4
            if (total > 0) {
              if (ready < total) {
                stage = '逐镜生成'
                percent = planPercent + Math.round((ready / total) * (composePercent - planPercent - 8))
              }
              else {
                stage = '合成与导出'
                percent = composePercent
              }
            }
            return {
              ...g,
              draftId,
              progress: {
                stage,
                percent,
                shotsReady: ready,
                shotsTotal: total,
                targetSeconds: task.targetSeconds,
                taskId,
              },
            }
          })
        writeOk(res, rows)
      },
    },
    {
      m: 'DELETE',
      p: 'ai/draft-generation',
      h: ({ res, body }) => {
        const params = (body ?? {}) as { taskIds?: unknown; all?: unknown }
        const list = files.generations.load()
        const before = list.length
        const ids = Array.isArray(params.taskIds) ? params.taskIds.filter((id): id is string => typeof id === 'string') : []
        const removedIds = new Set(params.all === true ? list.map(g => g.id) : list.filter(g => ids.includes(g.id)).map(g => g.id))
        const next = params.all === true ? [] : list.filter(g => !ids.includes(g.id))
        files.generations.saveEmpty(next)
        removeGenerationArtifacts(deps, removedIds)
        writeOk(res, { deleted: before - next.length })
      },
    },
    {
      m: 'DELETE',
      p: 'ai/draft-generation/:id',
      h: ({ res, params }) => {
        const list = files.generations.load()
        const idx = list.findIndex(g => g.id === params.id)
        if (idx >= 0) {
          list.splice(idx, 1)
          // 删最后一条时 list 变成空数组，save([]) 会撞上 store 的空值守卫
          // （"拒绝用空数据覆盖已有内容的文件"）抛错、被包成 500。批量删除早已改用 saveEmpty，
          // 单条删除漏了（2026-09-28 审计）。
          files.generations.saveEmpty(list)
          removeGenerationArtifacts(deps, new Set<string>(params.id ? [params.id] : []))
        }
        writeOk(res, idx >= 0)
      },
    },
    {
      m: 'GET',
      p: 'ai/draft-generation',
      h: ({ res, query }) => {
        const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
        const pageSize = Math.max(1, Number(query.get('pageSize') ?? 10) || 10)
        const all = files.generations.load()
        // 列表路径同样带上草稿 id：与按任务号精确查保持同一口径，
        // 否则"看看最近的任务"永远看不到片子落在哪条草稿上。
        const draftIdByGeneration = draftIdIndex(deps)
        writeOk(res, {
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
          total: all.length,
          list: all.slice((page - 1) * pageSize, page * pageSize).map(g => ({ ...g, draftId: draftIdByGeneration.get(g.id) ?? '' })),
        })
      },
    },
  )

  /**
   * 长视频（≥60 秒）分镜脚本：按总时长切分节点，每节点含建议时长、画面与口播方向。
   *
   * 本地模板不代写文案，因此用户文案要求不改写产出，而是写入脚本说明（description 同时是
   * 媒体生成提示词的一部分）并在逐段口播要点后附要求摘要，保证模板路径同样吃这条约束。
   *
   * @param captionPrompt - 用户文案要求（含平台标题/正文/话题上限）；空串表示未填写。
   * @param platforms - 本次选中的平台 id；只影响脚本说明里的落点与话题标签，不改分镜结构。
   */
  function buildLongVideoScript(topic: string, duration: number, resolution: string, aspectRatio: string, captionPrompt: string, platforms: string[]) {
    const segments = duration >= 180 ? 8 : duration >= 120 ? 7 : 6
    const perSegment = Math.floor(duration / segments)
    // 逐段提示里的要求摘要：压平换行并按字数截断，避免分镜要点被长要求淹没。
    const requirement = captionPrompt.replace(/\s+/g, ' ').trim()
    const requirementHint = requirement === ''
      ? ''
      : '，文案须满足用户要求：' + (requirement.length > 40 ? requirement.slice(0, 40) + '…' : requirement)
    const shots = Array.from({ length: segments }, (_, i) => ({
      index: i + 1,
      durationSec: i === segments - 1 ? duration - perSegment * (segments - 1) : perSegment,
      visual: topic + '：第' + (i + 1) + '段画面（开场钩子/产品特写/使用场景/痛点对比/解决方案/优势罗列/号召行动）',
      narration: topic + '——第' + (i + 1) + '句口播要点（' + (i === 0 ? '3 秒钩子抓住停留' : i === segments - 1 ? '结尾引导关注收藏' : '信息密度保持每 2 秒一个传播点') + '）' + requirementHint,
    }))
    // 平台是用户选的，不是写死的"抖音"：标题与话题标签跟着走，否则选了 B 站也得到一份抖音话术。
    const platformLabel = platforms.length === 0 ? '' : platforms.join('、')
    return {
      title: topic + '｜' + (platformLabel === '' ? '长视频' : platformLabel) + '分镜（' + duration + ' 秒 · ' + resolution + ' · ' + aspectRatio + '）',
      description: '已生成 ' + segments + ' 段分镜脚本，总时长 ' + Math.round(duration / 60) + ' 分钟；可配合已上传的参考视频/图片素材按分镜剪辑合成。'
        + (platformLabel === '' ? '' : '落点平台：' + platformLabel + '。')
        + (captionPrompt === '' ? '' : '\n\n【用户文案要求（本地模板未代写文案，落稿时必须逐条满足）】\n' + captionPrompt),
      longVideo: { duration, resolution, aspectRatio, segments: shots },
      topics: ['#干货', platformLabel === '' ? '#长视频' : '#' + platformLabel, '#' + topic.slice(0, 6)],
    }
  }
  /**
   * 任务号 → 草稿 id 的反查表：成片落草稿箱时写的是 metadata.generationId。
   *
   * 两个查询入口（按任务号精确查、列最近几条）都要用它：只给精确查那条带草稿 id 的话，
   * 调用方问"最近的任务怎么样"就永远读不到草稿，还得再查一次才知道片子落在哪。
   *
   * @param d - 服务端依赖（数据根）。
   * @returns 生成任务号到草稿 id 的映射；同一任务多条草稿时保留最早那条。
   */
  function draftIdIndex(d: Deps): Map<string, string> {
    const index = new Map<string, string>()
    for (const item of d.store.files.contents.load()) {
      if (item.kind !== 'draft') continue
      const genId = String((item.metadata as { generationId?: unknown } | undefined)?.generationId ?? '')
      if (genId === '' || index.has(genId)) continue
      index.set(genId, String(item._id ?? item.id ?? ''))
    }
    return index
  }

  function createDraftGeneration(d: Deps, body: unknown, kind: 'video' | 'image-text'): { taskIds: string[] } {
    const params = body as Record<string, unknown>
    const quantity = Math.max(1, Math.min(10, Number(params.quantity ?? 1) || 1))
    // 生成任务记录必须完整保存本次请求的每一项设置（模型/文案要求/风格/参考素材/目标平台等），
    // 刷新后 GET 回读与生成详情要能还原用户提交时的参数。
    // 与前端 PROMPT_MAX_LENGTH（2000）对齐：此前这里静默截到 500 字，而输入框允许写 2000 字——
  // 用户在 501 字之后写的最具体的那部分（镜头、服装、场景约束）在链路上根本不存在，
  // 界面也不会提示（2026-09-28 审计发现）。
  const userPrompt = extractPrompt(params.prompt).slice(0, PROMPT_MAX_CHARS)
    const groupId = typeof params.groupId === 'string' && params.groupId !== '' ? params.groupId : DEFAULT_MATERIAL_GROUP_ID
    const captionPrompt = readRequestString(params.captionPrompt, 2000)
    const model = readRequestString(params.model, 80)
    const imageModel = readRequestString(params.imageModel, 80)
    const style = readRequestString(params.style, 40)
    const draftType = readRequestString(params.draftType, 20)
    // 内容形式与出镜形象：融合进内容创作时这两个字段一度没被带上，
    // 编排层于是永远走缺省的 scene（口播 + 产品特写），用户要的走动 VLOG 就排不出来。
    const form = readRequestString(params.form, 30)
    const humanRef = readRequestString(params.humanRef, 60)
    const imageCount = Math.max(0, Math.min(20, Math.round(Number(params.imageCount ?? 0)) || 0))
    const imageSize = readRequestString(params.imageSize, 20)
    const imageUrls = readRequestStringList(params.imageUrls, 9)
    const videoUrls = readRequestStringList(params.videoUrls, 9)
    const audioUrls = readRequestStringList(params.audioUrls, 9)
    const platforms = readPlatformList(params.platforms, 20)
    const duration = Number(params.duration ?? 0) || 0
    // 图文请求的档位字段叫 imageSize，视频叫 resolution：两者同义，读不到前者就回退后者，
    // 否则图文任务永远按 720p 落盘，用户选的档位与比例都作用不到成品。
    const resolution = readRequestString(params.resolution, 40) || readRequestString(params.imageSize, 40)
    const aspectRatio = readRequestString(params.aspectRatio, 20)
    const ids: string[] = []
    const gens = d.store.files.generations.load()
    for (let i = 0; i < quantity; i++) {
      const gen: ZyDraftGenerationTask = {
        id: uid('gen'),
        status: 'generating',
        points: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        request: {
          groupId,
          kind,
          prompt: userPrompt,
          duration,
          resolution,
          aspectRatio,
          quantity,
          ...(model !== '' ? { model } : {}),
          ...(imageModel !== '' ? { imageModel } : {}),
          ...(captionPrompt !== '' ? { captionPrompt } : {}),
          ...(style !== '' ? { style } : {}),
          ...(draftType !== '' ? { draftType } : {}),
          ...(form === '' ? {} : { form }),
          ...(humanRef === '' ? {} : { humanRef }),
          ...(imageCount > 0 ? { imageCount } : {}),
          ...(imageSize !== '' ? { imageSize } : {}),
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
          ...(videoUrls.length > 0 ? { videoUrls } : {}),
          ...(audioUrls.length > 0 ? { audioUrls } : {}),
          ...(platforms.length > 0 ? { platforms } : {}),
        },
      }
      gens.unshift(gen)
      ids.push(gen.id)
      setTimeout(() => {
        void (async () => {
          const list = d.store.files.generations.load()
          const target = list.find(g => g.id === gen.id)
          if (target === undefined) return
          const topic = userPrompt.slice(0, 24) || '今日分享'
          const mediaDuration = duration
          const mediaResolution = resolution !== '' ? resolution : '720p'
          const mediaAspectRatio = aspectRatio !== '' ? aspectRatio : '9:16'
          // 文案要求（含目标平台标题/正文/话题上限）是本次生成的最高优先级约束：
          // 真模型分支并入提示词，模板兜底分支写入分镜脚本说明，两条路径都吃这一项。
          const captionRequirementBlock = buildCaptionRequirementBlock(captionPrompt)
          // 长视频（≥60 秒）：应答结构化分镜脚本（每段建议时长+节奏说明），适配抖音中长视频创作
          const longVideo = kind === 'video' && mediaDuration >= 60
          // 已配置用户大模型时用真实生成（OpenAI 兼容流式），失败/未配置回模板兜底
          try {
            const stored = readStoredLlm(d.dataRoot)
            let llmText = ''
            let llmError = ''
            // 知识库注入：先用用户指令检索知识笔记，命中即作为「已知知识」进模型上下文。
            const generationKnowledge = d.store.files.knowledge.load() as KnowledgeState
            const knowledgeContext = buildKnowledgeContext(generationKnowledge, userPrompt)
            // 质量语境：同类内容里用户认可过的产出（评分 ≥4 或注入过知识）进上下文。
            // 这是"越做越像你的"最便宜的一步：原料已经在蒸馏账本里，只是从前没有回流。
            const qualityContext = buildQualityContext(generationKnowledge, kind)
            // 长视频走本地分镜模板，不调用模型：只有"真的调用了模型却没有产出"才算失败，
            // 否则配置了大模型的用户每次 ≥60 秒生成都会被误判为失败（含媒体生成一并中断）。
            const llmAttempted = stored !== undefined && !longVideo
            if (llmAttempted) {
              // 提示词里的每一处都必须来自用户真正的选择：档位（mediaDuration）、体裁（kind）、
              // 目标平台（platforms）。写死"60 秒"与"小红书"会让参数区整片失效——
              // 选了 30 秒出 60 秒的稿子、选了抖音得到一篇小红书笔记（用户口径的"内容创作参数不对"）。
              const promptText = (kind === 'video'
                ? '围绕「' + topic + '」创作一条约 ' + String(Math.round(mediaDuration)) + ' 秒的短视频口播脚本：'
                  + '给出标题、与时长匹配的口播正文、3-5 个话题标签，直接输出可直接发布的内容。'
                  // 只写"与时长匹配"模型会写短（实测 60 秒档给 219 字，而分段工作流按 4.5 字/秒要求 270 字，
                  // 于是整条片子被判"稿件不够长"直接失败）。这里给硬下限，字数不够就没有成片。
                  + '口播正文不得少于 ' + String(Math.ceil(mediaDuration * CHARS_PER_SECOND)) + ' 字（按每秒 4.5 字计），少于这个字数成片会短于目标时长。'
                : '围绕「' + topic + '」创作一篇图文笔记：'
                  + '给出吸睛标题、带分段与 emoji 的正文、3-5 个话题标签，直接输出可直接发布的内容。')
                + buildPlatformBlock(platforms)
                + captionRequirementBlock
              const out = await streamLlmWithDeltas(promptText, undefined, stored, knowledgeContext.block + qualityContext.block)
              llmText = out.text
              llmError = out.error ?? ''
            }
            const honestFallback = stored === undefined
              ? '未接入任何大模型。请先在「设置 → 配置大模型」中填写你的 API 地址和密钥，配置后才能生成内容。'
              : '大模型调用失败：' + (llmError || '未知错误') + '。请检查 API 地址、密钥和模型名后重试。'
            target.response = kind === 'video'
              ? longVideo
                ? buildLongVideoScript(topic, mediaDuration, mediaResolution, mediaAspectRatio, captionPrompt, platforms)
                : { title: topic + '｜口播脚本', description: llmText !== '' ? llmText : honestFallback, topics: ['#干货', '#' + topic.slice(0, 6)] }
              : { title: topic + '｜图文笔记', description: llmText !== '' ? llmText : honestFallback, topics: ['#干货'], imageTexts: [{ title: topic + '｜笔记', content: llmText !== '' ? llmText : honestFallback }] }
            if (llmText === '' && llmAttempted) {
              target.status = 'failed'
              target.errorMessage = llmError || '大模型调用失败'
              target.updatedAt = nowIso()
              d.store.files.generations.save(list)
              recordDistillation(d, {
                task: kind,
                instruction: userPrompt,
                output: '',
                model: stored.model,
                knowledgePaths: knowledgeContext.paths,
                knowledgeChars: knowledgeContext.chars,
                exampleIds: qualityContext.ids,
                status: 'failed',
                rating: 0,
                sourceId: gen.id,
              })
              return
            }
            target.status = 'generating'
            target.updatedAt = nowIso()
            d.store.files.generations.save(list)
            // 把用户选的模型一并带进媒体生成：图片走 imageModel、视频走 model，
            // 选到本地模板时由 attachGenerationMedia 走本地兜底，不调厂商。
            //
            // 媒体生成期间持续刷新 updatedAt：停滞看门狗据此区分"很慢但还活着"和"已经死了"。
            // 没有心跳时，一段十几分钟的正常出图会被误判成停滞。
            // 媒体步骤有绝对截止时间：只看 updatedAt 的看门狗会被"进程活着但 await 永不返回"绕过去
            // （心跳还在刷时间，任务永远显得"很慢但还活着"——现场那条卡 38 分钟的记录正是这种形态）。
            // 预算按本次档位推导：30 秒档要下 7 片、1 分钟档 15 片，定值 15 分钟会在成片
            // 已经拼好之后才判超时（DEF-107）。部署方可用 BF_MEDIA_BUDGET_MAX_MS 压低上限。
            const mediaBudgetMaxMs = mediaBudgetMaxFromEnv()
            // 外层预算必须**覆盖内层的分段等待预算**：外层先到点就把记录收尾成 partial/failed，
            // 而分段任务还在跑——成片已经拼好在盘上、记录却是失败。
            // 2026-09-28 审计实测：30 秒档外层 34.2 分钟、内层 48 分钟，**每一档外层都小于内层**。
            const innerSegmentedBudgetMs = kind === 'video' ? segmentedVideoBudgetMs(mediaDuration) : 0
            const mediaBudget = Math.max(
              mediaBudgetMs(kind, {
                duration: mediaDuration,
                ...(mediaBudgetMaxMs !== undefined ? { maxMs: mediaBudgetMaxMs } : {}),
              }),
              innerSegmentedBudgetMs,
            )
            // 把生效的预算写进运行日志：DEF-107 的现场判据就是"预算与档位不匹配"，
            // 日志里有这个数，事后核对不必再靠读代码推算。
            console.error('[generation] 媒体预算 id=' + gen.id + ' kind=' + kind
              + ' duration=' + String(mediaDuration) + ' budgetMs=' + String(mediaBudget)
              + (mediaBudgetMaxMs !== undefined ? ' maxMs=' + String(mediaBudgetMaxMs) : ''))
            let mediaTimedOut = false
            const mediaResult = await Promise.race([
              (async () => {
              const heartbeat = setInterval(() => {
                try {
                  const rows = d.store.files.generations.load()
                  const row = rows.find(item => item.id === gen.id)
                  if (row === undefined || row.status !== 'generating')
                    return
                  row.updatedAt = nowIso()
                  d.store.files.generations.save(rows)
                }
                catch {
                  // 心跳写失败不影响生成。
                }
              }, 60_000)
              heartbeat.unref?.()
              try {
                return await attachGenerationMedia(d, gen.id, kind, target.response, {
                  duration: mediaDuration,
                  resolution: mediaResolution,
                  aspectRatio: mediaAspectRatio,
                  style,
                  imageUrls,
                  // 用户填的提示词必须一路带到出图/出片：带上参考图时它就是画面要求（图生图以它为准），
                  // 之前这一项没传，画面要求到不了厂商，用户看到的是"按文案另画的图"。
                  ...(userPrompt !== '' ? { prompt: userPrompt } : {}),
                  ...(model !== '' ? { model } : {}),
                  ...(imageModel !== '' ? { imageModel } : {}),
                  // 张数必须跟着本次请求走：不带这个字段时 attachGenerationMedia 只能按历史默认 2 张出图。
                  ...(imageCount > 0 ? { imageCount } : {}),
                  // 一分钟档的正文是本机分镜模板（不是口播稿）：分段工作流据此改成自己现写台词。
                  // 这个判据不能靠"响应里有没有 longVideo"——那个字段过不了落盘 schema，读回来就没了。
                  ...(longVideo ? { scriptIsStoryboard: true } : {}),
                  // 内容形式与出镜形象必须**在这一层**传进去：生成记录里存了不等于编排层拿得到，
                  // 少了这一环，form 一直是缺省的 scene，用户要的走动 VLOG 永远排不出来。
                  ...(gen.request?.form === undefined ? {} : { form: gen.request.form }),
                  ...(gen.request?.humanRef === undefined ? {} : { humanRef: gen.request.humanRef }),
                })
              }
              finally {
                clearInterval(heartbeat)
              }
              })(),
              new Promise<null>((resolve) => {
                const timer = setTimeout(() => {
                  mediaTimedOut = true
                  resolve(null)
                }, mediaBudget)
                timer.unref?.()
              }),
            ])
            if (mediaTimedOut || mediaResult === null) {
              const timedOut = d.store.files.generations.load().find(item => item.id === gen.id)
              if (timedOut !== undefined && timedOut.status === 'generating') {
                const hasText = timedOut.response?.description !== undefined || timedOut.response?.title !== undefined
                timedOut.status = hasText ? 'partial' : 'failed'
                timedOut.errorMessage = mediaTimeoutMessage(mediaBudget, hasText)
                timedOut.updatedAt = nowIso()
                d.store.files.generations.save(d.store.files.generations.load())
                // 走 console.error：内核运行日志已接管 stderr，这里就是它落盘的通道。
                console.error('[generation] 媒体超时收尾 id=' + gen.id + ' budgetMs=' + mediaBudget + ' status=' + timedOut.status)
              }
              return
            }
            const latest = d.store.files.generations.load().find(g => g.id === gen.id)
            if (latest === undefined)
              return
            if (!mediaResult.ok) {
              latest.status = 'partial'
              latest.errorMessage = '文字/脚本已生成，但媒体生成失败：' + (mediaResult.error || '媒体生成失败')
            }
            else {
              // 媒体是降级产出（厂商视频失败、用图片合成顶替）时**不报成成功**：如实标 partial + 原因，
              // 用户才知道手里这段不是 AI 视频；其余情况才是真正的成功。
              // 只有"降级产出"才把状态降成 partial；效果提示（notice）不影响状态——
              // 成片已经正常出来了，把它标成"未完成"是误导（实测 5 秒档那条）。
              latest.status = mediaResult.warning === undefined ? 'success' : 'partial'
              latest.errorMessage = mediaResult.warning ?? ''
              if (mediaResult.notice !== undefined) latest.notice = mediaResult.notice
              // 知识库自动沉淀（铁律 #9：知识库不能是摆设）：每次生成成功留一条可检索笔记。
              recordGenerationKnowledge(d, latest)
              // 蒸馏样本：留下可微调 / 可少样本 / 可复盘的完整「指令→输出」记录。
              recordDistillation(d, {
                task: kind,
                instruction: userPrompt,
                output: latest.response?.description ?? '',
                model: stored?.model ?? 'template',
                knowledgePaths: knowledgeContext.paths,
                knowledgeChars: knowledgeContext.chars,
                exampleIds: qualityContext.ids,
                status: 'success',
                rating: 0,
                sourceId: gen.id,
              })
            }
            latest.updatedAt = nowIso()
            d.store.files.generations.save(d.store.files.generations.load())
          } catch (error) {
            // 按 id 更新"最新一份"列表：闭包里的 list 是媒体生成之前的快照，
            // 直接 save(list) 会把正常路径刚写进去的终态整段覆盖回去
            // （同一条记录在盘上变成两个版本，用户看到的可能又是"生成中"）。
            const fresh = d.store.files.generations.load()
            const row = fresh.find(item => item.id === gen.id)
            if (row !== undefined) {
              row.status = 'failed'
              row.errorMessage = error instanceof Error ? error.message : '生成失败'
              row.updatedAt = nowIso()
              d.store.files.generations.save(fresh)
            }
          }
        })()
      }, 800)
    }
    d.store.files.generations.save(gens)
    return { taskIds: ids }
  }

  /**
   * 生成成功自动沉淀知识库：按日期聚合到「自动沉淀/生成记录.md」，
   * 记录标题、平台素材组、时间与产出，供后续检索与自进化复盘。
   */
  function recordGenerationKnowledge(d: Deps, gen: {
    id: string
    createdAt: string
    updatedAt: string
    request?: { groupId?: string; kind?: string; prompt?: string } | undefined
    response?: { title?: string; description?: string } | undefined
  }): void {
    const knowledge = d.store.files.knowledge.load()
    const key = '自动沉淀/生成记录.md'
    const title = String(gen.response?.title ?? '').slice(0, 60)
    const line = `- ${gen.updatedAt} [${gen.request?.kind ?? 'content'}] ${title}（组 ${gen.request?.groupId ?? ''}，任务 ${gen.id}）`
    const existing = knowledge.notes[key]
    knowledge.notes[key] = existing === undefined
      ? { name: '生成记录', content: `# 自动沉淀：生成记录\n\n${line}\n` }
      : { ...existing, content: existing.content.trimEnd() + '\n' + line + '\n' }
    d.store.files.knowledge.save(knowledge)
  }

  /** 删除生成记录时同步移除对应草稿与媒体，避免历史记录引用已删除的媒体。 */
  function removeGenerationArtifacts(d: Deps, ids: Set<string>): void {
    if (ids.size === 0)
      return
    const contents = d.store.files.contents.load()
    d.store.files.contents.saveEmpty(filterGenerationArtifacts(ids, contents))
    // 蒸馏样本的 sourceId 就是生成记录 id：删除源记录必须把样本一起带走，
    // 否则被删记录的提示词仍留在用户知识库（见 removeDistillationsBySource 的说明）。
    removeDistillationsBySource(d, ids)
  }

  /**
   * 取素材库里最新的一个视频素材（用户自己传的，或已经验收过的成品）。
   *
   * 供 AI 智能体的发布动作复用：现场生成一条视频要等几分钟、还要花掉一次视频额度，
   * 而手里已经有成品时用户要的是"就发这条"。没有现成视频才回落到现场生成。
   *
   * @param d - 依赖集合（含内容存储）。
   * @returns 视频地址与封面地址；素材库里没有视频时为 null。
   */
  function latestLibraryVideo(d: Deps): { url: string; coverUrl: string } | null {
    const rows = d.store.files.contents.load()
    const videos = rows.filter(row => row.kind === 'asset'
      && (row.type === 'video' || /\.(mp4|mov|webm|m4v)$/i.test(String(row.url ?? ''))))
    if (videos.length === 0)
      return null
    const newest = [...videos].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
    const url = String(newest?.url ?? '')
    if (url === '')
      return null
    return { url, coverUrl: String(newest?.thumbUrl ?? '') || url }
  }

  /** 抖音创作路径：等待真实视频素材生成完成；失败返回 null，前端不发送发布动作卡。 */
  async function generateAgentVideo(d: Deps, promptText: string): Promise<{ url: string; coverUrl: string } | null> {
    const started = createDraftGeneration(d, { prompt: promptText, groupId: 'mg-persist', quantity: 1 }, 'video')
    const genId = started.taskIds[0] ?? ''
    if (genId === '')
      return null
    // 视频厂商实测生成耗时约 3–5 分钟（2026-09-09 实测 4m07s）；180s 会在素材就绪前
    // 超时返回 null，导致抖音发布动作卡永远不出现、全自动链路中断。给足 360s。
    const deadline = Date.now() + 360_000
    while (Date.now() < deadline) {
      const gen = d.store.files.generations.load().find(item => item.id === genId)
      if (gen === undefined)
        return null
      if (gen.status === 'failed')
        return null
      const url = gen.response?.videoUrl ?? ''
      if (url !== '') {
        return {
          url,
          coverUrl: gen.response?.coverUrl ?? gen.response?.imageUrls?.[0] ?? '',
        }
      }
      await sleep(500)
    }
    return null
  }

  /** 全局图片生成串行队列：避免用户连续多点导致厂商限流（429/连接被重置）。 */
  let aiImageQueue: Promise<unknown> = Promise.resolve()

  /**
   * 生成结果附媒体：图文→多张真实卡片图；视频→帧图合成可播放 mp4（失败不影响文本）。
   *
   * 图片请求按**用户选的那个模型**发出（选本地模板的由调用方走模板卡片，不会走到这里）；
   * 接的是 Agnes（APP 内置系统大模型）时用官方字段：`size` 是档位（1K/2K/3K/4K）、画幅走 `ratio`。
   * 官方文档写明"不支持 1920x1080 这类精确尺寸，会被标准化"——原先发像素尺寸，
   * 用户选的比例与档位就是这样丢掉的。
   */
  async function generateAiImages(
    d: Deps,
    prompt: string,
    count: number,
    opts?: { resolution?: string; aspectRatio?: string; model?: string; imageUrls?: string[] },
  ): Promise<{ urls: string[]; files: string[]; model: string; error?: string } | null> {
    const cfg = readStoredLlm(d.dataRoot)
    if (cfg === undefined || cfg.apiKey === '' || cfg.baseUrl === '')
      return null
    // 图片模型 = **设置里配置的那个**。请求里带的型号只用来确认"用户选的就是配置的那个"：
    // 产品不内置任何大模型，所以一个没在设置里配过的型号**不许**被拿去下单——
    // 那等于替用户改了配置，而他只会在账单与成片上看到差别（本地模板由调用方走卡片兜底）。
    const configuredModel = (cfg.imageModel ?? '').trim()
    const requestedModel = (opts?.model ?? '').trim()
    if (requestedModel !== '' && requestedModel !== LOCAL_TEMPLATE_IMAGE_MODEL && requestedModel !== configuredModel) {
      const reason = '请求的图片模型 ' + requestedModel + ' 不在配置里（当前配置为 ' + configuredModel + '），已拒绝下单'
      console.error('[AI_IMG_ERR] ' + reason)
      throw new Error(reason)
    }
    const imageModel = configuredModel
    if (imageModel === '')
      throw new Error('没有配置图片模型，无法出图')
    const base = (cfg.imageBaseUrl || cfg.baseUrl).trim().replace(/\/+$/, '')
    // 出网一律经内核媒体能力面（0 号铁律第 1/2 条）：这里只解析"这条通道对应哪条内核路由"。
    const route = mediaRouteFor(cfg.providers, base)
    if (route === undefined)
      throw new Error('图片通道还没进内核媒体配置：请到「设置 → 配置大模型」把这条服务重新保存一次（内核侧需要同一条地址与密钥）')
    const media = d.media()
    if (media === undefined)
      throw new Error('内核媒体能力面不可用（media 服务未挂载），无法出图')
    const files: string[] = []
    const urls: string[] = []
    // 成品落盘目录在下单前就建好：目录缺失要在发请求前暴露，不能让 writeFileSync 收到厂商图之后才抛 ENOENT。
    const uploadsDir = ensureUploadsDir(d.dataRoot)
    const usedModel = imageModel
    // 与视频同一条口径：档位 + 画幅 → 成品像素；比例同时写进提示词，让模型按目标画幅构图。
    const targetSize = pixelFor(opts?.resolution ?? '', opts?.aspectRatio ?? '')
    const targetPixels = parseSize(targetSize)
    const ratioHint = ratioPromptHint(opts?.aspectRatio ?? '')
    // 参考图（图生图 / 多图合成）：Agnes 官方的 `image` 字段是**数组**——官方文档写明
    // "输入图像数组…多图合成时传入多张图像"，实测 `image: [图1, 图2]` 返回 200 且人物与设备都保住。
    // 此前这里只取第 1 张，用户传的第二张及以后**完全没有作用**（多图合成能力等于没接）。
    // 只在本机可达的素材必须先内联成 Data URI——厂商在公网取不到 127.0.0.1。
    const referenceImages = (opts?.imageUrls ?? [])
      .map(url => referenceImageValue(d, url))
      .filter(value => value !== '')
    // 官方对多图合成的要求：**写明每张参考图的角色**（"将第一张图作为主要角色，第二张图作为产品参考…"）。
    // 不指名时厂商只把多张图当"一堆素材"，合成关系由它自由决定。
    const pictureClause = agnesPictureReferenceClause(referenceImages.map((_, index) => index === 0
      ? '人物身份参考：保持这位人物的面部、发型与服装不变'
      : '素材参考：保持其外形、颜色与细节不变，并与第一张图里的人物合成到同一画面'))
    const requestPrompt = [prompt, ratioHint === '' ? '' : '画面比例：' + ratioHint, pictureClause]
      .filter(part => part !== '')
      .join('\n')
    /**
     * 出一张图。厂商方言（档位/画幅/尺寸协商/产物下载）都在能力面里，这里只管产品自己的重试与分类：
     * 没应答与 429/5xx 是**暂时**的，退避后重试一次；4xx（无权限、参数不合法）是确定的，如实失败。
     *
     * @returns 图片字节；厂商明确没产出时抛错。
     */
    // 出图前的实证记录：参考图到底带没带上、真正发出去的提示词是什么（排查"要求与产物不符"只看这一行）。
    console.log('[AI_IMG_REQ] ref=' + (referenceImages.length === 0 ? '无' : String(referenceImages.length) + '张(' + String(referenceImages.reduce((sum, value) => sum + value.length, 0)) + 'B)') + ' prompt=' + requestPrompt.slice(0, 200).replace(/\n/g, ' / '))
    const generateOne = async (): Promise<Uint8Array> => {
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await media.generateImage({
            provider: route,
            model: imageModel,
            prompt: requestPrompt,
            count: 1,
            ...(opts?.resolution !== undefined && opts.resolution !== '' ? { resolution: opts.resolution } : {}),
            ...(opts?.aspectRatio !== undefined && opts.aspectRatio !== '' ? { aspectRatio: opts.aspectRatio } : {}),
            ...(referenceImages.length === 0 ? {} : { images: referenceImages }),
            timeoutMs: MEDIA_TIMEOUTS.imageMs,
          })
          const first = result.images[0]
          if (first !== undefined && first.bytes.length > 0) return first.bytes
          lastError = new Error('厂商没有返回可用图片')
        }
        catch (error) {
          lastError = error
          console.error('[AI_IMG_ERR] ' + describeMediaFailure(error, 'image') + ' model=' + imageModel)
          if (!isRetryableMediaFailure(error)) throw error
          if (attempt === 0) await sleep(3000)
        }
      }
      throw lastError
    }
    const run = async (): Promise<{ urls: string[]; files: string[] }> => {
      for (let i = 0; i < count; i++) {
        let bytes: Uint8Array | undefined
        try {
          bytes = await generateOne()
        }
        catch (error) {
          // 第一张就失败 = 这次调用失败；后续张数失败则保留已经落盘的那些。
          if (i === 0) {
            // 401/403 = 这个 Key 没有该模型的权限（Agnes 按白名单放行，实测 403 team_model_access_denied）：
            // 结论落盘，模型清单据此不再摆出这把 Key 用不了的图片模型（DEF-067 的同一个坑）。
            const status = mediaFailureStatus(error)
            if (status === 401 || status === 403) rememberModelDenied(d.dataRoot, base, imageModel)
            console.error('[AI_IMG_ERR] ' + describeMediaFailure(error, 'image') + ' model=' + imageModel)
            throw new Error('图片生成失败：' + describeMediaFailure(error, 'image'))
          }
          break
        }
        if (bytes === undefined) break
        const id = uid('ai-img') + '.png'
        const file = join(uploadsDir, id)
        if (targetPixels === null) {
          writeFileSync(file, bytes)
        }
        else {
          // 厂商原图多为自家尺寸：落盘前按「档位 + 画幅」裁剪缩放到成品像素。
          // 裁剪失败（非 Windows 或解码失败）保留厂商原图并留日志，不阻断本次生成。
          const raw = join(uploadsDir, uid('ai-img-raw') + '.bin')
          writeFileSync(raw, bytes)
          const cropped = await cropImageToSize(raw, file, targetPixels.width, targetPixels.height)
          if (cropped === '') {
            console.error('[AI_IMG_ERR] crop to ' + targetSize + ' failed, keep vendor original')
            copyFileSync(raw, file)
          }
          try {
            unlinkSync(raw)
          }
          catch {
            // 临时原图删不掉只留垃圾文件，不影响已落盘的成品。
          }
        }
        uploadsMeta.set(id, 'image/png')
        files.push(file)
        urls.push('/bosom-friend/api/assets/file/' + encodeURIComponent(id))
      }
      if (files.length === 0) throw new Error('图片生成失败：厂商没有返回可用图片')
      return { urls, files }
    }
    const result = await new Promise<{ urls: string[]; files: string[] }>((resolve, reject) => {
      const task = aiImageQueue.then(() => run())
      aiImageQueue = task.catch(() => undefined)
      task.then(resolve, reject)
    })
    return { ...result, model: usedModel }
  }

  /**
   * 视频生成：一次厂商往返，经内核媒体能力面（`ctx.media.submitVideo` + `pollVideo`）。
   *
   * 端点怎么选、档位怎么映射、失败怎么分类，全在能力面与它的提供方里；这一层只负责
   * "用户选了什么、素材在哪、失败原因怎么讲给人听"。
   *
   * 传入 `opts.imageUrls` 即图生视频：引用图会被解析成厂商可读取的值（本地素材内联为 Data URI，
   * 公网地址原样透传），并按张数落到厂商的首帧/首尾帧/参考图模式。
   *
   * 传入 `opts.talkingHead` 即数字人口播：形象图（视频建的形象另带一段参考视频）走厂商的
   * `reference` 模式；**不传音频**——念白由厂商按提示词里的台词自己合成。
   */
  async function generateAiVideoDirect(
    d: Deps,
    prompt: string,
    opts?: {
      duration?: number
      resolution?: string
      aspectRatio?: string
      imageUrls?: string[]
      /** 用户这次选的视频模型；留空用配置里那个。 */
      model?: string
      /**
       * 数字人口播：形象图已是厂商可读取的值（Data URI 或公网地址）。
       *
       * `audios` 留空表示念白由厂商按提示词自己合成；给了音频则走厂商的"按参考音重新配音"，
       * 它会跟着那段参考音的节奏念，而不是跟着写好的台词。
       *
       * `videos` 是视频建的形象那条参考通道：厂商按它延续动作、说话方式与声音。
       * 不是每个型号都收参考视频（Agnes Video 2.5 收 1 段，Flash 官方明确 videos is not supported），
       * 型号不支持时这里**如实失败**——把它丢掉的表现是"每一镜都出一版不是这个人的画面"。
       */
      talkingHead?: { images: string[], audios?: string[], videos?: readonly MediaReferenceVideo[], seed: number }
      /**
       * 跨镜固定的采样种子。
       *
       * 同一条片子的所有镜头共用一个值：不给时厂商每次自由采样，即便参考图完全相同，
       * 人物也会逐镜漂移（对照实验里固定 seed 的那组跨镜一致性明显更好）。
       */
      seed?: number
    },
  ): Promise<VideoOutcome> {
    const cfg = readStoredLlm(d.dataRoot)
    if (cfg === undefined || cfg.videoModel === undefined || cfg.videoModel === '')
      return { ok: false, reason: '还没有配置视频模型。请到「设置 → 配置大模型」里选一个视频模型——本产品不内置任何大模型，用哪个型号由你决定。' }
    const base = (cfg.videoBaseUrl || cfg.baseUrl).trim().replace(/\/+$/, '')
    // 出网一律经内核媒体能力面（0 号铁律第 1/2 条）：这里只解析"这条通道对应哪条内核路由"。
    const route = mediaRouteFor(cfg.providers, base)
    if (route === undefined)
      return { ok: false, reason: '视频通道还没进内核媒体配置：请到「设置 → 配置大模型」把这条服务重新保存一次（内核侧需要同一条地址与密钥）' }
    const media = d.media()
    if (media === undefined)
      return { ok: false, reason: '内核媒体能力面不可用（media 服务未挂载），无法出片' }
    // 视频模型 = **设置里配置的那个**。请求里带的型号只用来确认"用户选的就是配置的那个"：
    // 没在设置里配过的型号不许被拿去下单（本地模板不出片，调用方会走本地幻灯片兜底）。
    const requestedModel = (opts?.model ?? '').trim()
    if (requestedModel !== '' && requestedModel !== LOCAL_TEMPLATE_VIDEO_MODEL && requestedModel !== cfg.videoModel) {
      return {
        ok: false,
        reason: '这次要用的模型「' + requestedModel + '」不在设置里。请到「设置 → 配置大模型」把它配成视频模型，'
          + '或改回已配置的「' + cfg.videoModel + '」——本产品只用你在设置里配的型号生成。',
      }
    }
    const videoModel = cfg.videoModel
    // 参考视频按型号能力先判一次：官方规格里 Flash 明确不收 videos（HTTP 400）。
    // 不支持就如实失败，而不是把参考视频丢掉——丢掉等于每一镜都白跑一次，用户还不知道为什么"换人了"。
    const referenceVideos = opts?.talkingHead?.videos ?? []
    if (referenceVideos.length > 0 && isAgnesVideoModel(videoModel) && agnesVideoLimits(videoModel).videos === 0) {
      return {
        ok: false,
        reason: '这个视频模型「' + videoModel + '」不收参考视频，用它做视频数字人只会得到另一张脸。'
          + '请到「设置 → 配置大模型」把视频模型换成 agnes-video-2.5，或改用照片建的数字人。',
      }
    }
    /** 实际出片的模型（就是用户配置/选择的那个）：写进生成记录，供复盘。 */
    let acceptedModel = videoModel
    // 参数契约：时长/分辨率/画幅必须尊重用户选择。档位与画幅怎么落到厂商字段（Agnes 的 size 按模型分档、
    // seconds 是 4~12 的字符串、画幅白名单）已经在内核能力面里，产品层只把用户的选择原样传下去。
    const duration = Math.min(180, Math.max(4, Math.round(opts?.duration ?? 5) || 5))
    const aspectRatio = opts?.aspectRatio ?? '9:16'
    // 图生视频：引用图必须先在本机解析成厂商可读取的值；读不到的图直接丢弃，
    // 只带剩下的图去生成，绝不拿别的图片冒充用户给的那张。
    // 用户传的是**一张人物拼图**（三视图/四视图）时先按人物列切开——这一步**与时长档位无关**：
    // 厂商按参考图**张数**切模式，1 张走 keyframe 把画面锁死在这张拼图上，
    // ≥3 张才走 reference（只锁人、场景按提示词走）。5 秒的短视频同样不该把三视图当一张图用
    // （实测 2026-09-28：5 秒档传三视图 → 参考图 1 张 → keyframe 锁死 → 用户看到的静止图片轮播）。
    let effectiveImageUrls = opts?.imageUrls ?? []
    if (opts?.talkingHead === undefined && effectiveImageUrls.length === 1) {
      const cut = await splitSheetIntoAngles(d, effectiveImageUrls[0]!)
      if (cut.length >= 3) {
        console.error('[AUTO_HUMAN] 短视频链路：一张拼图切成 ' + String(cut.length) + ' 张角度图，改走 reference 模式')
        effectiveImageUrls = cut
      }
    }
    const referenceImages = opts?.talkingHead !== undefined
      ? opts.talkingHead.images
      : effectiveImageUrls
          .map(url => referenceImageValue(d, url))
          .filter(value => value !== '')
    if (effectiveImageUrls.length > referenceImages.length)
      console.error('[AI_VID_ERR] 有引用图无法读取，已丢弃 ' + String(effectiveImageUrls.length - referenceImages.length) + ' 张')

    /**
     * 把厂商侧的失败写成一句用户能照着行动的话。
     *
     * `null` 是内部信号，用户看到的是"这一镜没出来"；不区分 429 与"没有 Key"这类原因，
     * 用户就只能盲目重试。状态码是唯一能区分它们的事实，所以每个失败出口都带上它。
     *
     * @param reason - 失败类型。
     * @param status - 厂商 HTTP 状态码（没有响应时为 undefined）。
     * @returns 可读的失败原因。
     */
    const videoFailureReason = (reason: string, status?: number, detail?: string): string => {
      const suffix = status === undefined ? '' : '（HTTP ' + String(status) + '）'
      // 429 与 5xx 是**暂时**的：编排层据此自动重跑这一镜（{@link RETRYABLE_FAILURE_PREFIX}）。
      if (status === 429) return RETRYABLE_FAILURE_PREFIX + '厂商限流，稍后再试' + suffix
      // 503 有两种，厂商在响应体里给了 code：队列满要等的是**队列**（几十分钟），一般故障只是抖动。
      // 2026-10-11 实测同一条任务交替收到 video_queue_full 与 rate_limit_exceeded，两者处置完全不同；
      // 不分类时编排层只能一刀切，用户也只看到一句「厂商服务暂时不可用」。
      if (status === 503 && String(detail ?? '').includes('video_queue_full'))
        return RETRYABLE_FAILURE_PREFIX + '厂商视频队列已满，稍后再试' + suffix
      if (status !== undefined && status >= 500) return RETRYABLE_FAILURE_PREFIX + '厂商服务暂时不可用，稍后再试' + suffix
      // 下面这些是**确定**的失败：重试只是白花额度，必须如实失败并让用户改配置。
      if (status === 400 || status === 422) return '厂商拒绝了这次生成参数' + suffix
      if (status === 401 || status === 403) return '厂商拒绝了这次调用（密钥或权限）' + suffix
      return reason + suffix
    }
    /** 成片落盘：产物已经由能力面下载成字节，这里只负责写文件与登记。 */
    const saveVideo = async (bytes: Uint8Array): Promise<VideoOutcome> => {
      if (bytes.length === 0)
        return { ok: false, reason: '厂商成片下载失败' }
      const id = uid('ai-vid') + '.mp4'
      const file = join(ensureUploadsDir(d.dataRoot), id)
      writeFileSync(file, bytes)
      uploadsMeta.set(id, 'video/mp4')
      return { ok: true, url: '/bosom-friend/api/assets/file/' + encodeURIComponent(id), model: acceptedModel }
    }
    /**
     * 下单一次。没应答与 429/5xx 是**暂时**的（三次下单全部网络失败/超时 = 厂商抖动，整条任务该重跑），
     * 4xx 交给上层如实失败。
     *
     * @returns 厂商受理后的结果（任务号或已成片）。
     */
    const submit = async (): Promise<MediaVideoSubmission> => {
      // 优先用**厂商已经认过**的档位下单：没记过才按用户档位试，试成了由调用方记下来（见下）。
      const preferred = rememberedVideoSize(d.dataRoot, base, videoModel)
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await media.submitVideo({
            provider: route,
            model: videoModel,
            prompt,
            durationSeconds: duration,
            resolution: opts?.resolution !== undefined && opts.resolution !== '' ? opts.resolution : '720p',
            aspectRatio,
            ...(referenceImages.length > 0 ? { images: referenceImages } : {}),
            // 非数字人路径（内容创作的直接出片）也要固定 seed：同一套参考图跨镜才不会逐镜漂移。
            ...(opts?.talkingHead === undefined && opts?.seed !== undefined ? { seed: opts.seed } : {}),
            ...(opts?.talkingHead === undefined
              ? {}
              : {
                  talkingHead: {
                    images: referenceImages,
                    // 没给音频就整个省略这个键：厂商据此自己合成念白，传空数组是另一种会被拒的请求。
                    ...(opts.talkingHead.audios === undefined ? {} : { audios: opts.talkingHead.audios }),
                    ...(opts.talkingHead.videos === undefined ? {} : { videos: opts.talkingHead.videos }),
                    seed: opts.talkingHead.seed,
                  },
                }),
            ...(preferred === '' ? {} : { preferredSize: preferred }),
            timeoutMs: MEDIA_TIMEOUTS.videoCreateMs,
          })
        }
        catch (error) {
          lastError = error
          console.error('[AI_VID_ERR] submit ' + describeMediaFailure(error, 'video'))
          if (!isRetryableMediaFailure(error)) throw error
          if (attempt < 2) await sleep(attempt === 0 ? 3000 : 8000)
        }
      }
      throw lastError
    }
    try {
      const submission = await submit()
      // 厂商认过的档位记下来：之后的每一镜都省掉一次必然被拒的下单（限流窗口里这一省很值钱）。
      if (submission.acceptedSize !== undefined && submission.acceptedSize !== '')
        rememberVideoSize(d.dataRoot, base, videoModel, submission.acceptedSize)
      acceptedModel = submission.model === '' ? videoModel : submission.model
      if (submission.video !== undefined)
        return await saveVideo(submission.video.bytes)
      const jobId = submission.jobId ?? ''
      if (jobId === '')
        return { ok: false, reason: '厂商没有返回任务编号' }
      const deadline = Date.now() + VIDEO_POLL_BUDGET_MS
      // 轮询间隔用指数退避，而不是固定 4 秒。
      // 一镜要 60~300 秒才出片，固定 4 秒意味着 15~75 次 poll；免费档的速率限制把 poll 也算进去，
      // 于是大量请求撞 429（日志里整页的 "poll 厂商返回 HTTP 429"），一镜要退避重试好几次才拿到。
      // 6s → 10s → 15s → 25s → 30s 封顶，poll 次数降到原来的三分之一左右。
      let pollWaitMs = 6_000
      while (Date.now() < deadline) {
        await sleep(pollWaitMs)
        pollWaitMs = Math.min(30_000, Math.round(pollWaitMs * 1.6))
        try {
          const status = await media.pollVideo({
            provider: route,
            model: videoModel,
            jobId,
            timeoutMs: MEDIA_TIMEOUTS.statusPollMs,
          })
          if (status.state === 'failed') {
            console.error('[AI_VID_ERR] task failed ' + (status.error ?? ''))
            return { ok: false, reason: '厂商生成失败' }
          }
          if (status.state === 'completed') {
            const video = status.video
            if (video === undefined) {
              console.error('[AI_VID_ERR] completed without artifact')
              return { ok: false, reason: '厂商报告完成但没有给出成片' }
            }
            return await saveVideo(video.bytes)
          }
        }
        catch (error) {
          console.error('[AI_VID_EXC] poll ' + describeMediaFailure(error, 'video'))
          if (mediaFailureStatus(error) === 429) await sleep(10000)
        }
      }
      console.error('[AI_VID_ERR] poll timeout')
      return { ok: false, reason: RETRYABLE_FAILURE_PREFIX + '厂商超时没出片（排队过久）' }
    }
    catch (error) {
      const status = mediaFailureStatus(error)
      if (status === 401 || status === 403) rememberModelDenied(d.dataRoot, base, videoModel)
      console.error('[AI_VID_ERR] ' + describeMediaFailure(error, 'video'))
      // 厂商连接失败（三次下单一次响应都没有）是**暂时**的：厂商侧只是抖动/网关重启，
      // 判成永久失败会把一条已经跑成十几镜的任务按死在这里，前面花掉的额度全白瞎
      // （实测 2026-09-17：90 秒 18 镜的任务跑到第 16 镜，就因为这个分支被判死）。
      if (isUnreachableMediaFailure(error))
        return { ok: false, reason: RETRYABLE_FAILURE_PREFIX + '厂商连接失败（网络超时），稍后重试' }
      return { ok: false, reason: videoFailureReason('厂商没有受理这次生成任务', status, (error as { detail?: string }).detail) }
    }
  }

  /** 本地素材 URL 对应的落盘文件；非本地素材或文件不存在时返回空串。 */
  function localAssetFile(d: Deps, url: string): string {
    const prefix = '/bosom-friend/api/assets/file/'
    // 运行时防御：调用方拿到的可能是 undefined（例如某镜没配参考图/音频），
    // 上一版直接 url.indexOf 会抛 "Cannot read properties of undefined"，把整条片子判死。
    if (typeof url !== 'string' || url === '') return ''
    const index = url.indexOf(prefix)
    if (index < 0) return ''
    const id = decodeURIComponent(url.slice(index + prefix.length).split('?')[0] ?? '')
    // 素材 id 是文件名：带路径分隔符的请求一律不认，避免越出 uploads 目录读任意文件。
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) return ''
    const uploadsDir = join(d.dataRoot, 'uploads')
    const file = join(uploadsDir, id)
    if (existsSync(file)) return file
    // 界面上传的素材 URL **不带扩展名**（/assets/file/asset-e27h0rb6），而磁盘上是
    // asset-e27h0rb6.png。不补这一步，所有按 URL 找原图的路径都会读不到文件——
    // 建形象、拼图切分、参考图内联全都静默失败（实测 2026-09-28：自动建形象一直不触发，
    // 日志里切分恒为 0 张）。
    try {
      const hit = readdirSync(uploadsDir).find(name => name.startsWith(id + '.'))
      return hit === undefined ? '' : join(uploadsDir, hit)
    }
    catch (_noUploadsDir) {
      // uploads 目录不存在与文件找不到同义：返回空串，让调用方走没有参考图那条路。
      return ''
    }
  }

  /**
   * 把生成请求里的引用图变成厂商能读到的值。
   *
   * 引用图落盘在本机 uploads，地址只有本机可达；厂商在公网侧取不到 127.0.0.1，
   * 因此本地素材内联为 `data:<mime>;base64,...`（Agnes 视频接口实测接受 Data URI），
   * 公网 http(s) 地址原样透传。读不到的图返回空串，由调用方丢弃——绝不拿占位图冒充用户的图。
   *
   * @param d - 依赖（数据根目录）。
   * @param url - 生成请求里的引用图地址。
   * @returns 厂商可读取的图片值；无法读取时为空串。
   */
  function referenceImageValue(d: Deps, url: string): string {
    if (/^https?:\/\//i.test(url)) return url
    const file = localAssetFile(d, url)
    if (file === '') return ''
    const id = file.slice(file.lastIndexOf('\\') + 1)
    return inlineFileDataUri(file, uploadsMeta.get(id))
  }

  /**
   * 把数字人的原始视频变成厂商能读到的参考视频值。
   *
   * 与引用图同一条路：素材只在本机、厂商在公网侧取不到，只能按字节内联成 Data URI。
   * 官方对参考视频的限制是**单个小于 50 MB**，而 base64 会放大三分之一——
   * 超过 {@link REFERENCE_VIDEO_MAX_BYTES} 的素材如实报错，而不是发一次注定被拒的请求把这一镜白跑掉。
   *
   * @param d - 依赖（数据根目录）。
   * @param url - 数字人记录里的原始视频地址（本机素材 URL 或公网地址）。
   * @returns 厂商可读取的视频值；无法读取或超过上限时给出可读原因。
   */
  function referenceVideoValue(d: Deps, url: string): { ok: true, value: string } | { ok: false, error: string } {
    if (/^https?:\/\//i.test(url)) return { ok: true, value: url }
    const file = localAssetFile(d, url)
    if (file === '') return { ok: false, error: '参考视频读不出来（素材可能已被删除），请重建这个数字人' }
    try {
      if (statSync(file).size > REFERENCE_VIDEO_MAX_BYTES) {
        return { ok: false, error: '参考视频超过厂商上限（单个 50 MB），请换一段更短的视频重建这个数字人' }
      }
    }
    catch {
      return { ok: false, error: '参考视频读不出来（素材可能已被删除），请重建这个数字人' }
    }
    const value = inlineFileDataUri(file, uploadsMeta.get(file.slice(file.lastIndexOf('\\') + 1)))
    return value === ''
      ? { ok: false, error: '参考视频读不出来（素材可能已被删除），请重建这个数字人' }
      : { ok: true, value }
  }
  /**
   * 把本机文件内联成 Data URI。
   *
   * 厂商在公网侧取不到本机路径，参考图、参考视频与音频都只能把字节塞进请求体。
   *
   * @param file - 本机文件绝对路径。
   * @param mimeOverride - 已知 MIME（如上传时记下的），缺省按扩展名推断。
   * @returns `data:<mime>;base64,...`；文件读不到或为空时返回空串。
   */
  function inlineFileDataUri(file: string, mimeOverride?: string): string {
    try {
      const bytes = readFileSync(file)
      if (bytes.length === 0) return ''
      const dot = file.lastIndexOf('.')
      const mime = mimeOverride ?? (dot < 0 ? 'application/octet-stream' : mimeOfExt(file.slice(dot)))
      return 'data:' + mime + ';base64,' + bytes.toString('base64')
    }
    catch {
      return ''
    }
  }
/**
 * 分段工作流的等待预算（毫秒）。
 *
 * 实测（2026-09-26）：60 秒档在厂商限流下 30 分钟只跑完 6/12 镜，等待预算先到点，
 * 内容创作侧就把整条判成"视频生成失败"——而后台的长视频任务其实还在正常出片。
 * 预算按目标时长给（每镜最多 5 分钟 + 重试退避），并保底 30 分钟。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @returns 等待预算（毫秒）。
 */
function segmentedVideoBudgetMs(targetSeconds: number): number {
  // 每镜给 8 分钟：实测限流下是 5.0~5.6 分钟/镜，原来的 6 分钟只够刚好，
  // 一旦厂商 429/503 连着来（一条 60 秒片能给到 16 镜），预算先到点、任务还在正常出片，
  // 界面却已经把它收尾成 partial——用户看到"生成失败"，后台其实还在跑。
  return Math.max(40 * 60_000, Math.ceil(targetSeconds / 5) * 8 * 60_000)
}
/** 轮询间隔（毫秒）：编排层每跑完一镜就落一次盘，间隔太密只是白读磁盘。 */
const SEGMENTED_VIDEO_POLL_MS = 5_000

/**
 * 半分钟以上档位改走**分段工作流**（与「长视频创作」同一条链路）。
 *
 * 为什么不再"同一个提示词连下 N 片再拼"：那样每一片都是同一句话、同一批参考图，
 * 成片就是同一段画面反复重播（用户口径的"4~5 秒的片段反复拼接"），而且厂商按画面出片，
 * 整条片子没有一句人声。分段工作流每一步都不同：稿件切进每一镜 → 每镜一个画面文案 →
 * 台词逐字进提示词（厂商在这一镜里把话念出来）→ 按镜头拼成一条并烧字幕。
 *
 * 复用长视频那套编排（`runLongVideoJob`）而不是另写一份：切段、重试、时长对账、字幕与拼接
 * 只有一套实现，两个入口不会有第二套行为。
 *
 * @param input - 主题、已定稿稿件（留空由编排层按主题现写）、目标时长、画布与可选的产品参考图。
 * @returns 成片地址或失败原因；成功时附上成片真正念的那份稿件（调用方据此把草稿正文对齐到片子）。
 */
/**
 * 把一张人物拼图**按人物之间的空白列**切成若干张角度图。
 *
 * 用户在内容创作里最常见的就是**一张三视图/四视图拼图**（正面+侧面+背面，或加大头照）。
 * 让产品代劳切开，用户就只需要上传一张图——这也是「上传三视图就能出镜」的入口。
 * 不按固定网格切：实测 720×960 的**横向三视图**按 2×2 切，第一格会变成
 * 「正面那人的上半身 + 侧面那人的半个身子」，等于把素材切废。
 *
 * @param deps - 存储依赖。
 * @param sheetUrl - 拼图的本机素材 URL。
 * @returns 切好的角度图 URL；不足 3 张（不是并排拼图）时返回空数组。
 */
async function splitSheetIntoAngles(deps: Deps, sheetUrl: string): Promise<string[]> {
  const uploadsDir = ensureUploadsDir(deps.dataRoot)
  // 必须用 localAssetFile 解析真实路径：界面传上来的 URL 是**没有扩展名**的
  // （/bosom-friend/api/assets/file/asset-e27h0rb6），而磁盘上是 asset-e27h0rb6.png。
  // 直接 split('/').pop() 再拼路径，existsSync 恒为 false，切分永远返回空数组
  // ——这正是 2026-09-28 自动建形象一直不触发的最后一个根因。
  const srcPath = localAssetFile(deps, sheetUrl)
  if (srcPath === '') return []
  const size = await readImageSize(srcPath)
  if (size === null) return []
  const columns = await detectColumnBounds(srcPath)
  if (columns.length < 3) return []
  const out: string[] = []
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i]!
    const outId = 'auto-angle-' + randomUUID().slice(0, 8) + '-' + String(i + 1) + '.png'
    const outPath = join(uploadsDir, outId)
    const done = await cropImageRegion(srcPath, outPath, { x: col.x, y: 0, width: col.width, height: size.height })
    if (done === '') continue
    // 厂商硬校验：输入图宽高比必须 0.4–2.5。横向三视图切出来的单格天生很窄
    // （实测 262×960 = 0.27），不补边整条片子会在第 1 镜被 HTTP 400 拒掉。
    const padded = await padImageToMinAspect(done, join(uploadsDir, 'pad-' + outId))
    if (padded === '') continue
    const finalId = padded === done ? outId : 'pad-' + outId
    out.push(registerAsset({ file: padded, id: finalId, mime: 'image/png', uploadsDir }))
  }
  return out.length >= 3 ? out : []
}

/**
 * 用几张已经落盘的角度图**当场建一个形象**（不经过界面）。
 *
 * 服务于「上传三视图就能出镜」：用户在内容创作里传了正面/侧面/背面，
 * 产品把它们落成一个形象，这条片子就走 reference 模式——**锁住这个人，场景按提示词走**，
 * 而不是被单张图 keyframe 锁死整幅画面。
 *
 * @param deps - 存储依赖（形象库与素材目录都从这里取）。
 * @param angleUrls - 角度图的本机素材 URL；少于 3 张不建（不足 3 张厂商会退回 keyframe）。
 * @param name - 形象名；用题材前几个字，便于用户在形象库里认出来。
 * @returns 建好的形象；素材读不出来时返回 null（调用方退回场景呈现，不硬出镜）。
 */
function buildHumanFromAngles(deps: Deps, angleUrls: readonly string[], name: string): ZyDigitalHuman | null {
  const usable = angleUrls.filter(url => localAssetFile(deps, url) !== '')
  if (usable.length < 3) return null
  const human: ZyDigitalHuman = {
    id: uid('dh'),
    name: name.trim() === '' ? '自动形象' : name.trim(),
    avatarUrl: usable[0]!,
    images: usable.slice(0, 8),
    persona: resolvePersona(''),
    seed: Math.floor(Math.random() * 1_000_000),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  const list = files.digitalHumans.load()
  list.unshift(human)
  files.digitalHumans.save(list)
  return human
}

async function generateSegmentedVideo(
  deps: Deps,
  input: {
    topic: string
    script: string
    targetSeconds: number
    resolution?: string
    aspectRatio?: string
    productImageUrl?: string
    /**
     * 内容形式（`vlog` / `scene-seeding` / `scene` / `tutorial` …）。
     *
     * 缺省 `scene`：这条链路原本只服务"场景呈现"。用户要的是走动 VLOG 时，
     * 必须换到 `vlog`（需要出镜形象）或 `scene-seeding`（空镜为主、人物走过、旁白在画外），
     * 否则排出来的镜头是"口播 + 产品特写"，跟 VLOG 不是一回事。
     */
    form?: string
    /** 出镜类形式（vlog / short-talk / unboxing / tutorial）需要的数字人形象 id。 */
    humanRef?: string
    /**
     * 人物参考图集（用户上传的全部参考图）。
     *
     * 必须整体传下去：厂商按**数量**切模式，只给 1 张会走 keyframe 把画面锁死在参考图上。
     */
    personImageUrls?: readonly string[]
    /**
     * 任务刚建好就回调一次，把分段任务 id 交回调用方。
     *
     * 界面靠这个 id 查实时进度（第几镜 / 共几镜）。此前只在**生成结束**时才把 id 写进生成记录，
     * 于是整条片子跑的 20~40 分钟里界面查不到任何进度，用户看到的就是"生成中"或干脆没有进度条。
     */
    onStarted?: (taskId: string) => void
  },
): Promise<{ ok: true, url: string, model: string, taskId: string, script?: string } | { ok: false, reason: string, taskId?: string }> {
  // 「上传三视图就能出镜」：用户传了 ≥3 张参考图（典型的正面/侧面/背面人物图）时，
  // 当场把它们落成一个形象并走出镜 VLOG——用户不需要先去别处建形象、
  // 也不需要知道厂商「按参考图张数切模式」这套规则。
  // 只传 1 张时不这么做：一张产品图不该被当成人（那会走 keyframe 锁死画面，
  // 而且出镜形式还要求有形象，最终只会降级成静止图片轮播）。
  const personImageUrls = input.personImageUrls ?? []
  let autoForm = input.form
  let autoHumanRef = input.humanRef
  // 注意：**不能**用 productImageUrl 是否存在来挡这条逻辑——form 缺省是 scene，
  // 而 scene 一定把第 1 张参考图当产品图传下来，于是自动建形象永远不会触发
  // （实测 2026-09-28 就是这样：用户传了三视图拼图，日志里仍是「参考图 1 张」）。
  // 真正的守卫在下面：切开后不足 3 张就不建形象，产品图自然不会被当成人。
  if (autoForm === undefined && autoHumanRef === undefined) {
    // 只给了一张图时，先当成拼图试着按人物列切开（横向三视图/四视图都走这条）——
    // 用户只需要上传一张，切分与建形象都由产品代劳。
    let angles: readonly string[] = personImageUrls
    if (angles.length === 1) {
      const cut = await splitSheetIntoAngles(deps, angles[0]!)
      console.error('[AUTO_HUMAN] 单图尝试按人物列切分：' + angles[0] + ' → ' + String(cut.length) + ' 张')
      if (cut.length >= 3) angles = cut
    }
    console.error('[AUTO_HUMAN] 进入自动建形象：personImageUrls=' + String(personImageUrls.length)
      + '、切分后角度=' + String(angles.length) + '、form=' + String(input.form ?? '(空)')
      + '、humanRef=' + String(input.humanRef ?? '(空)'))
    if (angles.length >= 3) {
      const built = buildHumanFromAngles(deps, angles, input.topic.slice(0, 12))
      console.error('[AUTO_HUMAN] 建形象结果=' + (built === null ? 'null（素材读不出来）' : built.id))
      if (built !== null) { autoForm = 'vlog'; autoHumanRef = built.id }
    }
    else console.error('[AUTO_HUMAN] 角度不足 3 张，不建形象（会走不出镜的场景呈现）')
  }
  const form = autoForm ?? 'scene'
  const producer = form === 'scene' || form === 'scene-seeding'
    ? sceneProducer(input.productImageUrl ?? '', form === 'scene-seeding' ? SCENE_SEEDING_FORM : SCENE_FORM, personImageUrls)
    : producerFor(form, autoHumanRef, input.productImageUrl ?? '')
  if ('error' in producer) return { ok: false, reason: producer.error }
  const started = startLongVideoTask({
    producer: form,
    ...(autoHumanRef === undefined ? {} : { producerRef: autoHumanRef }),
    topic: input.topic,
    targetSeconds: input.targetSeconds,
    scriptText: input.script,
    registerAsMaterial: false,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
    ...(input.productImageUrl === undefined ? {} : { productImageUrl: input.productImageUrl }),
  })
  if (!started.ok) return { ok: false, reason: started.error }
  // 立刻把 id 交回去：界面从这一刻起就能显示"逐镜生成 N/M"。
  input.onStarted?.(started.taskId)
  const budgetMs = segmentedVideoBudgetMs(input.targetSeconds)
  const finished = await waitForLongVideoTask(started.taskId, budgetMs)
  if (finished === undefined) {
    // 等待超时也要把任务 id 交回去：任务通常还在后台跑，界面据此给"断点继续"。
    return { ok: false, taskId: started.taskId, reason: '分段生成没在 ' + String(Math.round(budgetMs / 60_000)) + ' 分钟内跑完，任务仍在后台继续' }
  }
  if (finished.status !== 'success' || finished.videoUrl === undefined || finished.videoUrl === '') {
    return {
      ok: false,
      taskId: started.taskId,
      reason: finished.errorMessage === undefined || finished.errorMessage === '' ? '分段生成没有产出成片' : finished.errorMessage,
    }
  }
  const script = finished.scriptText ?? ''
  return {
    ok: true,
    url: finished.videoUrl,
    model: 'segmented:' + String(finished.totalSegments) + 'shots',
    // 带上任务 id：生成记录据此关联到这条分段任务，界面才能显示"到哪一步了"。
    taskId: started.taskId,
    ...(script === '' ? {} : { script }),
  }
}

/**
 * 等一条长视频任务跑到终态。
 *
 * @param taskId - 任务 id。
 * @returns 终态的任务记录；预算用尽仍未跑到终态时 undefined。
 */
async function waitForLongVideoTask(taskId: string, budgetMs: number): Promise<ZyLongVideoTask | undefined> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const task = files.longVideoTasks.load().find(item => item.id === taskId)
    if (task !== undefined && task.status !== 'generating') return task
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, SEGMENTED_VIDEO_POLL_MS))
  }
}
  async function attachGenerationMedia(
    d: Deps,
    genId: string,
    kind: 'video' | 'image-text',
    response?: { title?: string; description?: string; topics?: string[] },
    request?: {
      duration?: number
      resolution?: string
      aspectRatio?: string
      style?: string
      /** 用户这次填的提示词：它就是画面要求，带参考图出图时以它为准（见 mediaPrompt 的构造）。 */
      prompt?: string
      imageUrls?: string[]
      /** 用户这次选的视频模型；本地模板走本地幻灯片，不调厂商。 */
      model?: string
      /** 用户这次选的图片模型；本地模板走本地排版卡片，不调厂商。 */
      imageModel?: string
      /** 用户这次选的生成张数（界面 1–9）；缺省按历史行为的 2 张。 */
      imageCount?: number
      /**
       * 落盘的正文是不是**本机分镜模板**（一分钟档）而不是口播稿。
       *
       * 一分钟档的 response.description 是"已生成 N 段分镜脚本…"，当台词交出去会被判成
       * "模型自述混进正文"；这种档位让编排层按主题现写一版台词。
       */
      scriptIsStoryboard?: boolean
      /**
       * 内容形式：`vlog`（走动 VLOG）/ `scene-seeding`（场景种草）/ `scene`（场景呈现）/ …。
       *
       * 缺省 `scene`。要 VLOG 必须显式给，否则编排层排出来的是"口播 + 产品特写"。
       */
      form?: string
      /** 出镜类形式（vlog / short-talk / unboxing / tutorial）需要的数字人形象 id。 */
      humanRef?: string
    },
  ): Promise<{ ok: boolean; error?: string, warning?: string, notice?: string }> {
    try {
      const title = response?.title || '内容卡片'
      const body = response?.description || ''
      const topics = response?.topics || []
      const parts = body.split('\n').map(s => s.trim()).filter(Boolean)
      // 风格没有独立的厂商参数，只能作为提示词前缀进入图片/视频生成请求。
      // 用户填的提示词**排在文案前面**：它是画面要求（"严格保持参考图里这个人的面部/发型/服装，
      // 生成站立三视图"这类），而标题+正文是模型写的文案——只发文案时，画面要求根本到不了厂商，
      // 用户会看到一张与要求无关的图（实测：要求三视图，出来的是坐姿半身照）。
      // 用户上传的参考图（图生视频与图生图共用这一份）。
      let referenceImages = (request?.imageUrls ?? []).filter(url => url !== '')
      // **先在算警告之前把拼图切开**：厂商按参考图张数切模式，1 张走 keyframe 把画面锁死，
      // ≥3 张才走 reference（只锁人）。切分原本发生在后面的生成函数里，于是这里算出的
      // 「1 张」警告与实际不符——既误导用户，又把一条好片子标成 partial
      // （实测 2026-09-28：5 秒档成片 5.18 秒、720x1280、有声，全对，却因为这句警告判 partial）。
      if (referenceImages.length === 1) {
        const cutAngles = await splitSheetIntoAngles(d, referenceImages[0]!)
        if (cutAngles.length >= 3) {
          console.error('[AUTO_HUMAN] 生成前先把一张拼图切成 ' + String(cutAngles.length) + ' 张角度图（警告与出片口径从此一致）')
          referenceImages = cutAngles
        }
      }
      // 参考图的**身份由内容形式决定**：出镜形式（vlog / short-talk / unboxing / tutorial）里
      // 用户传的是"这个人是谁"；场景类（scene / scene-seeding / 缺省）里传的是"产品长什么样"。
      // 此前同一张图两边都传（personImageUrls 与 productImageUrl 各用一次），一张人像照于是
      // **同时成了"人物参考"与"产品外观参考"**——产品镜里出现人脸、分镜把"以参考图中的产品
      // 为主体"写到有人物的镜头上，画面主体当场混乱。
      // 内容形式：前端目前**没有选择控件**（2026-09-28 审计 #2），但绝不能因此永远排成 scene——
      // scene 的写稿要求曾是"分镜稿"而不是口播台词，用户拿到的是一条没有口播、稿子全在复述画面的
      // 片子（实测 60 秒档 272 字全是"我站在门口/穿着工装/冷白灯光下…"）。
      //
      // **出镜形式（vlog）必须有一个确定的数字人形象**，否则厂商会直接拒绝
      // （实测："这个内容形式要出镜，请先选一个数字人形象"），然后产品只能降级成图片轮播——
      // 用户拿到一条静止画面拼的视频，而界面上完全看不出降级过。
      // 所以推断规则收紧成：**形象库里恰好只有一个形象**时才自动走 vlog（那时确实能出镜、
      // 不需要用户再选）；其余情况一律退回 scene（不出镜、不需要形象、不会失败）。
      const formKind = request?.form ?? (files.digitalHumans.load().length === 1 ? 'vlog' : 'scene')
      const talkingForm = formKind !== 'scene' && formKind !== 'scene-seeding'
      // 参考图张数决定厂商模式（实测）：1 张 = keyframe（当首帧，**画面会被这张图锁死**）、
      // ≥3 张 = reference（只锁"是谁"，场景按提示词生成）。用户只给 1 张而提示词里写了场景时，
      // 成片必然是那张图本身——这里如实记一笔，让人能从日志看出"为什么画面没跟着提示词走"。
      /**
       * 参考图前置提醒：与"生成失败降级"共用同一个 warning 通道回到界面。
       *
       * 这条以前只 console.error——用户完全看不到，于是"我写了那么详细的场景，画面却还是那张照片"
       * 只能靠猜。厂商规则是死的（1 张走 keyframe 把画面锁死在首帧、≥3 张才走 reference 只锁人不锁场景），
       * 产品能做且必须做的是**在提交时就说清楚**。
       */
      let referenceNotice = ''
      if (referenceImages.length === 1 && kind === 'video') {
        // 只说清"会发生什么"与"你能做的那一步"，不要求用户理解厂商的模式名。
        referenceNotice = '这条片子以你上传的那张参考图为主：画面会跟着这张图走，'
          + '提示词里写的场景与光线可能画不出来（厂商按参考图数量决定：1 张锁画面，3 张以上才只锁人物）。'
          + '想要人物一致、场景又能自由换：用手机给同一个人拍三张——正面、侧面、背面，一起传上来就行。'
        console.error('[generation] ' + referenceNotice)
      }
      // 这里此前有一条"图文生成只使用第 1 张参考图"的提示，依据是"厂商图片接口是单图通道"。
      // 那条依据**已被实测推翻**：官方文档写明 `image` 是数组、多图合成时传多张，实测
      // `image:[图1,图2]` 返回 200 且人物与设备都保住——适配层与产品层现在都传全部参考图。
      // 提示留着会让用户以为多传没用（与事实相反），所以整段删掉。
      const userVisualPrompt = extractPrompt(request?.prompt ?? '').trim()
      // 带了参考图（图生图）时，画面由**用户的提示词**决定：文案是模型写的，把它并进去会盖过
      // 画面要求（实测：要求"同一个人的三视图"，文案里讲"三视图怎么拍"的段落让厂商画成了三个不同的人）。
      // 没有参考图时才回到"文案驱动画面"的常规路径。
      const mediaPrompt = (referenceImages.length > 0 && userVisualPrompt !== ''
        ? buildStyleDirective(request?.style ?? '') + userVisualPrompt
        : buildStyleDirective(request?.style ?? '')
          + (userVisualPrompt === '' ? '' : userVisualPrompt + '\n')
          + title + '\n' + body).slice(0, PROMPT_MAX_CHARS + 800)
      // 图生视频：用户给了引用图，成片就以这些图为源。此时不再另生成一批图片——
      // 否则封面与降级合成用的都是模型按文案另画的图，跟用户那张图毫无关系，"用图片生成视频"名存实亡。
      const imageDriven = kind === 'video' && referenceImages.length > 0
      // 优先调用用户选的 OpenAI 兼容图片模型生成真实图片；选到本地模板、没配置模型、
      // 模型不支持或请求失败时回退本地模板卡片，并在结果里如实标注来源。
      const localImageTemplate = (request?.imageModel ?? '') === LOCAL_TEMPLATE_IMAGE_MODEL
      // 张数是用户选的：这里此前写死 2，界面选 3 张也只出 2 张（2026-09-21 实测"已生成 2/3 张"）。
      // 没选过张数（旧请求 / 脚本）保持历史上的 2 张。
      const requestedImageCount = Math.round(Number(request?.imageCount ?? 0)) || 0
      const imageCount = Math.min(
        IMAGE_COUNT_LIMITS.max,
        Math.max(IMAGE_COUNT_LIMITS.min, requestedImageCount === 0 ? 2 : requestedImageCount),
      )
      const aiMedia = imageDriven || localImageTemplate
        ? null
        : await generateAiImages(d, mediaPrompt, imageCount, {
            ...(request?.resolution !== undefined ? { resolution: request.resolution } : {}),
            ...(request?.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
            ...(request?.imageModel !== undefined ? { model: request.imageModel } : {}),
            // 用户在这次生成里上传的参考图：带上去才走 i2i（不带就是纯文生图，每次换人）。
            ...(referenceImages.length > 0 ? { imageUrls: referenceImages } : {}),
          })
      let media: { urls: string[]; files: string[] } | null = null
      let generatedBy: 'ai' | 'local-template' = 'local-template'
      let generatedModel = ''
      if (imageDriven) {
        // 只登记本机真实存在的文件：地址读不到的引用图仍会送给厂商，但本地降级合成用不了它。
        media = { urls: referenceImages, files: referenceImages.map(url => localAssetFile(d, url)).filter(file => file !== '') }
      }
      else if (aiMedia !== null) {
        media = { urls: aiMedia.urls, files: aiMedia.files }
        generatedBy = 'ai'
        generatedModel = aiMedia.model
      }
      else {
        const cards = kind === 'video'
          ? Array.from({ length: Math.min(6, Math.max(2, parts.length)) }, (_, i) => ({
              title: i === 0 ? title.slice(0, 30) : (parts[i] ?? '第' + (i + 1) + '段内容').slice(0, 30),
              subtitle: (parts[i] ?? '').slice(0, 30),
            }))
          : Array.from({ length: Math.min(4, Math.max(1, parts.length + 1)) }, (_, i) => ({
              title,
              subtitle: [topics.map(t => t.replace(/^#/, '')).slice(0, 3).join(' · '), parts[i]?.slice(0, 26) ?? ''].filter(Boolean).join(' · '),
            }))
        media = await generateMediaCards(d, cards)
      }
      if (media === null || media.urls.length === 0)
        // 兜底分支：只有在既没走厂商、本地卡片也没产出时才会到达（厂商失败会经 catch 带上具体原因）。
        return { ok: false, error: '图片素材生成失败：既没有可用的厂商出图，本地卡片也未产出' }
      const list = d.store.files.generations.load()
      const target = list.find(g => g.id === genId)
      if (target === undefined || target.response === undefined)
        return { ok: false, error: '生成记录不存在或内容缺失' }
      target.response.imageUrls = media.urls
      target.response.generatedImageCount = media.urls.length
      target.response.generatedBy = generatedBy
      target.response.generatedModel = generatedModel
      const cover = media.urls[0]
      if (cover !== undefined) target.response.coverUrl = cover
      // 这条片子的所有镜头共用一个 seed（跨镜一致性的前提之一，见 generateAiVideoDirect 的 seed 说明）。
      const shotSeed = typeof target.response.seed === 'number'
        ? target.response.seed
        : Math.floor(Math.random() * 1_000_000)
      target.response.seed = shotSeed
      /** 厂商视频失败、改用本地图片合成时的如实说明（不能让"图片轮播"冒充 AI 视频的成功）。 */
      let videoWarning = ''
      /** 厂商那条路为什么没成片（限流/队列已满/参数被拒）。失败原因必须活着走出这一层。 */
      let videoFailure = ''
      /** 本地降级合成为什么也没产出。与厂商原因分开记：两者是不同的问题，不能互相顶替。 */
      let slideshowFailure = ''
      if (kind === 'video') {
        // 选到本地模板就直接走本地幻灯片（时长/档位/画幅都由它保证），不去厂商那边白花一次调用。
        const localVideoTemplate = (request?.model ?? '') === LOCAL_TEMPLATE_VIDEO_MODEL
        // ≤12 秒的档位是官方单次上限内的单片，走原来那一句，逐字未改。
        // >12 秒（半分钟 / 一分钟档）走**分段工作流**：先按稿件排分镜，再逐镜出片——每镜画面不同，
        // 台词由厂商在这一镜里念出来；原先那种"同一个提示词连下 N 片再拼"既重复又全程无声。
        const clipPlan = planClipSeconds(request?.duration ?? 5)
        // 成功结果里的 script 只在分段那条分支上出现：它是成片真正念的那份稿件（见 generateSegmentedVideo）。
        const realVideo: VideoOutcome & { script?: string, taskId?: string } = localVideoTemplate
          ? { ok: false as const, reason: '本地模板' }
          : clipPlan.composed
            ? await generateSegmentedVideo(d, {
                // 形式与出镜形象由请求决定：缺省 scene（场景呈现）；要 VLOG 必须显式给，
                // 否则编排层会排成"口播 + 产品特写"，跟 VLOG 不是一回事。
                // 传**推断后**的形式：request.form 为空时若原样透传，编排层又退回 scene。
                // **不传外层推断的 formKind**：那是粗推断（只有形象库恰好 1 个才给 vlog）。
                // 分段编排内部有更准的一层——它看参考图张数、必要时把拼图按人物列切开
                // 并当场建形象，再决定走出镜还是场景。外层一旦硬塞 scene，
                // 那条路就永远不会触发（实测 2026-09-28：日志里连 [AUTO_HUMAN] 都没打印）。
                ...(request?.form === undefined ? {} : { form: request.form }),
                ...(request?.humanRef === undefined ? {} : { humanRef: request.humanRef }),
                // 用户上传的全部参考图都交给编排层（≥3 张才走 reference，锁人物不锁场景）。
                // **无条件传全部参考图**：自动建形象 / 拼图切分都要看它们有几张。
                // 早先只在 talkingForm 时才传，而 talkingForm 又要求 form ≠ scene、
                // form 又要求先建成形象——三者互相等待，自动出镜永远不会发生
                // （实测 2026-09-28：用户传了三视图拼图，日志里仍是「参考图 1 张」）。
                ...(referenceImages.length === 0 ? {} : { personImageUrls: referenceImages }),
                // 任务一建好就把 id 落到生成记录：界面据此在生成过程中显示实时进度。
                onStarted: (taskId) => {
                  try {
                    const list = files.generations.load()
                    const row = list.find(item => item.id === genId)
                    if (row !== undefined) {
                      if (row.response === undefined) row.response = {}
                      row.response.longVideoTaskId = taskId
                      files.generations.save(list)
                    }
                  }
                  catch (error) { console.error('[generation] 写进度失败：' + String(error)) }
                },
                // topic 是分段链路的**题材与画面要求来源**（写稿、抽题材、排分镜、逐镜钉都用它）。
                // 此前这里传的是"模型写的标题前 24 字"——用户填的提示词在分段链路上**完全没有出口**，
                // 一条 60 秒的片子于是只按标题那 24 个字排画面，这是内容创作画面跑偏的直接原因。
                topic: userVisualPrompt !== '' ? userVisualPrompt : title.slice(0, 24),
                // 一分钟档的正文是本机分镜模板（不是口播稿）：把稿件留空，让编排层按主题现写一版台词。
                script: request?.scriptIsStoryboard === true ? '' : body,
                targetSeconds: clipPlan.target,
                ...(request?.resolution === undefined ? {} : { resolution: request.resolution }),
                ...(request?.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
                // 出镜形式下这张图是人物，不能再当产品图用（同一张图两个身份 = 画面主体混乱）。
                // **多角度人物图（≥3 张）不当产品图**：那正是「同一个人的正面/侧面/背面」，
                // 是给形象用的。之前无条件把第 1 张当产品图，于是产品图校验认人脸就报错、
                // 整条片子降级成图片轮播（实测 2026-09-28：30 秒档被这一条挡住，
                // 连自动建形象都没走到）。
                ...(referenceImages[0] === undefined || talkingForm || referenceImages.length >= 3 ? {} : { productImageUrl: referenceImages[0] }),
              })
            : await generateAiVideoDirect(d, mediaPrompt, {
              ...(request?.duration !== undefined ? { duration: request.duration } : {}),
              ...(request?.resolution !== undefined ? { resolution: request.resolution } : {}),
              ...(request?.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
              ...(request?.model !== undefined ? { model: request.model } : {}),
              imageUrls: referenceImages,
              seed: shotSeed,
            })
        if (realVideo.ok) {
          target.response.videoUrl = realVideo.url
          target.response.generatedBy = 'ai'
          target.response.generatedModel = 'video:' + realVideo.model
          // 记下分段任务 id：界面据此显示"写稿 / 排分镜 / 逐镜生成 9/17"这类实时进度。
          if (realVideo.taskId !== undefined) target.response.longVideoTaskId = realVideo.taskId
          // 一分钟档的稿件是编排层现写的：把成片真正念的那份写回草稿正文，
          // 用户在草稿里看到的就是片子里说的话（而不是本机那份分镜模板）。
          if (realVideo.script !== undefined && realVideo.script !== '') target.response.description = realVideo.script
        }
        else {
          // 失败也要记下分段任务 id：任务常常还在后台继续跑，界面据此给"断点继续 / 重新生成 / 放弃"三个选择，
          // 否则用户对着"生成失败"什么也做不了。
          if (realVideo.taskId !== undefined) target.response.longVideoTaskId = realVideo.taskId
          // 厂商返回的原因在这一层留住：它是"为什么没有片子"的第一手判据。
          videoFailure = realVideo.reason
          // 降级合成也必须携带用户参数（时长/分辨率/画幅），否则产出与选择不符
          const videoUrl = await createSlideshow(d, media.files, 'vid-' + genId + '.mp4', request, (reason) => {
            slideshowFailure = reason
          })
          if (videoUrl !== null) {
            target.response.videoUrl = videoUrl
            // 厂商没出片、用图片合成顶上：这是**降级**，必须如实说明（用户以为拿到的是 AI 视频，
            // 实际上是一段静止图片轮播——这正是"参数没起作用"最容易骗过人的形态）。
            if (!localVideoTemplate) {
              videoWarning = '厂商视频生成失败：' + realVideo.reason + '；已用图片合成的本地视频代替（静止画面轮播，不是 AI 视频）'
              // 降级必须在**正文里就看得见**：warning 字段只在生成卡片那一小块渲染，
              // 而草稿详情弹窗显示的是正文——用户对着一条"静止图片轮播"完全看不出降级过
              // （实测 2026-09-28：用户的原话是"一秒钟将我上传的图复制粘贴"，实际就是这条降级路径）。
              target.response.description = '⚠️ ' + videoWarning + '\n\n'
                + String(target.response.description ?? '')
            }
          }
          // 视频为本地合成：如实标注（图片可能是 AI 生成，视频本身不是厂商视频模型产出）
          if (generatedBy === 'ai')
            target.response.generatedBy = 'local-template'
        }
        if (!target.response.videoUrl) {
          // 失败原因是这条记录上**唯一**能解释"为什么没有片子"的信息：厂商限流、队列已满，
          // 还是本地降级合成也没跑成。此前一律回一句"未得到可播放的视频文件"，
          // 用户与模型都拿不到判据——2026-10-11 实测：真实原因是厂商 503 video_queue_full
          // 与 429 rate_limit_exceeded，链路上一个字都没留下，只能猜。
          const reasons = [videoFailure, slideshowFailure].filter(part => part !== '')
          return {
            ok: false,
            error: '视频生成失败，未得到可播放的视频文件'
              + (reasons.length === 0 ? '' : '：' + reasons.join('；')),
          }
        }
      }
      // 两条信息**必须分开**，它们对状态的含义不同：
      // - warning = 降级产出（厂商视频失败、用静止画面轮播顶替）→ 如实标 partial，用户手里那段不是 AI 视频；
      // - notice  = 效果提示（只传了 1 张参考图，画面会被锁死）→ 成片是正常的，状态仍是 success。
      // 此前两者共用 warning，实测一条正常出片的 5 秒档因此显示成"未完成"，用户以为失败了。
      const warnings = [videoWarning].filter(part => part !== '')
      const notices = [referenceNotice].filter(part => part !== '')
      // 必须**落进生成记录**：生成是异步的，函数返回值到不了用户眼前（请求早就返回 taskIds 了），
      // 只有写进 response，前端轮询时才会把这句话显示出来。
      if (warnings.length > 0) target.response.warning = warnings.join('；')
      if (notices.length > 0) target.response.notice = notices.join('；')
      // 不能用几十秒前取的那份 `list` 快照整份写回：那段窗口里外层超时收尾已经把记录标成
      // partial/failed，写回旧快照会把它覆盖回 generating —— 成片在盘上、记录却永远停在
      // "生成中"，再由停滞看门狗判成失败（2026-09-28 审计发现；同一个坑 catch 分支修过一次，
      // 正常路径这条漏了）。只把本次产出合并进**刚读到的**记录，别人的状态字段原样保留。
      const freshRows = d.store.files.generations.load()
      const freshRow = freshRows.find(item => item.id === genId)
      if (freshRow !== undefined) {
        freshRow.response = target.response
        freshRow.updatedAt = nowIso()
        d.store.files.generations.save(freshRows)
      }
      registerGenerationDraft(d, genId, target.request?.groupId ?? DEFAULT_MATERIAL_GROUP_ID, kind, target.response, target.request, media.urls, target.response.videoUrl)
      return {
        ok: true,
        ...(warnings.length === 0 ? {} : { warning: warnings.join('；') }),
        ...(notices.length === 0 ? {} : { notice: notices.join('；') }),
      }
      } catch (error) {
        console.error('[MEDIA_ERR] ' + String(error))
        return { ok: false, error: error instanceof Error ? error.message : '媒体生成失败' }
      }
  }

  /**
   * 让生成结果立即出现在草稿箱/素材库：同一张内容表写入 1 条 draft 与去重后的 N 条 asset。
   *
   * 草稿同时落盘本次生成参数与目标平台：详情页要复盘生成参数并把它应用回当前输入，
   * 草稿卡片与按平台用量要认用户勾选的平台。
   */
  function registerGenerationDraft(
    d: Deps,
    genId: string,
    groupId: string,
    kind: 'video' | 'image-text',
    response: NonNullable<NonNullable<ZyDraftGenerationTask['response']>>,
    request: ZyDraftGenerationTask['request'],
    imageUrls: string[],
    videoUrl?: string,
  ): void {
    const title = resolveDraftTitle({ title: response.title, description: response.description, prompt: request?.prompt }).title
    const mediaList: ZyMaterialMedia[] = [
      ...imageUrls.slice(0, 9).map(url => ({ type: 'img' as const, url, thumbUrl: url })),
      ...(videoUrl ? [{ type: 'video' as const, url: videoUrl, thumbUrl: imageUrls[0] ?? '' }] : []),
    ]
    if (mediaList.length === 0) return
    // 老记录的平台可能是空格分隔的字符串（见 readPlatformList）：落草稿时同样要读得出来。
    const platforms = readPlatformList(request?.platforms)
    const id = uid('cnt')
    const promotion: ZyContentRecord = {
      kind: 'draft',
      _id: id,
      id,
      groupId,
      title,
      desc: response.description?.slice(0, 5000) || '',
      coverUrl: imageUrls[0] ?? videoUrl ?? '',
      mediaList,
      type: kind,
      status: 0,
      topics: response.topics ?? [],
      ...(platforms.length > 0 ? { accountTypes: platforms } : {}),
      ...(request !== undefined ? { generationParams: request } : {}),
      useCount: 0,
      createdAt: nowIso(),
      metadata: { generationId: genId },
    }
    const contents = d.store.files.contents.load()
    contents.unshift(promotion)

    const materialGroupId = groupId
    const existing = new Set(contents.filter(item => item.kind === 'asset').map(item => item.url))
    for (const media of mediaList) {
      if (existing.has(media.url)) continue
      contents.unshift({
        kind: 'asset' as const,
        _id: uid('cnt'),
        userId: 'zy-user-001',
        groupId: materialGroupId,
        type: media.type,
        url: media.url,
        thumbUrl: media.thumbUrl ?? '',
        title,
        desc: '',
        useCount: 0,
        metadata: { generationId: promotion.metadata?.generationId ?? '' },
        createdAt: nowIso(),
      })
      existing.add(media.url)
    }
    d.store.files.contents.save(contents)

    const groups = d.store.files.materialGroups.load()
    const group = groups.find(item => item.id === groupId)
    if (group !== undefined) {
      group.mediaCount = contents.filter(item => item.kind === 'draft' && item.groupId === groupId).length
      group.updatedAt = nowIso()
      d.store.files.materialGroups.save(groups)
    }
  }

  // ---- 本地数据管理（普通用户可自行清空记录，保留账号/模型配置/权限） --------------
  routes.push({
    m: 'POST',
    p: 'v2/data/cleanup',
    h: ({ res, body }) => {
      const input = (body ?? {}) as { scopes?: unknown; all?: unknown }
      const scopes = Array.isArray(input.scopes)
        ? input.scopes.filter((scope): scope is string => typeof scope === 'string')
        : []
      const all = input.all === true || scopes.includes('all')
      const wanted = (scope: string) => all || scopes.includes(scope)
      // 2026-10-12（审计 W01 / G3「数据不会越用越乱」）：这一批清空跨 11 个域，
      // 必须**整体成功或整体不生效**。原实现逐个 saveEmpty——中间任一步抛错
      // （磁盘满 / 权限 / 进程被杀）就留下"一半清空"的状态，而用户以为清理已经完成。
      // store.transact 早已实现（store.ts:722）却没有任何生产调用点，这里是它的第一批
      // 生产调用点：事务体内任一步抛错，前面已写的域全部回滚到清理前的内容。
      const cleared = store.transact(() => {
        const rows: Record<string, number> = {}

        if (wanted('tasks')) {
          rows.tasks = files.tasks.load().length
          files.tasks.saveEmpty([])
        }
        if (wanted('publish')) {
          rows.publishRecords = files.records.load().length
          files.records.saveEmpty([])
          rows.metrics = files.metrics.load().length
          files.metrics.saveEmpty([])
        }
        if (wanted('content')) {
          rows.generations = files.generations.load().length
          files.generations.saveEmpty([])
          const contents = files.contents.load()
          rows.materials = contents.filter(item => item.kind === 'asset').length
          rows.promotions = contents.filter(item => item.kind === 'draft').length
          files.contents.saveEmpty([])
        }
        if (wanted('reception')) {
          rows.receptionPending = files.receptionPending.load().length
          files.receptionPending.saveEmpty([])
          rows.receptionSeen = Object.keys(files.receptionSeen.load()).length
          files.receptionSeen.saveEmpty({})
          rows.receptionReplies = files.receptionReplies.load().length
          files.receptionReplies.saveEmpty([])
        }
        if (wanted('aiLogs')) {
          rows.aiLogs = files.logs.load().length
          files.logs.saveEmpty([])
        }
        if (wanted('notifications')) {
          rows.notifications = files.notifications.load().length
          files.notifications.saveEmpty([])
        }
        if (wanted('knowledge')) {
          const knowledge = files.knowledge.load()
          const builtIn = Object.fromEntries(
            Object.entries(knowledge.notes).filter(([, note]) => note.protected === true),
          ) as typeof knowledge.notes
          rows.knowledge = Object.keys(knowledge.notes).length - Object.keys(builtIn).length
          files.knowledge.save({ ...knowledge, notes: builtIn })
        }

        return rows
      })

      writeOk(res, cleared)
    },
  })

  // ---- 长视频产出（通用工作流）--------------------------------------------
  //
  // 数字人口播、场景呈现共用同一条编排（long-video.ts）：写稿 → 排分镜 → 逐镜生成 → 拼接。
  // 业务的差别全部收在镜头生成器里，新增一种业务只加一个生成器，编排与存储都不动。

  /**
   * 长视频时长下限（秒）：低于它的档位属于「内容创作」的短视频，本板块不接受。
   *
   * 2026-10-11 由 90 改为 30：产品负责人的场景是「免费档也能跑完的短片」，而 90 秒档 = 18 镜，
   * 每镜都要抢一次厂商窗口，实测一整夜只推进 3 镜。30 秒 = 6 镜，是免费档真正能落地的长度；
   * 前端早就声明了 30/60 两个「拼装档位」（`longDurations`），此前只是被这个下限抬走。
   *
   * 仍是部署可变量：功能测试可以调得更小，跑的是同一套编排而不是放宽产品口径。
   *
   * @returns 下限秒数；非法值回退默认值（配置错不该让接口挂掉）。
   */
  function longVideoMinSeconds(): number {
    const raw = Number(process.env.BF_LONG_VIDEO_MIN_SECONDS ?? '')
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 30
  }

  /**
   * 产品图与形象库里某张形象图是不是同一张（逐字节相同）。
   *
   * 只判"完全相同"这一种情况：它就是实测踩到的那一脚（把另一位数字人的形象照当产品图传进来），
   * 判据确定、零误报。本机没有人脸检测，所以**不猜**"这张图里有没有人"——
   * 猜错一次就会把用户正常的产品图挡在门外，代价比漏一次大。
   *
   * @param productImageUrl - 用户这次给的产品图（本机素材 URL）；空串直接返回空。
   * @returns 与它相同的那张形象图所属数字人的名字；没有相同项时为空串。
   */
  function productImageMatchesHumanAvatar(productImageUrl: string): string {
    if (productImageUrl === '') return ''
    const product = readUploadedAsset(deps.dataRoot, productImageUrl)
    if (product === null) return ''
    for (const human of files.digitalHumans.load()) {
      const avatar = readUploadedAsset(deps.dataRoot, human.avatarUrl)
      if (avatar !== null && avatar.length === product.length && avatar.equals(product)) return human.name
    }
    return ''
  }

  /** 片段生成器注册表：新增一种内容形式只在这里加一行。 */
  /**
   * 出镜类内容形式必须先选一个数字人形象。
   *
   * 为什么单独一条（2026-09-24 实测）：没带 ref 时旧代码走的是"形象已被删除"那条错误——
   * 用户看到的是"数字人形象已被删除，任务中止"，而真相是**这个形式根本还没让他选形象**
   * （前端只在"数字人口播"下渲染选择器，见 LongVideoPage.tsx）。两件事必须分开说：
   * 没选 → 告诉他去哪儿选；选了但查不到 → 那才是"已被删除"。
   *
   * @param ref - 请求里带的数字人 id。
   * @returns 需要报错时返回错误，否则 undefined。
   */
  function requireHumanRef(ref?: string): { error: string } | undefined {
    return ref === undefined || ref.trim() === ''
      ? { error: '这个内容形式要出镜，请先选一个数字人形象（我的数字人 → 选一个或新建）' }
      : undefined
  }

  function producerFor(kind: string, ref?: string, productImageRef = ''): LongVideoProducer | { error: string } {
    if (kind === 'digital-human') {
      // 与出镜类形式同一条兜底：库里只有一个形象时不必让用户再选一次。
      const humanList = files.digitalHumans.load()
      const resolved = ref ?? (humanList.length === 1 ? humanList[0]!.id : undefined)
      const missing = requireHumanRef(resolved)
      if (missing !== undefined) return missing
      const human = humanList.find(item => item.id === resolved)
      if (human === undefined) return { error: '数字人形象已被删除，任务中止' }
      return digitalHumanProducer(withFixedSeed(human), productImageRef)
    }
    // 出镜类：都走同一套机械（母时钟、口型、贴音、字幕），差别只有体裁、导演要求与镜头模板。
    const onCamera: Record<string, LongVideoForm> = {
      vlog: VLOG_FORM,
      'short-talk': SHORT_TALK_FORM,
      unboxing: UNBOXING_FORM,
      tutorial: TUTORIAL_FORM,
    }
    const form = onCamera[kind]
    if (form !== undefined) {
      // 内容创作入口没有形象选择控件（2026-09-28 审计 #2）：用户选了出镜类形式，
      // 却没有地方指定"用哪个形象"。**只有一个形象时自动用它**——这不是猜，库里就一个人；
      // 0 个或 ≥2 个仍要求显式指定，否则等于替用户在几个人之间挑。
      const resolvedRef = ref ?? (files.digitalHumans.load().length === 1
        ? files.digitalHumans.load()[0]!.id
        : undefined)
      const missing = requireHumanRef(resolvedRef)
      if (missing !== undefined) return missing
      const human = files.digitalHumans.load().find(item => item.id === resolvedRef)
      if (human === undefined) return { error: '数字人形象已被删除，任务中止' }
      return digitalHumanProducer(withFixedSeed(human), productImageRef, form)
    }
    if (kind === 'scene') return sceneProducer(productImageRef, SCENE_FORM)
    if (kind === 'scene-seeding') return sceneProducer(productImageRef, SCENE_SEEDING_FORM)
    return { error: '未知的内容形式：' + kind }
  }

  /**
   * 数字人的固定种子：没有就当场补一个并落盘。
   *
   * 种子的作用按 2026-09-23 的真机对账改写（报告 `qa/reports/vlog-consistency-2026-09-23.md`）：
   * **"是不是同一个人"由形象图锚定**——同一个形象、两镜各换随机种子，判官仍判"同一个人"；
   * 种子管的是**这一镜画面的细节与构图**（换 seed 画面就变：同场景同台词的整帧相关只有 0.17~0.56），
   * 也就是"同一镜重跑能不能复现同一版画面"。
   *
   * 老版本建的形象、从别处导入的数据、或手工改过的 json 都可能没有这个字段；补一次就永久落盘：
   * 不补的话每次生成都换一个随机值，用户"重做这一镜"拿到的画面与上一版对不上，差异会全算到产品头上。
   *
   * @param human - 形象库里读到的数字人。
   * @returns 带合法种子的数字人；库里找不到它时原样返回（调用方随后会报"已被删除"）。
   */
  function withFixedSeed(human: ZyDigitalHuman): ZyDigitalHuman {
    if (Number.isInteger(human.seed) && human.seed >= 0) return human
    const list = files.digitalHumans.load()
    const target = list.find(item => item.id === human.id)
    if (target === undefined) return human
    target.seed = Math.floor(Math.random() * 1_000_000)
    target.updatedAt = nowIso()
    files.digitalHumans.save(list)
    console.error('[LONG_VIDEO_ERR] 数字人 ' + human.id + ' 没有固定种子（旧数据），已补一个并落盘：同一镜重跑复现同一版画面靠它')
    return target
  }

  /**
   * 走动 VLOG 的运镜要求：贴在口播镜提示词末尾。
   *
   * 为什么写死在提示词里而不是让模型自由发挥：厂商只认这一段文字，"人物在动"必须显式说；
   * 不写这句时数字人几乎总是坐着讲（用户反馈："像坐在一个地方干讲"）。
   */
  const MOVING_TALKING_CLAUSE = '人物在移动中说话：镜头手持跟拍、随步伐前进或侧移，背景随走动持续变化；不要坐下、不要静止对着镜头'

  /**
   * 全片一致性约束：贴在**每一镜**的厂商提示词末尾，管住人物、画面与声音三件事。
   *
   * 为什么必须是逐镜重复的硬约束，而不是只在第一镜说一次：厂商按镜独立生成，镜与镜之间
   * 不共享任何状态——只在开头交代一次，后面每一镜都拿不到它。
   *
   * 三件事各自的实测依据（2026-09-25，一条一分钟 15 镜的成片）：
   * - 人物：15 镜都用了同一张形象图，成片里仍是同一个人、同一姿势、同一景别，观感是"一段画面反复播放"；
   * - 画面：没有统一的机位与景别要求时，每镜都退回"正面坐着说话"这一个构图；
   * - 声音：15 镜里 14 镜的音轨是数字静音（均值 -63 ~ -85 dB）——**不写"要说话"，厂商就不出声**。
   */
  const CONSISTENCY_CLAUSE = '全片一致性要求：画面里是同一个人——与参考图完全相同的那个角色（同一个身份，不是"同类型的人"），同一张脸、同一发型、同一套服装；'
    // 服装单独再钉一次：实测同一张形象图跨镜出片时，模型会跟着每镜的场景描述换衣服
    // （第 1 镜白衬衫、第 2 镜起变成米白 T 恤），只写"同一套服装"它并不遵守。
    + '服装严格以参考图为准：颜色、款式、材质与配饰都不得改动，不要换成工装、外套、围裙或任何另一件衣服；'
    + '同一种画面风格——同一场景基调、同一光线方向、同一色调；'
    + '景别与机位逐镜变化，不要每镜都用同一个正面中景；'
    + '声音是同一个人在同一种状态下的说话声——同一音色、同一语气、同一语速，不要切换成播音腔或另一把声音。'
    // 实测（Seedance/Agnes 一致性长文与我们的对照实验）：手遮脸、快速转头、重复图案服装都会让模型"重新洗牌"人物。
    + '避免让手或物体遮住面部、避免快速甩头转头、避免大面积的重复图案服装——这些动作会让画面里的人物变成另一个人。'
    // 多张人物参考图时厂商会"把每个参考主体都画进画面"：实测成片里同时出现了两个小雅
    // （正面图一个、侧面图一个）。参考图是同一个人的不同角度，必须在提示词里说清只有一个人。
    + '参考图是同一个人的不同角度（正面/侧面/背面），不是多个人：画面里有人的镜头**只出现这一个人**，不要出现第二个相同的人，也不要出现长相相近的另一个人。'
    // 实测仍有镜头把三张参考图当成三个人并排画出来（成片第一镜同时出现两个小雅）。
    // 把"只有一位女性"写成一句独立、不可协商的硬约束。
    + '**全片画面里只有一位女性**：任何时刻都不得出现第二位女性、不得出现与主角相似的第二个人、不得把参考图里的多个角度当成多个人同时画进同一画面。'
    // 参考图多是白底证件照/立绘，厂商会连着白底一起抄：成片里出现"人物站在纯白背景前摆姿势"，
    // 与"实景 Vlog"完全相反（验收时看到的白底立绘就是这么来的）。
    + '画面必须是真实场景里的实拍质感：有真实的环境、陈设、背景层次与自然光线，不要白底影棚、不要纯色背景的摆拍、不要证件照构图。'
    // 第一人称镜头里出现手时，手也必须属于这同一个人（实测厂商默认画了一双男性的手）。
    + '画面里出现手时，这只手属于全片同一位年轻女性：肤色、手型与袖口一致，不要出现男性的手。'

  /**
   * 官方六段结构里的**视觉风格**一段（光线、色彩、材质、写实程度、氛围）。
   *
   * 为什么单独钉一段：CONSISTENCY_CLAUSE 管的是"跨镜保持一致"（同一光线方向、同一色调），
   * 它没有说清**这种风格本身长什么样**。官方《提示词建议》把"视觉风格"列为六段之一，
   * 缺这一段时厂商按自己的默认审美出片：CG 感、高饱和、塑料质感——正是用户口径的"画面不到位"。
   */
  const VISUAL_STYLE_CLAUSE = '画面风格：手机实拍的真实生活质感——写实，不是 CG、不是动画、不是插画；'
    + '用自然光或室内实用光源，光线方向明确、明暗过渡真实；色彩自然不过饱和、不要滤镜色偏；'
    + '材质细节看得见（皮肤纹理、布料织纹、木纹、金属与玻璃的反光），浅景深突出主体；'
    + '氛围松弛日常，像随手拍下来的一段生活，不要影棚白背景、不要塑料感'
  /**
   * 出镜类内容形式的**差异面**：数字人口播与走动 VLOG 共用同一套机械（母时钟、口型、贴音、字幕），
   * 只有三处不同——写稿体裁、分镜时的导演要求、以及**出片提示词**。
   *
   * 为什么"出片提示词"是差异面而不是细节：口播镜交给厂商的是"形象图 + 配音 + 一段提示词"，
   * 提示词写什么，画面就是什么。只写台词 = 人物坐着说话（观众看三镜就腻）；
   * 加上场景与运镜（"手持跟拍、人物走动、背景随步伐变化"）= 走动 VLOG 的观感。
   */
  interface LongVideoForm {
    /** 内容形式标识（落进任务记录、producers 清单与生成记录）。 */
    readonly kind: string
    /** 写稿体裁要求（进模型提示词）。 */
    readonly scriptBrief: (seconds: number, segments: number) => string
    /** 跨镜连贯性描述（背景与光线口径）。 */
    readonly continuityNote: string
    /** 分镜时额外的导演要求（运镜/场景变化），拼在分镜提示词里。 */
    readonly directorNote: string
    /** 口播镜的出片提示词：是否要把场景与运镜一起交给厂商（而不是只给台词）。 */
    readonly movingTalking: boolean
    /**
     * 镜头模板：这种类型的**镜头语言**（对标 Seedance 的运镜 + 多镜头写法）。
     *
     * 一份模板同时约束三件事——单镜时长区间、运镜白名单、以及每个 visual 必须写清的几件事。
     * 类型之间的差别一半在这里：口播短视频要"近景 + 少运镜"，开箱要"俯拍 + 手部特写"，
     * 教程要"步骤 + 俯拍"，VLOG 要"手持跟拍 + 场景变化"。
     */
    readonly shotTemplate: {
      /** 单镜时长区间（秒）。 */
      readonly minSeconds: number
      readonly maxSeconds: number
      /** 运镜白名单：分镜的每一镜从这里挑一种写进 visual。 */
      readonly cameraMoves: readonly string[]
      /** visual 的写法结构（顺序即写法）。 */
      readonly visualStructure: string
      /** 非口播镜最少占几成（0~1）；缺省按产品的 40% 口径。 */
      readonly minProductRatio?: number
    }
  }

  /** 数字人口播：坐着/站着把卖点讲清（成片以人物口播 + 产品镜为主）。 */
  const DIGITAL_HUMAN_FORM: LongVideoForm = {
    kind: 'digital-human',
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的中文带货口播稿：'
      + '口语化、开头有钩子、中间讲清卖点、结尾有行动号召。'
      + '全片按约 ' + String(segments) + ' 个镜头分段推进；**正文总量控制在 '
      + String(Math.round(seconds * 4.5)) + ' 字左右**（' + String(seconds)
      + ' 秒 × 每秒 4.5 字，偏差不要超过一成）——这是硬指标：写少了成片撑不满时长，'
      + '写多了会被母时钟退回重写重分镜，白白多花一倍额度（实测 60 秒档写成 510 字，'
      + '母时钟算出 125 秒、偏差 108%）。'
      + SPOKEN_STYLE_RULES
      + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。',
    continuityNote: '同一位主播，米色墙背景，室内柔和暖光，竖屏构图',
    directorNote: '',
    movingTalking: false,
    shotTemplate: {
      minSeconds: 4,
      maxSeconds: 6,
      cameraMoves: ['固定机位（人物坐/站在镜头前）', '缓慢推近', '半身近景切到产品特写'],
      visualStructure: '人物在画面中的位置与动作 + 身后的环境 + 景别',
    },
  }

  /**
   * 走动 VLOG：同一位主播**在移动中说**，场景随步伐变化（对标 Seedance 那类"多镜头 + 运镜"的提示词写法）。
   *
   * 与数字人口播共用同一套机械，差别在体裁与画面：稿子是第一人称当下时态，分镜必须写运镜与场景切换，
   * 口播镜交给厂商的提示词也从"台词"变成"场景 + 台词 + 走动运镜"。
   */
  const VLOG_FORM: LongVideoForm = {
    kind: 'vlog',
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的第一人称 VLOG 口播稿：'
      // 蝉妈妈对百万播放视频的统计：用户平均 0.8 秒划走一个视频，前三秒留不住人后面根本没人看。
      + '开场第一句必须在前 3 秒抓住人——用"预期落差 / 直击痛点的提问 / 具体到数字的细节 / 悬念"其中之一，'
      + '禁止"大家好""今天我带大家看看"这类开场；'
      + '像边走边讲给朋友听——用"我现在在…""你看这边…"这种当下时态的句子，一句一个动作或一个场景，'
      + '不要连着讲道理；中间要有"走两步、换个地方、顺手拿起来看看"的推进感。'
      + '全片按约 ' + String(segments) + ' 个镜头分段推进；**正文总量控制在 '
      + String(Math.round(seconds * 4.5)) + ' 字左右**（' + String(seconds)
      + ' 秒 × 每秒 4.5 字，偏差不要超过一成）——这是硬指标：写少了成片撑不满时长，'
      + '写多了会被母时钟退回重写重分镜，白白多花一倍额度（实测 60 秒档写成 510 字，'
      + '母时钟算出 125 秒、偏差 108%）。'
      + SPOKEN_STYLE_RULES
      + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。',
    // 竖屏的三条硬规矩（来自日本头部短剧团队 GOKKO 的公开方法论，累计播放 100 亿次）：
    // ① 竖屏左右极窄，横排并站会让人变小又局促——用"前-后"的纵深关系（肩后视角、人物走近镜头）；
    // ② 竖屏最适合接写：脸部/手部充满画面时，微表情直接传递，背景反而可以少做；
    // ③ 每 2~3 秒必须给新信息（换动作/换地点/拿起一样东西），停着不动的画面会立刻被划走。
    // 服装是"出戏"最快的地方：厂商按每镜的场景自己决定穿什么，实测一条片子里换了四次
    // （常服→工装→常服→工装），观众看到的是"这个人一直在换衣服"。
    // 规矩：整片只穿一套衣服；要换也只能在**全片唯一一次**场景跃迁处换（例如"从校园走进车间"），
    // 换过之后不再换回。
    continuityNote: '同一位主角，第三人称旁观视角（镜头是站在旁边看的人，不是主角的眼睛，不要自拍视角、不要出现拿着相机的手）：'
      + '镜头稳定：用固定机位或缓慢平稳的横移/推近，不要手持晃动、不要抖、不要快速甩镜；'
      + '标准视角（等效 24~35mm），人物与物体的比例自然，不要广角畸变、不要鱼眼、不要画面被拉伸；'
      + '服装全片只穿一套：从第一个镜头到最后一个镜头保持同一件衣服（同颜色、同款式、同配饰）；'
      + '不要在镜头之间换衣服、不要加外套或脱外套、不要把衣服换成另一种颜色；'
      + '如果剧情必须进入需要工装的场所，只在进入的那一次换一次，此后不再换回',
    directorNote: '每一镜都要写清"在哪、在做什么动作、镜头怎么跟着"：口播镜必须是人物**在走动中说话**'
      + '（例如"从门口走向工位""在货架前停下拿起产品""边走边回头说话"），背景随步伐变化，'
      + '镜头用手持跟拍/侧移/环绕/推近；禁止"坐着对着镜头讲""站在原地不动"这类静止画面。'
      + '产品镜与空镜同样要写拍摄手法（推近、俯拍、手持环绕），让全片像一条走动拍出来的 VLOG。'
      + '构图按竖屏的规矩：多用**接写**（脸部或手部充满画面），人物放在"前-后"的纵深关系里'
      + '（一人肩后拍另一人、人物朝镜头走近），**不要横排并站、不要大远景**；'
      + '每 2~3 秒必须有一个新信息（换动作、换地点、拿起一样东西），不要出现"停着不动"的画面。'
      // 台词一提到"旁人"，画面就会多出一个人（实测："师傅正教旁边那位同学"→ 出现第二个女性）。
      // 旁人可以有，但只能以远景、背影或虚化背景出现，绝不与主角同框特写。
      + '画面里**只有一位主角**：台词提到师傅、同学、工友时，这些人只能以远景、背影或虚化背景出现，'
      + '不要给旁人正脸特写、不要让两个人物并排出现、不要让第二个人的脸清晰可辨。',
    movingTalking: true,
    shotTemplate: {
      minSeconds: 4,
      maxSeconds: 6,
      // 走动 VLOG 的主角是人：非口播镜（手部特写/空镜）只占约两成，半数以上镜头要看得见人物。
      minProductRatio: 0.2,
      cameraMoves: ['固定机位中景', '缓慢横移跟随', '接写脸部特写', '推近到产品/手部', '俯拍操作台', '缓慢环绕半圈'],
      visualStructure: '人在哪（具体场景）+ 正在做什么动作 + 镜头怎么跟着（含接写或纵深构图）',
    },
  }

  /** 口播短视频：一条片子讲清一个点，近景为主、节奏快（对标短视频平台的口播形态）。 */
  const SHORT_TALK_FORM: LongVideoForm = {
    kind: 'short-talk',
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的短视频口播稿：'
      + '开头 3 秒必须给出结论或冲突（"别再…了""我劝你先看这个"），中间只讲一个点，结尾一句行动号召。'
      + '句子短、口语化，一句不超过 20 字；全片按约 ' + String(segments) + ' 个镜头分段推进。'
      + SPOKEN_STYLE_RULES
      + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。',
    continuityNote: '同一位主播，简洁背景，正面近景，竖屏构图',
    directorNote: '这是**近景口播**：镜头以固定近景与轻微推近为主，不要大幅运镜；'
      + '每一镜的人物位置、手势与表情要有变化（指向、摊手、比划），不要三镜同一个姿势。',
    movingTalking: false,
    shotTemplate: {
      minSeconds: 3,
      maxSeconds: 5,
      cameraMoves: ['固定近景', '轻微推近', '近景切产品特写再切回人物'],
      visualStructure: '人物景别与手势表情 + 背景 + 景别',
    },
  }

  /** 开箱测评：手部拆箱 + 产品特写 + 结论，靠手部动作与产品本体说话。 */
  const UNBOXING_FORM: LongVideoForm = {
    kind: 'unboxing',
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的开箱测评口播稿：'
      + '先说结论（值不值得买），再说依据（材质、做工、上手感受、和同类比），最后给建议。'
      + '每一句都对应一个能拍到的动作（拆盒、上手、称重、对比、试用），不要空讲形容词。'
      + '全片按约 ' + String(segments) + ' 个镜头分段推进；正文总量控制在 '
      + String(Math.round(seconds * 4.5)) + ' 字左右（' + String(seconds)
      + ' 秒 × 每秒 4.5 字，偏差不要超过一成）——这是硬指标。'
      + SPOKEN_STYLE_RULES
      + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。',
    continuityNote: '同一位主播，桌面开箱现场，顶光 + 台面，竖屏构图',
    directorNote: '重点在**手与产品**：拆盒、取出、上手、翻转、对比这些动作要逐镜写清；'
      + '镜头以俯拍与手部特写为主，产品镜必须写清产品形态与台面环境，不要编造包装上的文字。',
    movingTalking: false,
    shotTemplate: {
      minSeconds: 4,
      maxSeconds: 6,
      cameraMoves: ['俯拍手部特写', '推近到产品细节', '手部环绕半圈', '固定机位人物出镜点评'],
      visualStructure: '手在做什么（拆/拿/转/比）+ 产品形态 + 台面与光线',
    },
  }

  /** 教程：一步一步来，每镜一个步骤，俯拍手部/画面演示为主。 */
  const TUTORIAL_FORM: LongVideoForm = {
    kind: 'tutorial',
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的步骤教程口播稿：'
      + '按"第一步…第二步…"推进，每一步说清做什么、用什么、注意什么；'
      + '一步一句、不要跳步，也不要在一句里塞两步。全片按约 ' + String(segments) + ' 个镜头分段推进。'
      + SPOKEN_STYLE_RULES
      + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。',
    continuityNote: '同一位主播，操作台前，顶光俯拍视角，竖屏构图',
    directorNote: '每一步都要写清"手上在做什么"与"画面里能看到的材料/工具"；'
      + '镜头以俯拍步骤、手部特写、拉近到细节为主，禁止只拍人物脸讲步骤。',
    movingTalking: false,
    shotTemplate: {
      minSeconds: 4,
      maxSeconds: 6,
      cameraMoves: ['俯拍步骤全景', '推近到手部细节', '固定机位人物出镜点到', '侧移展示成品'],
      visualStructure: '这一步在做什么（手部动作）+ 用到的材料/工具 + 画面环境',
      minProductRatio: 0.5,
    },
  }

  /** 场景呈现（默认）：不出镜，每镜一个场景画面，产品镜占约四成。 */
  const SCENE_FORM: LongVideoForm = {
    kind: 'scene',
    // 这里写的是**旁白稿**（画外音），不是分镜稿。
    // 早先要求写成“分镜稿：每句描述一个具体画面、能直接当画面提示词用”，产出的正文
    // 全是“我站在门口、穿着工装、冷白灯光下是排列整齐的操作台”这类画面复述——
    // 用户念不出来、信息量为零，他的原话是“一分钟的视频只有几句话”（2026-09-28 现场）。
    // 画面由分镜环节单独安排，写稿这一环只负责“人嘴里说什么”。
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的中文短视频**旁白（画外音）**：'
      + '这段文字是要**被念出来的**，每一句都必须是能直接读出口的话。'
      + '全片按约 ' + String(segments) + ' 个镜头分段推进；开头有钩子、中间讲清这件事的价值与好处、'
      + '结尾给出行动号召（去哪里、做什么、怎么联系）。'
      + '内容要撑满整段时长：' + String(seconds) + ' 秒大约需要 '
      + String(Math.round(seconds * 4.5)) + ' 字，宁多勿少，不要几句话就收尾。'
      + '**不要写画面、不要写镜头、不要写光线与环境**（那是分镜环节的事），只写人嘴里说的话。'
      + SPOKEN_STYLE_RULES
      + '只输出正文，不要标题、不要编号、不要任何说明。',
    continuityNote: '真实生活场景，自然光，竖屏构图',
    directorNote: '',
    movingTalking: false,
    shotTemplate: {
      minSeconds: 4,
      maxSeconds: 6,
      cameraMoves: ['推近', '缓慢横移', '固定机位微动', '俯拍'],
      visualStructure: '主体（产品/场地/物件）+ 动作或状态 + 环境与光线',
    },
  }

  /**
   * 场景种草：**空镜为主 + 人物自然走过**，旁白在画面外。
   *
   * 与场景呈现的差别只有画面语言：允许并鼓励"人物入画但不对镜头说话"（走过、拿起、放下），
   * 运镜更像纪录片（跟随走动、横移、俯拍），产品镜至少要占一半——种草靠的是"我在这用它"的现场感。
   */
  const SCENE_SEEDING_FORM: LongVideoForm = {
    kind: 'scene-seeding',
    scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的场景种草旁白：'
      + '第一人称、现在时，像随手记录生活——"今天把桌面收拾了一下""你看这个角落…"；'
      + '每句对应一个能拍到的画面（人物走进画面、拿起产品、放到桌上、环境空镜），不要讲参数。'
      + '全片按约 ' + String(segments) + ' 个镜头分段推进；正文总量控制在 '
      + String(Math.round(seconds * 4.5)) + ' 字左右（' + String(seconds)
      + ' 秒 × 每秒 4.5 字，偏差不要超过一成）——这是硬指标。'
      + SPOKEN_STYLE_RULES
      + '只输出正文，不要标题、不要编号、不要任何说明。',
    continuityNote: '真实居家场景，自然光，手持纪录片质感，竖屏构图',
    directorNote: '**空镜 + 人物自然走过**：每一镜写清场地与人物"入画—做一件事—出画"的动作'
      + '（走进画面、拿起产品、放回桌面、从镜头前走过），人物不对镜头说话、不做口播动作；'
      + '产品镜用俯拍手部、推近细节、桌面全景，环境空镜要有生活痕迹（窗光、咖啡杯、绿植）。',
    movingTalking: false,
    shotTemplate: {
      minSeconds: 4,
      maxSeconds: 6,
      cameraMoves: ['跟随人物走动', '缓慢横移', '俯拍手部', '推近到产品细节'],
      visualStructure: '场地与光线 + 人物或手部的动作（入画/拿起/放下/走过）+ 镜头怎么跟',
      minProductRatio: 0.5,
    },
  }

  /**
   * 数字人口播：**全片只有一张脸、一种声音**。
   *
   * 按镜头类型分派（这是"像拍过的"的关键）：
   * - `talking-head`：形象图（+ 视频来源的原视频）与当镜台词交给厂商，reference 模式出片；
   * - `product`：画面提示词 + 产品参考图（若有）→ 图生视频，**画面主体是产品而不是人**；
   * - `scene`/`text-card`：按画面提示词出空镜。
   *
   * **声音由厂商在这次出片时自己念**（Agnes 原生）：台词逐字进提示词，念法（persona）逐镜重复，
   * 本机不再合成配音、也不再把音频当参考送进去。非口播镜没有出镜的人，旁白以画外音的形式写进提示词；
   * 厂商没照做时那一镜只剩环境声，字幕仍按台词走——不会静默成一段没人知道该说什么的画面。
   *
   * **口播镜只交形象图一张**（{@link talkingHeadImages}）：口播镜交给厂商的参考图就是"这个人是谁"，
   * 多一张人的图它就按两张融合。实测用户的真实数据里就出现过这种片子：产品图位放的是一张人像
   * （另一位数字人的形象照），于是每一镜都在两张脸之间跳——用户口径的"明明用一个数字人，
   * 画面里的人却跳到别的数字人去了"。代价是口播镜里出现的产品不再受参考图约束（厂商可能画一个
   * 臆造包装），由两个既有手段兜住：口播镜的画面提示词带"不出现任何文字与品牌标识"，
   * 而产品本身由专拍产品的镜头（占全片约四成）以**真实产品图**为主体交代清楚。
   *
   * 非口播镜则一律要求画面里不出现人物（{@link NO_PERSON_CLAUSE}）：那些镜头的参考图只有产品，
   * 厂商按文字画人时画出来的一定是另一张脸。
   *
   * 形象图定"是谁"（跨镜"是不是同一个人"由它锚定，2026-09-23 真机对账）；种子定"这一镜的画面怎么复现"——
   * 换 seed 画面就变（同场景同台词整帧相关 0.17~0.56），同一镜重跑要复现同一版就靠它。
   * 图像侧的图生图不可用（见 DEF-068），所以一致性只能在这一层做。
   *
   * @param human - 数字人形象（形象素材 + 念法 + 固定种子）。
   * @param productImageUrl - 用户给的产品参考图；没有时为空串。
   * @param form - 内容形式（口播 / 走动 VLOG / …）；缺省是数字人口播。
   * @returns 这一形式的镜头生成器。
   */
  function digitalHumanProducer(human: ZyDigitalHuman, productImageUrl = '', form: LongVideoForm = DIGITAL_HUMAN_FORM): LongVideoProducer {
    /**
     * 这个数字人的念法：写进**每一镜**的提示词。声音一致性靠它逐镜重复——
     * 厂商按镜独立生成、镜间不共享状态，只在开头交代一次，后面每一镜都拿不到。
     * 老数据没有 persona，按它当初选的音色与演绎风格折成同一段描述（见 {@link personaPrompt}）。
     */
    const persona = personaPrompt(human.persona ?? '', human.voice ?? '', human.voiceStyle ?? '')
    /** 视频建的形象：原视频（建形象时已裁到官方限制内）作为厂商的参考视频，首帧仍走图片那条参考通道。 */
    const sourceVideo = human.sourceVideoUrl ?? ''
    const continuityNote = form.continuityNote
    /** 产品镜的参考图集：用户给了产品图就用它，否则为空（纯描述）。 */
    const productRefs: ZyShotRef[] = productImageUrl === '' ? [] : [{ url: productImageUrl, role: 'product' }]

    return {
      kind: form.kind,
      // 暂时性失败（限流/5xx/超时/网络抖动）由编排层自动重跑这一镜：厂商 429 是"稍后再来"，
      // 不该把整条多镜任务判死、让用户盯着点"从断点继续"（实测一条 18 镜被限流打断五六次）。
      retryOnFailure: RETRYABLE_FAILURE_PREFIX,
      retryPolicy: retryPolicyFromEnv(),
      scriptBrief: form.scriptBrief,
      /**
       * 母时钟：给每一镜定出片时长。
       *
       * 旁白由厂商在这次出片时自己念（台词逐字写进提示词，见本函数下方的口播镜分支），
       * 所以这里按产品语速把台词的秒数估出来，夹进厂商的 4~12 秒区间后交给厂商当出片时长。
       *
       * 为什么保留这一层而不是直接删掉：编排层靠这些秒数做"母时钟对账"——
       * 各镜秒数累加与目标档位的偏差超容忍时，会在**还没调用厂商**之前先补写一版稿子。
       * 少了这一层，用户就会等到片出来才发现长度不对（那时额度已经花掉了）。
       */
      async planShotSeconds({ shots }) {
        const seconds: Record<string, number> = {}
        for (const shot of shots) {
          if (shot.line === '') continue
          // 与写稿门槛同一套折算：去标点后的字数 ÷ 产品语速，再夹进厂商的 4~12 秒区间。
          seconds[String(shot.index)] = clampSegmentSeconds(estimateSeconds(shot.line))
        }
        return { seconds }
      },
      async planShots({ targetSeconds, brief, instruction, topic, script }) {
        // 人物图挂在口播镜上；产品图由 fallbackShotPlan 按角色分派给产品镜。
        const references: ZyShotRef[] = [{ url: human.avatarUrl, role: 'person' }, ...productRefs]
        const hasProduct = productRefs.length > 0
        const subject = subjectFromTopic(topic)
        const fallbackShots = (): { shots: ZyShot[], source: 'fallback' } => ({
          // 模型不可用时的确定性兜底同样要钉用户要求——否则"模型挂了"就等于"用户要求丢了"。
          shots: pinVisualBrief(fallbackShotPlan(splitScript(script), references, 'digital-human', hasProduct, CHARS_PER_SECOND, subject), topic),
          source: 'fallback',
        })
        const prompt = '你是短视频导演。围绕「' + topic + '」' + brief + '\n' + instruction
          + (form.directorNote === '' ? '' : '\n' + form.directorNote)
          + '\n' + buildStoryboardPrompt(targetSeconds, hasProduct, {
            charsPerSecond: CHARS_PER_SECOND,
            personOnlyInTalkingHead: true,
            subject,
            // 用户写在「产品与卖点」里的画面要求原文：实测只抽 48 字题材时，
            // 217 字的输入里 15 项画面要求（运镜/色调/声音/构图…）全部丢失，成片必然跑偏。
            visualBrief: topic,
            // 融合创作：没有产品图也要排 B-roll，否则成片全是人物口播、看不见任何实物。
            allowBrollWithoutProduct: true,
            // 把已定稿的稿件交给排分镜的模型：画面才有机会对着"这一镜在讲什么"写，
            // 而不是让它自己另写一份短稿（那份短稿曾经就是成片短一截的直接原因，DEF-132）。
            script,
            // 镜头模板（运镜白名单 + visual 结构 + 单镜时长）：这是"内容形式"之间画面语言的差别。
            cameraMoves: form.shotTemplate.cameraMoves,
            visualStructure: form.shotTemplate.visualStructure,
            shotSeconds: { min: form.shotTemplate.minSeconds, max: form.shotTemplate.maxSeconds },
            ...(form.shotTemplate.minProductRatio === undefined ? {} : { minProductRatio: form.shotTemplate.minProductRatio }),
          })
        const planned = await completeWithModelOrNull(prompt)
        if (planned === null) return fallbackShots()
        const shots = parseShotPlan(planned, references, 'digital-human', formSellsProduct(form.kind))
        if (shots.length === 0) return fallbackShots()
        // 与分段编排同一条护栏：镜数超出目标口径 1.5 倍就退回兜底，不让成片长度翻倍。
        const shotBudget = planShotCount(targetSeconds)
        if (shots.length > shotBudget * 1.5) {
          console.error('[LONG_VIDEO_ERR] 分镜给了 ' + String(shots.length) + ' 镜，超出 ' + String(targetSeconds)
            + ' 秒档的 ' + String(shotBudget) + ' 镜口径，改用确定性兜底分镜')
          return fallbackShots()
        }
        // 台词一律由**已定稿的稿件**按镜头数分配（见 fitScriptToShots）：分镜模型只负责画面与节拍。
        // 模型自己写词时实测只有目标字数的 59%~83%，成片跟着短掉四分之一（DEF-132）。
        const fitted = fitScriptToShots(shots, script, CHARS_PER_SECOND)
        // 覆盖率本应是构造出来的（line 就是稿件的划分），量一次是为了"哪天切分被改坏、
        // 或者台词不再是来自稿件"能当场看见，而不是等用户又拿到一条短片。
        // 成片时长由台词合计决定，两者是同一件事。
        const coverage = shotsCoverTarget(fitted, targetSeconds, CHARS_PER_SECOND)
        if (!coverage.covered) {
          console.error('[LONG_VIDEO_ERR] 分镜台词合计 ' + String(coverage.chars) + ' 字，不足 ' + String(targetSeconds)
            + ' 秒所需的 ' + String(coverage.required) + ' 字：成片会比目标短一截（台词必须来自已定稿的稿件）')
        }
        // 融合创作的硬保证：模型排出"全是口播镜"时，由产品侧把一部分改成场景空镜——
        // 否则成片里只有人脸，观众看不见任何设备与场地（实测 22/22 全口播）。
        // 逐镜钉用户要求：模型在分镜这一步打折的地方，靠这里补回来（厂商只看单镜 prompt）。
        return { shots: pinVisualBrief(ensureBrollShots(fitted, subject), topic), source: 'model' }
      },
      async produce({ shot, resolution, aspectRatio, tailFrameFile }) {
        // 产品镜/空镜/文字卡：画面主体不是主播，不带人物形象图，走图生视频/文生视频。
        if (shot.kind === 'product' || shot.kind === 'scene' || shot.kind === 'text-card') {
          const shotProductRefs = shot.references.filter(item => item.role === 'product')
          // 这一镜的参考图里没有人物，厂商按文字画人时画出来的一定是另一张脸——画面切过去就是"换人了"。
          // 分镜提示词已经要求过，这里再硬补一次：模型漏写一次，用户看到的就是一条有两个人的片子。
          // 旁白同样逐字写进提示词（本机不再合成配音）：不写"要说话"，厂商给的就是一段纯环境声的画面。
          // 节拍的语气也一起给（钩子抓人 / 痛点放慢 / 号召果断）：语气不写进提示词，四拍念出来是一个调。
          // 旁白必须**是小雅的声音**：不写"女声/同一个人"时厂商默认给男声——
          // 实测成片里所有非口播镜都是男声旁白，整条片子的"我"变成了另一个人（用户口径："声音也是男的"）。
          // 按阿里云官方《视频生成 Prompt 指南》的"声音公式"写全六要素：
          // 人声 = 说话内容 + 情绪 + 语调 + 语速 + 音色 + 口音。此前只写"用画外音说出这句话"，
          // 缺了音色这一项，厂商默认配了男声（用户口径："声音也是男的"）。
          const voiceOverClause = shot.line === ''
            ? ''
            : '用同一位年轻女性的画外音（旁白）说出这句话——'
              + '音色：清亮、微甜的女声，与小雅是同一个人；语调：像跟朋友聊天，自然起伏；'
              + '语速：平实偏快，不要把字拖长；情绪：轻松、有分享欲；普通话，不要方言口音；'
              + '不要男声、不要播音腔、不要换成另一个人的声音：' + shot.line
          const beatHint = shot.beat === undefined ? '' : beatSpeechHint(shot.beat)
          // persona（念法：音色与演绎风格）也加进非口播镜：只在口播镜交代一次，旁白就换人了。
          // NO_RENDERED_TEXT 必须**每一镜**都带：实测只在分镜脚本里要求时，模型漏写的那几镜
          // 就把招生广告牌（"华创职业培训学校 学费500元"、"￥1200元"）画进了画面——
          // 平台把这些价格与文字判为违规营销，视频做得再好也限流。
          // 官方《提示词建议》要求 reference 模式在提示词里**写出素材占位符及其用途**：
          // 不指名时厂商只把参考图当"一张素材"，产品外形仍可能自己编（实测出过臆造包装）。
          const productImageClause = agnesPictureReferenceClause(
            shotProductRefs.map(() => '产品外观参考：保持外形、颜色、材质与比例不变，不要改包装上的任何内容'),
          )
          // 上一镜尾帧（若这一镜标了 continuous）：转成厂商可读的 Data URI 当首帧。
          const tailFrameValue = tailFrameFile === undefined || tailFrameFile === ''
            ? ''
            : inlineFileDataUri(tailFrameFile, 'image/png')
          // 非口播镜**不带人物参考图**：厂商只能按文字画人，画出来的一定是别人——
          // 实测镜 5 的 product 镜里出现了一位陌生女性（还多画了一位同事），而全片主角是另一位；
          // 同一镜的场景也从"金属实训台 + 冷白顶光"跳成了另一个绿墙车间。
          // 所以模型写在非口播镜里的人物句**整句剥掉**，只留物件、环境、光线与镜头运动；
          // 手部特写保留（不露脸），"不出现人脸"这类否定句也保留（它正是要留下的禁令）。
          // 这个分支只有 product / scene / text-card（口播镜走下面另一条路），一律剥人物句。
          const frameVisual = stripPersonClauses(shot.visual)
          const visual = [CONSISTENCY_CLAUSE, VISUAL_STYLE_CLAUSE, productImageClause, persona, NO_RENDERED_TEXT, shot.continuity === '' ? continuityNote : shot.continuity, frameVisual, voiceOverClause, beatHint, NO_PERSON_CLAUSE]
            .filter(part => part !== '')
            .join('。')
          const video = await generateAiVideoDirect(deps, visual, {
            // 短镜：镜头卡片给的就是 4~6 秒的目标时长（编排层已压好），这里只做厂商区间兜底。
            duration: clampSegmentSeconds(shot.seconds),
            resolution,
            aspectRatio,
            // 有产品参考图就带上（厂商按参考图约束画面主体）；没有就走纯文生视频。
            // 连续性（官方 create-video）：这一镜标了 continuous 时，**首帧参考优先于产品参考**——
            // 官方口径是「identity、composition、wardrobe、prop state、location 重要时先接受一张
            // 首帧参考再做图生视频」；而厂商侧 keyframe（1 张）与 reference（≥3 张）**互斥**，
            // 两者只能选一个，连续性镜选首帧。
            // 尾帧是本机 PNG、厂商在公网侧读不到 127.0.0.1，必须按字节内联成 Data URI。
            ...(tailFrameValue !== '' ? { imageUrls: [tailFrameValue] }
              : shotProductRefs.length > 0 ? { imageUrls: shotProductRefs.map(item => item.url) } : {}),
          })
          if (!video.ok) return { ok: false, error: video.reason }
          const file = localAssetFile(deps, video.url)
          if (file === '') return { ok: false, error: '成片落盘后找不到文件' }
          // 时长一律取**成片文件**的真实秒数：厂商按我们给的秒数出片，实际总有一点点出入。
          const seconds = await probeDurationSeconds(file)
          // 读不出成片时长时退回这一镜的目标时长：宁可拼接略有偏差，也不给出一条 null 的段。
          // 兜底值走 clampSegmentSeconds（本文件自己的函数）而不是跨模块引常量：
          // storyboard 的常量在本模块初始化时可能还是未初始化的绑定（实测拿到 undefined，产品镜因此返回 null 秒数）。
          const resolved = seconds > 0 ? seconds : shot.seconds
          return { ok: true, file, seconds: clampSegmentSeconds(Number.isFinite(resolved) ? resolved : 0) }
        }
        // 口播镜：念白交给厂商在这次出片时合成（Agnes 原声），本机不再合成配音、也不再把音频当参考送进去。
        // 送 audios 会走厂商的"按参考音重新配音"，那正是要避免的一层：它按参考音的节奏重念，而不是按这句话本身。
        const line = shot.line === '' ? shot.visual : shot.line
        // 口播镜此前**只交形象图一张**。厂商是按参考图**数量**切模式的：1 张走 keyframe，
        // 把画面锁死在这一帧上——用户写在提示词里的场景、光线、构图一律不生效
        // （实测：173 字的完整场景描述，成片仍然只是那张正面照在动）；≥3 张才走 reference，
        // 只锁"是谁"、场景按提示词生成。形象登记本来就带多角度图（正面/侧面/背面），
        // 把它们一起交出去才对得上用户"同一个人、画面按我写的来"的预期。
        const humanImages = (human.images ?? []).filter(url => url !== '')
        const avatarSources = humanImages.length >= 3 ? humanImages : [human.avatarUrl]
        const avatarValues = avatarSources
          .map(url => referenceImageValue(deps, url))
          .filter(value => value !== '')
        if (avatarValues.length === 0) return { ok: false, error: '形象图读不出来（素材可能已被删除）' }
        // 视频建的形象把原视频一起交给厂商（参考视频 = 视频生视频那条通道）：动作、说话方式、声音都从它延续。
        const referenceVideo = sourceVideo === '' ? undefined : referenceVideoValue(deps, sourceVideo)
        if (referenceVideo !== undefined && !referenceVideo.ok) return { ok: false, error: referenceVideo.error }
        // 参考视频要在提示词里被指名：官方提示词用 <Video N> 指代第 N 段参考视频（图片另有 <Picture N>）。
        // 不指名时厂商只把它当"一段素材"看，成片里的人物与动作容易另起一套。
        const videoClause = referenceVideo === undefined
          ? ''
          : '延续参考视频 <Video 1> 里这个人的长相、动作与说话方式，不要换成别人'
        // 台词逐字进提示词：厂商不知道"哪句是要说的话"，必须显式要求它开口，否则出的是无声画面
        // （2026-09-25 实测：一条一分钟的成片里 15 镜有 14 镜的音轨是数字静音，只有写进提示词的那一镜有声）。
        // 口播镜也按官方《声音公式》写全六要素——只写"用自然的口语说"时，
        // 厂商每次采样都可能换一把声音（用户口径："声音暂时对了，但不确定下次是否正常"）。
        const speechClause = '请让画面里的人用自然的口语说出下面这句话——'
          + '音色：清亮、微甜的女声（与参考图里是同一个人）；语调：像跟朋友聊天，自然起伏；'
          + '语速：平实偏快，不要把字拖长；情绪：轻松、有分享欲；普通话，不要方言口音；'
          + '不要男声、不要播音腔、不要换成另一个人的声音；'
          + '这句话是：' + line
        // 走动 VLOG 还要把"在哪、在做什么、镜头怎么跟"一起交给厂商，否则提示词只剩台词，必然给一个"坐着说话"的画面。
        // 念法（persona）逐镜重复：厂商按镜独立生成，镜间不共享状态，只在开头交代一次后面每一镜都拿不到。
        const beatHint = shot.beat === undefined ? '' : beatSpeechHint(shot.beat)
        // 形象图同样要被指名（官方要求写出占位符及其用途）：不指名时厂商仍可能照文字另编一张脸，
        // 而参考图与文字打架时它按哪一个走是不确定的。
        // 逐张指名用途（官方要求）：一张时是身份参考，多张时写明"同一个人的不同角度"——
        // 不写这句，厂商会把三视图当成三个人并排画进同一画面（实测过）。
        const avatarClause = agnesPictureReferenceClause(
          avatarValues.map((_, index) => avatarValues.length === 1
            ? '全片唯一主角的身份参考：画面里的人的同一张脸、同一发型、同一套服装'
            : '同一个人（全片唯一主角）的第 ' + String(index + 1) + ' 个角度，不是另一个人，'
              + '不要把她当成多个人同时画进同一画面'),
        )
        const talkingPrompt = form.movingTalking
          ? [CONSISTENCY_CLAUSE, VISUAL_STYLE_CLAUSE, avatarClause, persona, NO_RENDERED_TEXT, beatHint, videoClause, shot.continuity === '' ? continuityNote : shot.continuity, shot.visual, speechClause, MOVING_TALKING_CLAUSE]
              .filter(part => part !== '')
              .join('。')
          : [CONSISTENCY_CLAUSE, VISUAL_STYLE_CLAUSE, avatarClause, persona, NO_RENDERED_TEXT, beatHint, videoClause, speechClause].filter(part => part !== '').join('。')
        const video = await generateAiVideoDirect(deps, talkingPrompt, {
          // 时长按母时钟估出来的这一镜秒数：厂商按它出片，配音也在这个时长内念完。
          duration: clampSegmentSeconds(shot.seconds > 0 ? shot.seconds : estimateSeconds(line)),
          resolution,
          aspectRatio,
          talkingHead: {
            images: avatarValues,
            // 不传 audios：交由厂商按提示词里的那句台词自己念（Agnes 原声）。
            ...(referenceVideo === undefined ? {} : { videos: [{ url: referenceVideo.value }] }),
            seed: human.seed,
          },
        })
        if (!video.ok) return { ok: false, error: video.reason }
        const local = localAssetFile(deps, video.url)
        if (local === '') return { ok: false, error: '成片落盘后找不到文件' }
        // 字幕时间轴跟的是成片长度，不是配音长度：厂商会重新配音，两者常常对不齐。
        // 读不出成片时长时退回配音时长，宁可字幕略有偏差，也不让整段失败。
        const probed = await probeDurationSeconds(local)
        const fallbackSeconds = shot.seconds > 0 ? shot.seconds : clampSegmentSeconds(estimateSeconds(line))
        return { ok: true, file: local, seconds: probed > 0 ? probed : fallbackSeconds }
      },
    }
  }

  /**
   * 不出镜的场景类：每镜由厂商按画面文案直接生成场景画面（成片自带环境音）。
   *
   * 差异面同样收在 {@link LongVideoForm} 里：场景呈现（产品镜约四成）与场景种草
   * （空镜 + 人物走过，产品镜至少一半）共用这一段代码，只有体裁、导演要求与镜头模板不同。
   *
   * @param productImageUrl - 用户给的产品参考图（可为空）。
   * @param form - 内容形式；缺省是场景呈现。
   * @returns 这一形式的镜头生成器。
   */
  function sceneProducer(
    productImageUrl = '',
    form: LongVideoForm = SCENE_FORM,
    personImageUrls: readonly string[] = [],
  ): LongVideoProducer {
    const productRefs: ZyShotRef[] = productImageUrl === '' ? [] : [{ url: productImageUrl, role: 'product' }]
    // 人物参考图集：**每一镜都要带上**。厂商按参考图数量切模式——1 张走 keyframe（画面被这张图锁死），
    // ≥3 张才走 reference（只锁"是谁"，场景按提示词生成）。
    // 分段链路此前只把第 1 张参考图当"产品图"传下去，用户传的三张人物图到不了厂商，
    // 于是长片必然退化成"口播 + 产品特写"，跟 VLOG 的拍法无关。
    const personRefs: ZyShotRef[] = personImageUrls.filter(url => url !== '').map(url => ({ url, role: 'person' }))
    return {
      kind: form.kind,
      // 与数字人口播同一条厂商链路，暂时性失败同样自动重跑这一镜。
      retryOnFailure: RETRYABLE_FAILURE_PREFIX,
      retryPolicy: retryPolicyFromEnv(),
      scriptBrief: form.scriptBrief,
      async planShots({ targetSeconds, brief, instruction, topic, script }) {
        const hasProduct = productRefs.length > 0
        const subject = subjectFromTopic(topic)
        const fallbackShots = (): { shots: ZyShot[], source: 'fallback' } => ({
          // 与数字人口播同一条兜底：兜底分镜也要钉用户要求。
          shots: pinVisualBrief(fallbackShotPlan(splitScript(script), productRefs, 'scene', hasProduct, undefined, subject), topic),
          source: 'fallback',
        })
        const prompt = '你是短视频导演。围绕「' + topic + '」' + brief + '\n' + instruction
          + (form.directorNote === '' ? '' : '\n' + form.directorNote)
          + '\n' + buildStoryboardPrompt(targetSeconds, hasProduct, {
            subject,
            // 走动 VLOG 的主角是人：非口播镜（手部特写、空镜）只穿插，设上限。
            personLed: true,
            // 与数字人口播同一理由：用户写的画面要求必须整段进分镜，不能只留 48 字题材。
            visualBrief: topic,
            cameraMoves: form.shotTemplate.cameraMoves,
            visualStructure: form.shotTemplate.visualStructure,
            shotSeconds: { min: form.shotTemplate.minSeconds, max: form.shotTemplate.maxSeconds },
            ...(form.shotTemplate.minProductRatio === undefined ? {} : { minProductRatio: form.shotTemplate.minProductRatio }),
          })
        const planned = await completeWithModelOrNull(prompt)
        if (planned === null) return fallbackShots()
        const shots = parseShotPlan(planned, productRefs, form.kind, formSellsProduct(form.kind))
        if (shots.length === 0) return fallbackShots()
        // 镜数护栏：模型多排镜会让每一镜短于厂商最短的 4 秒，母时钟只能按 4 秒算 → 成片长度翻倍
        // （实测 60 秒档被排成 33 镜，母时钟算出 128 秒：目标是 60 秒、实际会到 2 分多）。
        // 一镜 5 秒是产品的口径，60 秒就是 12 镜上下；超出 1.5 倍一律退回确定性兜底分镜。
        const shotBudget = planShotCount(targetSeconds)
        if (shots.length > shotBudget * 1.5) {
          console.error('[LONG_VIDEO_ERR] 分镜给了 ' + String(shots.length) + ' 镜，超出 ' + String(targetSeconds)
            + ' 秒档的 ' + String(shotBudget) + ' 镜口径，改用确定性兜底分镜')
          return fallbackShots()
        }
        // **台词一律来自稿件**：模型这一趟只负责排画面（visual），它自己顺手写的台词要丢掉。
        // 实测：不覆盖时成片念的是模型自编的推销腔（"你信不信啊，人社局真给咱们送免费名额"），
        // 而稿件里明明是贴合用户提示词的"我在人社局大厅呢，刚领完工装，蓝灰的，袖口绣着字"——
        // 用户写的提示词驱动的稿子被整段抛弃，字幕也就跟着错乱。
        const scriptLines = splitScript(script)
        const withScriptLines = shots.map((shot, index) => ({ ...shot, line: scriptLines[index] ?? '' }))
        // 与数字人同一条兜底：空 line 的镜头补上稿件里还没念过的句子，不让画面空转。
        // 与数字人口播同一条兜底：用户写的画面要求逐镜钉一次。
        return { shots: pinVisualBrief(fillMissingLines(withScriptLines, script), topic), source: 'model' }
      },
      async produce({ shot, resolution, aspectRatio, tailFrameFile }) {
        // 口播镜**故意不接上一镜尾帧**：它走 reference 模式（多张形象图锁人），
        // 而厂商侧 keyframe（首帧）与 reference **互斥**，两者只能选一个——
        // 官方 create-video 的顺序也把 identity（锁人）排在 continuity（帧间连续）之前。
        // 口播镜的连续性由「同一套形象图 + 逐镜一致性约束句」保证，不靠接帧。
        void tailFrameFile
        const text = shot.visual === '' ? shot.line : shot.visual
        // 有人的镜头必须写明"只出现一个人"：给了多张人物参考图时，厂商会把参考主体一个个画进画面——
        // 实测成片里同时出现了两个小雅（正面图一个、侧面图一个），"同一个人的多角度参考"被当成了"多个人"。
        const withSinglePerson = shot.kind === 'product'
          ? text
          : text + '；画面里只出现一个人（参考图是同一个人的不同角度，不是多个人），不要出现第二个相同的人'
        // 画面时长按这句文案的体量给：固定给 12 秒会让厂商把画面拖慢拉长，
        // 一条片里出现几段"慢动作空镜"，也就是用户说的"画面不搭配"。
        const requested = clampSegmentSeconds(shot.seconds > 0 ? shot.seconds : estimateSeconds(text))
        const shotProductRefs = shot.references.filter(item => item.role === 'product')
        // 人物参考图每镜都带（去重后），产品图用分镜排的那张：
        // 三张人物图 + 一张产品图一起送，厂商才会走 reference 而不是 keyframe。
        const refs = [...personRefs, ...shotProductRefs]
        const uniqueRefs = refs.filter((item, index) => refs.findIndex(other => other.url === item.url) === index)
        // 官方《提示词建议》要求 reference 模式在提示词里**写出素材占位符及其用途**。
        // 不指名时厂商把多张图当"一堆素材"：实测同一个人的三个角度被当成三个人并排画进同一画面；
        // 逐张写明"哪张是身份、哪张是产品"之后，参考图各管什么才由我们说了算。
        const personRows = uniqueRefs.map((item, index) => ({ item, index })).filter(row => row.item.role === 'person')
        const referenceClause = agnesPictureReferenceClause(uniqueRefs.map((item, index) => {
          if (item.role !== 'person') return '产品外观参考：保持外形、颜色、材质与比例不变，不要改包装上的任何内容'
          return personRows.length === 1
            ? '全片唯一主角的身份与外观参考（长相、发型、服装都按它，不要换成另一个人）'
            : '同一个人（全片唯一主角）的第 ' + String(personRows.findIndex(row => row.index === index) + 1)
              + ' 个角度，不是另一个人，不要把她当成多个人同时画进同一画面'
        }))
        // 拼装顺序与官方给的六段顺序一致：视觉风格 → 画面（含镜头语言）→ 参考素材用途。
        const videoPrompt = [VISUAL_STYLE_CLAUSE, withSinglePerson, referenceClause].filter(part => part !== '').join('。')
        const video = await generateAiVideoDirect(deps, videoPrompt, {
          duration: requested,
          resolution,
          aspectRatio,
          ...(uniqueRefs.length > 0 ? { imageUrls: uniqueRefs.map(item => item.url) } : {}),
        })
        if (!video.ok) return { ok: false, error: video.reason }
        const local = localAssetFile(deps, video.url)
        if (local === '') return { ok: false, error: '成片落盘后找不到文件' }
        // 场景片段没有本地配音：长度以厂商成片的真实时长为准，不按请求值假装。
        const seconds = await probeDurationSeconds(local)
        return { ok: true, file: local, seconds: seconds > 0 ? seconds : requested }
      },
    }
  }

  /** 通用工作流的能力注入：编排层不认识数字人，也不认识厂商。 */
  function longVideoDeps(): LongVideoDeps {
    return {
      dataRoot: deps.dataRoot,
      loadTasks: () => files.longVideoTasks.load(),
      saveTasks: tasks => { files.longVideoTasks.save(tasks) },
      // 编排层靠这一条判断"参考图还在不在"：素材可能被用户在生成期间删掉。
      readAssetBytes: url => readUploadedAsset(deps.dataRoot, url),
      writeScript: writeLongVideoScript,
      registerVideo: registerLongVideoDraft,
    }
  }

  /**
   * 写稿：体裁要求由片段生成器给，编排层的长度要求由 instruction 给，
   * 这里只把两者并进提示词，并把结果清成可直接使用的文本。
   */
  async function writeLongVideoScript(
    topic: string,
    brief: string,
    instruction: string,
    sourceId = '',
  ): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
    const stored = readStoredLlm(deps.dataRoot)
    const missing = missingChatModelReason(stored)
    if (missing !== '') return { ok: false, error: missing }
    // 稿件要讲的是**用户的产品**：产品资料必须在场，否则模型只能编。
    const knowledgeState = files.knowledge.load() as KnowledgeState
    const knowledge = buildKnowledgeContext(knowledgeState, topic + ' ' + instruction)
    const quality = buildQualityContext(knowledgeState, 'video')
    const prompt = '你是短视频编剧。围绕「' + topic + '」' + brief + '\n' + instruction
    const out = await streamLlmWithDeltas(
      prompt,
      undefined,
      stored,
      knowledge.block + quality.block,
    )
    const text = normalizeSpokenText(out.text)
    if (text === '')
      return { ok: false, error: '大模型没有返回可用的稿件：' + (out.error ?? '未知错误') }
    // 留痕：编排层能给出任务 id 就用它（这样"这条稿属于哪条任务"查得到），
    // 给不出就内容寻址——**两条路都必须留痕**，不能因为拿不到 id 就什么都不记。
    recordDistillation(deps, {
      sourceId: sourceId !== '' ? 'long-video-script-' + sourceId : tracedSourceId('long-video-script', prompt),
      task: 'video',
      instruction: prompt,
      instructionLabel: '长视频稿件：' + topic.slice(0, 20),
      output: text,
      model: out.model ?? '',
      toolCalls: out.toolCalls ?? 0,
      ...(out.elapsedMs === undefined ? {} : { elapsedMs: out.elapsedMs }),
      ...(out.contextChars === undefined ? {} : { contextChars: out.contextChars }),
      knowledgePaths: knowledge.paths,
      knowledgeChars: knowledge.chars,
      status: 'success',
      rating: 0,
      exampleIds: quality.ids,
    })
    return { ok: true, text }
  }

  /**
   * 用当前生效的大模型补全一段提示词；未接入或调用失败时如实回原因。
   *
   * @param prompt - 已拼好的完整要求。
   * @returns 模型返回的文本，或可读的失败原因。
   */
  /**
   * 没配对话模型时给用户的那句话；配好了返回空串。
   *
   * 判据是"地址 + 密钥 + **型号**"三样齐全：产品不内置任何大模型，所以只填了 Key
   * 而没选型号，同样是"还没配置完"。这句话会被写稿、分镜、提示词增强三处复用，
   * 文案里必须给出下一步动作（去哪、做什么），否则用户只知道"失败了"。
   *
   * @param stored - 本机读到的模型配置；未配置时为 undefined。
   * @returns 可执行的提示；配置完整时为空串。
   */
  function missingChatModelReason(stored: LlmOverride | undefined): string {
    if (stored === undefined)
      return '还没有配置大模型。请到「设置 → 配置大模型」填写接口地址、API Key 并选一个模型——本产品只内置服务商，不内置任何大模型。'
    if (stored.model.trim() === '')
      return '配置里还没有选模型。请到「设置 → 配置大模型」点「获取可用模型」并选一个对话模型。'
    return ''
  }

  /**
   * 与 {@link completeWithModel} 同一件事，但**失败返回 null 而不是抛错**。
   *
   * 给"可选增强"用：分镜排不出来要走确定性兜底、提示词增强失败要如实提示，
   * 两者都不该让整条链路中断，所以这里把失败折叠成 null 由调用方决定怎么退。
   *
   * @param prompt - 已拼好的完整要求。
   * @returns 模型文本；未接入或调用失败时为 null。
   */
  async function completeWithModelOrNull(prompt: string): Promise<string | null> {
    try {
      const out = await completeWithModel(prompt)
      return out.ok && out.text.trim() !== '' ? out.text : null
    }
    catch (error) {
      console.error('[LONG_VIDEO_ERR] 模型调用失败，走确定性兜底：' + String(error))
      return null
    }
  }

  /**
   * 用当前生效的大模型补全一段文本。
   *
   * @param prompt - 已拼好的完整要求。
   * @param label - 留痕用的用途标签。
   * @param remember - 是否把这次调用记进知识库。**提示词增强必须传 false**：
   *   它的输出是"改写后的提示词"，不是可复用的创作素材；记进去以后，后续写稿会把它当参考资料
   *   塞进提示词，模型就会把指令原文当台词念出来（实测成片字幕里出现了"保留原有产品、卖点、价格与优惠"）。
   */
  async function completeWithModel(prompt: string, label = '长视频：模型补全', remember = true): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
    const stored = readStoredLlm(deps.dataRoot)
    const missing = missingChatModelReason(stored)
    if (missing !== '') return { ok: false, error: missing }
    // 写内容就该用**用户自己的资料**：选题增强、排分镜同样是"围绕他的产品写东西"，
    // 空手去问模型等于把产品事实交给它编（这一条是 S5 审计里查出来的缺口）。
    const knowledgeState = files.knowledge.load() as KnowledgeState
    const knowledge = buildKnowledgeContext(knowledgeState, prompt)
    const quality = buildQualityContext(knowledgeState, 'video')
    const out = await streamLlmWithDeltas(prompt, undefined, stored, knowledge.block + quality.block)
    const text = out.text.trim()
    if (text === '')
      return { ok: false, error: '大模型没有返回内容：' + (out.error ?? '未知错误') }
    // 每一次创作类模型调用都留痕（ADR-004 S5）；提示词增强这类工具性改写不留（见 remember 的说明）。
    if (remember) recordDistillation(deps, {
      sourceId: tracedSourceId('text-call', prompt),
      task: 'video',
      instruction: prompt,
      instructionLabel: label,
      output: text,
      model: out.model ?? '',
      toolCalls: out.toolCalls ?? 0,
      ...(out.elapsedMs === undefined ? {} : { elapsedMs: out.elapsedMs }),
      ...(out.contextChars === undefined ? {} : { contextChars: out.contextChars }),
      knowledgePaths: knowledge.paths,
      knowledgeChars: knowledge.chars,
      status: 'success',
      rating: 0,
      exampleIds: quality.ids,
    })
    return { ok: true, text }
  }

  /**
   * 成片登记：落一条草稿，下一步就能直接发。
   *
   * 登记失败不得影响"成片已产出"这个事实：视频在 uploads 里已经可用，
   * 这里出错只记日志，任务状态仍以成片为准。
   */
  async function registerLongVideoDraft(task: ZyLongVideoTask, script: string): Promise<void> {
    if (task.videoUrl === undefined || task.videoUrl === '') return
    let cover = ''
    try {
      cover = (await extractVideoThumbnail(deps, task.videoUrl)) ?? ''
    }
    catch (error) {
      console.error('[LONG_VIDEO_ERR] 封面抽取失败 ' + String(error))
    }
    const human = task.producerRef === undefined
      ? undefined
      : files.digitalHumans.load().find(item => item.id === task.producerRef)
    const contents = files.contents.load()
    const contentId = uid('cnt')
    contents.unshift({
      kind: 'draft',
      _id: contentId,
      id: contentId,
      groupId: DEFAULT_MATERIAL_GROUP_ID,
      title: ((human?.name ?? task.producer) + '｜' + task.topic).slice(0, 60),
      desc: script.slice(0, 5000),
      coverUrl: cover,
      mediaList: [{ type: 'video' as const, url: task.videoUrl, thumbUrl: cover }],
      type: 'video',
      status: 0,
      topics: [],
      useCount: 0,
      createdAt: nowIso(),
      metadata: { longVideoTaskId: task.id, producer: task.producer },
    })
    files.contents.save(contents)
    // 交接件：把这条草稿的 id 回写到长视频任务行上。
    // 有了它，AI 查进度时能直接拿到 materialId 交给发布，不必凭标题去草稿箱里翻——
    // "出片 → 发布"这一段交接原先就断在这里（下游只能二次查找）。
    const tasks = files.longVideoTasks.load()
    const target = tasks.find(item => item.id === task.id)
    if (target !== undefined) {
      target.materialId = contentId
      target.updatedAt = nowIso()
      files.longVideoTasks.save(tasks)
    }
  }

  /** 起一条长视频任务：立即回任务 id，后台按段推进。 */
  function startLongVideoTask(input: {
    producer: string
    producerRef?: string
    topic: string
    targetSeconds: number
    resolution?: string
    aspectRatio?: string
    withSubtitles?: boolean
    /**
     * 可选的产品参考图（本机素材 URL）。
     *
     * 这是"业余用户不被打扰、专业用户能更进一步"的那个可选加速器：
     * 给了它，产品镜就以**真实产品**为主体（画面不会画错包装与外形）；
     * 不给，产品镜退化为纯描述，画面里不许出现任何文字与品牌（见 DEF-068 的实测结论）。
     */
    productImageUrl?: string
    /**
     * 可选：这条片已经定稿的稿件。
     *
     * "内容创作"那条入口把用户已经拿到的稿子交进来——编排层不再自己写稿，用户在生成记录里
     * 看到的就是成片里念的那份；不给则按主题现写（长视频创作页的入口是这一条）。
     */
    scriptText?: string
    /**
     * 跑完是否把成片登记进素材库（缺省登记）。
     *
     * 内容创作的产物归属是那条生成记录：再登记一份素材，素材库里就会出现两条一模一样的视频。
     */
    registerAsMaterial?: boolean
  }): { ok: true, taskId: string, estimate: LongVideoEstimate } | { ok: false, error: string } {
    // 产品图必须是本机读得到的素材：厂商要按字节内联，读不到就生成不了——当场拒绝，不建一条注定跑不完的任务。
    const productImageUrl = (input.productImageUrl ?? '').trim()
    if (productImageUrl !== '' && localAssetFile(deps, productImageUrl) === '') {
      return { ok: false, error: '产品图读不出来，请重新上传一张产品照片' }
    }
    // 产品图位放了一张人像：厂商拿它当首帧，成片里就会出现**另一个人**（实测用户踩过这一脚：
    // 产品图选的是另一位数字人的形象照，整条片子每隔几镜就换一张脸）。
    // 先挡住能确定的那一类——与形象库里的形象图逐字节相同；确实是人像但不在库里的那种，
    // 靠前端在上传处的明示（本机没有人脸检测，不猜）。
    const personPhotoName = productImageMatchesHumanAvatar(productImageUrl)
    if (personPhotoName !== '') {
      return {
        ok: false,
        error: '这张图是数字人「' + personPhotoName + '」的形象照，不是产品图。'
          + '产品图请只放产品本身：画面会拿它当首帧，放人脸就会在成片里出现另一个人。',
      }
    }
    const producer = producerFor(input.producer, input.producerRef, productImageUrl)
    if ('error' in producer) return { ok: false, error: producer.error }
    const task: ZyLongVideoTask = {
      id: uid('lv'),
      producer: input.producer,
      ...(input.producerRef !== undefined ? { producerRef: input.producerRef } : {}),
      ...(productImageUrl !== '' ? { productImageUrl } : {}),
      topic: input.topic,
      targetSeconds: input.targetSeconds,
      ...(input.scriptText === undefined || input.scriptText.trim() === '' ? {} : { scriptText: input.scriptText.trim() }),
      resolution: input.resolution ?? '720p',
      aspectRatio: input.aspectRatio ?? '9:16',
      // 短视频带货默认带字幕（静音刷到的用户占多数）；要干净画面可以显式关掉。
      withSubtitles: input.withSubtitles !== false,
      status: 'generating',
      doneSegments: 0,
      totalSegments: 0,
      segments: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    const tasks = files.longVideoTasks.load()
    tasks.unshift(task)
    files.longVideoTasks.save(tasks)
    // 一条 30 秒成片要串行跑 4~8 次厂商生成（每次 1~3 分钟），同步等必超时：
    // 立即回任务 id，前端按段数轮询真实进度。
    // 内容创作那条入口不要素材登记：它的产物归属是生成记录（见 registerAsMaterial 的说明）。
    const jobDeps = input.registerAsMaterial === false
      ? { ...longVideoDeps(), registerVideo: async (): Promise<void> => undefined }
      : longVideoDeps()
    setTimeout(() => { void runLongVideoJob(jobDeps, task.id, producer) }, 300)
    return { ok: true, taskId: task.id, estimate: estimateLongVideo(task.targetSeconds, producer.charsPerSecond ?? CHARS_PER_SECOND) }
  }

  /**
   * 起任务前的预估：让用户点之前就知道要等多久、会跑几次厂商生成。
   *
   * 镜位数按"短时长多片段"的口径算（{@link planShotCount}：目标时长 ÷ 5 秒，向上取整）；
   * 时间按每镜 1~5 分钟给区间——**这是量级不是承诺**，厂商排队慢了这个区间只会更长，
   * 所以文案里写"约"，界面上也如实说明真实进度以镜数为准。
   *
   * @param targetSeconds - 目标成片时长（秒）。
   * @returns 预估镜数、时长与厂商调用次数区间。
   */
  function estimateLongVideo(targetSeconds: number, charsPerSecond = CHARS_PER_SECOND): LongVideoEstimate {
    const shots = planShotCount(targetSeconds)
    return {
      shots,
      // 每镜一次厂商生成；每镜 1~5 分钟（与前端进度面板同一口径）。
      callsMin: shots,
      callsMax: shots,
      minutesMin: shots * 1,
      minutesMax: shots * 5,
      // 稿件字数门槛前置告知（DEF-108）：用户点之前就知道这条片要多少字的口播稿。
      requiredChars: minScriptChars(targetSeconds, charsPerSecond),
      charsPerSecond,
      writerPaceCharsPerSecond: CHARS_PER_SECOND,
    }
  }

  /**
   * 数字人的**念法**目录：写进厂商提示词的声音人设。
   *
   * 为什么不再有音色清单与试听：成片里那一声由厂商在出片时自己念（Agnes 原生），
   * 厂商侧没有"音色 id"这种概念，声音只能靠提示词描述（性别、口音、音色质感、语速、语气）。
   * 念法因此不存在"选了某条却出不来"的失败模式，也就没有"先试听再决定"这一步——
   * `sampleText` 是给用户照着写稿的参考台词样板。
   */
  const personaPayload = (): unknown => ({
    list: DIGITAL_HUMAN_PERSONAS,
    defaultPersona: DEFAULT_DIGITAL_HUMAN_PERSONA,
    sampleText: VOICE_PREVIEW_TEXT,
  })

  routes.push(
    {
      m: 'GET',
      p: 'digital-humans/personas',
      h: ({ res }) => { writeOk(res, personaPayload()) },
    },
    {
      m: 'GET',
      p: 'digital-humans',
      h: ({ res }) => { writeOk(res, { list: files.digitalHumans.load() }) },
    },
    {
      m: 'POST',
      p: 'digital-humans',
      h: async ({ res, body }) => {
        const input = (body ?? {}) as { name?: unknown, avatarUrl?: unknown, persona?: unknown, images?: unknown }
        const name = typeof input.name === 'string' ? input.name.trim().slice(0, 30) : ''
        const avatarUrl = typeof input.avatarUrl === 'string' ? input.avatarUrl.trim() : ''
        // 多角度参考图（正面/侧面/背面）：厂商按**张数**切模式，≥3 张才走 reference
        // 只锁「是谁」而不锁画面；只给一张会走 keyframe 把画面锁死。
        const angleImages = Array.isArray(input.images)
          ? (input.images as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim() !== '').slice(0, 8)
          : []
        if (name === '' || avatarUrl === '') { writeFail(res, '数字人需要名字和形象素材', 40000); return }
        // 素材必须是本机文件：厂商要按字节内联，读不到就生成不了。
        const sourceFile = localAssetFile(deps, avatarUrl)
        if (sourceFile === '') { writeFail(res, '素材读不出来，请重新上传一张正面半身照或一段视频', 40000); return }
        // 视频上传：抽出形象帧，并把原视频按官方限制裁一段当参考视频（视频生视频那条通道）。
        const isVideo = DIGITAL_HUMAN_VIDEO_EXTENSIONS.includes(extname(sourceFile).toLowerCase())
        let resolvedAvatarUrl = avatarUrl
        let referenceVideoUrl: string | undefined
        if (isVideo) {
          const prepared = await prepareDigitalHumanVideo(deps.dataRoot, sourceFile)
          if (!prepared.ok) { writeFail(res, prepared.error, 40000); return }
          resolvedAvatarUrl = prepared.frameUrl
          referenceVideoUrl = prepared.referenceVideoUrl
        }
        const human: ZyDigitalHuman = {
          id: uid('dh'),
          name,
          avatarUrl: resolvedAvatarUrl,
          ...(angleImages.length === 0 ? {} : { images: angleImages }),
          ...(referenceVideoUrl === undefined ? {} : { sourceVideoUrl: referenceVideoUrl }),
          // 念法落盘前过一遍白名单：库里存了不存在的念法，界面就没东西可显示（不会让生成失败）。
          persona: resolvePersona(typeof input.persona === 'string' ? input.persona.trim() : ''),
          // 固定种子：同一张形象图配同一个种子，同一镜重跑才复现同一版画面（"是不是同一个人"由形象图锚定）。
          seed: Math.floor(Math.random() * 1_000_000),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        const list = files.digitalHumans.load()
        list.unshift(human)
        files.digitalHumans.save(list)
        writeOk(res, human)
      },
    },
    {
      m: 'POST',
      p: 'digital-humans/from-sheet',
      /**
       * 从一张人物拼图（或已经切好的多张角度图）**一步建成形象**。
       *
       * 为什么需要它：厂商按参考图**张数**切模式——1 张走 keyframe 把画面锁死，
       * ≥3 张才走 reference（只锁「是谁」，场景按提示词走）。而用户手里最常见的素材就是
       * **一张三视图/四视图拼图**（正面+侧面+背面，或加大头照）。让他自己去切成三张不现实，
       * 所以由产品代劳：拼图按 2×2 切开 → 落成形象的多角度参考图 → 内容创作里选它就能出镜。
       */
      h: async ({ res, body }) => {
        const input = (body ?? {}) as { name?: unknown, imageUrl?: unknown, images?: unknown }
        const name = typeof input.name === 'string' && input.name.trim() !== ''
          ? input.name.trim().slice(0, 30)
          : '我的形象'
        const uploadsDir = ensureUploadsDir(deps.dataRoot)
        // 已经是切好的多张角度图：直接用。
        const given = Array.isArray(input.images)
          ? (input.images as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim() !== '').slice(0, 8)
          : []
        let angles = given
        if (angles.length < 3) {
          const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : ''
          if (imageUrl === '') {
            writeFail(res, '请上传一张人物图：三视图/四视图拼图，或同一个人不同角度的多张图', 40000)
            return
          }
          // 同 splitSheetIntoAngles：URL 无扩展名，必须用 localAssetFile 解析。
          const srcPath = localAssetFile(deps, imageUrl)
          if (srcPath === '') { writeFail(res, '这张图读不出来（素材可能已被删除）', 40000); return }
          const size = await readImageSize(srcPath)
          if (size === null) { writeFail(res, '这张图读不出尺寸，无法切分', 40000); return }
          // 先按「人物之间的空白列」检测版面：横向三视图（3 格）与四宫格（2×2）都覆盖得住。
          // 硬编码 2×2 会把横向三视图切废——实测 720×960 的三视图切出来第一格是
          // 「正面那人的上半身 + 侧面那人的半个身子」，等于把用户素材切成了废图。
          const columns = await detectColumnBounds(srcPath)
          const halfW = Math.floor(size.width / 2)
          const halfH = Math.floor(size.height / 2)
          const regions = columns.length >= 2
            // 检测到并排的人物列：每列独占整高（横向三视图/四视图走这条）。
            ? columns.map(col => ({ x: col.x, y: 0, width: col.width, height: size.height }))
            // 检测不到空白列（四宫格拼图里人物可能上下也挨着）：退回 2×2。
            : [
                { x: 0, y: 0, width: halfW, height: halfH },
                { x: halfW, y: 0, width: halfW, height: halfH },
                { x: 0, y: halfH, width: halfW, height: halfH },
                { x: halfW, y: halfH, width: halfW, height: halfH },
              ]
          const cut: string[] = []
          for (let i = 0; i < regions.length; i += 1) {
            const outId = 'angle-' + randomUUID().slice(0, 8) + '-' + String(i + 1) + '.png'
            const outPath = join(uploadsDir, outId)
            const done = await cropImageRegion(srcPath, outPath, regions[i]!)
            if (done === '') continue
            // 同 splitSheetIntoAngles：不合规的宽高比会被厂商 400 拒掉。
            const padded = await padImageToMinAspect(done, join(uploadsDir, 'pad-' + outId))
            if (padded === '') continue
            const finalId = padded === done ? outId : 'pad-' + outId
            cut.push(registerAsset({ file: padded, id: finalId, mime: 'image/png', uploadsDir }))
          }
          // 切不出来（这张不是 2×2 拼图）就按单张用：一张也能建形象，只是出片会锁画面。
          angles = cut.length >= 3 ? cut : [imageUrl]
        }
        const human: ZyDigitalHuman = {
          id: uid('dh'),
          name,
          avatarUrl: angles[0]!,
          ...(angles.length >= 3 ? { images: angles } : {}),
          persona: resolvePersona(''),
          seed: Math.floor(Math.random() * 1_000_000),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        const list = files.digitalHumans.load()
        list.unshift(human)
        files.digitalHumans.save(list)
        writeOk(res, { human, angles: angles.length })
      },
    },
    {
      m: 'DELETE',
      p: 'digital-humans/:id',
      h: ({ res, params }) => {
        const list = files.digitalHumans.load()
        const kept = list.filter(item => item.id !== params.id)
        if (kept.length === list.length) { writeFail(res, '数字人不存在', 40404); return }
        files.digitalHumans.saveEmpty(kept)
        writeOk(res, { removed: list.length - kept.length })
      },
    },
    // ---- 长视频产出（通用工作流，任何业务共用）------------------------------
    {
      /**
       * 某一档位的稿件字数门槛：界面在用户点生成**之前**就把"要多少字"摆出来（DEF-108）。
       *
       * 为什么由服务端算：折算用的是所选音色的实测语速（各音色差 53%），
       * 前端自己按固定语速估一个数，就会与后端真正的门槛对不上——用户照提示写完仍被拒。
       *
       * 必须排在 `long-videos/:taskId` 之前：路由按顺序匹配，先注册的通配路由会把它吃掉
       * （实测：注册在后面时 GET 返回"任务不存在"）。
       */
      m: 'GET',
      p: 'long-videos/script-requirement',
      h: ({ res, query }) => {
        const producerKind = (query.get('producer') ?? '').trim()
        const producerRef = (query.get('producerRef') ?? '').trim()
        const productImageUrl = (query.get('productImageUrl') ?? '').trim()
        const targetSeconds = Math.max(1, Math.round(Number(query.get('targetSeconds') ?? '')) || 0)
        const producer = producerFor(producerKind, producerRef, productImageUrl)
        if ('error' in producer) { writeFail(res, producer.error, 40000); return }
        if (targetSeconds <= 0) { writeFail(res, '目标时长不合法', 40000); return }
        const pace = producer.charsPerSecond !== undefined && producer.charsPerSecond > 0
          ? producer.charsPerSecond
          : CHARS_PER_SECOND
        writeOk(res, {
          targetSeconds,
          requiredChars: minScriptChars(targetSeconds, pace),
          charsPerSecond: pace,
          writerPaceCharsPerSecond: CHARS_PER_SECOND,
          shots: planShotCount(targetSeconds),
        })
      },
    },
    {
      m: 'GET',
      p: 'long-videos/producers',
      h: ({ res }) => {
        writeOk(res, {
          list: [
            { kind: 'digital-human', name: '数字人口播', description: '用一个固定形象出镜口播，适合带货 IP。', needsHuman: true },
            {
              kind: 'vlog',
              name: '走动 VLOG',
              description: '同一位数字人在走动中说话，手持跟拍、场景随步伐变化；需要先在数字人形象库里选一个形象。',
              needsHuman: true,
            },
            {
              kind: 'short-talk',
              name: '口播短视频',
              description: '一条视频讲清一个点：近景为主、节奏快、开头 3 秒给结论；需要选一个数字人形象。',
              needsHuman: true,
            },
            {
              kind: 'unboxing',
              name: '开箱测评',
              description: '拆盒、上手、对比、给建议：俯拍手部与产品特写为主；需要选形象，建议再配一张产品图。',
              needsHuman: true,
            },
            {
              kind: 'tutorial',
              name: '步骤教程',
              description: '一步一步来，每镜一个步骤：俯拍手部与材料为主；需要选形象，建议再配一张产品图。',
              needsHuman: true,
            },
            { kind: 'scene', name: '场景呈现', description: '不出镜，每段由 AI 生成一个场景画面。', needsHuman: false },
            {
              kind: 'scene-seeding',
              name: '场景种草',
              description: '空镜 + 人物自然走过（不对镜头说话），旁白在画外；产品镜至少占一半。',
              // 画面里的人目前不是选定的形象（走的是 sceneProducer，参考图只带产品图，
              // 见 DEF-175）：所以这里如实标 false，别让用户以为选了就生效。
              needsHuman: false,
            },
          ],
        })
      },
    },
    {
      /**
       * 专业提示词增强：把用户写的大白话整理成有画面与人群维度的创作要求。
       *
       * 只增强文本、不建任务：用户看清楚增强结果、确认过后才去生成。
       * 大模型不可用时如实报错，不用模板糊一个假的"增强结果"。
       */
      m: 'POST',
      p: 'ai/reference/fourview',
      /**
       * 把一张人物四视图（正面 / 侧面 / 背面 / 大头照，2×2 拼图）切成四张独立图片。
       *
       * 为什么必须切：厂商按参考图**数量**决定模式——**1 张走 keyframe，画面被锁死在这一帧上**
       * （用户写的场景、光线、构图全部不生效），≥3 张才走 reference 只锁"是谁"。
       * 而普通用户手里只有一张人物建模图，让他自己准备三张是不现实的。
       * 切成四张之后，一张图就能满足 reference 模式，场景才真正按提示词走。
       */
      h: async ({ res, body }) => {
        const input = (body ?? {}) as { imageUrl?: unknown }
        const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : ''
        if (imageUrl === '') { writeFail(res, '先选一张四视图', 40000); return }
        const assetId = imageUrl.split('/').pop() ?? ''
        const uploadsDir = ensureUploadsDir(deps.dataRoot)
        const srcPath = join(uploadsDir, assetId)
        if (assetId === '' || !existsSync(srcPath)) { writeFail(res, '这张图读不出来（素材可能已被删除）', 40000); return }
        const size = await readImageSize(srcPath)
        if (size === null) { writeFail(res, '这张图读不出尺寸，无法切分', 40000); return }
        // 2×2 四宫格：左上/右上/左下/右下 —— 顺序即「正面 / 侧面 / 背面 / 大头照」的常见排布，
        // 界面按这个顺序展示，用户看得出来哪一格是哪一张，切错了可以重传。
        const halfW = Math.floor(size.width / 2)
        const halfH = Math.floor(size.height / 2)
        const regions = [
          { x: 0, y: 0, width: halfW, height: halfH },
          { x: halfW, y: 0, width: halfW, height: halfH },
          { x: 0, y: halfH, width: halfW, height: halfH },
          { x: halfW, y: halfH, width: halfW, height: halfH },
        ]
        const urls: string[] = []
        for (let i = 0; i < regions.length; i += 1) {
          const outId = 'fourview-' + randomUUID().slice(0, 8) + '-' + String(i + 1) + '.png'
          const outPath = join(uploadsDir, outId)
          const done = await cropImageRegion(srcPath, outPath, regions[i]!)
          if (done === '') continue
          urls.push(registerAsset({ file: outPath, id: outId, mime: 'image/png', uploadsDir }))
        }
        if (urls.length < 3) { writeFail(res, '切分失败：这张图可能不是四宫格拼图（需要 2×2 的四个人物角度）', 50000); return }
        writeOk(res, { images: urls })
      },
    },
    {
      m: 'POST',
      p: 'ai/prompt/enhance',
      h: async ({ res, body }) => {
        const input = (body ?? {}) as { prompt?: unknown, kind?: unknown, referenceCount?: unknown }
        const text = typeof input.prompt === 'string' ? input.prompt.trim() : ''
        if (text === '') { writeFail(res, '先写一句要做什么（一句话就够）', 40000); return }
        if (text.length > 500) { writeFail(res, '提示词太长了（最多 500 字）', 40000); return }
        // 内容创作的输入框要的是**画面描述**（直接喂给图片/视频模型），
        // 不是写给编剧的选题文档——用错口径会交回 700+ 字的编号清单，画面要素反被挤掉。
        // 图片与视频按各自的官方口径增强：图像按输入形态选结构（文生图 / 图生图 / 多图合成），
        // 视频走官方六段。kind 缺省按 video（老前端不带这个字段时的行为不变）。
        const kind = input.kind === 'image' ? 'image' as const : 'video' as const
        const referenceCount = typeof input.referenceCount === 'number' && Number.isFinite(input.referenceCount)
          ? Math.max(0, Math.floor(input.referenceCount))
          : 0
        const out = await enhanceVisualPrompt(text, p => completeWithModel(p, '提示词增强：画面', false), { kind, referenceCount })
        if (!out.ok) { writeFail(res, out.error, 50000); return }
        writeOk(res, { prompt: out.text })
      },
    },
    {
      m: 'POST',
      p: 'long-videos/enhance-topic',
      h: async ({ res, body }) => {
        const input = (body ?? {}) as { topic?: unknown }
        const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
        if (topic === '') { writeFail(res, '先写清楚要讲的产品与卖点', 40000); return }
        if (topic.length > 500) { writeFail(res, '产品与卖点太长了（最多 500 字）', 40000); return }
        const out = await enhanceSpokenTopic(topic, p => completeWithModel(p, '提示词增强：选题', false))
        if (!out.ok) { writeFail(res, out.error, 50000); return }
        writeOk(res, { topic: out.text })
      },
    },
    {
      m: 'GET',
      p: 'long-videos',
      h: ({ res }) => { writeOk(res, { list: files.longVideoTasks.load().slice(0, 50) }) },
    },
    {
      m: 'GET',
      p: 'ai/video-quota',
      /**
       * 今日已用 / 剩余的视频额度。
       *
       * **口径必须写清楚**：这是**本机任务记录**的累计（今天创建的任务，实测时长优先、没跑完用母时钟
       * 估算值），不是厂商侧的剩余额度——Agnes 官方没有额度查询接口，官方只给了"免费档每天 500 秒、
       * 每分钟真正执行 1 次"这两条硬事实。界面照实标注 source，不假装它是厂商返回的数。
       */
      h: ({ res }) => {
        const today = new Date().toISOString().slice(0, 10)
        let usedSeconds = 0
        let tasks = 0
        for (const task of files.longVideoTasks.load()) {
          if (String(task.createdAt ?? '').slice(0, 10) !== today) continue
          tasks += 1
          // 只算**真的出过片**的那部分：跑完的任务用成片实测秒数（actualSeconds），
          // 失败/中断的任务按"已跑成的镜数 × 5 秒"估（每镜 4~6 秒的口径）。
          // 不能拿目标时长或母时钟估算当消耗——实测第一次把它算成 631 秒，而其中一半是
          // 失败与中断的任务，用户会以为自己超额了（那是虚高，不是事实）。
          usedSeconds += task.actualSeconds !== undefined
            ? task.actualSeconds
            : (task.doneSegments ?? 0) * 5
        }
        const used = Math.round(usedSeconds)
        writeOk(res, {
          usedSecondsToday: used,
          dailyQuotaSeconds: VIDEO_DAILY_QUOTA_SECONDS,
          remainingSeconds: Math.max(0, VIDEO_DAILY_QUOTA_SECONDS - used),
          freeTierRpm: VIDEO_FREE_TIER_RPM,
          tasksToday: tasks,
          source: 'local-records',
        })
      },
    },
    {
      m: 'POST',
      p: 'long-videos',
      h: ({ res, body }) => {
        const input = (body ?? {}) as {
          producer?: unknown
          producerRef?: unknown
          topic?: unknown
          targetSeconds?: unknown
          resolution?: unknown
          aspectRatio?: unknown
          withSubtitles?: unknown
          productImageUrl?: unknown
          scriptText?: unknown
        }
        const producer = typeof input.producer === 'string' ? input.producer.trim() : ''
        // 定稿稿件（可选）：AI 智能体"写稿 → 出片"的交接件。给了它就按这份稿子出片，
        // 编排层不再另写一版——生成记录里看到的就是成片里念的那份（与内容创作页同一口径）。
        const scriptText = typeof input.scriptText === 'string' ? input.scriptText.trim().slice(0, 5000) : ''
        // 上限与前端输入框同一个数：低于它会把用户认真写的卖点静默截掉，写稿的原料就不够了（DEF-114）。
        const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, MAX_LONG_VIDEO_TOPIC_CHARS) : ''
        if (producer === '') { writeFail(res, '请先选择内容形式（数字人口播 / 走动 VLOG / 口播短视频 / 开箱测评 / 步骤教程 / 场景呈现）', 40000); return }
        if (topic === '') { writeFail(res, '请先填写要讲的产品与卖点', 40000); return }
        const started = startLongVideoTask({
          producer,
          ...(typeof input.producerRef === 'string' && input.producerRef !== '' ? { producerRef: input.producerRef } : {}),
          topic,
          // 长视频板块只做长片：低于下限的档位（属于「内容创作」的短视频）在这里抬到下限，
          // 避免旧链接、旧草稿或直接调接口把短视频时长带进这条分段生成的长片链路。
          // 下限是部署可变量（`BF_LONG_VIDEO_MIN_SECONDS`）：产品默认 90 秒；
          // 功能测试把它调小，这样测试跑的是**同一套编排**而不是"为了测试放宽产品口径"。
          targetSeconds: Math.min(300, Math.max(longVideoMinSeconds(), Math.round(Number(input.targetSeconds ?? 120)) || 120)),
          ...(typeof input.resolution === 'string' && input.resolution !== '' ? { resolution: input.resolution } : {}),
          ...(typeof input.aspectRatio === 'string' && input.aspectRatio !== '' ? { aspectRatio: input.aspectRatio } : {}),
          withSubtitles: input.withSubtitles !== false,
          // 可选：用户传了产品图就走"照着真实产品出画面"，没传就退化为不含任何文字的产品描述。
          ...(typeof input.productImageUrl === 'string' && input.productImageUrl.trim() !== ''
            ? { productImageUrl: input.productImageUrl.trim() }
            : {}),
          ...(scriptText === '' ? {} : { scriptText }),
        })
        if (!started.ok) { writeFail(res, started.error, 40000); return }
        writeOk(res, { taskId: started.taskId, estimate: started.estimate })
      },
    },
    {
      m: 'GET',
      p: 'long-videos/:taskId',
      h: ({ res, params }) => {
        const task = files.longVideoTasks.load().find(item => item.id === params.taskId)
        if (task === undefined) { writeFail(res, '任务不存在', 40404); return }
        writeOk(res, task)
      },
    },
    {
      /**
       * 删除一条长视频记录（生成记录列表里的「删除」）。
       *
       * 删的是**记录**：成片已经作为草稿进了内容库，删掉它会顺带毁掉那条草稿的视频，
       * 所以成片留着，只清工作目录与逐镜成片（见 {@link removeLongVideoArtifacts}）。
       *
       * 生成中的任务拒绝删除：那条记录还挂着一个正在跑的编排，删了它，逐镜写回的
       * `update()` 会找不到目标而静默丢弃——用户会看到"删掉了但还在后台跑"。
       * 想删就先等它跑完（失败的任务可以删）。
       */
      m: 'DELETE',
      p: 'long-videos/:taskId',
      h: ({ res, params }) => {
        const taskId = params.taskId ?? ''
        const tasks = files.longVideoTasks.load()
        const task = tasks.find(item => item.id === taskId)
        if (task === undefined) { writeFail(res, '记录不存在（可能已被删除）', 40404); return }
        if (task.status === 'generating') { writeFail(res, '这条还在生成中，等它跑完或中断之后再删', 40000); return }
        // 删掉最后一条记录时剩下的是空数组：空值守卫会拦下 save([])（那是防"读失败→空数组→覆盖"的
        // 事故护栏），而这次清空是用户显式删除，且上面已确认这条记录确实在列表里——走显式清空接口。
        files.longVideoTasks.saveEmpty(tasks.filter(item => item.id !== taskId))
        const removed = removeLongVideoArtifacts(deps.dataRoot, task)
        console.log('[LONG_VIDEO] 已删除记录 ' + taskId + '，清理中间产物 ' + String(removed) + ' 项')
        writeOk(res, { removed: 1 })
      },
    },
    {
      /**
       * 批量删除生成记录（记录列表的「批量管理 → 删除选中」）。
       *
       * 与单条删除同一条口径：**删记录不删成片**（成片已经作为草稿进了内容库），
       * 只清工作目录与逐镜成片。生成中的记录**跳过并如实报数**，而不是整批拒绝——
       * 用户选十条里有一条正在跑，剩下九条没道理跟着删不掉。
       *
       * @returns removed 实际删掉的条数；skippedGenerating 因为还在生成而跳过的条数；
       *   missing 已经不在盘上的条数（重复点击或另一处删过）。
       */
      m: 'DELETE',
      p: 'long-videos',
      h: ({ res, body }) => {
        const input = (body ?? {}) as { taskIds?: unknown }
        const wanted = Array.isArray(input.taskIds)
          ? input.taskIds.filter((id): id is string => typeof id === 'string' && id !== '')
          : []
        if (wanted.length === 0) { writeFail(res, '没有选中任何记录', 40000); return }
        const tasks = files.longVideoTasks.load()
        const doomed = new Set(wanted)
        let removed = 0
        let skippedGenerating = 0
        let missing = 0
        for (const id of wanted) {
          const task = tasks.find(item => item.id === id)
          if (task === undefined) { missing += 1; continue }
          if (task.status === 'generating') { skippedGenerating += 1; continue }
          removeLongVideoArtifacts(deps.dataRoot, task)
          removed += 1
        }
        // 同理：批量删掉全部记录时结果为空数组，必须走显式清空。
        if (removed > 0) files.longVideoTasks.saveEmpty(tasks.filter(item => !doomed.has(item.id) || item.status === 'generating'))
        console.log('[LONG_VIDEO] 批量删除记录：选中 ' + String(wanted.length) + ' 条，删除 ' + String(removed)
          + ' 条，生成中跳过 ' + String(skippedGenerating) + ' 条，已不存在 ' + String(missing) + ' 条')
        writeOk(res, { removed, skippedGenerating, missing })
      },
    },
    {
      /**
       * 重做某一镜：只重跑那一镜，随后整条自动重新拼接。
       *
       * 同步等待的理由：单独一镜的等待（1~5 分钟）比"提交后不知道什么时候好"更可接受，
       * 而重做之后成片必须真的更新——异步返回一个"已提交"而拼接失败，用户是看不出来的。
       */
      m: 'POST',
      p: 'long-videos/:taskId/shots/:index/redo',
      h: async ({ res, params }) => {
        const taskId = params.taskId ?? ''
        const index = Number(params.index)
        if (!Number.isInteger(index) || index < 0) { writeFail(res, '镜号不合法', 40000); return }
        const task = files.longVideoTasks.load().find(item => item.id === taskId)
        if (task === undefined) { writeFail(res, '任务不存在', 40404); return }
        const producer = producerFor(task.producer, task.producerRef, task.productImageUrl ?? '')
        if ('error' in producer) { writeFail(res, producer.error, 40000); return }
        const result = await redoShot(longVideoDeps(), taskId, index, producer)
        if (!result.ok) { writeFail(res, result.error, 50000); return }
        writeOk(res, { index, seconds: result.seconds })
      },
    },
    {
      /**
       * 按现有稿件再补写一轮（DEF-108 的"一键补写"落点）。
       *
       * 为什么做成独立一步而不是偷偷替用户重跑：补写会换掉稿件内容，用户必须看得见、能编辑，
       * 满意了再点"继续生成"。所以这里只扩写并落盘，不花一次厂商调用去出片。
       */
      m: 'POST',
      p: 'long-videos/:taskId/extend-script',
      h: async ({ res, params }) => {
        const taskId = params.taskId ?? ''
        const task = files.longVideoTasks.load().find(item => item.id === taskId)
        if (task === undefined) { writeFail(res, '任务不存在', 40404); return }
        const producer = producerFor(task.producer, task.producerRef, task.productImageUrl ?? '')
        if ('error' in producer) { writeFail(res, producer.error, 40000); return }
        const extended = await extendLongVideoScript(longVideoDeps(), taskId, producer)
        if (!extended.ok) { writeFail(res, extended.error, 50000); return }
        if (extended.chars < extended.required) {
          writeFail(res, '补写后仍只有 ' + String(extended.chars) + ' 字，不足 ' + String(extended.required) + ' 字；请删掉与卖点无关的句子，或把目标时长降下来', 40000)
          return
        }
        writeOk(res, { taskId, script: extended.text, chars: extended.chars, required: extended.required })
      },
    },
    {
      /**
       * 从断点继续：只跑还没跑成的镜，最后按镜头顺序重新拼整条。
       *
       * 为什么要有这条：一条 90 秒的片子是 18 镜、几次到几十次厂商调用。进程中断
       * （关软件、断电、应用重启）之后，已经花掉的那些镜**不能白花**——原先只有"整条重跑"
       * 一个出口，等于把已生成的部分全部丢掉。
       *
       * 与起任务同样的异步口径：一镜要 1~5 分钟，同步等必超时，所以立即回执、
       * 前端照旧按镜数轮询真实进度。
       */
      m: 'POST',
      p: 'long-videos/:taskId/resume',
      h: ({ res, params }) => {
        const taskId = params.taskId ?? ''
        const task = files.longVideoTasks.load().find(item => item.id === taskId)
        const blocked = resumeBlockedReason(task)
        if (blocked !== null) { writeFail(res, blocked, task === undefined ? 40404 : 40000); return }
        const running = task!
        const producer = producerFor(running.producer, running.producerRef, running.productImageUrl ?? '')
        if ('error' in producer) { writeFail(res, producer.error, 40000); return }
        const remaining = Math.max(0, running.shots!.length - resumeStartIndex(running))
        // 与起任务同一套计时口径（每镜 1~5 分钟）：续跑不该换一个算法。
        const calls = estimateLongVideo(remaining * 5, producer.charsPerSecond ?? CHARS_PER_SECOND)
        setTimeout(() => { void runLongVideoJob(longVideoDeps(), taskId, producer, { resume: true }) }, 300)
        // 关联的那条生成记录也要回到"生成中"：否则用户点了"断点继续"，卡片上仍是"生成失败"，
        // 以为没生效（生成记录与分段任务是一件事的两个视图）。
        const gens = files.generations.load()
        let touched = 0
        for (const gen of gens) {
          const linked = (gen.response as { longVideoTaskId?: unknown } | undefined)?.longVideoTaskId
          if (linked !== taskId) continue
          gen.status = 'generating'
          delete gen.errorMessage
          gen.updatedAt = nowIso()
          touched += 1
        }
        if (touched > 0) files.generations.save(gens)
        writeOk(res, { taskId, remaining, estimate: calls, linkedGenerations: touched })
      },
    },
    {
      /**
       * 停止一条正在生成的长视频任务（进度面板与生成记录里的「停止」）。
       *
       * 一镜要 1~5 分钟、一条 90 秒的片子是十几次厂商调用：没有这个出口时，用户发现选题
       * 写错了也只能眼看着额度被跑完（DEF-179）。停止**不丢已跑成的镜**——它们留在
       * `shotFiles` 里，想接着跑走「从断点继续」。
       */
      m: 'POST',
      p: 'long-videos/:taskId/stop',
      h: ({ res, params }) => {
        const taskId = params.taskId ?? ''
        const stopped = stopLongVideoTask(longVideoDeps(), taskId)
        if (!stopped) { writeFail(res, '这条任务不在生成中（可能已经跑完、已经停过或不存在）', 40000); return }
        console.log('[LONG_VIDEO] 已停止 ' + taskId)
        writeOk(res, { taskId, stopped: true })
      },
    },
  )

  appendChannelRoutes(deps, routes)
  appendContentRoutes(deps, routes)
  appendKnowledgeRoutes(deps, routes)
  appendKnowledgeDistillRoutes(deps, routes)
  // 经验升格为技能：路由已搬到 routes-skill-promotion.ts（api.ts 冻结增长，见 qa/verify-api-size.mjs），
  // 这里只注入模型能力——反回来 import 会形成循环依赖。
  appendSkillPromotionRoutes(deps, routes, {
    readStoredLlm,
    streamLlm: (prompt, llm) => streamLlmWithDeltas(prompt, undefined, llm, ''),
  })
  // 从历史补课：账本里更早的经验没有别的入口，只有当场复盘那一条是看不见它们的。
  routes.push({
    m: 'POST',
    p: 'knowledge/distill/backfill',
    h: async ({ res }) => {
      const knowledge = files.knowledge.load() as KnowledgeState
      const llm = readStoredLlm(deps.dataRoot)
      const result = await backfillSkillsFromHistory(deps.dataRoot, knowledge.distillations ?? [], llm, files.tasks.load())
      // 把"这条已经升格过"写回账本：否则下一次补课会把同一条再学一遍，技能目录里堆出重复文件。
      if (result.learned.length > 0) {
        const byId = new Map(result.learned.map(item => [item.id, item.path]))
        for (const record of knowledge.distillations ?? []) {
          const path = byId.get(record.id)
          if (path !== undefined) record.skillPath = path
        }
        files.knowledge.save(knowledge)
        // 与手动升格同一套 Curator：账本是事实源、目录是它的投影。
        curateSkillsByRole(dshHomeOf(deps.dataRoot), knowledge.distillations ?? [])
      }
      writeOk(res, { scanned: result.scanned, learned: result.learned.length, skipped: result.skipped, paths: result.learned.map(item => item.path) })
    },
  })
  // 稳定语境文件（`$DSH_HOME/AGENTS.md`）在建路由表时就写好——这一步发生在服务启动期，
  // 早于任何请求。产品规则与约束从"每轮拼提示词"改成"经官方上下文通道注入"之后，
  // 这份文件就是模型看到规则的唯一来源：等第一次助手对话才写，
  // 中间那些一次性生成/长视频/接待调用就会在没有规则的会话里跑。
  refreshAgentContext()
  return routes
}

/**
 * 远程访问被拦下时给远程浏览器看的那一页。
 *
 * 为什么要有页面而不是一行 JSON：用户多半是用手机浏览器打开的，
 * 一屏"需要什么、去哪拿"比一个 401 的 JSON 有用得多。
 *
 * @param title - 一句话说明出了什么事。
 * @param hint - 下一步该做什么。
 * @returns 一页最小 HTML。
 */
function remoteNoticePage(title: string, hint: string): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title></head>'
    + '<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;'
    + 'font:15px/1.7 system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:#f6f6f8;color:#1f2233">'
    + '<main style="max-width:26rem;padding:28px 24px;background:#fff;border-radius:16px;'
    + 'box-shadow:0 8px 30px rgba(20,20,40,.08)">'
    + '<h1 style="margin:0 0 10px;font-size:17px">' + title + '</h1>'
    + '<p style="margin:0;color:#5b6070">' + hint + '</p>'
    + '</main></body></html>'
}

/** 默认前端目录（相对本包安装布局推导，对齐 opc 的解析深度）。 */
function defaultFrontendDist(): string {
  return fileURLToPath(new URL('../../../project/bosom-friend-electron/dist', import.meta.url))
}

/**
 * 装载插件：注册 /bosom-friend/api REST 路由与 /bosom-friend 静态应用。
 * @param ctx - 携带 webServer、llm 服务的上下文。
 * @param config - 配置。
 */
export function apply(ctx: Context, config: Config): void {
  // **进程级兜底**：Node 15+ 对未处理的 Promise 拒绝（unhandledRejection）默认**直接终止进程**——
  // 于是一次厂商网络异常（ECONNRESET / 超时 / 网关抖动）就能把整个服务带走：
  // 用户界面上午还好好的、下午突然打不开，正在跑的任务全丢，日志里连一行崩溃痕迹都没有。
  // 实测 2026-09-28：服务在轮询厂商时报「厂商无响应（网络失败或超时）」之后进程直接消失；
  // 当天累计 48 次启动，其中多数是这类静默退出。
  // 这里兜住它：把原因记进日志、**不让进程退出**——真实的失败仍由各自的调用链如实回报给用户，
  // 但服务本身必须活着（它是整个 APP 的宿主）。
  process.on('unhandledRejection', reason => {
    console.error('[UNHANDLED_REJECTION] ' + String(reason instanceof Error ? reason.stack ?? reason.message : reason).slice(0, 800))
  })
  process.on('uncaughtException', error => {
    console.error('[UNCAUGHT_EXCEPTION] ' + String(error?.stack ?? error).slice(0, 800))
  })
  const dataRoot = config.dataRoot !== undefined && config.dataRoot !== ''
    ? config.dataRoot
    : join(homedir(), '.bosom-friend', 'bosom-friend')
  const store = openStore(dataRoot)
  // 内核运行日志：先接管 stderr，再装载任何业务逻辑。厂商 429 / 轮询超时 / 图片被拒这些行此前
  // 只进 SDK 客户端的内存环（最近 400 行），内核一死就再也看不到，现场只能靠猜（DEF-083）。
  // 目录由桌面主进程经 BF_LOG_DIR 注入（与主进程日志同目录，用户点一次"打开日志目录"就看全）；
  // 开发态与独立运行时回退到数据根 logs。
  const runtimeLog = installRuntimeLog({
    dir: process.env.BF_LOG_DIR !== undefined && process.env.BF_LOG_DIR.trim() !== ''
      ? process.env.BF_LOG_DIR.trim()
      : join(dataRoot, 'logs'),
  })
  runtimeLog.line('[boot] server 插件装载：内核运行日志=' + runtimeLog.path())
  // 账号库被写成空数组时留痕：账号清空是最高代价的误操作，留一份可追溯的调用栈。
  try {
    const accountsFile = store.files.accounts as unknown as { save: (value: unknown) => void }
    const originalSave = accountsFile.save.bind(accountsFile)
    accountsFile.save = (value: unknown): void => {
      if (Array.isArray(value) && value.length === 0) {
        const stack = new Error('empty accounts save').stack ?? ''
        try {
          appendFileSync(join(dataRoot, 'account-save-diag.log'), nowIso() + '\n' + stack + '\n\n', 'utf8')
        }
        catch {
          // 诊断写失败不影响保存。
        }
      }
      originalSave(value)
    }
  }
  catch {
    // 诊断包装失败不影响启动。
  }
  restoreAccountProfilesFromBackups(dataRoot, store.files)

  /** 兼容旧版：为历史生成任务补回分组并把结果写入草稿箱/素材库，避免前端永远空态。 */
  function backfillGenerationData(): void {
    const gens = store.files.generations.load()
    const contents = store.files.contents.load()
    const groups = store.files.materialGroups.load()
    let changedGenerations = false
    let changedContents = false
    let changedGroups = false
    const existingAssetUrls = new Set(contents.filter(item => item.kind === 'asset').map(item => item.url))
    for (const gen of gens) {
      if (gen.request === undefined) {
        gen.request = {
          groupId: 'mg-persist',
          kind: gen.response?.videoUrl ? 'video' : 'image-text',
          prompt: gen.response?.title ?? '',
          quantity: 1,
        }
        changedGenerations = true
      }
      const groupId = gen.request?.groupId || 'mg-persist'
      const response = gen.response
      if (typeof response !== 'object' || response === null) continue
      const imageUrls = Array.isArray(response.imageUrls)
        ? response.imageUrls
        : response.coverUrl
          ? [response.coverUrl]
          : []
      const videoUrl = response.videoUrl ?? ''
      if (imageUrls.length === 0 && videoUrl === '') continue
      if (contents.some(item => item.kind === 'draft' && item.metadata?.generationId === gen.id)) continue
      const id = uid('cnt')
      // DEF-266：原意是视频、但成片没出来时，不能静默把它当图文落草稿——用户会以为视频做好了。
      // gen.request 一定存在（上面刚补过），kind 是这条任务的原始意图。
      const intendedVideo = gen.request?.kind === 'video'
      const degradedToImages = intendedVideo && videoUrl === ''
      const createdPromotion: ZyContentRecord = {
        kind: 'draft',
        _id: id,
        id,
        groupId,
        title: resolveDraftTitle({ title: response.title, description: response.description, prompt: gen.request?.prompt }).title,
        desc: response.description?.slice(0, 5000) || '',
        coverUrl: imageUrls[0] ?? videoUrl,
        mediaList: [
          ...imageUrls.slice(0, 9).map(url => ({ type: 'img' as const, url, thumbUrl: url })),
          ...(videoUrl ? [{ type: 'video' as const, url: videoUrl, thumbUrl: imageUrls[0] ?? '' }] : []),
        ],
        type: videoUrl ? 'video' : 'image-text',
        status: 0,
        topics: response.topics ?? [],
        ...(Array.isArray(gen.request?.platforms) && gen.request.platforms.length > 0 ? { accountTypes: gen.request.platforms } : {}),
        ...(gen.request !== undefined ? { generationParams: gen.request } : {}),
        useCount: 0,
        createdAt: nowIso(),
        metadata: {
          generationId: gen.id,
          // 降级标记只进 metadata、不进 desc：desc 会被发布到平台，用户不会想让平台看到
          // 系统的内部说明；界面据此提示「这条原本要做视频，视频没生成成功」。
          ...(degradedToImages
            ? {
                degraded: 'video-to-image-text',
                degradedNote: '这条原本要做成视频，但视频生成没有成功，已按图文落草稿；图片可用，视频需要重新生成',
              }
            : {}),
        },
      }
      contents.unshift(createdPromotion)
      changedContents = true
      for (const media of createdPromotion.mediaList ?? []) {
        if (existingAssetUrls.has(media.url)) continue
        contents.unshift({
          kind: 'asset' as const,
          _id: uid('cnt'),
          userId: 'zy-user-001',
          groupId,
          materialGroupId: groupId,
          type: media.type,
          url: media.url,
          thumbUrl: media.thumbUrl ?? '',
          title: createdPromotion.title,
          desc: '',
          useCount: 0,
          metadata: { generationId: gen.id },
          createdAt: nowIso(),
        })
        existingAssetUrls.add(media.url)
        changedContents = true
      }
      const group = groups.find(item => item.id === groupId)
      if (group !== undefined) {
        group.mediaCount = contents.filter(item => item.kind === 'draft' && item.groupId === groupId).length
        group.updatedAt = nowIso()
        changedGroups = true
      }
    }
    if (changedGenerations) store.files.generations.save(gens)
    if (changedContents) store.files.contents.save(contents)
    if (changedGroups) store.files.materialGroups.save(groups)
  }
  backfillGenerationData()

  // DEF-271（2026-10-12）：**预热内核**。
  // 装机版上「手工皮具」类 11 条任务里 5 条报 `initialize timed out after 10000ms waiting for
  // dsh profile "bosom-friend-kernel"` —— 内核要加载 46 个工具与整棵插件树，冷启动经常超过
  // SDK 的 10 秒握手上限；不预热就必然把这份代价转嫁给用户的**第一次对话**（实测失败率 45%）。
  // 这里 fire-and-forget：不阻塞 server 启动，失败也只记一行日志（warmUp 内部吞掉异常）。
  void (async () => {
    try {
      const warm = createKernelClient()
      await warm.warmUp()
      await warm.close()
      console.log('[boot] 内核预热完成（DEF-271：首次对话不再等冷启动）')
    } catch (error) {
      // 预热失败不算启动失败：首次对话会照旧冷启动并如实报错。
      console.log('[boot] 内核预热跳过：' + String(error).slice(0, 200))
    }
  })()

  // 历史假成功归一：状态曾为 success 却没有真实图片/视频，或正文明确是
  // “大模型调用失败/未接入”的记录，必须改为 failed，不能继续欺骗用户。
  try {
    const gens = store.files.generations.load()
    let changed = false
    for (const gen of gens) {
      if (gen.status !== 'success' && gen.status !== 'failed')
        continue
      const response = gen.response as {
        imageUrls?: unknown
        videoUrl?: unknown
        coverUrl?: unknown
        description?: unknown
      } | undefined
      const hasImage = Array.isArray(response?.imageUrls) && response.imageUrls.length > 0
      const hasVideo = typeof response?.videoUrl === 'string' && response.videoUrl !== ''
      const hasCover = typeof response?.coverUrl === 'string' && response.coverUrl !== ''
      const description = typeof response?.description === 'string' ? response.description : ''
      const textFailed = description.includes('大模型调用失败') || description.includes('未接入任何大模型')
      const hasRealMedia = hasImage || hasVideo || hasCover
      const hasNonErrorText = description.trim() !== '' && !textFailed
      if (textFailed && hasRealMedia) {
        gen.status = 'partial'
        gen.errorMessage = '已完成图片/视频，但文字内容调用失败'
        gen.updatedAt = nowIso()
        changed = true
      }
      else if ((!hasRealMedia && !hasNonErrorText) || textFailed) {
        gen.status = 'failed'
        gen.errorMessage = textFailed
          ? '历史生成记录的大模型调用失败，已修正为失败状态'
          : '历史生成记录没有真实媒体文件，已修正为失败状态'
        gen.updatedAt = nowIso()
        changed = true
      }
    }
    if (changed)
      store.files.generations.save(gens)
  } catch {
    // 历史归一失败不影响启动，后续仍可按新链路产生正确状态
  }

  // 启动归一：历史占位昵称（如 “No name”）回退为平台显示名，账号列表不再出现假昵称。
  try {
    const accounts = store.files.accounts.load()
    let changed = false
    for (const account of accounts) {
      const cleaned = cleanPlatformNickname(account.nickname, account.type)
      if (cleaned !== account.nickname) {
        account.nickname = cleaned
        changed = true
      }
    }
    if (changed) store.files.accounts.save(accounts)
  } catch {
    // 昵称归一失败不影响启动
  }

  // 发布数据完整性修正：本地发布记录若标“成功”却没有平台作品 ID/链接，
  // 一律改为失败并写明原因，数据中心不再把无证据记录当成功作品。
  try {
    const records = store.files.records.load()
    let changed = false
    for (const rec of records) {
      const hasWorkEvidence = (typeof rec.platformWorkId === 'string' && rec.platformWorkId !== '')
        || (typeof rec.workLink === 'string' && rec.workLink !== '')
      if (rec.status === PUBLISH_RECORD_STATUS.PUBLISHED && rec.source !== 'platform-sync' && !hasWorkEvidence) {
        rec.status = PUBLISH_RECORD_STATUS.FAILED
        rec.errorMsg = '平台未返回作品链接，发布未确认成功（历史数据修正）'
        rec.updatedAt = nowIso()
        changed = true
      }
    }
    if (changed) store.files.records.save(records)
  } catch {
    // 发布数据修正失败不影响启动
  }

  // 平台引擎悬挂任务清理：等待超时的 starting 状态在服务重启后不可能由
  // 旧进程继续完成，必须改为失败并保留可读原因，避免前端永久轮询。
  try {
    for (const kind of ['interact', 'sync', 'publish']) {
      const root = join(dataRoot, 'platform-login', kind)
      if (!existsSync(root))
        continue
      for (const dirName of readdirSync(root, { withFileTypes: true })) {
        if (!dirName.isDirectory())
          continue
        const stateFile = join(root, dirName.name, 'state.json')
        if (!existsSync(stateFile))
          continue
        try {
          const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { status?: string; startedAt?: string }
          const startedAt = state.startedAt ? Date.parse(state.startedAt) : 0
          if ((state.status === 'starting' || state.status === 'uploading') && (Number.isNaN(startedAt) || Date.now() - startedAt > 5 * 60_000)) {
            writeDataJson(stateFile, {
              ...state,
              status: 'failed',
              error: '引擎任务在服务重启时被中断，请重新发起',
              finishedAt: nowIso(),
            })
          }
        }
        catch {
          // 状态文件损坏不影响启动
        }
      }
    }
  } catch {
    // 清理失败不影响启动
  }

  // 数据安全自动加固（零用户操作）：ACL 收紧 + 备份轮转 + 自检报告
  const securityReport: SecurityReport = securityHardening(dataRoot)

  /** 前缀处理器守卫：校验 Bearer token 是否为有效会话。 */
  function sessionValid(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const token = header.slice('Bearer '.length).trim()
    return token !== '' && store.files.sessions.load().some(s => tokenEquals(s.token, token))
  }

  const deps: Deps = {
    dataRoot,
    store,
    security: securityReport,
    kernelAi: config.kernelAi === true,
    media: () => ctx.get('media'),
  }
  // 启动恢复：上次进程中断遗留的「生成中」任务定格为失败，避免用户永远看到转圈
  /**
   * 生成任务停滞看门狗：服务不重启也要能收尾。
   *
   * generationRecovery 只在启动时收尾"上次进程中断"留下的记录；服务活着、任务却停滞
   * （厂商不回、媒体生成卡死）时，记录会永远停在 generating —— 现场实测卡了 38 分钟，
   * 用户一直看转圈，已经生成好的文案也拿不到（DEF-083）。这里每 60 秒扫一次，
   * 按任务类型预算判失败并保留已生成的文案。
   */
  const GENERATION_WATCHDOG_INTERVAL_MS = 60_000
  let generationWatchdog: ReturnType<typeof setInterval> | undefined

  function startGenerationWatchdog(): void {
    if (generationWatchdog !== undefined)
      return
    generationWatchdog = setInterval(() => {
      try {
        const list = store.files.generations.load() as unknown as GenerationRecord[]
        const stalled = markStalledGenerations(list, Date.now(), nowIso())
        if (stalled.length === 0)
          return
        store.files.generations.save(list as never)
        for (const gen of stalled) {
          runtimeLog.line('[generation] 停滞判失败 id=' + gen.id
            + ' kind=' + String(gen.request?.kind ?? '')
            + ' ' + String(gen.errorMessage ?? ''))
        }
      }
      catch (error) {
        runtimeLog.line('[generation] 看门狗扫描失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }, GENERATION_WATCHDOG_INTERVAL_MS)
    generationWatchdog.unref?.()
    runtimeLog.line('[generation] 停滞看门狗已启动，间隔ms=' + GENERATION_WATCHDOG_INTERVAL_MS)
  }

  const generationRecovery = (): void => {
    try {
      const gens = store.files.generations.load()
      let changed = false
      for (const gen of gens) {
        if (gen.status === 'generating') {
          gen.status = 'failed'
          gen.errorMessage = '上次生成被中断，请重新生成'
          gen.updatedAt = nowIso()
          changed = true
        }
      }
      if (changed) store.files.generations.save(gens)
    } catch {
      // 恢复失败不影响启动
    }
  }

  /**
   * 回收平台登录/互动任务目录。
   *
   * `platform-login/{interact,sessions,sync,daemon-jobs}` 每跑一次平台任务就多一个目录，
   * 从来没有回收过：实测一台机器 12 天堆到 4108 个目录 / 16432 个文件（37.5 MB）且只增不减。
   * 这些目录只服务于当次任务，任务结束即可回收，因此按「保留最近 2 天」清理；
   * 最近两天一律保留，避免删掉正在进行或刚刚失败的会话（用户可能正要重试）。
   *
   * @param root - 产品数据根。
   * @returns 本次回收的目录数。
   */
  function prunePlatformLoginTasks(root: string): number {
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000
    let removed = 0
    for (const kind of ['interact', 'sessions', 'sync', 'daemon-jobs']) {
      const dir = join(root, 'platform-login', kind)
      if (!existsSync(dir)) continue
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = join(dir, entry.name)
        try {
          if (statSync(full).mtimeMs >= cutoff) continue
          rmSync(full, { recursive: true, force: true })
          removed += 1
        } catch {
          // 目录被占用（worker 还在跑）不该拦住启动；下次启动再试。
        }
      }
    }
    return removed
  }
  generationRecovery()
  startGenerationWatchdog()
  // 长视频任务也要收尾：它的推进完全在进程内，进程一中断记录就永远停在「生成中」，
  // 用户既等不到成片，也点不了逐镜重做（重做对生成中的任务是拒绝的）。
  try {
    const recovered = recoverInterruptedLongVideoTasks({
      loadTasks: () => store.files.longVideoTasks.load(),
      saveTasks: tasks => { store.files.longVideoTasks.save(tasks) },
    })
    if (recovered.tasks > 0) {
      console.log('[BOSOM_FRIEND] 启动收尾：' + String(recovered.tasks) + ' 条被中断的长视频任务已定格为失败（其中已生成 '
        + String(recovered.readyShots) + ' 镜可从断点继续）')
    }
  } catch {
    // 收尾失败不影响启动：最坏情况仍是用户看到一条停在生成中的记录，下次启动再收。
  }
  prunePlatformLoginTasks(dataRoot)
  // 平台登录守护引擎默认懒加载：启动即预热会额外拉起 Python 守护与一个完整 Chrome，
  // 低配机器上会和内核冷启动抢内存/CPU。需要预热时显式设置 BF_WARM_ENGINE=1。
  if (process.env.BF_WARM_ENGINE === '1') ensureEngineDaemon(deps)
  // 7×24 评论/私信自动接待引擎：绑定账号即纳入真实平台轮询（前台监控页数据源）
  startReceptionEngine(deps)
  // 自动任务：三类事（待接待新增 / 发布失败 / 登录态失效）自动检查，发现即写进通知中心主动汇报。
  // **只查与报**——不发布、不删除、不花钱、不对外沟通（见 auto-tasks.ts 的拍板闸门）。
  startAutoTasks(deps)
  // 媒体留痕（D3）：能力面每完成一次厂商往返就报一条观察，产品写进同一个账本（ai-logs.json）。
  traceMediaObservations(ctx, store.files)
  const routes = buildRoutes(deps)
  // 排期恢复：定时器只活在进程内存里，服务一停（重启/升级/崩溃后拉起）就全丢，而记录仍是
  // 「已排期」。不在这里补装，用户排好的期永远不会发——界面看着排好了，到点什么都没有。
  // 与其它启动期动作一样，跑在装载阶段，早于任何请求。
  try { const swept = sweepStalePublishTasks({ dataRoot: deps.dataRoot, loadRecords: () => deps.store.files.records.load(), saveRecords: records => deps.store.files.records.save(records) }); if (swept.length > 0) runtimeLog.line('[boot] 悬挂发布回收：' + String(swept.length) + ' 条（' + swept.join(', ') + '）') } catch { /* DEF-304 悬挂回收失败不影响启动 */ }
  const scheduleResume = resumeScheduledPublishes(deps)
  if (scheduleResume.resumed > 0 || scheduleResume.missed > 0) {
    runtimeLog.line('[boot] 排期恢复：重新装上 ' + String(scheduleResume.resumed) + ' 条，停机期间错过 ' + String(scheduleResume.missed) + ' 条')
  }
  const server = ctx.get('webServer')!
  const disposers: (() => void)[] = []

  /**
   * 远程访问配置的内存副本：网关在每个请求上都要判一次，不能每个请求读一次文件。
   * 只在设置页保存时更新（写盘 + 更新这份副本），所以外部手改文件要重启才生效。
   */
  let remoteCfg: RemoteAccessConfig = readRemoteAccess(dataRoot)
  const saveRemoteCfg = (patch: Partial<RemoteAccessConfig>): RemoteAccessConfig => {
    remoteCfg = { ...remoteCfg, ...patch }
    writeRemoteAccess(dataRoot, remoteCfg)
    return remoteCfg
  }

  /**
   * 这次请求是不是从别的机器来的。
   *
   * 拿不到对端地址时**按本机处理**：那是没有网络对端的进程内通道（官方 Web Worker 隧道），
   * 不是"来源不明的外部请求"——把它当外部会把正常链路一起挡住。
   *
   * 回环地址要看第二眼：隧道进程（cloudflared / ngrok / frp）就跑在本机，它连的是
   * `127.0.0.1`，只看对端地址会把公网请求认成"坐在电脑前的人"，令牌形同虚设。
   * 所以回环请求再判两条：带隧道/代理的来源头，或 Host 不是本机地址，都算远程。
   *
   * @param req - 原始请求。
   * @returns true 表示来自本机以外的地址。
   */
  const isRemoteRequest = (req: IncomingMessage): boolean => {
    const address = req.socket?.remoteAddress
    if (address === undefined || address === '') return false
    if (!isLoopbackAddress(address)) return true
    return hasForwardedOrigin(req.headers) || !isLocalHostHeader(req.headers.host)
  }

  /**
   * 远程请求的令牌网关：返回 true 表示这次请求可以继续。
   *
   * 规则只有一条：**非本机请求必须带有效令牌**，且远程访问总开关是开着的。
   * 这台机器上装着用户的 API Key 与全部内容，默认不对外暴露是唯一安全的默认值。
   *
   * @param req - 原始请求。
   * @param url - 已解析的 URL（查询串里的 token 也算）。
   * @returns true 表示放行。
   */
  const remoteAllowed = (req: IncomingMessage, url: URL): boolean =>
    !isRemoteRequest(req) || (remoteCfg.enabled && remoteTokenMatches(req.headers, url.searchParams, remoteCfg.token))

  /**
   * 远程访问的当前状态（设置页要的全部事实一次给全）。
   *
   * 地址一律**带上令牌**：用户要的是"复制一条能在手机上打开的地址"，
   * 让他自己把令牌拼到 URL 后面，就是把最容易出错的一步留给他。
   *
   * @returns 开关、令牌、局域网地址、隧道状态与端口。
   */
  const remoteState = (): Record<string, unknown> => {
    const tunnel = tunnelStatus()
    const token = remoteCfg.token
    const withToken = (base: string): string => base + '?token=' + token
    return {
      enabled: remoteCfg.enabled,
      token,
      bindAll: remoteCfg.bindAll,
      tunnelCommand: remoteCfg.tunnelCommand,
      port: server.port,
      /** 当前实际监听地址（局域网可达要靠它变成 0.0.0.0，那需要重启）。 */
      bindHost: server.host,
      lanUrls: lanUrls(server.port).map(url => ({ url, urlWithToken: withToken(url) })),
      tunnel: {
        running: tunnel.running,
        url: tunnel.url,
        urlWithToken: tunnel.url === '' ? '' : withToken(tunnel.url + '/bosom-friend/'),
        provider: tunnel.provider,
        error: tunnel.error,
        log: tunnel.log,
      },
      cloudflared: findCloudflared() !== '',
    }
  }

  // 远程访问路由：它的处理器要用到 server（当前端口/监听地址）与内存里的配置副本，
  // 所以挂在 apply 里而不是 buildRoutes 里（后者拿不到这两样）。
  routes.push(
    {
      /** 读远程访问状态：开关、令牌、局域网地址、隧道状态。 */
      m: 'GET',
      p: 'remote-access',
      h: ({ res }) => { writeOk(res, remoteState()) },
    },
    {
      /**
       * 改远程访问配置。
       *
       * 关掉总开关时**顺手停掉隧道**：留着一条没人管的对外通道是最危险的半开状态
       * （用户以为已经关了，实际上外网还进得来）。
       */
      m: 'POST',
      p: 'remote-access',
      h: ({ res, body }) => {
        const input = (body ?? {}) as { enabled?: unknown, bindAll?: unknown, tunnelCommand?: unknown, rotateToken?: unknown }
        const patch: Partial<RemoteAccessConfig> = {}
        if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
        if (typeof input.bindAll === 'boolean') patch.bindAll = input.bindAll
        if (typeof input.tunnelCommand === 'string') patch.tunnelCommand = input.tunnelCommand.trim()
        if (input.rotateToken === true) patch.token = newRemoteToken()
        if (patch.enabled === false) stopTunnel()
        saveRemoteCfg(patch)
        writeOk(res, remoteState())
      },
    },
    {
      /** 起隧道：默认用探测到的 cloudflared，用户填了命令就用他的。 */
      m: 'POST',
      p: 'remote-access/tunnel/start',
      h: ({ res }) => {
        if (!remoteCfg.enabled) { writeFail(res, '先把「允许远程访问」打开，再起隧道', 40000); return }
        const started = startTunnel({ port: server.port, command: remoteCfg.tunnelCommand })
        if (!started.ok) { writeFail(res, started.error, 50000); return }
        writeOk(res, remoteState())
      },
    },
    {
      /** 停隧道。没在跑也返回成功：目标状态已经达成。 */
      m: 'POST',
      p: 'remote-access/tunnel/stop',
      h: ({ res }) => { stopTunnel(); writeOk(res, remoteState()) },
    },
  )

  disposers.push(server.register({
    kind: 'prefix',
    path: '/bosom-friend/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (handleCors(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
      // 远程访问网关：非本机请求必须带有效令牌（本机不受影响）。
      if (!remoteAllowed(req, url)) {
        writeFail(res, '这是远程请求，需要访问令牌：请在「设置 → 远程访问」里复制带令牌的地址', 40100)
        return
      }
      let pathname = url.pathname.replace(/^\/bosom-friend\/api/, '')
      const method = req.method ?? 'GET'
      // 前端三处前导斜杠路径会产生 api// 双斜杠（契约清单第12.7条）。
      pathname = pathname.replace(/\/{2,}/g, '/')
      if (pathname === '') pathname = '/'
      // 登录/注册为公开端点，其余全部要求有效会话；401 由前端 client.ts 静默接管并唤起登录框
      const publicPath = pathname.startsWith('/') ? pathname.slice(1) : pathname
      // 资产文件与分享链接由 <img>/外部访问直接读取（无法携带 Authorization 头），必须公开
      const isResourcePublic = publicPath.startsWith('assets/') || publicPath.startsWith('agent/tasks/shared/') || publicPath.startsWith('platform-login/qr/')
      if (sessionRequired(config.authEnabled !== false, publicPath, isResourcePublic, sessionValid(req))) {
        writeFail(res, '请先登录', 401)
        return
      }
      const match = matchRoute(routes, method, segsOf(pathname))
      if (match === undefined) {
        writeFail(res, 'no such endpoint: ' + method + ' ' + pathname, 40400)
        return
      }
      let body: unknown
      // 原生二进制直传（对象存储预签名语义）不按 JSON 解析，透传原始字节。
      const isRawUpload = pathname.includes('/assets/') && pathname.includes('/upload/')
      if (method !== 'GET' && method !== 'OPTIONS' && !isRawUpload) {
        try { body = await readBody(req) } catch (error) {
          if (error instanceof BodyTooLargeError) { writeFail(res, 'request body too large', 41300, 413); return }
          writeFail(res, 'invalid json body', 40000)
          return
        }
      }
      else if (isRawUpload) {
        // 直传同样受上限保护：无上限地把请求体读进内存，单个超大上传即可耗尽进程内存。
        const chunks: Buffer[] = []
        let rawSize = 0
        for await (const chunk of req) {
          rawSize += (chunk as Buffer).length
          if (rawSize > MAX_BODY_BYTES) {
            req.destroy()
            writeFail(res, 'request body too large', 41300, 413)
            return
          }
          chunks.push(chunk as Buffer)
        }
        body = Buffer.concat(chunks)
      }
      try {
        await match.route.h({ req, res, params: match.params, query: url.searchParams, body })
      }
      catch (error) {
        // 处理器抛错时宿主只回一个空体 400（packages/host/webserver 的 per-request failure 分支），
        // 用户看到的是"错误的请求"，原因（数据文件损坏、磁盘异常）全部丢失。
        // 这里如实回一个带原因的信封：数据读不出来时要让人看见为什么，而不是让人猜。
        const detail = error instanceof Error ? error.message : String(error)
        if (res.headersSent) res.end()
        else writeFail(res, '服务端处理失败：' + detail, 50000, 500)
      }
    },
  }))

  const distDir = config.frontendDist !== undefined && config.frontendDist !== ''
    ? config.frontendDist
    : defaultFrontendDist()
  // 免登录模式（authEnabled=false）：注入本地访客 token，前端免登录直达主页，
  // 避免打包产物在「登录页暂时屏蔽」期间出现空页/登录跳转死循环。
  const guestToken = config.authEnabled === false ? 'bf-local-guest-token' : undefined
  const perf = perfTier()
  const serveStatic = serveSpa({
    dist: distDir,
    backendBaseUrl: '/bosom-friend/api',
    perfTier: perf.tier,
    // 版本权威：桌面壳通过 BOSOM_FRIEND_VERSION 注入 app.getVersion()；
    // 未注入时（纯服务端调试）回退为 package.json 版本，绝不写死历史版本号。
    appVersion: resolveAppVersion(),
    ...(guestToken !== undefined ? { authToken: guestToken } : {}),
  })
  disposers.push(server.register({
    kind: 'prefix',
    path: '/bosom-friend',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      handleCors(req, res)
      const url = new URL(req.url ?? '/', 'http://x')
      const pathname = url.pathname
      // 远程访问网关：远程浏览器第一次用 ?token=xxx 打开页面，这里写下 Cookie，
      // 之后的页面资源、XHR、视频都由浏览器自动带上令牌，用户不必在每个地址后面粘一次。
      if (isRemoteRequest(req)) {
        if (!remoteCfg.enabled) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
          res.end(remoteNoticePage('远程访问没有开启',
            '这台机器默认只允许本机访问。要允许手机或别的电脑连上，请在「设置 → 远程访问」里打开它。'))
          return
        }
        if (!remoteTokenMatches(req.headers, url.searchParams, remoteCfg.token)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
          res.end(remoteNoticePage('需要访问令牌',
            '请在「设置 → 远程访问」里复制带令牌的完整地址（形如 …?token=…）再打开。'))
          return
        }
        if (url.searchParams.get('token') !== null) {
          res.setHeader('set-cookie', TOKEN_COOKIE + '=' + remoteCfg.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000')
        }
      }
      // 站点图标：dist 可能没有 favicon.ico，此时以 204 终结，消除浏览器 404 噪音。
      //
      // 判据是**剥掉挂载前缀之后**的路径：本处理器注册在 '/bosom-friend' 上，收到的 pathname
      // 仍带前缀（`/bosom-friend/favicon.ico`），拿 '/favicon.ico' 直接比永远不成立，该分支从未
      // 执行过——图标一路落到 serveSpa 变成 404。前端 index.html 声明的正是带前缀的路径。
      const assetPath = pathname.replace(/^\/bosom-friend/, '') || '/'
      if (assetPath === '/favicon.ico') {
        // Vite 把 public/ 原样投到 dist，图标通常落在 assets/ 下，两处都查。
        const favicon = [join(distDir, 'favicon.ico'), join(distDir, 'assets', 'favicon.ico')]
          .find(candidate => existsSync(candidate))
        if (favicon !== undefined) {
          // 站点图标改动后必须能立刻生效：此前不声明任何缓存头，浏览器按启发式规则长期沿用旧图标，
          // 换了图标签页却纹丝不动。带 ETag 的 no-cache = 可缓存但每次都回源校验。
          const iconStat = statSync(favicon)
          const iconTag = 'W/"' + iconStat.size.toString(16) + '-' + iconStat.mtimeMs.toString(16) + '"'
          // 条件请求要真的回 304：只写 ETag 不判 If-None-Match，每次都全量重发一个可能上百 KB 的 .ico。
          const iconHdrs = { 'content-type': 'image/x-icon', 'cache-control': 'no-cache', etag: iconTag }
          const iconMatches = String(req.headers['if-none-match'] ?? '') === iconTag
          res.writeHead(iconMatches ? 304 : 200, iconHdrs)
          if (iconMatches) res.end()
          else createReadStream(favicon).pipe(res)
        } else {
          res.writeHead(204)
          res.end()
        }
        return
      }
      serveStatic(assetPath, res, req)
    },
  }))

  ctx.effect(() => () => {
    stopReceptionEngine()
    stopAutoTasks()
    stopTrackedChildren()
    // 看门狗是插件自己起的定时器：卸载/热重载时必须一起停，否则重载一次就多一个扫描循环。
    if (generationWatchdog !== undefined) {
      clearInterval(generationWatchdog)
      generationWatchdog = undefined
    }
    // 隧道是"这台机器对外的门"：App 退出时把它一起关掉，绝不留一条没人管的对外通道。
    stopTunnel()
    for (const dispose of disposers.reverse()) dispose()
  }, 'bosom-friend-server-api routes')
}

export { buildRoutes, streamLlmWithDeltas, templateReply, uploadsMeta, runtime, sha8, segsOf, matchRoute }
export type { ApiCall, RouteDef, Deps }
