#!/usr/bin/env node
/**
 * 内核「模型可见面」冒烟（白盒、免 API Key）：按角色创建 agent、走**真实 preset mount**，
 * 打印运行期实际生效的技能目录、人设段、语境内核文件。
 *
 * 为什么必须走 mount：2026-10-12 起 host 的 skill-filesystem 已 disabled，技能面由
 * presets/<role>/agent.cordis.yml 的 skill-filesystem 行声明（只对该 agent 生效）。
 * 所以 boot 级列目录不再有意义——那样只会恒为 0，变成假红/假绿。
 * 这里用与 SDK server 完全同一条 setup（agentPresets.mount(agentCtx, id)）建 agent 再取值。
 *
 * 用法：node .../smoke-kernel-skills.mjs <role>     （role 缺省 steward；'none' = 不 join preset）
 * 输出：
 *   HOST_SKILL_FILESYSTEM disabled=true|false       （host 是否已收手）
 *   SKILLS role=… count=… / 一行一个 "名字 [来源]" / SKILLS_PUBLISHISH …
 *   PERSONA role=… prefixChars=… suffixChars=… prefixHead=…（preset 层的 deployment:persona-* 段）
 *   INSTRUCTIONS_CONFIG / INSTRUCTIONS configured|old-default files=[…]（语境内核读到的文件）
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'

// 'none' 用来显式跑「不 join preset」的调用方（纯文本会话等）：真实进程里它是「环境变量不存在」，
// 而 PowerShell 不把空字符串参数传给原生命令，所以这里用哨兵值。
const roleArg = (process.argv[2] ?? 'steward').trim()
const role = roleArg === 'none' ? '' : roleArg
process.env.BF_AGENT_ROLE = role
// 与 bin-kernel 同一口径：产品数据根是 BOSOM_FRIEND_HOME，否则 ~/.bosom-friend。
process.env.DSH_HOME = process.env.BOSOM_FRIEND_HOME && process.env.BOSOM_FRIEND_HOME.trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')

const require = createRequire(import.meta.url)
const patches = []
/** 基座层来自 node_modules（官方包，不改）；产品内核层读**仓库源**。 */
const layers = [
  ['@deepseek-ai/dsh-base', require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')],
  // node_modules 里的注入副本是构建产物：改完源不刷新副本就还是旧配置，白盒会得到假结论。
  ['@deepseek-ai/dsh-bosom-friend-kernel', fileURLToPath(new URL('../../kernel/cordis.patch.yml', import.meta.url))],
]
for (const [name, file] of layers) {
  const layer = loadOptionalPatches('bf-kernel-skills-' + role, file)
  if (layer !== undefined) patches.push(...layer)
}

// 两类行不属于本次判据，剔除：JSON-RPC 服务端占用 stdio；MCP 客户端会去 npx 拉 playwright。
// agent-presets 必须**留着**：本次冒烟要走真实的 mount。它能被解析到，是因为根配置取的是
// bundle/kernel/cordis.yml（该目录声明了 @deepseek-ai/dsh-agent-presets 依赖）。
const SKIP_ROWS = new Set([
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-mcp-client',
])
for (const entry of patches) {
  if (!Array.isArray(entry.insert)) continue
  entry.insert = entry.insert.filter((row) => !SKIP_ROWS.has(row.name))
}

// 根配置决定插件名的解析基准：loader 以 config 文件所在目录解析每一行的 name，
// 所以这里用 bundle/kernel 的根配置（该目录有自己的完整 node_modules）。
const config = fileURLToPath(new URL('../../bundle/kernel/cordis.yml', import.meta.url))
const ctx = await boot('bf-kernel-skills-' + role, config, patches)

// host 层是否已收手：技能面住 preset 的前提，配置层证据。
const hostRow = patches.find((entry) => entry.id === 'skill-filesystem')
console.log('HOST_SKILL_FILESYSTEM disabled=' + String(hostRow?.disabled === true))

// ---------------------------------------------------------------------------
// 技能面与人设：走真实 mount 路径（与 packages/sdk/server/src/server.ts 的 createSession 同一条 setup）
// ---------------------------------------------------------------------------
// 会话 id 必须唯一：agents.create 会把会话持久化到 $DSH_HOME/sessions，
// 同一 id 第二次运行会撞 SessionAlreadyExistsError（实测）。
const sessionId = 'smoke-' + (role === '' ? 'none' : role) + '-' + Date.now().toString(36)
const handle = await ctx.get('agents').create({
  sessionId,
  meta: { cwd: process.cwd() },
  ...(role === '' ? {} : {
    setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, role) },
  }),
})

const skills = await ctx.get('skills').list({ cwd: process.cwd(), scope: handle.agent })
const rows = skills.map((skill) => skill.name + ' [' + skill.source + ']').sort()
console.log('SKILLS role=' + role + ' count=' + String(rows.length) + ' cwd=' + process.cwd())
for (const row of rows) console.log('  ' + row)
const publish = rows.filter((row) => row.startsWith('bosom-friend-publish') || row.startsWith('publish-draft-to-douyin') || row.startsWith('draft-to-douyin') || row.startsWith('video-gen-publish') || row.startsWith('scheduled-draft') || row.startsWith('draft-scheduled'))
console.log('SKILLS_PUBLISHISH role=' + role + ' count=' + String(publish.length))

// 人设：preset 的 persona 行注册在 agent 的 scope 上，所以 assemble 必须带 scope——
// 不带 scope 读到的是部署级那份，会得出「人设没生效」的错误结论。
const assembly = await ctx.get('systemPrompt').assemble({ scope: handle.agent })
const prefixText = assembly.sections.find((section) => section.name === 'deployment:persona-prefix')?.text ?? ''
const suffixText = assembly.sections.find((section) => section.name === 'deployment:persona-suffix')?.text ?? ''
console.log('PERSONA role=' + role + ' prefixChars=' + String(prefixText.length) + ' suffixChars=' + String(suffixText.length))
console.log('PERSONA_PREFIX_HEAD role=' + role + ' ' + JSON.stringify(prefixText.split('\n')[0].slice(0, 80)))

// ---------------------------------------------------------------------------
// 语境内核（agent-instructions）：它不走 system prompt 的 section，而是作为**会话 baseline 消息**
// 进 agent inbox（packages/context/agent-instructions/src/index.ts 的 compose()），所以上面的
// assemble() 看不到它。这里按**同一份补丁配置**在真实 cwd 上重放它的发现逻辑，打印真正会读进
// 模型的语境内文件；并用旧候选名做负向对照——证明这条判据认得出「配置没挪对时会读进仓库 AGENTS.md」。
// ---------------------------------------------------------------------------
const bundleRequire = createRequire(fileURLToPath(new URL('../../bundle/kernel/package.json', import.meta.url)))
const { discoverBaselineInstructionFiles } = await import(
  pathToFileURL(bundleRequire.resolve('@deepseek-ai/dsh-agent-instructions')).href
)
const row = patches.find((entry) => entry.id === 'agent-instructions')
const rowConfig = row?.config ?? {}
console.log('INSTRUCTIONS_CONFIG role=' + role + ' ' + JSON.stringify(rowConfig))
const cases = [
  ['configured', rowConfig.instructionFileCandidates, rowConfig.localInstructionFileCandidates],
  ['old-default', ['AGENTS.md', 'CLAUDE.md'], []],
]
for (const [label, instructionFileCandidates, localInstructionFileCandidates] of cases) {
  const found = await discoverBaselineInstructionFiles({
    cwd: process.cwd(),
    dshHome: process.env.DSH_HOME,
    instructionFileCandidates,
    localInstructionFileCandidates,
  })
  const list = found.map((file) => file.displayPath).sort()
  console.log('INSTRUCTIONS ' + label + ' count=' + String(list.length) + ' files=' + JSON.stringify(list))
}

await handle.dispose()
await ctx.fiber.dispose()
process.exit(0)
