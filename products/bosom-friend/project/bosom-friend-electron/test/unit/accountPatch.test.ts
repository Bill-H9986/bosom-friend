/**
 * 账号改写的落点判定。
 *
 * 这个用例存在的理由是一次真缺陷（DEF-148）：账号页渲染的是 `accountGroupList[].children`，
 * 而改写只替换了 `accountList` 里那一个对象——服务端已经写成功，卡片却停在旧值，
 * 用户看到的是"点了没反应"。所以这里逐处断言，而不是只断言其中一处。
 */
import { describe, expect, it } from 'vitest'
import { patchAccountHomes } from '@web/store/accountPatch'

interface Account { id: string, nickname: string, aiPositioning?: string, accountSource?: string }
interface Group { id: string, children?: Account[] }

function buildState() {
  const a: Account = { id: 'acc-1', nickname: '甲', accountSource: 'backend' }
  const b: Account = { id: 'acc-2', nickname: '乙' }
  return {
    a,
    b,
    state: {
      accountList: [a, b],
      accountMap: new Map([['acc-1', a], ['acc-2', b]]),
      accountGroupList: [{ id: 'g1', children: [a] }, { id: 'g2', children: [b] }] as Group[],
      accountActive: a,
    },
  }
}

describe('改写一个账号：三处引用一起换', () => {
  it('列表、索引、分组里的 children 都拿到新值', () => {
    const { state } = buildState()
    const changed = patchAccountHomes(state, 'acc-1', { aiPositioning: '给上班族看' })!
    expect(changed.accountList[0]!.aiPositioning).toBe('给上班族看')
    expect(changed.accountMap.get('acc-1')!.aiPositioning).toBe('给上班族看')
    expect(changed.accountGroupList[0]!.children![0]!.aiPositioning, '页面渲染的正是这一处').toBe('给上班族看')
  })

  it('同一个对象出现在三处，换完仍是同一个对象（不会页面上一半新一半旧）', () => {
    const { state } = buildState()
    const changed = patchAccountHomes(state, 'acc-1', { aiPositioning: '定位' })!
    expect(changed.accountMap.get('acc-1')).toBe(changed.accountList[0])
    expect(changed.accountGroupList[0]!.children![0]).toBe(changed.accountList[0])
  })

  it('只动被点的那一个账号，同组的另一个不动', () => {
    const { state } = buildState()
    const changed = patchAccountHomes(state, 'acc-1', { aiPositioning: '定位' })!
    expect(changed.accountList[1]).toBe(state.accountList[1])
    expect(changed.accountGroupList[1]).toBe(state.accountGroupList[1])
    expect(changed.accountMap.get('acc-2')).toBe(state.accountMap.get('acc-2'))
  })

  it('选中项同一条时跟着换，不同条时不塞进状态里', () => {
    const { state } = buildState()
    expect(patchAccountHomes(state, 'acc-1', { aiPositioning: '定位' })!.accountActive!.aiPositioning).toBe('定位')
    expect(patchAccountHomes(state, 'acc-2', { aiPositioning: '定位' })).not.toHaveProperty('accountActive')
  })

  it('账号不在列表里：什么都不动（返回 undefined，调用方不 set）', () => {
    const { state } = buildState()
    expect(patchAccountHomes(state, 'acc-不存在', { aiPositioning: '定位' })).toBeUndefined()
  })

  it('没有分组时（未分组视图）只换列表与索引，不炸', () => {
    const { state } = buildState()
    const changed = patchAccountHomes({ accountList: state.accountList, accountMap: state.accountMap }, 'acc-1', { nickname: '甲改' })!
    expect(changed.accountList[0]!.nickname).toBe('甲改')
    expect(changed.accountGroupList).toEqual([])
  })
})
