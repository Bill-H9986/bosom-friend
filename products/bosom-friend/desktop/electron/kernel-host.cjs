/**
 * Official-kernel host for the Electron main process.
 *
 * Uses the official @deepseek-ai/dsh-sdk-client (ESM, loaded via dynamic import) to
 * own the kernel runtime's lifecycle. The child is a compiled runtime artifact, never a
 * source tree; in an Electron host the same binary runs as Node via ELECTRON_RUN_AS_NODE.
 */

const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const packaged = (() => {
  try {
    return require('electron').app.isPackaged
  }
  catch {
    return false
  }
})()

const kernelRoot = packaged
  ? (process.env.BF_KERNEL_ROOT || path.join(process.resourcesPath, 'kernel-runtime'))
  : path.join(repoRoot, 'products', 'bosom-friend')
// Development boots the same entry the deployed runtime ships (`bundle/kernel/runtime`), not
// the launcher copy: the three bundle patch layers name plugins as bare specifiers, and Node
// resolves them against the config file's directory. Only `bundle/kernel` declares the full
// plugin closure, so the launcher copy fails there with ERR_MODULE_NOT_FOUND.
const kernelBin = process.env.BF_KERNEL_BIN
  || (packaged
    ? path.join(kernelRoot, 'runtime', 'bin-desktop.mjs')
    : path.join(repoRoot, 'products', 'bosom-friend', 'bundle', 'kernel', 'runtime', 'bin-desktop.mjs'))
const runtimeNode = packaged
  ? path.join(process.resourcesPath, 'runtime', 'node.exe')
  : path.join(__dirname, '..', 'dist', 'runtime', 'node.exe')

/**
 * 内核子进程的 Node 参数。
 *
 * 低配档位按物理内存给出堆上限（perf-profile.cjs 计算，经 BF_PERF_CAPS 传入）：
 * 低内存机器上内核无上限增长会一路吃到换页——表现是整个系统卡死，而不只是内核变慢。
 * 未设置档位（开发态直接跑）时不加参数，保持 Node 默认行为。
 */
function nodeFlags() {
  try {
    const caps = JSON.parse(process.env.BF_PERF_CAPS ?? '')
    if (caps && Number.isFinite(caps.maxOldSpaceMb) && caps.maxOldSpaceMb > 0) {
      return ['--max-old-space-size=' + caps.maxOldSpaceMb]
    }
  }
  catch {
    // 档位缺失或格式不对：按 Node 默认值启动，不影响可用性。
  }
  return []
}

/** 内核运行时的启动规格：优先随包 Node（避免 Electron ABI 不匹配），失败时回退 Electron 自身 Node。 */
function launchSpec() {
  const flags = nodeFlags()
  if (fs.existsSync(runtimeNode)) {
    return { command: runtimeNode, args: [...flags, kernelBin], extraEnv: {} }
  }
  if (typeof process.versions.electron === 'string') {
    return { command: process.execPath, args: [...flags, kernelBin], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { command: process.execPath, args: [...flags, kernelBin], extraEnv: {} }
}

/** 给 Promise 加超时：内核子进程活着但一直不回应时，等待必须有界。 */
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Load the official SDK client from the copy this host can actually reach.
 *
 * Packaged: the kernel runtime unpacked next to the user data carries it at its top level,
 * because `bundle/kernel` declares it and `pnpm deploy` links the deploy root's direct
 * dependencies under `node_modules/@deepseek-ai`. Development: the repository has no
 * root-level link, so the workspace link inside the server package is the copy that exists.
 * The bare specifier stays as the fallback for a host that resolves it normally.
 *
 * @returns the loaded client module.
 */
async function loadSdkClient() {
  const candidates = packaged
    ? [path.join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')]
    : [path.join(
      repoRoot, 'products', 'bosom-friend', 'server', 'node_modules',
      '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js',
    )]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href)
    }
  }
  return import('@deepseek-ai/dsh-sdk-client')
}

async function createKernelHost(options = {}) {
  const sdkModule = await loadSdkClient()
  const { HarnessClient } = sdkModule
  const launch = launchSpec()

  // The launch spec is passed explicitly instead of through the profile options: the kernel
  // entry is a compiled artifact (`bin-desktop.mjs`) started by the runtime's own Node, and
  // the profile options pin the command to `process.execPath`, which in Electron means the
  // Electron binary and its Node ABI. `HarnessClient(options, runtime)` is the constructor
  // built for exactly this host shape.
  const client = new HarnessClient({}, {
    command: launch.command,
    args: launch.args,
    cwd: repoRoot,
    environment: () => ({
      ...process.env,
      ...launch.extraEnv,
      ...(options.env ?? {}),
    }),
    description: 'bosom-friend desktop kernel',
    initializeTimeoutMs: 120_000,
  })

  let subscription = null
  let closed = false

  return {
    /**
     * Complete the SDK initialize handshake; resolves with the runtime identity.
     *
     * 等待必须有界：子进程活着但不回应（运行时被安全软件卡住、解压不完整、协议不匹配）
     * 时，未加超时的等待会让启动页永远停在"等待初始化握手"，用户既进不去也看不到原因。
     * 超时不杀子进程——主进程随后仍会尝试接入已在服务的产品页，慢机器启动完还能用。
     *
     * @param timeoutMs - 三次尝试合计的等待预算；默认 120 秒。
     */
    async start() {
      const budgetMs = Number.isFinite(options.handshakeTimeoutMs) && options.handshakeTimeoutMs > 0
        ? options.handshakeTimeoutMs
        : 120_000
      const deadline = Date.now() + budgetMs
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        try {
          return await withTimeout(
            client.initialize({
              cwd: repoRoot,
              provider: options.provider ?? 'deepseek-official',
              model: options.model ?? 'deepseek-v4-flash',
            }),
            remaining,
            '内核初始化握手超时（' + Math.round(budgetMs / 1000) + ' 秒内没有收到内核响应）',
          )
        }
        catch (error) {
          lastError = error
          // 适配器路由注册提交与握手之间存在微时序竞态：任何握手错误先等待后重试。
          if (attempt === 2) {
            throw error
          }
          if (Date.now() + 400 >= deadline) break
          await new Promise((resolveWait) => setTimeout(resolveWait, 400))
        }
      }
      throw lastError ?? new Error('内核初始化握手超时（' + Math.round(budgetMs / 1000) + ' 秒内没有收到内核响应）')
    },
    /** Forward every SDK notification to the renderer-side callback. */
    subscribe(onNotification) {
      if (subscription !== null) {
        throw new Error('kernel host already subscribed')
      }
      subscription = client.subscribe()
      void (async () => {
        try {
          for await (const notification of subscription) {
            onNotification(notification)
          }
        }
        catch {
          // Runtime closed: the async iterator terminates; no further forwarding.
        }
      })()
      return subscription
    },
    /** Queue one prompt and return the durable inbox message id. */
    prompt(sessionId, contentBlocks) {
      return client.prompt(sessionId, contentBlocks)
    },
    /** Protocol shutdown followed by the client's EOF/TERM/KILL ladder. */
    async close() {
      if (closed) {
        return
      }
      closed = true
      if (subscription !== null) {
        subscription.close()
        subscription = null
      }
      await client.close()
    },
  }
}

module.exports = { createKernelHost, kernelBin, repoRoot }
