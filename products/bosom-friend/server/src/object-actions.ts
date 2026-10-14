/**
 * 对象自带的 AI 动作（ADR-004 S2，飞书那一侧"字段捷径 / 多维表格智能体"的对应物）。
 *
 * 与助手对话的区别是本模块存在的全部理由：
 * 对话是"用户把数据搬进对话框"，动作是"**数据自己会动**"——用户点一次，结果直接写回那条对象，
 * 不需要复制粘贴，也不产生一段没人看的文本。
 *
 * 一条动作规格只描述三件事：**改什么字段**、**给模型什么任务**、**把输出整理成什么值**。
 * 模型调用与落库在调用方（`api.ts`），因此这里全是可单测的纯函数。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/object-actions
 */

/** 一条对象级 AI 动作的规格。 */
export interface ObjectActionSpec {
  /** 动作 id：前端按钮与请求体都用它。 */
  id: string
  /** 对象种类：draft / account / record / note。 */
  kind: string
  /** 按钮文案（只给界面，模型看不到）。 */
  label: string
  /** 结果写回对象的哪个字段。 */
  field: string
  /** 给模型的任务说明。 */
  instruction: string
  /**
   * 这次写入的时间戳落在哪个字段。
   *
   * 各对象的更新时间字段名不一样（草稿是 `updatedAt`，账号是 `aiPositioningAt`，笔记没有），
   * 由规格声明出来，运行器就不必靠"对象上恰好有没有 updatedAt"去猜——猜不中时那次写入
   * 会静默地一个时间戳都不留。
   */
  stampField?: string
  /**
   * 从对象里取这一次要重写的当前值。
   *
   * @param record - 产品数据里的对象原文。
   * @returns 当前值；没有时为空串。
   */
  current: (record: Record<string, unknown>) => string
  /**
   * 这个对象的**其他事实**（不是被改的那个字段）。
   *
   * 为什么必须单独有这一路：`current` 给的是"被改字段的当前值"，而它第一次往往是空的——
   * 账号做「AI 定位」时，模型只拿到"当前定位：（空）"，它连这是哪个平台、多少粉丝都不知道，
   * 只能编。这一路把"对象是谁"如实告诉它。
   *
   * @param record - 产品数据里的对象原文。
   * @returns 事实清单（每行一条）；没有额外事实时返回空串。
   */
  context?: (record: Record<string, unknown>) => string
  /**
   * 把模型输出整理成可直接写回的值。
   *
   * @param text - 模型输出的原文。
   * @returns 可写回的值；整理不出内容时为空串（列表字段为空数组）——
   * 调用方据此如实报失败，**绝不写空值覆盖用户已有的内容**。
   */
  normalize: (text: string) => ObjectActionValue
}

/**
 * 动作写回的值。
 *
 * 为什么不是只有字符串：动作写的是**对象上的字段**，而字段不都是单值文本——
 * 草稿的话题就是一个字符串列表（`topics: string[]`）。只认字符串会逼着每个列表字段
 * 自己发明「用逗号拼起来再拆开」的私规，最后写进去的东西和字段的类型对不上。
 */
export type ObjectActionValue = string | string[]

/** 标题类输出最多留多少字：模型偶尔带解释，宁可截断也不要写进一条半句话。 */
export const MAX_TITLE_CHARS = 30
/** 正文类输出上限：与发布侧的字数门槛同量级。 */
const MAX_BODY_CHARS = 2000
/** 笔记正文上限：笔记本来就是长篇，但也要有个头，防止一次动作把文件撑爆。 */
export const MAX_NOTE_CHARS = 8000

/** 取对象上的字符串字段；非字符串按空串处理。 */
function textField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  return typeof value === 'string' ? value : ''
}

/**
 * 剥掉模型爱加的外壳：Markdown 标题记号、`标题：` 这类前缀、包裹的引号。
 *
 * @param text - 模型输出。
 * @returns 去掉外壳后的单段文本。
 */
function stripDecoration(text: string): string {
  let value = text.trim()
  value = value.replace(/^#+\s*/, '')
  value = value.replace(/^(标题|正文|描述|文案|Title|Body|Description)\s*[:：]\s*/i, '')
  value = value.replace(/^["'“”‘’「」『』【】]+/, '').replace(/["'“”‘’「」『』【】]+$/, '')
  return value.trim()
}

/**
 * 整理标题：单行、去掉外壳、限长。
 *
 * 为什么限长而不是"原样写回"：平台对标题有硬性字数门槛（超过就发不出去），
 * 而这个动作的结果是**直接落库**的，用户看不到中间态——写进一条发不出去的标题，
 * 比失败更糟。宁可截断并让用户在界面上看到结果。
 *
 * @param text - 模型输出。
 * @returns 可写回的标题；整理不出内容时为空串。
 */
export function normalizeTitle(text: string): string {
  const line = stripDecoration(text).split('\n').map(item => item.trim()).find(item => item !== '') ?? ''
  return line.slice(0, MAX_TITLE_CHARS)
}

/**
 * 整理正文：保留段落结构，去掉外壳与首尾空白，限长。
 *
 * @param text - 模型输出。
 * @returns 可写回的正文；整理不出内容时为空串。
 */
export function normalizeBody(text: string): string {
  const body = stripDecoration(text).replace(/\n{3,}/g, '\n\n').trim()
  return body.slice(0, MAX_BODY_CHARS)
}

/**
 * 整理笔记正文。
 *
 * **不剥 Markdown 标题记号**（与标题不同）：笔记本来就以 `# 标题` 开头，剥掉就是**改内容**。
 * 只处理一件事——模型偶尔把整段包进代码块，那就把最外层围栏去掉，里面的 Markdown 一字不动。
 *
 * @param text - 模型输出。
 * @returns 可写回的笔记正文；整理不出内容时为空串。
 */
export function normalizeNote(text: string): string {
  // 这里**不能**走 stripDecoration：它会剥掉行首的 `#`，而 `# 标题` 正是笔记的内容。
  let value = text.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(value)
  if (fenced?.[1] !== undefined) value = fenced[1]
  return value.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_NOTE_CHARS)
}

/**
 * 草稿这一层的对象事实：**除了被改的那个字段**之外的其他字段。
 *
 * 为什么必须有：动作第一次跑的时候 current 是空的（新草稿没有话题），
 * 模型只看到「当前内容：（当前为空）」，却被要求"读标题与正文"——它读不到，
 * 于是只能回一句元回应。真实跑出来的原文是：「理解，我将直接输出内容而不使用任何工具。」
 * （2026-09-22 线上探针，靠 object_action_unusable 这条日志才看清是提示词缺料，不是模型不行）。
 *
 * @param record - 草稿原文。
 * @param skip - 被改字段（不再重复给，它已经在【要改的对象】的当前内容里）。
 * @returns 事实清单（每行一条）。
 */
function draftFacts(record: Record<string, unknown>, skip: string): string {
  const lines: string[] = []
  if (skip !== 'title') lines.push('标题：' + (textField(record, 'title') || '（无标题）'))
  if (skip !== 'desc') lines.push('正文：' + (textField(record, 'desc') || '（无正文）'))
  if (skip !== 'topics') {
    const topics = Array.isArray(record.topics) ? record.topics.filter(item => typeof item === 'string') : []
    lines.push('已有话题：' + (topics.length > 0 ? topics.join('、') : '（无）'))
  }
  return lines.join('\n')
}

/** 合规检查里给模型看的正文长度上限（字）：够它判断措辞风险，又不把整篇长文塞进一次检查。 */
const MAX_COMPLIANCE_BODY_CHARS = 600

/**
 * 话题数量上限：**产品策略** —— 控制单次生成的话题规模，并让同一条草稿便于跨平台复用。
 *
 * **这不是已核验的平台兼容性保证**：原注释「低于平台最严的 10」依赖一个**来源未定的历史值**
 * （`PLATFORM_CONTENT_LIMITS.xhs.topics`，DEF-238 列为 D 类），该依据已撤销、不再引用。
 *
 * @constraintRelation gen-le-platform
 * @constraintTarget PLATFORM_CONTENT_LIMITS.*.topics
 * @constraintRationale shared-multiplatform-draft
 */
export const MAX_TOPICS = 8
/**
 * 单个话题的字数上限。超出的**整条丢掉而不是截断**——
 * 被截半句的「话题」用户看不懂；丢掉只说明模型没按要求给，调用方会如实报「没有可用内容」。
 */
const MAX_TOPIC_CHARS = 16

/** 去掉话题上的外壳：序号、项目符号、引号、井号、「话题：」这类前缀。 */
function cleanTopic(raw: string): string {
  let value = raw.trim()
  value = value.replace(/^[-*•·]\s*/, '')
  value = value.replace(/^\d+[.、)]\s*/, '')
  value = value.replace(/^(话题|标签|Topics?|Tags?)\s*[:：]\s*/i, '')
  value = value.replace(/^["'“”‘’「」『』【】#]+\s*/, '')
  value = value.replace(/["'“”‘’「」『』【】#]+\s*$/, '')
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 模型这次的输出是不是**关于任务本身的话**（元回应），而不是这条对象要的内容。
 *
 * 为什么要单独判：模型偶尔会回"我理解这是一个纯文本生成任务…不过您没有提供具体的创作需求"
 * 这类话——它**描述的是任务，不是内容**。写进字段就是污染（真机实测：一句这样的回应被写成了配图建议）。
 * 与"调过工具的产出"是两件事：那种由传输层丢弃（见 streamLlmWithDeltas），这种要在这里拦。
 *
 * 口径刻意收窄：只认"开头就是这些套话"或"明确说没拿到需求"，避免把正常内容误判
 * （例如复盘正文里出现"我理解"三个字不该被拦）。
 *
 * @param text - 模型输出原文。
 * @returns 像元回应时为 true。
 */
export function looksLikeMetaReply(text: string): boolean {
  const head = text.trim().slice(0, 40)
  // 明确的拒绝式开头：与助手那条路的 modelRefused 同一口径。
  if (/^(我无法|我不能|我没有权限|无法直接|不能直接|只能手动|抱歉[，,]我无法)/.test(head)) return true
  // 套话开头**加上**明说"没拿到需求"才算——两句都要满足。
  // 只按开头判会把"我理解的目标用户是刚入行的运营"这类正常内容误判（判据当场抓到过一次）。
  if (!/^(我理解|我明白|收到|好的[，,]|抱歉|对不起|很抱歉)/.test(head)) return false
  return /(没有提供|未提供|请提供|没有给出|缺少).{0,14}(需求|主题|信息|内容|素材|上下文)/.test(text)
}

/**
 * 把模型输出整理成话题列表。
 *
 * 形态要认全：模型会按 Markdown 列表一行一个给、会用中文顿号连成一行给、也会给一个 JSON 数组。
 * 只认其中一种，另外两种就会被当成「一个很长的话题」写进字段里。
 *
 * @param text - 模型输出。
 * @returns 可直接写回 `topics` 的话题数组；整理不出内容时为空数组。
 */
export function normalizeTopics(text: string): string[] {
  let body = text.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(body)
  if (fenced?.[1] !== undefined) body = fenced[1]
  const json = /^\[[\s\S]*\]$/.test(body.trim()) ? tryParseStringArray(body) : undefined
  const lines = json ?? body.split(/\r?\n/)
  const topics: string[] = []
  for (const line of lines) {
    // 分隔符**不含全角逗号**：中文的列表用顿号（、），而「，」是句子内部的停顿——
    // 拿它切分会把"这一条其实是一整句解释，不该被当成话题"切成两半，前半段长度正好合格，
    // 于是一句解释被当成话题写进字段（判据当场抓到的就是这个）。
    for (const piece of line.split(/[、,;；|]/)) {
      const topic = cleanTopic(piece)
      // 太短的是碎片，太长的是模型没按要求写（整句解释）——两种都不是话题。
      if (topic.length < 2 || topic.length > MAX_TOPIC_CHARS) continue
      if (topics.includes(topic)) continue
      topics.push(topic)
    }
  }
  return topics.slice(0, MAX_TOPICS)
}

/** 解析 JSON 字符串数组；不是数组、或元素不全是字符串时返回 undefined（回落到按行切）。 */
function tryParseStringArray(text: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return undefined
    return parsed.every(item => typeof item === 'string') ? parsed as string[] : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 全部已登记的对象级动作。
 *
 * 新增一个动作 = 在这里加一条 + 前端加一个按钮；调用方（路由与内核工具）自动认得它。
 *
 * 字段名必须与对象上真实存在的字段一致：写回是 `record[field] = value`，
 * 写一个不存在的字段会静默产生一个谁也不认识的键。
 */
export const OBJECT_ACTIONS: readonly ObjectActionSpec[] = [
  {
    id: 'draft-title',
    kind: 'draft',
    label: 'AI 改标题',
    field: 'title',
    stampField: 'updatedAt',
    instruction: '把这条草稿的标题重写一遍：保留原文的事实与卖点，不要编造新的数字或承诺；'
      + '不超过 30 个字，不要加表情符号，不要加引号，只输出标题本身。',
    current: record => textField(record, 'title'),
    context: record => draftFacts(record, 'title'),
    normalize: normalizeTitle,
  },
  {
    id: 'draft-body',
    kind: 'draft',
    label: 'AI 优化正文',
    field: 'desc',
    stampField: 'updatedAt',
    instruction: '把这条草稿的正文重写一遍：保留原文的事实、卖点与结构，不要编造数据或承诺；'
      + '口语化、适合直接发布，只输出正文本身，不要写"标题"两个字。',
    current: record => textField(record, 'desc'),
    context: record => draftFacts(record, 'desc'),
    normalize: normalizeBody,
  },
  {
    id: 'draft-topics',
    kind: 'draft',
    label: 'AI 生成话题',
    field: 'topics',
    stampField: 'updatedAt',
    instruction: '给这条草稿配话题标签：读标题与正文，挑出目标用户**真的会拿去搜**的词。'
      + '每行一个，只写话题本身（不要 # 号、不要序号、不要解释、不要引号），4~6 个，每个不超过 12 个字；'
      + '不要写「日常」「分享」这类放之四海皆准的大词，也不要写正文里没有提到的东西；'
      + '不要和【要改的对象】的当前内容重复。',
    // 字段是字符串列表：这里拼成一行给模型看，写回时仍然是数组（见 normalizeTopics）。
    current: record => (Array.isArray(record.topics) ? record.topics.join('、') : ''),
    // 生成话题靠的就是标题与正文——不给这两样，模型没有任何可读的料。
    context: record => draftFacts(record, 'topics'),
    normalize: normalizeTopics,
  },
  {
    id: 'draft-compliance',
    kind: 'draft',
    label: 'AI 合规检查',
    field: 'aiCompliance',
    stampField: 'updatedAt',
    // 与其它动作的区别：它**不改内容**，只给判断。所以指令要的是"逐条核 + 给改法"，
    // 而不是"重写一遍"；也不许把没问题的说成有问题（那会让用户白改一轮）。
    instruction: '逐条检查这条草稿能不能安全发出：① 标题字数是否超限；② 正文是不是太长；'
      + '③ 话题数是不是超限；④ 有没有绝对化用语（最、第一、唯一、100%）；⑤ 有没有医疗/功效承诺'
      + '（治好、根治、瘦身、包瘦）或收益承诺；⑥ 有没有诱导分享、站外引流、索要联系方式。'
      + '没有任何问题时只回一行「通过」；有问题时先写「发现 N 处」，再每条一行：问题在哪、为什么要改、改成什么。'
      + '不要编造没出现的问题，拿不准的写「不确定」而不是当成问题。',
    current: record => textField(record, 'aiCompliance'),
    // 检查要核的事实：字数与数量由产品数准（模型自己数会数错），措辞风险由模型判断。
    context: (record) => {
      const title = textField(record, 'title')
      const desc = textField(record, 'desc')
      const topics = Array.isArray(record.topics) ? record.topics.filter(item => typeof item === 'string') : []
      const accountTypes = Array.isArray(record.accountTypes) ? record.accountTypes.filter(item => typeof item === 'string') : []
      return [
        '标题：' + (title === '' ? '（无标题）' : title) + '（' + String(title.length) + ' 字，上限 ' + String(MAX_TITLE_CHARS) + '）',
        // **正文必须给原文，不能只给字数**：第一版只写了"正文共 N 字"，结果模型把标题挑出来之后
        // 正文里的功效承诺与引流一句都没提（真机实测，2026-09-22）——检查查不了它看不见的东西。
        // 与焦点摘要同一口径截断：够判断，又不至于把整篇长文塞进检查。
        '正文：' + (desc === '' ? '（无正文）' : desc.slice(0, MAX_COMPLIANCE_BODY_CHARS)
          + (desc.length > MAX_COMPLIANCE_BODY_CHARS ? '…（正文共 ' + String(desc.length) + ' 字，以上为前 ' + String(MAX_COMPLIANCE_BODY_CHARS) + ' 字）' : '')),
        '话题 ' + String(topics.length) + ' 个（上限 ' + String(MAX_TOPICS) + '）' + (topics.length > 0 ? '：' + topics.join('、') : ''),
        '目标平台：' + (accountTypes.length > 0 ? accountTypes.join('、') : '未指定'),
      ].join('\n')
    },
    normalize: normalizeBody,
  },
  {
    id: 'draft-illustration',
    kind: 'draft',
    label: 'AI 配图建议',
    field: 'aiIllustration',
    stampField: 'updatedAt',
    // 与合规检查一样是"给判断"，但判断的对象是**画面**：要具体到能照着拍/照着选，
    // 而且要落在用户自己的素材上——不看他库里有什么就出建议，等于让他去别处找图。
    instruction: '给这条内容出配图建议，按四段写：① 需要几张图（按平台惯例给一个数）；'
      + '② 每张拍/选什么画面（具体到"拍什么、什么角度、画面里有什么"，不要写"高质量""有氛围感"这类空话）；'
      + '③ 从素材库里挑哪几张（只能从给出的事实里挑，库里的图不够用就直说"需要补拍 N 张"）；'
      + '④ 封面用哪一张、为什么。只给配图建议，不要写文案，不要编造素材库里没有的图。',
    current: record => textField(record, 'aiIllustration'),
    context: (record) => {
      const title = textField(record, 'title')
      const desc = textField(record, 'desc')
      const media = Array.isArray(record.mediaList) ? record.mediaList : []
      return [
        '标题：' + (title === '' ? '（无标题）' : title),
        '正文：' + (desc === '' ? '（无正文）' : desc.slice(0, MAX_COMPLIANCE_BODY_CHARS)),
        '这条草稿现在已有素材 ' + String(media.length) + ' 个',
      ].join('\n')
    },
    normalize: normalizeBody,
  },
  {
    id: 'account-positioning',
    kind: 'account',
    label: 'AI 定位',
    field: 'aiPositioning',
    // 账号没有 updatedAt（只有 updateTime，那是账号自身资料的更新时间）：
    // 定位的时间戳单独记，不和"账号资料什么时候变的"混成一个。
    stampField: 'aiPositioningAt',
    instruction: '根据这个账号的平台、昵称与粉丝量，写出它的**定位与人设**：'
      + '一句话讲清"给谁看、靠什么留住人"。不要编造账号数据（粉丝数、平台都由事实给出），'
      + '不要写运营计划或涨粉技巧；不超过 80 个字，只输出这句定位本身。',
    current: record => textField(record, 'aiPositioning'),
    // 账号的事实：模型必须知道它给哪个平台、哪个号、多少人写定位。
    context: (record) => {
      const lines = [
        '平台：' + (textField(record, 'type') || '未知'),
        '昵称：' + (textField(record, 'nickname') || '（未设置）'),
      ]
      const fans = record.fansCount
      lines.push('粉丝数：' + (typeof fans === 'number' ? String(fans) : '平台未提供'))
      return lines.join('\n')
    },
    normalize: normalizeBody,
  },
  {
    id: 'account-risk',
    kind: 'account',
    label: 'AI 风险评估',
    field: 'aiRisk',
    stampField: 'aiRiskAt',
    // 与定位的区别：定位是"这个号该讲什么"，风险是"这个号现在能不能干活"。
    // 所以要的是**判断 + 依据 + 先做什么**，而不是一段人设描述。
    instruction: '判断这个账号现在有哪些风险，按三段写：① 风险等级（高/中/低）；'
      + '② 依据（只引用给你的事实：登录态、发布失败次数与原因、发布量）；'
      + '③ 先做什么（一到两条具体动作）。'
      + '**只依据给出的事实**，不要编造平台处罚、限流或流量数据；'
      + '事实里没有问题就明说「未见明显风险」，**不要为了凑内容编一条出来**。',
    current: record => textField(record, 'aiRisk'),
    // 这条号自己身上的事实（纯函数、可单测）；发布失败史由适配器另给（见 ObjectAdapter.find 的 facts）。
    context: (record) => {
      const lines = [
        '平台：' + (textField(record, 'type') || '未知'),
        '昵称：' + (textField(record, 'nickname') || '（未设置）'),
      ]
      const fans = record.fansCount
      lines.push('粉丝数：' + (typeof fans === 'number' ? String(fans) : '平台未提供'))
      const loginState = textField(record, 'loginState')
      const loginNote = textField(record, 'loginNote')
      lines.push('登录态：' + (loginState === 'invalid'
        ? '已失效' + (loginNote === '' ? '' : '（' + loginNote + '）')
        : loginState === 'valid' ? '正常' : '未知（还没有平台侧判定）'))
      lines.push('产品侧状态：' + (record.status === 1 ? '正常' : '已失效'))
      return lines.join('\n')
    },
    normalize: normalizeBody,
  },
  {
    id: 'note-polish',
    kind: 'note',
    label: 'AI 润色',
    field: 'content',
    instruction: '把这条笔记润色一遍：保留全部事实、结论与 Markdown 结构（标题层级、列表、链接、代码块）；'
      + '只让表达更清楚、句子更短；不要新增未经确认的事实、数字或结论，也不要删掉原有的信息点；'
      + '只输出笔记正文本身。',
    current: record => textField(record, 'content'),
    normalize: normalizeNote,
  },
  {
    id: 'work-review',
    kind: 'work',
    label: 'AI 复盘',
    field: 'aiReview',
    stampField: 'aiReviewAt',
    instruction: '复盘这条**已经发出去的作品**：先说清它现在拿到了什么（只用【已知事实】里给出的数字），'
      + '再说这可能是因为什么，最后给出**下一条同类选题该怎么做**的一到两条具体调整。'
      + '不要编造任何没有给出的数字、评论内容或平台规则；不要写"继续加油""保持更新"这类空话；'
      + '不超过 200 个字，只输出复盘本身。',
    current: record => textField(record, 'aiReview'),
    // 复盘靠的是数据：标题、发布多久了、各项互动——只给"当前复盘：（空）"的话，模型只能凭标题编。
    context: (record) => {
      const lines = [
        '平台：' + (textField(record, 'accountType') || '未知'),
        '标题：' + (textField(record, 'title') || '（无标题）'),
        '发布时间：' + (textField(record, 'publishTime') || '未知'),
      ]
      const engagement = record.engagement as Record<string, unknown> | undefined
      // 缺省 = 平台还没采到，**不是 0**：写成 0 会让模型得出"没人看"的错误结论。
      const metrics: Array<[string, string]> = [
        ['播放量', 'viewCount'],
        ['点赞数', 'likeCount'],
        ['评论数', 'commentCount'],
        ['收藏数', 'favoriteCount'],
        ['转发数', 'shareCount'],
      ]
      for (const [label, key] of metrics) {
        const value = engagement?.[key]
        lines.push(label + '：' + (typeof value === 'number' ? String(value) : '平台未采集'))
      }
      return lines.join('\n')
    },
    normalize: normalizeBody,
  },
]

/**
 * 按对象种类与动作 id 找一条规格。
 *
 * @param kind - 对象种类。
 * @param id - 动作 id。
 * @returns 匹配的规格；没登记时为 undefined（调用方如实报"不认识这个动作"）。
 */
export function findObjectAction(kind: string, id: string): ObjectActionSpec | undefined {
  return OBJECT_ACTIONS.find(item => item.kind === kind && item.id === id)
}

/**
 * 某个对象种类上可用的动作（给前端渲染按钮用；只给 id 与文案，不暴露提示词）。
 *
 * @param kind - 对象种类。
 * @returns 动作清单。
 */
export function objectActionsFor(kind: string): Array<{ id: string, label: string, field: string }> {
  return OBJECT_ACTIONS
    .filter(item => item.kind === kind)
    .map(item => ({ id: item.id, label: item.label, field: item.field }))
}

/**
 * 拼这次动作送给模型的那段用户输入。
 *
 * 为什么把"当前值"和"任务"分成两段而不是一句话：模型对"这是素材、这是要求"的切分很敏感，
 * 混成一句话时它常常把要求也当成素材抄进结果里。
 *
 * @param spec - 动作规格。
 * @param current - 对象的当前值（可能为空）。
 * @param extra - 界面上额外填的要求（可为空）。
 * @param context - 这个对象的其他事实（见 {@link ObjectActionSpec.context}）；没有就传空串。
 * @returns 提示词文本。
 */
export function buildObjectActionPrompt(spec: ObjectActionSpec, current: string, extra = '', context = ''): string {
  const lines: string[] = []
  lines.push('【要改的对象】')
  if (context !== '') {
    lines.push('已知事实（不要再编这些）：')
    lines.push(context)
    lines.push('')
  }
  lines.push('字段：' + spec.field)
  lines.push('当前内容：')
  lines.push(current === '' ? '（当前为空）' : current)
  lines.push('')
  lines.push('【怎么改】')
  lines.push(spec.instruction)
  const trimmed = extra.trim()
  if (trimmed !== '') {
    lines.push('')
    lines.push('【用户额外要求】')
    lines.push(trimmed)
  }
  // 只输出结果值：这是"字段捷径"不是对话，结果会被直接写回对象，多余的话会一起落库。
  lines.push('')
  lines.push('直接输出改写后的内容本身，不要任何解释、前后缀或引号。')
  return lines.join('\n')
}
