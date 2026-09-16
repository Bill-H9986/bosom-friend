/**
 * 官方内核客户端适配层（ADR-001 第一步）：server 作为官方 SDK 客户端进程，
 * 启动内核运行时（launcher/src/bin-kernel.ts），把对话请求经 session/prompt 送进内核，
 * 并把 SDK 的 session.event（assistant/chunk）翻译为前端可用的文本增量。
 * 默认关闭（Config.kernelAi=false），开启后不影响旧路径。
 * @module @deepseek-ai/dsh-bosom-friend-server/kernel-client
 */

import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export interface KernelPromptResult {
  text: string
  error?: string
}

export interface KernelClient {
  /**
   * 把一段用户输入送进官方内核，逐增量回调；返回聚合文本或错误。
   * @param prompt - 用户输入。
   * @param onDelta - 每个文本增量的回调。
   * @param shouldAbort - 返回 true 时立即停止等待并放弃本轮剩余输出（调用方随后 close 掉内核）。
   */
  prompt(prompt: string, onDelta?: (text: string) => void, shouldAbort?: () => boolean): Promise<KernelPromptResult>
  /** 关闭内核子进程（协议 shutdown）。 */
  close(): Promise<void>
}

/** 内核客户端可选配置：提供 baseUrl/apiKey 时走用户自定义网关（agnes 路由）。 */
export interface KernelClientOptions {
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
}

/**
 * 从一条 SDK 通知中提取 assistant/chunk 的文本增量；非增量通知返回空串。
 * 形状以实测为准：event.data.chunk.type === 'text-delta' 时取 chunk.text。
 */
export function assistantTextOf(notification: unknown): string {
  if (typeof notification !== 'object' || notification === null) return ''
  const record = notification as { method?: unknown; params?: unknown }
  if (record.method !== 'session.event') return ''
  const params = record.params as { event?: unknown } | undefined
  if (typeof params?.event !== 'object' || params.event === null) return ''
  const event = params.event as { type?: unknown; data?: { chunk?: { type?: unknown; text?: unknown; delta?: unknown } } }
  if (event.type !== 'assistant/chunk') return ''
  const chunk = event.data?.chunk
  if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text
  if (typeof chunk?.delta === 'string') return chunk.delta
  return ''
}

// 注意：本文件编译产物位于 lib/types/（比 lib/ 深一层），5 级向上才到仓库根；
// 若调整 tsconfig 输出布局，需同步修改这里的层级。
const repoRoot = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))
// 开发态回退入口与随包入口是同一个文件（打包时 bundle/kernel/runtime 会被复制到运行时根）。
// 不能回退到 launcher/lib/bin-kernel.mjs：三层 bundle 补丁里的插件是裸包名，Node 按配置文件
// 所在目录解析，只有 bundle/kernel 声明了完整插件闭包（实测 launcher 那份报
// ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-spill-policy）。
const sourceKernelBin = 'products/bosom-friend/bundle/kernel/runtime/bin-kernel.mjs'

/**
 * 内核入口与工作目录。
 *
 * 打包态不能用仓库相对路径：安装版的 server 包住在
 * `%APPDATA%\<产品>\kernel-runtime\node_modules\...` 下，上面那个 repoRoot 会解析成
 * kernel-runtime 本身，拼出的仓库路径在安装版里并不存在，于是每次 AI 生成都在 spawn 阶段
 * 失败，界面只显示「大模型调用失败：DeepSeek Harness runtime…」。
 *
 * 桌面壳启动时注入 BF_KERNEL_ROOT，指向安装期解压好的内核运行时。运行时里有两个入口，
 * 不能取错：`runtime/bin-kernel.mjs` 是 SDK 客户端要的 stdio 内核；
 * `runtime/bin-desktop.mjs` 是完整桌面启动，它会去监听 31280，与已在运行的产品实例必然
 * EADDRINUSE（实测就是这个报错）。这里只取 bin-kernel.mjs，开发态再回退到仓库路径。
 *
 * @returns 入口脚本绝对路径与应作为 cwd 的目录。
 */
function kernelEntry(): { bin: string; cwd: string } {
  const root = process.env.BF_KERNEL_ROOT
  if (typeof root === 'string' && root !== '') {
    const packaged = resolve(root, 'runtime', 'bin-kernel.mjs')
    if (existsSync(packaged)) return { bin: packaged, cwd: root }
  }
  return { bin: resolve(repoRoot, sourceKernelBin), cwd: repoRoot }
}

/**
 * 内核运行时以官方 `dsh` profile 契约启动：入口自己解析 `--profile`/`--patch`
 * （见 launcher/src/bin-kernel.ts），SDK 客户端只负责按契约拼 argv。产品数据根不在
 * 这里决定——入口自己把 `BOSOM_FRIEND_HOME`/`DSH_HOME` 设为产品根。
 * @returns 启动入口的绝对路径与运行目录。
 */
function kernelLaunch(): { bin: string; cwd: string } {
  const entry = kernelEntry()
  return { bin: entry.bin, cwd: entry.cwd }
}

/**
 * 创建内核客户端。provider 先固定 deepseek-official；BYOK 自定义端点后续
 * 经官方 llm-pi-ai 适配器注册（见 ADR-001 与 REQ-016）。
 * @param options - 可选模型覆盖。
 */
export function createKernelClient(options?: KernelClientOptions): KernelClient {
  const byok = options?.baseUrl !== undefined && options?.apiKey !== undefined
  const provider = byok ? (options?.provider ?? 'agnes') : (options?.provider ?? 'deepseek-official')
  const model = byok ? (options?.model ?? 'agnes-2.5-flash') : (options?.model ?? 'deepseek-v4-flash')
  let client: HarnessClient | undefined
  let subscription: { close(): void; tryNext(): unknown } | undefined
  let initialized = false
  const ensure = async (): Promise<HarnessClient> => {
    if (client !== undefined && initialized) return client
    const launch = kernelLaunch()
    client ??= new HarnessClient({
      dshBin: launch.bin,
      profile: 'bosom-friend-kernel',
      processCwd: launch.cwd,
      ...byok ? { env: { ...process.env, AGNES_API_KEY: options?.apiKey } } : {},
    })
    let lastError: unknown
    let handshakeDone = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await client.initialize({ cwd: launch.cwd, provider, model })
        handshakeDone = true
        break
      } catch (error) {
        lastError = error
        // 适配器路由注册提交与握手之间的微时序竞态：任何握手错误先等待后重试。
        if (attempt === 2) {
          throw error
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      }
    }
    if (!handshakeDone) throw lastError
    initialized = true
    subscription = client.subscribe()
    return client
  }
  return {
    async prompt(prompt, onDelta, shouldAbort) {
      let collected = ''
      let sawIdle = false
      try {
        const active = await ensure()
        await active.prompt('ai-chat-' + Date.now(), [{ type: 'text', text: prompt }])
        const deadline = Date.now() + 120000
        while (!sawIdle && Date.now() < deadline && shouldAbort?.() !== true) {
          const notification = subscription?.tryNext()
          if (notification === undefined) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 50))
            continue
          }
          if (typeof notification === 'object' && notification !== null) {
            const record = notification as { method?: unknown; params?: unknown }
            if (record.method === 'session.status') {
              const params = record.params as { status?: unknown } | undefined
              if (params?.status === 'idle') sawIdle = true
            }
          }
          const delta = assistantTextOf(notification)
          if (delta !== '') {
            collected += delta
            onDelta?.(delta)
          }
        }
        return { text: collected }
      } catch (error) {
        return { text: '', error: error instanceof Error ? error.message : String(error) }
      }
    },
    async close() {
      subscription?.close()
      subscription = undefined
      await client?.close()
      client = undefined
      initialized = false
    },
  }
}
