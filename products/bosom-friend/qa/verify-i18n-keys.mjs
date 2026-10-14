/**
 * i18n 关键键与占位符检查。
 *
 * 存在的理由（两条都是实测踩出来的用户可见缺陷）：
 * 1. 本地化文件曾出现「写入报成功、随后键静默消失」，界面直接渲染出原始键名
 *    （如 draftManage.batchManage）。这类缺陷在门禁里必须可见，而不是等用户看到键名。
 * 2. **占位符写错一层花括号**：i18next 只认 `{{name}}`，写成 `{name}` 永远不会被替换，
 *    界面直接渲染出 `已选 {count} / {total}` 这种半成品（实测 2026-09-22 批量管理工具条）。
 *    同族的第二种：某个语言多写了一个变量而调用方没传，i18next 同样把 `{{name}}` 原样渲染出来。
 *    两者都不是"翻译没跟上"，而是**用户屏幕上出现原始 token**——所以对基准语言与全语言一律判红。
 *
 * 用法：node products/bosom-friend/qa/verify-i18n-keys.mjs
 * 退出码：0 = 键齐备且占位符口径一致；1 = 有缺失或占位符不符。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'project', 'bosom-friend-web', 'src', 'app', 'i18n', 'locales')
const BASE_LANGUAGE = 'zh-CN'

/** 内容创作界面依赖的键：新增界面文案时在此登记，缺失即红灯。 */
const CRITICAL_KEYS = [
  ['brandPromotion.json', 'draftManage.batchManage'],
  ['brandPromotion.json', 'draftManage.batchTransfer'],
  ['brandPromotion.json', 'draftManage.batchDelete'],
  ['brandPromotion.json', 'draftManage.conditionalDelete'],
  ['material.json', 'mediaManagement.batchDelete'],
  // 任务记录（我的任务 / AI 社媒任务预览）的批量管理工具条与确认框：这些键带 {{count}}/{{total}}，
  // 写错一层花括号界面就会露出 {count}（DEF-062 的复发形态，2026-09-22 用户截图）。
  ['chat.json', 'task.selectAll'],
  ['chat.json', 'task.selectedCount'],
  ['chat.json', 'task.deleteSelected'],
  ['chat.json', 'task.batchExit'],
  ['chat.json', 'task.batchDeleteConfirmDesc'],
  ['chat.json', 'task.batchDeleteSuccess'],
  // 请求失败的三类真实原因：缺失会让界面渲染出原始键名（DEF-083 的提示语就靠它们说真话）
  ['common.json', 'backendUnreachable'],
  ['common.json', 'backendTimeout'],
  ['common.json', 'backendBadResponse'],
]

/** 读取点分键路径；任一层缺失返回 undefined。 */
function readPath(value, path) {
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), value)
}

/** 单花括号占位符：i18next 只认双花括号，命中的都是永远不会被替换的原始 token。 */
const SINGLE_BRACE = /(?<!\{)\{(?!\{)([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g
/** 双花括号占位符（i18next 的取值形态）。 */
const DOUBLE_BRACE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** 一门语言一个命名空间文件里的「键路径 → 文案」。 */
function flattenStrings(node, prefix = '', acc = new Map()) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const key of Object.keys(node)) flattenStrings(node[key], prefix === '' ? key : prefix + '.' + key, acc)
  }
  else if (typeof node === 'string') {
    acc.set(prefix, node)
  }
  return acc
}

function readLocale(language, file) {
  return flattenStrings(JSON.parse(readFileSync(join(localesDir, language, file), 'utf8')))
}

/** 一个字符串里出现的占位符名字（去重、排序后便于比对）。 */
function placeholders(text) {
  const names = new Set()
  for (const match of text.matchAll(DOUBLE_BRACE)) names.add(match[1])
  return [...names].sort()
}

const failures = []
const languages = readdirSync(localesDir).filter(name => statSync(join(localesDir, name)).isDirectory())
const baseFiles = readdirSync(join(localesDir, BASE_LANGUAGE)).filter(name => name.endsWith('.json'))

// 检查 1：内容创作界面依赖的键在基准语言里必须存在且非空。
for (const [file, key] of CRITICAL_KEYS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(localesDir, BASE_LANGUAGE, file), 'utf8'))
  }
  catch (error) {
    failures.push('FAIL zh-CN/' + file + ' 解析失败：' + String(error))
    continue
  }
  const value = readPath(parsed, key)
  if (typeof value !== 'string' || value === '') failures.push('FAIL 基准语言缺少键 zh-CN/' + file + ' :: ' + key)
}

// 检查 2 与 3：占位符写法必须能被 i18next 替换，且各语言的取值集合与基准语言一致。
let scannedFiles = 0
let scannedKeys = 0
for (const language of languages) {
  for (const file of readdirSync(join(localesDir, language)).filter(name => name.endsWith('.json'))) {
    scannedFiles += 1
    let values
    try {
      values = readLocale(language, file)
    }
    catch (error) {
      failures.push('FAIL ' + language + '/' + file + ' 解析失败：' + String(error))
      continue
    }
    for (const [key, value] of values) {
      scannedKeys += 1
      for (const match of value.matchAll(SINGLE_BRACE)) {
        failures.push('FAIL 单花括号占位符不会被替换 ' + language + '/' + file + ' :: ' + key + ' :: ' + match[0])
      }
    }
  }
}
for (const file of baseFiles) {
  const base = readLocale(BASE_LANGUAGE, file)
  for (const language of languages) {
    if (language === BASE_LANGUAGE) continue
    let other
    try {
      other = readLocale(language, file)
    }
    catch {
      // 该语言没有这个命名空间文件：跨语言同步是既有欠账，不在这条检查里判红。
      continue
    }
    for (const [key, value] of other) {
      if (!base.has(key)) continue
      const expected = placeholders(base.get(key))
      const actual = placeholders(value)
      if (expected.join(',') === actual.join(',')) continue
      failures.push('FAIL 占位符与基准语言不一致 ' + language + '/' + file + ' :: ' + key
        + ' :: 基准=[' + expected.join(' ') + '] 实际=[' + actual.join(' ') + ']')
    }
  }
}

if (failures.length > 0) {
  for (const line of failures.slice(0, 40)) console.error(line)
  if (failures.length > 40) console.error('…（还有 ' + String(failures.length - 40) + ' 条）')
  console.error('I18N_KEYS FAIL problems=' + String(failures.length) + ' checked=' + String(CRITICAL_KEYS.length)
    + ' files=' + String(scannedFiles) + ' keys=' + String(scannedKeys))
  process.exit(1)
}
console.log('I18N_KEYS PASS checked=' + String(CRITICAL_KEYS.length) + ' files=' + String(scannedFiles)
  + ' keys=' + String(scannedKeys) + '（占位符写法与跨语言取值集合一致）')
