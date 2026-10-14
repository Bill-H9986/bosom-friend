const FENCE = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96)
import { describe, expect, it } from 'vitest'
import {
  MIN_PRODUCT_SHOTS,
  SHOT_MAX_SECONDS,
  SHOT_MIN_SECONDS,
  SHOT_TARGET_SECONDS,
  SHOT_TEMPLATES,
  pickShotTemplate,
  requestsRenderedText,
  auditShotPlan,
  buildStoryboardPrompt,
  fallbackShotPlan,
  fillMissingLines,
  fitScriptToShots,
  parseShotPlan,
  planShotCount,
  ensureBrollShots,
  shotsCoverTarget,
  shotsSpokenChars,
  subjectFromTopic,
} from '../../src/storyboard.ts'
import { estimateSeconds, minScriptChars, spokenCharCount } from '../../src/speech.ts'
import type { ZyShot } from '../../src/types.ts'
import { NO_PERSON_CLAUSE, NO_RENDERED_TEXT } from '../../src/storyboard.ts'
import { AGNES_VIDEO_PROMPT_FIELDS, agnesVideoPromptStructureText } from '../../src/agnes.ts'
import type { ZyShotRef } from '../../src/types.ts'

/**
 * 分镜表：通用工作流的核心中间层。
 *
 * 这里钉的是三件事——**镜头数按节奏算**（成熟带货片平均镜头约 6 秒）、
 * **模型输出永远不可信**（越界要夹、脏数据要丢）、**模型挂了也要排得出片**（确定性兜底）。
 */

const REFS: ZyShotRef[] = [
  { url: '/bosom-friend/api/assets/file/avatar.png', role: 'person' },
  { url: '/bosom-friend/api/assets/file/product.png', role: 'product' },
]

describe('短时长、多片段：镜头数按 5 秒一镜折算', () => {
  it('目标 5 秒一镜（不是厂商上限的 12 秒），且至少 2 镜', () => {
    expect(SHOT_TARGET_SECONDS, '单镜目标是 5 秒').toBe(5)
    expect(SHOT_MAX_SECONDS, '我们主动压在厂商 12 秒上限之下').toBe(6)
    expect(SHOT_MIN_SECONDS, '下界就是厂商最短 4 秒').toBe(4)
    expect(planShotCount(12)).toBe(3)
    expect(planShotCount(30)).toBe(6)
    expect(planShotCount(60)).toBe(12)
    expect(planShotCount(1)).toBe(2)
    expect(planShotCount(Number.NaN)).toBe(4)
  })

  it('向上取整：宁可多切一镜，也不把尾巴塞进一个长镜', () => {
    expect(planShotCount(11)).toBe(3)
    expect(planShotCount(90)).toBe(18)
  })
})

describe('分镜要求：三条硬约束必须写进提示词', () => {
  it('给出总镜数与产品镜下限，且要求画面里不出现文字/品牌', () => {
    const prompt = buildStoryboardPrompt(30, false)
    expect(prompt).toContain('共 6 镜')
    expect(prompt, '短镜要求要写进提示词').toContain('4~6 秒之间')
    expect(prompt, '台词也要短：一镜一句、按字数给上限').toContain('一镜一句、每句 18~27 个字')
    expect(prompt).toContain('至少 ' + String(MIN_PRODUCT_SHOTS) + ' 个 product 镜头')
    expect(prompt, '画字会生成臆造品牌，必须明令禁止').toContain('不许出现任何文字、品牌名、logo')
    expect(prompt).toContain('continuity')
    expect(prompt, '只认 JSON，不要解释').toContain('只输出 JSON')
  })

  it('有没有产品参考图，产品镜的写法不同', () => {
    expect(buildStoryboardPrompt(30, true)).toContain('用户提供了产品参考图')
    expect(buildStoryboardPrompt(30, false)).toContain('没有产品参考图')
  })

  it('数字人口播：只有口播镜能出现人，其余镜头连"手"都要限定', () => {
    const plain = buildStoryboardPrompt(30, true)
    expect(plain, '不打开这条口径时不该出现人物禁令').not.toContain('只有 talking-head 镜能出现人')
    const prompt = buildStoryboardPrompt(30, true, { personOnlyInTalkingHead: true })
    expect(prompt, '模型最容易写的就是"双手打开瓶盖""演员侧脸"这类画面').toContain('只有 talking-head 镜能出现人')
    expect(prompt).toContain(NO_PERSON_CLAUSE)
    expect(prompt, '口播镜的长相由参考图决定，文字再写一遍就会换一张脸').toContain('不要描述长相')
  })

  it('语速折算进提示词：语速越慢要求的字数越少，非法值回退产品默认', () => {
    const fast = buildStoryboardPrompt(30, false, { charsPerSecond: 4.5 })
    const slow = buildStoryboardPrompt(30, false, { charsPerSecond: 3.4 })
    expect(fast).toContain('每秒 4.5 字')
    expect(slow).toContain('每秒 3.4 字')
    expect(slow, '语速慢时字数下限更低').toContain('不少于 ' + String(minScriptChars(30, 3.4)) + ' 字')
    expect(Number.parseInt(String(minScriptChars(30, 3.4)), 10))
      .toBeLessThan(Number.parseInt(String(minScriptChars(30, 4.5)), 10))
    // 非法语速回退默认值，不把 0 写进提示词。
    expect(buildStoryboardPrompt(30, false, { charsPerSecond: 0 })).toContain('每秒 4.5 字')
  })

  it('每一镜都要有 line（含产品镜/空镜），不再要求任何镜头留空', () => {
    const prompt = buildStoryboardPrompt(90, true)
    expect(prompt, '每一镜都要念，画面切到产品时口播不能停').toContain('**每一镜都要有 line**')
    expect(prompt, '旧口径（产品镜 line 留空）必须删掉').not.toContain('line 留空')
    // 字数下限与镜头数自洽：全片总字数要分到全部镜头里，包括产品镜的那几句。
    expect(prompt).toContain('不少于 ' + String(minScriptChars(90)) + ' 字')
    expect(prompt).toContain('这些字要分到全部 ' + String(planShotCount(90)) + ' 个镜头里')
    expect(prompt, '包括产品镜的那几句').toContain('包括 product/scene 镜的那几句')
  })
})

describe('解析模型输出：能夹就夹、夹不了就丢', () => {
  it('带 Markdown 代码块与前后废话也能抠出 JSON', () => {
    const raw = '好的，这是分镜：\n' + FENCE + JSON.stringify({ continuity: '室内暖光', shots: [{ kind: 'talking-head', seconds: 6, line: '姐妹们看过来', beat: 'hook' }] }) + '\n' + FENCE + '\n以上。'
    const shots = parseShotPlan(raw, REFS, 'digital-human')
    expect(shots).toHaveLength(1)
    expect(shots[0]!.kind).toBe('talking-head')
    expect(shots[0]!.beat).toBe('hook')
    expect(shots[0]!.continuity).toBe('室内暖光')
    expect(shots[0]!.references, '参考图集要挂到每一镜上').toEqual(REFS)
  })

  it('时长越界夹回"短镜"区间（不是厂商的 4~12 秒），类型写错按有无文本推断', () => {
    const raw = JSON.stringify({
      shots: [
        { kind: 'product', seconds: 99, visual: '产品缓慢旋转', line: '' },
        { kind: '胡说', seconds: 1, line: '这一句要念出来', visual: '' },
        { kind: 'scene', seconds: 'abc', visual: '空镜' },
      ],
    })
    const shots = parseShotPlan(raw, REFS, 'scene')
    // 99 秒夹到短镜上界 6（不是厂商上限 12）；1 秒抬到下界 4；非法值落到目标 5 秒。
    expect(shots.map(item => item.seconds)).toEqual([SHOT_MAX_SECONDS, SHOT_MIN_SECONDS, SHOT_TARGET_SECONDS])
    expect(shots[0]!.kind).toBe('product')
    expect(shots[1]!.kind, '不认识的类型 + 有文本 → 口播镜').toBe('talking-head')
    expect(shots[2]!.kind).toBe('scene')
  })

  it('空内容与脏数据被丢弃，不把整条片带崩', () => {
    const raw = JSON.stringify({ shots: [null, 'x', { kind: 'product' }, { line: '   ', visual: '  ' }, { line: '留下的这一句' }] })
    const shots = parseShotPlan(raw, REFS, 'digital-human')
    expect(shots).toHaveLength(1)
    expect(shots[0]!.line).toBe('留下的这一句')
    expect(shots[0]!.kind, '只给了文本，按口播镜处理').toBe('talking-head')
  })

  it('解析不出 JSON / 不是对象 / 没有 shots 都返回空数组', () => {
    expect(parseShotPlan('模型今天不想输出 JSON', REFS, 'x')).toEqual([])
    expect(parseShotPlan(FENCE + 'json\n{坏掉的\n' + FENCE, REFS, 'x')).toEqual([])
    expect(parseShotPlan('"就是一句话"', REFS, 'x')).toEqual([])
    expect(parseShotPlan('{"continuity":"有","shots":"不是数组"}', REFS, 'x')).toEqual([])
  })

  it('文字卡不带参考图（它不需要厂商画面）', () => {
    const raw = JSON.stringify({ shots: [{ kind: 'text-card', seconds: 4, visual: '价格卡：直降一百' }] })
    const shots = parseShotPlan(raw, REFS, 'scene')
    expect(shots[0]!.kind).toBe('text-card')
    expect(shots[0]!.references).toEqual([])
  })
})

describe('确定性兜底：模型不可用时也排得出片', () => {
  it('口播镜与产品镜交替，口播句按顺序分给每一镜（产品镜也有台词）', () => {
    const texts = ['第一句口播内容。', '第二句口播内容。', '第三句口播内容。', '第四句口播内容。']
    const shots = fallbackShotPlan(texts, REFS, 'digital-human', true)
    // 4 句口播：每 2 个口播镜后切一次产品画面，产品镜拿走下一句 → 4 镜，都是 4 句里的句子。
    expect(shots.map(item => item.kind)).toEqual(['talking-head', 'talking-head', 'product', 'talking-head'])
    expect(shots.map(item => item.line), '每一镜都要念一句，且不重复、不错序').toEqual(texts)
    expect(shots[2]!.visual).toContain('参考图中的产品')
    expect(shots[2]!.references, '产品镜只挂产品参考图，不把人物图塞进产品镜').toEqual([
      { url: '/bosom-friend/api/assets/file/product.png', role: 'product' },
    ])
    expect(shots[2]!.seconds, '产品镜时长由它自己那句口播决定，不是固定的 5 秒').toBe(estimateSeconds(texts[2]!))
    expect(shots[3]!.index, '索引连续，便于逐镜重做时定位').toBe(3)
  })

  it('没有产品参考图时不插产品镜：凭空画一个产品比"只有口播"更糟', () => {
    const shots = fallbackShotPlan(['一。', '二。'], REFS, 'scene', false)
    expect(shots.map(item => item.kind)).toEqual(['talking-head', 'talking-head'])
  })

  it('有产品参考图才插产品镜，且产品镜文案明令画面里不许出现文字/品牌', () => {
    const shots = fallbackShotPlan(['一。', '二。', '三。'], REFS, 'scene', true)
    const product = shots.find(item => item.kind === 'product')
    expect(product?.visual).toContain('参考图中的产品')
    expect(product?.visual).toContain('不出现任何文字与品牌标识')
    expect(product?.line, '产品镜同样有口播').toBe('三。')
    expect(auditShotPlan(shots).suspiciousTextRequests, '兜底文案自己不能要求画字').toEqual([])
  })

  it('兜底路径里没有一镜是静音的（产品镜也一样）', () => {
    const texts = ['第一句口播内容。', '第二句口播内容。', '第三句口播内容。', '第四句口播内容。', '第五句口播内容。']
    for (const shots of [fallbackShotPlan(texts, REFS, 'digital-human', true), fallbackShotPlan(texts, REFS, 'digital-human', false)]) {
      expect(shots.every(item => item.line !== ''), '兜底排出来的每一镜都要有台词').toBe(true)
      expect(new Set(shots.map(item => item.line)).size, '同一句不得被念两遍').toBe(texts.length)
    }
  })
})

describe('旁白铺满整条时间轴：空 line 的镜头补上稿件里还没念过的句子', () => {
  /** 四句稿件，每句都够 4 秒（切段口径：相邻短句会合并），切出来就是四段。 */
  const S1 = '第一句话讲开场钩子，先把人留住再说别的。'
  const S2 = '第二句话说清痛点，让用户觉得说的就是自己。'
  const S3 = '第三句话讲卖点，具体说清怎么用、有什么用。'
  const S4 = '第四句话收尾，让用户现在就点下方链接下单。'
  const SCRIPT = S1 + S2 + S3 + S4

  /** 按模型常给的那种分镜表建镜头：产品镜只有 visual，没有 line。 */
  const planOf = (rows: Array<Record<string, unknown>>) => parseShotPlan(JSON.stringify({ shots: rows }), REFS, 'digital-human')

  it('空 line 的产品镜被补上稿件里的下一句，已有 line 不被覆盖、顺序与稿件一致', () => {
    const shots = planOf([
      { kind: 'talking-head', seconds: 5, line: S1 },
      { kind: 'product', seconds: 5, visual: '产品缓慢旋转' },
      { kind: 'talking-head', seconds: 5, line: S3 },
    ])
    const filled = fillMissingLines(shots, SCRIPT)
    expect(filled.map(item => item.line)).toEqual([S1, S2, S3])
    expect(shots[1]!.line, '原数组不得被就地改写').toBe('')
    // 判据按**这句台词自己的折算秒数**算，不写死数字：写死等于把"字数 → 秒数"的口径抄了第二遍，
    // 口径一改（如去标点计字）用例就会指着一个正确的产出说它错。
    expect(filled[1]!.seconds, '补上句子后时长按这句话的字数算').toBe(estimateSeconds(S2))
  })

  it('text-card 不补：它是纯文字卡，没有配音也没有厂商画面', () => {
    const shots = planOf([
      { kind: 'talking-head', seconds: 5, line: S1 },
      { kind: 'text-card', seconds: 4, visual: '价格卡' },
      { kind: 'product', seconds: 5, visual: '产品缓慢旋转' },
      { kind: 'talking-head', seconds: 5, line: S3 },
    ])
    const filled = fillMissingLines(shots, SCRIPT)
    expect(filled[1]!.line, '文字卡保持空').toBe('')
    expect(filled[2]!.line, '空的产品镜拿到的仍是稿件的下一句').toBe(S2)
  })

  it('句子不够时后面的镜头留空，一处都没补时原样返回入参', () => {
    const shots = planOf([
      { kind: 'talking-head', seconds: 5, line: S1 },
      { kind: 'product', seconds: 5, visual: '产品缓慢旋转' },
      { kind: 'product', seconds: 5, visual: '产品细节' },
    ])
    const filled = fillMissingLines(shots, S1 + S2)
    expect(filled.map(item => item.line)).toEqual([S1, S2, ''])

    const allVoiced = planOf([
      { kind: 'talking-head', seconds: 5, line: S1 },
      { kind: 'product', seconds: 5, line: S2, visual: '产品缓慢旋转' },
    ])
    expect(fillMissingLines(allVoiced, SCRIPT), '没有空 line 时不新建数组').toBe(allVoiced)
  })

  it('稿件切不出句子时原样返回，不编造台词', () => {
    const shots = planOf([{ kind: 'product', seconds: 5, visual: '产品缓慢旋转' }])
    expect(fillMissingLines(shots, '   ')).toBe(shots)
    expect(fillMissingLines([], SCRIPT)).toEqual([])
  })
})

describe('镜头模板库：产品镜不再每次现编，而是复用稳定镜头语言', () => {
  it('六个模板覆盖常见镜头，且没有一个在要求模型画字', () => {
    expect(SHOT_TEMPLATES.length).toBeGreaterThanOrEqual(6)
    for (const template of SHOT_TEMPLATES)
      expect(requestsRenderedText(template.visual), template.id + ' 不得要求画字').toBe(false)
  })

  it('产品镜按序号轮转，避免连续两镜用同一个模板', () => {
    const pool = SHOT_TEMPLATES.filter(item => item.kind === 'product' && item.id !== 'before-after')
    const picked = pool.map((_, index) => pickShotTemplate('product', 'product', index)?.id)
    expect(picked).toEqual(pool.map(item => item.id))
    expect(picked[0], '轮转是循环的：转完一圈回到第一个').toBe(pickShotTemplate('product', 'product', pool.length)?.id)
    for (let i = 1; i < picked.length; i++)
      expect(picked[i], '相邻两镜不得用同一个模板').not.toBe(picked[i - 1])
  })

  it('收尾镜用促销模板；口播镜不硬塞模板', () => {
    expect(pickShotTemplate('scene', 'cta', 0)?.id).toBe('promo-end')
    expect(pickShotTemplate('talking-head', 'hook', 0)).toBeUndefined()
  })

  it('非带货形式（vlog / scene）不套产品广告模板', () => {
    // 模板库是带货片沉淀下来的镜头语言（360 度缓转 / 微距水珠 / 促销留白）。实测 60 秒档 VLOG
    // 里被整段套上，出现"产品置于简洁台面正中，缓慢 360 度旋转展示""上方留出干净空间（用于后期
    // 叠加价格与优惠文字）"——与免费培训 VLOG 的题材无关，也与"镜头不手持晃动"的硬要求相反。
    expect(pickShotTemplate('product', 'product', 0, false)).toBeUndefined()
    expect(pickShotTemplate('scene', 'cta', 0, false)).toBeUndefined()
  })

  it('解析出的产品镜带上了模板的镜头语言与禁画字约束', () => {
    const shots = parseShotPlan(JSON.stringify({
      shots: [
        { kind: 'product', seconds: 5, visual: '产品缓慢旋转' },
        { kind: 'product', seconds: 5, visual: '产品细节' },
      ],
    }), REFS, 'digital-human', true)
    for (const shot of shots) {
      expect(shot.visual, '模板语言必须并进提示词').toMatch(/浅景深|微距|自然光|分屏/)
      expect(shot.visual, '禁画字由代码统一补上，不指望模型记得').toContain(NO_RENDERED_TEXT)
    }
    expect(shots[0]!.visual, '同一个模板不得连续用两次').not.toBe(shots[1]!.visual)
  })
})

describe('生成前自检：花钱之前先看一眼这张分镜表', () => {
  it('统计镜头数、产品镜数与总时长', () => {
    const shots = parseShotPlan(JSON.stringify({
      shots: [
        { kind: 'talking-head', seconds: 6, line: '开场钩子' },
        { kind: 'product', seconds: 5, visual: '产品特写' },
        { kind: 'talking-head', seconds: 8, line: '讲卖点' },
      ],
    }), REFS, 'digital-human')
    const audit = auditShotPlan(shots)
    expect(audit.total).toBe(3)
    expect(audit.productShots).toBe(1)
    expect(audit.talkingHeadShots).toBe(2)
    // 6 + 5 + 6：口播镜 8 秒与 6 秒都被夹进短镜区间（上界 6），产品镜保持 5。
    expect(audit.totalSeconds).toBe(17)
    expect(audit.hasEnoughProductShots, '3 镜只 1 个产品镜，达不到底线').toBe(false)
  })

  it('"不许出现文字"是正确写法，不能被误报成"要求画字"', () => {
    const shots = parseShotPlan(JSON.stringify({
      shots: [
        { kind: 'product', seconds: 5, visual: '产品缓慢旋转，' + NO_RENDERED_TEXT },
        { kind: 'product', seconds: 5, visual: '不要展示logo，避免出现包装上的文字' },
      ],
    }), REFS, 'scene')
    expect(auditShotPlan(shots).suspiciousTextRequests, '误报会让这条闸门被无视').toEqual([])
  })

  it('模型要求画 logo 时，那一段被剥掉、只留禁令（同时说"画 logo"和"不画字"时模型会听第一句）', () => {
    const shots = parseShotPlan(JSON.stringify({
      shots: [
        { kind: 'product', seconds: 5, visual: '瓶身上清晰显示品牌名与 logo 特写，产品缓慢旋转' },
        { kind: 'product', seconds: 5, visual: '产品缓慢旋转，柔和光线' },
      ],
    }), REFS, 'scene')
    for (const shot of shots) {
      // 判据用产品自己的闸门函数，而不是裸正则 /logo|品牌名/：禁令文案里本来就写着"不要出现…logo"，
      // 裸正则会把这条正确写法一起判红（2026-09-28 实测：禁令扩写成逐项列举后这里假红两条）。
      expect(requestsRenderedText(shot.visual), '不得留下任何"画字"的要求').toBe(false)
      expect(shot.visual, '禁令必须补上').toContain(NO_RENDERED_TEXT)
    }
    expect(shots[0]!.visual, '同一句里的其它画面描述要保留').toContain('产品缓慢旋转')
    expect(auditShotPlan(shots).suspiciousTextRequests, '剥过之后不该再有可疑镜').toEqual([])
  })

  it('镜头很少时不拿产品镜下限判它不合格（短片本来就放不下）', () => {
    const shots = parseShotPlan(JSON.stringify({ shots: [{ kind: 'talking-head', seconds: 6, line: '一句话' }] }), REFS, 'x')
    expect(auditShotPlan(shots).hasEnoughProductShots).toBe(true)
  })
})

describe('画面要扣住题材：没有参考图也不能给通用素材（DEF-117）', () => {
  it('从卖点里取得出题材关键词', () => {
    const subject = subjectFromTopic('人社局定点机构「无人机装调检修」就业免费培训，正在招生，本期名额有限。如果你手里有证却总对不上岗位。')
    expect(subject).not.toBe('')
    expect(subject, '题材里必须出现这条片讲的东西').toContain('无人机装调检修')
  })

  it('卖点为空或只有标点时不编题材', () => {
    expect(subjectFromTopic('')).toBe('')
    expect(subjectFromTopic('。。。！？')).toBe('')
  })

  it('分镜要求把题材写进去：口播镜要有环境、空镜不许拿通用物件充数', () => {
    const prompt = buildStoryboardPrompt(90, false, { subject: '无人机装调检修、就业免费培训' })
    expect(prompt).toContain('无人机装调检修')
    expect(prompt, '口播镜也要写清处在什么环境里').toContain('talking-head 镜也要写清人物处在什么环境里')
    expect(prompt, '空镜不许用无关的通用物件').toContain('不许用无关的通用物件充数')
    expect(prompt, '题材要进 continuity，全片一条线').toContain('continuity 里把这条线的场景一次写清')
  })

  it('没有题材时不硬塞这条要求', () => {
    expect(buildStoryboardPrompt(90, false)).not.toContain('画面必须扣住这条片讲的东西')
  })
})

describe('融合创作：口播镜之外必须有 B-roll（产品侧兜底，不信模型自觉）', () => {
  const head = (index: number, line: string): ReturnType<typeof parseShotPlan>[number] => ({
    index,
    kind: 'talking-head',
    seconds: 5,
    line,
    visual: '',
    continuity: '',
    references: REFS,
    provider: 'digital-human',
    status: 'planned',
  })

  it('全是口播镜时按每 3 个改写 1 个成空镜，且台词一句不丢', () => {
    const shots = [head(0, '第一句。'), head(1, '第二句。'), head(2, '第三句。'), head(3, '第四句。'), head(4, '第五句。'), head(5, '第六句。')]
    const fixed = ensureBrollShots(shots, '无人机装调检修培训')
    const scenes = fixed.filter(shot => shot.kind === 'scene')
    expect(scenes.length, '至少要有三成非口播镜').toBeGreaterThanOrEqual(2)
    expect(fixed.map(shot => shot.line), '台词与顺序必须原样保留').toEqual(shots.map(shot => shot.line))
    for (const scene of scenes) {
      expect(scene.visual, '空镜画面要写题材').toContain('无人机装调检修培训')
      expect(scene.references, '空镜不得带人物参考图（否则画面里会长出第二张脸）').toEqual([])
    }
  })

  it('已经有足够非口播镜时一处都不改', () => {
    const shots = [
      { ...head(0, '第一句。') },
      { ...head(1, '第二句。'), kind: 'scene' as const, references: [] },
      { ...head(2, '第三句。'), kind: 'scene' as const, references: [] },
    ]
    expect(ensureBrollShots(shots, '无人机装调检修培训')).toBe(shots)
  })

  it('没有题材时不改：宁可全是口播，也不凭空编一个题材', () => {
    const shots = [head(0, '第一句。'), head(1, '第二句。'), head(2, '第三句。')]
    expect(ensureBrollShots(shots, '')).toBe(shots)
  })

  it('镜头太少时不改（两镜的片子切一个空镜就没口播了）', () => {
    const shots = [head(0, '第一句。'), head(1, '第二句。')]
    expect(ensureBrollShots(shots, '无人机装调检修培训')).toBe(shots)
  })

  it('兜底分镜在没有产品图但有题材时也插空镜', () => {
    const shots = fallbackShotPlan(['一句。', '二句。', '三句。', '四句。', '五句。'], [], 'digital-human', false, 4.1, '无人机装调检修培训')
    expect(shots.some(shot => shot.kind === 'scene'), '没有产品图也要有实物画面').toBe(true)
    for (const scene of shots.filter(shot => shot.kind === 'scene'))
      expect(scene.visual).toContain('无人机装调检修培训')
  })
})

describe('分镜台词由稿件分配：成片说多少字由稿件说了算（DEF-132）', () => {
  /** 造一个"模型排的画面 + 模型自己写的短台词"的分镜：实测三次都只有目标字数的 59%~83%。 */
  const planned = (lines: string[]): ZyShot[] => lines.map((line, index) => ({
    index,
    kind: index % 2 === 0 ? 'talking-head' as const : 'product' as const,
    seconds: 5,
    line,
    visual: '第 ' + String(index + 1) + ' 镜的画面：面霜瓶身特写，暖光扫过',
    continuity: '米色墙，室内暖光',
    references: REFS,
    provider: 'digital-human',
    beat: 'product' as const,
    status: 'planned' as const,
  }))

  const SCRIPT = '秋冬脸干到起皮，涂它第二天上妆就服帖。它是厚实但不闷的质地，晚上涂一层，早上摸着还是软的。'
    + '今天直播间直降一百，点下方链接就能拍，库存有限别错过。'

  it('台词合计就是稿件的字数：模型写短了也不会让成片短一截', () => {
    // 模型给的三句一共 21 字，而稿件是 60 字：过去成片就按这 21 字出（短了三分之二）。
    const shots = planned(['一句话。', '两句话。', '三句话五个字。'])
    const fitted = fitScriptToShots(shots, SCRIPT, 4.1)
    const spoken = fitted.reduce((total, shot) => total + spokenCharCount(shot.line), 0)
    expect(spoken, '台词合计必须等于稿件的字数').toBe(spokenCharCount(SCRIPT))
    expect(spoken).toBeGreaterThan(shots.reduce((total, shot) => total + spokenCharCount(shot.line), 0))
    expect(spoken).toBeGreaterThanOrEqual(minScriptChars(12, 4.1))
  })

  it('逐字覆盖整段稿件，不重不漏、顺序不变', () => {
    const fitted = fitScriptToShots(planned(['一句话。', '两句话。', '三句话五个字。']), SCRIPT, 4.1)
    const strip = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, '')
    expect(fitted.map(shot => strip(shot.line)).join(''), '连起来就是整篇稿件').toBe(strip(SCRIPT))
  })

  it('每镜都有台词，且长度尽量均匀（不甩出一镜 30 字、一镜 5 字）', () => {
    const shots = planned(new Array(6).fill('一句话。'))
    const fitted = fitScriptToShots(shots, SCRIPT, 4.1)
    const counts = fitted.map(shot => spokenCharCount(shot.line))
    expect(counts.every(count => count > 0), '每一镜都要有话说（空台词=静音镜）').toBe(true)
    const mean = counts.reduce((total, count) => total + count, 0) / counts.length
    for (const count of counts) expect(count, '每镜字数不该离均值太远：' + JSON.stringify(counts)).toBeLessThanOrEqual(mean * 1.8)
  })

  it('只换台词与时长：画面、节拍、参考图这些排分镜的成果一律保留', () => {
    const shots = planned(['一句话。', '两句话。', '三句话五个字。'])
    const fitted = fitScriptToShots(shots, SCRIPT, 4.1)
    fitted.forEach((shot, index) => {
      expect(shot.kind).toBe(shots[index]!.kind)
      expect(shot.visual).toBe(shots[index]!.visual)
      expect(shot.beat).toBe(shots[index]!.beat)
      expect(shot.continuity).toBe(shots[index]!.continuity)
      expect(shot.references).toBe(shots[index]!.references)
    })
    expect(fitted[0]!.seconds, '时长按分到的台词重新估').toBe(estimateSeconds(fitted[0]!.line, 4.1))
  })

  it('稿件短于镜头数时，多出来的镜头不混进模型自己写的台词', () => {
    // 20 个镜头、稿件只有 30 字：拆到"一个字一块"也不够 20 块。
    // 修好之前，多出来的镜头会保留模型自己写的那句——一份台词混两个来源、覆盖整段稿件当场失效
    // （实测探针：稿件 218 字 + 模型写的 20 句 → 合计 427 字）。
    const short = '秋冬脸干到起皮，涂它第二天上妆就服帖，今天直播间直降一百。'
    const shots = planned(new Array(20).fill('模型自己写的一句。'))
    const fitted = fitScriptToShots(shots, short, 4.1)
    const spoken = fitted.reduce((total, shot) => total + spokenCharCount(shot.line), 0)
    expect(spoken, '合计不得超过稿件字数（模型那 20 句一句都不许混进来）').toBeLessThanOrEqual(spokenCharCount(short))
    for (const shot of fitted) expect(shot.line, '每一句都必须来自稿件').not.toContain('模型自己写的一句')
  })

  it('没有镜头或没有稿件时原样返回，不凭空造台词', () => {
    const shots = planned(['一句话。'])
    expect(fitScriptToShots([], SCRIPT, 4.1)).toEqual([])
    expect(fitScriptToShots(shots, '   ', 4.1)).toBe(shots)
  })

  it('分镜要求里带上已定稿的稿件，并要求逐字照抄、覆盖整段', () => {
    const prompt = buildStoryboardPrompt(90, false, { charsPerSecond: 4.1, script: SCRIPT })
    expect(prompt, '稿件正文要进提示词（模型过去根本看不到它）').toContain(SCRIPT)
    expect(prompt, '要求逐字照抄').toContain('逐字照抄')
    expect(prompt, '要求覆盖整段稿件').toContain('覆盖整段稿件')
    expect(prompt).toContain(String(spokenCharCount(SCRIPT)) + ' 字')
    // 没有稿件时保持原样：分镜模型自己写词那条路径（场景呈现）不受影响。
    const withoutScript = buildStoryboardPrompt(90, false, { charsPerSecond: 4.1 })
    expect(withoutScript).not.toContain('逐字照抄')
    expect(withoutScript, '自己写词时仍要给出字数下限').toContain(String(minScriptChars(90, 4.1)) + ' 字')
  })

  it('台词合计的字数按去标点算：与稿件门槛同一把尺子', () => {
    // 「一句话。」3 字 + 「两句话。」3 字 = 6 字（标点不算）。
    expect(shotsSpokenChars(planned(['一句话。', '两句话。']))).toBe(6)
    expect(shotsCoverTarget(planned(['一句话。', '两句话。']), 1, 4.1).covered).toBe(true)
    expect(shotsCoverTarget(planned(['一句话。']), 12, 4.1).covered).toBe(false)
  })
})

describe('画面提示词：按 Agnes 官方的六段结构写全', () => {
  it('官方六段逐段进提示词，且每一镜必须有看得见的实体', () => {
    const prompt = buildStoryboardPrompt(30, false)
    // 官方《Agnes Video 2.5 · 提示词建议》给的顺序就是这六段：缺哪一段，画面就少一类信息。
    for (const field of AGNES_VIDEO_PROMPT_FIELDS)
      expect(prompt, '官方第 ' + field.id + ' 段（' + field.label + '）要进提示词').toContain(field.label)
    expect(prompt, '六段写法只由官方常量生成，不在提示词里另抄一份')
      .toContain(agnesVideoPromptStructureText())
    // 台词是“风一吹叶子哗哗响”这类没有实体的句子时厂商会画出扭曲几何体（实测），
    // 官方第 1 段“主体与场景”要的正是实体——这里把它钉成硬要求。
    expect(prompt, '抽象意象必须落到具体物件上').toContain('看得见的实体')
  })
})
