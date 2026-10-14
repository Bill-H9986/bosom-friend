import { describe, expect, it } from 'vitest'
import { sumInputVideoDuration } from '@web/components/draft-box/components/AiBatchGenerateBar/utils/helpers'

/**
 * 选中素材的合计时长（DEF-112）。
 *
 * 这条口径守的是一个**界面与请求不一致**的现场：素材时长按 id 边读边填，
 * 一个都没读出来时合计本来是 0，而 0 会被提交链路的 `inputVideoDuration ?? duration`
 * 当成有效档位一路下单，用户看到的是自己选的 30 秒、服务端收到的是 5 秒。
 * 因此"还不知道"必须是 null，"就是 0 秒"这种值根本不该存在。
 */
describe('选中素材的合计时长', () => {
  it('一个时长都没读出来时是 null，不是 0', () => {
    expect(sumInputVideoDuration([])).toBeNull()
  })

  it('非法与非正时长按"没读出来"处理，不拉低合计', () => {
    expect(sumInputVideoDuration([0, -3, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull()
    expect(sumInputVideoDuration([5, 0, Number.NaN])).toBe(5)
  })

  it('多段素材求和后四舍五入', () => {
    expect(sumInputVideoDuration([4.4, 5.2])).toBe(10)
    expect(sumInputVideoDuration([2.5, 2.5])).toBe(5)
  })
})
