import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { JsonFile } from '../../src/store.ts'
import { buildObjectActionPrompt, findObjectAction, looksLikeMetaReply, normalizeNote, normalizeTitle, normalizeTopics } from '../../src/object-actions.ts'

/**
 * 对象自带的 AI 动作：点一次按钮，结果**写回那条对象**（ADR-004 S2）。
 *
 * 为什么锁这一条：这是飞书那一侧"字段捷径"的全部价值——数据自己会动，人不用把数据搬进对话框。
 * 判据不能是"接口回了 code:0"，而必须是**落盘的那条记录真的变了**；
 * 反过来，三种情况下**一个字都不许改**：动作不认识、对象不存在、模型没给出可用内容
 * （用空值覆盖用户已有的内容，比失败更糟）。
 */

/** 这一轮"模型"会回什么；用例逐条改它。 */
let reply = '这是模型给的新标题'
/** 每一次真正送进内核的提示词（要验"事实到没到模型"时看它）。 */
const prompts: string[] = []

vi.mock('../../src/kernel-client.ts', async () => ({
  ...(({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (prompt: string, onDelta?: (text: string) => void) => {
      prompts.push(prompt)
      if (reply !== '') onDelta?.(reply)
      return { text: reply }
    },
    close: async () => {},
  }),
}))

let h: Harness

/** 建一条草稿，返回它的 id。 */
async function createDraft(title: string, desc: string): Promise<string> {
  const res = await h.call<{ _id?: string, id?: string }>('POST', 'contents/drafts', {
    body: { groupId: 'mg-persist', title, desc, mediaList: [] },
  })
  expect(res.code, '草稿必须建得出来').toBe(0)
  return String(res.data?._id ?? res.data?.id ?? '')
}

/** 读回落盘的那条草稿。 */
async function readDraft(id: string): Promise<{ title?: string, desc?: string, topics?: string[], aiCompliance?: string }> {
  const res = await h.call<{ title?: string, desc?: string } | null>('GET', 'contents/' + id)
  expect(res.data, '草稿必须读得回来').not.toBeNull()
  return res.data ?? {}
}

beforeAll(async () => {
  h = createHarness()
  await h.call('PUT', 'ai/user-llm', {
    body: {
      providers: [{ id: 'chat', displayName: '对话网关', baseUrl: 'https://chat.example.com/v1', apiKey: 'sk-chat-probe', models: ['chat-probe'] }],
      activeProviderId: 'chat',
    },
  })
})
afterAll(() => {
  h.dispose()
})

describe('动作清单由服务端给，界面不写死', () => {
  it('草稿上的动作清单由服务端给，界面照单渲染', async () => {
    const res = await h.call<{ list: Array<{ id: string, label: string, field: string }> }>('GET', 'ai/object-actions', { query: { kind: 'draft' } })
    expect(res.code).toBe(0)
    expect(res.data.list.map(item => item.id)).toEqual(['draft-title', 'draft-body', 'draft-topics', 'draft-compliance', 'draft-illustration'])
    expect(res.data.list[0]!.label).toBe('AI 改标题')
    expect(res.data.list[2]!.field, '话题写的是列表字段').toBe('topics')
    expect(res.data.list[3]!.label, '合规检查是"给判断"，与三个"改内容"的动作并列').toBe('AI 合规检查')
    expect(res.data.list[4]!.label, '配图建议也是"给判断"').toBe('AI 配图建议')
  })
})

describe('对象级动作：结果真的写回那条对象', () => {
  it('AI 改标题后，落盘的标题就是模型给的那一条', async () => {
    const id = await createDraft('旧标题', '旧正文')
    reply = '夏日特调 3.0 上新'
    const res = await h.call<{ field: string, value: string, before: string }>('POST', 'ai/object-action', {
      body: { kind: 'draft', id, action: 'draft-title' },
    })
    expect(res.code).toBe(0)
    expect(res.data.field).toBe('title')
    expect(res.data.before, '旧值要一起回给界面，用户才知道改了什么').toBe('旧标题')
    expect((await readDraft(id)).title).toBe('夏日特调 3.0 上新')
    expect((await readDraft(id)).desc, '只动被点的那个字段').toBe('旧正文')
  })

  it('模型爱加的外壳（Markdown 记号、字段前缀、引号）不会一起落库', async () => {
    const id = await createDraft('旧标题', '旧正文')
    reply = '# 标题： "夏日特调" '
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    expect((await readDraft(id)).title).toBe('夏日特调')
  })

  it('AI 生成话题写回的是**数组字段**，标题与正文都不动', async () => {
    const id = await createDraft('夏日特调', '三种在家就能做的夏日特调')
    reply = '- #夏日特调\n- #居家饮品\n- #低卡饮品'
    const res = await h.call<{ field: string, value: string | string[] }>('POST', 'ai/object-action', {
      body: { kind: 'draft', id, action: 'draft-topics' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.field).toBe('topics')
    expect(Array.isArray(res.data.value), '回给界面的就是数组，前端直接渲染话题').toBe(true)
    const after = await readDraft(id)
    expect(after.topics).toEqual(['夏日特调', '居家饮品', '低卡饮品'])
    expect(after.title).toBe('夏日特调')
    expect(after.desc).toBe('三种在家就能做的夏日特调')
  })

  it('整理不出话题时**一条都不写**，已有话题不会被清空', async () => {
    const id = await createDraft('夏日特调', '三种在家就能做的夏日特调')
    reply = '- #夏日特调\n- #居家饮品'
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-topics' } })
    const before = await readDraft(id)
    expect(before.topics).toEqual(['夏日特调', '居家饮品'])
    // 模型这次只回了一个碎片：整理出来是空数组，绝不能拿它去覆盖已经写好的一串话题。
    reply = '好'
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-topics' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('没有给出可用的内容')
    expect((await readDraft(id)).topics, '一次跑偏不该把用户已有的话题清掉').toEqual(['夏日特调', '居家饮品'])
  })

  it('配图建议看得到素材库里有什么（库里空着就直说，不假装挑图）', async () => {
    const id = await createDraft('夏日特调', '三种在家就能做的夏日特调')
    // 库里空着时：事实要明说"空"，模型才有机会写"需要补拍几张"。
    prompts.length = 0
    reply = '需要 3 张图：① 三种饮品摆在一起…（素材库现在是空的，需要补拍 3 张）'
    const empty = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-illustration' } })
    expect(empty.code).toBe(0)
    expect(prompts.join('\n')).toContain('素材库现在是空的')

    // 库里放两张：事实要把它们**点名**，模型才挑得出来。
    const after = new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/contents.json', () => []).load()
    new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/contents.json', () => []).save([
      ...after,
      { kind: 'asset', _id: 'asset-a', type: 'img', title: '成品俯拍', url: '/x/a.png' },
      { kind: 'asset', _id: 'asset-b', type: 'img', title: '材料平铺', url: '/x/b.png' },
    ])
    prompts.length = 0
    reply = '需要 3 张图：① 用素材库里的「成品俯拍」做封面…② 用「材料平铺」…③ 补拍一张倒进杯子的瞬间。'
    const withLibrary = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-illustration' } })
    expect(withLibrary.code, String(withLibrary.message)).toBe(0)
    const prompt = prompts.join('\n')
    expect(prompt).toContain('素材库里可用：图片 2 张')
    expect(prompt, '要点名，模型才挑得出来').toContain('成品俯拍')
    expect(prompt).toContain('材料平铺')
    // 没命名的素材要标成"未命名"：把 id 当名字给模型，它会拿 id 当描述（真机实测过一次）。
    const unnamed = new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/contents.json', () => []).load()
    new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/contents.json', () => []).save([
      ...unnamed,
      { kind: 'asset', _id: 'asset-zzz', type: 'img', title: 'asset-zzz', url: '/x/z.png' },
    ])
    prompts.length = 0
    reply = '需要 2 张图：用「成品俯拍」做封面，另一张补拍。'
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-illustration' } })
    const withUnnamed = prompts.join('\n')
    expect(withUnnamed).toContain('（未命名 asset-zzz）')
    expect(withUnnamed).not.toContain('、asset-zzz、')
  })

  it('配图建议把结论写回草稿，正文与标题一个字都不改', async () => {
    const id = await createDraft('夏日特调', '三种做法')
    reply = '需要 3 张图：① 成品俯拍做封面；② 材料平铺；③ 倒进杯子的瞬间。'
    const res = await h.call<{ field: string, value: string }>('POST', 'ai/object-action', {
      body: { kind: 'draft', id, action: 'draft-illustration' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.field).toBe('aiIllustration')
    const draft = await readDraft(id) as { title?: string, desc?: string, aiIllustration?: string }
    expect(String(draft.aiIllustration)).toContain('封面')
    expect(draft.title).toBe('夏日特调')
    expect(draft.desc).toBe('三种做法')
  })

  it('合规检查把结论写回草稿，正文与标题一个字都不改', async () => {
    const id = await createDraft('最好用的减肥神器', '七天包瘦，第一')
    reply = '发现 2 处：\n1. 标题里的「最好用」「第一」属于绝对化用语，平台会拒 —— 改成「夏天很顺口的一款」。\n2. 正文「七天包瘦」是功效承诺 —— 删掉，改写成做法本身。'
    const res = await h.call<{ field: string, value: string }>('POST', 'ai/object-action', {
      body: { kind: 'draft', id, action: 'draft-compliance' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.field).toBe('aiCompliance')
    const after = await readDraft(id) as { title?: string, desc?: string, aiCompliance?: string }
    expect(String(after.aiCompliance)).toContain('绝对化用语')
    expect(after.title, '合规检查不改内容').toBe('最好用的减肥神器')
    expect(after.desc).toBe('七天包瘦，第一')
  })

  it('模型回的是"关于任务本身的话"时，一个字都不写', async () => {
    const id = await createDraft('原样保留的标题', '正文')
    // 真机实测出现过：模型回"我理解这是一个纯文本生成任务…不过您没有提供具体的创作需求"，
    // 而当时它是被当成配图建议**写进去**的。
    reply = '我理解这是一个纯文本生成任务，需要我为某个内容生成配图建议。不过我注意到您没有提供具体的创作需求或主题信息。'
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-illustration' } })
    expect(res.code, '不能报成功').not.toBe(0)
    expect(String(res.message)).toContain('关于任务本身')
    expect((await readDraft(id)).title, '对象一个字都不能动').toBe('原样保留的标题')
    const logged = new JsonFile<Array<{ kind: string }>>(h.dataRoot + '/ai-logs.json', () => []).load()
    expect(logged.some(item => item.kind === 'object_action_meta_reply'), '拦下来也要留痕，方便复盘').toBe(true)
  })

  it('正常内容不会被误判成元回应', () => {
    // 口径刻意收窄：内容里出现"我理解"这类词不该被拦。
    expect(looksLikeMetaReply('需要 3 张图：① 用素材库里的「成品俯拍」做封面；② 补拍倒进杯子的瞬间。')).toBe(false)
    expect(looksLikeMetaReply('我理解的用户是刚入行的运营：这条内容要讲清"把一件小事重复做对"。')).toBe(false)
    expect(looksLikeMetaReply('抱歉，我无法访问平台后台，所以这条数据拿不到。')).toBe(true)
  })

  it('优化正文改的是 desc，标题原样不动', async () => {
    const id = await createDraft('标题别动', '旧正文')
    reply = '第一段。\n\n第二段。'
    await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-body' } })
    const after = await readDraft(id)
    expect(after.desc).toContain('第二段')
    expect(after.title).toBe('标题别动')
  })
})

describe('三种情况下一个字都不许改', () => {
  it('动作不认识就如实拒绝', async () => {
    const id = await createDraft('别动我', '正文')
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-delete-everything' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('没有这个动作')
    expect((await readDraft(id)).title).toBe('别动我')
  })

  it('对象不存在就如实报不存在', async () => {
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id: 'no-such-draft', action: 'draft-title' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('不存在')
  })

  it('模型没给出可用内容时不许用空值覆盖', async () => {
    const id = await createDraft('原始标题', '原始正文')
    reply = ''
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id, action: 'draft-title' } })
    expect(res.code).not.toBe(0)
    expect((await readDraft(id)).title, '失败不能把用户的标题清空').toBe('原始标题')
  })
})

describe('提示词与整理规则', () => {
  it('草稿动作必须看得到"不是自己要改的那个字段"', () => {
    const record = { title: '夏日特调三种做法', desc: '三种在家就能做的夏日特调', topics: [] }
    // 生成话题：第一次跑时 current 是空的，标题与正文就是全部的输入。
    const topics = findObjectAction('draft', 'draft-topics')!
    const topicsPrompt = buildObjectActionPrompt(topics, topics.current(record), '', topics.context?.(record) ?? '')
    expect(topicsPrompt).toContain('标题：夏日特调三种做法')
    expect(topicsPrompt).toContain('正文：三种在家就能做的夏日特调')
    // 没有这两行时，模型拿到的是"被要求读标题与正文、而标题与正文没给"——
    // 线上真实回的是「理解，我将直接输出内容而不使用任何工具。」
    expect(buildObjectActionPrompt(topics, topics.current(record), '', '')).not.toContain('夏日特调三种做法')
    // 改标题要看得到正文、改正文要看得到标题：否则标题与正文会对不上。
    const title = findObjectAction('draft', 'draft-title')!
    expect(title.context?.(record)).toContain('正文：三种在家就能做的夏日特调')
    const body = findObjectAction('draft', 'draft-body')!
    expect(body.context?.(record)).toContain('标题：夏日特调三种做法')
  })

  it('合规检查核对的是产品数准的事实，模型不用自己数字数', () => {
    // 字数与数量由产品数准（模型自己数会数错）；措辞风险（绝对化用语、功效承诺）才由模型判断。
    const spec = findObjectAction('draft', 'draft-compliance')!
    const record = { title: '最好用的夏日特调', desc: '三种做法', topics: ['夏日特调', '居家饮品'], accountTypes: ['xhs'] }
    const facts = spec.context?.(record) ?? ''
    expect(facts).toContain('（8 字，上限 30）')
    // 正文要给**原文**：只给字数的话，模型查不出正文里的功效承诺与引流（真机实测漏报）。
    expect(facts, '检查要看得到正文本身，不是只有字数').toContain('正文：三种做法')
    expect(facts).toContain('话题 2 个（上限 8）：夏日特调、居家饮品')
    expect(facts).toContain('目标平台：xhs')
    // 没标题 / 没话题时如实写，不留空
    const bare = spec.context?.({ title: '', desc: '' }) ?? ''
    expect(bare).toContain('（无标题）')
    expect(bare).toContain('（无正文）')
    expect(bare).toContain('话题 0 个')
    expect(bare).toContain('未指定')
    // 长正文按上限截断，并如实说明"以上是前 N 字"，不假装看全了。
    const long = spec.context?.({ title: 't', desc: 'x'.repeat(900) }) ?? ''
    expect(long).toContain('以上为前 600 字')
    expect(long).toContain('正文共 900 字')
  })

  it('话题解析认得模型可能给的三种形态，且不把整句话当话题', () => {
    // Markdown 列表 + 井号
    expect(normalizeTopics('- #夏日特调\n- #居家饮品\n')).toEqual(['夏日特调', '居家饮品'])
    // 顿号连成一行 + 序号
    expect(normalizeTopics('1. 夏日特调、2. 居家饮品')).toEqual(['夏日特调', '居家饮品'])
    // JSON 数组
    expect(normalizeTopics('["夏日特调", "低卡饮品"]')).toEqual(['夏日特调', '低卡饮品'])
    // 围栏代码块
    expect(normalizeTopics('\u0060\u0060\u0060\n夏日特调\n低卡饮品\n\u0060\u0060\u0060')).toEqual(['夏日特调', '低卡饮品'])
    // 去重、丢碎片、丢整句（模型没按要求写时宁可少给，也不写一条谁也看不懂的"话题"）
    expect(normalizeTopics('夏日特调\n夏日特调\n好\n这一条话题其实是一整句解释，不该被当成话题写进去')).toEqual(['夏日特调'])
    // 上限：一条草稿要能同时投多个平台
    expect(normalizeTopics(Array.from({ length: 12 }, (_, i) => '话题' + String(i)).join('\n'))).toHaveLength(8)
  })

  it('复盘的事实里，没采到的指标写「平台未采集」而不是 0', () => {
    // 把"未采集"写成 0，模型会据此得出"这条没人看"的结论——那是编出来的事实，比不给更糟。
    const spec = findObjectAction('work', 'work-review')!
    const withData = { accountType: 'xhs', title: '夏日特调', publishTime: '2026-09-20T10:00:00.000Z', engagement: { viewCount: 1200, likeCount: 88 } }
    const facts = spec.context?.(withData) ?? ''
    expect(facts).toContain('平台：xhs')
    expect(facts).toContain('标题：夏日特调')
    expect(facts).toContain('播放量：1200')
    expect(facts).toContain('点赞数：88')
    expect(facts).toContain('评论数：平台未采集')
    const withoutData = spec.context?.({ accountType: 'xhs', title: '还没采到' }) ?? ''
    expect(withoutData).toContain('播放量：平台未采集')
    expect(withoutData).not.toContain('播放量：0')
  })

  it('每个动作自己声明时间戳落在哪个字段：没声明的不写', () => {
    // "对象上恰好有没有 updatedAt"是猜的，猜不中时那次写入静默不留时间——所以必须由规格声明。
    // 草稿有 updatedAt，账号的时间戳单独记，笔记两个都没有。
    expect(findObjectAction('draft', 'draft-title')!.stampField).toBe('updatedAt')
    expect(findObjectAction('draft', 'draft-body')!.stampField).toBe('updatedAt')
    expect(findObjectAction('account', 'account-positioning')!.stampField).toBe('aiPositioningAt')
    expect(findObjectAction('work', 'work-review')!.stampField).toBe('aiReviewAt')
    expect(findObjectAction('note', 'note-polish')!.stampField).toBeUndefined()
  })

  it('提示词把"对象事实"带进去：否则第一次做定位的账号对模型是个匿名对象', () => {
    const spec = findObjectAction('account', 'account-positioning')!
    const record = { type: 'xhs', nickname: '小A读书圈', fansCount: 1234 }
    const prompt = buildObjectActionPrompt(spec, '', '', spec.context?.(record) ?? '')
    expect(prompt).toContain('已知事实')
    expect(prompt).toContain('平台：xhs')
    expect(prompt).toContain('昵称：小A读书圈')
    expect(prompt).toContain('粉丝数：1234')
  })

  it('提示词把"素材"和"要求"分开，并要求只输出结果', () => {
    const spec = findObjectAction('draft', 'draft-title')!
    const prompt = buildObjectActionPrompt(spec, '旧标题', '要更年轻一点')
    expect(prompt).toContain('【要改的对象】')
    expect(prompt).toContain('旧标题')
    expect(prompt).toContain('【用户额外要求】')
    expect(prompt).toContain('要更年轻一点')
    expect(prompt).toContain('不要任何解释')
  })

  it('标题整理成单行并限长，避免写进一条发不出去的标题', () => {
    expect(normalizeTitle('第一行\n第二行')).toBe('第一行')
    expect(normalizeTitle('x'.repeat(80)).length).toBe(30)
  })

  it('笔记正文保留 Markdown 标题（那是内容，不是外壳）', () => {
    expect(normalizeNote('# 投放经验\n\n正文')).toBe('# 投放经验\n\n正文')
  })

  it('模型把整段包进代码块时剥掉围栏，里面的 Markdown 一字不动', () => {
    expect(normalizeNote('```markdown\n# 标题\n\n- 要点\n```')).toBe('# 标题\n\n- 要点')
  })
})

describe('第三种对象：账号也能被 AI 定位并写回', () => {
  /** 建一个账号并读回它（路由的返回形状不作为断言依据）。 */
  async function createAccount(nickname: string): Promise<{ id: string, nickname?: string }> {
    const created = await h.call('POST', 'v2/channels/accounts', { body: { type: 'xhs', uid: 'u-probe', nickname } })
    expect(created.code, '账号必须建得出来').toBe(0)
    const list = await h.call<{ list: Array<{ id: string, nickname?: string }> }>('GET', 'v2/channels/accounts')
    const found = list.data.list.find(item => item.nickname === nickname)
    expect(found, '新建的账号要能在列表里找到').toBeDefined()
    return found!
  }

  it('账号上有 AI 定位这个动作', async () => {
    const res = await h.call<{ list: Array<{ id: string, label: string, field: string }> }>('GET', 'ai/object-actions', { query: { kind: 'account' } })
    expect(res.code).toBe(0)
    expect(res.data.list.map(item => item.id)).toEqual(['account-positioning', 'account-risk'])
    expect(res.data.list[0]!.field).toBe('aiPositioning')
  })

  it('定位写回这个账号，昵称不动', async () => {
    const account = await createAccount('小A读书圈')
    reply = '给想读书又没时间的上班族：每天一本书的十分钟精读。'
    const res = await h.call<{ field: string, value: string }>('POST', 'ai/object-action', {
      body: { kind: 'account', id: account.id, action: 'account-positioning' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.field).toBe('aiPositioning')
    const list = await h.call<{ list: Array<{ id: string, nickname?: string, aiPositioning?: string }> }>('GET', 'v2/channels/accounts')
    const after = list.data.list.find(item => item.id === account.id)!
    expect(after.aiPositioning).toContain('十分钟精读')
    expect(after.nickname, '只动被点的那个字段').toBe('小A读书圈')
  })

  it('写定位会留下时间戳，且不碰账号自己的 updateTime', async () => {
    const account = await createAccount('留下时间戳的号')
    const before = await h.call<{ list: Array<{ id: string, updateTime?: string }> }>('GET', 'v2/channels/accounts')
    const updateTimeBefore = before.data.list.find(item => item.id === account.id)!.updateTime
    reply = '给刚入行的运营讲清一件事：把一件小事重复做对。'
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'account', id: account.id, action: 'account-positioning' } })
    expect(res.code, String(res.message)).toBe(0)
    const list = await h.call<{ list: Array<{ id: string, aiPositioningAt?: string, updateTime?: string }> }>('GET', 'v2/channels/accounts')
    const after = list.data.list.find(item => item.id === account.id)!
    expect(Number.isNaN(Date.parse(String(after.aiPositioningAt))), 'aiPositioningAt 必须是能解析的时间').toBe(false)
    expect(after.updateTime, '定位的时间不混进账号资料的更新时间').toBe(updateTimeBefore)
  })

  it('风险评估的事实里有登录态，也有这个号的发布失败史', async () => {
    // 失败史住在**别的文件**（发布记录）里，只有知道这条号住在哪的适配器拿得到——
    // 所以它是适配器给的事实，不是动作规格算出来的。
    const account = await createAccount('有失败史的号')
    const accountId = account.id
    for (let i = 0; i < 2; i += 1) {
      const before = new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/publish-records.json', () => []).load()
      new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/publish-records.json', () => []).save([
        ...before,
        {
          id: 'rec-fail-' + String(i),
          accountId,
          accountType: 'xhs',
          type: 'ImageText',
          status: 1,
          title: '发布失败的靶子',
          publishTime: '2026-09-20T10:00:00.000Z',
          errorMsg: i === 0 ? '平台返回"内容含违规词"' : '平台返回"发布频率过高"',
        },
      ])
    }
    prompts.length = 0
    reply = '风险等级：中\n依据：近期发布失败 2 次（最近一次：平台返回"内容含违规词"）；登录态未知。\n先做什么：先在平台里确认一次登录态，再把那条违规词改掉重发。'
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'account', id: accountId, action: 'account-risk' } })
    expect(res.code, String(res.message)).toBe(0)
    const prompt = prompts.join('\n')
    expect(prompt, '登录态要进事实').toContain('登录态：')
    expect(prompt, '失败史要进事实').toContain('失败 2 次')
    expect(prompt).toContain('内容含违规词')
  })

  it('风险评估把结论写回这条号，昵称与登录态一个都不动', async () => {
    const account = await createAccount('风险评估的号')
    reply = '风险等级：低\n依据：没有失败记录，登录态未知。\n先做什么：正常发布即可，发布后回来看一次数据。'
    const res = await h.call<{ field: string, value: string }>('POST', 'ai/object-action', {
      body: { kind: 'account', id: account.id, action: 'account-risk' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.field).toBe('aiRisk')
    const list = await h.call<{ list: Array<{ id: string, nickname?: string, aiRisk?: string, aiRiskAt?: string }> }>('GET', 'v2/channels/accounts')
    const after = list.data.list.find(item => item.id === account.id)!
    expect(String(after.aiRisk)).toContain('风险等级')
    expect(after.nickname, '只动被点的那个字段').toBe('风险评估的号')
    expect(Number.isNaN(Date.parse(String(after.aiRiskAt))), 'aiRiskAt 要落时间').toBe(false)
  })

  it('账号不存在时如实拒绝', async () => {
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'account', id: 'acc-nope', action: 'account-positioning' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('不存在')
  })
})

describe('第四种对象：发布记录也能被 AI 复盘并写回', () => {
  /** 种一条发布记录：发布记录由发布流程写入，测试里直接放一条最省事（与 dashboard-honesty 同一做法）。 */
  function seedRecord(record: Record<string, unknown>): void {
    const existing = new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/publish-records.json', () => []).load()
    new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/publish-records.json', () => []).save([...existing, record])
  }

  function readRecord(id: string): Record<string, unknown> {
    return new JsonFile<Record<string, unknown>[]>(h.dataRoot + '/publish-records.json', () => [])
      .load()
      .find(item => item.id === id)!
  }

  it('发布记录上有 AI 复盘这个动作', async () => {
    const res = await h.call<{ list: Array<{ id: string, label: string, field: string }> }>('GET', 'ai/object-actions', { query: { kind: 'work' } })
    expect(res.code).toBe(0)
    expect(res.data.list.map(item => item.id)).toEqual(['work-review'])
    expect(res.data.list[0]!.label).toBe('AI 复盘')
    expect(res.data.list[0]!.field).toBe('aiReview')
  })

  it('复盘写回这条记录，标题与互动数据不动', async () => {
    seedRecord({
      id: 'rec-review-1',
      accountType: 'xhs',
      type: 'ImageText',
      status: 1,
      title: '夏日特调',
      publishTime: '2026-09-20T10:00:00.000Z',
      platformWorkId: 'work-1',
      engagement: { viewCount: 1200, likeCount: 88, commentCount: 7 },
    })
    reply = '播放量 1200 属于中等偏上，点赞率 7% 偏高：标题给的是具体场景。下一条沿用具体场景，但把开头换成提问。'
    const res = await h.call<{ field: string, value: string }>('POST', 'ai/object-action', {
      body: { kind: 'work', id: 'rec-review-1', action: 'work-review' },
    })
    expect(res.code, String(res.message)).toBe(0)
    expect(res.data.field).toBe('aiReview')
    const after = readRecord('rec-review-1')
    expect(String(after.aiReview)).toContain('下一条沿用具体场景')
    expect(after.title, '只动被点的那个字段').toBe('夏日特调')
    expect((after.engagement as { viewCount?: number }).viewCount, '复盘不许改数据').toBe(1200)
    expect(Number.isNaN(Date.parse(String(after.aiReviewAt))), 'aiReviewAt 必须是能解析的时间').toBe(false)
  })

  it('记录不存在时如实拒绝，不新建一条', async () => {
    const before = new JsonFile<unknown[]>(h.dataRoot + '/publish-records.json', () => []).load().length
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'work', id: 'rec-nope', action: 'work-review' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('不存在')
    const after = new JsonFile<unknown[]>(h.dataRoot + '/publish-records.json', () => []).load().length
    expect(after).toBe(before)
  })

  it('复盘进了蒸馏账本：这条结论会成为下一次的上下文（回流）', async () => {
    seedRecord({
      id: 'rec-review-2', accountType: 'douyin', type: 'VIDEO', status: 1,
      title: '三条视频的封面实验', publishTime: '2026-09-21T10:00:00.000Z',
      engagement: { viewCount: 30 },
    })
    reply = '播放量 30 说明封面没有拦住人：下一条换人脸特写做封面，标题只留一个冲突点。'
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'work', id: 'rec-review-2', action: 'work-review' } })
    expect(res.code, String(res.message)).toBe(0)
    const knowledge = h.disk<{ distillations?: Array<{ sourceId?: string, instructionLabel?: string, output?: string, status?: string }> }>('knowledge.json')
    const sample = (knowledge.distillations ?? []).find(item => item.sourceId === 'object-action-work-rec-review-2-work-review')
    expect(sample, '每一次对象动作都要留样本，否则复盘读完就没了').toBeDefined()
    expect(sample!.instructionLabel, '技能名与目录用的是人话标签').toContain('AI 复盘')
    expect(String(sample!.output)).toContain('人脸特写')
    expect(sample!.status).toBe('success')
  })
})

describe('换一种对象：知识笔记也能被 AI 润色并写回', () => {
  /** 建一条笔记并写入初始正文，返回它的路径键。 */
  async function createNote(name: string, content: string): Promise<string> {
    const created = await h.call<{ path: string }>('POST', 'knowledge/notes', { body: { name } })
    expect(created.code, '笔记必须建得出来').toBe(0)
    const path = created.data.path
    const saved = await h.call('PUT', 'knowledge/notes/' + encodeURIComponent(path), { body: { content } })
    expect(saved.code, '正文必须写得进去').toBe(0)
    return path
  }

  it('笔记上有 AI 润色这个动作', async () => {
    const res = await h.call<{ list: Array<{ id: string, label: string, field: string }> }>('GET', 'ai/object-actions', { query: { kind: 'note' } })
    expect(res.code).toBe(0)
    expect(res.data.list.map(item => item.id)).toEqual(['note-polish'])
    expect(res.data.list[0]!.field).toBe('content')
  })

  it('润色后落盘的正文是模型给的那一条，笔记名不动', async () => {
    const path = await createNote('投放经验', '# 投放经验\n\n原始正文。')
    reply = '# 投放经验\n\n润色后的正文。'
    const res = await h.call<{ field: string, value: string, before: string }>('POST', 'ai/object-action', {
      body: { kind: 'note', id: path, action: 'note-polish' },
    })
    expect(res.code).toBe(0)
    expect(res.data.field).toBe('content')
    expect(res.data.before).toContain('原始正文')
    const after = await h.call<{ name: string, content: string }>('GET', 'knowledge/notes/' + encodeURIComponent(path))
    expect(after.data.content).toContain('润色后的正文')
    expect(after.data.name, '只动被点的那个字段').toBe('投放经验')
  })

  it('笔记不存在时如实拒绝，不新建一条', async () => {
    const res = await h.call('POST', 'ai/object-action', { body: { kind: 'note', id: '不存在的笔记.md', action: 'note-polish' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('不存在')
  })

  it('还不支持的对象种类与传错的动作名给的是两句不同的话', async () => {
    // publish 没有适配器：这句话要指向"这类对象"，而不是"这个对象"。
    const kind = await h.call('POST', 'ai/object-action', { body: { kind: 'publish', id: 'pub-1', action: 'account-positioning' } })
    expect(String(kind.message)).toContain('还不支持')
    const action = await h.call('POST', 'ai/object-action', { body: { kind: 'draft', id: 'dft-x', action: 'no-such-action' } })
    expect(String(action.message)).toContain('没有这个动作')
  })
})
