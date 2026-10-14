#!/usr/bin/env node
/**
 * 语境一致性门禁：**运行时语境文件**里的平台规则，必须与**权威上限表**一致。
 *
 * 为什么需要它（2026-10-11 教训）：我改了 agent-rules.ts 的抖音标题上限（30 → 20），
 * 但语境文件 `$DSH_HOME/AGENTS.md` 是**会话冷启动时生成**的——改了源码不等于模型看到的就是新的。
 * verify-platform-rules.mjs 比对的是**源码**，这一条比对的是**模型真正读到的那份文件**。
 * 两者都要绿：源码对了但语境没刷新，模型照样按旧规则写字。
 *
 * 用法：node qa/verify-context-rules.mjs [--selftest]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const productRoot = join(here, '..')

/** 权威表：平台 id -> 标题上限。 */
function parseTruth(text) {
  const out = new Map()
  for (const m of text.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{([^}]*)\}/gm)) {
    const title = /title:\s*(\d+)/.exec(m[2])
    out.set(m[1], title === null ? undefined : Number(title[1]))
  }
  return out
}

/** 从语境文件里抽平台规则表：平台 id -> 标题列里的数字。 */
function parseContext(text) {
  const out = new Map()
  for (const m of text.matchAll(/^\|\s*([^|]*?)\s+([A-Za-z][A-Za-z0-9]*)\s*\|([^|]*)\|/gm)) {
    const num = /≤\s*(\d+)\s*字/.exec(m[3])
    out.set(m[2], num === null ? undefined : Number(num[1]))
  }
  return out
}

/** 比对；返回问题列表。 */
function compare(truth, context) {
  const problems = []
  if (context.size === 0) {
    problems.push('语境文件里找不到任何平台规则表——要么语境还没生成，要么表格格式变了')
    return problems
  }
  for (const [id, limit] of truth) {
    const seen = context.get(id)
    if (limit !== undefined && seen !== limit) {
      problems.push('平台 ' + id + ' 标题上限：权威表 ' + String(limit) + ' 字，语境里是 '
        + (seen === undefined ? '没写数字' : String(seen) + ' 字') + '（语境是旧的，重启 + 新建会话后才会刷新）')
    }
  }
  return problems
}

const truthText = readFileSync(join(productRoot, 'server', 'src', 'platform-catalog.ts'), 'utf8')
const truth = parseTruth(truthText)

if (process.argv.includes('--selftest')) {
  const good = new Map([['douyin', 20]])
  const bad = new Map([['douyin', 30]])
  const empty = new Map()
  const ok = compare(truth, good).length === 0
  const caught = compare(truth, bad).length > 0
  const caughtEmpty = compare(truth, empty).length > 0
  console.log('负向自测：一致判 PASS=' + String(ok) + '；旧数字判 FAIL=' + String(caught) + '；无表格判 FAIL=' + String(caughtEmpty))
  if (ok && caught && caughtEmpty) { console.log('SELFTEST_OK 门禁本身可信'); process.exit(0) }
  console.log('SELFTEST_FAIL 判据不工作'); process.exit(1)
}

// 候选路径按优先级：产品内核把 DSH_HOME 设成产品根（BOSOM_FRIEND_HOME），
// 但本门禁也可能跑在 DSH 自己的会话里（那时 DSH_HOME 指向 ~/.dsh，那里没有产品的平台规则表）。
// 所以依次找，取**第一个含平台规则表**的那份——找错了文件会让门禁假绿或假红。
const candidates = [
  process.env.BOSOM_FRIEND_HOME,
  join(homedir(), '.bosom-friend'),
  process.env.DSH_HOME,
  join(homedir(), '.dsh'),
].filter(candidate => typeof candidate === 'string' && candidate.trim() !== '')
  .map(candidate => join(String(candidate).trim(), 'AGENTS.md'))
let contextFile = ''
let contextText = ''
for (const candidate of candidates) {
  if (!existsSync(candidate)) continue
  const text = readFileSync(candidate, 'utf8')
  if (!/douyin/.test(text)) continue
  contextFile = candidate
  contextText = text
  break
}
if (contextFile === '') {
  console.log('CONTEXT_RULES SKIP 没有找到含平台规则表的语境文件（找过：' + candidates.join('、') + '）')
  process.exit(0)
}
const problems = compare(truth, parseContext(contextText))
console.log('语境文件：' + contextFile)
if (problems.length > 0) {
  console.log('CONTEXT_RULES FAIL 共 ' + String(problems.length) + ' 处：')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('CONTEXT_RULES OK 语境里的平台规则与权威表一致')
