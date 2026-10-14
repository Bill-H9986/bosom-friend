/**
 * 长视频产出与数字人形象库接口。
 *
 * 后端只有一条长视频工作流（写稿 → 切段 → 逐段生成 → 拼接），
 * 内容形式的差别全在 `producer` 字段上：`digital-human`（数字人口播）与 `scene`（场景呈现）。
 * 前端因此只对接一个生成入口，新增内容形式不需要改这里的调用方式。
 *
 * @module @web/api/longVideo
 */
import http from '@web/utils/request'

/** 固定 AI 数字人形象（带货 IP）：一份形象素材 + 一种念法。 */
export interface DigitalHuman {
  id: string
  name: string
  /** 形象图：上传的照片本身，或从视频里抽出的首帧。 */
  avatarUrl: string
  /** 视频建的才有：服务端从素材里裁出的参考视频（动作与说话方式从它延续）。 */
  sourceVideoUrl?: string
  /** 念法 id（查 DigitalHumanPersona）；老数据没有这个字段。 */
  persona?: string
  /** 老数据的音色 id：只读，新数据不再写它，只在缺 persona 时参与服务端的念法折算。 */
  voice?: string
  /** 老数据的演绎风格 id：与 voice 同理。 */
  voiceStyle?: string
  seed: number
  createdAt: string
  updatedAt: string
}

/**
 * 一条可选念法：写进厂商提示词的声音人设。
 *
 * 声音由厂商在出片时按 prompt 自己念，厂商侧没有"音色 id"这种概念，
 * 因此两个字段服务两个读者：summary 给用户看，prompt 给厂商看。
 */
export interface DigitalHumanPersona {
  id: string
  name: string
  /** 给用户看的一句话：这条声音是什么味道、适合什么内容。 */
  summary: string
  /** 写进厂商提示词的声音描述：**不面向用户**，界面不得展示。 */
  prompt: string
}

/** 念法目录与参考样句。 */
export interface PersonaCatalog {
  list: DigitalHumanPersona[]
  /** 没选过时的默认念法 id。 */
  defaultPersona: string
  /** 参考台词样板：给用户照着写口播稿的语气样板。 */
  sampleText: string
}

/** 可选的内容形式（后端的片段生成器注册表）。 */
export interface LongVideoProducerInfo {
  kind: string
  name: string
  description: string
  /**
   * 这个内容形式要不要出镜（要不要选数字人）。
   *
   * 由后端给，不在前端再抄一份名单：谁出镜是服务端的事实（`producerFor` 里那些形式缺形象会直接拒单），
   * 前端抄一份就会出现"页面让选、后端不认"或反过来的漂移。
   */
  needsHuman: boolean
}

/** 成片的一段。 */
export interface LongVideoSegment {
  index: number
  text: string
  audioSeconds: number
  videoUrl?: string
}

/** 镜头类型：决定画面里是什么（与"谁来生成"是两件事）。 */
export type LongVideoShotKind = 'talking-head' | 'product' | 'scene' | 'text-card'

/** 一张参考图的本机素材地址与它的角色。 */
export interface LongVideoShotRef {
  url: string
  role: 'person' | 'product' | 'style'
}

/**
 * 一个镜头：通用编排的最小单位，也是分镜预览与逐镜重做的依据。
 *
 * 落盘在后端任务上，所以刷新页面后仍能看到这张分镜表、并对不满意的某一镜单独重做。
 */
export interface LongVideoShot {
  index: number
  kind: LongVideoShotKind
  /** 这一镜的目标时长（秒）；口播镜以配音真实时长为准。 */
  seconds: number
  /** 口播文本；产品镜/空镜为空串。 */
  line: string
  /** 画面提示词（非口播镜必填）。 */
  visual: string
  continuity: string
  references: LongVideoShotRef[]
  provider: string
  beat?: 'hook' | 'pain' | 'product' | 'cta'
  status: 'planned' | 'ready' | 'failed'
  errorMessage?: string
}

/** 一条长视频任务。 */
export interface LongVideoTask {
  id: string
  producer: string
  producerRef?: string
  topic: string
  targetSeconds: number
  resolution: string
  aspectRatio: string
  withSubtitles?: boolean
  status: 'generating' | 'success' | 'failed'
  doneSegments: number
  totalSegments: number
  segments: LongVideoSegment[]
  /** 分镜表：这条成片的镜头序列（口播镜与产品镜交替）。 */
  shots?: LongVideoShot[]
  /**
   * 每一镜对应的成片文件（镜号 → 本地路径）。
   *
   * 界面用它算"这条片已经跑成几镜"——中断收尾之后 `doneSegments` 仍是中断前的口径，
   * 而"能不能从断点继续"取决于盘上真的有几镜成片。
   */
  shotFiles?: Record<string, string>
  /** 生成这条成片用的稿件正文（长度校准后的最终稿）。 */
  scriptText?: string
  /** 稿件字数（**不含标点**）：与语速同一把尺子（门槛与折算都用它）。 */
  scriptChars?: number
  /**
   * 母时钟量到的成片时长（秒）：全片配音第一次合成完的真实合计。
   *
   * 它与 {@link LongVideoTask.targetSeconds} 的差距在**任何厂商画面调用之前**就已确定，
   * 界面据此如实回报"按这版稿子成片约 N 秒"，而不是等逐镜跑完再让用户发现短了一截。
   */
  voicedSeconds?: number
  videoUrl?: string
  errorMessage?: string
  /** 失败原因的分类码；`script-too-short` = 稿件字数不足（界面据此给补写入口）。 */
  errorCode?: string
  createdAt: string
  updatedAt: string
}

/** 读数字人形象列表。 */
export function listDigitalHumans() {
  return http.get<{ list: DigitalHuman[] }>('digital-humans', undefined, true)
}

/**
 * 读念法目录、默认念法与参考样句。
 *
 * 没有音色清单与试听：成片里那一声由厂商在出片时按念法描述念，厂商侧没有"音色 id"这种概念。
 */
export function listPersonas() {
  return http.get<PersonaCatalog>('digital-humans/personas', undefined, true)
}

/**
 * 新建数字人形象。
 *
 * @param body - 名字、形象素材地址与念法 id；素材可以是照片或视频，视频由服务端抽首帧当形象并留一段参考视频。
 */
export function createDigitalHuman(body: { name: string, avatarUrl: string, persona: string }) {
  return http.post<DigitalHuman>('digital-humans', body, true)
}

/** 删除数字人形象。 */
export function deleteDigitalHuman(id: string) {
  return http.delete<{ removed: number }>(`digital-humans/${encodeURIComponent(id)}`, undefined, true)
}

/** 读可选内容形式。 */
export function listProducers() {
  return http.get<{ list: LongVideoProducerInfo[] }>('long-videos/producers', undefined, true)
}

/** 起一条长视频任务（立即返回任务 id，进度靠轮询）。 */
export function startLongVideo(body: {
  producer: string
  producerRef?: string
  topic: string
  targetSeconds: number
  aspectRatio?: string
  /** 是否把口播文本烧成画面字幕；缺省烧。 */
  withSubtitles?: boolean
  /** 成片分辨率档位（720p / 1080p）；缺省 1080p（长片更值得清晰度）。 */
  resolution?: string
  /**
   * 可选的产品参考图（本机素材 URL）。
   *
   * 传了：产品镜以**真实产品**为主体（画面不会画错外形与包装）；
   * 不传：产品镜退化为纯描述，画面里不出现任何文字与品牌。两种都能出片。
   */
  productImageUrl?: string
}) {
  return http.post<{ taskId: string, estimate: LongVideoEstimate }>('long-videos', body, true)
}

/**
 * 重做某一镜：只重跑这一镜，随后整条自动重新拼接。
 *
 * 为什么只重做一镜而不是整条重跑：一条 120 秒的片子有 20 多镜，跑一次十几分钟；
 * 某一镜不满意就整条重来，用户等不起也花不起。这是"可返工"这条能力的落点。
 */
export function redoLongVideoShot(taskId: string, index: number) {
  return http.post<{ index: number, seconds: number }>(
    `long-videos/${encodeURIComponent(taskId)}/shots/${String(index)}/redo`,
    undefined,
    true,
  )
}

/**
 * 从断点继续：只跑还没跑成的镜，随后按镜头顺序重新拼整条。
 *
 * 为什么要有这条：一条 90 秒的片子是 18 镜、十几次厂商调用。应用被关掉或重启之后，
 * 已经跑成的那几镜不能白花——没有这条出口时，用户只能整条重跑。
 *
 * 与起任务同一口径：立即回执，进度靠轮询。
 */
/** 某一档位的稿件字数门槛（按这条内容形式的语速折算，**不含标点**）。 */
export interface ScriptRequirement {
  targetSeconds: number
  requiredChars: number
  /** 折算用的语速（字/秒，去标点口径）。 */
  charsPerSecond: number
  /** 写稿模型的字数口径（产品默认 4.5 字/秒，去标点口径）。 */
  writerPaceCharsPerSecond: number
  shots: number
}

/**
 * 读某一档位的稿件字数门槛。
 *
 * 由服务端算而不是前端估：折算用的是服务端给这条内容形式的语速口径，前端猜一个数会与真正的门槛对不上。
 */
export function getScriptRequirement(input: {
  producer: string
  producerRef?: string
  productImageUrl?: string
  targetSeconds: number
}) {
  const params = new URLSearchParams()
  params.set('producer', input.producer)
  params.set('targetSeconds', String(input.targetSeconds))
  if (input.producerRef !== undefined && input.producerRef !== '') params.set('producerRef', input.producerRef)
  if (input.productImageUrl !== undefined && input.productImageUrl !== '') params.set('productImageUrl', input.productImageUrl)
  return http.get<ScriptRequirement>('long-videos/script-requirement?' + params.toString(), undefined, true)
}

/**
 * 按现有稿件再补写一轮（只扩写、不生成视频）。
 *
 * 补写会换掉稿件内容，所以这一步只把稿件扩写并返回给用户看；满意了再点「继续生成」
 * （走 resume 那条：按已定稿的稿件排分镜并出片，不会重复写稿）。
 */
export function extendLongVideoScript(taskId: string) {
  return http.post<{ taskId: string, script: string, chars: number, required: number }>(
    `long-videos/${encodeURIComponent(taskId)}/extend-script`,
    undefined,
    true,
  )
}

/** 从断点继续：只跑还没跑成的镜。 */
export function resumeLongVideoTask(taskId: string) {
  return http.post<{ taskId: string, remaining: number, estimate: LongVideoEstimate }>(
    `long-videos/${encodeURIComponent(taskId)}/resume`,
    undefined,
    true,
  )
}

/**
 * 停止一条正在生成的任务。
 *
 * 一镜要 1~5 分钟，跑一条 90 秒的片子是十几次厂商调用：没有这个出口，用户发现选题写错
 * 也只能眼看着额度被跑完。已经跑成的镜**保留**在任务记录里，因此停完可以走「从断点继续」。
 */
export function stopLongVideoTask(taskId: string) {
  return http.post<{ taskId: string, stopped: boolean }>(
    `long-videos/${encodeURIComponent(taskId)}/stop`,
    undefined,
    true,
  )
}

/**
 * 起任务前的预估：镜数、厂商调用次数与耗时区间。
 *
 * 都是**量级**而不是承诺：厂商排队慢时耗时只会更长，真实进度以逐镜回报的段数为准。
 */
export interface LongVideoEstimate {
  shots: number
  callsMin: number
  callsMax: number
  minutesMin: number
  minutesMax: number
  /**
   * 这条片要多少字的口播稿（**不含标点**，按这条内容形式的语速折算）。
   *
   * 前端的字数提示一律用它，不再自己按某个固定语速估：
   * 前端猜一个数就会与后端真正的门槛对不上，用户照提示写完仍被拒。
   */
  requiredChars: number
  /** 折算用的语速（字/秒，去标点口径）。 */
  charsPerSecond: number
  /** 写稿模型的字数口径（产品默认 4.5 字/秒，去标点口径）。 */
  writerPaceCharsPerSecond: number
}

/** 读任务进度。 */
export function getLongVideoTask(taskId: string) {
  return http.get<LongVideoTask>(`long-videos/${encodeURIComponent(taskId)}`, undefined, true)
}

/**
 * 删除一条长视频生成记录。
 *
 * 删的是记录：成片已经作为草稿进了内容库，删掉它会让那条草稿变成打不开的视频，
 * 所以服务端保留成片、只清中间产物。生成中的记录会被拒绝（后台还在跑）。
 */
export function deleteLongVideoTask(taskId: string) {
  return http.delete<{ removed: number }>(`long-videos/${encodeURIComponent(taskId)}`, undefined, true)
}

/**
 * 批量删除长视频生成记录。
 *
 * 与单条删除同一条口径（删记录不删成片）。生成中的记录**跳过并如实回报条数**，
 * 不让"选中十条里有一条在跑"把剩下九条一起挡住。
 */
export function deleteLongVideoTasks(taskIds: string[]) {
  return http.delete<{ removed: number, skippedGenerating: number, missing: number }>(
    'long-videos',
    { taskIds },
    true,
  )
}

/** 读最近的长视频任务（也用于「生成记录」：刷新后仍能看到历史与进行中的任务）。 */
export function listLongVideoTasks() {
  return http.get<{ list: LongVideoTask[] }>('long-videos', undefined, true)
}

/**
 * 把一句大白话增强成专业创作要求。
 *
 * 只返回文本、不建任务：用户看清结果、确认后才去生成。
 * 未接入大模型或调用失败时后端返回非零码与原因，调用方如实提示。
 */
export function enhanceLongVideoTopic(topic: string) {
  return http.post<{ topic: string }>('long-videos/enhance-topic', { topic }, true)
}