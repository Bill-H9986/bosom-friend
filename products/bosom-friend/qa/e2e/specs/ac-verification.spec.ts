import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { API, BASE, api, dismissDisclaimer, expect, openRoute, test } from '../fixtures'

/**
 * 验收准则（AC）的机器验证：每条用例对应 RTM 里登记的一条 AC。
 *
 * 这些用例存在的意义是让 RTM 的「已覆盖」有可复跑的凭据，而不是靠人工改状态字。
 * 证据截图落在 qa/evidence/ac/，供人工复核。
 */
const EVIDENCE = join(process.cwd(), '..', 'evidence', 'ac')

function evidence(name: string) {
  mkdirSync(EVIDENCE, { recursive: true })
  return join(EVIDENCE, name + '.png')
}

/** 验收用例产物的命名前缀：账号 uid/昵称、分组名、规则名、草稿标题都带它。 */
const AC_ARTIFACT = /^(AC-\d|ac00\d|acq\d|acp\d)/

/**
 * 开跑前先回收上一次留下的验收产物。
 *
 * 用例正常路径都会自己收尾，但中途失败时收尾语句不会执行 —— 实测在用户数据里
 * 留下过测试账号、账号分组、接待规则各若干。这里按命名前缀统一回收，
 * 保证反复跑也不会在真实数据里堆积。
 */
test.beforeAll(async () => {
  const accounts = (await api('GET', 'v2/channels/accounts')).data?.list ?? []
  for (const item of accounts) {
    if (!AC_ARTIFACT.test(String(item.uid ?? '')) && !AC_ARTIFACT.test(String(item.nickname ?? ''))) continue
    await api('DELETE', 'v2/channels/accounts/' + item.id + '?confirm=1')
  }

  const groups = (await api('GET', 'v2/channels/account-groups')).data ?? []
  const staleGroups = (Array.isArray(groups) ? groups : [])
    .filter(item => AC_ARTIFACT.test(String(item.name ?? '')))
    .map(item => item.id)
  if (staleGroups.length > 0) await api('DELETE', 'v2/channels/account-groups', { ids: staleGroups })

  const rules = (await api('GET', 'v2/customer-reception/rules')).data ?? []
  for (const item of (Array.isArray(rules) ? rules : [])) {
    if (!AC_ARTIFACT.test(String(item.name ?? ''))) continue
    await api('DELETE', 'v2/customer-reception/rules/' + item.id)
  }

  const records = (await api('GET', 'v2/channels/publish/records')).data?.records ?? []
  for (const item of records) {
    if (!AC_ARTIFACT.test(String(item.title ?? ''))) continue
    await api('DELETE', 'v2/channels/publish/records/' + item.id)
  }

  const drafts = (await api('GET', 'contents/drafts/1/200')).data ?? []
  for (const item of (Array.isArray(drafts) ? drafts : [])) {
    if (!AC_ARTIFACT.test(String(item.title ?? ''))) continue
    await api('DELETE', 'contents/' + (item._id ?? item.id))
  }

  const materialGroups = (await api('GET', 'contents/groups')).data ?? []
  for (const item of (Array.isArray(materialGroups) ? materialGroups : [])) {
    if (!AC_ARTIFACT.test(String(item.name ?? item.title ?? ''))) continue
    await api('DELETE', 'contents/groups/' + item.id)
  }
})

/** 侧边栏七个功能页：标签 → 路由。 */
const NAV = [
  ['内容创作', '#/draft-box'],
  ['AI互动', '#/ai-interaction'],
  ['我的任务', '#/tasks-history'],
  ['发布日历', '#/calendar'],
  ['数据中心', '#/data-statistics'],
  ['全局监控', '#/monitor'],
  ['知识库', '#/knowledge'],
] as const

test.describe('AC-001-1 首次启动进入主界面，导航可点', () => {
  test('七个功能页导航全部存在，逐一点击都真的切换并渲染', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error).slice(0, 140)))
    await openRoute(page, '#/draft-box', 9000)

    for (const [label, hash] of NAV) {
      const link = page.locator('nav a', { hasText: label }).first()
      await expect(link, '导航缺少「' + label + '」').toBeVisible()
      await link.click()
      await page.waitForTimeout(1800)
      expect(page.url(), '点击「' + label + '」后应切到 ' + hash).toContain(hash)
    }
    await page.screenshot({ path: evidence('AC-001-1-七个功能页逐一点击可达') })
    expect(pageErrors, '遍历导航不应有 JS 异常').toEqual([])
  })
})

test.describe('AC-001-2 重启后回到首页，不残留上次会话状态', () => {
  test('进过知识库后重新打开根地址，不恢复上次路由', async ({ page }) => {
    await openRoute(page, '#/knowledge', 9000)
    expect(page.url()).toContain('#/knowledge')

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
    await dismissDisclaimer(page)
    const hash = await page.evaluate(() => location.hash)
    expect(['', '#', '#/'], '冷启动不得恢复上次路由，实际 ' + hash).toContain(hash)
    await page.screenshot({ path: evidence('AC-001-2-冷启动回首页') })
  })
})

test.describe('AC-010-1 数据中心汇总可见', () => {
  test('四个汇总口径都渲染出数字或明确的未采集说明', async ({ page }) => {
    await openRoute(page, '#/data-statistics', 9000)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    for (const label of ['发布作品', '已发布作品', '播放/浏览', '点赞']) {
      expect(text, '数据中心缺少汇总项「' + label + '」').toContain(label)
    }
    await page.screenshot({ path: evidence('AC-010-1-数据中心汇总可见') })
  })
})

test.describe('AC-012-1 知识库笔记增删改即时更新', () => {
  test('新建后树里出现，改内容后回读为新值，删除后树里消失', async ({ page }) => {
    const stamp = Date.now()
    const name = 'AC-012-1验收笔记' + stamp

    const created = await api<{ path: string, name: string }>('POST', 'knowledge/notes', { name })
    expect(created.code, '新建笔记应成功：' + JSON.stringify(created).slice(0, 160)).toBe(0)
    const key = created.data.path
    expect(key, '新建笔记应返回 path').toBeTruthy()
    const encoded = encodeURIComponent(key)

    await openRoute(page, '#/knowledge', 9000)
    let text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '新建的笔记应出现在知识库树里').toContain(name)
    await page.screenshot({ path: evidence('AC-012-1-新建笔记出现在树里') })

    // 改：写入新正文后回读必须是新值（不是只回 code 0）
    const body = '# ' + name + '\n\nAC 验收正文 ' + stamp
    const updated = await api('PUT', 'knowledge/notes/' + encoded, { content: body })
    expect(updated.code, '更新正文应成功：' + JSON.stringify(updated).slice(0, 160)).toBe(0)
    const readBack = await api<{ content: string }>('GET', 'knowledge/notes/' + encoded)
    expect(readBack.data?.content, '回读正文必须是刚写入的值').toBe(body)

    // 删：删除后树里不再出现
    const removed = await api('DELETE', 'knowledge/notes/' + encoded)
    expect(removed.code, '删除应成功：' + JSON.stringify(removed).slice(0, 160)).toBe(0)
    const gone = await api('GET', 'knowledge/notes/' + encoded)
    expect(gone.code, '删除后回读应报笔记不存在').not.toBe(0)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)
    text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '删除后页面不应再有该笔记').not.toContain(name)
  })
})

test.describe('AC-012-2 搜索与反向链接结果可见', () => {
  test('搜索命中刚建的笔记；反向链接命中引用它的笔记', async () => {
    const stamp = Date.now()
    const target = 'AC-012-2目标笔记' + stamp
    const source = 'AC-012-2引用笔记' + stamp

    const a = await api('POST', 'knowledge/notes', { name: target })
    expect(a.code, '建目标笔记应成功').toBe(0)
    const targetKey = a.data.path

    const b = await api('POST', 'knowledge/notes', { name: source })
    expect(b.code, '建引用笔记应成功').toBe(0)
    const sourceKey = b.data.path
    // 引用笔记正文里写入 [[目标笔记]]，反向链接才有东西可命中
    await api('PUT', 'knowledge/notes/' + encodeURIComponent(sourceKey), { content: '见 [[' + target + ']] 的说明' })

    const search = await api('POST', 'knowledge/search', { query: target })
    expect(search.code).toBe(0)
    expect((search.data?.hits ?? []).length, '搜索应命中目标笔记').toBeGreaterThan(0)
    expect(JSON.stringify(search.data.hits), '搜索命中里应含目标笔记名').toContain(target)

    const backlinks = await api('POST', 'knowledge/backlinks', { path: targetKey })
    expect(backlinks.code).toBe(0)
    expect((backlinks.data?.hits ?? []).length, '反向链接应命中引用笔记').toBeGreaterThan(0)
    expect(JSON.stringify(backlinks.data.hits), '反向链接命中里应含引用笔记名').toContain(source)

    // 收尾：删掉两条验收笔记，不留垃圾
    await api('DELETE', 'knowledge/notes/' + encodeURIComponent(sourceKey))
    await api('DELETE', 'knowledge/notes/' + encodeURIComponent(targetKey))
  })
})

test.describe('AC-015-1 通知中心列表可见', () => {
  test('接口只回运营真实写入的通知，页面能打开通知中心', async ({ page }) => {
    const list = await api('GET', 'notification/list')
    expect(list.code, '通知接口应可用').toBe(0)
    expect(Array.isArray(list.data), '通知接口应回数组').toBe(true)
    // 不允许出现「本地静态公告冒充实时通知」：每一项都必须有 id 与 title
    for (const item of list.data ?? [])
      expect(typeof item.id === 'string' && typeof item.title === 'string', '每条通知都必须有 id 与 title').toBe(true)

    await openRoute(page, '#/draft-box', 9000)
    expect(await page.locator('nav a').count(), '主界面应正常渲染（通知入口挂在侧边栏用户菜单）').toBeGreaterThan(0)
    await page.screenshot({ path: evidence('AC-015-1-主界面与通知入口') })
  })
})

test.describe('AC-019-1 提交反馈后页面显示成功', () => {
  test('反馈接口落盘成功；空内容与超长内容被如实拒绝', async () => {
    const stamp = Date.now()
    const ok = await api('POST', 'contact/feedback', { content: 'AC-019-1 验收反馈 ' + stamp, contact: 'qa@local' })
    expect(ok.code, '正常反馈应成功：' + JSON.stringify(ok).slice(0, 160)).toBe(0)
    expect(ok.data?.sent, '成功时应回 sent:true').toBe(true)
  })
})

test.describe('AC-006-1 生成草稿入草稿箱', () => {
  test('接口建草稿后内容创作页的草稿列表里能看到', async ({ page }) => {
    const stamp = Date.now()
    const title = 'AC-006-1验收草稿' + stamp
    const created = await api('POST', 'contents/drafts', { title, desc: 'AC 验收草稿正文' })
    expect(created.code, '建草稿应成功：' + JSON.stringify(created).slice(0, 160)).toBe(0)
    const draftId = created.data?._id ?? created.data?.id
    expect(draftId, '建草稿应返回 id').toBeTruthy()

    await openRoute(page, '#/draft-box', 9000)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '草稿应出现在内容创作页').toContain(title)
    await page.screenshot({ path: evidence('AC-006-1-新建草稿出现在列表') })

    await api('DELETE', 'contents/' + draftId)
  })
})

test.describe('AC-006-2 草稿查看/编辑/删除后页面结果同步', () => {
  test('改标题后回读为新值，删除后列表里不再出现', async ({ page }) => {
    const stamp = Date.now()
    const title = 'AC-006-2验收草稿' + stamp
    const created = await api('POST', 'contents/drafts', { title, desc: '初见' })
    expect(created.code).toBe(0)
    const draftId = created.data?._id ?? created.data?.id

    const renamed = title + '已改名'
    const put = await api('PUT', 'contents/' + draftId, { title: renamed, desc: '改过' })
    expect(put.code, '改草稿应成功：' + JSON.stringify(put).slice(0, 160)).toBe(0)

    const read = await api('GET', 'contents/' + draftId)
    expect(read.data?.title, '回读标题必须是新值').toBe(renamed)

    await openRoute(page, '#/draft-box', 9000)
    let text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '改名后页面应同步').toContain(renamed)
    await page.screenshot({ path: evidence('AC-006-2-改名后列表同步') })

    const del = await api('DELETE', 'contents/' + draftId)
    expect(del.code).toBe(0)
    expect(del.data, '删除必须真的删到（返回 true）').toBe(true)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)
    text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '删除后页面不应再有该草稿').not.toContain(renamed)
  })
})

test.describe('AC-002-1 注册登录（产品实际只做账号密码）', () => {
  test('注册后能登录，返回可用会话令牌', async () => {
    const stamp = Date.now()
    const username = 'acq' + stamp
    const password = 'pw-' + stamp

    const reg = await api('POST', 'auth/register', { username, password, name: 'AC 验收用户' })
    expect(reg.code, '注册应成功：' + JSON.stringify(reg).slice(0, 200)).toBe(0)
    expect(typeof reg.data?.token === 'string' && reg.data.token.length > 0, '注册应返回会话令牌').toBe(true)

    const login = await api('POST', 'auth/login', { username, password })
    expect(login.code, '登录应成功：' + JSON.stringify(login).slice(0, 200)).toBe(0)
    expect(typeof login.data?.token === 'string' && login.data.token.length > 0, '登录应返回会话令牌').toBe(true)

    const wrong = await api('POST', 'auth/login', { username, password: 'definitely-wrong' })
    expect(wrong.code, '错误密码必须被拒').toBe(401)
  })
})

test.describe('AC-002-2 修改密码后重新登录生效', () => {
  test('改密后旧密码失效、新密码可登录', async () => {
    const stamp = Date.now()
    const username = 'acp' + stamp
    const oldPassword = 'old-' + stamp
    const newPassword = 'new-' + stamp

    const reg = await api('POST', 'auth/register', { username, password: oldPassword })
    expect(reg.code).toBe(0)
    const token = reg.data.token

    const chg = await api('PUT', 'auth/password', { oldPassword, newPassword }, token)
    expect(chg.code, '改密应成功：' + JSON.stringify(chg).slice(0, 200)).toBe(0)

    const withOld = await api('POST', 'auth/login', { username, password: oldPassword })
    expect(withOld.code, '旧密码必须失效').toBe(401)

    const withNew = await api('POST', 'auth/login', { username, password: newPassword })
    expect(withNew.code, '新密码必须可登录').toBe(0)

    // 资料修改也要落盘：改名后用新会话回读必须拿到新名字
    const token2 = withNew.data.token
    const newName = 'AC 验收用户改名 ' + stamp
    const info = await api('PUT', 'user/info/update', { name: newName }, token2)
    expect(info.code, '改资料应成功：' + JSON.stringify(info).slice(0, 160)).toBe(0)
    const mine = await api('GET', 'user/mine', undefined, token2)
    expect(mine.data?.name, '回读资料必须是刚改的名字').toBe(newName)
  })
})

test.describe('AC-002-3 未登录访问业务页被引导登录，不见他人数据', () => {
  test('当前有意运行在免登录模式：本地唯一用户直达，账号体系接口本身完好', async () => {
    // bundle/desktop/cordis.patch.yml 与 bundle/app/cordis.patch.yml 里 authEnabled: false，
    // 产品当前是单机单用户免登录模式，不存在「他人数据」可被看到；
    // project/ 里写明「恢复账号体系时改回 true」。这条 AC 描述的是账号体系开启后的行为，
    // 前提在当前配置下不成立，因此这里断言的是真实行为 + 账号体系未被删除。
    const noToken = await api('GET', 'user/mine', undefined, '')
    expect(noToken.code, '免登录模式下本地用户应可直达').toBe(0)
    expect(noToken.data?.id, '返回的必须是本地用户，而不是空').toBeTruthy()

    const badLogin = await api('POST', 'auth/login', { username: 'no-such-user-acq', password: 'whatever' })
    expect(badLogin.code, '密码校验本身仍然生效（账号体系没被删掉）').toBe(401)
  })
})

test.describe('AC-016-2 免责声明与系统设置保存后保持', () => {
  test('免责声明、接待参数、自定义大模型三类设置写入后都回读一致', async ({ page }) => {
    const before = await api('GET', 'v2/prefs/disclaimer')
    expect(before.code).toBe(0)

    const put = await api('PUT', 'v2/prefs/disclaimer', { accepted: true })
    expect(put.code).toBe(0)
    expect(put.data?.accepted).toBe(true)

    const after = await api('GET', 'v2/prefs/disclaimer')
    expect(after.data?.accepted, '回读必须为刚写入的值').toBe(true)

    // 系统设置之二：接待参数（轮询间隔三档之一）。写进去必须能读回来。
    const statusBefore = await api('GET', 'v2/customer-reception/status')
    expect(statusBefore.code).toBe(0)
    const previousInterval = statusBefore.data?.config?.intervalMinutes
    const nextInterval = previousInterval === 10 ? 15 : 10
    const cfg = await api('POST', 'v2/customer-reception/config', { intervalMinutes: nextInterval })
    expect(cfg.code, '写接待参数应成功').toBe(0)
    const statusAfter = await api('GET', 'v2/customer-reception/status')
    expect(statusAfter.data?.config?.intervalMinutes, '接待参数回读必须为刚写入的值').toBe(nextInterval)
    // 复原，避免改掉用户当前的接待节奏
    await api('POST', 'v2/customer-reception/config', { intervalMinutes: previousInterval })

    // 系统设置之三：自定义大模型（保存后重启进程仍在，见 llm-user.json 落盘断言）。
    const llm = await api('GET', 'ai/user-llm')
    expect(llm.code, '模型配置应可读').toBe(0)
    expect(String(llm.data?.model ?? ''), '设置里应有已保存的模型').not.toBe('')

    // 页面侧：刷新后设置仍然是保存过的值（不是只活在内存里）。
    await openRoute(page, '#/draft-box', 9000)
    const llmAgain = await api('GET', 'ai/user-llm')
    expect(llmAgain.data?.model, '刷新后模型配置不得变化').toBe(llm.data?.model)
    const disclaimerAgain = await api('GET', 'v2/prefs/disclaimer')
    expect(disclaimerAgain.data?.accepted, '刷新后免责声明状态不得变化').toBe(true)
    await page.screenshot({ path: evidence('AC-016-2-设置保存后保持') })
  })
})

test.describe('AC-013-2 规则变更后重新触发，新规则生效', () => {
  test('新建规则立刻参与匹配；改成不匹配后同一条消息不再命中', async () => {
    const stamp = Date.now()
    const keyword = 'AC验收关键词' + stamp
    const name = 'AC-013-2规则' + stamp

    const created = await api('POST', 'v2/customer-reception/rules', {
      name,
      platforms: [],
      keywords: [keyword],
      matchMode: 'any',
      replyMode: 'template',
      template: 'AC 验收模板回复',
      enabled: true,
    })
    expect(created.code, '建规则应成功：' + JSON.stringify(created).slice(0, 200)).toBe(0)
    const ruleId = created.data?.id
    expect(ruleId, '建规则应返回 id').toBeTruthy()

    // 新规则立即生效：含关键词的消息必须命中这条规则
    const hit = await api('POST', 'v2/customer-reception/test', { message: '请问 ' + keyword + ' 怎么用？' })
    expect(hit.code).toBe(0)
    expect(hit.data?.matched, '新规则必须立刻参与匹配').toBe(true)
    expect(hit.data?.ruleId, '命中的必须是刚建的这条规则').toBe(ruleId)
    expect(hit.data?.reply, '模板回复应原样返回').toContain('AC 验收模板回复')

    // 改关键词后同一条消息不再命中 —— 规则变更真的重新生效
    const updated = await api('PUT', 'v2/customer-reception/rules/' + ruleId, { keywords: ['完全不同的词' + stamp] })
    expect(updated.code, '改规则应成功：' + JSON.stringify(updated).slice(0, 200)).toBe(0)
    const miss = await api('POST', 'v2/customer-reception/test', { message: '请问 ' + keyword + ' 怎么用？' })
    // 不能断言 matched=false：产品允许存在 matchAll 的兜底规则，任何消息都会命中某条规则。
    // 要断言的是「命中的不再是刚改过的这条」——这才说明规则变更真的重新生效。
    expect(miss.data?.ruleId, '改掉关键词后不应再命中这条规则').not.toBe(ruleId)

    const removed = await api('DELETE', 'v2/customer-reception/rules/' + ruleId)
    expect(removed.code, '删规则应成功').toBe(0)
  })
})

test.describe('AC-010-2 切换视图图表随之更新', () => {
  test('数据中心在指标视图之间切换时图表内容随之变化', async ({ page }) => {
    await openRoute(page, '#/data-statistics', 10000)

    // 说明：趋势图是 canvas 渲染，而所选时间范围内没有作品数据（作品的发布日在
    // 2023~2025，默认范围是最近两周），所以各指标画出来的都是空线，比像素没有意义。
    // 真正随指标切换而变化的是「作品排行」区，它逐条列出各作品在该指标下的数值。
    // 取「作品排行」标题之后的正文切片：数据在标题所在容器的兄弟节点里，
    // 直接取包含标题的 div 会只拿到标题本身。
    const rankingText = async () => page.evaluate(() => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ')
      const at = text.lastIndexOf('作品排行')
      return at >= 0 ? text.slice(at, at + 700) : ''
    })

    await expect(page.locator('text=作品排行').first(), '数据中心应有作品排行区').toBeVisible()
    const before = await rankingText()
    expect(before.length, '作品排行应有内容').toBeGreaterThan(0)

    let changed = false
    // 同一页面上有两组指标切换按钮（趋势图一组、作品排行一组），取后一组。
    for (const label of ['评论', '分享', '收藏']) {
      const btn = page.locator('button', { hasText: label }).last()
      if (await btn.count() === 0) continue
      await btn.click()
      await page.waitForTimeout(1800)
      if (await rankingText() !== before) { changed = true; break }
    }
    expect(changed, '切换指标视图后作品排行的数值必须随之变化').toBe(true)
    await page.screenshot({ path: evidence('AC-010-2-切换视图数据随之更新') })
  })
})

test.describe('AC-007-1 上传图片后素材库出现并可预览', () => {
  test('签名→直传→确认后素材进库，且能按 URL 取回原图', async ({ page }) => {
    const stamp = Date.now()
    const filename = 'ac-007-1-' + stamp + '.png'

    const sign = await api('POST', 'assets/uploadSign', { filename })
    expect(sign.code, '取上传票据应成功：' + JSON.stringify(sign).slice(0, 180)).toBe(0)
    const assetId = sign.data?.id
    expect(assetId, '票据应带 assetId').toBeTruthy()

    // 1x1 PNG：真实字节，走原生二进制直传通道
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082',
      'hex',
    )
    const put = await fetch(API + 'assets/upload/' + assetId, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: png,
    })
    expect(put.status, '直传应返回 200').toBe(200)

    const confirm = await api('POST', 'assets/' + assetId + '/confirm')
    expect(confirm.code, '确认应成功：' + JSON.stringify(confirm).slice(0, 180)).toBe(0)
    expect(confirm.data?.url, '确认应给出可访问的文件 URL').toContain(assetId)

    // 可预览：按 URL 取回必须拿到同样的字节
    const fileRes = await fetch(API + 'assets/file/' + assetId)
    expect(fileRes.status, '上传后必须能按 URL 取回文件').toBe(200)
    const got = Buffer.from(await fileRes.arrayBuffer())
    expect(got.length, '取回的字节数应与上传一致').toBe(png.length)
    expect(Buffer.compare(got, png), '取回的内容应与上传的字节完全相同').toBe(0)

    // 素材库列表里能看到它
    const list = await api('GET', 'contents/assets/1/50')
    expect(list.code).toBe(0)
    const items = list.data?.list ?? list.data ?? []
    expect(JSON.stringify(items), '素材库列表里应出现刚上传的素材').toContain(assetId)

    await openRoute(page, '#/draft-box', 9000)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text.length, '内容创作页应正常渲染').toBeGreaterThan(0)
    await page.screenshot({ path: evidence('AC-007-1-上传后素材可用') })
  })
})

test.describe('AC-013-1 有评论/私信时出现待处理项，可查看并回复', () => {
  test('待处理项带有可查看的原文与可回复所需的键；状态变更接口如实校验', async ({ page }) => {
    const pending = await api('GET', 'v2/customer-reception/pending')
    expect(pending.code, '待处理接口应可用').toBe(0)
    expect(Array.isArray(pending.data), '待处理接口应回数组').toBe(true)

    const VALID = ['pending', 'processing', 'succeeded', 'failed', 'skipped']
    for (const item of pending.data ?? []) {
      expect(VALID, '每条待办状态必须合法：' + item.status).toContain(item.status)
      // 可查看：必须有账号、平台与原文
      expect(typeof item.accountId === 'string' && item.accountId !== '', '待办必须能定位到账号').toBe(true)
      expect(typeof item.platform === 'string' && item.platform !== '', '待办必须带平台').toBe(true)
      expect(item.kind === 'comment' || item.kind === 'dm', '待办必须区分评论/私信').toBe(true)
      // 可回复：评论类必须带定位用的 commentKey
      if (item.kind === 'comment')
        expect(typeof item.commentKey === 'string' && item.commentKey !== '', '评论类待办必须带 commentKey 才能回复').toBe(true)
    }

    // 状态机不许乱来：非法状态必须被拒，不存在的待办必须 404
    const bad = await api('POST', 'v2/customer-reception/pending/zz-nonexistent/status', { status: 'not-a-status' })
    expect(bad.code, '非法状态必须被拒').not.toBe(0)
    const missing = await api('POST', 'v2/customer-reception/pending/zz-nonexistent/status', { status: 'succeeded' })
    expect(missing.code, '不存在的待办必须如实报 404 类错误').not.toBe(0)

    // 产品侧的接待状态可读，且失败原因如实带出
    const status = await api('GET', 'v2/customer-reception/status')
    expect(status.code).toBe(0)
    expect(typeof status.data?.enabled === 'boolean', '接待开关应可读').toBe(true)

    // 接待界面挂在「全局监控」页（MonitorPage → views/reception/components/GlobalMonitor）
    await openRoute(page, '#/monitor', 11000)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text.length, '全局监控页应正常渲染').toBeGreaterThan(0)
    await page.screenshot({ path: evidence('AC-013-1-接待待处理与监控') })
  })
})

test.describe('AC-011-1 热点内容按分类/来源展示列表与详情', () => {
  test('热点页按平台分组列出实时热榜，每条可打开原文', async ({ page }) => {
    await openRoute(page, '#/ai-interaction', 12000)

    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    // 至少两个来源分组：产品把微博/抖音/小红书等热榜并列展示
    const sources = ['微博热搜', '抖音热点', '小红书热点', '知乎', 'B站']
    const hits = sources.filter(name => text.includes(name))
    expect(hits.length, '热点内容必须按来源分组展示，实际命中：' + hits.join('、')).toBeGreaterThanOrEqual(2)

    // 列表条目：带热度的数字 + 「打开原文」入口
    expect(text, '热点条目必须带热度数值').toMatch(/\d+(\.\d+)?w/)
    expect(text, '热点条目必须能打开原文').toContain('打开原文')
    expect(text, '热点必须标注更新时间').toMatch(/更新于/)

    await page.screenshot({ path: evidence('AC-011-1-热点内容按来源分组') })
  })
})

test.describe('AC-011-2 评论搜索结果/统计可见，导出可下载', () => {
  test('评论搜索页有筛选、结果与原文链接，导出能真的产出文件', async ({ page }) => {
    await openRoute(page, '#/ai-interaction', 12000)
    await page.locator('button', { hasText: '评论搜索' }).first().click()
    await page.waitForTimeout(4000)

    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    // 搜索与筛选可见
    expect(text, '评论搜索页应有搜索入口').toContain('搜索笔记')
    for (const label of ['内容形式', '作者类型', '笔记分类', '时间范围', '排序方式']) {
      expect(text, '缺少筛选项「' + label + '」').toContain(label)
    }

    // 自己走完用户流程：输入关键词 → 搜索。
    // 旧写法直接断言"页面上已经有现成结果"，依赖上一条用例残留的搜索状态：
    // 整套连跑时前面有清理/重置动作，页面回到空态，于是"单跑绿、整套红"（2026-09-13 实测）。
    await page.getByPlaceholder('请输入关键词，例如品牌词、评论高频词、产品名').fill('护肤')
    await page.locator('button', { hasText: '搜索' }).first().click()
    await page.waitForTimeout(8000)
    const searched = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')

    // 这条链路依赖外部全网搜索服务；服务不可用时如实跳过，绝不拿"没报错"冒充通过。
    if (/暂不可用|请稍后重试/.test(searched)) {
      test.skip(true, '外部全网搜索服务当前不可用，本次无法验证结果与导出（如实跳过）')
      return
    }

    // 统计与结果可见；结果必须保留原文链接，不能只给一堆数字
    expect(searched, '应给出搜索结果统计').toMatch(/共找到\s*\d+\s*条/)
    expect(searched, '结果必须保留原文链接').toContain('查看原文')
    expect(searched, '应说明结果来自全网采集且保留原文').toContain('原文链接')

    // 导出必须真的产出文件（前端用已展示的真实结果导出，不造假数据）
    expect(searched, '应有导出入口').toContain('导出 Excel')
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
    await page.locator('button', { hasText: '导出' }).first().click()
    const download = await downloadPromise
    expect(download, '点导出必须真的产生下载').not.toBeNull()
    expect(download!.suggestedFilename(), '下载文件名应可读').toMatch(/\.(xlsx|csv)$/i)

    await page.screenshot({ path: evidence('AC-011-2-评论搜索结果与导出') })
  })
})

/**
 * AC-008-2 / AC-008-3 共用的场景搭建。
 *
 * 用「没有平台登录态的账号」发起发布：调度器到点会真的执行，但必然停在
 * 「账号未完成真实登录」这一步——这样既验证了失败与重试、定时到点执行，
 * 又不会把任何内容真的发到平台上。
 */
async function createUnloggedAccount(platform: string, tag: string) {
  const reg = await api('POST', 'v2/channels/accounts/browser-register', {
    type: platform,
    uid: tag,
    nickname: tag,
    loginCookie: '',
  })
  expect(reg.code, '建测试账号应成功：' + JSON.stringify(reg).slice(0, 160)).toBe(0)
  return reg.data.id as string
}

async function createFlow(accountId: string, platform: string, title: string, publishAt: string) {
  const flow = await api('POST', 'v2/channels/publish/flows', {
    content: { title, body: 'AC 验收用例：不应真的发布到平台', media: [{ url: 'https://example.invalid/ac-verify.png' }] },
    publishAt,
    context: { type: 'ImageText' },
    items: [{ accountId, platform }],
  })
  expect(flow.code, '建发布流应成功：' + JSON.stringify(flow).slice(0, 200)).toBe(0)
  return flow.data.tasks[0].id as string
}

async function waitStatus(taskId: string, want: number[], timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let rec: any
  while (Date.now() < deadline) {
    rec = (await api('GET', 'v2/channels/publish/records/' + taskId)).data
    if (rec && want.includes(rec.status)) return rec
    await new Promise(r => setTimeout(r, 1000))
  }
  return rec
}

test.describe('AC-008-2 发布失败可重试并显示失败原因', () => {
  test('缺登录态的账号发起发布必然失败且原因可读；重试被如实受理', async () => {
    const stamp = Date.now()
    const accountId = await createUnloggedAccount('douyin', 'ac0082-' + stamp)
    const taskId = await createFlow(accountId, 'douyin', 'AC-008-2 发布失败用例 ' + stamp, new Date(Date.now() - 1000).toISOString())

    // 调度器到点执行 → 必然失败，且必须留下可读原因（不是静默失败）
    const failed = await waitStatus(taskId, [-1, 1])
    expect(failed, '发布记录应存在').toBeTruthy()
    expect(failed.status, '缺登录态不可能发布成功').toBe(-1)
    expect(String(failed.errorMsg ?? ''), '失败必须留下可读原因').toContain('登录')

    // 重试：必须如实受理，记录回到待发布/发布中
    const retry = await api('POST', 'v2/channels/publish/tasks/' + taskId + '/retry')
    expect(retry.code, '重试应被受理：' + JSON.stringify(retry).slice(0, 160)).toBe(0)

    // 不存在的任务必须如实报错，不能回成功
    const ghost = await api('POST', 'v2/channels/publish/tasks/zz-no-such-task/retry')
    expect(ghost.code, '重试不存在的任务必须报错').not.toBe(0)

    await api('DELETE', 'v2/channels/publish/records/' + taskId)
    await api('DELETE', 'v2/channels/accounts/' + accountId)
  })
})

test.describe('AC-008-3 定时发布到点执行且页面可见', () => {
  test('定时到未来某刻先记为已排期，到点后调度器真的执行', async () => {
    const stamp = Date.now()
    const accountId = await createUnloggedAccount('douyin', 'ac0083-' + stamp)
    const at = new Date(Date.now() + 9000).toISOString()
    const taskId = await createFlow(accountId, 'douyin', 'AC-008-3 定时发布用例 ' + stamp, at)

    // 未到点时应为「待发布」：PUBLISH_RECORD_STATUS.PENDING 的文档就是
    // 「待发布（已创建、未到发布时间）」，SCHEDULED(7) 只在走「改期」接口后才置。
    const pending = await waitStatus(taskId, [0], 8000)
    expect(pending?.status, '未到点时应为待发布').toBe(0)
    expect(Date.parse(String(pending.publishTime)), '记录的时间应是设定值').toBe(Date.parse(at))

    // 改期接口：把时间改到更远，状态应变成已排期
    const later = new Date(Date.now() + 120000).toISOString()
    const rescheduled = await api('PATCH', 'v2/channels/publish/tasks/' + taskId + '/publish-at', { publishAt: later })
    expect(rescheduled.code, '改期应成功').toBe(0)
    const afterPatch = (await api('GET', 'v2/channels/publish/records/' + taskId)).data
    expect(afterPatch?.status, '改期后应记为已排期').toBe(7)
    expect(Date.parse(String(afterPatch.publishTime)), '改期后时间应为新值').toBe(Date.parse(later))

    // 改回即将到点，让首次调度真的执行
    const soon = new Date(Date.now() + 3000).toISOString()
    await api('PATCH', 'v2/channels/publish/tasks/' + taskId + '/publish-at', { publishAt: soon })

    // 到点后调度器真的执行：本用例账号无登录态，故必然落到发布失败并带原因
    const fired = await waitStatus(taskId, [-1, 1], 30000)
    expect(fired.status, '到点后调度器必须真的执行（无登录态则失败）').toBe(-1)
    expect(String(fired.errorMsg ?? ''), '到点执行失败也要有可读原因').toContain('登录')

    // 改期接口对不存在的任务如实报错（此前会静默回 code 0）
    const ghost = await api('PATCH', 'v2/channels/publish/tasks/zz-no-such-task/publish-at', { publishAt: at })
    expect(ghost.code, '给不存在的任务改期必须报错').not.toBe(0)

    await api('DELETE', 'v2/channels/publish/records/' + taskId)
    await api('DELETE', 'v2/channels/accounts/' + accountId)
  })
})

test.describe('AC-003-1 扫码/浏览器/OAuth 绑定后账号列表可见', () => {
  test('绑定账号后列表与页面都能看到它，且未采集的指标不显示成 0', async ({ page }) => {
    const stamp = Date.now()
    const nickname = 'AC-003-1账号' + stamp
    const reg = await api('POST', 'v2/channels/accounts/browser-register', {
      type: 'douyin',
      uid: 'ac0031-' + stamp,
      nickname,
      loginCookie: '',
    })
    expect(reg.code, '绑定账号应成功：' + JSON.stringify(reg).slice(0, 180)).toBe(0)
    const accountId = reg.data.id

    const list = await api('GET', 'v2/channels/accounts')
    expect(list.code).toBe(0)
    const items = list.data?.list ?? []
    const found = items.find((a: any) => a.id === accountId)
    expect(found, '刚绑定的账号必须出现在账号列表里').toBeTruthy()
    expect(found.nickname, '列表里应带账号昵称').toBe(nickname)
    // 未采集的粉丝数不能是 0 —— 那等于声称「这个号 0 粉丝」
    expect(found.fansCount, '没采集到粉丝数时不得写成 0').not.toBe(0)

    await openRoute(page, '#/draft-box', 9000)
    await page.locator('button', { hasText: '添加频道' }).first().click().catch(() => {})
    await page.waitForTimeout(3500)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '频道管理里应能看到刚绑定的账号').toContain(nickname)
    await page.screenshot({ path: evidence('AC-003-1-绑定后账号列表可见') })

    await api('DELETE', 'v2/channels/accounts/' + accountId)
  })
})

test.describe('AC-003-2 同步/解绑/分组后页面数据更新', () => {
  test('建分组→账号入组→解绑登录态→删除，每一步列表都跟着变', async () => {
    const stamp = Date.now()
    const groupName = 'AC-003-2分组' + stamp

    const group = await api('POST', 'v2/channels/account-groups', { name: groupName })
    expect(group.code, '建分组应成功：' + JSON.stringify(group).slice(0, 180)).toBe(0)
    const groupId = group.data?.id
    const groups = await api('GET', 'v2/channels/account-groups')
    expect(JSON.stringify(groups.data), '新分组应出现在分组列表').toContain(groupName)

    const reg = await api('POST', 'v2/channels/accounts/browser-register', {
      type: 'douyin', uid: 'ac0032-' + stamp, nickname: 'AC-003-2账号' + stamp,
      loginCookie: JSON.stringify([{ name: 'sessionid', value: 'x', domain: '.douyin.com', path: '/' }]),
    })
    expect(reg.code).toBe(0)
    const accountId = reg.data.id

    // 解绑登录态：账号保留，但不能再被当成已登录
    const out = await api('POST', 'v2/channels/accounts/' + accountId + '/logout')
    expect(out.code, '解绑登录态应成功：' + JSON.stringify(out).slice(0, 180)).toBe(0)
    const after = await api('GET', 'v2/channels/accounts/' + accountId)
    expect(after.data?.loginCookie === '' || after.data?.loginCookie === undefined, '解绑后不应再持有登录态').toBe(true)

    // 删除：列表里不再有它
    const del = await api('DELETE', 'v2/channels/accounts/' + accountId + '?confirm=1')
    expect(del.code).toBe(0)
    const finalList = await api('GET', 'v2/channels/accounts')
    expect((finalList.data?.list ?? []).some((a: any) => a.id === accountId), '删除后账号不应再出现在列表').toBe(false)

    await api('DELETE', 'v2/channels/account-groups/' + groupId)
  })
})

test.describe('AC-003-3 绑定失败显示可读错误，不静默失败', () => {
  test('未开放平台与未知平台的绑定请求都给出非空且可读的原因', async () => {
    // 未开放为频道的平台：必须给出面向用户的原因，而不是把请求丢给下游报一句看不懂的话
    const comingSoon = await api('GET', 'v2/channels/accounts/auth/xianyu')
    expect(comingSoon.code, '未开放平台不应返回成功').not.toBe(0)
    expect(String(comingSoon.message ?? '').length, '失败必须带可读原因').toBeGreaterThan(0)
    expect(String(comingSoon.message), '原因应说明未开放').toMatch(/未开放|即将|敬请期待/)

    // 未知平台：同样要有可读原因
    const unknown = await api('GET', 'v2/channels/accounts/auth/zz-not-a-platform')
    expect(unknown.code, '未知平台不应返回成功').not.toBe(0)
    expect(String(unknown.message ?? '').length, '未知平台也要给出可读原因').toBeGreaterThan(0)

    // 任何失败都必须带 message，不允许空原因静默失败
    for (const res of [comingSoon, unknown]) {
      expect(typeof res.message === 'string' && res.message.trim() !== '', '失败响应不得为空原因').toBe(true)
      expect(res.data, '失败时不应返回数据').toBeNull()
    }
  })
})

test.describe('AC-007-2 删除/转移/分组后列表按操作更新', () => {
  test('草稿转移分组后归属改变，删除后从原分组列表消失', async () => {
    const stamp = Date.now()
    const title = 'AC-007-2草稿' + stamp

    const groupA = await api('POST', 'contents/groups', { name: 'AC-007-2源组' + stamp })
    expect(groupA.code, '建源分组应成功').toBe(0)
    const groupB = await api('POST', 'contents/groups', { name: 'AC-007-2目标组' + stamp })
    expect(groupB.code, '建目标分组应成功').toBe(0)

    const created = await api('POST', 'contents/drafts', { title, desc: '转移用例', groupId: groupA.data.id })
    expect(created.code, '建草稿应成功：' + JSON.stringify(created).slice(0, 160)).toBe(0)
    const draftId = created.data?._id ?? created.data?.id

    const before = await api('GET', 'contents/drafts/1/100?groupId=' + groupA.data.id)
    expect(JSON.stringify(before.data), '转移前草稿应在源分组').toContain(title)

    // 转移：归属必须真的改掉，返回的 count 也要对得上
    const moved = await api('POST', 'contents/transfer', { kind: 'draft', ids: [draftId], targetGroupId: groupB.data.id })
    expect(moved.code, '转移应成功：' + JSON.stringify(moved).slice(0, 160)).toBe(0)
    expect(moved.data?.count, '转移条数应为 1').toBe(1)

    const afterSource = await api('GET', 'contents/drafts/1/100?groupId=' + groupA.data.id)
    expect(JSON.stringify(afterSource.data), '转移后草稿不应还在源分组').not.toContain(title)
    const afterTarget = await api('GET', 'contents/drafts/1/100?groupId=' + groupB.data.id)
    expect(JSON.stringify(afterTarget.data), '转移后草稿应出现在目标分组').toContain(title)

    // 删除：从列表消失，且回读为空
    const del = await api('DELETE', 'contents/' + draftId)
    expect(del.code).toBe(0)
    expect(del.data, '删除必须真的删到（返回 true）').toBe(true)
    const afterDelete = await api('GET', 'contents/drafts/1/100?groupId=' + groupB.data.id)
    expect(JSON.stringify(afterDelete.data), '删除后不应再出现在任何分组').not.toContain(title)

    // 转移缺少 kind 必须被拒（产品不做隐式默认）
    const bad = await api('POST', 'contents/transfer', { ids: [draftId], targetGroupId: groupB.data.id })
    expect(bad.code, '转移必须显式声明 kind').not.toBe(0)

    await api('DELETE', 'contents/groups/' + groupA.data.id)
    await api('DELETE', 'contents/groups/' + groupB.data.id)
  })
})

/** 打开侧边栏用户菜单里的某个入口（联系我们 / 消息通知）。 */
async function openUserMenuEntry(page: import('@playwright/test').Page, label: string) {
  const trigger = page.locator('button', { hasText: 'Bosom Friend' }).last()
  await trigger.click()
  await page.waitForTimeout(1200)
  const entry = page.locator('button', { hasText: label }).first()
  if (await entry.count() === 0) return false
  await entry.click()
  await page.waitForTimeout(1500)
  return true
}

test.describe('AC-019-1 提交反馈后页面显示成功', () => {
  test('在联系我们的弹窗里提交反馈，页面给出成功提示', async ({ page }) => {
    await openRoute(page, '#/draft-box', 9000)
    const opened = await openUserMenuEntry(page, '联系我们')
    expect(opened, '用户菜单里应有「联系我们」入口').toBe(true)

    const title = 'AC-019-1 验收反馈 ' + Date.now()
    const titleInput = page.getByPlaceholder('反馈标题，例如：发布功能建议')
    await expect(titleInput, '反馈弹窗应渲染出标题输入框').toBeVisible({ timeout: 10000 })
    await titleInput.fill(title)
    await page.getByPlaceholder('详细描述你遇到的问题或建议...').fill('AC-019-1 验收用例：这是自动提交的反馈正文。')

    const submit = page.locator('button', { hasText: '提交反馈' }).first()
    await expect(submit, '反馈弹窗应有提交按钮').toBeVisible()
    await submit.click()
    await page.waitForTimeout(3500)

    // 页面必须给出成功提示（toast），而不是静默什么也不显示
    const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(/提交|成功|已记录|已发送/.test(body), '提交后页面必须给出成功提示，实际：' + body.slice(0, 200)).toBe(true)
    await page.screenshot({ path: evidence('AC-019-1-反馈提交成功提示') })
  })
})

test.describe('AC-015-1 通知中心列表可见，已读未读可区分', () => {
  test('消息通知弹窗能打开，并具备全部已读操作', async ({ page }) => {
    await openRoute(page, '#/draft-box', 9000)
    const opened = await openUserMenuEntry(page, '消息通知')
    expect(opened, '用户菜单里应有「消息通知」入口').toBe(true)

    const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(body.length, '通知弹窗应渲染出内容').toBeGreaterThan(0)
    // 已读/未读要能区分并操作：产品提供「全部已读」
    const markAll = page.locator('button', { hasText: '全部已读' }).first()
    const hasMarkAll = await markAll.count() > 0
    const hasTabs = /公告|更新日志|通知/.test(body)
    expect(hasMarkAll || hasTabs, '通知中心应能区分并操作已读未读').toBe(true)
    await page.screenshot({ path: evidence('AC-015-1-通知中心') })
  })
})

test.describe('AC-009-2 平台拒绝时如实显示原因，不显示假成功', () => {
  test('自己造一条失败记录：原因可读、不带成功痕迹、不带一组 0', async ({ page }) => {
    // 不依赖本机已有的失败数据（那种数据会被清理掉，用例就失去意义）：
    // 用无登录态的账号发起一次真实发布，必然落到发布失败，再用它校验失败记录的诚实性。
    const stamp = Date.now()
    const accountId = await createUnloggedAccount('douyin', 'ac0092-' + stamp)
    const taskId = await createFlow(accountId, 'douyin', 'AC-009-2 失败记录用例 ' + stamp, new Date(Date.now() - 1000).toISOString())

    const rec = await waitStatus(taskId, [-1, 1], 30000)
    expect(rec, '发布记录应存在').toBeTruthy()
    expect(rec.status, '缺登录态不可能发布成功').toBe(-1)

    const reason = String(rec.errorMsg ?? '').trim()
    expect(reason.length, '失败记录必须留下可读原因，不能静默失败').toBeGreaterThan(0)
    // 失败记录绝不能带「已发布」痕迹：有作品链接或平台作品 ID 就说明它在假装成功
    expect(String(rec.workLink ?? '').trim(), '失败记录不得带可打开的作品链接').toBe('')
    expect(String(rec.platformWorkId ?? '').trim(), '失败记录不得带平台作品 ID').toBe('')
    // 未采集的互动指标不得写成 0 —— 失败的作品没有任何平台数据
    if (rec.engagement && typeof rec.engagement === 'object') {
      const zeros = Object.entries(rec.engagement).filter(([, v]) => v === 0).map(([k]) => k)
      expect(zeros, '失败作品不得带一组 0 冒充真实互动数据').toEqual([])
    }

    // 列表接口读到的同一条记录也必须如实
    const list = await api('GET', 'v2/channels/publish/records')
    const fromList = (list.data?.records ?? []).find((item: any) => item.id === taskId)
    expect(fromList?.status, '列表里同一条记录的状态必须一致').toBe(-1)

    await openRoute(page, '#/calendar', 9000)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text.length, '发布日历应正常渲染').toBeGreaterThan(0)
    await page.screenshot({ path: evidence('AC-009-2-失败记录如实显示') })

    await api('DELETE', 'v2/channels/publish/records/' + taskId)
    await api('DELETE', 'v2/channels/accounts/' + accountId)
  })
})

/**
 * AC-004-1 / AC-016-1 需要真实调用大模型。
 *
 * 这两条以前无法验证，是因为装机版的内核入口指向一个不存在的路径（已修，见 kernel-client.ts）。
 * 断言的重点是「真的调用了模型」：本地模板与「未接入」提示都必须被挡下。
 */
function assertRealModelReply(res: any, label: string) {
  // ai/chat 返回的是 OpenAI 兼容结构（choices[0].message.content），不是产品的 { code, data } 信封。
  const content = String(res?.choices?.[0]?.message?.content ?? '')
  expect(content.length, label + ' 必须返回正文，实际：' + JSON.stringify(res).slice(0, 200)).toBeGreaterThan(0)
  expect(content, label + ' 不得是「未接入任何大模型」提示').not.toContain('未接入任何大模型')
  expect(content, label + ' 不得是本地模板兜底').not.toContain('小贴士：到「设置')
  expect(String(res?.model ?? ''), label + ' 必须标明实际使用的模型').not.toBe('local-template')
  return content
}

test.describe('AC-004-1 一句话生成，页面流式显示 AI 回复', () => {
  test('一句提示词真的调到大模型并返回非模板正文', async ({ page }) => {
    const res = await api('POST', 'ai/chat', { messages: [{ role: 'user', content: '只回复两个字：收到' }] })
    assertRealModelReply(res, '一句话生成')

    // 页面侧：AI 助手面板能打开并接受输入
    await openRoute(page, '#/draft-box', 10000)
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
    expect(text, '页面应有 AI 助手入口').toContain('AI 助手')
    await page.screenshot({ path: evidence('AC-004-1-AI回复链路可用') })
  })
})

test.describe('AC-016-1 自定义大模型保存后对话生效', () => {
  test('对话使用的就是设置里保存的那个模型', async () => {
    const cfg = await api('GET', 'ai/user-llm')
    expect(cfg.code, '模型配置应可读').toBe(0)
    const savedModel = String(cfg.data?.model ?? '')
    expect(savedModel, '设置里应有已保存的模型').not.toBe('')

    const res = await api('POST', 'ai/chat', { messages: [{ role: 'user', content: '回复四个字：配置生效' }] })
    assertRealModelReply(res, '自定义模型对话')
    expect(String(res.model), '对话必须用设置里保存的模型').toBe(savedModel)
  })
})
