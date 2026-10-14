/**
 * 固定 AI 数字人形象（带货 IP）：形象素材、**念法**目录，与它们到厂商提示词的映射。
 *
 * 一条带货 IP 靠"同一个形象 + 同一种声音"立住。形象素材（照片或视频）与念法随形象一起落盘；
 * 长视频的分段与拼接在 `long-video.ts`（通用工作流），本模块只管数字人自己的东西。
 *
 * **这里没有音色目录，也没有试听**：成片里那一声由厂商（Agnes）在出片时自己念，
 * 厂商侧没有"音色 id"这种概念，声音只能靠提示词描述（性别、口音、音色质感、语速、语气）。
 * 所以摆给用户的是**念法人设**：一个 id + 一句写进提示词的描述 + 一句给用户看的说明。
 * 跨镜、跨片的声音一致性由同一段描述逐镜重复保证。
 *
 * 出厂声线是产品给的一组常用人设（女声/男声 × 亲切/利落/带货/沉稳/少年，含东北话、粤语与台湾腔），
 * 用户可以在此基础上写自己的。念法只影响提示词，因此不存在"选了某条音色却出不来"的失败模式。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/digital-human
 */

/**
 * 一条可选念法：写进厂商提示词的声音人设。
 *
 * 字段收成"描述 + 说明"两件事，是因为它们服务两个不同的读者：
 * `prompt` 给厂商（模型看），`summary` 给用户（选的时候看）。
 */
export interface DigitalHumanPersona {
  /** 念法 id（落盘在形象上）。 */
  id: string
  /** 展示名：用户在列表里看到的就是它。 */
  name: string
  /** 给用户看的一句话：这条声音是什么味道、适合什么内容。 */
  summary: string
  /**
   * 写进厂商提示词的声音描述：**必须逐镜重复**，厂商按镜独立生成、镜间不共享状态。
   *
   * 描述里必须同时给出性别、音色质感、语速与语气——只写"女声"时厂商会换一把声音，
   * 一条片子里就会出现两种人声。
   */
  prompt: string
}

/**
 * 全部可选念法（9 条）。
 *
 * 顺序即展示顺序：先普通话，再地方口音，最后粤语与台湾普通话——与"先找通用、再找特色"的取用顺序一致。
 * 默认是第一条（女声·温柔亲切），带货口播最通用的一档。
 */
export const DIGITAL_HUMAN_PERSONAS: DigitalHumanPersona[] = [
  {
    id: 'female-warm',
    name: '女声·温柔亲切',
    summary: '像朋友聊天，情绪起伏自然；口播带货、护肤美妆、知识分享',
    prompt: '声音：成年女性的普通话，音色温暖柔和，语速中速偏慢（每分钟约 250 字），语气亲切自然，像朋友面对面聊天，句尾不上扬',
  },
  {
    id: 'female-lively',
    name: '女声·活泼俏皮',
    summary: '年轻轻快，节奏偏快；零食日用、年轻女性向、种草短视频',
    prompt: '声音：年轻女性的普通话，音色清亮偏甜，语速偏快（每分钟约 300 字），语气俏皮有活力，句尾微微上扬',
  },
  {
    id: 'female-steady',
    name: '女声·沉稳专业',
    summary: '字正腔圆、不疾不徐；成分讲解、品牌宣传、专业内容',
    prompt: '声音：成年女性的普通话，音色厚实沉稳，语速中速（每分钟约 240 字），语气专业克制，字字清楚，不带情绪起伏',
  },
  {
    id: 'male-sunny',
    name: '男声·阳光',
    summary: '年轻阳光、语气轻快；数码家电、运动户外、男性向种草',
    prompt: '声音：年轻男性的普通话，音色明亮干净，语速中速偏快（每分钟约 270 字），语气阳光自然，像邻家男生',
  },
  {
    id: 'male-steady',
    name: '男声·沉稳',
    summary: '有力洪亮、字字落地；功能演示、挑战类、强节奏口播',
    prompt: '声音：成年男性的普通话，音色低沉有力，语速中速（每分钟约 240 字），语气笃定，重音落在关键信息上',
  },
  {
    id: 'male-broadcast',
    name: '男声·播音',
    summary: '标准播音腔、正式；品牌通告、参数讲解',
    prompt: '声音：成年男性的普通话，标准播音腔，音色浑厚，语速平稳（每分钟约 250 字），语气正式，不用口语词',
  },
  {
    id: 'female-dongbei',
    name: '女声·东北话',
    summary: '东北口音、热络直爽；搞笑测评、接地气带货',
    prompt: '声音：成年女性的东北口音普通话，音色爽朗，语速偏快（每分钟约 290 字），语气热络直爽，自带喜感',
  },
  {
    id: 'female-cantonese',
    name: '女声·粤语',
    summary: '粤语、温婉清晰；香港与广东市场、粤语带货',
    prompt: '声音：成年女性的粤语（香港口音），音色温婉清晰，语速中速（每分钟约 250 字），语气自然亲切',
  },
  {
    id: 'female-taiwan',
    name: '女声·台湾腔',
    summary: '台湾腔、软糯亲和；台湾市场、生活好物种草',
    prompt: '声音：成年女性的台湾普通话，音色软糯，语速中速偏慢（每分钟约 240 字），语气亲和，句尾语气词轻',
  },
]

/** 默认念法：口播带货最通用的一档。 */
export const DEFAULT_DIGITAL_HUMAN_PERSONA = DIGITAL_HUMAN_PERSONAS[0]!.id

/**
 * 参考台词样板：产品给用户看"这样念是什么味道"的例句。
 *
 * 它不再进任何合成接口（已经没有试听），留着是因为创建页与文案示例都拿它当语气样板——
 * 用户照着它写自己的稿子，语气与提示词里的描述才对得上。
 */
export const VOICE_PREVIEW_TEXT = '姐妹们，这款面霜我自己用了三个月，干皮救急真的顶用，今天直播间直降一百。'

/**
 * 旧数据把音色与演绎风格分成两个字段存（Edge 音色 id + 风格 id）。
 * 这张对照表把老形象折成一条念法，不必让用户重新建形象。
 */
const LEGACY_VOICE_PERSONAS: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': 'female-warm',
  'zh-CN-XiaoyiNeural': 'female-lively',
  'zh-CN-liaoning-XiaobeiNeural': 'female-dongbei',
  'zh-CN-shaanxi-XiaoniNeural': 'female-warm',
  'zh-CN-YunxiNeural': 'male-sunny',
  'zh-CN-YunjianNeural': 'male-steady',
  'zh-CN-YunyangNeural': 'male-broadcast',
  'zh-CN-YunxiaNeural': 'male-sunny',
  'zh-HK-HiuMaanNeural': 'female-cantonese',
  'zh-HK-HiuGaaiNeural': 'female-cantonese',
  'zh-HK-WanLungNeural': 'male-steady',
  'zh-TW-HsiaoChenNeural': 'female-taiwan',
  'zh-TW-HsiaoYuNeural': 'female-taiwan',
  'zh-TW-YunJheNeural': 'male-sunny',
}

/** 旧的演绎风格 id 折成念法：只在音色对不上时用（老数据里可能只有风格在）。 */
const LEGACY_STYLE_PERSONAS: Record<string, string> = {
  natural: 'female-warm',
  warm: 'female-warm',
  crisp: 'female-steady',
  hype: 'female-lively',
  pro: 'male-broadcast',
}

/** 按 id 取念法。 */
export function findPersona(persona: string): DigitalHumanPersona | undefined {
  return DIGITAL_HUMAN_PERSONAS.find(item => item.id === persona)
}

/**
 * 念法是否在可选范围内；不在范围内一律回退默认念法。
 *
 * 未知念法不会让任何一次生成失败（厂商只看到一段文字），所以这里回退是**为了让界面有东西可显示**，
 * 而不是为了拦住一次注定失败的请求。
 *
 * @param persona - 形象上记录的念法。
 * @returns 可直接使用的念法 id。
 */
export function resolvePersona(persona: string): string {
  return findPersona(persona) === undefined ? DEFAULT_DIGITAL_HUMAN_PERSONA : persona
}

/**
 * 把一个形象上的念法读成**可直接拼进提示词**的那段描述。
 *
 * 兼容三种老数据：只有音色、只有风格、两者都有。都读不出来时给默认念法——
 * 一段提示词没有声音描述，厂商会自己挑一条，跨镜就会换人声。
 *
 * @param persona - 形象的 persona 字段（可能为空）。
 * @param legacyVoice - 旧数据的音色 id（可能为空）。
 * @param legacyStyle - 旧数据的演绎风格 id（可能为空）。
 * @returns 写进厂商提示词的声音描述。
 */
export function personaPrompt(persona: string, legacyVoice = '', legacyStyle = ''): string {
  const direct = findPersona(persona)
  if (direct !== undefined) return direct.prompt
  const fromVoice = LEGACY_VOICE_PERSONAS[legacyVoice]
  const fromStyle = LEGACY_STYLE_PERSONAS[legacyStyle]
  return (findPersona(fromVoice ?? '') ?? findPersona(fromStyle ?? '') ?? DIGITAL_HUMAN_PERSONAS[0]!).prompt
}
