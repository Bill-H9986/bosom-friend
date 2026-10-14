/**
 * 分镜表：把"一段稿子"编排成"一组镜头"，这是通用工作流的核心中间层。
 *
 * 为什么要它：真人带货片里人只出镜一半时间，另一半在拍产品——**镜头交替**才是"像拍过的"的来源。
 * 旧的"写稿 → 按句切段 → 拼接"只会产出"一个人从头念到尾"，段与段之间硬切还在人脸上。
 *
 * 本模块只做三件事，全部是纯函数（可单测、不碰厂商与存储）：
 * 1. 生成给模型的分镜要求（{@link buildStoryboardPrompt}）；
 * 2. 解析并**夹紧**模型返回的分镜表（{@link parseShotPlan}）——模型输出不可信，越界一律夹回来；
 * 3. 模型不可用/输出不可解析时的确定性兜底（{@link fallbackShotPlan}），保证任何情况下都排得出片。
 *
 * 与内容形式无关：镜头卡片（ZyShot）里的 provider 只是字段，
 * 数字人口播、产品特写、场景空镜共用同一套编排。
 * @module @deepseek-ai/dsh-bosom-friend-server/storyboard
 */

// 只依赖无 import 的叶子模块（agnes.ts 与 speech.ts）：分镜层与编排层不能互相 import
// （循环依赖会让常量未初始化，实测踩过）。
import { agnesVideoPromptStructureText } from './agnes.ts'
import { CHARS_PER_SECOND, SEGMENT_MAX_SECONDS, SEGMENT_MIN_SECONDS, beatToneHint, estimateSeconds, minScriptChars, normalizeSpokenText, spokenCharCount, splitScript } from './speech.ts'
import type { ZyShot, ZyShotKind, ZyShotRef } from './types.ts'

/**
 * 单镜目标时长（秒）：**短时长、多片段**。
 *
 * 这是实测结论而不是审美偏好：
 * - 厂商每次只出 4~12 秒，**要得越长，模型在同一镜里越容易飘**（人脸变形、画面拖成慢镜）；
 * - 短视频的剪辑点本来就密（光羽案例实测平均镜头 6.18 秒，其中大量是 3~5 秒的短镜）；
 * - 短镜多，意味着"切在产品上、切在动作上"的机会更多——这正是"像拍过的"的来源。
 */
export const SHOT_TARGET_SECONDS = 5

/** 单镜时长下界：厂商单次生成最短 4 秒，比它更短只会被厂商拉长成慢速念白。 */
export const SHOT_MIN_SECONDS = SEGMENT_MIN_SECONDS

/**
 * 每个画面提示词都要带上的禁令。
 *
 * 两条理由：
 * 1. 实测模型会臆造品牌名与乱码标签，品牌信息只能后期叠加；
 * 2. 平台审核：抖音等平台对画面里的**二维码、电话号、车牌、水印、logo**一律判违规引流/营销，
 *    视频做得再好也会被限流（用户口径的"别他妈好不容易做个视频还限流了"）。
 *    这些元素一旦由模型画进画面，后期只能靠裁剪或打码补救，成本远高于一开始就禁止生成。
 */
export const NO_RENDERED_TEXT = '画面里不出现任何文字（字幕是后期工作，画面必须是干净的实拍）：'
  + '不要出现招牌、门头字、横幅、标语、证书、奖状、制度牌、公告栏、价目表、海报、易拉宝、产品包装上的文字、'
  + '屏幕上的界面文字、水印、logo、二维码、条形码、电话号码、车牌号；'
  + '需要交代机构或场地时，用画面元素（工装、设备、器材、场地）而不是文字'

/**
 * 非口播镜的人物禁令（数字人口播专用）。
 *
 * 为什么必须是硬要求：产品镜与空镜的参考图里只有产品，厂商看不到"这个人长什么样"，
 * 按文字画人只能自己编一张脸——一条片子里因此出现第二个人（用户口径的"明明用一个数字人，
 * 画面里的人却跳到别的数字人去了"）。实测模型很爱写"双手打开瓶盖""一只手托起产品"
 * 甚至"演员侧脸对着镜头"，所以这条禁令既写进分镜提示词，也在真正下单的那一处再补一次。
 */
export const NO_PERSON_CLAUSE = '画面里不出现人脸、不出现第二个人，也不要出现完整人物；产品演示只允许手部出镜，'
  // 手部也要统一到同一个人：实测（成片 29 秒处）第一人称镜头里厂商画了一双**男性的手**——
  // 全片只有一位出镜人物是年轻女性，手出镜时也必须是她（同样的肤色、细长的手、同一件工装的袖口）。
  + '且必须是全片同一位年轻女性的手：肤色与手型一致、袖口是同一件服装，不要出现男性的手、不要出现第三个人的手臂'

/** 一句话是不是在讲"人"（人称、身份、身体、姿态）——非口播镜的提示词不许带这类句子。 */
const PERSON_CLAUSE = /(学员|主播|人物|人脸|正脸|侧脸|背影|视线|眼神|表情|面部|步伐|身穿|穿着|工装|袖口|她|他|姿态|下颌|嘴角)/

/** 这句话是不是"不出现人"的禁令：含人物词但语义是否定，必须原样留着。 */
const PERSON_NEGATION = /(不出现|不要|不许|不得|无需|避免|没有|禁止)[^，。；]{0,10}?(人|脸|人物|第二个|手)/

/**
 * 把非口播镜提示词里的**人物句整句剥掉**。
 *
 * 为什么非口播镜不能带人物句：这些镜**不带人物参考图**（带了就会在画面里长出第二张脸），
 * 厂商只能按文字画人，画出来的一定不是全片主角——实测第五轮的 product 镜里出现了一位
 * 陌生女性、还多画了一位同事，同一镜的场景也从"金属实训台 + 冷白顶光"跳成了另一个绿墙车间。
 * 这一镜的提示词里写着"画面里不出现人脸"，但同一段话又写着"学员从走廊向车间入口移动"，
 * 两条要求互相打架，厂商按后者画了人。
 *
 * 保留两类句子：① 含"不出现人/脸"的**否定禁令**（它正是要留下的约束）；
 * ② 不含人物词的物件、环境、光线、镜头运动描述。手部描述保留（产品镜的手部特写不露脸）。
 *
 * @param visual - 这一镜的画面提示词。
 * @returns 剥掉人物句之后的提示词；一句都不剩时返回空串（由调用方与禁令一起拼接）。
 */
export function stripPersonClauses(visual: string): string {
  return visual
    .split(/(?<=[，,。；;])/)
    .filter(clause => clause.trim() !== '')
    .filter(clause => PERSON_NEGATION.test(clause) || !PERSON_CLAUSE.test(clause))
    .join('')
}


/**
 * 单镜时长上界（秒）：我们主动压在厂商允许的 {@link SEGMENT_MAX_SECONDS} 之下。
 *
 * 厂商能收 12 秒不等于我们应该要 12 秒——12 秒一镜是"一眼 AI"的高发区。
 */
export const SHOT_MAX_SECONDS = 6

/** 编排层允许的最长成片时长（秒），与接口口径一致。 */
export const MAX_FILM_SECONDS = 300

/** 产品镜在整条片里至少要占的镜头数下限（不足则画面会退化成"一个人念稿"）。 */
export const MIN_PRODUCT_SHOTS = 2

/**
 * 目标时长对应的镜头数。
 * @param targetSeconds - 目标成片时长（秒）。
 * @returns 镜头数（至少 2：一个开场、一个收尾）。
 */
export function planShotCount(targetSeconds: number): number {
  const seconds = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : SHOT_TARGET_SECONDS * 4
  // 向上取整：宁可多切一镜，也不把尾巴塞进一个超长镜（"短时长、多片段"这条口径不能松）。
  return Math.max(2, Math.ceil(seconds / SHOT_TARGET_SECONDS))
}

/**
 * 碎片：句末标点 → 逗号顿号 → 按长度硬切。
 *
 * 粒度由 `limit`（一句口播的舒适字数）决定，而不是"能整句就整句"：
 * 整句不切时碎片太粗（一句 20 字），均分到每个镜头时会挤出 29 字与 9 字这种悬殊的邻居。
 * 切开之后分界点落在逗号上，读起来仍是自然的换气点。
 *
 * @param text - 已归一化的稿件正文。
 * @param limit - 单个碎片的字数上限（约一镜说一句的量）。
 * @returns 按原顺序排列的碎片。
 */
function splitIntoPieces(text: string, limit: number): string[] {
  const pieces: string[] = []
  const push = (value: string): void => {
    const part = value.trim()
    if (part !== '') pieces.push(part)
  }
  for (const sentence of text.split(/(?<=[。！？!?；;…])/)) {
    if (sentence.trim().length <= limit) { push(sentence); continue }
    for (const clause of sentence.split(/(?<=[，,、])/)) {
      if (clause.trim().length <= limit) { push(clause); continue }
      for (let i = 0; i < clause.length; i += limit) push(clause.slice(i, i + limit))
    }
  }
  return pieces
}

/**
 * 把碎片拆到至少有 `parts` 块：一句长台词只值一块时，后面的镜头就没话说了。
 *
 * 为什么必须拆够：`fitScriptToShots` 是"按镜头数分配稿件"，块数少于镜头数就只能让多出来的镜头
 * **留着模型自己写的那句**——一份台词混两个来源，覆盖整段稿件这条保证当场失效
 * （实测：稿件 218 字 + 模型写的 20 句 → 合计 427 字，且顺序错位）。
 *
 * @param pieces - 已切好的碎片（按原顺序）。
 * @param parts - 需要的块数。
 * @returns 至少 parts 块碎片；稿件总字数少于 parts 时按实际字数返回（一个字一块，拆不动了）。
 */
function splitUntilEnough(pieces: string[], parts: number): string[] {
  const work = [...pieces]
  while (work.length < parts) {
    let longest = 0
    for (let i = 1; i < work.length; i += 1) if (work[i]!.length > work[longest]!.length) longest = i
    const piece = work[longest]!
    if (piece.length < 2) break
    const cut = Math.ceil(piece.length / 2)
    work.splice(longest, 1, piece.slice(0, cut), piece.slice(cut))
  }
  return work
}

/**
 * 把碎片按字符数均分成 `parts` 块：第 k 个分界点取最接近"总字数 × k / parts"的碎片边界。
 *
 * 均分而不是"每块固定切满"：固定切法会把零头全甩到最后一块，于是最后一镜特别长、
 * 前面几镜特别短（实测那种"最后一句要念十秒"的观感就是这么来的）。
 *
 * @param pieces - 已切好的碎片（按原顺序）。
 * @param parts - 要分成的块数。
 * @returns 恰好 parts 个分块；碎片不足以分成 parts 块时按实际块数返回。
 */
function balancePieces(pieces: string[], parts: number): string[] {
  const prefix = [0]
  for (const piece of pieces) prefix.push(prefix[prefix.length - 1]! + piece.length)
  const total = prefix[prefix.length - 1]!
  const bounds = [0]
  for (let k = 1; k < parts; k += 1) {
    const target = (total * k) / parts
    const start = bounds[k - 1]!
    // 后面每个镜头至少留一个碎片：边界最远只能到"剩余碎片数 = 剩余镜头数"的位置。
    const lastAllowed = pieces.length - (parts - k - 1)
    let best = Math.min(start + 1, lastAllowed)
    let bestDistance = Number.POSITIVE_INFINITY
    for (let i = start + 1; i <= lastAllowed; i += 1) {
      const distance = Math.abs(prefix[i]! - target)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    bounds.push(best)
  }
  bounds.push(pieces.length)
  const chunks: string[] = []
  for (let k = 0; k < parts; k += 1) chunks.push(pieces.slice(bounds[k]!, bounds[k + 1]!).join(''))
  return chunks
}

/**
 * 把已定稿的稿件按镜头数分配下去：这是"这条片会说多少字"的**唯一出口**。
 *
 * 为什么必须由我们切，而不是让分镜模型自己写词：配音按分镜的 line 合成，成片时长因此由 line 决定。
 * 实测三次把稿件交给分镜模型并明确要求"逐字照抄、覆盖整段"之后，它仍然改写成 59%~83% 的长度
 * （90 秒的片子 218~335 字），成片跟着短掉四分之一（用户口径的"口播文案太短、内容太少"，DEF-132）。
 * 模型可以做的是**画面**（哪一镜拍什么、什么节拍），词由稿件说了算。
 *
 * 只改 line 与 seconds：kind / visual / beat / continuity / references 都是模型排分镜的成果，
 * 一律保留——画面与口播的对应关系因此还在（模型是照着稿件顺序写画面的）。
 *
 * @param shots - 模型排出的分镜（line 会被替换）。
 * @param script - 已定稿的稿件正文。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @returns 台词来自稿件、与镜头一一对应的分镜。
 */
export function fitScriptToShots(shots: ZyShot[], script: string, charsPerSecond = CHARS_PER_SECOND): ZyShot[] {
  const text = normalizeSpokenText(script)
  if (shots.length === 0 || text === '') return shots
  // 碎片粒度取"一镜说一句"的量（目标单镜 5 秒），均分才有得选。
  const limit = Math.max(4, Math.round(SHOT_TARGET_SECONDS * charsPerSecond))
  const chunks = balancePieces(splitUntilEnough(splitIntoPieces(text, limit), shots.length), shots.length)
  return shots.map((shot, index) => {
    // 稿件比镜头数还短（稿件门槛本不该放它过）时拆不出这么多块：多出来的镜头没有台词可念。
    // 这里给空串而**不是**留着模型自己写的那句——一份台词混两个来源，覆盖整段稿件这条保证就没了；
    // 空台词的镜会在配音阶段被跳过，成片少一句话，但至少说的全是稿件里的话。
    const line = chunks[index] ?? ''
    return { ...shot, line, seconds: estimateSeconds(line, charsPerSecond) }
  })
}

/**
 * 分镜台词合计的字数（去标点）。
 *
 * 为什么要单独一条：**这条片实际会说多少字由分镜的 line 决定，不由稿件决定**——
 * 配音按 line 合成、画面按 line 的时长生成，稿件只是一份"原料"。
 * 实测一条 90 秒的任务：稿件 448 字（过了稿件门槛），分镜的 line 加起来只有 335 字，
 * 成片因此只有 80.5 秒，四分之一的内容没进片子（用户口径的"口播文案太短、内容太少"，DEF-132）。
 *
 * @param shots - 分镜表（含各镜的台词）。
 * @returns 去标点后的总字数。
 */
export function shotsSpokenChars(shots: ZyShot[]): number {
  return shots.reduce((total, shot) => total + spokenCharCount(shot.line), 0)
}

/**
 * 分镜的台词够不够撑起目标时长。
 *
 * 口径与稿件门槛（{@link minScriptChars}）完全一致：同一把语速尺子、同样去标点，
 * 否则"稿件够了"与"分镜够了"会用两个标准判同一件事。
 *
 * @param shots - 分镜表（含各镜的台词）。
 * @param targetSeconds - 目标成片时长（秒）。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值。
 * @returns chars 分镜台词合计字数；required 目标时长折算的字数下限；covered 是否够。
 */
export function shotsCoverTarget(
  shots: ZyShot[],
  targetSeconds: number,
  charsPerSecond = CHARS_PER_SECOND,
): { chars: number, required: number, covered: boolean } {
  const chars = shotsSpokenChars(shots)
  const required = minScriptChars(targetSeconds, charsPerSecond)
  return { chars, required, covered: chars >= required }
}

/**
 * 生成分镜要求（并进写稿提示词）。
 *
 * 四条硬约束不是风格偏好，都是实测结论：
 * - **产品镜必须占一定比例**：否则成片就是"一个人念稿"；
 * - **每一镜都要有 line**（含 product/scene 镜）：画面切到产品只是画面切走，旁白不能停，
 *   否则成片里会出现整段完全静音的画面（用户口径的"5 秒死寂"）；
 * - **画面里不出现任何文字/logo**：文生图/文生视频会生成臆造品牌（实测出现过乱码标签），
 *   品牌文字一律走后期叠加；
 * - **连续性描述全片一致**：光线/背景/服装写在每一镜里，跨镜才不会各长一套。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param hasProductReference - 用户是否提供了产品参考图（决定产品镜走"照着产品"还是"纯描述"）。
 * @param options - 语气与人物口径，见 {@link StoryboardPromptOptions}。
 * @returns 并进提示词的分镜要求。
 */
/**
 * 从用户填的"产品与卖点"里取题材关键词：画面要对得上内容，靠的就是它。
 *
 * 做法是确定性的，不再多花一次模型调用：按标点切句，取最前面几句里的名词性短语
 * （去标点后 2~8 个字的片段），去重后拼成一行。抽不出东西时返回空串，调用方据此
 * 退回原行为（宁可没有题材约束，也不要塞一句编出来的题材）。
 *
 * @param topic - 用户填写的产品与卖点全文。
 * @param maxChars - 题材描述的字数上限，默认 24（太长会把提示词淹没）。
 * @returns 题材关键词串（可能为空串）。
 */
export function subjectFromTopic(topic: string, maxChars = 48): string {
  const parts = topic
    .split(/[。！？；\n.!?;]/)
    .map(part => part.replace(/[\s，、,：:「」“”"'（）()【】\[\]—-]/g, ''))
    .filter(part => part.length >= 2)
  const picked: string[] = []
  let total = 0
  for (const part of parts) {
    // 取整句（首句常常就是题材本身，截到 12 字会把"无人机装调检修"切掉半截）。
    const snippet = part.slice(0, 20)
    if (snippet === '' || picked.includes(snippet)) continue
    if (total + snippet.length > maxChars && picked.length > 0) break
    picked.push(snippet)
    total += snippet.length
    if (picked.length >= 2) break
  }
  return picked.join('、')
}

export interface StoryboardPromptOptions {
  /** 这条音色的实测语速（字/秒）；缺省用产品默认值（每镜字数与全片字数下限都按它折算）。 */
  charsPerSecond?: number
  /**
   * 视频类型的**运镜白名单**（对标 Seedance 的镜头语言）。
   *
   * 给了就要求每一镜的 visual 从里面挑一种写清楚：厂商只认文字，不写运镜时画面就是"机位不动、
   * 人物站着说完"——走动 VLOG、开箱、教程这些类型之间的差别，一半就在这份运镜清单上。
   */
  cameraMoves?: readonly string[]
  /**
   * 用户写的**画面要求原文**（长视频创作里就是「产品与卖点」框里那段）。
   *
   * 为什么要它：分镜模型只按我们给的模板排画面，用户写在框里的镜头语言、光线、声音、构图
   * **到不了它眼前**——实测把一段 217 字的完整画面要求填进去，只有 20 字被当成"题材关键词"
   * （手持跟拍／冷蓝／颗粒感／电机嗡嗡声等 15 项全部丢失），成片自然跑偏。
   * 这一项把原文整段交给分镜模型，并要求逐条落实。
   */
  visualBrief?: string
  /**
   * 这一类型**额外**要求 visual 写清的几件事（顺序即写法）。
   *
   * 官方六段结构是每一镜的底线（见 {@link buildStoryboardPrompt} 第 10 条），这里是类型之上的加成：
   * 口播短视频要"近景 + 少运镜"，开箱要"俯拍 + 手部特写"。
   */
  visualStructure?: string
  /** 单镜时长区间（秒）；缺省用产品的 4~6 秒口径。 */
  shotSeconds?: { readonly min: number; readonly max: number }
  /**
   * 非口播镜最少占几成（0~1）；缺省按产品的 40% 口径。
   *
   * 类型之间对"看得见实物"的要求不同：开箱测评与步骤教程必须让产品/手部占大头，
   * 而口播短视频可以以人物为主——这条比例就是这种差别，别让它停在口头约定上。
   */
  minProductRatio?: number
  /**
   * 这条片子是不是**以人物出镜为主**（走动 VLOG / 口播类）。
   *
   * 打开后会给非口播镜一个**上限**：这类片子的主角是人，手部特写与空镜只是穿插。
   * 实测不设上限时，模型把手部特写排到 9/12 镜，成片像一部没有主角的操作教学片。
   */
  personLed?: boolean
  /**
   * 只有口播镜能出现人物（数字人口播用）。
   *
   * 打开后：非口播镜的 visual 里不许描述人物与动作主体是人，口播镜也不许描述长相与服装
   * （长相由形象参考图决定，文字再写一遍只会让模型自己编）。
   */
  personOnlyInTalkingHead?: boolean
  /**
   * 这条片子讲的是什么（题材关键词，取自用户填的产品与卖点）。
   *
   * 为什么要有它：没有产品参考图时，画面全靠文字描述自由发挥，模型会给出与该题材无关的
   * 通用素材（实测：无人机培训片里出现手机充电、室内伸懒腰）。把题材写进要求里，画面才有
   * 机会对上内容；它同时也进 continuity，保证全片的场景是同一条线。
   */
  subject?: string
  /**
   * 允许"没有产品参考图也排 B-roll（空镜/场景镜）"。
   *
   * 这条是融合创作的核心：数字人口播镜的画面由形象图决定，**场地与设备只有 B-roll 能带进来**；
   * 而"没有产品图就不排产品镜"这条老口径会把整条片压成清一色的人物口播
   * （实测：无人机培训 22/22 镜全是口播，成片里没有任何设备与场地）。
   */
  allowBrollWithoutProduct?: boolean
  /**
   * 已定稿的口播稿件：给了它，模型的任务就从"自己写词"变成"把这段词按顺序分给各镜"。
   *
   * 为什么必须把稿件交给排分镜的模型：配音按**分镜的 line** 合成，成片时长因此由 line 决定，
   * 而稿件是**已经按目标时长校准过**的那一份。分镜模型看不到稿件时只能自己重写一遍，
   * 实测四次都只写出目标字数的 58%~91%（90 秒的片子 215~335 字，门槛 369 字），
   * 成片跟着短一截、内容也少一截——用户口径的"口播文案太短、内容太少"（DEF-132）。
   */
  script?: string
}

export function buildStoryboardPrompt(
  targetSeconds: number,
  hasProductReference: boolean,
  options: StoryboardPromptOptions = {},
): string {
  const charsPerSecond = options.charsPerSecond !== undefined && options.charsPerSecond > 0
    ? options.charsPerSecond
    : CHARS_PER_SECOND
  const subject = (options.subject ?? '').trim()
  const allowBroll = options.allowBrollWithoutProduct === true
  const shots = planShotCount(targetSeconds)
  const ratio = options.minProductRatio !== undefined && options.minProductRatio > 0 && options.minProductRatio <= 1
    ? options.minProductRatio
    : 0.4
  const productShots = Math.min(shots, Math.max(MIN_PRODUCT_SHOTS, Math.round(shots * ratio)))
  /** 已定稿的口播稿（有它时模型只负责把稿子分给各镜，不自己写词）。 */
  const narration = normalizeSpokenText(options.script ?? '')
  // 上限 600 字：够装下一段完整的画面要求，又不至于把 JSON 格式与条数要求挤出注意力。
  const visualBrief = (options.visualBrief ?? '').trim().slice(0, 600)
  return [
    '把这条片排成 ' + String(shots) + ' 个镜头（口播镜与产品镜交替），输出 JSON：',
    '{"continuity":"全片统一的光线/背景/服装/景别描述","shots":[{'
      + '"kind":"talking-head|product|scene","seconds":数字,"line":"口播文本",'
      + '"visual":"画面提示词","beat":"hook|pain|product|cta",'
      + '"purpose":"这一镜要让观众看到/知道的一件事（一句话）",'
      + '"relationship":"montage|continuous|scene"}]}',
    ...(visualBrief === ''
      ? []
      : [
          '',
          '【用户已经写好了画面要求 · 下面每一句都是硬要求，必须逐条落实到每一镜的 visual 里，不许概括、不许改写、不许丢项】',
          visualBrief,
          '',
        ]),
    '要求：',
    allowBroll
      ? '1. 共 ' + String(shots) + ' 镜：其中**至少 ' + String(productShots) + ' 个非口播镜**（product：主体是产品/设备；或 scene：工位、场地、操作过程的空镜），其余为 talking-head。'
        + '这是**硬要求**：全靠人物口播的成片会"看不见任何实物"，场地与设备必须由这些镜头带进来；'
      : '1. 共 ' + String(shots) + ' 镜，其中**至少 ' + String(productShots) + ' 个 product 镜头**（画面主体是产品本身：特写、细节、使用演示），其余为 talking-head；',
    '   口播镜按「钩子 → 痛点 → 卖点 → 行动号召」排 beat：' + beatToneHint('hook') + '；' + beatToneHint('pain') + '；' + beatToneHint('product') + '；' + beatToneHint('cta') + '；',
    ...(narration === ''
      ? [
          '2. **每一镜都要有 line**：product/scene 镜也一样——画面切到产品时口播不能停，这一句就念在产品的画面上（成片里不允许出现任何一镜没有声音）。line 是可以直接念出来的口播文本，一镜一句、每句 '
            + String(Math.round(SHOT_MIN_SECONDS * charsPerSecond)) + '~' + String(Math.round(SHOT_MAX_SECONDS * charsPerSecond)) + ' 个字（多一个字都要拆成两镜）；',
          // 每镜平均值必须算给模型看：只写"全片不少于 N 字"时，模型会认真地满足"每句 16~25 字"却凑不够总数
          // （实测 90 秒片写了 335 字，成片只有 80.5 秒）。给它"平均每镜不少于几字"，这道算术就只剩照做。
          '   全片 line 加起来**不少于 ' + String(minScriptChars(targetSeconds, charsPerSecond)) + ' 字**（' + String(targetSeconds) + ' 秒 × 每秒 ' + String(charsPerSecond) + ' 字），'
            + '平均每镜不少于 ' + String(Math.ceil(minScriptChars(targetSeconds, charsPerSecond) / shots)) + ' 字：这些字要分到全部 ' + String(shots) + ' 个镜头里，包括 product/scene 镜的那几句；',
        ]
      : [
          '2. **每一镜都要有 line**：product/scene 镜也一样——画面切到产品时口播不能停，这一句就念在产品的画面上。',
          '   这一版的 line **不是让你自己写词，而是把下面那份已定稿的口播稿按顺序分给各镜**：',
          '   - 每一条 line 都必须是稿件里**连续的一段原文，逐字照抄**（可以按句子边界切开，也可以两三个短句合成一镜）；',
          '   - 按稿件顺序分配，不许改写、不许压缩、不许省略、不许自己编，也不许把后面的句子挪到前面；',
          '   - 全部 line 连起来要**覆盖整段稿件**（' + String(spokenCharCount(narration)) + ' 字），一个字都不能少——口播稿的长度就是成片的长度；',
          '   - 每镜的 line 控制在 ' + String(Math.round(SHOT_MIN_SECONDS * charsPerSecond)) + '~' + String(Math.round(SHOT_MAX_SECONDS * charsPerSecond)) + ' 字之间，长句就在标点处切开分给相邻的两镜；',
        ]),
    '   product/scene 镜的 visual 写清主体、动作、环境、镜头运动；',
    '3. **所有 visual 与 line 里都不许出现任何文字、品牌名、logo、包装印刷内容**：画面里的文字一律由后期叠加，模型不要试图画字；',
    '4. continuity 写一次即可（光线、背景、服装、色调），全片共用；',
    // 官方 create-video 规范把相邻镜分三类，关系决定要不要锁连续性；写进每一镜的
    // relationship 字段（生产记录要用它判断“这一镜该不该和上一镜对齐”）。
    '   每一镜还要给两个字段：',
    '   - purpose：这一镜**只服务一个目的**，用一句**中文**写清“要让观众看到或知道的一件事”'
      + '（实测模型会写成英文，这里必须点明用中文）；',
    '   - relationship：这一镜与**前一镜**的关系，三选一（第 1 镜一律 montage）：'
      + 'continuous=同一动作跨镜延续（人物身份、物理状态、视线方向、环境都不能变）；'
      + 'scene=同一场地换机位或换时间（保留故事事实与视觉锚点即可）；'
      + 'montage=各自独立（不要人为制造帧间连续）。',
    '   标为 continuous 的相邻镜，visual 里要带上**只在那一维**对齐的锚点（例如“服装与前一镜一致”），其余维度不要重复写；',
    '5. **每一镜都要短，' + String(SHOT_MIN_SECONDS) + '~' + String(SHOT_MAX_SECONDS) + ' 秒之间**（目标 ' + String(SHOT_TARGET_SECONDS) + ' 秒）：',
    '   宁可多切几镜，也不要把内容塞进一个长镜——单镜越长，画面越容易变形与拖慢；全部镜头相加要接近 ' + String(targetSeconds) + ' 秒；',
    hasProductReference
      ? '6. 用户提供了产品参考图：product 镜要描述"以参考图中的产品为主体"的动作（缓慢旋转、光带扫过、特写拉近），不要改变产品外形。'
      : allowBroll
        ? '6. 没有产品参考图：product/scene 镜**按这段口播讲的东西**写具体画面（设备、工位、操作动作、场地），让观众看得见实物；不要编造包装上的文字或品牌。'
        : '6. 没有产品参考图：product 镜只描述产品的形态与使用场景，不要编造包装上的文字或品牌。',
    ...(options.personOnlyInTalkingHead === true
      ? [
          '7. **全片只会出现同一个人（形象参考图里的那位主播），只有 talking-head 镜能出现人**：',
          '   product/scene 镜的 visual 里不许出现人、人脸、人物动作主体是人的描述（"双手打开瓶盖""一只手托起产品"这类也不行），要写成' + NO_PERSON_CLAUSE + '；',
          '   talking-head 镜的 visual 只写这位主播的动作、表情、机位与光线，不要描述长相、发型、服装（那由形象参考图决定，文字再写一遍就会换一张脸）。',
        ]
      : []),
    ...(subject !== ''
      ? [
          '8. **画面必须扣住这条片讲的东西：' + subject + '**。',
          '   每一镜的 visual 都要有能看出这个题材的元素（设备、场地、工位、物料、使用场景），talking-head 镜也要写清人物处在什么环境里（例如在' + subject + '的场地前讲解），不许只写"人物在室内说话"；',
          '   产品镜/空镜的 visual 里必须出现该题材的具体物件，不许用无关的通用物件充数；',
          '   continuity 里把这条线的场景一次写清（场地、光线、色调），全片共用。',
        ]
      : []),
    ...(options.cameraMoves !== undefined && options.cameraMoves.length > 0
      ? [
          '9. **每一镜的 visual 必须以运镜开头**，只从这些运镜里挑一种（这决定了这条片像不像实拍）：'
            + options.cameraMoves.join(' / ') + '；同一组运镜不要连着用三次，快慢要有变化。',
        ]
      : []),
    '10. **每一镜的 visual 按 Agnes 官方的六段顺序写全**（这是厂商官方给的提示词结构，顺序照写、一段都不许省）：'
      + agnesVideoPromptStructureText() + '；',
    // 官方 create-video 规范对单镜提示词的口径是 one purpose, one visible action, camera
    // behavior, and only relevant continuity anchors —— 目的、动作、运镜三者都只允许一个。
    // 我们此前只约束了“要有实体”，没约束“不许一镜多动作”，于是模型常写出
    // “先拧开盒子、再拿起扳手、然后指向电机”这种一镜三动作的句子，厂商只能三选一或画成一团
    // （实测成片里动作与台词对不上，多半出在这里）。
    '   每一镜**只做一件事**（官方口径 one purpose, one visible action）：'
      + '一镜里只允许**一个可见动作**（“拧开扳手盒”“缓慢推近电机口”），'
      + '**不许**写“先…再…然后…”这种多步动作；需要多步就拆成相邻的两镜，'
      + '这既是官方要求，也正好是短视频的剪辑节奏；',
    '   每一镜**只写一个运镜**（官方口径 camera behavior）：从允许的运镜里挑一种写完就停，不许一镜里既推又摇；',
    // 实测：一条 60 秒片的中段连续 5 镜都是"俯拍操作台上的手部特写"，画面几乎不动，
    // 台词在换、画面不换，观众看到的是"卡住了"。约束要落在**景别 + 主体**上，
    // 只约束运镜挡不住它（那五镜的运镜确实各不相同，景别与主体却一模一样）。
    '11. **相邻镜的画面不许雷同（镜头总数不变，仍是最上面那个数）**：连续两镜不得是同一景别 + 同一主体；'
      + '景别在「全身 / 中景 / 近景 / 手部特写 / 俯拍 / 环境空镜」之间轮换，'
      + '主体在「人物 / 人物手上的物件 / 设备全貌 / 场地环境」之间轮换，'
      + '**同一种景别不得连用超过两镜**（第三镜必须换成别的景别）；',
    ...(options.personLed === true
      ? [
          '12. **这条片子以人物出镜为主**：非口播镜（product/scene）合计**不超过 ' + String(productShots) + ' 个**，'
            + '其余镜头都必须是 talking-head（看得见人物）。'
            + '只有手、只有物件的镜头最多 2 个：观众要看的是"谁在讲这件事"，'
            + '不是一部没有主角的操作教学片（实测手部特写排到 9/12 镜时，成片像设备展示素材）；',
        ]
      : []),
    '   每一镜的 visual 开头写清景别与主体（例如"中景，人物站在操作台前"），让这条约束可核对；',
    '   每一镜都要有**看得见的实体**：镜头对着谁或什么物体（人物 / 产品 / 设备 / 场地 / 手上的东西）、'
      + '它在做什么动作、它周围是什么环境与时间；台词是抽象意象时（"风一吹叶子哗哗响""阳光落在椅背上"），'
      + '必须把它落在一个具体物件与具体动作上（写成"镜头对着窗台上被风吹动的绿萝叶子"），'
      + '不许只写情绪、光线、氛围这类没有实体的句子——没有实体时厂商会画出扭曲的几何体；',
    ...(options.visualStructure === undefined || options.visualStructure === ''
      ? []
      : ['   这一类型另有写法要求：' + options.visualStructure + '。']),
    ...(options.shotSeconds === undefined
      ? []
      : ['11. 每一镜的 seconds 落在 ' + String(options.shotSeconds.min) + '~' + String(options.shotSeconds.max)
        + ' 秒之间（这条类型就是这么切的，不要用别的区间）。']),
    ...(narration === ''
      ? []
      : [
          '',
          '已定稿的口播稿（按顺序分给各镜，逐字照抄）：',
          narration,
        ]),
    '只输出 JSON，不要 Markdown 代码块、不要解释、不要多余文字。',
  ].join('\n')
}

/** 从模型输出里抠出第一个完整 JSON 对象；抠不到返回空串。 */
function extractJsonObject(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, ' ')
  const start = cleaned.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return ''
}

const SHOT_KINDS: ZyShotKind[] = ['talking-head', 'product', 'scene', 'text-card']
const BEATS = ['hook', 'pain', 'product', 'cta'] as const

/**
 * 相邻镜关系（Agnes 官方 create-video 规范的三分类）。
 *
 * 它决定要不要锁连续性：continuous 要保住人物身份/物理状态/视线方向/环境，
 * scene 只要保住故事事实与视觉锚点，montage 不制造人为的帧间连续。
 */
export const SHOT_RELATIONSHIPS = ['continuous', 'scene', 'montage'] as const


/** 把字符串夹到合法镜头类型；不认识的一律按 talking-head（有文本）或 scene（无文本）处理。 */
function toKind(value: unknown, hasLine: boolean): ZyShotKind {
  return typeof value === 'string' && (SHOT_KINDS as string[]).includes(value)
    ? value as ZyShotKind
    : (hasLine ? 'talking-head' : 'scene')
}

/** 夹紧时长：非数字用兜底值，越界夹回本编排的"短镜"区间（不是厂商的 4~12 秒）。 */
function toSeconds(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(SHOT_MAX_SECONDS, Math.max(SHOT_MIN_SECONDS, Math.round(parsed)))
}

/**
 * 解析模型返回的分镜表。
 *
 * 模型输出永远不可信：字段缺失、类型不对、时长越界、镜头类型瞎写都会发生。
 * 这里的原则是**能夹就夹、夹不了就丢**，绝不让一条脏数据把整条片带崩。
 *
 * @param raw - 模型返回的原始文本。
 * @param references - 这一次任务可用的参考图集（按角色挂到每一镜上）。
 * @param provider - 生成方标识（写入每一镜，便于逐镜覆盖）。
 * @param allowsProductTemplates - 这个内容形式会不会真的在卖东西（决定能不能套产品广告模板）。
 *   **不能拿 provider 判断**：vlog 链路也把 provider 写成 'digital-human'（那是生成方标识，
 *   不是内容形式），按它判断等于永远允许——实测 60 秒档 VLOG 因此被套上"产品缓慢 360 度旋转展示"。
 * @returns 镜头数组；解析不出任何镜头时返回空数组（由调用方走兜底）。
 */
export function parseShotPlan(
  raw: string,
  references: ZyShotRef[],
  provider: string,
  allowsProductTemplates = true,
): ZyShot[] {
  const json = extractJsonObject(raw)
  if (json === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  }
  catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const record = parsed as { continuity?: unknown, shots?: unknown }
  const continuity = typeof record.continuity === 'string' ? record.continuity.trim().slice(0, 200) : ''
  if (!Array.isArray(record.shots)) return []
  const shots: ZyShot[] = []
  /** 已解析的产品镜数量：用于在模板之间轮转，避免连续两镜用同一个模板。 */
  let productShotCount = 0
  for (const item of record.shots) {
    if (item === null || typeof item !== 'object') continue
    const row = item as { kind?: unknown, seconds?: unknown, line?: unknown, visual?: unknown, beat?: unknown, purpose?: unknown, relationship?: unknown, strategy?: unknown }
    // 官方生产记录字段：模型没给就留空（留空可读，编造不可读）。
    const purpose = typeof row.purpose === 'string' ? row.purpose.trim().slice(0, 120) : ''
    const relationship = typeof row.relationship === 'string'
      && (SHOT_RELATIONSHIPS as readonly string[]).includes(row.relationship)
      ? row.relationship as ZyShot['relationship']
      : undefined
    const strategy = typeof row.strategy === 'string' ? row.strategy.trim().slice(0, 60) : ''
    const line = typeof row.line === 'string' ? row.line.trim() : ''
    const visual = typeof row.visual === 'string' ? row.visual.trim().slice(0, 500) : ''
    if (line === '' && visual === '') continue
    const kind = toKind(row.kind, line !== '')
    const beat = typeof row.beat === 'string' && (BEATS as readonly string[]).includes(row.beat)
      ? row.beat as ZyShot['beat']
      : undefined
    // 镜头模板：产品镜按序号轮转（避免同一模板连用导致画面重复），收尾镜用促销模板。
    // 模板给"怎么拍"（稳定的镜头语言），模型给"拍什么"（这一句对应的画面内容）。
    const template = pickShotTemplate(kind, beat, productShotCount, allowsProductTemplates)
    if (template !== undefined && kind === 'product') productShotCount += 1
    // 模板给"怎么拍"，模型给"拍什么"：两段拼起来。禁画字那条统一由这里补，
    // 不指望模型每次都记得（它一忘就会生成臆造品牌）。
    const mergedVisual = sanitizeVisualPrompt(
      (template === undefined ? [visual] : [visual, template.visual]).filter(part => part !== '').join('，'),
    )
    shots.push({
      index: shots.length,
      kind,
      // 口播镜以配音真实时长为准，这里的估值只用于排序与预算，执行时回填真实秒数。
      seconds: toSeconds(row.seconds, line === '' ? SHOT_TARGET_SECONDS : estimateSeconds(line)),
      line,
      visual: mergedVisual,
      continuity,
      // 纯文字卡不需要厂商画面，也就没有参考图；其余镜头共用同一套参考图（一致性的关键）。
      references: kind === 'text-card' ? [] : references,
      provider,
      ...(beat !== undefined ? { beat } : {}),
      // 官方生产记录要求每一镜带上：目的（只服务一件事）、与前镜的关系、生成策略。
      // 这三项此前完全没有，于是“这一镜为什么存在”“该不该和上一镜对齐”都无从判断。
      ...(purpose === '' ? {} : { purpose }),
      ...(relationship === undefined ? {} : { relationship }),
      ...(strategy === '' ? {} : { strategy }),
      status: 'planned',
    })
  }
  return shots
}

/**
 * 确定性兜底分镜：模型不可用或输出不可解析时用它，保证任何情况下都排得出片。
 *
 * 规则：口播文本按句切段（沿用 long-video 的切段口径），每 2 个口播镜后插 1 个产品镜，
 * **口播句按顺序分给全部镜头（口播镜与产品镜各得一句）**——产品镜只是画面切到产品上，
 * 旁白照念，所以它同样带 line、同样有配音；产品镜不再出现"没有台词"的静音镜。
 * 句子用完时不再插产品镜（宁可少一个产品画面，也不要一个 5 秒的死寂镜头）。
 *
 * **有产品参考图**：插产品镜（照着参考图出片）。
 * **没有产品参考图但有题材**：插场景空镜（文生视频），画面按"题材 + 这一句在讲什么"写——
 * 这是融合创作的兜底形态：口播镜带人、空镜带实物，成片里既有脸也有场地与设备。
 * **既没有产品图也没有题材**：退回纯口播（宁可如实少画面，也不凭空画一个产品）。
 *
 * @param texts - 已经切好的口播段文本（按稿件顺序）。
 * @param references - 这一次任务可用的参考图集。
 * @param provider - 生成方标识。
 * @param hasProductReference - 是否有产品参考图（有则插产品镜）。
 * @param charsPerSecond - 这条音色的实测语速；缺省用产品默认值（兜底分镜的时长按它估）。
 * @param subject - 这条片的题材（没有产品图时用它给空镜写画面）。
 * @returns 镜头数组（口播镜与非口播镜交替，每一镜都有 line）。
 */
/**
 * 把"全是口播镜"的分镜补上 B-roll（融合创作的硬保证）。
 *
 * 为什么不信模型：分镜提示词里写了"至少 N 个非口播镜"是硬要求，实测模型照样能排出 22/22
 * 全是口播（无人机培训那条），成片里于是没有任何设备与场地。所以这一层是**产品侧兜底**：
 * **一镜非口播都没有时**，把每第 3 个口播镜改写成场景空镜，画面按题材与它那句词写。
 *
 * 只改 kind / visual / references，**不动 line**：台词与配音顺序保持原样，母时钟与字幕都不受影响。
 *
 * @param shots - 模型排出的分镜。
 * @param subject - 这条片的题材（给空镜写画面用）。
 * @returns 补齐后的分镜；本来就够或没有题材时原样返回。
 */
export function ensureBrollShots(shots: ZyShot[], subject: string): ZyShot[] {
  const topic = subject.trim()
  if (topic === '' || shots.length < 3) return shots
  const broll = shots.filter(shot => shot.kind !== 'talking-head' && shot.kind !== 'text-card').length
  // 只在"退化形态"上动手：一镜画面都没有时才补。
  // 为什么不去凑比例：模型按提示词排出的 1~2 个非口播镜**已经是它读懂题材的结果**，
  // 再按固定比例改，会把"产品图该进哪一镜"这类设计一起改掉（实测把带产品图的产品镜改成空镜，
  // 产品图就再也进不了画面）。缺画面时才补，是这条兜底的边界。
  if (broll > 0) return shots
  let talkingHeads = 0
  return shots.map(shot => {
    if (shot.kind !== 'talking-head') return shot
    talkingHeads += 1
    if (talkingHeads % BROLL_EVERY_NTH_TALKING_HEAD !== 0 || shot.line === '') return shot
    return {
      ...shot,
      kind: 'scene' as const,
      visual: brollVisualFor(topic, shot.line),
      // 空镜不带人物参考图：带了就会在画面里长出第二张脸。
      references: [],
    }
  })
}

export function fallbackShotPlan(
  texts: string[],
  references: ZyShotRef[],
  provider: string,
  hasProductReference: boolean,
  charsPerSecond = CHARS_PER_SECOND,
  subject = '',
): ZyShot[] {
  const productRefs = references.filter(item => item.role === 'product')
  const insertProductShots = hasProductReference && productRefs.length > 0
  // 没有产品图但有题材时改插"场景空镜"：画面由文生视频按题材给，观众至少看得见实物。
  const insertBroll = !insertProductShots && subject.trim() !== ''
  const shots: ZyShot[] = []
  const productVisual = '以参考图中的产品为主体，缓慢旋转展示，柔和光带扫过，微距特写，浅景深，画面里不出现任何文字与品牌标识'
  /** 空镜的画面：题材 + 这一句在讲什么，固定机位、无文字。 */
  const brollVisual = (line: string): string => {
    const what = line.replace(/[，。！？；：、,.!?;:：\s]/g, '').slice(0, 18)
    return subject + '：' + what + '。画面出现该题材的具体物件与场地（设备、工位、操作过程），固定机位，画面里不出现任何文字与品牌标识、不出现人脸'
  }
  /** 下一句要说的话在 texts 里的位置：口播镜与产品镜共用同一个游标，谁都不会拿到重复或错序的句子。 */
  let cursor = 0
  /** 已经排了几个口播镜：用来决定这一句之后要不要切到产品画面。 */
  let talkingHeads = 0
  while (cursor < texts.length) {
    const text = texts[cursor]!
    cursor += 1
    talkingHeads += 1
    shots.push({
      index: shots.length,
      kind: 'talking-head',
      // 单句口播本来就短（一句 20 字约 4.5 秒），按真实字数估即可；不强行拉到 4 秒下限，
      // 否则"一句话一镜"会被撑成慢速念白——那正是要消除的观感。
      seconds: estimateSeconds(text, charsPerSecond),
      line: text,
      visual: '',
      continuity: '',
      references,
      provider,
      status: 'planned',
    })
    // 每两个口播镜后插一个产品镜，但不在开头插（开场要先把人立住）；
    // 没有剩余的句子就不插——产品镜的时长由它自己那句口播决定，不接受"没有台词的 5 秒"。
    if ((!insertProductShots && !insertBroll) || talkingHeads % 2 !== 0 || cursor >= texts.length) continue
    const brollText = texts[cursor]!
    cursor += 1
    shots.push({
      index: shots.length,
      kind: insertProductShots ? 'product' : 'scene',
      seconds: estimateSeconds(brollText, charsPerSecond),
      line: brollText,
      visual: insertProductShots ? productVisual : brollVisual(brollText),
      continuity: '',
      references: insertProductShots ? productRefs : [],
      provider,
      status: 'planned',
    })
  }
  return shots
}

/** 去标点后的纯字文本：模型抄稿时常改标点或添语气词，"姐妹们，秋冬"与"姐妹们秋冬"是同一句。 */
function spokenChars(text: string): string {
  return text.replace(/[\s，。！？；：、,.!?;:~…'"“”‘’（）()【】\[\]—\-]/g, '')
}

/** 非口播镜的最低占比：低于它就由 {@link ensureBrollShots} 从口播镜里改几个成空镜。 */
export const MIN_BROLL_RATIO = 0.3
/** 每 N 个口播镜改写一个成空镜（在需要补 B-roll 时才生效）。 */
export const BROLL_EVERY_NTH_TALKING_HEAD = 3

/**
 * 空镜的画面描述：题材 + 这一句在讲什么。
 *
 * 判据是"观众能不能从画面里看出这条片讲的东西"——所以要求出现该题材的具体物件与场地，
 * 并要求无文字、无人物（文字会被厂商画成臆造品牌，人物会与主播变成两个人）。
 *
 * @param subject - 这条片的题材。
 * @param line - 这一镜要念的台词。
 * @returns 交给文生视频的画面提示词。
 */
export function brollVisualFor(subject: string, line: string): string {
  const what = line.replace(/[，。！？；：、,.!?;:\s]/g, '').slice(0, 18)
  return subject + '：' + what + '。画面出现该题材的具体物件与场地（设备、工位、操作过程），固定机位，画面里不出现任何文字与品牌标识、不出现人脸'
}

/** 少于这个字数的片段不算"已经说过"：那种包含关系多半是巧合，会让这一句永远补不上。 */
const MIN_SPOKEN_MATCH_CHARS = 6

/**
 * 这一句是不是已经由某条 line 念过了。
 *
 * 判据是**去标点后的包含关系**（短的被长的包住）：模型写分镜时经常把稿件原句抄进 line，
 * 只是改了标点或加了语气词；逐字比对认不出来，同一句就会被念第二遍。
 *
 * @param line - 某一镜已有的口播文本。
 * @param sentence - 稿件里的一句话。
 * @returns true 表示这句话已经说过了。
 */
function sentenceSpoken(line: string, sentence: string): boolean {
  const spoken = spokenChars(line)
  const target = spokenChars(sentence)
  if (spoken === '' || target === '') return false
  const shorter = spoken.length <= target.length ? spoken : target
  const longer = spoken.length <= target.length ? target : spoken
  if (shorter.length < MIN_SPOKEN_MATCH_CHARS) return spoken === target
  return longer.includes(shorter)
}

/**
 * 把稿件里还没被任何一镜念过的句子，补到 line 为空的镜头上。
 *
 * 为什么需要它：分镜表由模型排，它常把 product/scene 镜的 line 留空，成片里那几镜就是
 * **完全静音**的画面（用户口径的"5 秒死寂"）。旁白必须铺满整条时间轴，产品镜只是画面切走。
 *
 * 补写规则（不改已有 line、不编造新句子）：
 * - 句子取自 {@link splitScript}（与切段同一把尺子）；
 * - 按**镜头顺序**推进游标，而不是从"没被说过的句子池"里挑：模型常把稿件前几句原样抄进前几镜，
 *   从池子里挑会让后面的产品镜拿到稿子末尾的句子，全片口播顺序就乱了；
 * - 某条 line 已经念过的句子不再重复使用（见 {@link sentenceSpoken}）；
 * - 文字卡（text-card）不补：它是纯文字卡，既不配音也没有厂商画面；
 * - 句子不够时后面的镜头保持为空，多出来的句子按顺序丢掉。
 *
 * @param shots - 解析出来的镜头数组（含模型给的 line）。
 * @param script - 已定稿的稿件正文。
 * @returns 补过 line 的镜头数组；一处都没补时原样返回入参。
 */
export function fillMissingLines(shots: ZyShot[], script: string): ZyShot[] {
  const sentences = splitScript(script)
  if (sentences.length === 0 || shots.length === 0) return shots
  let cursor = 0
  let changed = false
  const filled = shots.map(shot => {
    if (shot.line !== '') {
      // 这一镜自己说了话：游标推过它念的那一句（或那几句）。
      let lastSpoken = -1
      for (let i = cursor; i < sentences.length; i++) {
        if (sentenceSpoken(shot.line, sentences[i]!)) lastSpoken = i
      }
      cursor = Math.max(cursor + 1, lastSpoken + 1)
      return shot
    }
    if (shot.kind === 'text-card' || cursor >= sentences.length) return shot
    const line = sentences[cursor]!
    cursor += 1
    changed = true
    // 补上的这一句就是这一镜要念的话：时长按它自己的字数估（母时钟合成后会回填真实秒数）。
    return { ...shot, line, seconds: estimateSeconds(line) }
  })
  return changed ? filled : shots
}

/**
 * 镜头模板：把"这一类镜头怎么拍"沉淀下来，而不是每次让模型自由发挥。
 *
 * 为什么需要模板：产品镜反复出现（一条 90 秒片里至少 7 个），若每次都靠模型现编，
 * 画面风格会一镜一个样；模板给出**稳定的镜头语言**（缓转/微距/手持比例/使用场景/对比/促销），
 * 模型只负责把"这个产品"填进去。
 */
export interface ShotTemplate {
  /** 模板标识，落盘与日志用。 */
  id: string
  /** 展示名（分镜预览里给用户看）。 */
  name: string
  /** 适用镜头类型。 */
  kind: ZyShotKind
  /** 画面提示词骨架（与 continuity 拼成最终提示词）。 */
  visual: string
  /** 建议时长（秒）。 */
  seconds: number
  /** 建议用在哪个节拍上。 */
  beat: 'hook' | 'pain' | 'product' | 'cta'
}

/**
 * 内置镜头模板库（六个，覆盖带货片的常见镜头）。
 *
 * 所有 visual 都**不含任何文字/品牌要求**：实测文生视频会臆造品牌名与乱码标签，
 * 品牌信息一律走字幕与后期叠加（见知识库条目 13）。
 */
export const SHOT_TEMPLATES: ShotTemplate[] = [
  {
    id: 'hero-rotate',
    name: '静物缓转',
    kind: 'product',
    visual: '产品置于简洁台面正中，缓慢 360 度旋转展示，柔和光带扫过表面，浅景深，微距质感',
    seconds: SHOT_TARGET_SECONDS,
    beat: 'hook',
  },
  {
    id: 'macro-detail',
    name: '微距细节',
    kind: 'product',
    visual: '极近微距：表面纹理与水珠清晰可见，焦点缓慢推移，柔和侧光勾勒轮廓',
    seconds: SHOT_TARGET_SECONDS,
    beat: 'product',
  },
  {
    id: 'hand-scale',
    name: '手持比例',
    kind: 'product',
    visual: '一只手自然托起产品，展示真实大小与质感，背景虚化，窗边自然光',
    seconds: SHOT_TARGET_SECONDS,
    beat: 'product',
  },
  {
    id: 'usage-scene',
    name: '使用场景',
    kind: 'product',
    visual: '产品在真实使用场景里被使用：动作自然、环境生活化，固定机位或极缓慢推移，暖色调',
    seconds: SHOT_TARGET_SECONDS,
    beat: 'product',
  },
  {
    id: 'before-after',
    name: '前后对比',
    kind: 'product',
    visual: '左右分屏对比：先展示使用前的状态，再切到使用后的状态，光线与机位保持一致',
    seconds: SHOT_TARGET_SECONDS,
    beat: 'product',
  },
  {
    id: 'promo-end',
    name: '促销收尾',
    kind: 'scene',
    visual: '产品置于画面下方三分之一，上方留出干净空间（用于后期叠加价格与优惠文字），暖光收束',
    seconds: SHOT_TARGET_SECONDS,
    beat: 'cta',
  },
]

/**
 * 这个内容形式会不会真的在卖东西（决定分镜能不能套"产品广告"模板）。
 *
 * 模板库是带货片沉淀下来的镜头语言（360 度缓转 / 微距水珠 / 促销留白）：只有数字人口播
 * 这类以"卖点 + 行动号召"为骨架的形式才适用。走动 VLOG 与场景空镜里没有产品要卖，
 * 套上就会出现与题材无关的画面要求（实测 60 秒档免费培训 VLOG 里出现"产品置于简洁台面正中，
 * 缓慢 360 度旋转展示""上方留出干净空间（用于后期叠加价格与优惠文字）"）。
 *
 * @param kind - 内容形式的 kind（LongVideoForm.kind）。
 * @returns 允许套产品模板时为 true。
 */
export function formSellsProduct(kind: string): boolean {
  return kind === 'digital-human' || kind === 'product'
}

/**
 * 为某一镜挑一个模板。
 *
 * 规则简单且确定：产品镜按序号在三个产品模板间轮转（避免同一模板连用导致画面重复），
 * 收尾镜优先用促销模板，其余交给口播。**不确定时宁可返回 undefined**（由模型提示词决定），
 * 不硬塞一个不合适模板。
 *
 * @param kind - 该镜类型。
 * @param beat - 该镜节拍（可能缺省）。
 * @param productIndex - 这是第几个产品镜（0 起，用于轮转）。
 * @returns 匹配到的模板；没有合适的返回 undefined。
 */
export function pickShotTemplate(
  kind: ZyShotKind,
  beat: ZyShot['beat'],
  productIndex: number,
  allowProductTemplates = true,
): ShotTemplate | undefined {
  // 非带货形式（走动 VLOG、场景空镜）不套产品广告模板：这套模板是带货片沉淀下来的镜头语言
  // （360 度缓转 / 微距水珠 / 促销留白），套在"免费培训 VLOG"上会写出与题材无关、
  // 甚至与硬要求冲突的画面——实测 60 秒档 VLOG 里出现"产品置于简洁台面正中，缓慢 360 度旋转展示"
  // "上方留出干净空间（用于后期叠加价格与优惠文字）""极近微距：表面纹理与水珠清晰可见"。
  if (!allowProductTemplates) return undefined
  if (kind !== 'product') {
    if (beat === 'cta') return SHOT_TEMPLATES.find(item => item.id === 'promo-end')
    return undefined
  }
  const productTemplates = SHOT_TEMPLATES.filter(item => item.kind === 'product' && item.id !== 'before-after')
  if (productTemplates.length === 0) return undefined
  return productTemplates[productIndex % productTemplates.length]
}

/** 分镜表质量自检结果：用于生成前预校验与测试断言。 */
export interface ShotPlanAudit {
  total: number
  productShots: number
  talkingHeadShots: number
  /** 总时长（各镜之和），用于与目标时长对比。 */
  totalSeconds: number
  /** 是否满足"产品镜不少于下限"这条底线。 */
  hasEnoughProductShots: boolean
  /** 画面提示词里疑似出现文字/品牌要求的位置（命中即需要人看一眼）。 */
  suspiciousTextRequests: number[]
}

/**
 * 画面提示词是否在**要求模型把文字画出来**（而不是禁止它画）。
 *
 * @param visual - 该镜的画面提示词。
 * @returns 命中正向要求时返回 true。
 */
export function requestsRenderedText(visual: string): boolean {
  // 判据只认**正向要求**：`显示文字`、`logo 特写` 这类才会让模型去画字。
  // `不出现文字` 这种禁止令是正确写法；`用于后期叠加文字` 说的是后期，也不是要求模型画——
  // 误报会让这条闸门被无视，而它恰恰是唯一拦"臆造品牌"的闸门（实测踩过一次）。
  const negation = /(不出现|不要|不许|不用|不得|无需|避免|不能|禁止|别)([^，。；]{0,12})?(文字|字幕|logo|LOGO|品牌名|品牌标识|包装上的|印刷)/
  if (negation.test(visual)) return false
  // "用于后期叠加文字""留给字幕"说的是**后期**，不是让模型在画面里画字——同属禁止令一侧，不能算可疑。
  const deferred = /(用于|留给|预留给|之后|后期|稍后)[^，。；]{0,6}(叠加|添加|加上|放|显示)[^，。；]{0,4}(文字|字幕|logo|LOGO|价格)/
  if (deferred.test(visual)) return false
  return /(显示|写上|印着|印有|出现|展示|露出|带有|加上|叠加)[^，。；]{0,8}?(文字|字幕|logo|LOGO|品牌名|品牌标识|包装上的|印刷)/.test(visual)
    || /(文字|字幕|logo|LOGO|品牌名|品牌标识)[^，。；]{0,8}?(特写|清晰|显示|可见|露出)/.test(visual)
}

/**
 * 把画面提示词里"要求模型画字"的部分剥掉，再补上统一禁令。
 *
 * 为什么要剥而不是只加禁令：提示词里同时有「logo 特写」和「不出现任何文字」两句时，
 * 模型会按**第一句**去执行（实测生成过臆造品牌 `ALTLONE / MUSKIRY CADEE`）。
 * 品牌文字一律走后期叠加，所以这里把正向要求整句删掉，只留禁令。
 *
 * @param visual - 模型给的画面提示词。
 * @returns 可直接发给厂商的提示词（必带禁令）。
 */
export function sanitizeVisualPrompt(visual: string): string {
  const clauses = visual
    .split(/[，,。；;]/)
    .map(part => part.trim())
    .filter(part => part !== '')
    .filter(part => !requestsRenderedText(part))
  return clauses.concat(NO_RENDERED_TEXT).join('，')
}

/**
 * 一句话看起来像"整片流程"还是"全片统一要求"。
 *
 * 判据是时序与位移词：用户（以及提示词增强器）写下"先拍走廊、随后走进车间、最后走到外场"
 * 这类句子时，写的是**整条片子怎么走**；这类句子钉在每一镜会变成"每一镜都要演完整片"。
 * 反过来，"第三人称旁观视角""镜头不手持晃动""画面中不出现文字与logo"是每镜都适用的要求。
 */
const FLOW_SENTENCE = /(先|随后|接着|然后|最后|紧接着|转身|走进|走向|走到|拿起|端起|走出)/

/** 一句话里出现人物（人称、身份、身体部位）——空镜与产品镜的提示词里不许带这类句子。 */
const PERSON_SENTENCE = /(她|他|学员|主播|人物|我|人手|双手|手部|双手|视线|表情|脸部|脸|人像)/

/**
 * 把用户写的画面要求钉进每一镜，但**不把整片流程当成这一镜要演完的内容**。
 *
 * 为什么不能只靠分镜提示词：提示词里写了"逐条落实"不等于模型照做——实测它会把要求压缩、
 * 换词，甚至整段丢掉。而厂商**只看单镜那一段 prompt**，分镜那一步丢掉的信息在出片时无处可寻。
 *
 * 为什么钉进去还要分两段：用户提示词（尤其经「提示词增强」扩写之后）往往是一整条片子的流程
 * （"先拍走廊 → 装机臂 → 最后走到外场"）。整段贴在每镜开头，厂商会把**整片流程**当成
 * 这一镜要演的内容——实测 60 秒档 15 镜的提示词里都带着同一段完整流程，等于每镜都在演全片，
 * 与官方"一镜一目的、一镜一动作"的口径相反。所以这里：**这一镜的画面写在最前**并标明只拍这段，
 * 全片统一要求（风格 / 一致性 / 禁令）跟在其后，流程句另列并明确"不是这一镜要演完的内容"。
 *
 * 幂等：已经带过标记的镜头不再重复钉（重排分镜时会再调一次）。
 *
 * @param shots - 分镜表（模型排的或确定性兜底排的）。
 * @param brief - 用户写的画面要求原文（就是「产品与卖点／提示词」框里那段）。
 * @returns 每一镜都带上用户要求的镜头数组；没有要求时原样返回。
 */
export function pinVisualBrief(shots: ZyShot[], brief: string): ZyShot[] {
  const text = brief.trim().slice(0, 600)
  if (text === '' || shots.length === 0) return shots
  const sentences = text.split(/(?<=[。！？；])/).map(item => item.trim()).filter(item => item !== '')
  const isFlow = (sentence: string): boolean => sentence.length >= 24 && FLOW_SENTENCE.test(sentence)
  const global = sentences.filter(sentence => !isFlow(sentence)).join('')
  const flow = sentences.filter(sentence => isFlow(sentence)).join('').slice(0, 160)
  const sharedSource = global === '' ? text.slice(0, 200) : global.slice(0, 300)
  // 空镜/产品镜连"统一要求"里的人物句也不能带：用户提示词（以及增强器）常把人物动作写进
  // 风格段（实测"她停步半秒，右手把防静电手环戴到右手腕…"），而空镜本来就不带人物参考图，
  // 钉进去等于告诉厂商"这一镜也要有这个人"——第三轮镜 2 的空镜里因此长出了一位陌生女性。
  const sharedForFrames = sharedSource
    .split(/(?<=[。！？；])/)
    .filter(sentence => sentence.trim() !== '' && !PERSON_SENTENCE.test(sentence))
    .join('')
  const shared = '【全片统一要求 · 每一镜都要满足】' + sharedSource
  const sharedNoPerson = '【全片统一要求 · 每一镜都要满足】' + sharedForFrames
  const flowPart = flow === '' ? '' : '【整片流程参考 · 不是这一镜要演完的内容】' + flow
  return shots.map(shot => {
    if (shot.visual.includes('【全片统一要求')) return shot
    // 流程段只给**口播镜**。空镜与产品镜本来就不带人物参考图，把"学员从走廊走向车间"这类
    // 整片流程钉进去，厂商会照着它凭空画一个人——实测第三轮镜 2 的空镜里出现了一位穿校服的
    // 陌生女性（全片主角是另一位），画面切过去就是"换人了"；而这一镜的提示词里明明写着
    // "画面中无完整人物"，两条要求互相打架。
    const pin = shot.kind === 'talking-head'
      ? shared + flowPart
      : sharedNoPerson + NO_PERSON_CLAUSE
    return { ...shot, visual: shot.visual === '' ? pin : '【这一镜只拍下面这段】' + shot.visual + '。' + pin }
  })
}

/**
 * 分镜表自检：在花厂商的钱之前，先用它判断这张分镜表值不值得跑。
 *
 * @param shots - 待检查的镜头数组。
 * @returns 统计结果与可疑位置。
 */
export function auditShotPlan(shots: ZyShot[]): ShotPlanAudit {
  const suspicious: number[] = []
  let productShots = 0
  let talkingHeadShots = 0
  let totalSeconds = 0
  for (const shot of shots) {
    if (shot.kind === 'product') productShots++
    if (shot.kind === 'talking-head') talkingHeadShots++
    totalSeconds += shot.seconds
    // 提示词里主动要求模型"画文字"是实测会翻车的写法（会生成臆造品牌），命中要提示人工确认。
    // 判据只认**正向要求**："不许出现文字/不要 logo"这类禁止令是正确写法，不能当成可疑
    // （误报会让这条自检很快被无视，而它恰恰是唯一拦"画字"的闸门）。
    if (requestsRenderedText(shot.visual)) suspicious.push(shot.index)
  }
  return {
    total: shots.length,
    productShots,
    talkingHeadShots,
    totalSeconds,
    hasEnoughProductShots: productShots >= MIN_PRODUCT_SHOTS || shots.length < 3,
    suspiciousTextRequests: suspicious,
  }
}
