/**
 * i18n 关键键检查：断言内容创作界面依赖的键存在于基准语言 zh-CN。
 *
 * 存在的理由：本地化文件曾出现「写入报成功、随后键静默消失」，界面直接渲染出
 * 原始键名（如 draftManage.batchManage）。这类缺陷在门禁里必须可见，而不是等
 * 用户看到键名。跨语言的整体同步度是既有欠账，本检查只对基准语言判红。
 *
 * 用法：node products/bosom-friend/qa/verify-i18n-keys.mjs
 * 退出码：0 = 基准语言键齐备；1 = 有缺失。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'project', 'bosom-friend-web', 'src', 'app', 'i18n', 'locales')

/** 内容创作界面依赖的键：新增界面文案时在此登记，缺失即红灯。 */
const CRITICAL_KEYS = [
  ['brandPromotion.json', 'draftManage.batchManage'],
  ['brandPromotion.json', 'draftManage.batchTransfer'],
  ['brandPromotion.json', 'draftManage.batchDelete'],
  ['brandPromotion.json', 'draftManage.conditionalDelete'],
  ['material.json', 'mediaManagement.batchDelete'],
]

/** 读取点分键路径；任一层缺失返回 undefined。 */
function readPath(value, path) {
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), value)
}

let failures = 0
for (const [file, key] of CRITICAL_KEYS) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(localesDir, 'zh-CN', file), 'utf8'))
  } catch (error) {
    console.error('FAIL zh-CN/' + file + ' 解析失败：' + String(error))
    failures += 1
    continue
  }
  const value = readPath(parsed, key)
  if (typeof value !== 'string' || value === '') {
    console.error('FAIL 基准语言缺少键 zh-CN/' + file + ' :: ' + key)
    failures += 1
  }
}

if (failures > 0) {
  console.error('I18N_KEYS FAIL missing=' + failures + ' checked=' + CRITICAL_KEYS.length)
  process.exit(1)
}
console.log('I18N_KEYS PASS checked=' + CRITICAL_KEYS.length)
