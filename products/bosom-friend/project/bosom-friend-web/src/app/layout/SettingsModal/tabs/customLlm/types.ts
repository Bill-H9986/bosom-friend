/**
 * 自定义大模型设置页的共享类型与纯函数。
 *
 * 服务列表与编辑面板共用同一份 ProviderDraft：编辑即改内存，
 * 点「保存」才整列表写服务端，避免列表与表单两份状态互相覆盖。
 * 服务端契约见 products/bosom-friend/server/src/api.ts 的 ai/user-llm 路由。
 */

/** Agnes 国内站默认接口地址。 */
export const AGNES_BASE_URL = 'https://api.agnes-ai.cn/v1'
/** Agnes 国内站 API 申请入口（用户自行注册并创建 Key）。 */
export const AGNES_APPLY_URL = 'https://platform.agnes-ai.cn/'
/** 默认 API 协议：内核默认按 OpenAI 兼容协议适配。 */
export const DEFAULT_PROTOCOL = 'openai-completions'

/**
 * 可选 API 协议。
 *
 * 取值来自内核 llm-pi-ai 的协议表（`COMPAT_GATES`），这里只放两条：
 * 默认的 openai-completions，以及同样支持「GET /models + bearer」询问的 openai-responses。
 * 其余协议（azure-openai-responses / openai-codex-responses / anthropic-messages /
 * bedrock-converse-stream）内核认识，但产品侧没有验证过的接入路径，先不放进下拉。
 */
export const PROVIDER_PROTOCOLS = ['openai-completions', 'openai-responses'] as const

/**
 * 模型用途：对话 / 图片 / 视频。
 *
 * 图片、视频模型和对话模型一样挂在「服务」下面，不再另开一块媒体通道配置——
 * 客户有多个图片/视频模型时，直接在同一份模型目录里逐个标明用途即可。
 */
export type ModelKind = 'chat' | 'image' | 'video'

/** 用途下拉的显示名。 */
export const MODEL_KIND_LABELS: Record<ModelKind, string> = {
  chat: '对话',
  image: '图片',
  video: '视频',
}

/** 单个模型的可选参数（内核模型目录字段）；kind 只由产品侧使用，不投影给内核。 */
export interface ModelOption {
  name?: string
  contextWindow?: number
  maxTokens?: number
  kind?: ModelKind
}

/** 图片 / 视频通道的归属：哪个服务的哪个模型。 */
export interface MediaPick {
  providerId: string
  model: string
}

/** 某个模型的用途；没标过一律按对话模型算。 */
export function modelKind(draft: ProviderDraft, model: string): ModelKind {
  const kind = draft.modelOptions[model]?.kind
  return kind === 'image' || kind === 'video' ? kind : 'chat'
}

/** 改写某个模型的用途，返回新的 modelOptions（不改原对象）。 */
export function withModelKind(
  draft: ProviderDraft,
  model: string,
  kind: ModelKind,
): Record<string, ModelOption> {
  const options = { ...draft.modelOptions }
  const current = options[model] ?? {}
  if (kind === 'chat') {
    // 对话是默认值：不留 kind 字段，配置里不写冗余信息。
    delete options[model]
    if (Object.keys(current).length > 0 && current.name === undefined && current.contextWindow === undefined && current.maxTokens === undefined) {
      // 原本就只有 kind，删完就是空对象。
      return options
    }
    options[model] = current
    return options
  }
  options[model] = { ...current, kind }
  return options
}

/** 服务端保存的单个提供方（GET ai/user-llm 返回；密钥不回显，仅提交时带上）。 */
export interface ServerProvider {
  id?: string
  displayName?: string
  builtin?: boolean
  baseUrl?: string
  protocol?: string
  models?: string[]
  modelLabels?: Record<string, string>
  modelOptions?: Record<string, ModelOption>
  hasApiKey?: boolean
}

/** 服务端保存的模型配置（GET ai/user-llm 返回）。 */
export interface ServerLlmConfig {
  baseUrl?: string
  model?: string
  displayName?: string
  protocol?: string
  models?: string[]
  modelLabels?: Record<string, string>
  activeProviderId?: string
  providers?: ServerProvider[]
  hasApiKey?: boolean
  image?: { baseUrl?: string; model?: string; hasApiKey?: boolean }
  video?: { baseUrl?: string; model?: string; hasApiKey?: boolean }
}

/** 编辑态的模型服务：列表行与编辑面板共用同一对象。 */
export interface ProviderDraft {
  id: string
  displayName: string
  baseUrl: string
  protocol: string
  /** 仅提交时使用：留空表示沿用服务端已保存的密钥。 */
  apiKey: string
  /** 服务端已有可用密钥：徽标、占位文案与校验都以此为准。 */
  hasApiKey: boolean
  /** 模型目录：可在其中切换的模型 id。 */
  models: string[]
  /** 当前对话模型；提交时排到 models 首位（服务端以首个模型为当前模型）。 */
  model: string
  modelLabels: Record<string, string>
  modelOptions: Record<string, ModelOption>
  /** 尚未保存到服务端的新增服务。 */
  isNew: boolean
}

/** 展示用的接口主机名：去掉协议与结尾斜杠，空值回退为占位符。 */
export function displayHost(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (trimmed === '')
    return '—'
  return trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** 服务展示名：优先用户填写的名称，其次按接口主机名推导。 */
export function providerLabel(name: string, baseUrl: string): string {
  const trimmed = name.trim()
  if (trimmed !== '')
    return trimmed
  if (displayHost(baseUrl).toLowerCase().includes('agnes'))
    return 'Agnes AI'
  return '自定义模型'
}

/** 把服务端返回的提供方映射成编辑态：服务端首个模型即当前对话模型。 */
export function toDraft(item: ServerProvider, fallbackId: string): ProviderDraft {
  const models = Array.isArray(item.models)
    ? item.models.filter(model => typeof model === 'string' && model.trim() !== '').map(model => model.trim())
    : []
  const baseUrl = (item.baseUrl ?? '').trim()
  return {
    id: (item.id ?? fallbackId).trim() !== '' ? (item.id ?? fallbackId).trim() : fallbackId,
    displayName: (item.displayName ?? '').trim(),
    baseUrl,
    protocol: (item.protocol ?? '').trim() !== '' ? (item.protocol ?? '').trim() : DEFAULT_PROTOCOL,
    apiKey: '',
    hasApiKey: item.hasApiKey === true,
    models,
    model: models[0] ?? '',
    modelLabels: item.modelLabels ?? {},
    modelOptions: item.modelOptions ?? {},
    isNew: false,
  }
}

/** 未占用的新增服务 id：内核据此生成路由 bf-<id> 与密钥引用名。 */
export function nextProviderId(providers: ProviderDraft[]): string {
  const used = new Set(providers.map(item => item.id))
  for (let index = 1; index <= 99; index += 1) {
    const id = 'custom-' + String(index)
    if (!used.has(id))
      return id
  }
  return 'custom-' + String(Date.now())
}

/**
 * 新建一个空服务：字段全空，不预填任何接口地址、不预设任何模型与密钥。
 *
 * 预填过一个 Agnes 服务会在列表里凭空多出一张"Agnes AI（未保存）"的卡——
 * 用户并没有配过它。要引导用户去 Agnes 就在服务区放一个官网按钮，而不是替他建一条配置。
 */
export function newDraft(providers: ProviderDraft[]): ProviderDraft {
  return {
    id: nextProviderId(providers),
    displayName: '',
    baseUrl: '',
    protocol: DEFAULT_PROTOCOL,
    apiKey: '',
    hasApiKey: false,
    models: [],
    model: '',
    modelLabels: {},
    modelOptions: {},
    isNew: true,
  }
}

/**
 * 该服务要提交的模型目录：当前模型排首位（服务端以首个模型为当前对话模型），
 * 其余已保存模型按原顺序跟随，空值与重复项丢弃。
 */
export function draftModels(draft: ProviderDraft): string[] {
  const ordered = [draft.model, ...draft.models]
    .map(model => model.trim())
    .filter(model => model !== '')
  return [...new Set(ordered)]
}

/** 校验一个服务是否可保存：返回第一条错误，空串表示通过。 */
export function draftProblem(draft: ProviderDraft, label: string): string {
  if (!/^https?:\/\//.test(draft.baseUrl.trim()))
    return '「' + label + '」的接口地址需以 http(s):// 开头'
  if (draft.apiKey.trim() === '' && !draft.hasApiKey)
    return '「' + label + '」还缺你的 API Key'
  if (draft.model.trim() === '')
    return '「' + label + '」还缺模型名称（以你账户内的模型为准，没有默认模型）'
  return ''
}

/** 打开 Agnes 国内站：桌面壳提供 openApplyPage 时优先走壳，避免被 CSP 拦截。 */
export function openAgnesApplyPage(): void {
  const bridge = typeof window !== 'undefined'
    ? (window as unknown as { zhiyinModel?: { openApplyPage?: () => void } }).zhiyinModel
    : undefined
  if (bridge?.openApplyPage !== undefined) {
    bridge.openApplyPage()
    return
  }
  window.open(AGNES_APPLY_URL, '_blank', 'noopener,noreferrer')
}
