import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONSTRAINT_SOURCES,
  MANAGED_BEGIN,
  MANAGED_END,
  buildAgentContext,
  buildConstraintLines,
  dshHomeOf,
  mergeAgentContext,
  writeAgentContext,
  type AgentContextFacts,
} from '../../src/agent-context.ts'

/**
 * 产品稳定语境文件的落盘与合并语义。
 *
 * 为什么单独锁这一条：这份文件既是**用户数据根里的用户资产**，又是模型的上下文来源。
 * 写坏它有两条很隐蔽的路径——区块堆叠（每轮追加一份，文件和提示词一起膨胀）与整文件覆盖
 * （把用户手写的偏好删掉）。两者在界面都看不出来，只有断言能拦住。
 */

const homes: string[] = []
/** 建一个一次性的 DSH 数据根；用例结束统一删。 */
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bf-agent-context-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

const FACTS: AgentContextFacts = {
  platforms: ['小红书', '抖音'],
  recentFailures: ['《夏日特调》发布失败：平台返回"内容含违规词"'],
  successSamples: 7,
  ratedSamples: 3,
  failuresByPlatform: [{ platform: '小红书', count: 3, lastMessage: '内容含违规词' }],
  accountFacts: [{ platform: '小红书', nickname: '深夜食堂研究所', positioning: '深夜治愈系美食内容，给打工人下班后的一口温暖' }],
  accountUsability: {
    usable: 1,
    relogin: [{ platform: '抖音', nickname: '深夜食堂研究所', note: '抖音登录已失效，请重新扫码登录' }],
    disabled: [],
  },
  profile: {
    accountCount: 2,
    publishesByPlatform: [{ platform: '小红书', count: 3 }, { platform: '抖音', count: 1 }],
    generationsByKind: [{ kind: 'image-text', count: 5 }],
    topRatedTask: 'image-text',
  },
}

describe('语境块：约束与历史都要写进模型看得见的那份文件', () => {
  it('约束语境带上产品自己的数字，不是"一般来说"', () => {
    const block = buildAgentContext(FACTS)
    expect(block).toContain('## 约束语境')
    expect(block).toContain(String(CONSTRAINT_SOURCES.titleChars) + ' 个字')
    expect(block).toContain(String(CONSTRAINT_SOURCES.topics) + ' 个')
    // 成本是行为约束而不是数字：付钱的动作用户没说就不要做。
    expect(block).toContain('会产生真实费用与额度消耗')
  })

  it('约束文案跟着来源走，而不是手抄一份数字', () => {
    // 手抄的数字改了代码不会跟着变——这条断言是"派生"的证据：
    // 换一组来源，文案跟着换。
    const lines = buildConstraintLines({ ...CONSTRAINT_SOURCES, titleChars: 42, topics: 3 })
    expect(lines.join('\n')).toContain('不超过 42 个字')
    expect(lines.join('\n')).toContain('不超过 3 个')
    expect(lines.join('\n')).not.toContain('不超过 30 个字')
  })

  it('段落时长与镜头时长是两组数字，不能混成一句', () => {
    // 2026-09-22 核对时发现的老文案：「单条视频按 4~12 秒一个镜头」——
    // 4~12 秒是**配音段落**的时长，镜头目标 5 秒、上限 6 秒；按老文案排镜头会排出产品不会剪的片子。
    const text = buildConstraintLines(CONSTRAINT_SOURCES).join('\n')
    expect(text).toContain(String(CONSTRAINT_SOURCES.segmentMin) + '~' + String(CONSTRAINT_SOURCES.segmentMax) + ' 秒切分')
    expect(text).toContain('目标时长是 ' + String(CONSTRAINT_SOURCES.shotTarget) + ' 秒')
    expect(text).toContain('不超过 ' + String(CONSTRAINT_SOURCES.shotMax) + ' 秒')
    expect(CONSTRAINT_SOURCES.shotMax).toBeLessThan(CONSTRAINT_SOURCES.segmentMax)
  })

  it('政策类数字只出现在宪章里：同一份语境文件里一个数字只说一次', () => {
    // 同一份文件里写两遍，改一处漏一处就是"教模型两套规矩"。
    const block = buildAgentContext(FACTS)
    const count = (needle: string) => block.split(needle).length - 1
    expect(count('不超过 3 条'), '发布限频写在领域语境的第八节').toBe(1)
    expect(count('不超过 20 次'), '互动次数同理').toBe(1)
  })

  it('账号定位进画像：它是长期上下文（ADR-004 §2.1）', () => {
    const block = buildAgentContext(FACTS)
    expect(block).toContain('- 账号定位：')
    expect(block).toContain('小红书·深夜食堂研究所：深夜治愈系美食内容')
  })

  it('账号定位：没有就不写这一段，也不留空标题', () => {
    const block = buildAgentContext({ ...FACTS, accountFacts: [] })
    expect(block).not.toContain('- 账号定位：')
  })

  it('权限边界：掉了登录的号要点名，并说清"这些号现在做不了事"', () => {
    // 飞书那句「权限即上下文边界」在本产品里的落点：语境只写"你绑了抖音"是不够的——
    // 掉了登录的号做不到事，而产品规则又禁止模型说"我没有权限"。
    const block = buildAgentContext(FACTS)
    expect(block).toContain('现在能用的账号：1 个')
    expect(block).toContain('1 个需要重新登录')
    expect(block).toContain('抖音·深夜食堂研究所：抖音登录已失效，请重新扫码登录')
    expect(block).toContain('发不出去也拿不到数据')
  })

  it('权限边界：失效与掉登录是两回事，各说各的', () => {
    const block = buildAgentContext({
      ...FACTS,
      accountFacts: [],
      accountUsability: {
        usable: 1,
        relogin: [{ platform: '抖音', nickname: 'A', note: '' }],
        disabled: [{ platform: '快手', nickname: 'B' }],
      },
    })
    expect(block).toContain('1 个需要重新登录')
    expect(block).toContain('1 个已失效（快手·B）')
  })

  it('权限边界：全都正常时不编出问题，也不重复说一遍', () => {
    const block = buildAgentContext({
      ...FACTS,
      accountFacts: [],
      accountUsability: { usable: 2, relogin: [], disabled: [] },
    })
    expect(block).toContain('现在能用的账号：2 个（全部正常）')
    // 只断言这一行里没有别的话：宪章（领域语境）里本来就会出现"失效"这类词。
    expect(block).not.toContain('个需要重新登录')
    expect(block).not.toContain('个已失效')
  })

  it('权限边界：一个账号都没有时不写这一段（不留空标题、不说"0 个可用"）', () => {
    const block = buildAgentContext({
      ...FACTS,
      platforms: [],
      accountFacts: [],
      accountUsability: { usable: 0, relogin: [], disabled: [] },
    })
    expect(block).toContain('已连接平台：暂无')
    expect(block).not.toContain('现在能用的账号')
  })

  it('历史语境带上这台机器上真实发生过的失败原文', () => {
    const block = buildAgentContext(FACTS)
    expect(block).toContain('## 历史语境')
    expect(block).toContain('平台返回"内容含违规词"')
  })

  it('没有真实失败时不出现"最近真实发生过"这一段，不留空标题', () => {
    const block = buildAgentContext({ ...FACTS, recentFailures: [] })
    expect(block).not.toContain('最近真实发生过的失败')
    expect(block).not.toContain('## 当前家底\n\n## ')
  })

  it('记忆：同一个平台反复失败才进这一段（按次数降序、带上最近一次的原因）', () => {
    const block = buildAgentContext(FACTS)
    expect(block).toContain('## 记忆（这台机器上反复出问题的地方，别硬来）')
    expect(block).toContain('- 小红书：3 次失败（最近一次：内容含违规词）')
  })

  it('没有聚合失败时不出现记忆段（单次失败只在"最近真实失败"里）', () => {
    const block = buildAgentContext({ ...FACTS, failuresByPlatform: [] })
    expect(block).not.toContain('## 记忆')
    expect(block, '但单次失败那一段照旧').toContain('最近真实发生过')
  })

  it('画像：只写有出处的事实，不推断口味', () => {
    const block = buildAgentContext(FACTS)
    expect(block).toContain('## 用户画像（这台机器上真实发生的事，不是猜的）')
    expect(block).toContain('- 已绑定账号：2 个')
    expect(block).toContain('- 已发布：小红书 3 条、抖音 1 条')
    expect(block).toContain('- 生成过的内容：image-text 5 条')
    expect(block).toContain('- 用户打过高分（≥4）的任务类型：image-text')
  })

  it('画像在什么都没有时也只写"已绑定账号 0 个"，不编造发布与偏好', () => {
    const block = buildAgentContext({
      ...FACTS,
      profile: { accountCount: 0, publishesByPlatform: [], generationsByKind: [], topRatedTask: '' },
    })
    expect(block).toContain('- 已绑定账号：0 个')
    expect(block).not.toContain('- 已发布：')
    expect(block).not.toContain('- 用户打过高分')
  })

  it('还没有绑定任何账号时如实写"暂无"，不编造平台名', () => {
    const block = buildAgentContext({
      platforms: [],
      recentFailures: [],
      successSamples: 0,
      ratedSamples: 0,
      failuresByPlatform: [],
      accountFacts: [],
      accountUsability: { usable: 0, relogin: [], disabled: [] },
      profile: { accountCount: 0, publishesByPlatform: [], generationsByKind: [], topRatedTask: '' },
    })
    expect(block).toContain('暂无（还没有扫码绑定任何账号）')
    expect(block).toContain('成功 0 条')
    expect(block, '一个账号都没有时不写"0 个可用"这句废话').not.toContain('现在能用的账号')
  })
})

describe('合并语义：自动区块可重复刷新，用户手写的内容不动', () => {
  it('同一份事实合并两次，内容完全一致（不堆叠）', () => {
    const block = buildAgentContext(FACTS)
    const once = mergeAgentContext(undefined, block)
    const twice = mergeAgentContext(once, block)
    expect(twice).toBe(once)
    expect(once.split(MANAGED_BEGIN)).toHaveLength(2)
  })

  it('事实变了就替换旧区块，而不是再追加一份', () => {
    const first = mergeAgentContext(undefined, buildAgentContext(FACTS))
    const second = mergeAgentContext(first, buildAgentContext({ ...FACTS, platforms: ['视频号'] }))
    expect(second).toContain('视频号')
    expect(second).not.toContain('小红书、抖音')
    expect(second.split(MANAGED_BEGIN)).toHaveLength(2)
  })

  it('区块之外用户写的内容逐字保留', () => {
    const block = buildAgentContext(FACTS)
    const withUserText = mergeAgentContext('# 我自己的偏好\n\n- 口吻要像朋友聊天，不要客服腔\n', block)
    const refreshed = mergeAgentContext(withUserText, buildAgentContext({ ...FACTS, successSamples: 9 }))
    expect(refreshed).toContain('口吻要像朋友聊天，不要客服腔')
    expect(refreshed).toContain('成功 9 条')
  })

  it('文件里原本只有自动区块时，刷新后也不留多余空行', () => {
    const block = buildAgentContext(FACTS)
    const merged = mergeAgentContext(undefined, block)
    expect(merged.endsWith(MANAGED_END + '\n')).toBe(true)
    expect(merged.startsWith('# Bosom Friend 产品语境')).toBe(true)
  })
})

describe('落盘：写进 $DSH_HOME/AGENTS.md，内容没变就不动 mtime', () => {
  it('数据根的上一级就是 DSH_HOME', () => {
    expect(dshHomeOf(join('C:', 'Users', 'someone', '.bosom-friend', 'bosom-friend')))
      .toBe(join('C:', 'Users', 'someone', '.bosom-friend'))
  })

  it('首次写入建目录建文件，第二次相同内容不落盘', () => {
    const home = tempHome()
    const block = buildAgentContext(FACTS)
    const first = writeAgentContext(home, block)
    expect(first.path).toBe(join(home, 'AGENTS.md'))
    expect(first.changed).toBe(true)
    expect(existsSync(first.path)).toBe(true)
    const second = writeAgentContext(home, block)
    expect(second.changed).toBe(false)
  })

  it('用户把文件改成自己的内容后，刷新仍然保留他的文字', () => {
    const home = tempHome()
    writeAgentContext(home, buildAgentContext(FACTS))
    const file = join(home, 'AGENTS.md')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n## 我的补充\n\n- 每周五只发一条\n', 'utf8')
    writeAgentContext(home, buildAgentContext({ ...FACTS, platforms: ['快手'] }))
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('每周五只发一条')
    expect(text).toContain('快手')
  })
})
