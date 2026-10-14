/**
 * 口播基本量：语速折算、切段口径与文本清理——被"语言单位"与"编排单位"共同依赖的叶子模块。
 *
 * 为什么单独一个模块：这些东西原先住在 `long-video.ts`（编排层）里，而分镜层（`storyboard.ts`）
 * 又要用它，于是两层互相 import，形成**循环依赖**。循环依赖在 ESM 里不会报错，
 * 但某些加载顺序下，一方拿到的是另一方**尚未初始化的绑定**——实测表现为
 * `SHOT_MIN_SECONDS` 变成 `undefined`，镜头时长被算成 `null`
 * （编译期完全看不出来，只有跑起来才暴露）。
 *
 * 抽到这里之后依赖方向是单向的：`speech.ts` ← `storyboard.ts` ← `long-video.ts`。
 * 往这里加东西前先问一句：它属于"一句中文怎么念、怎么切"，还是属于"一条片怎么编排"？
 * 后者不该放这里。
 *
 * **这里的语速只用于写稿与排分镜的估算**：成片里那一声由厂商在出片时自己念（Agnes 原生声音），
 * 所以字数门槛是一个"落在合理区间"的工程估算，而不是某条音色的实测值。
 * @module @deepseek-ai/dsh-bosom-friend-server/speech
 */

/** 厂商单次生成的时长硬边界。 */
export const SEGMENT_MIN_SECONDS = 4
export const SEGMENT_MAX_SECONDS = 12

/**
 * 中文口播语速默认值（字/秒，**按 `spokenCharCount` 的去标点口径**）——把「秒数」折算成「要写多少字」时用它。
 *
 * 取 4.5 而不是更慢的值：稿子写短了，配音撑不满目标时长，成片就成了慢速念白
 * （用户口径的"语速太慢、讲解内容太少"）。宁可要求多写一点。
 *
 * 这是产品口径的**估算值**，不是某一家的实测值：厂商按提示词里的台词自己念，
 * 真实语速由它决定，编排层只能按一个合理的常速折算。
 */
export const CHARS_PER_SECOND = 4.5

/**
 * 稿件里出现的段落标记名。
 *
 * 模型爱在正文前后加「【标题】…【口播正文】…【话题标签】」这类结构外壳，而产品要的是
 * **可以直接念的正文**。这些词一旦漏进稿子，就会一字不差地进语音与字幕
 * （实测 30 秒档成片把「【标题】」「【口播正文】」「【话题标签】」三个标记一起念了出来）。
 */
const SECTION_MARKERS = [
  '标题', '副标题', '口播正文', '正文', '文案', '口播稿', '脚本', '分镜',
  '画面', '封面', '摘要', '话题标签', '标签', '发布标签', '结尾',
] as const

/** 把模型写的稿子清成「能直接念」的文本：去掉 Markdown 装饰、段落标记、话题标签与多余空白。 */
export function normalizeSpokenText(text: string): string {
  // ① 代码块与 Markdown 装饰：不是台词。
  let out = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/#[^\s#，。！？；：]+/g, '')
  // ② 【标题】【口播正文】这类方括号标记：连括号带标记名整体删掉。
  for (const marker of SECTION_MARKERS)
    out = out.replace(new RegExp('[【\\[（(]\\s*' + marker + '\\s*[】\\]）)]', 'g'), ' ')
  // ③ 独占一行的标记名（模型常把 `标题：` 与正文分行写）：整行或行首前缀都不是台词。
  //    只在**标记位**上剥——正文里正常用到的词（"证书上的标题"）不动。
  out = out
    .split(/\r?\n/)
    .map(line => {
      let trimmed = line.trim()
      for (const marker of SECTION_MARKERS)
        trimmed = trimmed.replace(new RegExp('^' + marker + '\\s*[:：]\\s*'), '')
      return trimmed
    })
    .filter(line => line !== '' && !(SECTION_MARKERS as readonly string[]).includes(line))
    .join('\n')
  return out.replace(/\s+/g, ' ').trim()
}
/**
 * 口播字数：只数**念得出来的字**，标点与空白不计。
 *
 * 为什么标点必须排除：字数门槛是用来折算时长的，标点不发音、只占停顿；含标点的字数去乘同一个语速，
 * 分子被系统性放大（中文带货稿的标点约占 15%），门槛于是被算低约 15%：
 * 实测 90 秒档放行了一篇 396 字（含标点）/ 337 字（去标点）的稿子，成片只有 77.97 秒（DEF-113）。
 *
 * 计数口径与 {@link normalizeSpokenText} 正交：那个管"哪些字符不该念"（Markdown 装饰、话题标签），
 * 这个管"剩下的里面哪些发得出声"。两个一起用，先清后数。
 *
 * @param text - 任意文本（稿件原文或清理过的文本都行）。
 * @returns 去标点去空白后的字数。
 */
export function spokenCharCount(text: string): number {
  // 只保留字母、数字与汉字：中文标点、全角符号、空白、Emoji 都不发音。
  // 用 Unicode 属性而不是手写标点表——手写表必然漏（实测漏过「·」「～」「……」，各差一两个字）。
  return text.replace(/[^\p{L}\p{N}]/gu, '').length
}

/**
 * 口播节拍：一条带货片的四拍结构（钩子 → 痛点 → 卖点 → 行动号召）。
 *
 * 行业里叫"说服框架"，四种节拍需要的**语气**不同：钩子要抓人、痛点要共情、
 * 卖点要清楚、号召要果断。语气落两处：写稿提示词（让模型写出适合这一拍的句子）
 * 与出片提示词（让厂商按这一拍的语气念）。
 */
export type SpeechBeat = 'hook' | 'pain' | 'product' | 'cta'

/**
 * 写口语稿的硬要求：并进写稿提示词，专治"一眼 AI 味"。
 *
 * 这些不是文风偏好，是"念出来像不像人"的可执行判据：机器味的来源是长句、
 * 书面连接词与堆砌的形容词，而口播的呼吸点只有标点能给——厂商按句子本身决定在哪里换气，
 * 句子写长了它就一路念下去。
 */
export const SPOKEN_STYLE_RULES = '必须像人说话，不许像念稿：'
  + '一句不超过 20 字，一句话里最多一个逗号；'
  + '用"你、我"直接说，可以带"啊、呢、吧、真的、说白了"这类口语词；'
  + '不许用"首先/其次/综上/旨在"这类书面连接词，不许用"赋能/闭环/助力/打造"这类行业黑话，不许排比句；'
  + '数字与价格用口语说法（"一百块"而不是"100 元"）；'
  // 平台合规（抖音/小红书/视频号一致）：这些词会被判定为违规营销或站外引流，
  // 视频做得再好也会限流，所以要在**写稿阶段**就避开，而不是等发布后被扣分。
  + '不许用平台违禁词：极限词（最/第一/唯一/国家级/顶级/独家/全网最好/销量冠军）、'
  + '刺激消费词（秒杀/抢爆/错过就没机会/最后一波/不会再便宜了）、'
  + '诱导点击（点击链接/点击领取/点击有惊喜/恭喜获奖）、'
  + '医疗承诺（治愈/根治/防癌/降血压）；'
  + '不报任何联系方式（电话、手机号、社交账号、二维码），不说"加我微信""V 我""看个性签名""主页有微""私信我""评论区扣1""点下方链接"；'
  // 抖音《社区自律公约》明确"同音、谐音、相近文字、数字、符号变相呈现"同样违规，
  // 所以变体词也要一起禁（官方点名的：绿泡泡、VX、小企鹅、某书/某东/某宝、公众号）。
  + '也不许用谐音或变体绕过（绿泡泡、VX、威信、小企鹅、某书、某东、某宝、公众号）；'
  + '不提第三方平台或店铺名、不说"去 XX 平台搜""货到付款"。'

/**
 * 节拍 → 写稿时的语气要求（并进分镜提示词）。
 *
 * @param beat - 节拍。
 * @returns 该拍的语气要求短句。
 */
export function beatToneHint(beat: SpeechBeat): string {
  if (beat === 'hook') return '开头就抓人：一句短促的反问或结论，不要铺垫'
  if (beat === 'pain') return '讲痛点要共情：说出用户真实遇到的麻烦，语气可以沉一点'
  if (beat === 'cta') return '收尾要果断：明确让用户现在做什么，不要含糊'
  return '讲卖点要具体：说清它解决什么问题、怎么用，不要堆形容词'
}

/**
 * 节拍 → 念这一句的语气（并进厂商提示词）。
 *
 * 与 {@link beatToneHint} 配对：那个负责让模型**写出**适合这一拍的句子，
 * 这个负责让厂商**念出**这一拍该有的语气。两者缺一，情绪都落不了地。
 *
 * @param beat - 节拍。
 * @returns 该拍的念法要求短句。
 */
export function beatSpeechHint(beat: SpeechBeat): string {
  if (beat === 'hook') return '这一句语速略快、语气抓人'
  if (beat === 'pain') return '这一句语速放慢、语气沉一点'
  if (beat === 'cta') return '这一句语气果断、音量提一点'
  return '这一句语速平稳、字字清楚'
}

/**
 * 按估算语速把一个句子折算成秒数（至少 1 秒，避免空句被判成 0）。
 *
 * 字数取 {@link spokenCharCount}（去标点）：标点不发音，却要占掉一段停顿，
 * 把标点算进分子就会把这一句的时长估长。
 *
 * @param text - 要念的文本。
 * @param charsPerSecond - 估算用的语速；缺省用产品默认值。
 * @returns 估算秒数。
 */
export function estimateSeconds(text: string, charsPerSecond = CHARS_PER_SECOND): number {
  const pace = charsPerSecond > 0 ? charsPerSecond : CHARS_PER_SECOND
  return Math.max(1, Math.round(spokenCharCount(text) / pace))
}

/**
 * 目标成片时长对应的稿件字数下限。
 *
 * 这是"语速太慢、内容太少"的正面解法：成片长度由台词量决定，字数不够就只剩拖长音的念白。
 *
 * **单位必须与语速一致**：`charsPerSecond` 按去标点的口径标定，这里数出来的也就必须是去标点的字数。
 * 曾经这里与门槛判定各用一套（一个去标点、一个含标点），门槛被系统性算低约 15%（DEF-113）。
 *
 * @param targetSeconds - 目标成片时长（秒）。
 * @param charsPerSecond - 估算用的语速；缺省用产品默认值。
 * @returns 稿件至少要写的字数（不含标点）。
 */
export function minScriptChars(targetSeconds: number, charsPerSecond = CHARS_PER_SECOND): number {
  const pace = charsPerSecond > 0 ? charsPerSecond : CHARS_PER_SECOND
  return Math.ceil(targetSeconds * pace)
}

/** 按句末标点切句，保留标点；纯空白片段丢弃。 */
function splitSentences(text: string): string[] {
  return normalizeSpokenText(text)
    .split(/(?<=[。！？!?；;…])/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * 把稿子切成可以逐段生成的片段。
 *
 * 规则两头的边界都由厂商约束反推，不是随手定的：
 * - 相邻短句合并到 ≥ {@link SEGMENT_MIN_SECONDS} 秒：一次生成最短 4 秒，太短的段会被拉长成慢速念白；
 * - 单段不超过 {@link SEGMENT_MAX_SECONDS} 秒：厂商只收 4~12 秒，超了直接拒收；
 * - 单句本身就超长时按逗号再切，仍超长才硬切，保证必然得到合法片段。
 *
 * @param text - 稿件正文。
 * @param charsPerSecond - 估算用的语速；缺省用产品默认值。
 * @returns 段落文本数组；没有可朗读内容时为空数组。
 */
export function splitScript(text: string, charsPerSecond = CHARS_PER_SECOND): string[] {
  const segments: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.trim() !== '') segments.push(buffer.trim())
    buffer = ''
  }
  for (const sentence of splitSentences(text)) {
    const pieces: string[] = []
    for (const clause of sentence.split(/(?<=[，,、])/)) {
      if (estimateSeconds(clause, charsPerSecond) <= SEGMENT_MAX_SECONDS) { pieces.push(clause); continue }
      const chars = Math.max(1, Math.floor(SEGMENT_MAX_SECONDS * charsPerSecond))
      for (let i = 0; i < clause.length; i += chars) pieces.push(clause.slice(i, i + chars))
    }
    for (const piece of pieces) {
      const merged = buffer + piece
      if (estimateSeconds(merged, charsPerSecond) > SEGMENT_MAX_SECONDS) {
        flush()
        buffer = piece
        continue
      }
      buffer = merged
      if (estimateSeconds(buffer, charsPerSecond) >= SEGMENT_MIN_SECONDS) flush()
    }
  }
  flush()
  return segments
}
