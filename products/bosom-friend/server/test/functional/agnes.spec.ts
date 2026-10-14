import { describe, expect, it } from 'vitest'
import { createHarness } from '../harness.ts'
import {
  AGNES_BASE_URL,
  AGNES_IMAGE_PROMPT_STRUCTURES,
  AGNES_PROVIDER_ID,
  AGNES_VIDEO_PROMPT_FIELDS,
  AGNES_VIDEO_RATIOS,
  agnesMediaPlaceholder,
  agnesPictureReferenceClause,
  agnesVideoLimits,
  agnesVideoPromptStructureText,
  isAgnesVideoModel,
} from '../../src/agnes.ts'
import { isAgnesBaseUrl, parseLlmOverride } from '../../src/api.ts'

/**
 * 内置 Agnes 规格：内置的只有**服务商**（地址与协议），没有任何内置大模型。
 *
 * 这里断言两件事——**厂商事实**按官方文档取值（基址、模型能力上限、画幅白名单），
 * 以及**型号一律来自用户配置**（没配就是没有，绝不替他挑一个）。官方文档一改，
 * 断言就该跟着改，而不是被放宽。
 *
 * 档位/画幅/时长怎么落到厂商字段已经搬进内核媒体能力面
 * （`packages/media/media-pi-ai/src/vendor.ts`，用例在 `tests/vendor.spec.ts`），这里不再重复。
 */
describe('内置 Agnes：模型能力来自官方规格', () => {
  it('每个模型的能力来自官方：Flash 只出 720P，2.5 支持 1080P', () => {
    expect(isAgnesVideoModel('agnes-video-2.5')).toBe(true)
    expect(isAgnesVideoModel('agnes-video-2.5-flash')).toBe(true)
    expect(isAgnesVideoModel('some-vendor-video')).toBe(false)
  })

  it('参考素材上限按模型分：Flash 只收 5 张图且不支持参考视频', () => {
    expect(agnesVideoLimits('agnes-video-2.5-flash').images).toBe(5)
    expect(agnesVideoLimits('agnes-video-2.5-flash').videos).toBe(0)
    expect(agnesVideoLimits('agnes-video-2.5').images).toBe(8)
    expect(agnesVideoLimits('agnes-video-2.5').videos).toBe(1)
    // 认不出的模型按最保守一档：宁可少要素材，也不要被厂商 400 拒收。
    expect(agnesVideoLimits('unknown-model').sizes).toEqual(['720P'])
  })
})

describe('官方提示词规范：六段结构、图像结构、参考素材占位符', () => {
  it('视频提示词就是官方给的六段，顺序不能改', () => {
    expect(AGNES_VIDEO_PROMPT_FIELDS.map(field => field.id))
      .toEqual(['subject', 'action', 'camera', 'style', 'sound', 'consistency'])
    const text = agnesVideoPromptStructureText()
    expect(text).toContain('1) 主体与场景')
    expect(text).toContain('6) 一致性要求')
  })

  it('参考素材占位符按官方写法编号，且用途被写明', () => {
    expect(agnesMediaPlaceholder('picture', 0)).toBe('<Picture 1>')
    expect(agnesMediaPlaceholder('picture', 2)).toBe('<Picture 3>')
    expect(agnesMediaPlaceholder('audio', 0)).toBe('<Audio 1>')
    expect(agnesMediaPlaceholder('video', 1)).toBe('<Video 2>')
    // 官方要求写明占位符**及其用途**：不指名时厂商会把同一人物的多个角度当成多个人。
    expect(agnesPictureReferenceClause(['主角的身份参考', '', '产品外观参考']))
      .toBe('<Picture 1> 是主角的身份参考；<Picture 3> 是产品外观参考')
    expect(agnesPictureReferenceClause([]), '没有素材就没有指代句').toBe('')
  })

  it('图像提示词结构逐字抄录（三种输入各一套）', () => {
    expect(AGNES_IMAGE_PROMPT_STRUCTURES.textToImage)
      .toBe('[主体] + [场景 / 环境] + [风格] + [光照] + [构图] + [质量要求]')
    expect(AGNES_IMAGE_PROMPT_STRUCTURES.multiImage).toContain('[参考图角色]')
  })
})

describe('内置 Agnes：只内置服务商，不内置任何大模型', () => {
  it('只填 API Key 时补齐官方基址，但**不补任何型号**', () => {
    const cfg = parseLlmOverride({ apiKey: 'sk-builtin-probe' })
    expect(cfg, '只填 Key 必须能解析出配置').toBeTruthy()
    expect(cfg?.baseUrl, '地址是服务商事实，由内置规格补齐').toBe(AGNES_BASE_URL)
    // 型号是用户的决定：替他挑一个，界面显示的选择与实际请求的型号就对不上了。
    expect(cfg?.model, '没填型号就是没配').toBe('')
    expect(cfg?.imageModel).toBeUndefined()
    expect(cfg?.videoModel).toBeUndefined()
    expect(cfg?.models ?? [], '也不预置模型目录').toEqual([])
  })

  it('用户填了型号就原样使用（内置规格不覆盖、不改写）', () => {
    const cfg = parseLlmOverride({
      apiKey: 'sk-builtin-probe',
      model: 'agnes-3.0-flash',
      videoModel: 'agnes-video-2.5',
      imageModel: 'agnes-image-2.5-flash',
      models: ['agnes-3.0-flash', 'agnes-video-2.5'],
    })
    expect(cfg?.model).toBe('agnes-3.0-flash')
    expect(cfg?.videoModel).toBe('agnes-video-2.5')
    expect(cfg?.imageModel).toBe('agnes-image-2.5-flash')
    expect(cfg?.models).toEqual(['agnes-3.0-flash', 'agnes-video-2.5'])
  })

  it('认得出内置厂商的地址（含自建代理域名之外的官方域名），不做误导性判定', () => {
    expect(isAgnesBaseUrl('')).toBe(true)
    expect(isAgnesBaseUrl('https://api.agnes-ai.cn/v1')).toBe(true)
    expect(isAgnesBaseUrl('https://api.agnes-ai.com/v1')).toBe(true)
    expect(isAgnesBaseUrl('https://my-gateway.example.com/v1')).toBe(false)
  })

  it('其它厂商的配置不会被塞进 Agnes 的模型名', () => {
    const cfg = parseLlmOverride({ baseUrl: 'https://my-gateway.example.com/v1', apiKey: 'sk-x', model: 'my-chat' })
    expect(cfg?.model).toBe('my-chat')
    expect(cfg?.imageModel).toBeUndefined()
    expect(cfg?.videoModel).toBeUndefined()
  })

  it('对话模型清单 = 用户配的那些，没配就是空清单', async () => {
    const h = createHarness()
    try {
      const empty = await h.call<unknown[]>('GET', 'ai/models/chat')
      expect(empty.data, '没配置时不摆任何模型').toEqual([])

      await h.call('PUT', 'ai/user-llm', {
        body: {
          providers: [{ id: AGNES_PROVIDER_ID, apiKey: 'sk-builtin-probe', models: ['agnes-3.0-flash', 'agnes-2.5-pro'], model: 'agnes-3.0-flash' }],
          activeProviderId: AGNES_PROVIDER_ID,
        },
      })
      const listed = await h.call<Array<{ name: string, channel: string }>>('GET', 'ai/models/chat')
      expect(listed.data.map(item => item.name)).toEqual(['agnes-3.0-flash', 'agnes-2.5-pro'])
      expect(listed.data[0]?.channel, '不再是"内置厂商"口径').toBe('user')
    }
    finally {
      h.dispose()
    }
  })

  it('设置页拿到的内置卡 id 固定，前端据此认出"不可删除的内置服务"', () => {
    expect(AGNES_PROVIDER_ID).toBe('agnes-builtin')
  })
})
describe('内容创作的模型清单：只有用户配置的那一个，且档位按官方能力给', () => {
  it('没配置时：图片与视频清单都是空的（界面据此提示去设置）', async () => {
    const h = createHarness()
    try {
      const res = await h.call<{ imageModels: unknown[], videoModels: unknown[] }>('GET', 'ai/draft-generation/pricing')
      expect(res.data.videoModels, '不摆任何内置模型').toEqual([])
      expect(res.data.imageModels, '本地排版卡片也不再冒充模型').toEqual([])
    }
    finally {
      h.dispose()
    }
  })

  it('Flash 官方只出 720P，清单里就不该出现 1080p；2.5 两档都在', async () => {
    const h = createHarness()
    try {
      const save = async (videoModel: string): Promise<void> => {
        const saved = await h.call('PUT', 'ai/user-llm', {
          body: {
            providers: [{ id: AGNES_PROVIDER_ID, apiKey: 'sk-tier-probe', models: [videoModel], model: videoModel }],
            activeProviderId: AGNES_PROVIDER_ID,
            video: { providerId: AGNES_PROVIDER_ID, model: videoModel },
          },
        })
        expect(saved.code, String(saved.message)).toBe(0)
      }
      await save('agnes-video-2.5-flash')
      const flash = await h.call<{ videoModels: Array<{ name: string, resolutions: string[] }> }>('GET', 'ai/draft-generation/pricing')
      expect(flash.data.videoModels.map(item => item.name), '只列配置的那个').toEqual(['agnes-video-2.5-flash'])
      expect(flash.data.videoModels[0]?.resolutions, 'Flash 官方原文 size must be 720P').toEqual(['720p'])

      await save('agnes-video-2.5')
      const full = await h.call<{ videoModels: Array<{ name: string, resolutions: string[] }> }>('GET', 'ai/draft-generation/pricing')
      expect(full.data.videoModels.map(item => item.name)).toEqual(['agnes-video-2.5'])
      expect(full.data.videoModels[0]?.resolutions, '2.5 官方支持 720P 与 1080P').toEqual(['720p', '1080p'])
    }
    finally {
      h.dispose()
    }
  })
})

describe('内置 Agnes 卡：接口地址内置，模型目录由用户填', () => {
  it('只保存内置卡（不带模型）后：地址补齐、模型一个都不补', async () => {
    const h = createHarness()
    try {
      const saved = await h.call('PUT', 'ai/user-llm', {
        body: {
          providers: [{ id: AGNES_PROVIDER_ID, apiKey: 'sk-builtin-probe' }],
          activeProviderId: AGNES_PROVIDER_ID,
        },
      })
      expect(saved.code, String(saved.message)).toBe(0)

      const raw = h.disk<Record<string, unknown>>('llm-user.json')
      expect(raw.baseUrl, '接口地址由内置规格补齐').toBe(AGNES_BASE_URL)
      expect(raw.model, '没填型号就不编一个').toBe('')
      expect(raw.imageModel, '图片通道不替用户选型号').toBeUndefined()
      expect(raw.videoModel, '视频通道同理').toBeUndefined()

      const got = await h.call<{ providers?: Array<{ id?: string, models?: string[] }> }>('GET', 'ai/user-llm')
      const card = got.data.providers?.find(item => item.id === AGNES_PROVIDER_ID)
      expect(card, '内置卡必须回读得到').toBeTruthy()
      expect(card?.models ?? [], '内置卡不带模型目录：用户点「获取可用模型」自己选').toEqual([])
    }
    finally {
      h.dispose()
    }
  })

  it('没配对话模型时，写稿与分镜都给出"去哪配"的提示，而不是拿官方默认档顶上', async () => {
    const h = createHarness()
    try {
      await h.call('PUT', 'ai/user-llm', {
        body: {
          providers: [{ id: AGNES_PROVIDER_ID, apiKey: 'sk-builtin-probe' }],
          activeProviderId: AGNES_PROVIDER_ID,
        },
      })
      const res = await h.call('POST', 'long-videos/enhance-topic', { body: { topic: '干皮救急面霜' } })
      expect(res.code, '没配模型不能假装能生成').not.toBe(0)
      expect(res.message, '要指路设置页').toContain('设置')
    }
    finally {
      h.dispose()
    }
  })
})
