import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { api, expect, openRoute, test } from '../fixtures'

/**
 * 模型配置只有一个权威：服务端 llm-user.json（设置页保存时写入，并投影给内核 settings.yaml/.credentials.yaml）。
 *
 * 历史行为：每次启动都把浏览器 localStorage 里的副本整份 PUT 回服务端，
 * 一次局部同步就会冲掉设置页配好的多服务配置（实测过：配了第二个服务，下次启动就消失）；
 * 每次 AI 请求还额外带上这份副本，服务端于是有两套配置在争。
 * 现在：启动不再回灌（只在服务端为空时迁移一次），请求也不带 llm。
 *
 * 安全性：用例会种一份"老用户本地副本"来复现历史场景，因此**必须**能在失败时自愈——
 * 前后备份 llm-user.json，finally 里写回并按它重新投影内核，避免把用户的模型配置留在探针值上。
 */
const LLM_FILE = join(homedir(), '.bosom-friend', 'bosom-friend', 'llm-user.json')

test.describe('模型配置 · 单一权威', () => {
  test('启动不回灌浏览器副本，服务端配置原样不动', async ({ page }) => {
    const before = await api('GET', 'ai/user-llm')
    const beforeProviders = Array.isArray(before.data?.providers) ? before.data.providers : []
    test.skip(beforeProviders.length === 0, '当前实例没有配置任何模型服务，无法验证单一权威')

    const fileBackup = existsSync(LLM_FILE) ? readFileSync(LLM_FILE, 'utf8') : null
    try {
      const writes: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'PUT' && request.url().includes('/bosom-friend/api/ai/user-llm'))
          writes.push(request.postData() ?? '')
      })

      // 模拟老用户：浏览器里本来就留着一份旧副本（旧版本每次启动都把它整份 PUT 回去）。
      await page.addInitScript(() => {
        window.localStorage.setItem('bosom-friend-user-llm', JSON.stringify({
          baseUrl: 'https://legacy-probe.example.com/v1',
          apiKey: 'sk-legacy-probe',
          model: 'legacy-probe-model',
        }))
      })

      await openRoute(page, '#/draft-box', 9000)

      expect(writes, '带着本地副本启动也不得回灌服务端').toEqual([])
      expect(await page.evaluate(() => window.localStorage.getItem('bosom-friend-user-llm')), '本地副本应原样保留（只做密钥回填）').not.toBeNull()

      const after = await api('GET', 'ai/user-llm')
      const afterProviders = Array.isArray(after.data?.providers) ? after.data.providers : []
      expect(afterProviders.length, '启动后服务端提供方数量不得变化').toBe(beforeProviders.length)
      expect(after.data?.activeProviderId, '启动后当前生效服务不得被改掉').toBe(before.data?.activeProviderId)
      expect(afterProviders[0]?.baseUrl, '启动后接口地址不得被本地副本改掉').toBe(beforeProviders[0]?.baseUrl)
    }
    finally {
      // 自愈：万一把探针副本写进了服务端，这里按备份文件还原并重新投影内核。
      if (fileBackup !== null) {
        writeFileSync(LLM_FILE, fileBackup, 'utf8')
        await api('PUT', 'ai/user-llm', JSON.parse(fileBackup))
      }
    }
  })
})
