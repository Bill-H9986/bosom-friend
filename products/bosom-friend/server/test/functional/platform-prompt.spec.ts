/**
 * 内容生成的参数必须真的进提示词。
 *
 * 用户口径的"内容创作参数不对"来自三处：提示词里写死"60 秒"、体裁写死"小红书图文笔记"、
 * 目标平台只在发布时用（生成时一个字都不提）。这里把"用户选了什么、模型就看到什么"钉住。
 */
import { describe, expect, it } from 'vitest'
import { buildPlatformBlock, detectPublishPlatform, readPlatformList } from '../../src/api.ts'

describe('目标平台进提示词', () => {
  it('没选平台时不给平台块（不拿通用话术冒充）', () => {
    expect(buildPlatformBlock([])).toBe('')
  })

  it('选了平台就逐个写出来，并要求按各平台习惯写', () => {
    const block = buildPlatformBlock(['douyin', 'xiaohongshu'])
    expect(block).toContain('douyin')
    expect(block).toContain('xiaohongshu')
    expect(block, '要按平台习惯写，而不是写通用文案').toContain('各自的习惯')
    expect(block, '站外导流话术会被限流，必须在提示词里禁掉').toContain('点下方链接')
  })
})

describe('目标平台的读取：数组与老版的空格串都要认', () => {
  it('数组原样读出来', () => {
    expect(readPlatformList(['douyin', 'xhs'])).toEqual(['douyin', 'xhs'])
  })

  it('空格分隔的字符串也要读出来（实测盘上就有这种老记录：xhs douyin KWAI wxSph）', () => {
    expect(readPlatformList('xhs douyin KWAI wxSph')).toEqual(['xhs', 'douyin', 'KWAI', 'wxSph'])
  })

  it('中英文逗号与顿号同样当分隔符（用户手填与旧客户端都出现过）', () => {
    expect(readPlatformList('douyin, xhs，KWAI、wxSph')).toEqual(['douyin', 'xhs', 'KWAI', 'wxSph'])
  })

  it('读不出来时给空数组，调用方按"没选平台"处理', () => {
    expect(readPlatformList(undefined)).toEqual([])
    expect(readPlatformList(42)).toEqual([])
    expect(readPlatformList('   ')).toEqual([])
    expect(readPlatformList(['', '  '])).toEqual([])
  })
})

describe('发布动作卡的平台来自用户那句话', () => {
  it('说到哪个平台就是哪个平台——不是"不是抖音就算小红书"', () => {
    expect(detectPublishPlatform('帮我发布到快手')).toBe('KWAI')
    expect(detectPublishPlatform('发到视频号')).toBe('wxSph')
    expect(detectPublishPlatform('发小红书笔记')).toBe('xhs')
    expect(detectPublishPlatform('发布到抖音')).toBe('douyin')
    expect(detectPublishPlatform('发到 B 站')).toBe('bilibili')
  })

  it('没说平台时回落到产品默认的小红书，而不是随机挑一个', () => {
    expect(detectPublishPlatform('帮我写一条面霜文案')).toBe('xhs')
  })
})
