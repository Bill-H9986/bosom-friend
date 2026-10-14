/**
 * 账号级 AI 事实的地址判定。
 *
 * 这个用例存在的理由是一次真缺陷（DEF-147）：账号实体在两处各有一份权威——服务端账号行与桌面端
 * 本机 SQLite。事实写成"两处都存一份"时，模型永远读不到本机那份。收口后事实只有一个家，按
 * `(平台, uid)` 寻址，于是**写入地址与读回地址必须是同一个键**：写成两个拼法不会报错，
 * 事实落进一个没人按它查的地方，界面上就是"点了没反应"。
 */
import { describe, expect, it } from 'vitest'
import { accountActionTarget, accountFactKey, accountFactsIndex } from '@web/store/accountPatch'

describe('账号级 AI 事实的地址', () => {
  it('服务端账号行用行 id 寻址', () => {
    expect(accountActionTarget({ id: 'acc-1', type: 'xhs', uid: 'u-1', accountSource: 'backend' })).toBe('acc-1')
  })

  it('桌面端本机账号用 (平台, uid) 寻址——服务端没有它的行', () => {
    expect(accountActionTarget({ id: 'local-9', type: 'xhs', uid: 'u-9', accountSource: 'desktop-local' })).toBe('xhs|u-9')
  })

  it('本机账号的写入地址与读回地址是同一个键', () => {
    const account = { id: 'local-9', type: 'xhs', uid: 'u-9', accountSource: 'desktop-local' }
    expect(accountActionTarget(account)).toBe(accountFactKey(account.type, account.uid))
  })

  it('平台或 uid 缺失也给得出稳定地址，不抛错', () => {
    expect(accountFactKey(undefined, 'u-1')).toBe('|u-1')
    expect(accountFactKey(null, null)).toBe('|')
  })
})

describe('账号事实表：按地址索引', () => {
  it('路由返回的每一项都能按 (平台, uid) 查到', () => {
    const index = accountFactsIndex([{ platform: 'xhs', uid: 'u-9', positioning: '给上班族看', risk: '需重新登录' }])
    expect(index.get(accountFactKey('xhs', 'u-9'))).toEqual({ positioning: '给上班族看', risk: '需重新登录' })
  })

  it('缺字段的项只带它有的字段——undefined 进表会把账号行上的旧值覆盖成空', () => {
    const index = accountFactsIndex([{ platform: 'xhs', uid: 'u-9', positioning: '给上班族看' }])
    const fact = index.get(accountFactKey('xhs', 'u-9'))!
    expect(fact.positioning).toBe('给上班族看')
    expect(fact).not.toHaveProperty('risk')
  })

  it('本机账号读事实表：用页面那套寻址查得到动作刚写进去的值', () => {
    const account = { id: 'local-9', type: 'xhs', uid: 'u-9', accountSource: 'desktop-local' }
    const written = accountActionTarget(account)
    const index = accountFactsIndex([{ platform: 'xhs', uid: 'u-9', positioning: '新定位' }])
    expect(index.get(written)!.positioning).toBe('新定位')
    expect(index.get(accountFactKey(account.type, account.uid))!.positioning).toBe('新定位')
  })
})
