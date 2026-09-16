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
import { dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { PUBLISH_RECORD_STATUS, type ShareLinkRecord, type ZyContentRecord, type ZyDigitalHuman, type ZyDraftGenerationTask, type ZyLongVideoTask, type ZyMaterialMedia } from './types.ts'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { handleCors, mimeOfExt, readBody, serveSpa, writeFail, writeOk } from './http.ts'
import { DEFAULT_MATERIAL_GROUP_ID, filterGenerationArtifacts, openStore } from './store.ts'
import { securityHardening, type SecurityReport } from './security.ts'
import { generateNoteCover, ensureEngineDaemon, generateMediaCards, createSlideshow, cleanPlatformNickname, extractVideoThumbnail } from './platform-login.ts'
import { cropImageToSize, imagePricingRows, IMAGE_RATIOS, parseSize, pixelFor, ratioPromptHint } from './image-ratio.ts'
import { appendChannelRoutes } from './routes-channels.ts'
import { appendContentRoutes } from './routes-content.ts'
import { appendKnowledgeRoutes } from './routes-knowledge.ts'
import { appendKnowledgeDistillRoutes, buildKnowledgeContext, recordDistillation, type KnowledgeState } from './knowledge-distill.ts'
import { perfTier } from './perf.ts'
import { startReceptionEngine, stopReceptionEngine } from './reception-engine.ts'
import { stopTrackedChildren } from './platform-processes.ts'
import { createKernelClient } from './kernel-client.ts'
import { AGENT_RULES } from './agent-rules.ts'
import { changelogNotifications } from './changelog.ts'
import { DEFAULT_DIGITAL_HUMAN_VOICE, DIGITAL_HUMAN_VOICES, VOICE_PREVIEW_TEXT, resolveVoice } from './digital-human.ts'
import {
  clampSegmentSeconds,
  enhanceSpokenTopic,
  estimateSeconds,
  normalizeSpokenText,
  runLongVideoJob,
  splitScript,
} from './long-video.ts'
import type { LongVideoDeps, LongVideoProducer } from './long-video.ts'
import { buildStoryboardPrompt, fallbackShotPlan, parseShotPlan } from './storyboard.ts'
import type { ZyShot, ZyShotRef } from './types.ts'
import { probeDurationSeconds } from './ffmpeg.ts'
import { synthesizeSpeech } from './tts.ts'
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


function sha8(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function segsOf(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
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
 * 文案要求块：用户填写的文案要求（内含目标平台标题/正文/话题上限）作为最高优先级约束并入模型提示词。
 *
 * @param captionPrompt - 已解析的文案要求；空串表示用户未填写。
 * @returns 可直接拼接的提示词片段；未填写时为空串。
 */
function buildCaptionRequirementBlock(captionPrompt: string): string {
  return captionPrompt === '' ? '' : '\n\n【用户文案要求（最高优先级，必须逐条满足）】\n' + captionPrompt
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

/** 模型可见智能体规则：单一事实源见 agent-rules.ts（身份/原则/能力/工具/流程/输出/失败/合规/自检/红线）。 */
const AGENT_OPERATING_RULES = AGENT_RULES

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
): Promise<{ text: string; model?: string; timedOut?: boolean; error?: string }> {
  // 统一经官方内核（ADR-001）：把操作规则+用户需求送进官方内核，SSE 增量由内核客户端回调，
  // 再不经手 openai 兼容 /chat/completions（避免第二套会话状态，符合“DSH 唯一运行时”）。
  if (override) {
    // 路由 id 与模型都来自设置页的当前生效提供方；密钥由内核从 .credentials.yaml 解析。
    const activeProvider = override.providers?.find(item => item.id === override.activeProviderId) ?? override.providers?.[0]
    const kernel = createKernelClient({
      provider: activeProvider !== undefined ? kernelRouteId(activeProvider.id) : 'agnes',
      model: override.model,
      baseUrl: override.baseUrl,
      apiKey: override.apiKey,
    })
    try {
      const out = await kernel.prompt(AGENT_OPERATING_RULES + knowledgeBlock + '\n\n[用户需求]\n' + prompt, onDelta, shouldAbort)
      await kernel.close().catch(() => {})
      const text = (out.text || '').trim()
      return text !== ''
        ? { text, model: override.model, ...(out.error ? { error: out.error } : {}) }
        : { text: '', ...(out.error ? { error: out.error } : {}) }
    } catch (error) {
      return { text: '', error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { text: '' }
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

/** 从模型回复中提取可直接发布的小红书标题与正文，剥离操作说明和 Markdown 装饰。 */
function extractPublishContent(text: string): { title: string; body: string } {
  const titleMatch = text.match(/(?:\*\*)?(?:视频|图文|笔记)?\s*(?:标题|Title)\s*[：:]\s*\*?\s*\n?\s*([^\n]+)/i)
  const title = titleMatch?.[1]?.replace(/[*_>`]/g, '').trim() ?? ''
  const bodyMatch = text.match(/(?:\*\*)?(?:视频|图文|笔记)?\s*(?:正文|内容|文案)\s*[：:]\s*\*?\s*\n?/i)
  let body = ''
  if (bodyMatch?.index != null) {
    const start = bodyMatch.index + bodyMatch[0].length
    const after = text.slice(start)
    const endMatch = after.search(/\n\s*(?:\*\*)?(?:封面|话题|标签|同步账号|前端动作卡片|AI客服|AI 客服)[^\n]*[：:]?/)
    body = (endMatch >= 0 ? after.slice(0, endMatch) : after)
      .replace(/\n\s*[-—–]{3,}\s*\n[\s\S]*$/g, '')
      .replace(/[*_>`]/g, '')
      .trim()
  }
  return {
    title: title.slice(0, 30),
    body: body.slice(0, 5000),
  }
}

/** 明确要求把内容发布出去的说法。 */
const PUBLISH_REQUEST = /(发布|发出去|发到|发去|发一条|发个|发一篇|上传到|投稿|同步到)/

/**
 * 只是在打听发布相关的事，并不是在要求发布：命中这些说法一律不算发布指令。
 * 少了这道排除，「帮我看看发布记录」「发布频率怎么设置」都会被当成发布命令。
 */
const PUBLISH_TOPIC = /(发布日历|发布记录|发布数据|发布时间|发布规则|发布频率|发布失败|发布列表|发布历史|发布计划|发布任务|发布状态|发布效果|发布渠道|发布设置)/

/** 用户明确说了先别发：否定式说法不能被当成发布要求（"先写文案，先不要发布"）。 */
const PUBLISH_NEGATION = /(不要发布|不发布|先别发|别发布|不用发布|不需要发布|暂不发布|先不发布|不要发|先别发布)/

/**
 * 判定用户这一句话是否明确要求把内容发布出去。
 *
 * 发布是对外且不可撤销的动作，默认不做：跟随模式下前端会自动执行「去发布」动作卡，
 * 没有这道判定，用户只是想写篇文案，成品就已经被发到平台上了。
 * 因此只认用户亲口说出的发布措辞，创作类请求（写、生成、做个脚本）一律不算。
 *
 * @param prompt - 用户这一轮的原始输入。
 * @returns true 表示用户明确要求发布；false 表示只创作、不发布。
 */
export function detectPublishIntent(prompt: string): boolean {
  return PUBLISH_REQUEST.test(prompt) && !PUBLISH_TOPIC.test(prompt) && !PUBLISH_NEGATION.test(prompt)
}

/**
 * Agnes 视频生成模式与媒体字段：按引用图张数落到厂商自己的三种模式。
 *
 * - 0 张：`text`，纯文生视频；
 * - 1 张：`keyframe` + `first_frame`，成片首帧就是用户给的那张图（"用图片生成视频"最贴近预期的解法）；
 * - 2 张：`keyframe` + 首尾帧，在两张图之间过渡；
 * - 3 张及以上：`reference` + `images`，作为内容/风格参考（Flash 单次上限 5 张，超出按前 5 张截断）。
 *
 * 单图走 `keyframe` 而不是 `reference`：厂商文档明确 `reference` 只做参考、成片可能重新构图，
 * 用户拿一张图来生成视频时，构图对不上就等于白给。
 *
 * @param images - 已解析成厂商可读取值（公网地址或 Data URI）的引用图。
 * @returns 直接并入创建任务请求体的模式字段。
 */
export function agnesVideoModeFields(images: string[]): Record<string, unknown> {
  if (images.length === 0) return { mode: 'text' }
  if (images.length === 1) return { mode: 'keyframe', first_frame: images[0] }
  if (images.length === 2) return { mode: 'keyframe', first_frame: images[0], last_frame: images[1] }
  return { mode: 'reference', images: images.slice(0, 5) }
}

/**
 * Agnes 数字人口播参数：一张形象图 + 一段配音 + 固定种子。
 *
 * 走 `reference` 模式而不是 `keyframe`：口播要的是"这个人照着我给的音频说话"，
 * 参考模式才吃音频；首帧模式只吃图片，出的是无声的画面动效。
 * 音频与图片的数量上限来自厂商文档（Flash 图片 ≤5、音频 ≤3），超出按前几张截断。
 *
 * @param input - 已解析成厂商可读取值的形象图、音频与随机种子。
 * @returns 直接并入创建任务请求体的模式字段。
 */
export function agnesTalkingHeadFields(input: { images: string[], audios: string[], seed: number }): Record<string, unknown> {
  return {
    mode: 'reference',
    images: input.images.slice(0, 5),
    audios: input.audios.slice(0, 3),
    seed: input.seed,
  }
}

// ---------------------------------------------------------------------------
// 领域路由表
// ---------------------------------------------------------------------------

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
  /** 内置提供方不可删除（如 DeepSeek）。 */
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

/** 从请求体提取合法覆盖（缺 apiKey/baseUrl 视为未配置）。 */
export function parseLlmOverride(input: unknown): LlmOverride | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const o = input as Record<string, unknown>
  const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : ''
  const model = typeof o.model === 'string' ? o.model.trim() : ''
  if (!/^https?:\/\//.test(baseUrl) || apiKey === '' || model === '') return undefined
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
  return {
    baseUrl,
    apiKey,
    model,
    ...(displayName !== '' ? { displayName } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(activeProviderId !== '' ? { activeProviderId } : {}),
    ...(protocol !== '' ? { protocol } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(Object.keys(modelLabels).length > 0 ? { modelLabels } : {}),
    ...(image.model !== '' ? { imageBaseUrl: image.baseUrl || baseUrl, imageApiKey: image.apiKey || apiKey, imageModel: image.model } : {}),
    ...(video.model !== '' ? { videoBaseUrl: video.baseUrl || baseUrl, videoApiKey: video.apiKey || apiKey, videoModel: video.model } : {}),
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
 * 内核模型路由 id：设置页里的提供方 id 映射到 DSH `llm-pi-ai` 命名空间下的路由名。
 *
 * agnes 沿用内核补丁里已有的路由；其余加 `bf-` 前缀，避免与内置适配器（如 llm-deepseek）
 * 的路由重名。路由名必须满足 pi-ai 的标识符规则（小写字母开头、连字符分段）。
 *
 * @param providerId - 设置页里的提供方 id。
 * @returns 内核可用的路由 id。
 */
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
 * 把设置页的模型配置写进 DSH 的用户设置与凭据文档，让内核真正使用这些提供方。
 *
 * 只替换 `settings.yaml` 里的 `llm-pi-ai:` 顶层段，其它命名空间原样保留；
 * 凭据文档写 `version: 1` + `refs`，密钥按路由引用名存放。
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

  const settingsPath = join(dshHome, 'settings.yaml')
  try {
    const existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    // 逐行定位 llm-pi-ai 顶层段：段内是缩进行与空行，遇到下一个顶层键即结束。
    // （不用正则的 \z —— JS 不支持，之前因此把新段追加成重复键。）
    const lines = existing.split(/\r?\n/)
    const start = lines.findIndex(line => /^llm-pi-ai:\s*$/.test(line))
    let next: string
    if (start === -1) {
      next = (existing.trim() === '' ? '' : existing.replace(/\s*$/, '') + '\n') + sectionLines.join('\n') + '\n'
    }
    else {
      let end = start + 1
      while (end < lines.length) {
        const line = lines[end]
        if (line === undefined || (line.trim() !== '' && !/^\s/.test(line))) break
        end += 1
      }
      next = [...lines.slice(0, start), ...sectionLines, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
      if (!next.endsWith('\n')) next += '\n'
    }
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(settingsPath, next, 'utf8')

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
      writeFileSync(credentialsPath, 'version: 1\n\nrefs:\n' + refs.join('\n') + '\n', 'utf8')
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
    writeFileSync(join(dataRoot, 'llm-user.json'), JSON.stringify(cfg ?? { baseUrl: '', apiKey: '', model: '' }, null, 2), 'utf8')
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
}

const uploadsMeta = new Map<string, string>()

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
    if (alive.length !== links.length) files.shareLinks.save(alive)
    return links.find(item => item.token === token)
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
      files.tasks.save(kept)
      files.shareLinks.save(files.shareLinks.load().filter(link => !ids.has(link.taskId)))
    }
    return removed
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
    const session = files.sessions.load().find(item => item.token === token)
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
        files.users.save(users)
        files.sessions.save(files.sessions.load().filter(s => s.userId !== user.id || s.token === bearerToken(req)))
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
        const params = body as { prompt?: unknown; taskId?: unknown; llm?: unknown }
        const promptText = extractPrompt(params.prompt)
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
        res.on('close', () => { streamClosed = true })
        const safeSse = (payload: Record<string, unknown>): void => {
          if (streamClosed) return
          try { sse(res, payload) } catch { streamClosed = true }
        }

        safeSse({ type: 'init', taskId: task.id, sessionId: task.id })

        const continuation = existing && task.messages.some(m => m.type === 'assistant')
          ? '（这是同一话题的继续，请接着上文自然延续，不要重新开场。）'
          : ''
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

        // 仅用户自己的钥匙（BYOK）：未配置 → 模板兜底 + 指引（系统不内置任何模型）
        const llmOut = llmOverride
          ? await streamLlmWithDeltas(promptText + continuation, emitDelta, llmOverride, '', () => control.aborted)
          : { text: '' }
        let fullText = ''
        if (!llmOverride) {
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

        // 智能体“动手”入口：识别内容创作/发布意图，生成可预览封面并返回发布动作卡片。
        const wantsAction = /(小红书|抖音|发布|创作|生成|种草|笔记)/i.test(promptText)
        // 发布闸门：这一句话里没有明确的发布指令，就只交付内容，不准备发布素材、不给发布入口。
        // 跟随模式会自动执行动作卡，少了这道闸等于智能体替用户按了发布。
        const wantsPublish = detectPublishIntent(promptText)
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
        else if (wantsAction && wantsPublish && !modelRefused && !modelFailed && !control.aborted) {
          const marker = ['📝 小红书笔记文案', '小红书笔记文案', '### 📝 小红书笔记文案', '【正文】']
            .find(token => fullText.includes(token))
          const actionableText = marker === undefined ? fullText : fullText.slice(fullText.indexOf(marker))
          const cleanText = actionableText
            .replace(/```/g, '')
            .replace(/[*_#>`]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
          const parsed = extractPublishContent(fullText)
          const titleFromExam = /《(.+?)》/.exec(promptText)?.[1] || promptText.replace(/\s+/g, ' ').slice(0, 30)
          const agentTitle = (parsed.title || titleFromExam).slice(0, 30)
          const agentBody = parsed.body || cleanText
          const agentSubtitle = agentBody.slice(0, 40)
          const cover = await generateNoteCover(deps, agentTitle, agentSubtitle, 1)
          if (!cover.ok)
            log('agent_warning', 'AI 动作封面生成失败：' + cover.error)
          const mediaUrl = cover.ok ? (cover.urls[0] ?? '') : ''
          const hashtags = Array.from(actionableText.matchAll(/#([^\s#，。]+)/g), match => match[1])
          const tags = Array.from(new Set(hashtags)).slice(0, 10)
          const wantsVideo = /(抖音|视频)/i.test(promptText)
          let publishReady = true
          let agentMedia: Array<{ type: 'image' | 'VIDEO'; url: string; coverUrl?: string }> = []
          if (mediaUrl !== '') {
            agentMedia.push({ type: 'image', url: mediaUrl, coverUrl: mediaUrl })
          }
          if (wantsVideo) {
            const videoMedia = await generateAgentVideo(deps, promptText)
            if (videoMedia === null) {
              log('agent_warning', '抖音视频素材生成失败，已阻止发布动作卡')
              publishReady = false
            }
            else {
              agentMedia = [{ type: 'VIDEO', url: videoMedia.url, coverUrl: videoMedia.coverUrl }]
            }
          }
          if (publishReady) {
            actionable = {
              type: 'fullContent',
              action: 'navigateToPublish',
              platform: promptText.includes('抖音') ? 'douyin' : 'xhs',
              title: agentTitle,
              description: agentBody,
              tags,
              medias: agentMedia,
            }
          }
          else {
            actionNote = '\n\n> （本次视频素材生成未完成，暂未提供「去发布」按钮；可稍后重试，或到创作页手动上传素材后发布。）'
          }
        }
        // 创作意图但没说发布：只交付正文，并如实告诉用户发布入口从哪来。
        // 这里不生成封面/视频素材，避免"用户没要发布却先花掉一次视频生成额度"。
        else if (wantsAction && !wantsPublish && !modelRefused && !modelFailed && !control.aborted) {
          actionNote = '\n\n> （内容已生成，尚未发布。需要发布时回一句「发布到抖音」或「发布到小红书」，我再准备素材并给出「去发布」入口。）'
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
          createdAt: nowIso(),
        })
        task.status = control.aborted ? 'aborted' : 'completed'
        task.updatedAt = nowIso()

        safeSse({
          type: 'result',
          data: {
            content: fullText,
            ...(actionable === undefined ? {} : { result: [actionable] }),
          },
          sessionId: task.id,
          taskId: task.id,
          model: usedModel,
        })
        safeSse({ type: 'done', taskId: task.id })

        log('chat', promptText)
        files.tasks.save(tasks)
        inFlightAgentTasks.delete(task.id)
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
        const publicTask = { ...task, messages: task.messages.filter(m => m.type === 'assistant' || m.type === 'user') }
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
        writeOk(res, task)
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
        writeOk(res, [
          { name: 'deepseek-chat', description: 'DeepSeek V3 通用对话', logo: '', channel: 'deepseek', scenes: ['comment', 'web'], inputModalities: ['text'], outputModalities: ['text'], pricing: {}, fixedImagePricing: [], tags: ['推荐'], mainTag: true },
          { name: 'deepseek-reasoner', description: 'DeepSeek R1 推理增强', logo: '', channel: 'deepseek', scenes: ['web'], inputModalities: ['text'], outputModalities: ['text'], pricing: {}, fixedImagePricing: [], tags: [], mainTag: false },
        ])
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
          providers: rawProviders.map((item) => {
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
          }),
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
            const models = Array.isArray(entry.models)
              ? entry.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim())
              : []
            return [{
              id,
              displayName: typeof entry.displayName === 'string' && entry.displayName.trim() !== '' ? entry.displayName.trim() : id,
              ...(entry.builtin === true ? { builtin: true } : {}),
              baseUrl: entryBaseUrl,
              apiKey: typed !== '' ? typed : (priorKey.get(id) ?? (entryBaseUrl !== '' && entryBaseUrl === legacyBaseUrl ? legacyKey : '')),
              ...(typeof entry.protocol === 'string' && entry.protocol.trim() !== '' ? { protocol: entry.protocol.trim() } : {}),
              ...(models.length > 0 ? { models } : {}),
              ...(typeof entry.modelLabels === 'object' && entry.modelLabels !== null ? { modelLabels: entry.modelLabels as Record<string, string> } : {}),
              ...(typeof entry.modelOptions === 'object' && entry.modelOptions !== null ? { modelOptions: entry.modelOptions as Record<string, LlmModelOption> } : {}),
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
          const next: Record<string, unknown> = {
            baseUrl: active?.baseUrl ?? '',
            apiKey: active?.apiKey ?? '',
            model: active?.models?.[0] ?? '',
            ...(active?.displayName !== undefined ? { displayName: active.displayName } : {}),
            ...(active?.protocol !== undefined ? { protocol: active.protocol } : {}),
            ...(active?.models !== undefined ? { models: active.models } : {}),
            ...(active?.modelLabels !== undefined ? { modelLabels: active.modelLabels } : {}),
            ...(keepImage ? { imageBaseUrl: existing?.imageBaseUrl ?? '', imageApiKey: existing?.imageApiKey ?? '', imageModel: existing?.imageModel ?? '' } : {}),
            ...(image.model !== undefined ? { imageBaseUrl: imageChannel.baseUrl, imageApiKey: imageChannel.apiKey, imageModel: image.model } : {}),
            ...(keepVideo ? { videoBaseUrl: existing?.videoBaseUrl ?? '', videoApiKey: existing?.videoApiKey ?? '', videoModel: existing?.videoModel ?? '' } : {}),
            ...(video.model !== undefined ? { videoBaseUrl: videoChannel.baseUrl, videoApiKey: videoChannel.apiKey, videoModel: video.model } : {}),
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
      m: 'POST',
      p: 'ai/chat',
      h: async ({ res, body }) => {
        const params = body as { messages?: { role: string; content: string }[]; llm?: unknown }
        const lastUser = [...params.messages ?? [].values()].reverse().find(m => m.role === 'user')
        const llmOverride = parseLlmOverride(params.llm) ?? readStoredLlm(deps.dataRoot)
        let llmOut: { text: string; model?: string } = { text: '' }
        // 知识库注入：对话同样先检索知识笔记，命中即进上下文（对话与生成共用一条检索链路）。
        const chatKnowledge = buildKnowledgeContext(files.knowledge.load() as KnowledgeState, lastUser?.content ?? '')
        if (deps.kernelAi === true) {
          const kernel = createKernelClient(llmOverride === undefined ? undefined : {
            provider: 'agnes',
            model: llmOverride.model,
            baseUrl: llmOverride.baseUrl,
            apiKey: llmOverride.apiKey,
          })
          const out = await kernel.prompt(AGENT_OPERATING_RULES + chatKnowledge.block + '\n\n[用户需求]\n' + (lastUser?.content ?? ''))
          await kernel.close()
          llmOut = out.error === undefined ? { text: out.text, model: 'dsh-kernel' } : { text: '' }
        } else if (llmOverride) {
          llmOut = await streamLlmWithDeltas(lastUser?.content ?? '', undefined, llmOverride, chatKnowledge.block)
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
        // 图片档位与视频一致（720p/1080p），成品像素由「档位 + 画幅」派生：
        // 定价行一一对应，前端切比例后下拉不会出现别家的尺寸（P-012/P-013）。
        const imageModels: unknown[] = [{
          model: 'zy-template-image',
          displayName: 'Bosom Friend图文模板',
          pricing: imagePricingRows(),
          supportedAspectRatios: IMAGE_RATIOS,
          maxInputImages: 9,
          styles: ['写实', '插画', '水彩', '油画', '卡通', '赛博朋克', '电影感', '极简'],
          tags: [],
        }]
        if (userCfg?.imageModel) {
          imageModels.unshift({
            model: userCfg.imageModel,
            displayName: `${userCfg.imageModel}（用户模型）`,
            pricing: imagePricingRows(),
            supportedAspectRatios: IMAGE_RATIOS,
            maxInputImages: 9,
            styles: ['写实', '插画', '水彩', '油画', '卡通', '赛博朋克', '电影感', '极简'],
            tags: ['user'],
          })
        }
        const videoModels: unknown[] = [{
          name: 'zy-template-video',
          description: 'Bosom Friend视频脚本模板',
          channel: 'local',
          creditsScope: 'general',
          modes: ['text2video', 'multi-ref', 'video2video'],
          resolutions: ['720p', '1080p'],
          durations: [5, 10, 15, 30, 60, 120, 180],
          maxInputImages: 9,
          aspectRatios: ['1:1', '4:3', '3:4', '9:16', '16:9'],
          inputConstraints: {
            images: { maxCount: 9 },
            videos: { maxCount: 1, maxDuration: 180, maxTotalDuration: 180 },
            audios: { maxCount: 1, maxDuration: 180, maxTotalDuration: 180 },
          },
          tags: [],
          styles: ['口播实拍', '电影感', '快节奏混剪', '叙事旅行', '产品大片', '生活纪录'],
          defaults: { resolution: '720p', aspectRatio: '9:16', duration: 15 },
          pricing: [
            ...['720p', '1080p'].flatMap(resolution =>
              [5, 10, 15, 30, 60, 120, 180].flatMap(duration =>
                ['1:1', '4:3', '3:4', '9:16', '16:9'].map(aspectRatio => ({
                  duration, price: 0, mode: 'text2video', resolution, aspectRatio,
                }))
              )
            ),
          ],
        }]
        if (userCfg?.videoModel) {
          videoModels.unshift({
            name: userCfg.videoModel,
            description: `${userCfg.videoModel}（用户模型）`,
            channel: 'user',
            creditsScope: 'general',
            modes: ['text2video'],
            resolutions: ['720p', '1080p'],
            durations: [4, 5, 6, 8, 10, 12],
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
        writeOk(res, files.generations.load().filter(g => want.includes(g.id)))
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
        files.generations.save(next)
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
          files.generations.save(list)
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
        writeOk(res, { page, pageSize, totalPages: Math.max(1, Math.ceil(all.length / pageSize)), total: all.length, list: all.slice((page - 1) * pageSize, page * pageSize) })
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
   */
  function buildLongVideoScript(topic: string, duration: number, resolution: string, aspectRatio: string, captionPrompt: string) {
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
    return {
      title: topic + '｜抖音长视频分镜（' + duration + ' 秒 · ' + resolution + ' · ' + aspectRatio + '）',
      description: '已生成 ' + segments + ' 段分镜脚本，总时长 ' + Math.round(duration / 60) + ' 分钟；可配合已上传的参考视频/图片素材按分镜剪辑合成。'
        + (captionPrompt === '' ? '' : '\n\n【用户文案要求（本地模板未代写文案，落稿时必须逐条满足）】\n' + captionPrompt),
      longVideo: { duration, resolution, aspectRatio, segments: shots },
      topics: ['#干货', '#长视频', '#' + topic.slice(0, 6)],
    }
  }
  function createDraftGeneration(d: Deps, body: unknown, kind: 'video' | 'image-text'): { taskIds: string[] } {
    const params = body as Record<string, unknown>
    const quantity = Math.max(1, Math.min(10, Number(params.quantity ?? 1) || 1))
    // 生成任务记录必须完整保存本次请求的每一项设置（模型/文案要求/风格/参考素材/目标平台等），
    // 刷新后 GET 回读与生成详情要能还原用户提交时的参数。
    const userPrompt = extractPrompt(params.prompt).slice(0, 500)
    const groupId = typeof params.groupId === 'string' && params.groupId !== '' ? params.groupId : DEFAULT_MATERIAL_GROUP_ID
    const captionPrompt = readRequestString(params.captionPrompt, 2000)
    const model = readRequestString(params.model, 80)
    const imageModel = readRequestString(params.imageModel, 80)
    const style = readRequestString(params.style, 40)
    const draftType = readRequestString(params.draftType, 20)
    const imageCount = Math.max(0, Math.min(20, Math.round(Number(params.imageCount ?? 0)) || 0))
    const imageSize = readRequestString(params.imageSize, 20)
    const imageUrls = readRequestStringList(params.imageUrls, 9)
    const videoUrls = readRequestStringList(params.videoUrls, 9)
    const audioUrls = readRequestStringList(params.audioUrls, 9)
    const platforms = readRequestStringList(params.platforms, 20)
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
            const knowledgeContext = buildKnowledgeContext(d.store.files.knowledge.load() as KnowledgeState, userPrompt)
            // 长视频走本地分镜模板，不调用模型：只有"真的调用了模型却没有产出"才算失败，
            // 否则配置了大模型的用户每次 ≥60 秒生成都会被误判为失败（含媒体生成一并中断）。
            const llmAttempted = stored !== undefined && !longVideo
            if (llmAttempted) {
              const promptText = (kind === 'video'
                ? '围绕「' + topic + '」创作一条 60 秒内短视频口播脚本：给出标题、口播正文、3-5 个话题标签，直接输出可直接发布的内容。'
                : '围绕「' + topic + '」创作一篇小红书图文笔记：20 字内吸睛标题、带 emoji 与分段的正文、3-5 个话题标签，直接输出可直接发布的内容。')
                + captionRequirementBlock
              const out = await streamLlmWithDeltas(promptText, undefined, stored, knowledgeContext.block)
              llmText = out.text
              llmError = out.error ?? ''
            }
            const honestFallback = stored === undefined
              ? '未接入任何大模型。请先在「设置 → 配置大模型」中填写你的 API 地址和密钥，配置后才能生成内容。'
              : '大模型调用失败：' + (llmError || '未知错误') + '。请检查 API 地址、密钥和模型名后重试。'
            target.response = kind === 'video'
              ? longVideo
                ? buildLongVideoScript(topic, mediaDuration, mediaResolution, mediaAspectRatio, captionPrompt)
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
                status: 'failed',
                rating: 0,
                sourceId: gen.id,
              })
              return
            }
            target.status = 'generating'
            target.updatedAt = nowIso()
            d.store.files.generations.save(list)
            const mediaResult = await attachGenerationMedia(d, gen.id, kind, target.response, { duration: mediaDuration, resolution: mediaResolution, aspectRatio: mediaAspectRatio, style, imageUrls })
            const latest = d.store.files.generations.load().find(g => g.id === gen.id)
            if (latest === undefined)
              return
            if (!mediaResult.ok) {
              latest.status = 'partial'
              latest.errorMessage = '文字/脚本已生成，但媒体生成失败：' + (mediaResult.error || '媒体生成失败')
            }
            else {
              latest.status = 'success'
              latest.errorMessage = ''
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
                status: 'success',
                rating: 0,
                sourceId: gen.id,
              })
            }
            latest.updatedAt = nowIso()
            d.store.files.generations.save(d.store.files.generations.load())
          } catch (error) {
            target.status = 'failed'
            target.errorMessage = error instanceof Error ? error.message : '生成失败'
            target.updatedAt = nowIso()
            d.store.files.generations.save(list)
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
    d.store.files.contents.save(filterGenerationArtifacts(ids, contents))
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

  /** 生成结果附媒体：图文→多张真实卡片图；视频→帧图合成可播放 mp4（失败不影响文本）。 */
  async function generateAiImages(
    d: Deps,
    prompt: string,
    count: number,
    opts?: { resolution?: string; aspectRatio?: string },
  ): Promise<{ urls: string[]; files: string[]; model: string } | null> {
    const cfg = readStoredLlm(d.dataRoot)
    if (cfg === undefined || cfg.apiKey === '' || cfg.baseUrl === '')
      return null
    // 仅当显式配置了图片模型时才调用图片接口；
    // 纯对话模型（如 agnes-2.5-flash）请求 /images/generations 会被服务商拒绝。
    const imageModel = cfg.imageModel ?? ''
    if (imageModel === '')
      return null
    const base = (cfg.imageBaseUrl || cfg.baseUrl).trim().replace(/\/+$/, '')
    const endpoint = /\/v\d+$/.test(base)
      ? base + '/images/generations'
      : base + '/v1/images/generations'
    const apiKey = cfg.imageApiKey || cfg.apiKey
    const files: string[] = []
    const urls: string[] = []
    // 与视频同一条口径：档位 + 画幅 → 成品像素；比例同时写进提示词，让模型按目标画幅构图。
    const targetSize = pixelFor(opts?.resolution ?? '', opts?.aspectRatio ?? '')
    const targetPixels = parseSize(targetSize)
    const ratioHint = ratioPromptHint(opts?.aspectRatio ?? '')
    const requestPrompt = ratioHint === '' ? prompt : prompt + '\n画面比例：' + ratioHint
    // 首选成品尺寸；厂商只认自家尺寸（4xx）时退到通用正方形，成品尺寸仍由下方裁剪保证。
    const sizeCandidates = [...new Set([targetSize, '1024x1024'].filter(size => size !== ''))]
    const run = async (): Promise<{ urls: string[]; files: string[] } | null> => {
      const postImage = async (size: string): Promise<Response | null> => {
        let resp: Response | null = null
        for (let attempt = 0; attempt < 2 && resp === null; attempt++) {
          try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 90000)
            const candidate = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer ' + apiKey,
              },
              body: JSON.stringify({ model: imageModel, prompt: requestPrompt, n: 1, size }),
              signal: controller.signal,
            })
            clearTimeout(timer)
            if (candidate.status === 429 || candidate.status >= 500) {
              console.error('[AI_IMG_ERR] endpoint=' + endpoint + ' status=' + candidate.status)
              await sleep(attempt === 0 ? 3000 : 8000)
              continue
            }
            resp = candidate
          }
          catch (error) {
            console.error('[AI_IMG_EXC] attempt=' + attempt + ' ' + String(error))
            if (attempt === 0) await sleep(3000)
          }
        }
        return resp
      }
      // 部分厂商一次只接受 n=1（如 agnes-image）：逐张生成，单张带重试
      for (let i = 0; i < count; i++) {
        let resp: Response | null = null
        for (const size of sizeCandidates) {
          resp = await postImage(size)
          if (resp !== null && resp.ok)
            break
          // 4xx = 厂商不接受这个尺寸，换下一个候选；网络失败或 5xx 换尺寸也救不回来。
          if (resp === null || resp.status < 400 || resp.status >= 500)
            break
          console.error('[AI_IMG_ERR] size=' + size + ' rejected status=' + resp.status)
        }
        if (resp === null || !resp.ok) {
          if (i === 0)
            return null
          break
        }
        const payload = await resp.json() as { data?: Array<{ b64_json?: string; url?: string }>; images?: Array<{ b64_json?: string; url?: string }> }
        const item = (payload?.data ?? payload?.images ?? [])[0]
        if (!item)
          break
        let bytes: Buffer | null = null
        if (item?.b64_json) {
          bytes = Buffer.from(item.b64_json, 'base64')
        }
        else if (item?.url) {
          // 图片下载失败只跳过该张，禁止未捕获异常拖垮整个服务进程（9/7 实测 fatal load failure 事故）
          try {
            const imageResp = await fetch(item.url, { signal: AbortSignal.timeout(30000) })
            if (imageResp.ok)
              bytes = Buffer.from(await imageResp.arrayBuffer())
          }
          catch (downloadError) {
            console.error('[AI_IMG_EXC] image download failed, skip: ' + String(downloadError))
            continue
          }
        }
        if (bytes === null || bytes.length === 0)
          continue
        const id = uid('ai-img') + '.png'
        const file = join(d.dataRoot, 'uploads', id)
        if (targetPixels === null) {
          writeFileSync(file, bytes)
        }
        else {
          // 厂商原图多为自家尺寸：落盘前按「档位 + 画幅」裁剪缩放到成品像素。
          // 裁剪失败（非 Windows 或解码失败）保留厂商原图并留日志，不阻断本次生成。
          const raw = join(d.dataRoot, 'uploads', uid('ai-img-raw') + '.bin')
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
      return files.length > 0 ? { urls, files } : null
    }
    const result = await new Promise<{ urls: string[]; files: string[] } | null>((resolve) => {
      const task = aiImageQueue.then(() => run())
      aiImageQueue = task.catch(() => undefined)
      void task.then(resolve)
    })
    return result === null ? null : { ...result, model: imageModel }
  }

  /**
   * 视频生成：优先 OpenAI 兼容 /videos/generations；404/405 或连接失败时回退 Agnes 异步 /videos + /agnesapi 轮询。
   *
   * 传入 `opts.imageUrls` 即图生视频：引用图会被解析成厂商可读取的值（本地素材内联为 Data URI，
   * 公网地址原样透传），并按张数落到 Agnes 的首帧/首尾帧/参考图模式。
   *
   * 传入 `opts.talkingHead` 即数字人口播：形象图与配音音频直接进 `reference` 模式，
   * 跳过 OpenAI 兼容端点（音频参考是厂商专有参数，通用端点必然不认）。
   */
  async function generateAiVideoDirect(
    d: Deps,
    prompt: string,
    opts?: {
      duration?: number
      resolution?: string
      aspectRatio?: string
      imageUrls?: string[]
      /** 数字人口播：形象图与音频都已是厂商可读取的值（Data URI 或公网地址）。 */
      talkingHead?: { images: string[], audios: string[], seed: number }
    },
  ): Promise<{ url: string; model: string } | null> {
    const cfg = readStoredLlm(d.dataRoot)
    if (cfg === undefined || cfg.videoModel === undefined || cfg.videoModel === '')
      return null
    const base = (cfg.videoBaseUrl || cfg.baseUrl).trim().replace(/\/+$/, '')
    const apiKey = cfg.videoApiKey || cfg.apiKey
    const videoModel = cfg.videoModel
    // 参数契约：时长/分辨率/画幅必须尊重用户选择（UI 档位 5-180s、720p/1080p/2K），不得静默降级；厂商不支持时由 API 如实报错。
    const duration = Math.min(180, Math.max(4, Math.round(opts?.duration ?? 5) || 5))
    const resolutionRaw = (opts?.resolution ?? '720p').toUpperCase().replace(/\s+/g, '')
    const size = ['720P', '1080P', '960P', '2K', '4K'].includes(resolutionRaw) ? resolutionRaw : '720P'
    const aspectRatio = opts?.aspectRatio ?? '9:16'
    const headers = { 'content-type': 'application/json', 'authorization': 'Bearer ' + apiKey }
    // 图生视频：引用图必须先在本机解析成厂商可读取的值；读不到的图直接丢弃，
    // 只带剩下的图去生成，绝不拿别的图片冒充用户给的那张。
    const referenceImages = opts?.talkingHead !== undefined
      ? opts.talkingHead.images
      : (opts?.imageUrls ?? [])
          .map(url => referenceImageValue(d, url))
          .filter(value => value !== '')
    if ((opts?.imageUrls ?? []).length > referenceImages.length)
      console.error('[AI_VID_ERR] 有引用图无法读取，已丢弃 ' + String((opts?.imageUrls ?? []).length - referenceImages.length) + ' 张')

    const saveVideo = async (directUrl: string): Promise<{ url: string; model: string } | null> => {
      const bytes = await downloadToBuffer(directUrl)
      if (bytes === null || bytes.length === 0)
        return null
      const id = uid('ai-vid') + '.mp4'
      const file = join(d.dataRoot, 'uploads', id)
      writeFileSync(file, bytes)
      uploadsMeta.set(id, 'video/mp4')
      return { url: '/bosom-friend/api/assets/file/' + encodeURIComponent(id), model: videoModel }
    }
    const postWithRetry = async (endpoint: string, payload: Record<string, unknown>): Promise<Response | null> => {
      let resp: Response | null = null
      for (let attempt = 0; attempt < 3 && resp === null; attempt++) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 45000)
          const candidate = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
          clearTimeout(timer)
          if (candidate.status === 429 || candidate.status >= 500) {
            console.error('[AI_VID_ERR] endpoint=' + endpoint + ' status=' + candidate.status)
            await sleep(attempt === 0 ? 3000 : 8000)
            continue
          }
          resp = candidate
        }
        catch (error) {
          console.error('[AI_VID_EXC] endpoint=' + endpoint + ' attempt=' + attempt + ' ' + String(error))
          if (attempt === 0) await sleep(3000)
        }
      }
      return resp
    }
    try {
      const genericEndpoint = /\/v\d+$/.test(base) ? base + '/videos/generations' : base + '/v1/videos/generations'
      // 口播走厂商专有的音频参考参数，通用端点不会有；直接进异步任务，少一次必然 404 的往返。
      const genericResp = opts?.talkingHead !== undefined ? null : await postWithRetry(genericEndpoint, {
        model: videoModel,
        prompt,
        duration,
        resolution: opts?.resolution ?? '720p',
        aspect_ratio: opts?.aspectRatio ?? '9:16',
        // 带图时一并给出各家通用字段名；不带图时不发空字段，避免厂商把空值当"有图但读不到"。
        ...(referenceImages.length > 0 ? { image: referenceImages[0], images: referenceImages } : {}),
      })
      if (genericResp !== null && genericResp.ok) {
        const payload = await genericResp.json() as Record<string, unknown>
        const directUrl = pickVideoUrl(payload)
        if (directUrl !== '') {
          const saved = await saveVideo(directUrl)
          if (saved !== null) return saved
        }
        const taskId = pickTaskId(payload)
        if (taskId !== '') {
          const statusBase = /\/v\d+$/.test(base) ? base : base + '/v1'
          const deadline = Date.now() + VIDEO_POLL_BUDGET_MS
          while (Date.now() < deadline) {
            await sleep(4000)
            const statusResp = await fetch(statusBase + '/videos/' + encodeURIComponent(taskId), {
              headers: { 'authorization': 'Bearer ' + apiKey },
              signal: AbortSignal.timeout(20000),
            })
            if (!statusResp.ok) continue
            const status = await statusResp.json() as Record<string, unknown>
            const url = pickVideoUrl(status)
            if (url !== '') {
              const saved = await saveVideo(url)
              if (saved !== null) return saved
            }
          }
        }
      }
      // Agnes 异步任务：POST {base}/videos 创建任务，再轮询 {origin}/agnesapi 取成品
      const agnesEndpoint = /\/v\d+$/.test(base) ? base + '/videos' : base + '/v1/videos'
      const agnesResp = await postWithRetry(agnesEndpoint, {
        model: videoModel,
        prompt,
        seconds: String(duration),
        size,
        aspect_ratio: aspectRatio,
        ...(opts?.talkingHead !== undefined
          ? agnesTalkingHeadFields({ ...opts.talkingHead, images: referenceImages })
          : agnesVideoModeFields(referenceImages)),
      })
      if (agnesResp === null || !agnesResp.ok) {
        console.error('[AI_VID_ERR] agnes create failed status=' + (agnesResp?.status ?? 'null'))
        return null
      }
      const created = await agnesResp.json() as Record<string, unknown>
      const videoId = typeof created.video_id === 'string' && created.video_id !== ''
        ? created.video_id
        : pickTaskId(created)
      if (videoId === '')
        return null
      const origin = new URL(base).origin
      const statusEndpoint = origin + '/agnesapi'
      const deadline = Date.now() + VIDEO_POLL_BUDGET_MS
      while (Date.now() < deadline) {
        await sleep(4000)
        try {
          const statusUrl = statusEndpoint
            + '?video_id=' + encodeURIComponent(videoId)
            + '&model_name=' + encodeURIComponent(videoModel)
          const statusResp = await fetch(statusUrl, {
            headers: { 'authorization': 'Bearer ' + apiKey },
            signal: AbortSignal.timeout(20000),
          })
          if (!statusResp.ok) {
            console.error('[AI_VID_ERR] poll status=' + statusResp.status)
            if (statusResp.status === 429) await sleep(10000)
            continue
          }
          const status = await statusResp.json() as Record<string, unknown>
          const done = status.status
          if (done === 'completed') {
            const url = pickVideoUrl(status)
            if (url === '') {
              console.error('[AI_VID_ERR] completed without url')
              return null
            }
            return await saveVideo(url)
          }
          if (done === 'failed') {
            console.error('[AI_VID_ERR] task failed ' + JSON.stringify(status.error ?? {}))
            return null
          }
        }
        catch (error) {
          console.error('[AI_VID_EXC] poll ' + String(error))
        }
      }
      console.error('[AI_VID_ERR] poll timeout')
      return null
    }
    catch (error) {
      console.error('[AI_VID_ERR] ' + String(error))
      return null
    }
  }

  function pickVideoUrl(payload: Record<string, unknown>): string {
    const data = payload.data as unknown
    if (Array.isArray(data)) {
      for (const item of data as Array<Record<string, unknown>>) {
        const url = typeof item.url === 'string' ? item.url : ''
        if (url !== '') return url
        const videoUrl = typeof item.video_url === 'string' ? item.video_url : ''
        if (videoUrl !== '') return videoUrl
      }
    }
    else if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>
      const url = typeof obj.url === 'string' ? obj.url : typeof obj.video_url === 'string' ? obj.video_url : ''
      if (url !== '') return url
    }
    const output = payload.output as unknown
    if (Array.isArray(output)) {
      for (const item of output as Array<unknown>) {
        if (typeof item === 'string' && /^https?:/i.test(item)) return item
        if (typeof item === 'object' && item !== null) {
          const url = (item as Record<string, unknown>).url
          if (typeof url === 'string' && url !== '') return url
        }
      }
    }
    const topUrl = typeof payload.url === 'string' ? payload.url : ''
    if (topUrl !== '') return topUrl
    const meta = payload.metadata as { url?: unknown } | undefined
    const metaUrl = typeof meta?.url === 'string' ? meta.url : ''
    if (metaUrl !== '') return metaUrl
    return ''
  }

  function pickTaskId(payload: Record<string, unknown>): string {
    const data = payload.data as unknown
    if (Array.isArray(data)) {
      const id = (data[0] as Record<string, unknown> | undefined)?.id
      return typeof id === 'string' ? id : ''
    }
    if (typeof data === 'object' && data !== null) {
      const id = (data as Record<string, unknown>).id
      return typeof id === 'string' ? id : ''
    }
    return ''
  }

  /** 本地素材 URL 对应的落盘文件；非本地素材或文件不存在时返回空串。 */
  function localAssetFile(d: Deps, url: string): string {
    const prefix = '/bosom-friend/api/assets/file/'
    const index = url.indexOf(prefix)
    if (index < 0) return ''
    const id = decodeURIComponent(url.slice(index + prefix.length).split('?')[0] ?? '')
    // 素材 id 是文件名：带路径分隔符的请求一律不认，避免越出 uploads 目录读任意文件。
    if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) return ''
    const file = join(d.dataRoot, 'uploads', id)
    return existsSync(file) ? file : ''
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
   * 把本机文件内联成 Data URI。
   *
   * 厂商在公网侧取不到本机路径，图片与配音音频都只能把字节塞进请求体。
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

  async function downloadToBuffer(url: string): Promise<Buffer | null> {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000) })
      return resp.ok ? Buffer.from(await resp.arrayBuffer()) : null
    }
    catch {
      return null
    }
  }

  async function attachGenerationMedia(
    d: Deps,
    genId: string,
    kind: 'video' | 'image-text',
    response?: { title?: string; description?: string; topics?: string[] },
    request?: { duration?: number; resolution?: string; aspectRatio?: string; style?: string; imageUrls?: string[] },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const title = response?.title || '内容卡片'
      const body = response?.description || ''
      const topics = response?.topics || []
      const parts = body.split('\n').map(s => s.trim()).filter(Boolean)
      // 风格没有独立的厂商参数，只能作为提示词前缀进入图片/视频生成请求。
      const mediaPrompt = (buildStyleDirective(request?.style ?? '') + title + '\n' + body).slice(0, 800)
      // 图生视频：用户给了引用图，成片就以这些图为源。此时不再另生成一批图片——
      // 否则封面与降级合成用的都是模型按文案另画的图，跟用户那张图毫无关系，"用图片生成视频"名存实亡。
      const referenceImages = (request?.imageUrls ?? []).filter(url => url !== '')
      const imageDriven = kind === 'video' && referenceImages.length > 0
      // 优先调用用户配置的 OpenAI 兼容图片模型生成真实图片；
      // 未配置/模型不支持/请求失败时回退本地模板卡片，并在结果里如实标注来源。
      const aiMedia = imageDriven ? null : await generateAiImages(d, mediaPrompt, 2, request)
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
        return { ok: false, error: '图片素材生成失败' }
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
      if (kind === 'video') {
        const realVideo = await generateAiVideoDirect(d, mediaPrompt, { ...request, imageUrls: referenceImages })
        if (realVideo !== null) {
          target.response.videoUrl = realVideo.url
          target.response.generatedBy = 'ai'
          target.response.generatedModel = 'video:' + realVideo.model
        }
        else {
          // 降级合成也必须携带用户参数（时长/分辨率/画幅），否则产出与选择不符
          const videoUrl = await createSlideshow(d, media.files, 'vid-' + genId + '.mp4', request)
          if (videoUrl !== null) target.response.videoUrl = videoUrl
          // 视频为本地合成：如实标注（图片可能是 AI 生成，视频本身不是厂商视频模型产出）
          if (generatedBy === 'ai')
            target.response.generatedBy = 'local-template'
        }
        if (!target.response.videoUrl)
          return { ok: false, error: '视频生成失败，未得到可播放的视频文件' }
      }
      target.updatedAt = nowIso()
      d.store.files.generations.save(list)
      registerGenerationDraft(d, genId, target.request?.groupId ?? DEFAULT_MATERIAL_GROUP_ID, kind, target.response, target.request, media.urls, target.response.videoUrl)
      return { ok: true }
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
    const title = response.title?.slice(0, 60) || 'AI 生成内容'
    const mediaList: ZyMaterialMedia[] = [
      ...imageUrls.slice(0, 9).map(url => ({ type: 'img' as const, url, thumbUrl: url })),
      ...(videoUrl ? [{ type: 'video' as const, url: videoUrl, thumbUrl: imageUrls[0] ?? '' }] : []),
    ]
    if (mediaList.length === 0) return
    const platforms = Array.isArray(request?.platforms) ? request.platforms : []
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
      const cleared: Record<string, number> = {}

      if (wanted('tasks')) {
        cleared.tasks = files.tasks.load().length
        files.tasks.save([])
      }
      if (wanted('publish')) {
        cleared.publishRecords = files.records.load().length
        files.records.save([])
        cleared.metrics = files.metrics.load().length
        files.metrics.save([])
      }
      if (wanted('content')) {
        cleared.generations = files.generations.load().length
        files.generations.save([])
        const contents = files.contents.load()
        cleared.materials = contents.filter(item => item.kind === 'asset').length
        cleared.promotions = contents.filter(item => item.kind === 'draft').length
        files.contents.save([])
      }
      if (wanted('reception')) {
        cleared.receptionPending = files.receptionPending.load().length
        files.receptionPending.save([])
        cleared.receptionSeen = Object.keys(files.receptionSeen.load()).length
        files.receptionSeen.save({})
        cleared.receptionReplies = files.receptionReplies.load().length
        files.receptionReplies.save([])
      }
      if (wanted('aiLogs')) {
        cleared.aiLogs = files.logs.load().length
        files.logs.save([])
      }
      if (wanted('notifications')) {
        cleared.notifications = files.notifications.load().length
        files.notifications.save([])
      }
      if (wanted('knowledge')) {
        const knowledge = files.knowledge.load()
        const builtIn = Object.fromEntries(
          Object.entries(knowledge.notes).filter(([, note]) => note.protected === true),
        ) as typeof knowledge.notes
        cleared.knowledge = Object.keys(knowledge.notes).length - Object.keys(builtIn).length
        files.knowledge.save({ ...knowledge, notes: builtIn })
      }

      writeOk(res, cleared)
    },
  })

  // ---- 长视频产出（通用工作流）--------------------------------------------
  //
  // 数字人口播、场景呈现共用同一条编排（long-video.ts）：写稿 → 切段 → 逐段生成 → 拼接。
  // 业务的差别全部收在片段生成器里，新增一种业务只加一个生成器，编排与存储都不动。

  /** 片段生成器注册表：新增一种内容形式只在这里加一行。 */
  function producerFor(kind: string, ref?: string, productImageRef = ''): LongVideoProducer | { error: string } {
    if (kind === 'digital-human') {
      const human = files.digitalHumans.load().find(item => item.id === ref)
      if (human === undefined) return { error: '数字人形象已被删除，任务中止' }
      return digitalHumanProducer(human, productImageRef)
    }
    if (kind === 'scene') return sceneProducer(productImageRef)
    return { error: '未知的内容形式：' + kind }
  }

  /**
   * 数字人口播：**同一个人 + 同一套参考图**跨镜复用。
   *
   * 按镜头类型分派（这是"像拍过的"的关键）：
   * - `talking-head`：形象图 + 当镜配音 → 厂商 reference 模式（口型由真实音频驱动）；
   * - `product`：画面提示词 + 产品参考图（若有）→ 图生视频，**画面主体是产品而不是人**；
   * - `scene`/`text-card`：按画面提示词出空镜。
   *
   * 参考图集与固定种子是跨镜一致性的全部依据——实测证明多参考图能锁住同一个人，
   * 而图像侧的图生图不可用（见 DEF-068），所以一致性只能在这一层做。
   */
  function digitalHumanProducer(human: ZyDigitalHuman, productImageUrl = ''): LongVideoProducer {
    const continuityNote = '同一位主播，米色墙背景，室内柔和暖光，竖屏构图'
    /** 产品镜的参考图集：用户给了产品图就用它，否则为空（纯描述）。 */
    const productRefs: ZyShotRef[] = productImageUrl === '' ? [] : [{ url: productImageUrl, role: 'product' }]
    return {
      kind: 'digital-human',
      scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的中文带货口播稿：'
        + '口语化、开头有钩子、中间讲清卖点、结尾有行动号召。'
        + '全片按约 ' + String(segments) + ' 个镜头分段推进，内容要撑满整段时长，不要一句话就收尾。'
        + '只输出可以直接念出来的正文，不要标题、不要分镜、不要话题标签、不要任何说明。',
      async planShots({ targetSeconds, brief, instruction, topic, script }) {
        // 人物图挂在口播镜上；产品图由 fallbackShotPlan 按角色分派给产品镜。
        const references: ZyShotRef[] = [{ url: human.avatarUrl, role: 'person' }, ...productRefs]
        const hasProduct = productRefs.length > 0
        const fallbackShots = (): { shots: ZyShot[], source: 'fallback' } => ({
          shots: fallbackShotPlan(splitScript(script), references, 'digital-human', hasProduct),
          source: 'fallback',
        })
        const prompt = '你是短视频导演。围绕「' + topic + '」' + brief + '\n' + instruction
          + '\n' + buildStoryboardPrompt(targetSeconds, hasProduct)
        const planned = await completeWithModelOrNull(prompt)
        if (planned === null) return fallbackShots()
        const shots = parseShotPlan(planned, references, 'digital-human')
        return shots.length === 0 ? fallbackShots() : { shots, source: 'model' }
      },
      async produce({ index, shot, workDir, resolution, aspectRatio }) {
        const position = String(index + 1).padStart(2, '0')
        // 产品镜：画面主体是产品，不带人物形象图、不配音，走图生视频。
        if (shot.kind === 'product' || shot.kind === 'scene' || shot.kind === 'text-card') {
          const shotProductRefs = shot.references.filter(item => item.role === 'product')
          const visual = [shot.continuity === '' ? continuityNote : shot.continuity, shot.visual]
            .filter(part => part !== '')
            .join('。')
          const video = await generateAiVideoDirect(deps, visual, {
            duration: clampSegmentSeconds(shot.seconds),
            resolution,
            aspectRatio,
            // 有产品参考图就带上（厂商按参考图约束画面主体）；没有就走纯文生视频。
            ...(shotProductRefs.length > 0 ? { imageUrls: shotProductRefs.map(item => item.url) } : {}),
          })
          if (video === null) return { ok: false, error: '厂商未返回可用成片' }
          const local = localAssetFile(deps, video.url)
          if (local === '') return { ok: false, error: '成片落盘后找不到文件' }
          const seconds = await probeDurationSeconds(local)
          // 读不出成片时长时退回这一镜的目标时长：宁可拼接略有偏差，也不给出一条 null 的段。
          // 兜底值走 clampSegmentSeconds（本文件自己的函数）而不是跨模块引常量：
          // storyboard 的常量在本模块初始化时可能还是未初始化的绑定（实测拿到 undefined，产品镜因此返回 null 秒数）。
          const resolved = seconds > 0 ? seconds : shot.seconds
          return { ok: true, file: local, seconds: clampSegmentSeconds(Number.isFinite(resolved) ? resolved : 0) }
        }
        // 口播镜：配音真实时长就是这一段的时间基准（母时钟）。
        const line = shot.line === '' ? shot.visual : shot.line
        const speech = await synthesizeSpeech(line, resolveVoice(human.voice), join(workDir, 'seg-' + position + '.mp3'))
        if (!speech.ok) return { ok: false, error: '配音失败：' + speech.error }
        const avatarValue = referenceImageValue(deps, human.avatarUrl)
        if (avatarValue === '') return { ok: false, error: '形象图读不出来（素材可能已被删除）' }
        const audioValue = inlineFileDataUri(speech.result.file)
        if (audioValue === '') return { ok: false, error: '配音文件读不出来' }
        const video = await generateAiVideoDirect(deps, line, {
          duration: clampSegmentSeconds(speech.result.seconds),
          resolution,
          aspectRatio,
          talkingHead: { images: [avatarValue], audios: [audioValue], seed: human.seed },
        })
        if (video === null) return { ok: false, error: '厂商未返回可用成片' }
        const local = localAssetFile(deps, video.url)
        if (local === '') return { ok: false, error: '成片落盘后找不到文件' }
        // 字幕时间轴跟的是成片长度，不是配音长度：厂商会重新配音，两者常常对不齐。
        // 读不出成片时长时退回配音时长，宁可字幕略有偏差，也不让整段失败。
        const probed = await probeDurationSeconds(local)
        return { ok: true, file: local, seconds: probed > 0 ? probed : speech.result.seconds }
      },
    }
  }

  /** 场景呈现：不出镜，每镜由厂商按画面文案直接生成场景画面（成片自带环境音）。 */
  function sceneProducer(productImageUrl = ''): LongVideoProducer {
    const productRefs: ZyShotRef[] = productImageUrl === '' ? [] : [{ url: productImageUrl, role: 'product' }]
    return {
      kind: 'scene',
      scriptBrief: (seconds, segments) => '写一段约 ' + String(seconds) + ' 秒的中文短视频分镜稿：'
        + '刚好 ' + String(segments) + ' 句，一句一个镜头。'
        + '每句描述一个不同的具体画面：主体、动作、环境、光线、镜头运动，'
        + '每句都要能直接当画面提示词用；相邻句子不许是同一个场景的重复描述，'
        + '画面要在不同场景之间推进（如产品特写 → 使用场景 → 人物反应 → 促销画面）。'
        + '只输出正文，不要标题、不要编号、不要任何说明。',
      async planShots({ targetSeconds, brief, instruction, topic, script }) {
        const hasProduct = productRefs.length > 0
        const fallbackShots = (): { shots: ZyShot[], source: 'fallback' } => ({
          shots: fallbackShotPlan(splitScript(script), productRefs, 'scene', hasProduct),
          source: 'fallback',
        })
        const prompt = '你是短视频导演。围绕「' + topic + '」' + brief + '\n' + instruction
          + '\n' + buildStoryboardPrompt(targetSeconds, hasProduct)
        const planned = await completeWithModelOrNull(prompt)
        if (planned === null) return fallbackShots()
        const shots = parseShotPlan(planned, productRefs, 'scene')
        return shots.length === 0 ? fallbackShots() : { shots, source: 'model' }
      },
      async produce({ shot, resolution, aspectRatio }) {
        const text = shot.visual === '' ? shot.line : shot.visual
        // 画面时长按这句文案的体量给：固定给 12 秒会让厂商把画面拖慢拉长，
        // 一条片里出现几段"慢动作空镜"，也就是用户说的"画面不搭配"。
        const requested = clampSegmentSeconds(shot.seconds > 0 ? shot.seconds : estimateSeconds(text))
        const shotProductRefs = shot.references.filter(item => item.role === 'product')
        const video = await generateAiVideoDirect(deps, text, {
          duration: requested,
          resolution,
          aspectRatio,
          ...(shotProductRefs.length > 0 ? { imageUrls: shotProductRefs.map(item => item.url) } : {}),
        })
        if (video === null) return { ok: false, error: '厂商未返回可用成片' }
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
  ): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
    const stored = readStoredLlm(deps.dataRoot)
    if (stored === undefined)
      return { ok: false, error: '未接入大模型，写不了稿。请先在「设置 → 配置大模型」中填写 API 地址和密钥。' }
    const out = await streamLlmWithDeltas(
      '你是短视频编剧。围绕「' + topic + '」' + brief + '\n' + instruction,
      undefined,
      stored,
      '',
    )
    const text = normalizeSpokenText(out.text)
    if (text === '')
      return { ok: false, error: '大模型没有返回可用的稿件：' + (out.error ?? '未知错误') }
    return { ok: true, text }
  }

  /**
   * 用当前生效的大模型补全一段提示词；未接入或调用失败时如实回原因。
   *
   * @param prompt - 已拼好的完整要求。
   * @returns 模型返回的文本，或可读的失败原因。
   */
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

  async function completeWithModel(prompt: string): Promise<{ ok: true, text: string } | { ok: false, error: string }> {
    const stored = readStoredLlm(deps.dataRoot)
    if (stored === undefined)
      return { ok: false, error: '未接入大模型。请先在「设置 → 配置大模型」中填写 API 地址和密钥。' }
    const out = await streamLlmWithDeltas(prompt, undefined, stored, '')
    const text = out.text.trim()
    if (text === '')
      return { ok: false, error: '大模型没有返回内容：' + (out.error ?? '未知错误') }
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
  }): { ok: true, taskId: string } | { ok: false, error: string } {
    // 产品图必须是本机读得到的素材：厂商要按字节内联，读不到就生成不了——当场拒绝，不建一条注定跑不完的任务。
    const productImageUrl = (input.productImageUrl ?? '').trim()
    if (productImageUrl !== '' && localAssetFile(deps, productImageUrl) === '') {
      return { ok: false, error: '产品图读不出来，请重新上传一张产品照片' }
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
    setTimeout(() => { void runLongVideoJob(longVideoDeps(), task.id, producer) }, 300)
    return { ok: true, taskId: task.id }
  }

  routes.push(
    // ---- 数字人形象库（producer=digital-human 的可选项）--------------------
    {
      m: 'GET',
      p: 'digital-humans/voices',
      h: ({ res }) => { writeOk(res, { list: DIGITAL_HUMAN_VOICES, defaultVoice: DEFAULT_DIGITAL_HUMAN_VOICE }) },
    },
    {
      /**
       * 音色试听：按需合成样音并缓存。
       *
       * 走 GET 是因为前端直接把它当 `<audio src>` 播放：浏览器自己发请求、自己带 Range，
       * 不必把几 MB 音频读进 JS 再转 blob 地址。试听要连微软语音服务，正常几秒返回；
       * 失败时如实报原因（"配音失败（Edge 语音服务不可达）"），不返回一段无声文件。
       */
      m: 'GET',
      p: 'digital-humans/voices/:voiceId/preview',
      h: async ({ req, res, params, query }) => {
        const voiceId = params.voiceId ?? ''
        if (!DIGITAL_HUMAN_VOICES.some(item => item.id === voiceId)) {
          writeFail(res, '没有这个音色，请刷新后重试', 40000)
          return
        }
        const raw = (query.get('text') ?? '').trim().slice(0, 100)
        const text = raw === '' ? VOICE_PREVIEW_TEXT : raw
        const dir = join(deps.dataRoot, 'voice-previews')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, sha8(voiceId + '|' + text) + '.mp3')
        if (!existsSync(file)) {
          // 试听只要音频字节：不读时长，也就不依赖本机 ffmpeg。
          const speech = await synthesizeSpeech(text, voiceId, file, { probeDuration: false })
          if (!speech.ok) { writeFail(res, speech.error, 50000); return }
        }
        const stat = statSync(file)
        const range = req.headers.range
        const match = range === undefined ? null : /bytes=(\d*)-(\d*)/.exec(range)
        if (match !== null) {
          const start = match[1] !== '' ? Number(match[1]) : 0
          const end = match[2] !== '' ? Number(match[2]) : stat.size - 1
          if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < stat.size && end < stat.size) {
            res.writeHead(206, {
              'content-type': 'audio/mpeg',
              'accept-ranges': 'bytes',
              'content-range': 'bytes ' + String(start) + '-' + String(end) + '/' + String(stat.size),
              'content-length': end - start + 1,
              'cache-control': 'public, max-age=3600',
            })
            createReadStream(file, { start, end }).pipe(res)
            return
          }
        }
        res.writeHead(200, {
          'content-type': 'audio/mpeg',
          'accept-ranges': 'bytes',
          'content-length': stat.size,
          'cache-control': 'public, max-age=3600',
        })
        createReadStream(file).pipe(res)
      },
    },
    {
      m: 'GET',
      p: 'digital-humans',
      h: ({ res }) => { writeOk(res, { list: files.digitalHumans.load() }) },
    },
    {
      m: 'POST',
      p: 'digital-humans',
      h: ({ res, body }) => {
        const input = (body ?? {}) as { name?: unknown, avatarUrl?: unknown, voice?: unknown }
        const name = typeof input.name === 'string' ? input.name.trim().slice(0, 30) : ''
        const avatarUrl = typeof input.avatarUrl === 'string' ? input.avatarUrl.trim() : ''
        if (name === '' || avatarUrl === '') { writeFail(res, '数字人需要名字和形象图', 40000); return }
        // 形象图必须是本机素材：厂商要按字节内联，读不到就生成不了。
        if (localAssetFile(deps, avatarUrl) === '') { writeFail(res, '形象图读不出来，请重新上传一张正面半身照', 40000); return }
        const human: ZyDigitalHuman = {
          id: uid('dh'),
          name,
          avatarUrl,
          voice: typeof input.voice === 'string' && input.voice.trim() !== ''
            ? input.voice.trim()
            : DEFAULT_DIGITAL_HUMAN_VOICE,
          // 固定种子：同一张形象图配同一个种子，跨次生成的形象才稳定。
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
      m: 'DELETE',
      p: 'digital-humans/:id',
      h: ({ res, params }) => {
        const list = files.digitalHumans.load()
        const kept = list.filter(item => item.id !== params.id)
        if (kept.length === list.length) { writeFail(res, '数字人不存在', 40404); return }
        files.digitalHumans.save(kept)
        writeOk(res, { removed: list.length - kept.length })
      },
    },
    // ---- 长视频产出（通用工作流，任何业务共用）------------------------------
    {
      m: 'GET',
      p: 'long-videos/producers',
      h: ({ res }) => {
        writeOk(res, {
          list: [
            { kind: 'digital-human', name: '数字人口播', description: '用一个固定形象出镜口播，适合带货 IP。' },
            { kind: 'scene', name: '场景呈现', description: '不出镜，每段由 AI 生成一个场景画面。' },
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
      p: 'long-videos/enhance-topic',
      h: async ({ res, body }) => {
        const input = (body ?? {}) as { topic?: unknown }
        const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
        if (topic === '') { writeFail(res, '先写清楚要讲的产品与卖点', 40000); return }
        if (topic.length > 500) { writeFail(res, '产品与卖点太长了（最多 500 字）', 40000); return }
        const out = await enhanceSpokenTopic(topic, completeWithModel)
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
        }
        const producer = typeof input.producer === 'string' ? input.producer.trim() : ''
        const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, 200) : ''
        if (producer === '') { writeFail(res, '请先选择内容形式（数字人口播 / 场景呈现）', 40000); return }
        if (topic === '') { writeFail(res, '请先填写要讲的产品与卖点', 40000); return }
        const started = startLongVideoTask({
          producer,
          ...(typeof input.producerRef === 'string' && input.producerRef !== '' ? { producerRef: input.producerRef } : {}),
          topic,
          targetSeconds: Math.min(300, Math.max(8, Math.round(Number(input.targetSeconds ?? 30)) || 30)),
          ...(typeof input.resolution === 'string' && input.resolution !== '' ? { resolution: input.resolution } : {}),
          ...(typeof input.aspectRatio === 'string' && input.aspectRatio !== '' ? { aspectRatio: input.aspectRatio } : {}),
          withSubtitles: input.withSubtitles !== false,
          // 可选：用户传了产品图就走"照着真实产品出画面"，没传就退化为不含任何文字的产品描述。
          ...(typeof input.productImageUrl === 'string' && input.productImageUrl.trim() !== ''
            ? { productImageUrl: input.productImageUrl.trim() }
            : {}),
        })
        if (!started.ok) { writeFail(res, started.error, 40000); return }
        writeOk(res, { taskId: started.taskId })
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
  )


  appendChannelRoutes(deps, routes)
  appendContentRoutes(deps, routes)
  appendKnowledgeRoutes(deps, routes)
  appendKnowledgeDistillRoutes(deps, routes)
  return routes
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
  const dataRoot = config.dataRoot !== undefined && config.dataRoot !== ''
    ? config.dataRoot
    : join(homedir(), '.bosom-friend', 'bosom-friend')
  const store = openStore(dataRoot)
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
      const createdPromotion: ZyContentRecord = {
        kind: 'draft',
        _id: id,
        id,
        groupId,
        title: response.title?.slice(0, 60) || 'AI 生成内容',
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
        metadata: { generationId: gen.id },
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
            writeFileSync(stateFile, JSON.stringify({
              ...state,
              status: 'failed',
              error: '引擎任务在服务重启时被中断，请重新发起',
              finishedAt: nowIso(),
            }, null, 2), 'utf8')
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
    return token !== '' && store.files.sessions.load().some(s => s.token === token)
  }

  const deps: Deps = {
    dataRoot,
    store,
    security: securityReport,
    kernelAi: config.kernelAi === true,
  }
  // 启动恢复：上次进程中断遗留的「生成中」任务定格为失败，避免用户永远看到转圈
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
  prunePlatformLoginTasks(dataRoot)
  // 平台登录守护引擎默认懒加载：启动即预热会额外拉起 Python 守护与一个完整 Chrome，
  // 低配机器上会和内核冷启动抢内存/CPU。需要预热时显式设置 BF_WARM_ENGINE=1。
  if (process.env.BF_WARM_ENGINE === '1') ensureEngineDaemon(deps)
  // 7×24 评论/私信自动接待引擎：绑定账号即纳入真实平台轮询（前台监控页数据源）
  startReceptionEngine(deps)
  const routes = buildRoutes(deps)
  const server = ctx.get('webServer')!
  const disposers: (() => void)[] = []

  disposers.push(server.register({
    kind: 'prefix',
    path: '/bosom-friend/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (handleCors(req, res)) return
      const url = new URL(req.url ?? '/', 'http://x')
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
        try { body = await readBody(req) } catch { writeFail(res, 'invalid json body', 40000); return }
      }
      else if (isRawUpload) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        body = Buffer.concat(chunks)
      }
      await match.route.h({ req, res, params: match.params, query: url.searchParams, body })
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
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      // 站点图标：dist 可无 favicon 时以 204 终结，消除浏览器 404 噪音。
      if (pathname === '/favicon.ico') {
        const favicon = join(distDir, 'favicon.ico')
        if (existsSync(favicon)) {
          res.writeHead(200, { 'content-type': 'image/x-icon' })
          createReadStream(favicon).pipe(res)
        } else {
          res.writeHead(204)
          res.end()
        }
        return
      }
      serveStatic(pathname.replace(/^\/bosom-friend/, '') || '/', res, req)
    },
  }))

  ctx.effect(() => () => {
    stopReceptionEngine()
    stopTrackedChildren()
    for (const dispose of disposers.reverse()) dispose()
  }, 'bosom-friend-server-api routes')
}

export { buildRoutes, streamLlmWithDeltas, templateReply, uploadsMeta, runtime, sha8, segsOf, matchRoute }
export type { ApiCall, RouteDef, Deps }
