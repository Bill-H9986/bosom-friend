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
  /**
   * 这一轮的正文增量流（模型真实时间戳）：厂商不发增量时由调用方按它回放，
   * 用户看到的是"一个字一个字出来"，而不是等半天一下蹦出整段。
   *
   * 只在拿到完整正文时有值；空数组表示这次没有可回放的增量。
   */
  stream?: KernelTextStreamPart[]
}

export interface KernelClient {
  /**
   * 把一段用户输入送进官方内核，逐增量回调；返回聚合文本或错误。
   *
   * @param prompt - 用户输入（多轮对话时由调用方拼成完整上下文，见 `chatTranscript`）。
   * @param onDelta - 每个文本增量的回调。
   * @param shouldAbort - 返回 true 时立即停止等待并放弃本轮剩余输出（调用方随后 close 掉内核）。
   *
   * 多轮上下文**不经过内核会话**：一个内核进程只服务一次请求，而内核的会话注册表是进程内的，
   * 跨请求复用同一个 session id 会以 `session "…" already exists` 整轮失败（实测 2026-09-21）。
   * 调用方把整段历史折进 `prompt`（见 {@link chatTranscript}），这一层只负责把一段文本送进去。
   */
  prompt(
    prompt: string,
    onDelta?: (text: string) => void,
    shouldAbort?: () => boolean,
    onStep?: (step: KernelAgentStep) => void,
  ): Promise<KernelPromptResult>
  /** 关闭内核子进程（协议 shutdown）。 */
  close(): Promise<void>
  /**
   * 预热：把内核子进程与握手提前做掉，让用户第一次说话时不再等冷启动。
   *
   * 为什么需要（DEF-271，2026-10-12 实测）：装机版上「手工皮具」类 11 条任务里 **5 条**报
   * `initialize timed out after 10000ms waiting for dsh profile "bosom-friend-kernel"`——
   * 内核要加载 46 个工具与整棵插件树，冷启动经常超过 SDK 的 10 秒握手上限；
   * 不预热就必然把这份代价转嫁给用户的第一次对话（失败率实测 45%）。
   *
   * 失败**不抛**：预热只是优化；失败时保持未初始化，让首次 prompt 照旧走冷启动。
   */
  warmUp(): Promise<void>
}

/** 内核客户端可选配置：提供 baseUrl/apiKey 时走用户自定义网关（agnes 路由）。 */
export interface KernelClientOptions {
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  /**
   * 会话 id：**同一个 id 的多次 prompt 进同一个会话**（历史、压缩、标题都在内核侧）。
   *
   * 为什么需要它：不给 id 时每次 prompt 都开一个新会话，多轮对话的上下文只能由调用方
   * 折成文本重发（上限 12000 字，且每轮重发一次，长对话的成本是平方级）。
   * 给了 id 之后，调用方只送**本轮这一句**，前几轮由会话承担。
   *
   * 约束：会话注册表在**进程内**——同一个进程里重复用同一个 id 是允许的（服务端会取回既有会话），
   * 但持久化日志已经存在的 id 在**新进程**里创建会失败（`session "…" already exists`，实测）。
   * 因此调用方必须在"进程还活着"的前提下复用，进程换掉之后要换 id 并重新喂一次历史。
   */
  sessionId?: string
  /**
   * 这次调用是**纯文本生成**（写稿 / 改写 / 检查…）：内核侧据此不挂载任何工具。
   *
   * 为什么走环境变量而不是参数：工具面是**进程级**的（补丁层在启动时决定挂哪些插件），
   * 而内核客户端一次调用就是一个进程——所以"这次要不要工具"只能在这一层说。
   */
  textOnly?: boolean
  /**
   * 管家角色：注入内核的 BF_AGENT_ROLE，决定这次会话的**工具面**（见 presets/roles.json）。
   *
   * 为什么和 textOnly 一样走环境变量：工具面是**进程级**的（补丁层在启动时决定挂哪些插件），
   * 而一次内核调用就是一个进程——「这次归哪个管家」只能在这一层说。
   */
  role?: string
}

/** 一轮对话。 */
export interface ChatTurn {
  /** 说话的人：用户或助手（其余角色不进上下文）。 */
  role: string
  content: string
}

/**
 * 一次对话最多带多少字的历史：超出就从头截断，只留最近的部分。
 *
 * 为什么要有上限：多轮对话会把整段历史每轮重发一次，长对话的成本与延迟是平方级增长的。
 * 12000 字约等于十几轮正常问答——足够"接着说""再改改"这类追问，又不至于让一次提问变贵。
 */
export const CHAT_CONTEXT_MAX_CHARS = 12_000

/**
 * 把前端送来的消息数组折成一段提示词文本（多轮上下文）。
 *
 * 为什么是这段文本而不是分别发送：内核客户端只接受一段文本输入，且本产品在它前面还要拼
 * 系统规则与知识块——分角色发送会绕开这一层。折成文本后，"谁说的"由行首标签表达，
 * 模型对 `用户：/助手：` 这种对话稿的读取是稳的。
 *
 * 只保留用户与助手两种角色：系统提示由本产品的规则块统一给，前端再塞一份会与它打架。
 *
 * @param messages - 前端送来的消息（按时间顺序）。
 * @returns 折好的对话文本；没有可用消息时为空串。
 */
export function chatTranscript(messages: ChatTurn[] | undefined): string {
  const usable = (messages ?? [])
    .filter(item => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim() !== '')
    .map(item => (item.role === 'user' ? '用户：' : '助手：') + item.content.trim())
  if (usable.length === 0) return ''
  // 从后往前取到预算为止：宁可丢掉最早的几轮，也不能丢掉"刚刚说的那句"。
  const kept: string[] = []
  let used = 0
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const line = usable[i]!
    if (used + line.length > CHAT_CONTEXT_MAX_CHARS && kept.length > 0) break
    kept.unshift(line)
    used += line.length
  }
  return kept.join('\n')
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
/**
 * 从一条 SDK 通知中提取整段 assistant 文本；只认 assistant/message 里的 text 块。
 *
 * 与 {@link assistantTextOf} 是两条互补通道，不是重复实现：实测 agnes 系列模型
 * （api: openai-completions）**不发 assistant/chunk 的 text-delta**，正文只出现在
 * 回合结束的 assistant/message.content[].text 里。只收增量会让每个请求都空手而归，
 * 界面表现为等满超时后报「未知错误」（DEF-072）。
 *
 * 工具回合同样会发 assistant/message，但它的 content 只有 tool-call 块（没有 text），
 * 所以这里对工具回合天然返回空串；调用方按「后来者覆盖」保留最后一个文本块，即最终答复。
 *
 * @param notification - 一条 SDK 通知。
 * @returns 该通知携带的整段文本；非 assistant/message 或没有 text 块时为空串。
 */
export function assistantMessageTextOf(notification: unknown): string {
  if (typeof notification !== 'object' || notification === null) return ''
  const record = notification as { method?: unknown, params?: unknown }
  if (record.method !== 'session.event') return ''
  const params = record.params as { event?: unknown } | undefined
  if (typeof params?.event !== 'object' || params.event === null) return ''
  const event = params.event as { type?: unknown, data?: { message?: { content?: unknown } } }
  if (event.type !== 'assistant/message') return ''
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block): string[] => {
      const item = block as { type?: unknown, text?: unknown }
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    })
    .join('')
}


/** 内核会话里的一次工具调用（模型决定"动手"的那一刻）。 */
export interface KernelToolCall {
  /** 调用 id：与它的 tool/result 配对。 */
  callId: string
  /** 工具名（产品工具以 bosom_ 开头，其余是官方内核自带工具）。 */
  name: string
  /** 模型给的原始参数 JSON 字符串（未解析，原样展示给用户）。 */
  arguments: string
}

/** 内核会话里的一次工具结果。 */
export interface KernelToolResult {
  /** 对应的调用 id。 */
  callId: string
  /** 结果的文本内容。 */
  text: string
  /** 工具自己报了失败。 */
  isError: boolean
}

/**
 * 正文增量流的一段：`afterMs` 是它相对上一段的等待毫秒数。
 *
 * 为什么需要它：厂商网关（agnes，openai-completions）**不发 text-delta**，
 * 正文只在回合结束的 assistant/message 里——用户看到的就是"等半天然后答案一下蹦出来"。
 * 而 assistant/message 里带着**模型真实的增量时间戳**（Session v2 的 `stream` 字段），
 * 按它回放就是模型自己的出字节奏，不是我们编的打字机。
 */
export interface KernelTextStreamPart {
  /** 这一段的文本。 */
  text: string
  /** 相对上一段的等待毫秒数（首段相对本轮开始）。 */
  afterMs: number
}

/** 一轮内核回合里给调用方的过程事件（除了正文增量之外的那些）。 */
export type KernelAgentStep =
  | { kind: 'tool-call', call: KernelToolCall }
  | { kind: 'tool-result', result: KernelToolResult }

/**
 * 从一条 SDK 通知里提取工具调用；不是 tool/call 时返回 null。
 *
 * 形状以实测为准（2026-09-22 真实内核会话）：
 * `event.type === 'tool/call'`，`data = { turn, step, callId, name, arguments }`。
 *
 * @param notification - 一条 SDK 通知。
 * @returns 工具调用；非 tool/call 或无 callId 时为 null。
 */
export function toolCallOf(notification: unknown): KernelToolCall | null {
  if (typeof notification !== 'object' || notification === null) return null
  const record = notification as { method?: unknown, params?: unknown }
  if (record.method !== 'session.event') return null
  const event = (record.params as { event?: unknown } | undefined)?.event as
    | { type?: unknown, data?: { callId?: unknown, name?: unknown, arguments?: unknown } }
    | undefined
  if (event?.type !== 'tool/call') return null
  const callId = event.data?.callId
  const name = event.data?.name
  if (typeof callId !== 'string' || callId === '' || typeof name !== 'string' || name === '') return null
  return {
    callId,
    name,
    arguments: typeof event.data?.arguments === 'string' ? event.data.arguments : '',
  }
}

/**
 * 从一条 SDK 通知里提取工具结果；不是 tool/result 时返回 null。
 *
 * 结果的形状实测为 `data.message.content[0].content[0].text`（tool-result 块套 text 块），
 * 与 assistant/message 的正文块同构，所以这里复用同一套"取 text 块"的读法。
 *
 * @param notification - 一条 SDK 通知。
 * @returns 工具结果；非 tool/result 时为 null。
 */
export function toolResultOf(notification: unknown): KernelToolResult | null {
  if (typeof notification !== 'object' || notification === null) return null
  const record = notification as { method?: unknown, params?: unknown }
  if (record.method !== 'session.event') return null
  const event = (record.params as { event?: unknown } | undefined)?.event as
    | { type?: unknown, data?: { message?: { content?: unknown } } }
    | undefined
  if (event?.type !== 'tool/result') return null
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return null
  let callId = ''
  let text = ''
  let isError = false
  for (const block of blocks) {
    const item = block as { type?: unknown, toolCallId?: unknown, content?: unknown, isError?: unknown }
    if (item.type !== 'tool-result') continue
    if (typeof item.toolCallId === 'string') callId = item.toolCallId
    if (item.isError === true) isError = true
    if (Array.isArray(item.content)) {
      for (const inner of item.content) {
        const part = inner as { type?: unknown, text?: unknown }
        if (part.type === 'text' && typeof part.text === 'string') text += part.text
      }
    }
    else if (typeof item.content === 'string') {
      text += item.content
    }
  }
  return callId === '' ? null : { callId, text, isError }
}

/**
 * 从一条 assistant/message 通知里取出**带时间的正文增量**；没有可用增量时返回空数组。
 *
 * 只认 `text-chunks` 这类压缩记录（Session v2 把一次流的增量打包进这一条事件），
 * 以及未被打包的裸 `chunk`（text-delta）。两类都按原时间戳还原成"等多久、出多少字"。
 *
 * @param notification - 一条 SDK 通知。
 * @returns 按顺序排列的增量段；非 assistant/message 或没有增量时为空数组。
 */
export function assistantStreamPartsOf(notification: unknown): KernelTextStreamPart[] {
  if (typeof notification !== 'object' || notification === null) return []
  const record = notification as { method?: unknown, params?: unknown }
  if (record.method !== 'session.event') return []
  const event = (record.params as { event?: unknown } | undefined)?.event as
    | { type?: unknown, data?: { stream?: unknown } }
    | undefined
  if (event?.type !== 'assistant/message') return []
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return []
  const parts: KernelTextStreamPart[] = []
  let cursor: number | undefined
  for (const item of stream) {
    const entry = item as {
      type?: unknown
      time?: unknown
      time0?: unknown
      dt?: unknown
      texts?: unknown
      chunk?: { type?: unknown, text?: unknown }
    }
    if (entry.type === 'text-chunks' && Array.isArray(entry.texts)) {
      let at = typeof entry.time0 === 'number' ? entry.time0 : cursor ?? 0
      entry.texts.forEach((text, index) => {
        if (typeof text !== 'string' || text === '') return
        const gap = Array.isArray(entry.dt) && typeof entry.dt[index] === 'number' ? entry.dt[index] as number : 0
        at += gap
        parts.push({ text, afterMs: cursor === undefined ? 0 : Math.max(0, at - cursor) })
        cursor = at
      })
      continue
    }
    if (entry.type === 'chunk' && entry.chunk?.type === 'text-delta' && typeof entry.chunk.text === 'string') {
      const at = typeof entry.time === 'number' ? entry.time : cursor ?? 0
      parts.push({ text: entry.chunk.text, afterMs: cursor === undefined ? 0 : Math.max(0, at - cursor) })
      cursor = at
    }
  }
  return parts
}


/** 回放的总时间预算（毫秒）：用户已经等过模型一次，不该再按原速等第二遍。 */
export const REPLAY_TOTAL_BUDGET_MS = 2500
/** 回放时单帧最长等待（毫秒）：模型在思考处停顿很久时，回放不该真的卡住。 */
export const REPLAY_MAX_GAP_MS = 120
/** 回放的最大帧数：帧太密对 SSE 与重渲染都是负担，宁可每帧多几个字。 */
export const REPLAY_MAX_FRAMES = 120

/** 一帧回放：先等 `waitMs`，再把 `text` 推给界面。 */
export interface KernelReplayFrame {
  /** 这一帧的文本（原顺序拼接，一字不改）。 */
  text: string
  /** 发出这一帧前等待的毫秒数。 */
  waitMs: number
}

/**
 * 把模型真实的增量流压成"回放节拍"。
 *
 * 为什么需要压缩而不是原速回放：真实增量跨度可能是十几秒（模型想得久），而用户已经为这一整段
 * 等过一次。回放要做的是"让正文逐字出现"，不是让他再等一遍——所以总预算与单帧等待都设上限，
 * **文本与顺序一字不动**。
 *
 * @param parts - {@link assistantStreamPartsOf} 给出的真实增量。
 * @returns 回放帧；没有增量时为空数组。
 */
export function replayFrames(parts: readonly KernelTextStreamPart[]): KernelReplayFrame[] {
  const usable = parts.filter(part => part.text !== '')
  if (usable.length === 0) return []
  // 先按帧数上限合并：每 frameCount 段合成一帧，段间等待求和。
  const groupSize = Math.ceil(usable.length / REPLAY_MAX_FRAMES)
  const groups: KernelTextStreamPart[] = []
  for (let i = 0; i < usable.length; i += groupSize) {
    const slice = usable.slice(i, i + groupSize)
    groups.push({
      text: slice.map(part => part.text).join(''),
      afterMs: slice.reduce((total, part) => total + part.afterMs, 0),
    })
  }
  const totalWait = groups.reduce((total, group) => total + group.afterMs, 0)
  const scale = totalWait > REPLAY_TOTAL_BUDGET_MS ? REPLAY_TOTAL_BUDGET_MS / totalWait : 1
  return groups.map((group, index) => ({
    text: group.text,
    // 首帧不等待：模型已经出完了，第一帧立刻显示，"等半天还是空白"是最糟的观感。
    waitMs: index === 0 ? 0 : Math.max(8, Math.min(REPLAY_MAX_GAP_MS, Math.round(group.afterMs * scale))),
  }))
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
 * 创建内核客户端。
 *
 * APP 的官方大模型支持厂商是 **Agnes AI**：无论有没有用户密钥，默认路由与默认模型都是 Agnes
 * （`agnes` 路由 + `agnes-2.5-flash`）——不再有"没配 Key 就走别家内置模型"的第二套默认，
 * 文本/图片/视频因此是同一家厂商、同一把 Key。
 *
 * @param options - 可选模型覆盖（设置页当前生效提供方与密钥）。
 */
export function createKernelClient(options?: KernelClientOptions): KernelClient {
  const byok = options?.baseUrl !== undefined && options?.apiKey !== undefined
  const provider = options?.provider ?? 'agnes'
  const model = options?.model ?? 'agnes-2.5-flash'
  let client: HarnessClient | undefined
  let subscription: { close(): void; tryNext(): unknown } | undefined
  let initialized = false
  const hasRole = options?.role !== undefined && options.role !== ''
  const ensure = async (): Promise<HarnessClient> => {
    if (client !== undefined && initialized) return client
    const launch = kernelLaunch()
    client ??= new HarnessClient({
      dshBin: launch.bin,
      profile: 'bosom-friend-kernel',
      processCwd: launch.cwd,
      // 只有真要传东西时才给 env（不给就沿用进程继承，保持与以前完全一致）。
      ...(byok || options?.textOnly === true || hasRole)
        ? {
            env: {
              ...process.env,
              // 2026-10-12 修：内核里真正干活的是 settings.yaml 注册的 `bf-agnes-builtin`
              // （它的 apiKeyEnv 是 BF_AGNES_BUILTIN_API_KEY），而这里此前只注入 AGNES_API_KEY——
              // 那是 cordis 补丁层里另一个 provider 的名字。两个名字对不上，内核就拿不到钥匙：
              // 走 ctx.llm.stream 的写稿类工具会以「未知错误。请检查 API 地址、密钥和模型名后重试」
              // 失败，而走回环 HTTP 的只读工具完全不受影响——这正是 2026-10-12 端到端
              // 「只读 10/13 过、写链路全挂」的形状。实测：同一把钥匙直连厂商
              // /v1/models 与 /v1/chat/completions 均为 HTTP 200。
              ...byok
                ? { AGNES_API_KEY: options?.apiKey, BF_AGNES_BUILTIN_API_KEY: options?.apiKey }
                : {},
              ...options?.textOnly === true ? { BF_TEXT_ONLY: '1' } : {},
              ...hasRole ? { BF_AGENT_ROLE: String(options?.role) } : {},
            },
          }
        : {},
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
    async warmUp() {
      try {
        await ensure()
      } catch {
        // 预热失败不影响可用性：首次 prompt 会照旧冷启动并如实报错（DEF-271）。
      }
    },
    async prompt(prompt, onDelta, shouldAbort, onStep) {
      let collected = ''
      // 整段通道暂存：agnes 不发增量，正文只在 assistant/message 里（见 assistantMessageTextOf）。
      // 一个回合可能有多条 assistant/message（工具回合只有 tool-call 块），后到的文本覆盖先到的。
      let wholeMessage = ''
      // 与正文一起到达的**带时间增量**：只有正文那一条 message 才有，回放靠它。
      let streamParts: KernelTextStreamPart[] = []
      let sawIdle = false
      try {
        const active = await ensure()
        // 会话 id 每轮唯一（内核侧只认进程内注册表，同名会直接抛错，见接口注释）。
        // 给了 sessionId 就用它（同进程内续轮 = 真正的会话上下文）；没给就每轮一个新会话。
        const sessionId = options?.sessionId !== undefined && options.sessionId !== ''
          ? options.sessionId
          : 'turn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        await active.prompt(sessionId, [{ type: 'text', text: prompt }])
        // 上限按最慢的真实用途取：18 镜分镜表是单次较长输出，厂商网关下实测十几秒到一分钟，
        // 留足余量，避免慢响应被误判成空手而归（原 120 秒在多轮工具调用时会先超时）。
        const deadline = Date.now() + 240000
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
          // 工具调用与结果：这是"智能体在做什么"的可见过程，与正文走同一条通知通道。
          const call = toolCallOf(notification)
          if (call !== null) {
            onStep?.({ kind: 'tool-call', call })
            continue
          }
          const result = toolResultOf(notification)
          if (result !== null) {
            onStep?.({ kind: 'tool-result', result })
            continue
          }
          const delta = assistantTextOf(notification)
          if (delta !== '') {
            collected += delta
            onDelta?.(delta)
            continue
          }
          const whole = assistantMessageTextOf(notification)
          if (whole !== '') {
            wholeMessage = whole
            // 增量时间戳只在有正文的那条 message 上，与正文一起替换，避免张冠李戴。
            streamParts = assistantStreamPartsOf(notification)
          }
        }
        // 增量通道优先：只有真流式时它才是完整正文。厂商网关一次性返回整段，
        // 此时增量通道全程为空，必须回落到整段通道，否则调用方只会拿到空串。
        if (collected === '') {
          collected = wholeMessage
          // 有带时间的增量时**不**把整段当一次增量转发：调用方按真实时间戳回放（逐字出现），
          // 直接推一整段正是用户口径的"一下蹦出答案"。只有连时间戳都没有时才退化成整段。
          if (collected !== '' && streamParts.length === 0) onDelta?.(collected)
        }
        return { text: collected, stream: streamParts }
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
