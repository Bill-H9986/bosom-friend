import { describe, expect, it } from 'vitest'
import { shouldUseDesktopPublish } from '../../../aitoearn-web/src/utils/publish/desktopRoute'

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
