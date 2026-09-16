/**
 * userLlm - 浏览器里的模型配置副本（只读缓存 + 密钥回填）
 *
 * **唯一权威是服务端 `llm-user.json`**（设置页保存时写入，并投影到内核的 settings.yaml/.credentials.yaml）。
 * 这里的 localStorage 副本只做两件事：
 *   1. 服务端不回显密钥，设置页用它回填"你的 API Key"输入框；
 *   2. 首次启动且服务端还没有任何配置时，做一次迁移。
 * 除迁移外，本副本**不再回写服务端**：历史上每次启动整份 PUT 回去，
 * 一次局部同步就会冲掉设置页配好的多服务配置。
 */

export interface UserLlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 图片模型（OpenAI 兼容 /images/generations），选填。 */
  imageBaseUrl?: string
  imageApiKey?: string
  imageModel?: string
  /** 视频模型（OpenAI 兼容 /videos/generations 或厂商扩展），选填。 */
  videoBaseUrl?: string
  videoApiKey?: string
  videoModel?: string
  /** 展示名称（设置页服务商卡片标题）。 */
  displayName?: string
  /** API 协议标识（openai-completions 等）。 */
  protocol?: string
  /** 模型目录：可选模型 id，第一个为当前对话模型。 */
  models?: string[]
  /** 模型 id -> 显示名称。 */
  modelLabels?: Record<string, string>
}

const STORAGE_KEY = 'bosom-friend-user-llm'

export function loadUserLlm(): UserLlmConfig | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as Partial<UserLlmConfig>
    // 要求：密钥、接口、模型三者都必须由用户显式提供（无默认模型）
    if (typeof cfg.apiKey !== 'string' || cfg.apiKey.trim() === '') return null
    if (typeof cfg.baseUrl !== 'string' || !/^https?:\/\//.test(cfg.baseUrl)) return null
    if (typeof cfg.model !== 'string' || cfg.model.trim() === '') return null
    const models = Array.isArray(cfg.models) ? cfg.models.filter(item => typeof item === 'string' && item.trim() !== '') : []
    const modelLabels = typeof cfg.modelLabels === 'object' && cfg.modelLabels !== null ? cfg.modelLabels : {}
    return {
      baseUrl: cfg.baseUrl.trim(),
      apiKey: cfg.apiKey.trim(),
      model: cfg.model.trim(),
      ...(typeof cfg.displayName === 'string' && cfg.displayName.trim() !== '' ? { displayName: cfg.displayName.trim() } : {}),
      ...(typeof cfg.protocol === 'string' && cfg.protocol.trim() !== '' ? { protocol: cfg.protocol.trim() } : {}),
      ...(models.length > 0 ? { models } : {}),
      ...(Object.keys(modelLabels).length > 0 ? { modelLabels } : {}),
      ...(typeof cfg.imageModel === 'string' && cfg.imageModel.trim() !== '' ? { imageBaseUrl: (cfg.imageBaseUrl || cfg.baseUrl).trim(), imageApiKey: (cfg.imageApiKey || cfg.apiKey).trim(), imageModel: cfg.imageModel.trim() } : {}),
      ...(typeof cfg.videoModel === 'string' && cfg.videoModel.trim() !== '' ? { videoBaseUrl: (cfg.videoBaseUrl || cfg.baseUrl).trim(), videoApiKey: (cfg.videoApiKey || cfg.apiKey).trim(), videoModel: cfg.videoModel.trim() } : {}),
    }
  } catch {
    return null
  }
}

export function saveUserLlm(cfg: UserLlmConfig | null): void {
  if (typeof window === 'undefined') return
  if (cfg && cfg.apiKey.trim() !== '' && /^https?:\/\//.test(cfg.baseUrl.trim()) && cfg.model.trim() !== '') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      baseUrl: cfg.baseUrl.trim(),
      apiKey: cfg.apiKey.trim(),
      model: cfg.model.trim(),
      ...(cfg.displayName ? { displayName: cfg.displayName.trim() } : {}),
      ...(cfg.protocol ? { protocol: cfg.protocol.trim() } : {}),
      ...(cfg.models && cfg.models.length > 0 ? { models: cfg.models } : {}),
      ...(cfg.modelLabels && Object.keys(cfg.modelLabels).length > 0 ? { modelLabels: cfg.modelLabels } : {}),
      ...(cfg.imageModel ? { imageBaseUrl: (cfg.imageBaseUrl || cfg.baseUrl).trim(), imageApiKey: (cfg.imageApiKey || cfg.apiKey).trim(), imageModel: cfg.imageModel.trim() } : {}),
      ...(cfg.videoModel ? { videoBaseUrl: (cfg.videoBaseUrl || cfg.baseUrl).trim(), videoApiKey: (cfg.videoApiKey || cfg.apiKey).trim(), videoModel: cfg.videoModel.trim() } : {}),
    }))
  }
  else {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}
