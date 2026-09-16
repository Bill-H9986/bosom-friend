import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness } from '../harness.ts'
import type { Harness } from '../harness.ts'
import { IMAGE_RATIOS, IMAGE_TIERS, cropImageToSize, imagePricingRows, parseSize, pixelFor } from '../../src/image-ratio.ts'

/**
 * 内容创作参数口径与频道平台清单（RELEASE_GATE 门槛 10/11/12 的逻辑侧）。
 *
 * 图片档位必须与视频同为 720p/1080p，成品像素由「档位 + 画幅」派生；
 * 裁剪真的产出目标像素；频道清单里快手可连接、闲鱼如实标注 coming_soon。
 */
let h: Harness

beforeAll(() => {
  h = createHarness()
})
afterAll(() => {
  h.dispose()
})

interface PricingModel {
  model?: string
  name?: string
  resolutions?: string[]
  pricing?: Array<{ resolution: string; aspectRatio?: string; size?: string }>
}

describe('图片档位与视频一致，成品像素由档位 + 画幅派生', () => {
  it('pricing 接口的图片档位等于视频档位（720p/1080p）', async () => {
    const res = await h.call<{ imageModels: PricingModel[]; videoModels: PricingModel[] }>('GET', 'ai/draft-generation/pricing')
    expect(res.code).toBe(0)

    const imageTiers = [...new Set(res.data.imageModels.flatMap(model => (model.pricing ?? []).map(item => item.resolution)))]
    const videoTiers = [...new Set(res.data.videoModels.flatMap(model => model.resolutions ?? []))]
    expect(imageTiers.sort(), '图片档位必须与视频档位一致').toEqual(videoTiers.sort())
    expect(imageTiers.sort()).toEqual(['1080p', '720p'])
  })

  it('每个「档位 + 画幅」都有唯一成品像素，且与档位表一致', async () => {
    const res = await h.call<{ imageModels: PricingModel[] }>('GET', 'ai/draft-generation/pricing')
    for (const model of res.data.imageModels) {
      const rows = model.pricing ?? []
      expect(new Set(rows.map(item => item.aspectRatio)).size, '画幅数量').toBe(IMAGE_RATIOS.length)
      for (const row of rows) {
        expect(row.aspectRatio, '每一行都必须标明适用画幅').toBeTruthy()
        expect(row.size, row.resolution + ' ' + String(row.aspectRatio) + ' 必须有成品像素').toBe(pixelFor(row.resolution, String(row.aspectRatio)))
      }
      // 同一画幅下不得出现两家尺寸：1:1 只能是 720x720 / 1080x1080。
      const square = rows.filter(row => row.aspectRatio === '1:1').map(row => row.size)
      expect(square.sort()).toEqual(['1080x1080', '720x720'])
    }
  })

  it('档位表覆盖全部标准画幅，未知组合不编造尺寸', () => {
    expect(IMAGE_TIERS).toEqual(['720p', '1080p'])
    expect(IMAGE_RATIOS).toEqual(['1:1', '4:3', '3:4', '9:16', '16:9'])
    expect(pixelFor('1080p', '9:16')).toBe('1080x1920')
    expect(pixelFor('720p', '3:4')).toBe('720x960')
    expect(pixelFor('1080p', '21:9'), '未知画幅不得编造尺寸').toBe('')
    expect(imagePricingRows()).toHaveLength(IMAGE_TIERS.length * IMAGE_RATIOS.length)
    expect(parseSize('1080x1920')).toEqual({ width: 1080, height: 1920 })
    expect(parseSize('1080p')).toBeNull()
  })
})

/** PNG IHDR：宽高分别是第 16..20、20..24 字节。 */
function pngSize(file: string): { width: number; height: number } {
  const buffer = readFileSync(file)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

describe('成品裁剪：模型原图按档位 + 画幅落到目标像素', () => {
  // 裁剪依赖 Windows 自带 System.Drawing；其它平台保留原图，用例随之跳过。
  it.skipIf(process.platform !== 'win32')('1080p + 9:16 的成品必须正好是 1080x1920', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-crop-'))
    try {
      const source = join(dir, 'source.png')
      // 128x128 真 PNG（由 PowerShell 绘制，避免依赖测试夹具二进制）。
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Drawing;'
        + '$b=New-Object System.Drawing.Bitmap(128,128);'
        + '$g=[System.Drawing.Graphics]::FromImage($b);'
        + '$g.Clear([System.Drawing.Color]::CornflowerBlue);'
        + `$b.Save('${source.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`
        + '$g.Dispose();$b.Dispose()'], { windowsHide: true })

      const target = join(dir, 'target.png')
      const cropped = await cropImageToSize(source, target, 1080, 1920)
      expect(cropped, '裁剪成功必须返回成品路径').toBe(target)
      expect(pngSize(target), '成品必须正好是 1080p 9:16 的像素').toEqual({ width: 1080, height: 1920 })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('未知档位不产生成品（调用方保留原图）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-crop-'))
    try {
      const source = join(dir, 'source.png')
      writeFileSync(source, Buffer.from('not an image'))
      const target = join(dir, 'target.png')
      expect(await cropImageToSize(source, target, 1080, 1920)).toBe('')
      expect(pixelFor('unknown', '9:16')).toBe('')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('图片 / 视频模型挂在服务下面：地址与密钥按所属服务解析', () => {
  it('前端只报 providerId + model，服务端用该服务的地址与密钥补齐', async () => {
    await h.call('PUT', 'ai/user-llm', {
      body: {
        providers: [
          { id: 'a', displayName: 'A 网关', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-a', models: ['chat-a', 'img-a'] },
          { id: 'b', displayName: 'B 网关', baseUrl: 'https://b.example.com/v1', apiKey: 'sk-b', models: ['chat-b', 'vid-b'] },
        ],
        activeProviderId: 'a',
        // 图片模型属于 a、视频模型属于 b：两个通道必须各取自己那个服务的地址与密钥。
        image: { providerId: 'a', model: 'img-a' },
        video: { providerId: 'b', model: 'vid-b' },
      },
    })
    const raw = h.disk<Record<string, unknown>>('llm-user.json')
    expect(raw.imageBaseUrl, '图片通道取所属服务 a 的地址').toBe('https://a.example.com/v1')
    expect(raw.imageApiKey, '图片通道取 a 的密钥').toBe('sk-a')
    expect(raw.videoBaseUrl, '视频通道取所属服务 b 的地址').toBe('https://b.example.com/v1')
    expect(raw.videoApiKey, '视频通道必须用 b 的密钥，不能拿当前生效服务的').toBe('sk-b')
  })

  it('空 model 是显式清空通道，不会被当成"本次没提交"而保留旧值', async () => {
    // 真实 UI 的形状：服务列表与媒体通道一起提交（只报媒体通道、不带 providers 的旧式请求
    // 会被上面那条清空护栏拦下——这正是它该做的）。
    const cleared = await h.call('PUT', 'ai/user-llm', {
      body: {
        providers: [
          { id: 'a', displayName: 'A 网关', baseUrl: 'https://a.example.com/v1', apiKey: 'sk-a', models: ['chat-a', 'img-a'] },
          { id: 'b', displayName: 'B 网关', baseUrl: 'https://b.example.com/v1', apiKey: 'sk-b', models: ['chat-b', 'vid-b'] },
        ],
        activeProviderId: 'a',
        image: { model: '' },
        video: { model: '' },
      },
    })
    expect(cleared.code).toBe(0)
    const raw = h.disk<Record<string, unknown>>('llm-user.json')
    expect(raw.imageModel ?? '', '图片通道已清空').toBe('')
    expect(raw.videoModel ?? '', '视频通道已清空').toBe('')
  })
})

describe('模型服务整份清空必须显式确认', () => {
  it('空 providers 且已有服务时拒绝落盘，显式确认后才允许', async () => {
    const saved = await h.call('PUT', 'ai/user-llm', {
      body: {
        providers: [{
          id: 'agnes',
          displayName: 'Agnes AI',
          baseUrl: 'https://api.agnes-ai.cn/v1',
          protocol: 'openai-completions',
          apiKey: 'sk-functional-probe',
          models: ['agnes-2.5-flash'],
        }],
        activeProviderId: 'agnes',
      },
    })
    expect(saved.code, '先写入一个服务').toBe(0)
    expect(h.disk<{ providers?: unknown[] }>('llm-user.json').providers?.length, '写入后落盘应有 1 个服务').toBe(1)

    // 静默清空：必须被拒绝——实测发生过一次 providers 变 [] 只剩图片/视频残留，用户配置整份消失。
    const refused = await h.call('PUT', 'ai/user-llm', { body: { providers: [], activeProviderId: '' } })
    expect(refused.code, '静默清空必须报错').not.toBe(0)
    const after = await h.call<{ providers?: unknown[] }>('GET', 'ai/user-llm')
    expect(after.data.providers?.length, '被拒绝之后服务必须还在').toBe(1)

    // 显式确认（删除最后一个服务是合法操作）才允许清空。
    const allowed = await h.call('PUT', 'ai/user-llm', { body: { providers: [], activeProviderId: '', allowEmptyProviders: true } })
    expect(allowed.code, '显式确认后允许清空').toBe(0)
    const cleared = await h.call<{ providers?: unknown[] }>('GET', 'ai/user-llm')
    expect(cleared.data.providers?.length ?? 0).toBe(0)
  })

  it('旧式单配置请求同样不能静默清空多服务配置', async () => {
    await h.call('PUT', 'ai/user-llm', {
      body: {
        providers: [{
          id: 'agnes',
          baseUrl: 'https://api.agnes-ai.cn/v1',
          apiKey: 'sk-functional-probe',
          models: ['agnes-2.5-flash'],
        }],
        activeProviderId: 'agnes',
      },
    })
    // 不带 providers、也没有可用字段的旧式请求（历史上的"启动回灌"就是这个形状）必须被拒绝。
    const refused = await h.call('PUT', 'ai/user-llm', { body: { baseUrl: '', apiKey: '', model: '' } })
    expect(refused.code, '旧式空提交必须报错').not.toBe(0)
    const after = await h.call<{ providers?: unknown[] }>('GET', 'ai/user-llm')
    expect(after.data.providers?.length, '服务必须原样保留').toBe(1)

    // 每次写入都要留审计行：DEF-034 那次清空事后查不出发起方，就是因为没有这行日志。
    const audit = readFileSync(join(h.dataRoot, 'logs', 'llm-config-audit.log'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { action: string, providers: number, wiped?: boolean })
    expect(audit.some(item => item.action === 'providers' && item.providers === 1), '写入服务要留痕').toBe(true)

    // 显式 clear 仍然是合法的"断开配置"操作。
    const cleared = await h.call('PUT', 'ai/user-llm', { body: { clear: true } })
    expect(cleared.code, '显式 clear 允许').toBe(0)
    const afterClear = readFileSync(join(h.dataRoot, 'logs', 'llm-config-audit.log'), 'utf8')
    expect(afterClear, '清空动作必须留痕并标明原因').toContain('legacy-clear')
    const gone = await h.call<{ providers?: unknown[] }>('GET', 'ai/user-llm')
    expect(gone.data.providers?.length ?? 0).toBe(0)
  })
})

describe('频道平台清单：能连的与能发的必须分开如实报告', () => {
  it('快手与闲鱼的连接能力按引擎真实模块下发', async () => {
    const res = await h.call<Array<{ platform: string, status: string, authType: string, capabilities: { auth?: { supported?: boolean }, publish?: { supported?: boolean } } }>>('GET', 'v2/channels/platforms')
    expect(res.code).toBe(0)

    const kwai = res.data.find(item => item.platform === 'KWAI')
    expect(kwai, '清单必须包含快手').toBeTruthy()
    expect(kwai?.status, '快手已由引擎落地，必须是 available').toBe('available')
    expect(kwai?.capabilities.auth?.supported, '快手必须可扫码授权').toBe(true)
    expect(kwai?.capabilities.publish?.supported, '快手必须可发布').toBe(true)

    const xianyu = res.data.find(item => item.platform === 'xianyu')
    expect(xianyu, '清单必须包含闲鱼').toBeTruthy()
    // 闲鱼引擎模块存在，但登录流程依赖随包的 patchright 浏览器 chromium_headless_shell-1169，
    // 而安装包只带 1208 —— 实测 /platform-login/qr/<sid> 返回 HTTP 500「Executable doesn't exist」。
    // 在补齐之前不得宣称可用，必须如实报 coming_soon，且不得作为可连接频道暴露。
    expect(xianyu?.status, '闲鱼未就绪，必须报 coming_soon').toBe('coming_soon')
    expect(xianyu?.channel, '闲鱼不得作为可连接频道暴露').toBe(false)
  })

  it('目录同时报告「引擎能做什么」与「产品是否接入」：不再宣称未接入的平台', async () => {
    const res = await h.call<Array<{ platform: string, channel: boolean }>>('GET', 'v2/channels/platforms')
    const channels = res.data.filter(item => item.channel === true).map(item => item.platform).sort()
    expect(channels, '产品频道白名单只认这几个').toEqual(['KWAI', 'alipay', 'baijiahao', 'bilibili', 'douyin', 'hupu', 'weibo', 'wxSph', 'xhs'])

    // 引擎带模块、但产品没作为频道开放的平台必须在列且 channel=false：
    // 接口仍然如实报告引擎能力（诊断用），但不能让调用方以为产品已经接入。
    const engineOnly = res.data.filter(item => item.channel !== true).map(item => item.platform)
    expect(engineOnly.length, '引擎里还有产品未接入的平台').toBeGreaterThan(0)
    expect(engineOnly, '未接入的平台不得混进频道白名单').not.toContain('xhs')
  })

  it('发布能力与连接能力分开报告：能连上不等于能发出去', async () => {
    const res = await h.call<Array<{ platform: string, capabilities: { publish?: { supported?: boolean } } }>>('GET', 'v2/channels/platforms')
    const publishable = res.data
      .filter(item => item.capabilities.publish?.supported === true)
      .map(item => item.platform)
    // 三个真实接通发布的频道平台必须在列（能力清单来自引擎源码扫描，不靠人工声明）。
    for (const platform of ['xhs', 'douyin', 'KWAI'])
      expect(publishable, platform + ' 必须宣称可发布').toContain(platform)
    // 闲鱼登录已接通但发布还没有：不得混进可发布清单，前端据此把它挡在内容创作目标平台之外。
    expect(publishable, '闲鱼发布未接通前不得宣称可发布').not.toContain('xianyu')
  })
})
