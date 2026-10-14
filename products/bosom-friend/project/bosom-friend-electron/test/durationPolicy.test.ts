import { describe, expect, it } from 'vitest'
import {
  briefCharsHint,
  DEFAULT_VIDEO_DURATION_SECONDS,
  SHORT_VIDEO_MAX_SECONDS,
  enabledVideoDurationOptions,
  getEnabledVideoDurations,
  sanitizeVideoDuration,
} from '@web/components/draft-box/components/AiBatchGenerateBar/utils/constants'

/**
 * 时长分工：内容创作是**短视频**板块，长片归「长视频创作」。
 *
 * 这条口径有三个落点（前端上限、长视频下限、服务端夹紧），这里钉的是前端那两个：
 * 模型的更长档位在**来源处**就被过滤掉，且任何来源的时长都会被收敛回可用档位。
 */
describe('内容创作的短视频时长口径', () => {
  it('模型的更长档位不出现在本板块', () => {
    // Agnes 实测声明到 180 秒：内容创作只保留短视频档位，180 秒档位不该出现在这里。
    expect(enabledVideoDurationOptions([5, 10, 15, 30, 60, 90, 120, 180])).toEqual([5, 10, 15, 30, 60])
  })

  it('档位升序去重；模型没给档位时给默认档位兜底', () => {
    expect(enabledVideoDurationOptions([15, 5, 15, 10])).toEqual([5, 10, 15])
    expect(enabledVideoDurationOptions([])).toEqual([DEFAULT_VIDEO_DURATION_SECONDS])
    expect(enabledVideoDurationOptions(undefined)).toEqual([DEFAULT_VIDEO_DURATION_SECONDS])
    expect(enabledVideoDurationOptions([0, -5, Number.NaN, 180])).toEqual([DEFAULT_VIDEO_DURATION_SECONDS])
  })

  it('上限就是 60 秒：超过它的声明档位一律不进本板块', () => {
    expect(SHORT_VIDEO_MAX_SECONDS).toBe(60)
    expect(enabledVideoDurationOptions([60])).toEqual([60])
    expect(enabledVideoDurationOptions([61])).toEqual([DEFAULT_VIDEO_DURATION_SECONDS])
  })
})

/**
 * 30 秒 / 1 分钟必须**出现在同一个档位列表**里。
 *
 * 回归自 2026-09-18 的现场报障（DEF-104 同批）：模型声明 durations=4~12、longDurations=30/60，
 * 而「视频时长」选择器只列 durations，于是在模型参数面板里选的 30 秒在这个选择器里不存在，
 * 被 sanitize 成默认档——用户看到的是「30 秒和 1 分钟根本没做」，接着 4~12 也跟着选了没反应。
 */
describe('30 秒 / 1 分钟与原生档位同列', () => {
  const model = (durations: number[], longDurations?: number[]) =>
    ({ name: 'agnes-video-2.5-flash', durations, longDurations }) as never

  it('原生档位与拼装档位合并成一个升序列表', () => {
    expect(getEnabledVideoDurations([model([4, 5, 6, 8, 10, 12], [30, 60])]))
      .toEqual([4, 5, 6, 8, 10, 12, 30, 60])
  })

  it('模型没声明拼装档位时只有原生档位（不凭空造 30/60）', () => {
    expect(getEnabledVideoDurations([model([4, 5, 6, 8, 10, 12])])).toEqual([4, 5, 6, 8, 10, 12])
  })

  it('多选模型时两个列表都取交集：不能拿 A 的长档位去下单 B', () => {
    expect(getEnabledVideoDurations([model([4, 8], [30, 60]), model([4, 8, 12], [60])]))
      .toEqual([4, 8, 60])
  })

  it('没有选中模型时返回空列表（界面回落到滑块）', () => {
    expect(getEnabledVideoDurations([])).toEqual([])
  })

  it('拼装档位不会被「不在 durations 里」收敛掉（选了 30 秒就一直是 30 秒）', () => {
    expect(sanitizeVideoDuration(30, [4, 5, 6, 8, 10, 12])).toBe(30)
    expect(sanitizeVideoDuration(60, [4, 5, 6, 8, 10, 12])).toBe(60)
  })
})

describe('时长收敛：任何来源的时长都落回可用档位', () => {
  it('老草稿里的 180 秒档位被收敛到默认档位（不报错、也不偷偷按 180 秒生成）', () => {
    expect(sanitizeVideoDuration(180, [5, 10, 15, 30, 60])).toBe(DEFAULT_VIDEO_DURATION_SECONDS)
    expect(sanitizeVideoDuration(180)).toBe(DEFAULT_VIDEO_DURATION_SECONDS)
  })

  it('可用档位内的时长原样保留（不把用户的选择改掉）', () => {
    expect(sanitizeVideoDuration(30, [5, 10, 15, 30, 60])).toBe(30)
    expect(sanitizeVideoDuration(60, [5, 10, 15, 30, 60])).toBe(60)
  })

  it('非法值（0、负数、非数字）回退默认档位', () => {
    expect(sanitizeVideoDuration(0)).toBe(DEFAULT_VIDEO_DURATION_SECONDS)
    expect(sanitizeVideoDuration(-3)).toBe(DEFAULT_VIDEO_DURATION_SECONDS)
    expect(sanitizeVideoDuration(Number.NaN)).toBe(DEFAULT_VIDEO_DURATION_SECONDS)
  })
})
/**
 * DEF-108：长视频的稿件字数门槛必须在填卖点的时候就看得见。
 *
 * 口径是"成稿"不是"卖点"——后端会把卖点扩写成稿，所以提示只能说明差多少，不能拦提交。
 */
describe('长视频卖点字数与门槛的对照提示', () => {
  const need = { requiredChars: 369, charsPerSecond: 4.1, targetSeconds: 90 }

  it('没填卖点：说清要多少成稿，并说明空着不会开始', () => {
    const hint = briefCharsHint(0, need)
    expect(hint.meets).toBe(false)
    expect(hint.text).toContain('369')
    expect(hint.text).toContain('空着不会开始')
  })

  it('卖点不足：同时给出已填字数与门槛，并说明后端会补写', () => {
    const hint = briefCharsHint(64, need)
    expect(hint.meets).toBe(false)
    expect(hint.text).toContain('64')
    expect(hint.text).toContain('369')
    expect(hint.text).toContain('自动补写')
  })

  it('卖点已达到门槛：如实说已经够，不再提补写', () => {
    const hint = briefCharsHint(369, need)
    expect(hint.meets).toBe(true)
    expect(hint.text).toContain('已够')
    expect(hint.text).not.toContain('自动补写')
  })

  it('门槛还没取到时不给提示：宁可什么都不说，也不报一个不带音色语速的假数', () => {
    expect(briefCharsHint(64, null)).toEqual({ text: '', meets: false })
  })

  it('非法字数按 0 处理：NaN 不能渲染成"卖点 NaN 字"', () => {
    const hint = briefCharsHint(Number.NaN, need)
    expect(hint.text).toContain('还没填卖点')
    expect(hint.text).not.toContain('NaN')
  })
})
