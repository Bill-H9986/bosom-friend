import { describe, expect, it } from 'vitest'
import {
  durationPillState,
  getEnabledVideoDurations,
  sanitizeVideoDuration,
} from '@web/components/draft-box/components/AiBatchGenerateBar/utils/constants'
import { getVideoModelParamsMap } from '@web/components/draft-box/components/AiBatchGenerateBar/utils/helpers'

/**
 * 模型参数解析里的时长口径（DEF-112）。
 *
 * 现场：内容创作里选「30 秒」，界面上药丸显示 30 秒，页面发出的生成请求却是 `duration: 5`
 * （模型默认档）——用户选的档位一个字都没写进下单。
 *
 * 根因是**拼装档位不在档位表里**：官方单次只收 4~12 秒，30/60 秒由多个 4 秒片段拼成，
 * 因此只声明在模型的 `longDurations` 上；解析函数只查 pricing/durations，
 * "不在表里就回退默认档"这条收敛顺手把用户的选择吃掉了。
 */
const model = (over: Record<string, unknown> = {}) => ({
  name: 'agnes-video-2.5-flash',
  durations: [5, 10],
  longDurations: [30, 60],
  defaults: { duration: 5, resolution: '720p', aspectRatio: '9:16' },
  pricing: [{ resolution: '720p', duration: 5, price: 1 }, { resolution: '720p', duration: 10, price: 2 }],
  ...over,
}) as never

const fallback = { resolution: '720p', duration: 30, aspectRatio: '9:16' }

describe('模型参数解析：用户选的时长必须原样保留', () => {
  it('拼装档位（30 秒）不被回退成模型默认档', () => {
    const params = getVideoModelParamsMap([model()], {}, {}, fallback, false)
    expect(params['agnes-video-2.5-flash']?.duration).toBe(30)
  })

  it('1 分钟同理', () => {
    const params = getVideoModelParamsMap([model()], {}, {}, { ...fallback, duration: 60 }, false)
    expect(params['agnes-video-2.5-flash']?.duration).toBe(60)
  })

  it('模型没声明这一档拼装档位时仍然回退默认档，不凭空下单', () => {
    const params = getVideoModelParamsMap([model({ longDurations: [] })], {}, {}, fallback, false)
    expect(params['agnes-video-2.5-flash']?.duration).toBe(5)
  })

  it('原生档位照旧原样保留', () => {
    const params = getVideoModelParamsMap([model()], {}, {}, { ...fallback, duration: 10 }, false)
    expect(params['agnes-video-2.5-flash']?.duration).toBe(10)
  })
})

/**
 * 档位选择的收敛必须拿"选择器上真实列出的档位"当依据（DEF-112 的第二半）。
 *
 * 现场：在「视频时长」里点 4 秒 / 6 秒 / 8 秒 / 10 秒，药丸都变成 12 秒——用户点的那一档留不住。
 * 根因是收敛时没传档位表：`sanitizeVideoDuration(d)` 只剩默认档（15）一个选项，
 * 15 再被模型上限（12）夹一次，于是所有原生档位都落到 12。
 */
describe('档位收敛用的是选择器自己列出的那一组', () => {
  // 真实型号（装机版 pricing 实测 2026-09-19）：原生 4~12 秒，拼装 30/60。
  const picker = () => getEnabledVideoDurations([model({ durations: [4, 5, 6, 8, 10, 12] })])

  it('选择器列出的档位与模型声明一致（原生 + 拼装）', () => {
    expect(picker()).toEqual([4, 5, 6, 8, 10, 12, 30, 60])
  })

  it('每个原生档位点了都留得住', () => {
    for (const seconds of [4, 5, 6, 8, 10, 12])
      expect(sanitizeVideoDuration(seconds, picker()), String(seconds) + ' 秒').toBe(seconds)
  })

  it('拼装档位照旧原样放行', () => {
    expect(sanitizeVideoDuration(30, picker())).toBe(30)
    expect(sanitizeVideoDuration(60, picker())).toBe(60)
  })

  it('负向对照：不传档位表时会退化成"什么都留不住"', () => {
    // 这就是现场那个写法——留着它，回归才有意义。
    expect(sanitizeVideoDuration(4)).toBe(15)
    expect(sanitizeVideoDuration(10)).toBe(15)
  })
})
/**
 * 时长药丸该长成什么样（DEF-112 的界面半边，DEF-163 收口）。
 *
 * 规则只有一条：**用户看到的时长必须是真正会提交的那个**。编辑态下成片时长由素材合计决定
 * （提交链路取 `inputVideoDuration ?? duration`），所以只有素材时长读得出时药丸才该锁死；
 * 读不出（还在解析）时用户选的档位确实会生效，此时让人点开是对的——挡住反而会造出
 * 「界面显示一个值、下单是另一个值」那个老问题。
 */
describe('时长药丸的状态判定', () => {
  it('编辑态 + 素材时长已知：锁死，并显示真正会提交的那个时长', () => {
    expect(durationPillState({ isVideoEditMode: true, inputVideoDuration: 12, limitMin: 4, limitMax: 12 })).toBe('locked-by-video')
  })

  it('编辑态 + 素材时长读不出：可以点——此时用户选的档位真的会提交', () => {
    expect(durationPillState({ isVideoEditMode: true, inputVideoDuration: null, limitMin: 4, limitMax: 12 })).toBe('chooser')
  })

  it('非编辑态：素材时长不参与，永远是可选档位', () => {
    expect(durationPillState({ isVideoEditMode: false, inputVideoDuration: 12, limitMin: 4, limitMax: 12 })).toBe('chooser')
  })

  it('上下限只有一个档位：固定值，点不开也没有可改的', () => {
    expect(durationPillState({ isVideoEditMode: false, inputVideoDuration: null, limitMin: 5, limitMax: 5 })).toBe('fixed')
  })

  it('负向对照：锁死与可选的差别只来自素材时长——读得出就必须锁', () => {
    const fixed = { isVideoEditMode: true, limitMin: 4, limitMax: 12 } as const
    expect(durationPillState({ ...fixed, inputVideoDuration: 4 })).toBe('locked-by-video')
    expect(durationPillState({ ...fixed, inputVideoDuration: 4 })).not.toBe(durationPillState({ ...fixed, inputVideoDuration: null }))
  })
})
