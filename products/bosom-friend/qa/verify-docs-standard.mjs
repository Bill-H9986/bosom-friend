#!/usr/bin/env node
/**
 * A 级文档结构门禁（BFS-400 十二项）。
 *
 * 为什么需要它：BFS-400《文档编写标准》第 3 节规定 A 级（规范级）文档必须有十二项结构，
 * 第 9.2 节规定「A 级文档缺任一必备结构项 → 判红」。在此之前这项检查是人工的，
 * 而人工检查一定会过期——本仓库已经有过一次：规范写了十二项，实际文档缺项没人发现。
 *
 * 它检查什么：docs/规范/ 下每一份**现行 A 级文档**是否具备 BFS-400 第 3 节的十二项结构：
 *   文档头 / 修订记录 / 目的 / 适用范围 / 文档关系 / 术语与定义 / 关键词约定 /
 *   编号化条款 / 判据 / 证据要求 / 反例与违规处置 / 附录
 *
 * 三类文件不检查（并在输出里说明）：
 *   ① 历史件：标题或文档头已标注「已被 … 替代」（BFS-400 第 8.3 节：被替代件不删除、不判红）；
 *   ② 非 A 级：在 LEVEL_EXEMPT 里显式登记（例如 B 级台账）；
 *   ③ 无编号且不在豁免表：判红「无法判定级别」，要求补编号或登记豁免。
 *
 * 两条判定口径（写在代码里，避免口头约定）：
 *   1. 结构项认「同义结构」：目的是「这份文件解决什么」，反例是「假阳性清单 / 红线」，
 *      文档关系可由文档头的「上位依据 / 替代 / 配套」承担；编号化条款认三种载体——
 *      条款号（形如 101.1）、行首编号条目 + 规范性词、表格首列编号 + 规范性词。
 *      BFS-400 要的是结构角色在场，不是固定措辞。
 *   2. 已知例外（L3 记录例外）：被 BFS-400 自己认定为合格样件的文档，其缺项登记在
 *      KNOWN_EXCEPTIONS 里，不计 FAIL，但**每次都打印出来**，并带补做计划。
 *      理由：知识库条目 07《门禁设计原则》——假红会让人不再相信门禁；
 *      而把缺项藏起来同样是错的，所以例外必须可见。
 *
 * 用法：
 *   node products/bosom-friend/qa/verify-docs-standard.mjs          # 检查
 *   node products/bosom-friend/qa/verify-docs-standard.mjs --selftest  # 负向对照自检
 * 退出码：0 = 全部合规（含已登记例外）；1 = 有未登记的缺项。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT = dirname(HERE)
const STANDARD_DIR = join(PRODUCT, 'docs', '规范')

/** BFS-400 第 3 节的十二项结构，顺序即标准顺序。 */
const ITEMS = [
  '文档头', '修订记录', '目的', '适用范围', '文档关系', '术语与定义',
  '关键词约定', '编号化条款', '判据', '证据要求', '反例与违规处置', '附录',
]

/** 非 A 级、显式豁免的文件（相对 docs/规范/）。 */
const LEVEL_EXEMPT = new Map([
  ['需求台账-产品负责人指令.md', 'B 级：产品负责人原话台账，只增不改（BFS-400 第 4 节）'],
])

/** 已知例外（L3 记录例外）：文件名 → 结构项 → { 依据, 补做计划 }。 */
const KNOWN_EXCEPTIONS = new Map([
  ['验收标准-一句话端到端.md', new Map([
    ['术语与定义', {
      依据: 'BFS-400 第 3 节把本件列为「现有合格样例」；其角色表（第 1.2 节）与证据档定义（第 3.1 节）承担术语职能',
      补做计划: '下一轮修订时补一个术语小节，或把角色表提升为「术语与角色」',
    }],
    ['关键词约定', {
      依据: 'BFS-400 第 6.4 节「一个事实一个家」：必须 / 应当 / 可以的三级语义在 BFS-100 第 0.5 节统一定义，执行细则按引用处理',
      补做计划: '下一轮修订时补一行「关键词依 BFS-100 第 0.5 节」',
    }],
  ])],
  ['开发与验收规范-小白版.md', new Map([
    ['关键词约定', {
      依据: 'BFS-400 第 6.4 节：三级语义词在 BFS-100 第 0.5 节统一定义；本件面向非技术读者，按引用处理',
      补做计划: '下一轮修订时补一行「关键词依 BFS-100 第 0.5 节」',
    }],
  ])],
])

/** 被替代件判据：标题或文档头里标注了替代关系。 */
const SUPERSEDED = /已被[^\n]{0,40}替代|（\*\*已被/
/** A 级判据：文档头里出现 BFS 三字编号。 */
const BFS_NUMBER = /BFS-\d{3}/

const HEAD_LINES = 40
const head = text => text.split(/\r?\n/).slice(0, HEAD_LINES).join('\n')
const hasHeading = (text, words) =>
  text.split(/\r?\n/).some(line => /^#{1,4}\s/.test(line) && words.some(word => line.includes(word)))

/** 十二项的同义结构识别规则。 */
const RULES = {
  文档头: text => {
    const h = head(text)
    return h.includes('文档编号') && h.includes('版本') && h.includes('状态')
  },
  修订记录: text => hasHeading(text, ['修订记录', '修订历史', '变更记录']),
  目的: text => hasHeading(text, ['目的', '解决什么', '判定线']) || text.includes('判定线')
    || /适用于[\s\S]{0,60}判定/.test(text),
  适用范围: text => hasHeading(text, ['适用']) || head(text).includes('面向读者'),
  文档关系: text => hasHeading(text, ['关系', '上位', '替代', '配套', '对照', '与旧'])
    || head(text).includes('上位'),
  术语与定义: text => hasHeading(text, ['术语', '定义', '名词', '词汇']),
  关键词约定: text => hasHeading(text, ['关键词']) || text.includes('关键词')
    || (text.includes('**必须**') && text.includes('**应当**') && text.includes('**可以**')),
  编号化条款: text => {
    if (/(?:^|\n)\s*[-*]?\s*\*{0,2}\d{3}\.\d+\*{0,2}/.test(text)) return true
    if (/(?:^|\n)\|\s*\*{0,2}\d{3}\.\d+/.test(text)) return true
    const words = /必须|禁止|不得|应当|不许|视为未完成|判红/
    return text.split(/\r?\n/).some(line =>
      (/^\s*(?:[-*]\s*)?(?:\*\*)?\d{1,3}[.、)）]\s*\S/.test(line) && words.test(line))
      || (/^\|\s*\d{1,3}\s*\|/.test(line) && words.test(line)))
  },
  判据: text => text.includes('判据') || hasHeading(text, ['怎么算', '才算', '缺一不算']),
  证据要求: text => text.includes('证据'),
  反例与违规处置: text => text.includes('反例') || text.includes('假阳性')
    || text.includes('违规处置') || text.includes('红线'),
  附录: text => hasHeading(text, ['附录']),
}

/**
 * 检查一份文档文本，返回缺项清单。
 * @param {string} text 文档全文
 * @returns {string[]} 缺失的结构项（按 ITEMS 顺序）
 */
export function missingItems(text) {
  const missing = []
  for (const item of ITEMS) if (!RULES[item](text)) missing.push(item)
  return missing
}

/**
 * 扫描一个目录里的 A 级文档。
 * @param {string} dir 扫描目录
 * @returns {{checked: Array<{file: string, missing: string[], excepted: Array<{item: string, 依据: string, 补做计划: string}>}>,
 *   failed: Array<{file: string, missing: string[]}>, history: string[], exempt: Array<{file: string, reason: string}>, unknown: string[]}}
 */
export function scanDirectory(dir) {
  const checked = []
  const failed = []
  const history = []
  const exempt = []
  const unknown = []
  const files = readdirSync(dir).filter(name => name.endsWith('.md')).sort()
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    const title = text.split(/\r?\n/)[0] ?? ''
    if (SUPERSEDED.test(title) || SUPERSEDED.test(head(text))) { history.push(file); continue }
    if (LEVEL_EXEMPT.has(file)) { exempt.push({ file, reason: LEVEL_EXEMPT.get(file) }); continue }
    if (!BFS_NUMBER.test(head(text))) { unknown.push(file); continue }
    const missing = missingItems(text)
    const table = KNOWN_EXCEPTIONS.get(file) ?? new Map()
    const excepted = []
    const real = []
    for (const item of missing) {
      if (table.has(item)) excepted.push({ item, ...table.get(item) })
      else real.push(item)
    }
    checked.push({ file, missing, excepted })
    if (real.length > 0) failed.push({ file, missing: real })
  }
  return { checked, failed, history, exempt, unknown }
}

/** 检查结果汇总（供主流程与自检共用）。 */
function report(result, dir) {
  const lines = []
  lines.push('A 级文档结构门禁（BFS-400 十二项）')
  lines.push('  扫描目录：' + dir)
  lines.push('  检查 ' + result.checked.length + ' 份 · 跳过历史件 ' + result.history.length
    + ' 份 · 跳过非 A 级 ' + result.exempt.length + ' 份'
    + (result.unknown.length ? ' · 级别未知 ' + result.unknown.length + ' 份' : ''))
  for (const row of result.checked) {
    const ok = ITEMS.length - row.missing.length
    const tag = row.missing.length === 0 ? 'PASS' : (row.excepted.length === row.missing.length ? 'PASS(例外)' : 'FAIL')
    lines.push('  [' + tag + '] ' + row.file + '  ' + ok + '/' + ITEMS.length)
  }
  for (const file of result.history) lines.push('  [跳过] ' + file + '（历史件：已标注被替代）')
  for (const row of result.exempt) lines.push('  [跳过] ' + row.file + '（' + row.reason + '）')
  for (const file of result.unknown) lines.push('  [FAIL] ' + file + '（无法判定级别：文档头没有 BFS 编号，也不在豁免表）')

  const exceptions = result.checked.flatMap(row => row.excepted.map(item => ({ file: row.file, ...item })))
  if (exceptions.length > 0) {
    lines.push('')
    lines.push('例外清单（L3 记录例外，不计 FAIL，下一轮补齐）：')
    for (const e of exceptions) lines.push('  - ' + e.file + ' · ' + e.item + '：' + e.依据 + '；补做计划：' + e.补做计划)
  }

  const failCount = result.failed.reduce((sum, row) => sum + row.missing.length, 0) + result.unknown.length
  if (failCount > 0) {
    lines.push('')
    lines.push('DOCS_STANDARD_FAIL files=' + result.checked.length + ' missing=' + failCount)
    lines.push('缺项清单：')
    for (const row of result.failed) lines.push('  - ' + row.file + '：' + row.missing.join('、'))
    for (const file of result.unknown) lines.push('  - ' + file + '：无法判定级别（补 BFS 编号或登记 LEVEL_EXEMPT）')
    lines.push('修法：按 BFS-400 第 3 节补齐对应结构项（可参考 规范/工程化流程规范-v2.0.md）；')
    lines.push('      被替代的历史件请在标题或文档头标注「已被 … 替代」，本门禁会自动跳过。')
  } else {
    lines.push('')
    lines.push('DOCS_STANDARD_OK files=' + result.checked.length + ' items=' + result.checked.length * ITEMS.length
      + ' exceptions=' + exceptions.length)
  }
  return { text: lines.join('\n'), failCount }
}

/**
 * 负向对照自检：造一份缺项文档，它必须判红；再造一份十二项齐全的文档，它必须判绿。
 * 这条断言的意义：证明门禁真的会红——不会红的门禁等于没有门禁（BFS-108.5）。
 */
function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'bfs-docs-standard-selftest-'))
  try {
    const complete = [
      '# 结构自检齐全样例（BFS-999）',
      '',
      '> **文档编号**：BFS-999 ｜ **版本**：1.0 ｜ **状态**：正式生效',
      '> **上位依据**：BFS-400',
      '',
      '## 修订记录',
      '',
      '| 版本 | 日期 | 修订内容 | 依据 |',
      '| --- | --- | --- | --- |',
      '| 1.0 | 2026-10-11 | 自检样例 | BFS-400 |',
      '',
      '## 1 目的与适用范围',
      '### 1.1 目的',
      '本文的判定线：证明齐全件判绿。',
      '### 1.2 适用范围',
      '适用于门禁自检；不管真实文档。',
      '### 1.3 与其他文档的关系',
      '上位 BFS-400。',
      '',
      '## 2 术语与关键词',
      '| 术语 | 定义 |',
      '| --- | --- |',
      '| 样例 | 自检用文本 |',
      '| 关键词 | 含义 |',
      '| **必须** | 强制 |',
      '| **应当** | 建议 |',
      '| **可以** | 可选 |',
      '',
      '## 3 结构条款',
      '- 999.1 每份 A 级文档**必须**有文档头。',
      '- 999.2 缺项**必须**判红。',
      '',
      '**判据**：十二项齐全。',
      '**证据要求**：门禁运行输出。',
      '**反例（判红）**：缺项且未登记例外。',
      '',
      '## 附录 A · 自检清单',
      '- [ ] 十二项齐全',
      '',
    ].join('\n')
    const incomplete = [
      '# 结构自检缺项样例（BFS-998）',
      '',
      '> **文档编号**：BFS-998 ｜ 日期：2026-10-11',
      '',
      '这份文档只有一句话，十二项结构一项都没有。',
      '',
    ].join('\n')
    writeFileSync(join(dir, '齐全件.md'), complete, 'utf8')
    writeFileSync(join(dir, '缺项件.md'), incomplete, 'utf8')

    const missingComplete = missingItems(complete)
    const missingIncomplete = missingItems(incomplete)
    const result = scanDirectory(dir)
    // 「无法判定级别」同样是红：级别都认不出来，不能算通过。
    const failedFiles = result.failed.map(row => row.file).concat(result.unknown)

    const problems = []
    if (missingComplete.length > 0) problems.push('齐全件被误判缺项：' + missingComplete.join('、'))
    if (missingIncomplete.length < 8) problems.push('缺项件缺项数过少（' + missingIncomplete.length + '），样例构造不足')
    if (!failedFiles.includes('缺项件.md')) problems.push('缺项件没有被判红')
    if (failedFiles.includes('齐全件.md')) problems.push('齐全件被误判为红')

    console.log('负向对照自检')
    console.log('  齐全件：缺项 ' + missingComplete.length + ' 项（期望 0）')
    console.log('  缺项件：缺项 ' + missingIncomplete.length + ' 项（期望 >= 8）')
    console.log('  扫描判定：红了 ' + (failedFiles.length ? failedFiles.join('、') : '无'))
    if (problems.length > 0) {
      console.log('SELF_TEST_FAIL')
      for (const p of problems) console.log('  - ' + p)
      return 1
    }
    console.log('SELF_TEST_OK')
    return 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const isSelfTest = process.argv.includes('--selftest')
if (isSelfTest) {
  process.exitCode = selftest()
} else {
  const result = scanDirectory(STANDARD_DIR)
  const { text, failCount } = report(result, STANDARD_DIR)
  console.log(text)
  process.exitCode = failCount > 0 ? 1 : 0
}
