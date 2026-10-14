#!/usr/bin/env node
/**
 * 把仓库的 presets/ 物化到运行期 home 的 .agent-presets/。
 *
 * 为什么需要（2026-10-12 编排层收敛时暴露的最大遗留）：
 *   内核读的工具面来自**运行期副本**（$BOSOM_FRIEND_HOME/.agent-presets/roles.json，
 *   默认 ~/.bosom-friend/.agent-presets），仓库里的 presets/ 只是「源」。
 *   此前两者靠**手工复制**保持一致，于是源改了运行期没改就成了常态：
 *     · steward 少 bosom_task_*（2026-10-12 发现）
 *     · operator 少 bosom_platform_sync_now
 *     · device 少 bosom_platform_login_start
 *   三次漂移都是同一类事故，所以把它变成启动链路的固定一步：
 *   **源永远是仓库，运行期是产物**。
 *
 * 路径口径与 bundle/kernel/runtime/bin-kernel.mjs 一致：BOSOM_FRIEND_HOME，否则 ~/.bosom-friend。
 * 故意**不读 DSH_HOME**：内核启动时第一件事就是把它覆盖成上面那个值（bin-kernel.mjs:18-20）。
 *
 * 幂等：内容相同不写盘。用法：node .../sync-presets.mjs [--quiet]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = join(HERE, '..', '..')
const PRESET_DIR = join(PRODUCT, 'presets')
const quiet = process.argv.includes('--quiet')

const home = (process.env.BOSOM_FRIEND_HOME ?? '').trim() !== ''
  ? process.env.BOSOM_FRIEND_HOME.trim()
  : join(homedir(), '.bosom-friend')
const target = join(home, '.agent-presets')

/** 要物化的文件：仓库源 → 运行期相对路径。 */
const pairs = [['roles.json', 'roles.json']]
const roles = JSON.parse(readFileSync(join(PRESET_DIR, 'roles.json'), 'utf8'))
for (const role of Object.keys(roles))
  pairs.push([join(role, 'agent.cordis.yml'), join(role, 'agent.cordis.yml')])
// none 不在 roles.json 里（它不是管家，没有工具面），但纯文本会话要 join 它，所以同样要物化。
pairs.push([join('none', 'agent.cordis.yml'), join('none', 'agent.cordis.yml')])

let copied = 0
let same = 0
const problems = []
for (const [rel, destRel] of pairs) {
  const src = join(PRESET_DIR, rel)
  const dest = join(target, destRel)
  if (!existsSync(src)) { problems.push('仓库缺少 ' + rel); continue }
  const want = readFileSync(src, 'utf8')
  const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null
  if (have === want) { same += 1; continue }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, want)
    copied += 1
    if (!quiet) console.log('  ' + (have === null ? '新增 ' : '更新 ') + destRel)
  }
  catch (error) {
    problems.push('写 ' + destRel + ' 失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 技能面按角色切开（2026-10-12）：把角色技能与跨管家通用技能也物化到运行期。
 *
 * 为什么需要：内核的技能目录由 skill-filesystem 扫出来，而它的默认根
 * （项目 `.agents/skills`、`$DSH_HOME/skills`）**不分角色**——实测 creator 任务里
 * 模型能加载到发布技能。切法是把专业管家的技能根换成
 * `.agent-presets/<role>/skills`（见 kernel/cordis.patch.yml 的 skill-filesystem 覆盖），
 * 这里负责把仓库的源物化过去：`presets/<role>/skills` → `<role>/skills`，
 * `skills` → `common/skills`。与 roles.json 同一条纪律：**源永远是仓库，运行期是产物**。
 *
 * @param srcDir - 仓库里的技能源目录（只取顶层 .md，与 provider 的发现口径一致）。
 * @param destDir - 运行期技能根目录。
 * @param label - 打印用的相对标签。
 */
function mirrorSkillDir(srcDir, destDir, label) {
  if (!existsSync(srcDir)) return
  let entries
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
  } catch (error) {
    problems.push('读 ' + label + ' 失败：' + (error instanceof Error ? error.message : String(error)))
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const want = readFileSync(join(srcDir, entry.name), 'utf8')
    const dest = join(destDir, entry.name)
    const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null
    if (have === want) { same += 1; continue }
    try {
      mkdirSync(destDir, { recursive: true })
      writeFileSync(dest, want)
      copied += 1
      if (!quiet) console.log('  ' + (have === null ? '新增 ' : '更新 ') + label + '/' + entry.name)
    }
    catch (error) {
      problems.push('写 ' + label + '/' + entry.name + ' 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

/**
 * 折叠标量还原：YAML 的 `>-` 把单个换行折成空格、空行折成换行。
 * @param lines - 已去掉缩进的正文行（空行保留为空串）。
 * @returns 折叠后的单段文本。
 */
function foldFoldedScalar(lines) {
  let text = ''
  let blanks = 0
  for (const line of lines) {
    if (line === '') { blanks += 1; continue }
    if (text === '') text = line
    else text += (blanks > 0 ? '\n'.repeat(blanks) : ' ') + line
    blanks = 0
  }
  return text
}

/**
 * 抽一份 preset 的 persona（agent.cordis.yml 里 persona 行的 prefix / suffix）。
 *
 * 形状固定（我们自己维护的 5 份文件），所以不引 YAML 解析器：
 * `    prefix: >-` 起，随后 6 空格缩进的行是正文，缩进更浅即结束。
 * @param role - 角色代号。
 * @returns `{prefix?, suffix?}`；文件缺失或没有 persona 段时返回 undefined。
 */
function readPersona(role) {
  const file = join(PRESET_DIR, role, 'agent.cordis.yml')
  if (!existsSync(file)) return undefined
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
  const persona = {}
  for (const key of ['prefix', 'suffix']) {
    const start = lines.findIndex(line => line === '    ' + key + ': >-')
    if (start < 0) continue
    const chunk = []
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') { chunk.push(''); continue }
      if (!/^ {6}/.test(line)) break
      chunk.push(line.trim())
    }
    persona[key] = foldFoldedScalar(chunk)
  }
  return Object.keys(persona).length === 0 ? undefined : persona
}

for (const role of Object.keys(roles)) mirrorSkillDir(join(PRESET_DIR, role, 'skills'), join(target, role, 'skills'), role + '/skills')
// 跨管家通用技能（handoff / truthful-report）：**拷进每个角色目录**，不放共享目录。
// 为什么不是 .agent-presets/common/skills：agent-presets 的 roster 把 .agent-presets/ 下的每个目录
// 都当成一个 preset（实测 roster 里出现过 "common"）——一个技能目录被当成 preset 迟早会咬人：
// 谁真去 join 它，技能面就静默变成「只有通用技能」。拷贝的代价只是一份产物重复，
// 源仍是仓库的 skills/ —— 与 roles.json 同一条纪律：源是仓库，运行期是产物。
for (const role of Object.keys(roles)) mirrorSkillDir(join(PRODUCT, 'skills'), join(target, role, 'skills'), role + '/skills(公共)')

// 人设（2026-10-12）：按角色物化，供内核入口在 boot 前读进 BF_AGENT_PERSONA_SUFFIX。
// 为什么必须物化：system-prompt 的 personaSuffix 走 !!js 表达式求值，而求值是同步的
// （new Function('ctx','expr','with(ctx){return eval(expr)}')），读不了文件；
// 所以人设文本由这里落盘、由启动器读进环境变量。源永远是 presets/<role>/agent.cordis.yml。
const personas = {}
for (const role of Object.keys(roles)) {
  const persona = readPersona(role)
  if (persona !== undefined) personas[role] = persona
}
const personaFile = join(target, 'personas.json')
const personaText = JSON.stringify(personas, null, 2) + '\n'
if (existsSync(personaFile) && readFileSync(personaFile, 'utf8') === personaText) {
  same += 1
} else {
  try {
    mkdirSync(target, { recursive: true })
    writeFileSync(personaFile, personaText)
    copied += 1
    if (!quiet) console.log('  更新 personas.json（' + String(Object.keys(personas).length) + ' 个角色）')
  } catch (error) {
    problems.push('写 personas.json 失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 旧技能位置迁移（2026-10-12）：$DSH_HOME/skills 里**本应用写的**技能，按名字归到
 * .agent-presets/<role>/skills/。
 *
 * 为什么放在这里：这是装机存量的一次性处置，而本脚本已经是「启动前把运行期准备到位」的
 * 那一步（dev-web.ps1 与装机脚本都调它）——放这里就不必新增启动步骤，而且幂等
 * （旧目录里没有受管文件时什么都不做）。
 *
 * 归类是**历史数据的处置**，不是常规逻辑：新技能由服务端按 sourceId 反查任务归属、直接
 * 落到该角色目录（见 server/src/agent-skills.ts 的 skillRoleOfRecord）；只有这批老文件
 * 没有那条线索，才按名字归类。判不准一律归总管——与「判不准不猜」同一条纪律。
 * 只动带 managed-by 标记的文件（与 curateSkills 同一判据）：技能根是用户的空间，
 * 他手写的技能不搬。
 */
const MANAGED_MARKER = 'managed-by: bosom-friend'
const LEGACY_ROLE_RULES = [
  ['operator', /sync|reconcile|reception|comment|metric|data/i],
  ['publisher', /publish|douyin|scheduled/i],
  ['device', /account|login|setting|profile/i],
  ['creator', /draft|copy|title|script|video|image|cover|封面|标题|文案/i],
]
/** 老技能按名字归角色；都不匹配时归总管（见上面「判不准一律归总管」）。 */
function legacyRoleOf(fileName) {
  for (const [role, pattern] of LEGACY_ROLE_RULES) if (pattern.test(fileName)) return role
  return 'steward'
}
const legacyDir = join(home, 'skills')
let migrated = 0
if (existsSync(legacyDir)) {
  for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const from = join(legacyDir, entry.name)
    let text = ''
    try {
      text = readFileSync(from, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(MANAGED_MARKER)) continue
    const role = legacyRoleOf(entry.name)
    const destDir = join(target, role, 'skills')
    const to = join(destDir, entry.name)
    if (existsSync(to)) continue
    try {
      mkdirSync(destDir, { recursive: true })
      renameSync(from, to)
      migrated += 1
      if (!quiet) console.log('  迁移 ' + entry.name + ' → ' + role + '/skills/')
    }
    catch (error) {
      problems.push('迁移 ' + entry.name + ' 失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

if (problems.length > 0) {
  console.log('SYNC_PRESETS_FAIL');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1)
}
console.log('SYNC_PRESETS_OK 已同步 ' + String(copied) + ' 个、未变 ' + String(same) + ' 个、迁移旧技能 ' + String(migrated) + ' 个 → ' + target)