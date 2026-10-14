import { describe, expect, it } from 'vitest'
// 用 @web 别名而不是相对路径：产品目录改名过一次，裸相对路径不会在改名时报错，
// 只会让套件静默收集失败（DEF-069）。
import { shouldUseDesktopPublish } from '@web/utils/publish/desktopRoute'

describe('desktop publish route helper', () => {
  it('routes xhs/douyin to desktop direct publish when running in Electron', () => {
    expect(shouldUseDesktopPublish('xhs', true)).toBe(true)
    expect(shouldUseDesktopPublish('douyin', true)).toBe(true)
  })

  it('keeps plugin flows for other platforms and browser environments', () => {
    expect(shouldUseDesktopPublish('xhs', false)).toBe(false)
    expect(shouldUseDesktopPublish('kwai', true)).toBe(false)
  })
})
