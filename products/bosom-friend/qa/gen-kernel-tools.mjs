#!/usr/bin/env node
/**
 * 内核工具投影生成器：\`server/src/capabilities.ts\`（登记表，唯一事实源）→
 * \`kernel/src/generated-tools.ts\` 的 \`CAPABILITIES\` 常量。
 *
 * 为什么必须有它：投影此前是**手抄副本**——登记表改了不会传到投影，模型看到旧工具名、覆盖率按旧名单算，
 * 都是**静默**错（2026-10-12 真实发生过：投影落后 1 条，人工补的）。生成器把这条链变成单向：
 * 登记表改 → 跑一次 → 投影跟上；投影被人手改 → \`--check\` 当场红。
 *
 * 用法：
 *   node qa/gen-kernel-tools.mjs                      生成（只重写 CAPABILITIES 段，其余原样保留）
 *   node qa/gen-kernel-tools.mjs --check              只比对不写；有漂移 exit 1（可当门禁用）
 *   node qa/gen-kernel-tools.mjs --registry <path>    换一份登记表（自测 / 演示用）
 *   node qa/gen-kernel-tools.mjs --quiet              生成时不打印
 *
 * 两条不能碰的约束：
 *   ① **幂等**：渲染是纯函数（登记表 → 文本），连跑两次逐字节一致（sha256 相同）；
 *   ② **保留字面量**：条目里必须有 \`tool: 'bosom_xxx'\` 文本——qa/verify-kernel-tools.mjs 的
 *      readGeneratedToolNames() 用**正则**读它，把生成式工具整类登记为「只验注册不执行」；
 *      改成 import 派生会让这条安全网变瞎（那 73 条 execute 是裸代理服务端写接口，真跑会真发布）。
 *
 * 顺带消费登记表的 {@link TOOL_SELECTION_GUIDE}：按工具名把「该用它 / 别用它」拼进 description。
 * 不拼的话那 8 组易混指引只躺在登记表里，模型挑工具时看不到（2026-10-12 端到端实测：问「最近有哪些生成记录」，
 * 模型调了长视频任务工具）。指引文本由登记表给出，本文件只做拼接。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
/** 默认登记表：能力登记表是投影的唯一事实源。 */
const DEFAULT_REGISTRY = join(PRODUCT, 'server', 'src', 'capabilities.ts')
/** 被生成的投影文件。 */
const PROJECTION = join(PRODUCT, 'kernel', 'src', 'generated-tools.ts')
/** CAPABILITIES 段的起始锚点（段内只有生成出来的条目行）。 */
const SECTION_START = 'export const CAPABILITIES: CapabilityRow[] = ['
/** CAPABILITIES 段的结束锚点：段尾第一个行首 \`]\`。 */
const SECTION_END = '\n]'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法：node qa/gen-kernel-tools.mjs [--check] [--registry <path>] [--quiet]')
  process.exit(0)
}
const check = argv.includes('--check')
const quiet = argv.includes('--quiet')
const registryAt = argv.indexOf('--registry')
if (registryAt >= 0 && (argv[registryAt + 1] === undefined || argv[registryAt + 1].startsWith('--'))) {
  console.error('GEN_KERNEL_TOOLS_FAIL --registry 后面要跟一个文件路径')
  process.exit(2)
}
const registryPath = registryAt >= 0 ? resolve(argv[registryAt + 1]) : DEFAULT_REGISTRY

/**
 * 单引号字符串字面量（与投影既有风格一致：字段值用单引号，内部单引号与反斜杠转义）。
 * @param {unknown} value - 任意值。
 * @returns {string} 可直接写进源码的字面量。
 */
function quote(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

/**
 * 示例值字面量：字符串用 JSON 双引号（空串就是 ""），数字与布尔原样。
 * @param {unknown} value - 登记表里的 sample。
 * @returns {string} 可直接写进源码的字面量。
 */
function sampleLiteral(value) {
  return JSON.stringify(value)
}

/**
 * 一个入参的字面量（字段顺序固定；\`inPath\` 只在真时写出来，与登记表缺省语义一致）。
 * @param {object} param - 登记表的 CapabilityParam。
 * @returns {string} 字面量。
 */
function paramLiteral(param) {
  return '{ name: ' + quote(param.name) + ', type: ' + quote(param.type)
    + ', required: ' + String(param.required === true)
    + ', description: ' + quote(param.description)
    + ', sample: ' + sampleLiteral(param.sample)
    + (param.inPath === true ? ', inPath: true' : '') + ' }'
}

/**
 * 入参数组的字面量。
 * @param {Array<object>} list - 登记表的 params。
 * @returns {string} 字面量。
 */
function paramsLiteral(list) {
  return '[' + list.map(paramLiteral).join(', ') + ']'
}

/**
 * 按工具名取选择指引（一个工具可能命中多组）。
 * @param {string} tool - 工具名。
 * @param {Array<object>} guide - 登记表的 TOOL_SELECTION_GUIDE。
 * @returns {string} 拼好的指引句子；没有命中就返回空串。
 */
function guideText(tool, guide) {
  const parts = []
  for (const group of guide) {
    const use = group.useWhen === undefined ? undefined : group.useWhen[tool]
    const avoid = group.avoidWhen === undefined ? undefined : group.avoidWhen[tool]
    if (use === undefined && avoid === undefined) continue
    const bits = []
    if (use !== undefined) bits.push('该用它：' + use)
    if (avoid !== undefined) bits.push('不该用它：' + avoid)
    parts.push('【挑工具·' + group.topic + '】' + bits.join('；'))
  }
  return parts.join('')
}

/**
 * 一条登记 → 投影里的一行（字段顺序固定：改顺序会让 --check 恒红）。
 *
 * method/path 由 route 拆出（登记表只有「METHOD 路径」两段），保持与既有投影一致。
 * @param {object} row - 登记表的 Capability。
 * @param {Array<object>} guide - 选择指引。
 * @returns {string} 一行字面量（含缩进与尾逗号）。
 */
function renderRow(row, guide) {
  const space = row.route.indexOf(' ')
  const method = space < 0 ? row.route : row.route.slice(0, space)
  const path = space < 0 ? '' : row.route.slice(space + 1)
  let line = '  { id: ' + quote(row.id) + ', tool: ' + quote(row.tool) + ', role: ' + quote(row.role)
    + ', description: ' + quote(row.description + guideText(row.tool, guide))
    + ', exists: ' + String(row.exists === true)
    + ', route: ' + quote(row.route)
    + ', source: ' + quote(row.source)
    + ', kind: ' + quote(row.kind)
    + ', toolizable: ' + String(row.toolizable === true)
    + ', method: ' + quote(method)
    + ', path: ' + quote(path)
  if (row.note !== undefined) line += ', note: ' + quote(row.note)
  if (row.params !== undefined) line += ', params: ' + paramsLiteral(row.params)
  return line + ' },'
}

/**
 * 渲染整个 CAPABILITIES 段。
 * @param {Array<object>} rows - 登记表的 CAPABILITIES。
 * @param {Array<object>} guide - 选择指引。
 * @returns {string} 段文本（含起止行）。
 */
function renderSection(rows, guide) {
  return SECTION_START + '\n' + rows.map(row => renderRow(row, guide)).join('\n') + '\n]'
}

/**
 * 把渲染好的段替换进投影全文（其余内容——判据、闸门、注释——逐字保留）。
 * @param {string} source - 投影全文。
 * @param {string} section - 渲染好的段。
 * @returns {string} 新全文。
 */
function spliceSection(source, section) {
  const start = source.indexOf(SECTION_START)
  if (start < 0) throw new Error('找不到 CAPABILITIES 段起点：' + SECTION_START)
  const end = source.indexOf(SECTION_END, start)
  if (end < 0) throw new Error('找不到 CAPABILITIES 段终点（行首的 ]）')
  return source.slice(0, start) + section + source.slice(end + SECTION_END.length)
}

/**
 * 行级差异摘要（--check 判红时给人看，最多 8 条）。
 * @param {string} before - 磁盘上的投影。
 * @param {string} after - 生成出来的投影。
 * @returns {string[]} 差异行描述。
 */
function diffSummary(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const out = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max && out.length < 8; i += 1) {
    if (a[i] === b[i]) continue
    out.push('第 ' + String(i + 1) + ' 行：磁盘 ' + JSON.stringify((a[i] ?? '(缺)').slice(0, 90)) + ' → 生成 ' + JSON.stringify((b[i] ?? '(缺)').slice(0, 90)))
  }
  return out
}

const registry = await import(pathToFileURL(registryPath).href)
const rows = Array.isArray(registry.CAPABILITIES) ? registry.CAPABILITIES : []
const guide = Array.isArray(registry.TOOL_SELECTION_GUIDE) ? registry.TOOL_SELECTION_GUIDE : []
if (rows.length === 0) {
  console.error('GEN_KERNEL_TOOLS_FAIL 登记表为空或读不到 CAPABILITIES：' + registryPath)
  process.exit(2)
}

const section = renderSection(rows, guide)
const current = readFileSync(PROJECTION, 'utf8')
const next = spliceSection(current, section)

if (check) {
  if (current === next) {
    console.log('GEN_KERNEL_TOOLS_OK 投影与登记表一致（' + String(rows.length) + ' 条 / 指引 ' + String(guide.length) + ' 组）')
    process.exit(0)
  }
  console.log('GEN_KERNEL_TOOLS_DRIFT 投影与登记表不一致（登记表 ' + String(rows.length) + ' 条）')
  for (const line of diffSummary(current, next)) console.log('  ' + line)
  console.log('  修法：node qa/gen-kernel-tools.mjs（生成后按需重建内核产物）')
  process.exit(1)
}

writeFileSync(PROJECTION, next, 'utf8')
if (!quiet) {
  console.log('GEN_KERNEL_TOOLS_WRITTEN 投影已重写：' + String(rows.length) + ' 条 / ' + String(Buffer.byteLength(next, 'utf8')) + ' 字节')
}
