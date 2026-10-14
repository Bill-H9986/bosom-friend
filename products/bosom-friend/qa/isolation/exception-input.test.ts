/**
 * DEF-240-IMPLEMENT-6 第三项：异常输入下的失败方向（fail-closed）探测。
 * 用真实 `isAutoPublishAuthorized`，不复制规则。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { isAutoPublishAuthorized } from '@web/components/Chat/ActionCard/publishAuthorization'
import { useAgentFollowStore } from '@web/store/agentFollow'

beforeAll(() => { useAgentFollowStore.getState().setEnabled(true) })

describe('异常 / 畸形输入的失败方向', () => {
  it('缺字段 -> 拒绝', () => {
    expect(isAutoPublishAuthorized({})).toBe(false)
  })
  it('数字 1 -> 拒绝（不做真值强转）', () => {
    expect(isAutoPublishAuthorized({ explicitPublishIntent: 1 as unknown as boolean })).toBe(false)
  })
  it('字符串 "true" -> 拒绝', () => {
    expect(isAutoPublishAuthorized({ explicitPublishIntent: 'true' as unknown as boolean })).toBe(false)
  })
  it('空数组 -> 拒绝', () => {
    expect(isAutoPublishAuthorized({ explicitPublishIntent: [] as unknown as boolean })).toBe(false)
  })
  it('空对象 -> 拒绝', () => {
    expect(isAutoPublishAuthorized({ explicitPublishIntent: {} as unknown as boolean })).toBe(false)
  })
  it('NaN -> 拒绝', () => {
    expect(isAutoPublishAuthorized({ explicitPublishIntent: Number.NaN as unknown as boolean })).toBe(false)
  })
  it('null action -> 抛异常（不静默放行）', () => {
    let threw = false
    try { isAutoPublishAuthorized(null as unknown as { explicitPublishIntent?: boolean }) } catch { threw = true }
    expect(threw).toBe(true)
  })
  it('undefined action -> 抛异常（不静默放行）', () => {
    let threw = false
    try { isAutoPublishAuthorized(undefined as unknown as { explicitPublishIntent?: boolean }) } catch { threw = true }
    expect(threw).toBe(true)
  })
  it('跟随模式关闭 + 任何标记 -> 拒绝', () => {
    useAgentFollowStore.getState().setEnabled(false)
    expect(isAutoPublishAuthorized({ explicitPublishIntent: true })).toBe(false)
    expect(isAutoPublishAuthorized({})).toBe(false)
    useAgentFollowStore.getState().setEnabled(true)
  })
})