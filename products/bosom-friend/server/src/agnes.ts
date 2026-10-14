/**
 * Agnes AI 官方规格：内置服务商的接口地址与各模态的**参数契约**。
 *
 * 产品只内置一家服务商（Agnes AI，用户填一个 API Key），但**不内置任何大模型**：
 * 用哪个型号完全由用户在「设置 → 配置大模型」里填（可用「获取可用模型」从服务商读回真实清单）。
 * 本模块因此**没有模型目录、没有默认型号**——只有"用户配了某个 Agnes 型号时，请求该怎么发"。
 *
 * 为什么参数契约必须写死在这一层：时长/比例/分辨率都是**官方白名单**（传错直接 400，
 * 或者被静默标准化），而产品侧原先散落的硬编码（图片像素尺寸、每个模型都宣称支持 720p/1080p）
 * 与官方不一致，于是"选了 1080p 出的还是 720p""比例没作用到成品"。
 *
 * 本模块只放**官方文档里逐条核对过**的事实，纯常量与纯函数，不碰网络与存储：
 * - 文本：OpenAI 兼容 `POST /v1/chat/completions`（`https://api.agnes-ai.cn/v1`），走内核模型能力面；
 * - 图片与视频的端点、请求字段与档位映射已经搬进内核媒体能力面
 *   （`packages/media/media-pi-ai/src/vendor.ts`，那份实现自带用例）；产品侧不再持有这些 HTTP 事实。
 *
 * 官方依据（2026-09-17 逐页核对）：Agnes-Ai Docs 的 Overview / Agnes Video 2.5 / Agnes Video 2.5 Flash /
 * Agnes Image 2.5 Flash 四页；**提示词规范**（视频六段结构、图像结构、参考素材占位符）见本文件末尾，
 * 依据同站的《Agnes Video 2.5 · 提示词建议》与《Agnes Image 2.5 Flash · 推荐提示词结构》两节。
 * @module @deepseek-ai/dsh-bosom-friend-server/agnes
 */

/** Agnes 国内站接口基址；内置服务与"只填了一个 Key"的用户都用它。 */
export const AGNES_BASE_URL = 'https://api.agnes-ai.cn/v1'

/** 内置服务的展示名（设置页与生成记录里显示的就是这个名字）。 */
export const AGNES_DISPLAY_NAME = 'Agnes AI（内置）'

/** 内置服务在设置页里的固定 id：不可删除，用户只填 API Key。 */
export const AGNES_PROVIDER_ID = 'agnes-builtin'

/** 内核注册用的 API 协议：Agnes 全站兼容 OpenAI 风格接口。 */
export const AGNES_PROTOCOL = 'openai-completions'

/**
 * 厂商给出的档位/素材上限只对**内置规格里核对过的型号**成立。
 *
 * 表里没有的型号（含用户自己填的自定义厂商模型）不猜它的能力：按用户档位下单，
 * 厂商以参数不合法拒收时按它自报的合法档位降一档并记住结论。
 */

// ---------------------------------------------------------------------------
// 图片与视频的**参数契约**（档位/画幅/时长映射）已经搬进内核媒体能力面：
// 见 packages/media/media-pi-ai/src/vendor.ts（那份实现有自己的用例）。
// 这里只留产品**仍在用**的厂商事实：基址、展示名、模型能力上限（模型清单接口要按它给档位）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 视频：官方 POST /v1/videos + GET /agnesapi
// ---------------------------------------------------------------------------

/** 官方视频分辨率档位（`size`）。 */
export const AGNES_VIDEO_SIZES = ['720P', '1080P', '1K', '2K'] as const

/** 官方视频画幅白名单（`aspect_ratio`）。 */
export const AGNES_VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const

/** 官方视频时长区间（秒）：`seconds` 是字符串，只收 "4"~"12"。 */
export const AGNES_VIDEO_SECONDS_MIN = 4
export const AGNES_VIDEO_SECONDS_MAX = 12

/** 官方参考素材上限（按模型分：2.5 是 8 张图，Flash 只收 5 张且不支持参考视频）。 */
export interface AgnesVideoLimits {
  images: number
  audios: number
  videos: number
  sizes: string[]
}

const VIDEO_LIMITS: Record<string, AgnesVideoLimits> = {
  'agnes-video-2.5': { images: 8, audios: 3, videos: 1, sizes: [...AGNES_VIDEO_SIZES] },
  'agnes-video-2.5-flash': { images: 5, audios: 3, videos: 0, sizes: ['720P'] },
}

/** 认不出的视频模型按最保守的一档处理：720P、无参考视频（宁可少要，也不要被 400 拒收）。 */
const UNKNOWN_VIDEO_LIMITS: AgnesVideoLimits = { images: 5, audios: 3, videos: 0, sizes: ['720P'] }

/**
 * 某个视频模型的官方参考素材上限与支持档位。
 *
 * @param model - 视频模型 ID。
 * @returns 该模型的官方上限；未内置的模型按最保守一档返回。
 */
export function agnesVideoLimits(model: string): AgnesVideoLimits {
  return VIDEO_LIMITS[model] ?? UNKNOWN_VIDEO_LIMITS
}

/** 该视频模型官方支持的分辨率档位。 */
export function agnesVideoSizes(model: string): string[] {
  return [...agnesVideoLimits(model).sizes]
}

/**
 * 这个模型是不是内置 Agnes 视频模型（官方规格里逐条核对过的那两个）。
 *
 * 用户自带厂商的模型名不在表里：那种情况下**不猜**它的档位与素材上限，
 * 由调用方沿用"按用户档位下单，被 400 拒收时按厂商自报的合法档位降档"的既有机制。
 *
 * @param model - 视频模型 ID。
 * @returns true 表示有官方规格可依据。
 */
export function isAgnesVideoModel(model: string): boolean {
  return VIDEO_LIMITS[model] !== undefined
}

// ---------------------------------------------------------------------------
// 提示词规范：官方文档逐条抄录（Agnes-Ai Docs，2026-09-28 核对）
//
// 为什么"提示词怎么写"也属于官方规格：厂商只认提示词里的文字，画面稳不稳一半取决于官方要的
// 那几件事有没有写全。此前这些写法散在分镜层与编排层各写各的，同一家公司出的片子画面口径
// 随内容类型漂移。官方依据：
// - 《Agnes Video 2.5 · 提示词建议》：wiki.agnes-ai.cn/zh-Hans/docs/agnes-video-25
// - 《Agnes Image 2.5 Flash · 推荐提示词结构》：wiki.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash
// ---------------------------------------------------------------------------

/** 官方视频提示词的一段（段落名与官方原文说明）。 */
export interface AgnesPromptField {
  /** 段落标识（用例断言与日志用）。 */
  readonly id: string
  /** 官方给的段落名。 */
  readonly label: string
  /** 官方原文对这一段的说明。 */
  readonly requirement: string
}

/**
 * 官方视频提示词的**六段结构**，顺序即官方给定顺序。
 *
 * 官方给的是顺序要求而不是风格建议：同一句主体描述，按这六段写全的提示词比只写一句稳定得多。
 */
export const AGNES_VIDEO_PROMPT_FIELDS: readonly AgnesPromptField[] = [
  { id: 'subject', label: '主体与场景', requirement: '明确人物、物体、环境和时间' },
  { id: 'action', label: '动作与变化', requirement: '描述主体如何移动，以及场景如何变化' },
  { id: 'camera', label: '镜头语言', requirement: '指定推、拉、摇、移、跟拍、固定镜头或景别' },
  { id: 'style', label: '视觉风格', requirement: '补充光线、色彩、材质、写实程度和氛围' },
  { id: 'sound', label: '声音与节奏', requirement: '需要时描述环境声、动作声或引用音频素材' },
  { id: 'consistency', label: '一致性要求', requirement: '说明需要保持不变的主体外观、产品细节或构图' },
]

/**
 * 官方六段结构的写法要求，可直接拼进提示词。
 *
 * @returns 形如 `1) 主体与场景（明确人物、物体、环境和时间）；2) …` 的一行要求。
 */
export function agnesVideoPromptStructureText(): string {
  return AGNES_VIDEO_PROMPT_FIELDS
    .map((field, index) => String(index + 1) + ') ' + field.label + '（' + field.requirement + '）')
    .join('；')
}

/**
 * 官方图像提示词结构：官方按三种输入各给一套模板，逐字抄录。
 *
 * 与视频六段的差别是没有"声音与节奏"；而**多图合成**多出"参考图角色"这一项，
 * 与视频 reference 模式的占位符要求同源。
 */
export const AGNES_IMAGE_PROMPT_STRUCTURES = {
  /** 文生图（没有输入图）。 */
  textToImage: '[主体] + [场景 / 环境] + [风格] + [光照] + [构图] + [质量要求]',
  /** 图生图（以一张图为底改）。 */
  imageToImage: '[改变要求] + [新风格 / 场景] + [需要添加或移除的元素] + [需要保留的元素]',
  /** 多图合成（多张图各自担任一个角色）。 */
  multiImage: '[参考图角色] + [目标场景] + [图像之间的关系] + [风格 / 光照 / 构图]',
  /** 高信息密度（画面元素多时要求写清视觉层次）。 */
  highDensity: '[主要主体] + [背景环境] + [重要次要细节] + [风格] + [光照] + [构图约束]',
} as const

/**
 * 图像提示词的增强要求（官方《Agnes Image 2.5 Flash · 推荐提示词结构》口径）。
 *
 * 与视频口径的差别在于**按输入形态选结构**：没有参考图走文生图结构、一张走图生图结构、
 * 多张走多图合成结构。官方对多图合成的要求是"说明每张参考图的角色，以及最终图像应如何
 * 组合这些参考信息"——不指名时厂商只把多张图当一堆素材，合成关系由它自由决定。
 * 视频那套六段（含"声音与节奏"）在这里不适用：图像没有声音这一维。
 *
 * @param text - 用户写的原始提示词。
 * @param referenceCount - 这次带入的参考图张数；0 表示文生图。
 * @returns 并进模型提示词的写作要求。
 */
export function enhanceImagePromptInstruction(text: string, referenceCount = 0): string {
  const structure = referenceCount >= 2
    ? '多图合成：' + AGNES_IMAGE_PROMPT_STRUCTURES.multiImage
      + '（**每一张参考图都要指名并写明它当什么用**：' + agnesMediaPlaceholder('picture', 0)
      + ' 是人物身份参考、' + agnesMediaPlaceholder('picture', 1) + ' 是产品/设备外观参考，以此类推）'
    : referenceCount === 1
      ? '图生图：' + AGNES_IMAGE_PROMPT_STRUCTURES.imageToImage
        + '（"需要保留的元素"必须写清：人物面部与发型、产品外形、原始构图里哪些不能变）'
      : '文生图：' + AGNES_IMAGE_PROMPT_STRUCTURES.textToImage
  return '把下面这段用户原话整理成一段可直接用于 AI 生成**图片**的画面提示词：'
    + '1. **用户原话里的每一项都要保留**——主体、场景、风格、光线、构图，以及原话点名的机构、工种、'
    + '主题词（例如"无人机装调检修操作工""免费就业培训"），一律照抄，不许改写、不许概括、不许丢项；'
    + '同时不得编造用户没提到的品牌、参数、功效与人物身份；'
    + '2. **按官方推荐的结构写全，顺序照写、一项都不许省**——这次是' + structure + '；'
    + '3. **把「感觉词」翻译成可执行的画面指令**：用户写了「高级 / 大气 / 有质感 / 治愈」这类词时，'
    + '不许原样保留、更不许再堆同类形容词，要换成具体的：景别与机位、光线方向与色温、'
    + '景深与焦点、空间布局与构图、材质质感；'
    + '4. 写清画面里**不出现**什么：文字、logo、水印、二维码、第二个人、用户没提到的道具'
    + '（画面里的文字一律由后期叠加，模型不要试图画字）；'
    + '5. 写成**一整段中文**，120~260 字，不要分点、不要编号、不要标题、不要解释；'
    + '6. 不写营销文案、不写价格与优惠口号，只描述画面里能看到什么。'
    + '用户原话：' + text
}

/** 官方参考素材占位符的种类。 */
export type AgnesMediaKind = 'picture' | 'audio' | 'video'

/**
 * 官方参考素材占位符：图片 `<Picture N>`、音频 `<Audio N>`、视频 `<Video N>`，各自从 1 开始编号。
 *
 * 编号对的是**该素材在自己的数组里的下标**（`images` 里的第二张写 `<Picture 2>`），
 * 不是全部素材加在一起的总序号。
 *
 * @param kind - 素材种类。
 * @param index - 该素材在自己的数组里的下标（0 起）。
 * @returns 官方占位符写法。
 */
export function agnesMediaPlaceholder(kind: AgnesMediaKind, index: number): string {
  const tag = kind === 'picture' ? 'Picture' : kind === 'audio' ? 'Audio' : 'Video'
  return '<' + tag + ' ' + String(index + 1) + '>'
}

/**
 * 参考图的用途指代句：官方要求在 reference 模式写明占位符**及其用途**。
 *
 * 官方口径是"以 `<Picture 1>` 为角色参考"比只上传素材不解释用途更容易获得可控结果；
 * 本项目另有一条实测依据：多张参考图不指名时，厂商会把同一人物的不同角度当成多个人画进同一画面。
 *
 * @param purposes - 按 `images` 数组顺序给出的每张参考图用途；空串表示这一张不指代。
 * @returns 以 `；` 分隔的指代句；没有任何用途时返回空串。
 */
export function agnesPictureReferenceClause(purposes: readonly string[]): string {
  const parts: string[] = []
  purposes.forEach((purpose, index) => {
    const text = purpose.trim()
    if (text !== '') parts.push(agnesMediaPlaceholder('picture', index) + ' 是' + text)
  })
  return parts.join('；')
}
