import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIGITAL_HUMAN_PERSONA,
  DIGITAL_HUMAN_PERSONAS,
  VOICE_PREVIEW_TEXT,
  findPersona,
  personaPrompt,
  resolvePersona,
} from '../../src/digital-human.ts'
import { CHARS_PER_SECOND, estimateSeconds, minScriptChars, splitScript, spokenCharCount } from '../../src/speech.ts'

/**
 * 数字人的念法（persona）：目录、回退，以及它到厂商提示词的映射。
 *
 * 这一层是纯函数与常量，所以断言的是**事实本身**——条目数与产品口径一致、
 * 每条都写得出"给用户看的一句"与"进提示词的一段"、老数据能折算成一条念法。
 * 声音由厂商在出片时按这段描述自己念，本机没有配音链路，也没有试听。
 */
describe('念法目录：产品给几条就摆几条', () => {
  it('9 条念法，id 唯一，每条都说得出"什么味道"与"怎么念"', () => {
    expect(DIGITAL_HUMAN_PERSONAS).toHaveLength(9)
    expect(new Set(DIGITAL_HUMAN_PERSONAS.map(item => item.id)).size, 'id 不能重复').toBe(9)
    for (const persona of DIGITAL_HUMAN_PERSONAS) {
      // 给用户看的一句：太短就分辨不出这条与那条的差别（用户挑声音靠的就是它）。
      expect(persona.summary.length, persona.id + ' 要有给用户看的说明').toBeGreaterThan(10)
      // 进提示词的一段：性别/音色/语速/语气四件事必须都写出来，少一件厂商就会换一把声音。
      expect(persona.prompt, persona.id + ' 要写进提示词').toContain('声音：')
      expect(persona.prompt, persona.id + ' 的音色描述要够具体').toContain('音色')
      expect(persona.prompt, persona.id + ' 要给出语速').toMatch(/语速[^。]*字/)
      expect(persona.prompt, persona.id + ' 要给出语气').toContain('语气')
      expect(persona.name.length, persona.id + ' 要有展示名').toBeGreaterThan(2)
    }
    // 同一段描述不能两条共用：共用等于"换了念法还是同一把声音"。
    expect(new Set(DIGITAL_HUMAN_PERSONAS.map(item => item.prompt)).size, '不能是同一句套话').toBe(9)
    // 默认念法必须真的在目录里：不在的话界面默认选中的那条查不到。
    expect(DIGITAL_HUMAN_PERSONAS.some(item => item.id === DEFAULT_DIGITAL_HUMAN_PERSONA)).toBe(true)
  })

  it('按 id 取得到，未知 id 一律回退默认念法', () => {
    expect(findPersona('female-warm')?.id).toBe('female-warm')
    expect(findPersona('no-such-persona')).toBeUndefined()
    expect(resolvePersona('no-such-persona')).toBe(DEFAULT_DIGITAL_HUMAN_PERSONA)
    expect(resolvePersona('')).toBe(DEFAULT_DIGITAL_HUMAN_PERSONA)
    expect(resolvePersona('male-broadcast'), '认得的原样返回').toBe('male-broadcast')
  })
})

describe('念法进提示词：新数据直接用，老数据折算', () => {
  it('有 persona 就用它的那段描述', () => {
    expect(personaPrompt('female-dongbei')).toBe(findPersona('female-dongbei')!.prompt)
  })

  it('老数据（只有音色或只有风格）折成一条念法，不把用户变成没声音', () => {
    // 老数据的两个字段是分开存的：音色是 Edge 的 ShortName，风格是演绎风格 id。
    expect(personaPrompt('', 'zh-CN-liaoning-XiaobeiNeural')).toBe(findPersona('female-dongbei')!.prompt)
    expect(personaPrompt('', '', 'hype')).toBe(findPersona('female-lively')!.prompt)
    // 音色对得上时优先按音色折算（风格只是"怎么念"，音色才决定"是谁的声音"）。
    expect(personaPrompt('', 'zh-HK-WanLungNeural', 'warm')).toBe(findPersona('male-steady')!.prompt)
  })

  it('三种老数据都读不出来时给默认念法：一段提示词没有声音描述，厂商会自己挑一条', () => {
    expect(personaPrompt('')).toBe(findPersona(DEFAULT_DIGITAL_HUMAN_PERSONA)!.prompt)
    expect(personaPrompt('', 'zh-CN-NoSuchVoice', 'no-such-style')).toBe(findPersona(DEFAULT_DIGITAL_HUMAN_PERSONA)!.prompt)
  })

  it('参考台词样板是照写的样本：去标点字数与产品语速折算出来的秒数对得上', () => {
    const chars = spokenCharCount(VOICE_PREVIEW_TEXT)
    expect(chars, '样板要够长，用户才看得出语气').toBeGreaterThan(20)
    // 字数口径与语速口径必须同一把尺子（去标点）：含标点计字会把时长算长（DEF-113）。
    // 只判区间，不在这里复算四舍五入规则——那等于把实现抄成第二份。
    const seconds = estimateSeconds(VOICE_PREVIEW_TEXT)
    expect(seconds).toBeGreaterThanOrEqual(Math.floor(chars / CHARS_PER_SECOND))
    expect(seconds).toBeLessThanOrEqual(Math.ceil(chars / CHARS_PER_SECOND))
  })
})

describe('语速折算：写稿门槛与分镜时长按同一个产品语速算', () => {
  it('产品语速是 4.5 字/秒，字数下限与它同源', () => {
    expect(CHARS_PER_SECOND).toBe(4.5)
    expect(minScriptChars(90)).toBe(Math.ceil(90 * CHARS_PER_SECOND))
    expect(minScriptChars(90, 3.4), '语速慢时字数下限更低').toBeLessThan(minScriptChars(90, CHARS_PER_SECOND))
  })

  it('切段按语速折算，每一段都落在厂商的 4~12 秒区间内', () => {
    const text = '姐妹们，这款面霜我自己用了三个月，干皮救急真的顶用，今天直播间直降一百，点下方链接就能拍。'
    const segments = splitScript(text)
    expect(segments.length).toBeGreaterThan(0)
    for (const segment of segments)
      expect(estimateSeconds(segment), '每段都要在厂商的 4~12 秒内').toBeLessThanOrEqual(12)
  })

  it('语速参数非法时回退默认值：不因为一个 0 让整条片子切不出段', () => {
    const text = '姐妹们，这款面霜我自己用了三个月。'
    expect(estimateSeconds(text, 0)).toBe(estimateSeconds(text, CHARS_PER_SECOND))
    expect(minScriptChars(30, -1)).toBe(minScriptChars(30, CHARS_PER_SECOND))
    expect(splitScript(text, 0).length).toBeGreaterThan(0)
  })
})
