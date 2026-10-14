import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import {
  MAX_SKILLS,
  curateSkills,
  eligibleForSkill,
  normalizeProcedure,
  renderSkillFile,
  skillBaseName,
  skillFilesToKeep,
  skillName,
  skillSlug,
  SKILL_NAME_PATTERN,
  writeSkill,
} from '../../src/agent-skills.ts'

/**
 * 经验升格为技能（ADR-003 口径四）与 Curator 归档。
 *
 * 两个最容易写坏、又最不容易被界面发现的地方单独锁住：
 * ① **升格门槛**——把一次失败或用户明确不满意的产出固化成"以后照做的流程"，比不升格糟得多；
 * ② **归属**——技能根（`$DSH_HOME/skills`）是用户的空间，Curator 只能搬走**本应用写的**文件，
 *    否则它会把用户手写的技能当作"不在账本里"归档掉，那是数据丢失。
 */

let reply = '1. 先读需求\n2. 再写标题\n3. 最后核对字数'

vi.mock('../../src/kernel-client.ts', async () => ({
  ...(({ chatTranscript, replayFrames }) => ({ chatTranscript, replayFrames }))(
    await vi.importActual<typeof import('../../src/kernel-client.ts')>('../../src/kernel-client.ts'),
  ),
  createKernelClient: () => ({
    prompt: async (_prompt: string, onDelta?: (text: string) => void) => {
      if (reply !== '') onDelta?.(reply)
      return { text: reply }
    },
    close: async () => {},
  }),
}))

const homes: string[] = []
/** 一次性 DSH_HOME；用例结束统一删。 */
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bf-skills-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

describe('技能名与 slug：文件名要安全，一条样例对应一个文件', () => {
  it('只留 ASCII 小写与连字符；压不出 ASCII 时退回 skill', () => {
    // 官方 provider 的名字规则不接受非 ASCII，留汉字等于让整个技能被静默丢弃。
    expect(skillName('写一条小红书种草笔记！')).toBe('skill')
    expect(skillName('AI 改标题：夏日特调')).toBe('ai')
    expect(skillName('  a  b  ')).toBe('a-b')
    expect(skillName('！！！')).toBe('skill')
  })

  it('**生成的技能名必须满足官方 provider 的规则**（不满足会被静默丢弃）', () => {
    const samples = ['写一条小红书种草笔记', 'AI 改标题：夏日特调', 'x'.repeat(80), '！！！', 'Mixed 中英 Case!', 'a']
    for (const text of samples) {
      const slug = skillSlug('task-1', text)
      expect(SKILL_NAME_PATTERN.test(slug), '这个 slug 不合法：' + slug).toBe(true)
    }
  })

  it('同一条样例的 slug 稳定，不同样例即使指令相同也不会互相覆盖', () => {
    const first = skillSlug('task-a', '写一条小红书种草笔记')
    expect(skillSlug('task-a', '写一条小红书种草笔记')).toBe(first)
    expect(skillSlug('task-b', '写一条小红书种草笔记')).not.toBe(first)
  })

  it('技能名用人话标签，没有标签才回退到原始指令', () => {
    expect(skillBaseName({ instruction: '【要改的对象】字段：title\n\n【怎么改】…', instructionLabel: 'AI 改标题：夏日特调' }))
      .toBe('AI 改标题：夏日特调')
    // 旧样本没有标签：回退到指令（哪怕它不好看，也总比没有名字强）。
    expect(skillBaseName({ instruction: '写一条小红书种草笔记' })).toBe('写一条小红书种草笔记')
    // 标签是空串/空白时同样回退，不能产生一个空名字。
    expect(skillBaseName({ instruction: '写一条小红书种草笔记', instructionLabel: '   ' })).toBe('写一条小红书种草笔记')
  })

  it('技能文件带必填 frontmatter 与归属标记', () => {
    const text = renderSkillFile({ slug: 's', name: '种草笔记', description: '说明', whenToUse: '当用户要写笔记时', body: '1. 一步' })
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('name: "种草笔记"')
    expect(text).toContain('description: "说明"')
    expect(text).toContain('whenToUse: "当用户要写笔记时"')
    expect(text, '归属标记：Curator 靠它区分本应用的技能与用户手写的技能').toContain('managed-by: bosom-friend')
    expect(text).toContain('1. 一步')
  })
})

describe('升格门槛与 Curator 的取舍', () => {
  it('只有成功且评分达标才有资格', () => {
    expect(eligibleForSkill({ status: 'success', rating: 4, createdAt: 't' })).toBe(true)
    expect(eligibleForSkill({ status: 'success', rating: 3, createdAt: 't' })).toBe(false)
    expect(eligibleForSkill({ status: 'failed', rating: 5, createdAt: 't' })).toBe(false)
  })

  it('该保留的文件按评分与时间排序，超上限的丢掉，没升格过的不算', () => {
    const records = [
      { status: 'success', rating: 4, createdAt: 't1', skillPath: 'a.md' },
      { status: 'success', rating: 5, createdAt: 't0', skillPath: 'b.md' },
      { status: 'success', rating: 5, createdAt: 't9', skillPath: 'c.md' },
      { status: 'success', rating: 5, createdAt: 't8' },
      { status: 'failed', rating: 5, createdAt: 't9', skillPath: 'd.md' },
    ]
    expect(skillFilesToKeep(records)).toEqual(['c.md', 'b.md', 'a.md'])
    const many = Array.from({ length: MAX_SKILLS + 3 }, (_, index) => ({
      status: 'success',
      rating: 5,
      createdAt: 't' + String(1000 - index),
      skillPath: 's' + String(index) + '.md',
    }))
    expect(skillFilesToKeep(many)).toHaveLength(MAX_SKILLS)
  })

  it('Curator 只归档本应用写的技能，用户手写的原样留着', () => {
    const home = tempHome()
    writeSkill(home, { slug: 'ours', name: '我们的', description: 'd', whenToUse: 'w', body: 'body' })
    writeSync(join(home, 'skills', 'user-note.md'), '---\nname: "我自己写的"\ndescription: "d"\n---\n\n正文\n')
    const archived = curateSkills(home, [])
    expect(archived).toEqual(['ours.md'])
    expect(existsSync(join(home, 'skills', 'archive', 'ours.md'))).toBe(true)
    expect(existsSync(join(home, 'skills', 'user-note.md')), '用户手写的技能不该被搬走').toBe(true)
    expect(existsSync(join(home, 'skills', 'ours.md'))).toBe(false)
  })

  it('流程正文剥掉代码围栏并限长', () => {
    expect(normalizeProcedure('```markdown\n1. 一步\n```')).toBe('1. 一步')
    expect(normalizeProcedure('x'.repeat(9000)).length).toBe(4000)
  })
})

/** 同步写一个小文件（用例里造"用户手写的技能"用）。 */
function writeSync(file: string, content: string): void {
  writeFileSync(file, content, 'utf8')
}

describe('升格接口：成功且被认可的样例才能变成技能', () => {
  let h: Harness

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

  /** 账本里 task=chat 的样例 id 集合。 */
  async function chatSampleIds(): Promise<Set<string>> {
    const res = await h.call<{ list: Array<{ id: string }> }>('GET', 'knowledge/distill/dataset', { query: { task: 'chat' } })
    return new Set(res.data.list.map(item => item.id))
  }

  /**
   * 发一轮对话拿到一条账本样例，并按需评分，返回它的 sourceId。
   *
   * 为什么从账本里取而不是自己拼：助手对话的 sourceId 带一个内容寻址后缀
   * （同一任务的两轮各记一条），拼不出来——只能读回真正记下的那一条。
   */
  async function seedSample(rating: number): Promise<string> {
    const before = await chatSampleIds()
    await h.call('POST', 'agent/tasks', { body: { prompt: '帮我写一条小红书种草笔记', includePartialMessages: true } })
    const after = await h.call<{ list: Array<{ id: string, sourceId: string }> }>('GET', 'knowledge/distill/dataset', { query: { task: 'chat' } })
    const fresh = after.data.list.find(item => !before.has(item.id))
    expect(fresh, '这一轮对话要留下一条账本样例').toBeDefined()
    const rated = await h.call<{ ok: boolean }>('POST', 'knowledge/distill/rate', { body: { id: fresh!.id, rating } })
    expect(rated.data.ok, '评分要真的落到那条样例上').toBe(true)
    return fresh!.sourceId
  }

  it('打了 5 分的成功样例可以升格，技能文件落盘且账本留痕', async () => {
    const taskId = await seedSample(5)
    reply = '1. 先想清楚给谁看\n2. 再写标题\n3. 最后核对字数'
    const res = await h.call<{ path: string, name: string }>('POST', 'knowledge/distill/promote', { body: { sourceId: taskId } })
    expect(res.code, String(res.message)).toBe(0)
    const file = join(dirname(h.dataRoot), 'skills', res.data.path)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('先想清楚给谁看')
    // 账本留痕：技能目录是账本的投影，没有这一笔它下一次刷新就会被归档。
    const dataset = await h.call<{ list: Array<{ sourceId: string, skillPath?: string }> }>('GET', 'knowledge/distill/dataset', { query: { task: 'chat' } })
    expect(dataset.data.list.find(item => item.sourceId === taskId)?.skillPath).toBe(res.data.path)
  })

  it('没到 4 分的样例拒绝升格，也不写文件', async () => {
    const taskId = await seedSample(3)
    const before = readdirSync(join(dirname(h.dataRoot), 'skills')).length
    const res = await h.call('POST', 'knowledge/distill/promote', { body: { sourceId: taskId } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('4 分')
    expect(readdirSync(join(dirname(h.dataRoot), 'skills')).length).toBe(before)
  })

  it('样例不存在时如实拒绝', async () => {
    const res = await h.call('POST', 'knowledge/distill/promote', { body: { sourceId: 'no-such-sample' } })
    expect(res.code).not.toBe(0)
    expect(String(res.message)).toContain('找不到')
  })
})
