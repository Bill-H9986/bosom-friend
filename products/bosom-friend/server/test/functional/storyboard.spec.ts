const FENCE = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96)
import { describe, expect, it } from 'vitest'
import {
  AVG_SHOT_SECONDS,
  MIN_PRODUCT_SHOTS,
  auditShotPlan,
  buildStoryboardPrompt,
  fallbackShotPlan,
  parseShotPlan,
  planShotCount,
} from '../../src/storyboard.ts'
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

describe('镜头数按平均镜头长度折算', () => {
  it('按 6 秒一镜折算，且至少 2 镜（开场 + 收尾）', () => {
    expect(AVG_SHOT_SECONDS).toBe(6)
    expect(planShotCount(12)).toBe(2)
    expect(planShotCount(30)).toBe(5)
    expect(planShotCount(60)).toBe(10)
    expect(planShotCount(1)).toBe(2)
    expect(planShotCount(Number.NaN)).toBe(4)
  })
})

describe('分镜要求：三条硬约束必须写进提示词', () => {
  it('给出总镜数与产品镜下限，且要求画面里不出现文字/品牌', () => {
    const prompt = buildStoryboardPrompt(30, false)
    expect(prompt).toContain('共 5 镜')
    expect(prompt).toContain('至少 ' + String(MIN_PRODUCT_SHOTS) + ' 个 product 镜头')
    expect(prompt, '画字会生成臆造品牌，必须明令禁止').toContain('不许出现任何文字、品牌名、logo')
    expect(prompt).toContain('continuity')
    expect(prompt, '只认 JSON，不要解释').toContain('只输出 JSON')
  })

  it('有没有产品参考图，产品镜的写法不同', () => {
    expect(buildStoryboardPrompt(30, true)).toContain('用户提供了产品参考图')
    expect(buildStoryboardPrompt(30, false)).toContain('没有产品参考图')
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

  it('时长越界夹回厂商区间，类型写错按有无文本推断', () => {
    const raw = JSON.stringify({
      shots: [
        { kind: 'product', seconds: 99, visual: '产品缓慢旋转', line: '' },
        { kind: '胡说', seconds: 1, line: '这一句要念出来', visual: '' },
        { kind: 'scene', seconds: 'abc', visual: '空镜' },
      ],
    })
    const shots = parseShotPlan(raw, REFS, 'scene')
    expect(shots.map(item => item.seconds)).toEqual([12, 4, 12])
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
  it('口播镜与产品镜交替，产品镜只用产品参考图', () => {
    const texts = ['第一句口播内容。', '第二句口播内容。', '第三句口播内容。', '第四句口播内容。']
    const shots = fallbackShotPlan(texts, REFS, 'digital-human', true)
    // 4 段口播 → 每 2 段后插 1 个产品镜 → 6 镜
    expect(shots).toHaveLength(6)
    expect(shots.map(item => item.kind)).toEqual([
      'talking-head', 'talking-head', 'product', 'talking-head', 'talking-head', 'product',
    ])
    expect(shots[0]!.line).toBe('第一句口播内容。')
    expect(shots[2]!.line, '产品镜没有口播文本').toBe('')
    expect(shots[2]!.visual).toContain('参考图中的产品')
    expect(shots[2]!.references, '产品镜只挂产品参考图，不把人物图塞进产品镜').toEqual([
      { url: '/bosom-friend/api/assets/file/product.png', role: 'product' },
    ])
    expect(shots[3]!.index, '索引连续，便于逐镜重做时定位').toBe(3)
  })

  it('没有产品参考图时不插产品镜：凭空画一个产品比"只有口播"更糟', () => {
    const shots = fallbackShotPlan(['一。', '二。'], REFS, 'scene', false)
    expect(shots.map(item => item.kind)).toEqual(['talking-head', 'talking-head'])
  })

  it('有产品参考图才插产品镜，且产品镜文案明令画面里不许出现文字/品牌', () => {
    const shots = fallbackShotPlan(['一。', '二。'], REFS, 'scene', true)
    const product = shots.find(item => item.kind === 'product')
    expect(product?.visual).toContain('参考图中的产品')
    expect(product?.visual).toContain('不出现任何文字与品牌标识')
    expect(auditShotPlan(shots).suspiciousTextRequests, '兜底文案自己不能要求画字').toEqual([])
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
    expect(audit.totalSeconds).toBe(19)
    expect(audit.hasEnoughProductShots, '3 镜只 1 个产品镜，达不到底线').toBe(false)
  })

  it('"不许出现文字"是正确写法，不能被误报成"要求画字"', () => {
    const shots = parseShotPlan(JSON.stringify({
      shots: [
        { kind: 'product', seconds: 5, visual: '产品缓慢旋转，画面里不出现任何文字与品牌标识' },
        { kind: 'product', seconds: 5, visual: '不要展示logo，避免出现包装上的文字' },
      ],
    }), REFS, 'scene')
    expect(auditShotPlan(shots).suspiciousTextRequests, '误报会让这条闸门被无视').toEqual([])
  })

  it('画面提示词里要求画文字/logo 会被标成可疑（实测会生成臆造品牌）', () => {
    const shots = parseShotPlan(JSON.stringify({
      shots: [
        { kind: 'product', seconds: 5, visual: '瓶身上清晰显示品牌名与 logo 特写' },
        { kind: 'product', seconds: 5, visual: '产品缓慢旋转，柔和光线' },
      ],
    }), REFS, 'scene')
    const audit = auditShotPlan(shots)
    expect(audit.suspiciousTextRequests).toEqual([0])
  })

  it('镜头很少时不拿产品镜下限判它不合格（短片本来就放不下）', () => {
    const shots = parseShotPlan(JSON.stringify({ shots: [{ kind: 'talking-head', seconds: 6, line: '一句话' }] }), REFS, 'x')
    expect(auditShotPlan(shots).hasEnoughProductShots).toBe(true)
  })
})
