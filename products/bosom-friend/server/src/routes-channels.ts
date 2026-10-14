/* oxlint-disable no-non-null-assertion, restrict-plus-operands, no-unnecessary-condition, no-unnecessary-type-conversion, no-unnecessary-type-assertion, no-unnecessary-type-parameters, require-await, @stylistic/max-len -- 结构保证型规则：路由段由匹配器确保存在、JSON 文件由 JsonFile 确保可读；中文文案/资源 URL 为长单串，属产品文案而非可拆分语句 */
/**
 * 渠道域路由：平台元数据、授权会话、账号与分组、发布 Flow/记录/任务、作品分析
 * 与作品归属校验。字段结构对齐前端 v2/channels 与 platforms 契约。
 * @module @deepseek-ai/dsh-bosom-friend-server/routes-channels
 */

import type { RouteDef, Deps } from './api.ts'
import { PUBLISH_RECORD_STATUS, type PublishRecordStatus, type ZySocialAccount } from './types.ts'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeOk } from './http.ts'
import { nowIso, uid } from './store-helper.ts'

/**
 * 内容标注的默认值。
 *
 * 中央网信办 2026-05-13 起把内容标注设为短视频发布的**必经环节**（六类必选标签之一），
 * 抖音侧落地成"自主声明"弹窗。产品出的是 AI 生成内容，所以默认就是这一项；
 * 用户能在发布前改（例如同时带货要改成含营销信息的声明）。
 */
export const DEFAULT_CONTENT_DECLARATION = '内容由AI生成'
import { getPlatformLoginStatus, startPlatformLogin, startPlatformPublish, getPublishState, readLoginQr, revokeAccountLoginSessions, killPublishWorker, confirmLoginInvalid, PUBLISH_TASK_BUDGET_MS, PUBLISH_RESULT_UNKNOWN_MESSAGE } from './platform-login.ts'
import { platformSyncCapabilities, syncPlatformWorks, type PlatformSyncOutcome } from './platform-sync.ts'
import { platformCatalog, platformContentLimits, platformTitleLimit } from './platform-catalog.ts'
import { MAX_TITLE_CHARS } from './object-actions.ts'
import { accountFactKey } from './types.ts'

/**
 * 追加渠道域路由。
 * @param deps - 共享依赖（存储、配置、模型桥）。
 * @param routes - 待追加的路由数组。
 */
export function appendChannelRoutes(deps: Deps, routes: RouteDef[]): void {
  const files = deps.store.files

  /** 面向 HTTP 客户端的安全账号视图：不返回登录态 cookie / token，只给可用性标记。 */
  function publicAccountView(account: ZySocialAccount): Record<string, unknown> {
    const safe: Record<string, unknown> = { ...account }
    // 账号级 AI 事实（定位/风险）的家是 account-facts.json（DEF-147）：这里把它**投影**进账号视图，
    // 于是浏览器模式与桌面端看到的都是同一份事实。
    const fact = files.accountFacts.load()[accountFactKey(String(account.type ?? ''), String(account.uid ?? ''))]
    if (fact !== undefined) {
      if (fact.positioning !== undefined) safe.aiPositioning = fact.positioning
      if (fact.positioningAt !== undefined) safe.aiPositioningAt = fact.positioningAt
      if (fact.risk !== undefined) safe.aiRisk = fact.risk
      if (fact.riskAt !== undefined) safe.aiRiskAt = fact.riskAt
    }
    delete safe.loginCookie
    delete safe.access_token
    delete safe.refresh_token
    safe.hasLoginCookie = typeof account.loginCookie === 'string' && account.loginCookie !== ''
    if (typeof account.avatar === 'string' && /^https:\/\/img\.xiaohongshu\.com\//.test(account.avatar))
      safe.avatar = '/bosom-friend/api/assets/avatar/' + account.id
    return safe
  }

  // ---- 平台元数据 ---------------------------------------------------------

  routes.push({
    m: 'GET',
    p: 'v2/channels/platforms',
    h: ({ res }) => {
      const catalog = platformCatalog()
      const list = catalog.map((ch) => {
        const limits = platformContentLimits(ch.platform)
        return {
        platform: ch.platform,
        // 引擎已落地的平台 = available；仅列入清单的（如闲鱼）= coming_soon，
        // 前端据此置灰并提示「即将支持」，绝不谎称可连接。
        status: ch.status,
        // 产品是否把它当频道开放：引擎能做 ≠ 产品已接入。前端只认这个字段，
        // 不再自己维护第二份白名单（两份清单必然会漂移）。
        channel: ch.channel,
        displayName: { 'zh-CN': ch.name, 'en-US': ch.name },
        logoUrl: '',
        authType: ch.auth ? 'qrcode' : 'browser',
        authInstructions: {},
        editor: ch.editor,
        contentLimits: {
          modes: ch.publish.length > 0 ? ch.publish : ['video', 'image_text'],
          // 标题 30 字是**产品自己的**上限（见 object-actions 的 MAX_TITLE_CHARS），不是平台事实。
          // 正文/话题数来自 PLATFORM_CONTENT_LIMITS —— 该表是**配置登记处，不等于已全部核实的平台官方规则**
          // （其中 xhs.topics 至今仍是来源未定的历史值，见 DEF-238）。表只保证「没有出处的**不报**」，
          // 界面据此显示"未声明"，而不是显示一个用户会照着写的假上限（DEF-153）。
          maxTitleLength: MAX_TITLE_CHARS,
          ...(limits.body === undefined ? {} : { maxBodyLength: limits.body }),
        },
        mediaRules: {},
        topic: {
          supported: true,
          ...(limits.topics === undefined ? {} : { maxCount: limits.topics }),
        },
        capabilities: {
          auth: ch.auth ? { supported: true } : {},
          publish: ch.publish.length > 0 ? { supported: true } : {},
          // account: true 表示"可按账号取数据"——频道行的「刷新粉丝数」按钮据此显示；
          // 只发 supported 会让该按钮永远不出现（前端判的是 analytics.account）。
          analytics: ch.data ? { supported: true, account: true } : {},
          engagement: {},
          work: ch.data ? { supported: true } : {},
          browse: {},
          webhook: {},
        },
        optionSchema: {},
        }
      })
      writeOk(res, list)
    },
  })

  // ---- 授权会话（真实平台扫码登录：引擎打开官方创作者页取码，扫码后落盘真实 cookie） -------

  routes.push(
    {
      m: 'GET',
      p: 'v2/channels/accounts/auth/:platform',
      h: async ({ res, params, query }) => {
        const platform = params.platform ?? 'xhs'
        const result = await startPlatformLogin(deps, platform, query.get('groupId') ?? undefined)
        if (!result.ok) {
          writeFailRaw(res, result.error, 50000)
          return
        }
        writeOk(res, { url: result.url, sessionId: result.sessionId, expiresAt: result.expiresAt })
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/accounts/auth/:platform/status/:sessionId',
      h: ({ res, params }) => {
        const status = getPlatformLoginStatus(deps, params.sessionId ?? '')
        if (status.status === 'failed') {
          writeFailRaw(res, status.message ?? '平台登录失败，请重试', 50000)
          return
        }
        writeOk(res, status)
      },
    },
    {
      m: 'GET',
      p: 'platform-login/qr/:sessionId',
      h: async ({ res, params }) => {
        const result = await readLoginQr(deps, params.sessionId ?? '')
        if (!result.ok) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ code: 50000, data: null, message: result.error }))
          return
        }
        res.writeHead(200, { 'content-type': result.mime, 'cache-control': 'no-store' })
        res.end(result.body)
      },
    },
    {
      m: 'POST',
      p: 'v2/channels/accounts/browser-register',
      h: ({ res, body }) => {
        const params = body as { type?: unknown; uid?: unknown; nickname?: unknown; avatar?: unknown; loginCookie?: unknown }
        const platform = typeof params.type === 'string' ? params.type : 'xhs'
        const accounts = files.accounts.load()
        let account = accounts.find(a => a.type === platform && a.uid === (typeof params.uid === 'string' ? params.uid : ''))
        if (account === undefined) {
          account = {
            id: uid('acc'),
            type: platform,
            uid: typeof params.uid === 'string' ? params.uid : 'web-' + Math.floor(Math.random() * 100000),
            avatar: typeof params.avatar === 'string' ? params.avatar : '',
            nickname: typeof params.nickname === 'string' && params.nickname !== '' ? params.nickname : platform + ' 账号',
            loginCookie: typeof params.loginCookie === 'string' ? params.loginCookie : '',
            // 粉丝/关注/作品/收益这一刻一个都没采到，写 0 等于声称「这个号 0 粉丝」。
            // 留缺省（界面显示未采集），由真实采集链路回填。
            status: 1,
            rank: accounts.length,
            groupId: 'grp-default',
            clientType: 'web',
            createTime: nowIso(),
            updateTime: nowIso(),
          }
          accounts.push(account)
          files.accounts.save(accounts)
        }
        writeOk(res, { id: account.id })
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/oauth/:platform',
      h: async ({ res, params, query }) => {
        const platform = params.platform ?? 'xhs'
        const result = await startPlatformLogin(deps, platform, query.get('groupId') ?? undefined)
        if (!result.ok) {
          writeFailRaw(res, result.error, 50000)
          return
        }
        writeOk(res, { url: result.url, sessionId: result.sessionId, expiresAt: result.expiresAt, authInstructions: {} })
      },
    },

    // ---- 渠道账号与分组 -----------------------------------------------------

    {
      m: 'GET',
      p: 'assets/avatar/:accountId',
      h: async ({ res, params }) => {
        const account = files.accounts.load().find(item => item.id === params.accountId)
        const avatar = typeof account?.avatar === 'string' ? account.avatar : ''
        if (!/^https:\/\/img\.xiaohongshu\.com\//.test(avatar)) {
          writeFailRaw(res, 'avatar not found', 40404)
          return
        }
        try {
          const remote = await fetch(avatar, {
            headers: { 'user-agent': 'BosomFriend/1.0' },
            signal: AbortSignal.timeout(10_000),
          })
          if (!remote.ok) {
            writeFailRaw(res, 'avatar remote unavailable', 40404)
            return
          }
          const body = Buffer.from(await remote.arrayBuffer())
          res.writeHead(200, {
            'content-type': remote.headers.get('content-type') || 'image/jpeg',
            'cache-control': 'public, max-age=3600',
          })
          res.end(body)
        }
        catch {
          writeFailRaw(res, 'avatar remote failed', 40404)
        }
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/accounts',
      h: ({ res }) => {
        const list = files.accounts.load()
        writeOk(res, { total: list.length, list: list.map(publicAccountView) })
      },
    },
    {
      m: 'POST',
      p: 'v2/channels/accounts',
      h: ({ res, body }) => {
        const params = body as { type?: unknown; uid?: unknown; nickname?: unknown; loginCookie?: unknown; avatar?: unknown; groupId?: unknown }
        const accounts = files.accounts.load()
        const account = {
          id: uid('acc'),
          type: typeof params.type === 'string' ? params.type : 'xhs',
          uid: typeof params.uid === 'string' ? params.uid : '',
          avatar: typeof params.avatar === 'string' ? params.avatar : '',
          nickname: typeof params.nickname === 'string' ? params.nickname : '新账号',
          loginCookie: typeof params.loginCookie === 'string' ? params.loginCookie : '',
          // 与 browser-register 同规则：这一刻一个指标都没采到，不写 0 冒充真值。
          status: 1,
          rank: accounts.length,
          groupId: typeof params.groupId === 'string' ? params.groupId : 'grp-default',
          clientType: 'plugin',
          createTime: nowIso(),
          updateTime: nowIso(),
        }
        accounts.push(account)
        files.accounts.save(accounts)
        writeOk(res, publicAccountView(account))
      },
    },
    {
      /**
       * 账号级 AI 事实（按 平台|uid 寻址）。
       *
       * 为什么单独一条：桌面端本机账号**不在服务端账号列表里**（它住在本机 SQLite），
       * 界面要显示它们的定位/风险，只能按 (平台, uid) 来对账（DEF-147）。
       */
      m: 'GET',
      p: 'v2/channels/account-facts',
      h: ({ res }) => {
        const facts = files.accountFacts.load()
        writeOk(res, { list: Object.values(facts) })
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/accounts/:id',
      h: ({ res, params }) => {
        const account = files.accounts.load().find(a => a.id === params.id)
        if (account === undefined) { writeFailRaw(res, 'account not found', 40404); return }
        writeOk(res, publicAccountView(account))
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/accounts/:id/analytics',
      h: ({ res, params }) => {
        const account = files.accounts.load().find(a => a.id === params.id)
        if (account === undefined) { res.statusCode = 200; writeFailRaw(res, 'account not found', 40404); return }
        // 纯读（2026-09-10）：lastStatsTime 只由真实采集链路（syncPlatformWorks 成功）写入。
        // 这里既不改写时间戳，也不触发平台拉取——否则「刷新粉丝数」按 code===0 判成功，
        // 响应却一直是缓存值、时间戳被读请求推到现在，用户看到的是「刷新完成但数字没变」。
        // 真实采集由 POST .../analytics/refresh 显式触发，结果如实写回账号。
        const view = publicAccountView(account)
        view.statsSyncInFlight = statsSyncInFlight.has(account.id)
        writeOk(res, view)
      },
    },
    {
      m: 'POST',
      p: 'v2/channels/accounts/:id/analytics/refresh',
      h: async ({ res, params }) => {
        const account = files.accounts.load().find(a => a.id === params.id)
        if (account === undefined) { writeFailRaw(res, 'account not found', 40404); return }
        const result = await startAccountStatsRefresh(deps, account)
        // 触发不了真实采集（平台未接入/缺 Cookie/引擎起不来）必须报错，不能回 code 0 让前端弹「刷新完成」。
        if (!result.ok) { writeFailRaw(res, result.message, 50000); return }
        writeOk(res, {
          refreshStatus: result.status,
          message: result.message,
          // throttled 时把剩余冷却带出去：前端据此精确记录本地冷却，
          // 否则下一次点击会再次打到接口（A10 回归判据）。
          ...('remainingMs' in result && typeof result.remainingMs === 'number' ? { remainingMs: result.remainingMs } : {}),
          lastStatsTime: result.lastStatsTime,
          fansCount: result.fansCount,
          workCount: result.workCount,
        })
      },
    },
    {
      m: 'DELETE',
      p: 'v2/channels/accounts/:id',
      h: ({ res, params, query }) => {
        const accounts = files.accounts.load()
        const idx = accounts.findIndex(a => a.id === params.id)
        if (idx >= 0) {
          const account = accounts[idx]
          if (typeof account?.loginCookie === 'string' && account.loginCookie !== '' && query.get('confirm') !== '1') {
            writeFailRaw(res, '删除真实登录账号需要二次确认，请从确认框再次操作', 40001)
            return
          }
          // 删除账号会级联清掉它的发布记录与统计，误删代价很高：真正开始删之前先留一份可回滚快照。
          // 快照必须放在二次确认之后：被拦下的请求不能有落盘副作用（否则点一次"删除再取消"就多一份备份）。
          backupBeforeDestructive(deps.dataRoot, 'delete-account')
          // 全清（2026-09-07）：删除账号前吊销其全部登录会话，防止 done 会话轮询
          // 用旧 cookie 新建幽灵账号（ensureAccountMaterialized 的复活链）。
          if (account !== undefined) revokeAccountLoginSessions(deps, account)
          accounts.splice(idx, 1)
          // 删掉最后一个账号时结果就是空数组：`save` 的空值守卫会拒绝（它防的是「读失败→内存空数组→回写」那次
          // 数据全没的事故），而这是用户明确要的删除，且上面已经留过快照——按契约走显式接口。
          // 2026-10-12（审计 W04）：账号行、发布记录、统计三份数据必须同生共死——中途失败会留下
          // 「账号没了但记录/统计还挂着」的孤儿状态（G3「数据不会越用越乱」的典型来源）。包进事务。
          deps.store.transact(() => {
            if (accounts.length === 0) files.accounts.saveEmpty(accounts)
            else files.accounts.save(accounts)
            // 级联清理：只清该账号自己的发布记录与统计，不影响其他账号
            files.records.saveEmpty(files.records.load().filter(r => r.accountId !== params.id))
            files.metrics.save(files.metrics.load().filter(m => m.accountId !== params.id))
          })
        }
        writeOk(res, idx >= 0)
      },
    },
    {
      m: 'POST',
      p: 'v2/channels/accounts/:id/logout',
      h: ({ res, params }) => {
        const accounts = files.accounts.load()
        const account = accounts.find(a => a.id === params.id)
        if (account === undefined) {
          writeFailRaw(res, 'account not found', 40404)
          return
        }
        // 退出登录但保留账号资料：清除平台 Cookie/令牌，不删除历史统计。
        account.loginCookie = ''
        account.access_token = ''
        account.refresh_token = ''
        account.updateTime = nowIso()
        // 全清（2026-09-07）：同步吊销该账号的全部登录会话——抹除
        // platform-login/sessions/*/state.json 内的明文 cookie、删除 storage.json、
        // 写 revokedAt。否则旧会话轮询会把 cookie 复活回 accounts.json。
        const revokedSessions = revokeAccountLoginSessions(deps, account)
        files.accounts.save(accounts)
        const view = publicAccountView(account)
        view.revokedSessions = revokedSessions
        writeOk(res, view)
      },
    },
    // 2026-10-12 删：`GET v2/channels/accounts/:id/detail` 与 `GET v2/channels/accounts/:id`
    // 是同一个 handler（都用 publicAccountView），前端只调用后者——后端复核判定为真死接口。
    {
      m: 'POST',
      p: 'v2/channels/accounts/:id/sync',
      h: async ({ res, params }) => {
        const account = files.accounts.load().find(a => a.id === params.id)
        if (account === undefined) {
          writeFailRaw(res, 'account not found', 40404)
          return
        }
        const result = await syncPlatformWorks(deps, account)
        // 手动同步与「刷新粉丝数」共用同一条采集链路：结果一律写回账号，
        // 成功才推进 lastStatsTime（读接口不再写它），失败留下可读原因。
        recordStatsOutcome(deps, account.id, result)
        if (!result.ok) {
          writeFailRaw(res, result.message, 50000)
          return
        }
        writeOk(res, result)
      },
    },
    {
      m: 'GET',
      p: 'v2/platform-sync/capabilities',
      h: ({ res }) => {
        writeOk(res, platformSyncCapabilities())
      },
    },

    {
      m: 'GET',
      p: 'v2/channels/account-groups',
      h: ({ res }) => {
        writeOk(res, [...files.groups.load()].sort((a, b) => a.rank - b.rank))
      },
    },
    {
      m: 'POST',
      p: 'v2/channels/account-groups',
      h: ({ res, body }) => {
        const params = body as { name?: unknown }
        const groups = files.groups.load()
        const group = {
          id: uid('grp'),
          name: typeof params.name === 'string' ? params.name : '新分组',
          rank: groups.length,
          isDefault: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        groups.push(group)
        files.groups.save(groups)
        writeOk(res, group)
      },
    },
    {
      m: 'PATCH',
      p: 'v2/channels/account-groups/:id',
      h: ({ res, params, body }) => {
        const groups = files.groups.load()
        const group = groups.find(g => g.id === params.id)
        if (group === undefined) { writeFailRaw(res, 'group not found', 40404); return }
        const patch = body as { name?: unknown; rank?: unknown }
        if (typeof patch.name === 'string' && patch.name.trim() !== '') group.name = patch.name.trim()
        if (typeof patch.rank === 'number') group.rank = patch.rank
        group.updatedAt = nowIso()
        files.groups.save(groups)
        writeOk(res, group)
      },
    },
    {
      m: 'DELETE',
      p: 'v2/channels/account-groups',
      h: ({ res, query, body }) => {
        // 前端 http.delete 把参数放在 JSON 体（{ ids: [...] }），而查询串是另一条路径；
        // 旧实现只读查询串：ids 为空时过滤条件退化成"保留全部非默认分组"，
        // 于是用户删任意分组，被删掉的其实是默认分组、目标分组反而留下（账号随后成为孤儿）。
        // 两种来源都读；ids 为空一律不删；默认分组永不删除。
        const bodyIds = Array.isArray((body as { ids?: unknown } | undefined)?.ids)
          ? ((body as { ids: unknown[] }).ids).filter((id): id is string => typeof id === 'string' && id !== '')
          : []
        const ids = [...new Set([...query.getAll('ids'), ...bodyIds])]
        if (ids.length === 0) { writeOk(res, false); return }

        const groups = files.groups.load()
        const defaultGroup = groups.find(g => g.isDefault)
        const removedIds = new Set(groups.filter(g => ids.includes(g.id) && !g.isDefault).map(g => g.id))
        if (removedIds.size === 0) { writeOk(res, false); return }
        // 2026-10-12（审计 W05）：删分组要同时落 groups.json 与 accounts.json——两步之间失败会留下
        // 「分组没了、账号 groupId 还指着它」的孤儿状态（G3）。包进事务：要么都生效要么都不生效。
        deps.store.transact(() => {
          files.groups.save(groups.filter(g => !removedIds.has(g.id)))

          // 被删分组里的账号回落到默认分组，避免账号 groupId 指向已不存在的分组。
          if (defaultGroup !== undefined) {
            const accounts = files.accounts.load()
            let changed = false
            for (const account of accounts) {
              if (account.groupId !== undefined && removedIds.has(account.groupId)) {
                account.groupId = defaultGroup.id
                changed = true
              }
            }
            if (changed) files.accounts.save(accounts)
          }
        })
        writeOk(res, true)
      },
    },

    // ---- 发布 Flow / 记录 / 任务 ---------------------------------------------

    {
      m: 'POST',
      p: 'v2/channels/publish/flows',
      h: ({ res, body }) => {
        const params = body as {
          flowId?: unknown
          content?: { title?: unknown; body?: unknown; topics?: unknown; declaration?: unknown; location?: unknown; media?: { url: string; metadata?: Record<string, unknown> }[]; cover?: { url: string } }
          publishAt?: unknown
          context?: { type?: unknown; materialId?: unknown; requestId?: unknown }
          items?: { accountId: string; platform: string }[]
        }
        const flowId = typeof params.flowId === 'string' && params.flowId !== '' ? params.flowId : uid('flow')
        const records = files.records.load()
        const title = typeof params.content?.title === 'string' ? params.content.title : ''
        const bodyText = typeof params.content?.body === 'string' ? params.content.body : ''
        const topics = (Array.isArray(params.content?.topics) ? params.content.topics : [])
          .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          .map(t => t.replace(/^#+/, '').trim())
          .slice(0, 10)
        // 内容标注：前端传什么就存什么；没传按默认（AI 生成内容）——引擎侧抖音会按这段文字
        // 在"自主声明"弹窗里点选。它属于**发布必经环节**，不能悄悄漏掉。
        const declaration = typeof params.content?.declaration === 'string' && params.content.declaration.trim() !== ''
          ? params.content.declaration.trim()
          : DEFAULT_CONTENT_DECLARATION
        // 位置标签：用户/智能体在发布前指定的地名，透传到引擎的「添加标签 → 位置」。
        const location = typeof params.content?.location === 'string' ? params.content.location.trim() : ''
        const mediaUrls = (params.content?.media ?? []).map(m => m.url)
        const coverUrl = params.content?.cover?.url ?? mediaUrls[0] ?? ''
        const items = Array.isArray(params.items) ? params.items : []
        const contextType = typeof params.context?.type === 'string' ? params.context.type : ''
        // 界面一直在传来源草稿，服务端此前只是**声明**了它却没读——于是"作品 ↔ 草稿 ↔ AI 样本"
        // 这条链在落库这一步就断了。存下来才谈得上用真实表现给样本打分。
        const draftId = typeof params.context?.materialId === 'string' ? params.context.materialId : ''
        // 动作卡的工单号（DEF-247）：界面把动作卡上的 requestId 随发布请求带回来，
        // 发布完成后才有依据把"已核验 + 真实作品号"回填到那张卡上。
        // 不传就为空——照常发布，只是没有工单可回填；绝不按账号/时间猜一个任务去写。
        const actionRequestId = typeof params.context?.requestId === 'string' ? params.context.requestId.trim() : ''
        const publishType = contextType === 'VIDEO' || contextType === 'video' ? 'VIDEO' as const : 'ImageText' as const
        const tasks: Record<string, unknown>[] = []

        // 真实发布硬校验：无账号 / 空标题 / 无媒体都会在落库前拦截，
        // 避免“发布”按钮产生一条必然失败的记录。
        if (items.length === 0) {
          writeFailRaw(res, '请选择至少一个发布账号', 40000)
          return
        }
        if (items.some(item => typeof item?.accountId !== 'string' || item.accountId.trim() === '')) {
          writeFailRaw(res, '发布账号无效，请重新选择账号', 40000)
          return
        }
        const needsMedia = items.some(item => ['xhs', 'douyin', 'KWAI', 'wxSph'].includes(String(item.platform)))
        if (needsMedia && mediaUrls.length === 0) {
          writeFailRaw(res, '发布内容缺少媒体文件，请上传图片或视频后重试', 40000)
          return
        }
        const needsTitle = items.some(item => ['xhs', 'douyin', 'KWAI', 'wxSph'].includes(String(item.platform)))
        if (needsTitle && title.trim() === '') {
          writeFailRaw(res, '发布内容缺少标题，请填写标题后重试', 40000)
          return
        }
        // 发布内容体检（DEF-303）：前端「去发布」弹窗路径实测会把助手对用户的**过程叙述**
        // 当成品文案提交（现场：标题＝「已经办了这两步，剩下的交给发布管家了：」）。
        // 在落库前拦一道：命中即拒、记录都不创建——比跑完引擎再判省一条失败记录。
        // 清单必须与 engine/worker.py 的 _process_marks 一致（两道闸、一份真相，门禁校验一致）。
        const narrationMarks = ['交给发布管家', '剩下的交给', '已经办了', '已经完成，接下来', '进度去「我的任务」', '请到「我的任务」']
        const narrationHit = narrationMarks.find(mark => title.includes(mark) || bodyText.includes(mark))
        if (narrationHit !== undefined) {
          writeFailRaw(res, '发布内容疑似过程叙述而不是成品文案（含「' + narrationHit + '」这类对我说的过程话）：'
            + '请让管家先生成正式的标题与正文，再从这里发布', 40004)
          return
        }
        // 标题长度按**权威表**校验（platform-catalog.ts 的 PLATFORM_CONTENT_LIMITS）：
        // 语境教给模型的数字与这里必须是同一个真相。此前站内规则表写 ≤30（无出处）、引擎按 20 拒收，
        // 模型只能靠撞墙学会（DEF-253）。现在在落库前就用同一张表拦下，并给出可执行的改法。
        for (const item of items) {
          const limit = platformTitleLimit(String(item.platform))
          if (limit !== undefined && title.trim().length > limit) {
            writeFailRaw(
              res,
              '标题 ' + String(title.trim().length) + ' 字，超过 ' + String(item.platform) + ' 的标题上限 '
                + String(limit) + ' 字：请压到 ' + String(limit) + ' 字以内再提交',
              40003,
            )
            return
          }
        }

        // 界面连「立即发布」也会带 publishAt（值就是当下），所以只有**明确排在未来的**才算排期：
        // 否则重启恢复排期时会把本就该立刻跑的记录也当排期恢复。判断口径与内核侧一致。
        const scheduledAt = typeof params.publishAt === 'string' ? params.publishAt.trim() : ''
        const scheduledMs = scheduledAt === '' ? Number.NaN : Date.parse(scheduledAt)
        const isScheduled = Number.isFinite(scheduledMs) && scheduledMs > Date.now() + 60_000

        for (const item of items) {
          const recordId = uid('rec')
          const publishAt = scheduledAt !== '' ? scheduledAt : nowIso()
          records.unshift({
            id: recordId,
            flowId,
            taskId: recordId,
            userId: 'zy-user-001',
            accountId: item.accountId,
            accountType: item.platform,
            ...(draftId !== '' ? { draftId } : {}),
            // 来源工单号：发布完成/失败时据此把结果回填到那张动作卡上（DEF-247）。
            ...(actionRequestId === '' ? {} : { requestId: actionRequestId }),
            type: publishType,
            status: isScheduled ? PUBLISH_RECORD_STATUS.SCHEDULED : PUBLISH_RECORD_STATUS.PENDING,
            title,
            desc: bodyText,
            publishTime: publishAt,
            videoUrl: publishType === 'VIDEO' ? mediaUrls[0] ?? '' : '',
            coverUrl,
            imgUrlList: publishType === 'ImageText' ? mediaUrls : [],
            topics,
            declaration,
            // 位置标签（可选）：透传到引擎的「添加标签 → 位置」，也留在记录里便于回看。
            ...(location === '' ? {} : { location }),
            source: 'publish',
            errorMsg: '',
            createdAt: nowIso(),
            updatedAt: nowIso(),
            linkStatus: 'pending',
            // 不写 engagement：新建记录时一个互动指标都还没采到，写一组 0 就是
            // 声称「这条作品的播放/点赞都是 0」（要求二 R3 无源不显示）。
            // 真实采集回填由 platform-sync 负责，那边只写平台真的给了的字段。
          })
          schedulePublish(deps, recordId, publishAt)
          tasks.push({ id: recordId, accountId: item.accountId, platform: item.platform, status: PUBLISH_RECORD_STATUS.PENDING, publishTime: publishAt, platformWorkId: '', workLink: '', errorMsg: '' })
        }
        files.records.save(records)
        writeOk(res, { flowId, tasks })
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/publish/flows/:flowId',
      h: ({ res, params }) => {
        const mine = files.records.load().filter(r => r.flowId === params.flowId)
        if (mine.length === 0) { writeFailRaw(res, 'flow not found', 40404); return }
        writeOk(res, { flowId: params.flowId, tasks: mine.map(flowTaskView) })
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/publish/records/public/:recordId',
      h: ({ res, params }) => {
        const rec = files.records.load().find(r => r.id === params.recordId)
        if (rec === undefined) { writeFailRaw(res, 'record not found', 40404); return }
        writeOk(res, { id: rec.id, accountType: rec.accountType, type: rec.type, status: rec.status, publishTime: rec.publishTime, workLink: rec.workLink })
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/publish/records/:recordId/user-action',
      h: ({ res }) => {
        // 抖音 H5 用户确认通道目前未接入：显式返回不可用，避免前端把空 scheme/shortLink
        // 当成“待确认”永久轮询，造成“看起来在发布、实际永远发不出去”的假象。
        writeFailRaw(res, '抖音用户确认通道未接入，无法完成真实发布', 50100)
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/publish/records/:recordId',
      h: ({ res, params }) => {
        const rec = files.records.load().find(r => r.id === params.recordId)
        if (rec === undefined) { writeFailRaw(res, 'record not found', 40404); return }
        writeOk(res, rec)
      },
    },
    {
      m: 'DELETE',
      p: 'v2/channels/publish/records/:recordId',
      h: ({ res, params }) => {
        const records = files.records.load()
        const idx = records.findIndex(r => r.id === params.recordId)
        if (idx >= 0) { records.splice(idx, 1); files.records.saveEmpty(records) }
        // DEF-273（2026-10-12）：删记录必须**同时**取消内存里的排期定时器。
        // 只删记录的话，用户看见「已取消」、到点却照样发出去——记录没了、定时器还在。
        cancelScheduledPublish(params.recordId ?? '')
        writeOk(res, null)
      },
    },
    {
      m: 'GET',
      p: 'v2/channels/publish/records',
      h: ({ res, query }) => {
        let list = files.records.load()
        const accountId = query.get('accountId')
        const accountType = query.get('accountType')
        const status = query.get('status')
        if (accountId != null && accountId !== '') list = list.filter(r => r.accountId === accountId)
        if (accountType != null && accountType !== '') list = list.filter(r => r.accountType === accountType)
        if (status != null && status !== '') list = list.filter(r => r.status === Number(status))
        const timeParam = query.get('time')
        if (timeParam != null && timeParam !== '') {
          const timeParts = timeParam.split(',').filter(part => part !== '')
          const [startRaw, endRaw] = timeParts
          if (startRaw !== undefined && endRaw !== undefined) {
            const startTime = Date.parse(startRaw)
            const endTime = Date.parse(endRaw)
            if (Number.isFinite(startTime) && Number.isFinite(endTime)) {
              list = list.filter((r) => {
                const publishTime = Date.parse(String(r.publishTime ?? ''))
                return Number.isFinite(publishTime) && publishTime >= startTime && publishTime <= endTime
              })
            }
          }
        }
        writeOk(res, { records: list })
      },
    },

    {
      m: 'POST',
      p: 'v2/channels/publish/tasks/:taskId/publish-now',
      h: ({ res, params }) => {
        // 任务不存在时必须如实报错：回 code 0 会让界面以为已开始发布。
        if (!setRecordStatus(deps, params.taskId!, PUBLISH_RECORD_STATUS.PUBLISHING)) {
          writeFailRaw(res, 'task not found', 40404)
          return
        }
        schedulePublish(deps, params.taskId!, nowIso())
        writeOk(res, { taskId: params.taskId! })
      },
    },
    {
      m: 'POST',
      p: 'v2/channels/publish/abort-current',
      h: ({ res, body }) => {
        // 按账号打断"正在进行中的发布"：前端在发布途中点「中断」时用。
        // 前端手里只有动作卡上的 accountId、没有 taskId —— 逼它去猜 taskId 等于把这个功能做成摆设。
        const accountId = readString(body, 'accountId')
        if (accountId === '') {
          writeFailRaw(res, 'accountId required', 40001)
          return
        }
        const running = findRunningPublish(deps, accountId)
        if (running === undefined) {
          writeOk(res, { aborted: false, reason: '没有进行中的发布' })
          return
        }
        killPublishWorker(join(deps.dataRoot, 'platform-login', 'publish', running))
        setRecordStatus(deps, running, PUBLISH_RECORD_STATUS.CANCELED)
        writeOk(res, { aborted: true, taskId: running })
      },
    },
    // 2026-10-12 删：`POST v2/channels/publish/tasks/:taskId/abort` 零调用方——
    // 前端的中断走 `publish/abort-current`，取消走 `DELETE v2/channels/publish/tasks/:taskId`
    // （后端复核判定为真死接口；retry 仍在用，保留）。
    {
      m: 'POST',
      p: 'v2/channels/publish/tasks/:taskId/retry',
      h: ({ res, params }) => {
        if (!setRecordStatus(deps, params.taskId!, PUBLISH_RECORD_STATUS.PENDING)) {
          writeFailRaw(res, 'task not found', 40404)
          return
        }
        schedulePublish(deps, params.taskId!, nowIso())
        writeOk(res, { taskId: params.taskId! })
      },
    },
    {
      m: 'PATCH',
      p: 'v2/channels/publish/tasks/:taskId/publish-at',
      h: ({ res, params, body }) => {
        const publishAt = readString(body, 'publishAt')
        const records = files.records.load()
        const rec = records.find(r => r.id === params.taskId || r.taskId === params.taskId)
        // 以前这里 if (rec !== undefined) 包着，任务不存在照样回 code 0：
        // 界面显示「已定时」，实际什么都没排。与 publish-now/retry 同规则如实报错。
        if (rec === undefined) {
          writeFailRaw(res, 'task not found', 40404)
          return
        }
        rec.publishTime = publishAt
        rec.status = PUBLISH_RECORD_STATUS.SCHEDULED
        rec.updatedAt = nowIso()
        files.records.save(records)
        // 改时刻必须**重装**定时器：原来那个还按旧时刻在跑，用户把「今天下午」改成「后天」，
        // 到点却照旧发布——改了时间等于没改。schedulePublish 内部先撤旧的再装新的。
        schedulePublish(deps, rec.id, publishAt)
        writeOk(res, { taskId: params.taskId })
      },
    },
    {
      m: 'DELETE',
      p: 'v2/channels/publish/tasks/:taskId',
      h: ({ res, params }) => {
        if (!setRecordStatus(deps, params.taskId!, PUBLISH_RECORD_STATUS.CANCELED)) {
          writeFailRaw(res, 'task not found', 40404)
          return
        }
        writeOk(res, { taskId: params.taskId })
      },
    },

    // ---- 作品分析与归属校验 --------------------------------------------------

    {
      m: 'GET',
      p: 'v2/channels/works/:platform/:workId/analytics',
      h: ({ res, params, query }) => {
        const rows = files.metrics.load().filter(m => m.workId === params.workId)
        // 没有采样行时不能回一组 0：那等于声称「这条作品的播放/点赞都是 0」。
        // 与要求二 R3 同规则——平台没给的指标整键缺省，调用方据此显示「未采集」。
        const sum = (key: 'viewCount' | 'likeCount' | 'commentCount' | 'shareCount' | 'favoriteCount'): number | undefined => {
          const values = rows
            .map(row => row[key])
            .filter((value): value is number => typeof value === 'number')
          return values.length === 0 ? undefined : values.reduce((acc, value) => acc + value, 0)
        }
        const metrics: Record<string, number> = {}
        for (const key of ['viewCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount'] as const) {
          const value = sum(key)
          if (value !== undefined) metrics[key] = value
        }
        writeOk(res, {
          platform: params.platform,
          accountId: query.get('accountId') ?? undefined,
          platformWorkId: params.workId,
          metrics,
          // 一条采样行都没有时说清楚，免得调用方把空对象读成「全是 0」。
          sampleCount: rows.length,
          fetchedAt: nowIso(),
        })
      },
    },
    {
      m: 'POST',
      p: 'channel/work/validate',
      h: ({ res, body }) => {
        void body
        writeFailRaw(res, '平台作品归属校验尚未接入真实验证，当前不会伪造已通过', 50100)
      },
    },
  )
}

// ---- 共享动作 ---------------------------------------------------------------

/** analytics 实时拉取节流：同账号两次真实平台采集的最小间隔。 */
const ANALYTICS_SYNC_MIN_INTERVAL_MS = 10 * 60_000
/**
 * 触发接口在响应前等待采集结果的时长。真实平台采集要 20 秒以上，不可能在一次请求里等完；
 * 这个窗口只用来同步判定"秒级失败"（平台未接入、缺 Cookie、同步引擎起不来），
 * 超过窗口仍无结果就如实回「已开始采集」，由账号上的留痕告知最终成败。
 */
const ANALYTICS_SYNC_INLINE_WAIT_MS = 3_000
/** 每账号上次触发真实拉取的时间戳。 */
const analyticsSyncAt = new Map<string, number>()
/** 正在执行真实拉取的账号（防止重复点击把 worker 堆叠）。 */
const statsSyncInFlight = new Set<string>()

/** 「刷新粉丝数」触发结果：状态如实描述本次请求到底做了什么。 */
interface AccountStatsRefreshResult {
  /** 请求本身是否成立；false 表示这次没有（也无法）刷新，message 是原因。 */
  ok: boolean
  /**
   * completed=本次已真实采集完；started=已开始采集、完成后再落盘；
   * in_flight=上一轮采集还在跑；throttled=仍在刷新间隔内；failed=没有触发采集。
   */
  status: 'completed' | 'started' | 'in_flight' | 'throttled' | 'failed'
  /** 面向用户的原因/说明。 */
  message: string
  /** throttled 时的剩余冷却时长；供调用方精确记录冷却，缺省表示未知。 */
  remainingMs?: number | undefined
  /** 本次真实采集后的账号数据；未采到（如仍在采集中）时为 undefined，不伪造数值。 */
  lastStatsTime?: string | undefined
  fansCount?: number | undefined
  workCount?: number | undefined
}

/**
 * 触发一次账号真实数据采集（「刷新粉丝数」按钮）。
 * 能当场判定的失败一定如实返回失败；真实采集超出等待窗口时返回 started，
 * 最终成败由 recordStatsOutcome 写回账号，读接口照实呈现。
 * @param deps - 共享依赖（存储、配置、模型桥）。
 * @param account - 目标账号。
 * @returns 本次触发的真实状态与说明。
 */
async function startAccountStatsRefresh(deps: Deps, account: ZySocialAccount): Promise<AccountStatsRefreshResult> {
  const capability = platformSyncCapabilities().find(c => c.platform === account.type)
  if (capability === undefined)
    return { ok: false, status: 'failed', message: `平台「${account.type}」没有注册数据采集适配器，粉丝数无法刷新` }
  if (!capability.canSync)
    return { ok: false, status: 'failed', message: `${capability.name}账号数据采集尚未接入，本次不会刷新粉丝数` }
  if (typeof account.loginCookie !== 'string' || account.loginCookie === '')
    return { ok: false, status: 'failed', message: `${capability.name}账号缺少平台 Cookie，请先扫码登录再刷新粉丝数` }
  if (statsSyncInFlight.has(account.id))
    return { ok: true, status: 'in_flight', message: `${capability.name}账号数据正在采集中，完成后数字会更新` }
  const remainingMs = ANALYTICS_SYNC_MIN_INTERVAL_MS - (Date.now() - (analyticsSyncAt.get(account.id) ?? 0))
  if (remainingMs > 0)
    return { ok: true, status: 'throttled', remainingMs, message: `距上次真实采集不足 ${Math.ceil(remainingMs / 60_000)} 分钟，仍在刷新间隔内，本次未重复采集${capability.name}数据` }

  analyticsSyncAt.set(account.id, Date.now())
  statsSyncInFlight.add(account.id)
  const pending = syncPlatformWorks(deps, account)
  const settled = await Promise.race([
    pending.then(outcome => ({ outcome })),
    new Promise<null>(resolve => setTimeout(() => resolve(null), ANALYTICS_SYNC_INLINE_WAIT_MS)),
  ])
  if (settled !== null) {
    statsSyncInFlight.delete(account.id)
    recordStatsOutcome(deps, account.id, settled.outcome)
    if (!settled.outcome.ok) {
      // 采集没成功就不占节流窗口，用户可以立刻重试。
      analyticsSyncAt.delete(account.id)
      return { ok: false, status: 'failed', message: settled.outcome.message }
    }
    const updated = deps.store.files.accounts.load().find(a => a.id === account.id)
    return {
      ok: true,
      status: 'completed',
      message: `${capability.name}粉丝数已刷新`,
      lastStatsTime: updated?.lastStatsTime,
      fansCount: updated?.fansCount,
      workCount: updated?.workCount,
    }
  }

  void pending
    .then(outcome => recordStatsOutcome(deps, account.id, outcome))
    .catch((error: unknown) => {
      // 采集链路自己抛错（不是平台回失败）同样要留痕，否则账号上看起来一直在采集。
      recordStatsOutcome(deps, account.id, {
        ok: false,
        platform: account.type,
        count: 0,
        updatedAt: nowIso(),
        message: `平台数据采集异常：${error instanceof Error ? error.message : String(error)}`,
      })
    })
    .finally(() => statsSyncInFlight.delete(account.id))
  return { ok: true, status: 'started', message: `已开始采集${capability.name}真实数据，完成后数字会自动更新` }
}

/**
 * 把一次真实采集的结果写回账号：成功才推进 lastStatsTime 并清掉上次的失败原因；
 * 失败留下平台给出的原因，供读接口与界面如实展示。
 * @param deps - 共享依赖（存储、配置、模型桥）。
 * @param accountId - 目标账号 id。
 * @param outcome - syncPlatformWorks 的采集结果。
 */
function recordStatsOutcome(deps: Deps, accountId: string, outcome: PlatformSyncOutcome): void {
  const accounts = deps.store.files.accounts.load()
  const target = accounts.find(a => a.id === accountId)
  if (target === undefined) return
  target.lastStatsAttemptTime = nowIso()
  if (outcome.ok) {
    target.lastStatsTime = nowIso()
    delete target.lastStatsError
  }
  else {
    target.lastStatsError = outcome.message
  }
  deps.store.files.accounts.save(accounts)
}

function flowTaskView(rec: import('./types.ts').ZyPublishRecord): Record<string, unknown> {
  return {
    id: rec.id,
    accountId: rec.accountId,
    platform: rec.accountType,
    status: rec.status,
    publishTime: rec.publishTime,
    platformWorkId: rec.platformWorkId ?? '',
    workLink: rec.workLink ?? '',
    errorMsg: rec.errorMsg ?? '',
  }
}

/** 把记录里的媒体 URL（后端资产 URL 或外链）映射为引擎可用的本地/远端路径。 */
function mediaUrlToPath(d: Deps, url: string): string {
  if (url.startsWith('/bosom-friend/api/assets/file/')) {
    const assetId = decodeURIComponent(url.split('/').pop() ?? '')
    return join(d.dataRoot, 'uploads', assetId)
  }
  return url
}

/**
 * 把这次发布的结果回填到任务的动作卡上（DEF-247）。
 *
 * 为什么必须回填：动作卡上的"已申请"由服务端发放，而**发布结果只有发布链路知道**
 * （记录里的平台作品号）。不回填时，任务里那张卡永远停在"已申请"，
 * 用户与模型都判断不了这一步到底做完了没有。
 *
 * 认领方式只看**工单号**（记录里的 `requestId`）：没有它就什么都不做。
 * 按账号/时间猜一个任务去写，比不回填更坏——那会把结果写到别人的任务上。
 *
 * @param d - 产品依赖（任务存储）。
 * @param record - 发布记录（带来源工单号；作品号用于核验态的真实 id）。
 * @param outcome - 这次发布的结果：verified 表示平台已回执，failed 表示明确没成。
 */
export function writePublishActionResult(
  d: Deps,
  record: Pick<import('./types.ts').ZyPublishRecord, 'id' | 'requestId' | 'platformWorkId'>,
  outcome: { state: 'verified' | 'failed', realId?: string, note: string },
): void {
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : ''
  if (requestId === '') return
  const tasks = d.store.files.tasks.load()
  const task = tasks.find(item => item.messages.some(message => messageCarriesRequestId(message, requestId)))
  if (task === undefined) return
  const results = Array.isArray(task.actionResults) ? task.actionResults : []
  const previous = results.find(item => item.requestId === requestId)
  // 已核验的工单不回退：发布成功过就是成功过，之后的一条失败记录不能把它改回去。
  if (previous !== undefined && previous.state === 'verified' && outcome.state !== 'verified') return
  const entry = {
    requestId,
    state: outcome.state,
    realId: outcome.realId ?? '',
    note: outcome.note.slice(0, 200),
    at: nowIso(),
  }
  if (previous === undefined) results.push(entry)
  else Object.assign(previous, entry)
  task.actionResults = results
  task.updatedAt = nowIso()
  d.store.files.tasks.save(tasks)
}

/**
 * 这条任务消息里有没有某张动作卡的工单号。
 *
 * 动作卡落在助手消息的 `result` 数组里（api.ts 发放时就是那个位置），
 * 所以按 requestId 反查任务只能从这里找——不另建索引，避免两份事实互相漂移。
 *
 * @param message - 任务消息。
 * @param requestId - 服务端发放的工单号。
 * @returns 这条消息带着该工单时为 true。
 */
function messageCarriesRequestId(message: import('./types.ts').ZyTaskMessage, requestId: string): boolean {
  const result = message.result
  if (!Array.isArray(result)) return false
  return result.some(card => {
    const value = (card as { requestId?: unknown } | null | undefined)?.requestId
    return typeof value === 'string' && value === requestId
  })
}

/** 发布失败：把原因写回记录，供前端展示真实错误。 */
function failRecord(d: Deps, recordId: string, message: string): void {
  const records = d.store.files.records.load()
  const rec = records.find(r => r.id === recordId)
  if (rec === undefined) return
  rec.status = PUBLISH_RECORD_STATUS.FAILED
  rec.errorMsg = message
  rec.updatedAt = nowIso()
  d.store.files.records.save(records)
  // 工单回填（DEF-247）：这张动作卡最后是失败。动作卡本身仍是"已申请"（服务端不改它），
  // 这里记下"这一步没成 + 为什么"，用户回到任务里能看到下文，而不是一直停在申请中。
  writePublishActionResult(d, rec, { state: 'failed', note: '发布未成功：' + message })
}

/** 读取一个 JSON 文件；缺失或损坏一律按「没有」处理。 */
function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }
  catch {
    return undefined
  }
}

/**
 * 找出该账号仍在进行的发布任务。
 *
 * 平台不允许同一账号两个会话同时发布：第二个会话会被顶掉登录态，两条一起失败
 * （2026-09-29 现场）。引擎侧没有账号级串行，闸门放在调度这一层。
 *
 * @param d - 产品依赖。
 * @param accountId - 目标账号 id。
 * @returns 进行中的发布任务 id；没有则为 undefined。
 */
function findRunningPublish(d: Deps, accountId: string): string | undefined {
  const root = join(d.dataRoot, 'platform-login', 'publish')
  let names: string[] = []
  try {
    names = readdirSync(root)
  }
  catch {
    return undefined
  }
  for (const name of names) {
    const state = readJsonFile<{ status?: string }>(join(root, name, 'state.json'))
    if (state?.status !== 'starting' && state?.status !== 'uploading') continue
    const input = readJsonFile<{ accountId?: string }>(join(root, name, 'input.json'))
    if (input?.accountId === accountId) return name
  }
  return undefined
}

/** 记录 id → 当前排期定时器。重排期必须先撤掉上一个，否则旧时刻到点照旧发布。 */
const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * setTimeout 的 delay 是 32 位有符号整数：超过 2147483647ms（≈24.8 天）会溢出成 1ms **立即执行**。
 * 用户把内容排到一个月后，等于当场真实发布，所以超上限一律分段等，绝不把超限值交给 setTimeout。
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * 发布调度：到点后拉起真实平台发布引擎（social-auto-upload），轮询结果回写记录。
 *
 * 定时器只活在进程内存里，服务一停就没了（dev 重启、升级、崩溃后拉起），所以启动时还要
 * {@link resumeScheduledPublishes} 把还没到点的排期重新装上。
 *
 * @param d - 产品依赖。
 * @param recordId - 发布记录 id。
 * @param publishAt - 目标发布时刻（ISO 字符串）。
 */
function schedulePublish(d: Deps, recordId: string, publishAt: string): void {
  cancelScheduledPublish(recordId)
  armPublishTimer(d, recordId, publishAt)
}

/**
 * 撤掉这条记录的排期定时器。重排期与取消都必须先走这里。
 *
 * @param recordId - 发布记录 id。
 */
function cancelScheduledPublish(recordId: string): void {
  const timer = scheduledTimers.get(recordId)
  if (timer === undefined) return
  clearTimeout(timer)
  scheduledTimers.delete(recordId)
}

/**
 * 装上（或重装）这条记录的排期定时器；剩余时间超过 {@link MAX_TIMER_DELAY_MS} 时先等一段再续排。
 *
 * @param d - 产品依赖。
 * @param recordId - 发布记录 id。
 * @param publishAt - 目标发布时刻（ISO 字符串），分段续排期间保持不变。
 */
function armPublishTimer(d: Deps, recordId: string, publishAt: string): void {
  const delay = Math.max(0, Date.parse(publishAt) - Date.now())
  if (delay > MAX_TIMER_DELAY_MS) {
    const segment = setTimeout(() => {
      scheduledTimers.delete(recordId)
      const still = d.store.files.records.load().find(r => r.id === recordId)
      if (still === undefined || still.status === PUBLISH_RECORD_STATUS.CANCELED) return
      armPublishTimer(d, recordId, publishAt)
    }, MAX_TIMER_DELAY_MS)
    scheduledTimers.set(recordId, segment)
    return
  }
  const timer = setTimeout(() => {
    scheduledTimers.delete(recordId)
    runScheduledPublish(d, recordId)
  }, delay)
  scheduledTimers.set(recordId, timer)
}

/**
 * 到点执行一次排期发布：复核账号与媒体、同账号串行、交给平台引擎并轮询回写。
 *
 * @param d - 产品依赖。
 * @param recordId - 发布记录 id。
 */
function runScheduledPublish(d: Deps, recordId: string): void {
  const records = d.store.files.records.load()
    const rec = records.find(r => r.id === recordId)
    if (rec === undefined || rec.status === PUBLISH_RECORD_STATUS.CANCELED || rec.status === PUBLISH_RECORD_STATUS.PUBLISHED) return

    const accounts = d.store.files.accounts.load()
    const account = accounts.find(a => a.id === rec.accountId)
    if (account === undefined || typeof account.loginCookie !== 'string' || account.loginCookie === '') {
      failRecord(d, recordId, '账号未完成真实登录（缺少平台 cookie），请先在「渠道」中扫码登录该账号')
      return
    }
    const mediaFiles = Array.from(new Set(
      (rec.type === 'VIDEO'
        ? [rec.videoUrl, rec.coverUrl]
        : [...(rec.imgUrlList ?? []), rec.coverUrl])
        .filter((u): u is string => typeof u === 'string' && u !== '')
        .map(u => mediaUrlToPath(d, u)),
    ))
    if (mediaFiles.length === 0) {
      failRecord(d, recordId, '发布内容缺少媒体文件，请重新编辑草稿')
      return
    }

    const accountId = rec.accountId ?? ''
    // 同账号串行：先让看门狗判一次超时（它会把僵尸任务标失败并按进程树终止），
    // 免得一个已经跑死的引擎把账号一直占住。
    if (accountId !== '') {
      const running = findRunningPublish(d, accountId)
      if (running !== undefined) {
        const state = getPublishState(d, running)
        if (state?.status === 'starting' || state?.status === 'uploading') {
          failRecord(d, recordId, '该账号已有发布任务在进行中（' + running + '），请等它结束后重试')
          return
        }
      }
    }

    const taskId = uid('pub')
    const started = startPlatformPublish(d, taskId, {
      platform: rec.accountType,
      type: rec.type,
      title: rec.title ?? '',
      desc: rec.desc ?? '',
      topics: rec.topics ?? [],
      mediaFiles,
      loginCookie: account.loginCookie,
      // 账号维度复用引擎的持久档案：缺了它每次发布都是新设备，平台必弹短信验证。
      ...(accountId === '' ? {} : { accountId }),
      // 内容标注（网信办 2026-05 起为发布必经环节）：记录里没写就按"内容由AI生成"——
      // 我们出的是 AI 内容，这是正确的一项，且与引擎的兜底值一致（不让两边各说各话）。
      declaration: rec.declaration ?? DEFAULT_CONTENT_DECLARATION,
      // 位置：记录里写过就带上，没写就不加位置（引擎侧位置是可选步骤）。
      ...(rec.location === undefined || rec.location === '' ? {} : { location: rec.location }),
      // 封面：把记录的封面图解析成本地路径交给引擎；不传时平台拿视频首帧当封面（实拍片常是黑屏）。
      ...(rec.coverUrl === undefined || rec.coverUrl === ''
        ? {}
        : { thumbnailPath: mediaUrlToPath(d, rec.coverUrl) }),
    })
    if (!started.ok) {
      failRecord(d, recordId, started.error)
      markAccountLoginInvalid(d, rec.accountId, started.error)
      return
    }
    rec.status = PUBLISH_RECORD_STATUS.PUBLISHING
    rec.updatedAt = nowIso()
    d.store.files.records.save(records)

    // 轮询预算与引擎/看门狗同一张表：引擎总量（发布步骤 + 20 分钟回读）小于它，
    // 真实发布在预算内永远不会被这里判超时（DEF-305：三处预算必须一起改）。
    const deadline = Date.now() + PUBLISH_TASK_BUDGET_MS
    const poll = setInterval(() => {
      const state = getPublishState(d, taskId)
      const latest = d.store.files.records.load()
      const done = latest.find(r => r.id === recordId)
      if (done === undefined || done.status === PUBLISH_RECORD_STATUS.CANCELED) {
        clearInterval(poll)
        return
      }
      if (state?.status === 'done') {
        clearInterval(poll)
        const workId = state.platformWorkId ?? ''
        const workLink = state.workLink ?? ''
        // 真实发布硬校验：平台未返回作品 ID/链接时一律不得标记成功，避免“假发布”。
        if (workId === '' && workLink === '') {
          failRecord(d, recordId, '平台未返回作品链接，本次发布未确认成功，请检查账号后重试')
          return
        }
        done.status = PUBLISH_RECORD_STATUS.PUBLISHED
        done.platformWorkId = workId
        done.workLink = workLink
        done.publishedAt = nowIso()
        done.updatedAt = nowIso()
        done.linkStatus = 'ready'
        done.errorMsg = ''
        d.store.files.records.saveEmpty(latest)
        // 工单回填（DEF-247）：**这里才是"已核验"的正解**——平台回执（作品号/链接）在这一刻才拿到，
        // 而"这条发布对应哪张动作卡"只有服务端自己的工单号说得清（记录里的 requestId）。
        // 写进任务后，动作卡从"已申请"变成"已核验 + 真实作品号"，用户与模型都不必再猜这一步做完了没有。
        writePublishActionResult(d, done, {
          state: 'verified',
          realId: workId,
          note: '平台已回执：作品已发布' + (workLink === '' ? '' : '（' + workLink + '）'),
        })
        // 回填到来源草稿（DEF-247 的正解）：用户在草稿箱里要能一眼看出「这条发过没、发到哪个号、作品在哪」。
        // 不回填的话，草稿与发布记录是两座孤岛——明明发出去了，草稿上还是"未发布"。
        // 只写 metadata.published 一个命名空间，不动草稿的其它字段，向后兼容（老草稿没有这个键就是没发过）。
        const sourceDraftId = typeof done.draftId === 'string' ? done.draftId : ''
        if (sourceDraftId !== '') {
          const contents = d.store.files.contents.load()
          const draft = contents.find(item => item.kind === 'draft' && item._id === sourceDraftId)
          if (draft !== undefined) {
            const target = draft as { metadata?: Record<string, unknown>, updatedAt?: string }
            target.metadata = {
              ...(target.metadata ?? {}),
              published: {
                platform: done.accountType,
                accountId: done.accountId,
                workId,
                workLink,
                at: done.publishedAt,
              },
            }
            target.updatedAt = nowIso()
            d.store.files.contents.save(contents)
          }
        }
        const accountsNow = d.store.files.accounts.load()
        const acc = accountsNow.find(a => a.id === done.accountId)
        if (acc !== undefined) {
          acc.workCount = (acc.workCount ?? 0) + 1
          acc.updateTime = nowIso()
          d.store.files.accounts.save(accountsNow)
        }
        // 真实发布成功：写一条数据中心指标行（后续由数据采集刷新互动数据）
        const metricsNow = d.store.files.metrics.load()
        metricsNow.unshift({
          date: nowIso().slice(0, 10),
          platform: done.accountType,
          accountId: done.accountId,
          workId: done.platformWorkId ?? done.id,
          viewCount: 0,
          likeCount: 0,
          commentCount: 0,
          shareCount: 0,
          favoriteCount: 0,
        })
        d.store.files.metrics.save(metricsNow)
        return
      }
      if (state?.status === 'failed') {
        clearInterval(poll)
        const message = state.error ?? '平台发布失败，请重试'
        failRecord(d, recordId, message)
        markAccountLoginInvalid(d, done.accountId, message)
        return
      }
      if (Date.now() > deadline) {
        clearInterval(poll)
        // 超时收尸可能与「动作已执行」重合：统一用"可能已发出、先同步确认"的文案，
        // 不诱导直接重发（DEF-240 / DEF-305）。
        failRecord(d, recordId, PUBLISH_RESULT_UNKNOWN_MESSAGE)
      }
    }, 2000)
}

/**
 * 服务启动时恢复排期：还没到点的重新装上定时器，停机期间已经错过的如实标记为没发出去。
 *
 * 为什么必须有：定时器只活在进程内存里，服务一停（dev 重启、升级、崩溃后拉起）就全丢，
 * 而记录仍停在「已排期」。不恢复的话用户排好的期**永远不会发布**——界面上看着排好了，
 * 到点什么都没有，这比没有排期更坏。
 *
 * 错过的**绝不补发**：排期是用户对某一个时刻的指令，时刻过了就不该再替他发出去
 * （与「未经明确发布指令绝不自动发布」同一条红线）。所以只如实标记失败，让用户看见并自行决定。
 *
 * @param d - 产品依赖。
 * @returns 恢复的条数与标记为错过的条数，供启动日志留痕。
 */
export function resumeScheduledPublishes(d: Deps): { resumed: number, missed: number } {
  const now = Date.now()
  let resumed = 0
  let missed = 0
  for (const rec of d.store.files.records.load()) {
    if (rec.status !== PUBLISH_RECORD_STATUS.SCHEDULED) continue
    const at = Date.parse(rec.publishTime)
    if (!Number.isFinite(at)) continue
    if (at <= now) {
      failRecord(d, rec.id, '排期时刻已过（' + new Date(at).toLocaleString('zh-CN') + '），这条没有发出去：服务当时没有运行，错过的排期不会自动补发')
      missed += 1
      continue
    }
    schedulePublish(d, rec.id, rec.publishTime)
    resumed += 1
  }
  return { resumed, missed }
}

/**
 * 破坏性操作前的快照：把账号/发布记录/统计/分组复制到 backups/pre-<原因>-<时间戳>/。
 *
 * 账号删除会级联清空发布记录与统计，误删后没有回滚点就只能重扫登录；
 * 备份失败不阻塞业务操作（与安全加固的备份轮转同一目录，便于统一查找）。
 *
 * @param dataRoot - 产品数据根。
 * @param reason - 触发原因（用于目录命名，便于事后判断）。
 */
function backupBeforeDestructive(dataRoot: string, reason: string): void {
  try {
    const stamp = nowIso().replace(/[:.]/g, '-')
    const dir = join(dataRoot, 'backups', 'pre-' + reason + '-' + stamp)
    mkdirSync(dir, { recursive: true })
    for (const name of ['accounts.json', 'publish-records.json', 'metrics.json', 'account-groups.json']) {
      const from = join(dataRoot, name)
      if (existsSync(from)) copyFileSync(from, join(dir, name))
    }
  }
  catch {
    // 快照失败不阻塞删除：用户仍然能完成自己的操作。
  }
}

/**
 * 平台侧判定登录失效时，把账号标记为"需重新登录"。
 *
 * 发布失败此前只写进发布记录的错误行，账号页仍显示"在线"——用户看到的是一片正常，
 * 只有翻发布记录才知道要重扫。这里与平台同步路径共用 loginState/loginNote 字段，
 * 账号页随即显示需要重新授权。
 *
 * @param d - 产品依赖（数据根与存储）。
 * @param accountId - 失败发布对应的账号 id。
 * @param message - 平台返回的失败原因。
 */
function markAccountLoginInvalid(d: Deps, accountId: string | undefined, message: string): void {
  if (accountId === undefined || accountId === '')
    return
  if (!/登录已失效|登录失效|未登录|重新扫码|请重新登录|登录过期/i.test(message))
    return
  const accounts = d.store.files.accounts.load()
  const account = accounts.find(a => a.id === accountId)
  if (account === undefined)
    return
  // 证据分级：硬证据（引擎明确报凭据问题）立即确认，软证据要连续两次——
  // 见 platform-login.ts 的 confirmLoginInvalid（发布与同步两条路径共用同一口径）。
  if (!confirmLoginInvalid(account, message)) {
    d.store.files.accounts.save(accounts)
    return
  }
  account.loginState = 'invalid'
  account.loginCheckedAt = nowIso()
  d.store.files.accounts.save(accounts)
}

/**
 * 改发布记录状态。
 *
 * @param d - 依赖集合。
 * @param recordId - 记录 id 或 taskId。
 * @param status - 目标状态。
 * @returns 是否命中记录；false 表示这条任务不存在，调用方必须如实报错而不是回成功。
 */
function setRecordStatus(d: Deps, recordId: string, status: PublishRecordStatus): boolean {
  const records = d.store.files.records.load()
  const rec = records.find(r => (r.id === recordId || r.taskId === recordId))
  if (rec === undefined) return false
  rec.status = status
  if (status === PUBLISH_RECORD_STATUS.CANCELED) rec.errorMsg = '已取消'
  rec.updatedAt = nowIso()
  d.store.files.records.save(records)
  return true
}

function readString(body: unknown, key: string): string {
  const value = (body as Record<string, unknown>)?.[key]
  return typeof value === 'string' ? value : ''
}

function writeFailRaw(res: import('node:http').ServerResponse, message: string, code: number): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ code, data: null, message }))
}
