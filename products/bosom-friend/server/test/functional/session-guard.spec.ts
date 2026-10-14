import { describe, expect, it } from 'vitest'
import { PUBLIC_PATHS, sessionRequired } from '../../src/api.ts'

/**
 * AC-002-3 未登录访问业务页被引导登录：守卫判定必须与运行配置一致。
 *
 * 产品当前有意运行在免登录模式（bundle 下各 cordis.patch.yml 的 authEnabled: false），
 * 单机单用户，不存在「他人数据」。但账号体系本身没有被删掉：一旦把 authEnabled 改回
 * true，所有业务端点都必须要求有效会话。这条锁死那份判定逻辑本身，避免以后改回
 * 账号体系时守卫被静默削弱。
 */
describe('会话守卫（AC-002-3）', () => {
  it('免登录模式：业务端点不要求会话（产品当前的配置）', () => {
    expect(sessionRequired(false, 'user/mine', false, false)).toBe(false)
    expect(sessionRequired(false, 'agent/tasks', false, false)).toBe(false)
  })

  it('账号体系开启：没带 token 的业务请求必须被拒', () => {
    for (const path of ['user/mine', 'agent/tasks', 'v2/channels/accounts', 'contents/groups', 'ai/chat']) {
      expect(sessionRequired(true, path, false, false), path + ' 未登录必须被拒').toBe(true)
    }
  })

  it('账号体系开启：带了有效会话就放行', () => {
    expect(sessionRequired(true, 'user/mine', false, true)).toBe(false)
  })

  it('登录/注册端点始终公开，否则登录框自己会被 401 挡死', () => {
    for (const path of PUBLIC_PATHS) {
      expect(sessionRequired(true, path, false, false), path + ' 必须公开').toBe(false)
    }
    expect(PUBLIC_PATHS.has('auth/login')).toBe(true)
  })

  it('资源与只读分享路径公开：<img> 与外部访问带不上 Authorization 头', () => {
    expect(sessionRequired(true, 'assets/a.png', true, false)).toBe(false)
    expect(sessionRequired(true, 'agent/tasks/shared/xyz', true, false)).toBe(false)
    expect(sessionRequired(true, 'platform-login/qr/q.png', true, false)).toBe(false)
  })

  it('公开路径之外的资源路径仍然要求会话，公开判定不放宽业务数据', () => {
    expect(sessionRequired(true, 'agent/tasks/shared-anything/secret', false, false)).toBe(true)
    expect(sessionRequired(true, 'assets-private/list', false, false)).toBe(true)
  })
})
