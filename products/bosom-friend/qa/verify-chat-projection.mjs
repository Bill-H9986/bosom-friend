#!/usr/bin/env node
/**
 * 对话投影防复发门禁：把 2026-09-29 "对话框没有内容" 的三个状态机缺陷钉成可执行断言。
 *
 * 现场：AI 回复已落库、界面却只剩用户那一句。根因在产品自建的消息投影层
 * （README: docs/过程档案/方案与路线/消息链路归位DSH投影-2026-09-29.md）。
 * 每条断言配一个"改回旧写法"的样本，样本必须让断言判红（铁律 #16）。
 *
 * 用法：node products\bosom-friend\qa\verify-chat-projection.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const product = resolve(here, '..')
const read = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const HOOK = 'project/bosom-friend-web/src/app/[lng]/chat/[taskId]/hooks/useChatState.ts'
const PAGE = 'project/bosom-friend-web/src/app/[lng]/chat/[taskId]/page.tsx'

const SPECS = [
  {
    name: '详情页消息源：store 为空必须回退到接口拉回的那份',
    file: HOOK,
    ok: s => s.includes('if (storeMessages.length > 0) return storeMessages')
      && s.includes('return localMessages'),
    // 旧写法：只要任务活跃就用（可能为空的）storeMessages
    broken: s => s.replace('if (storeMessages.length > 0) return storeMessages', 'if (isActiveTask) return storeMessages'),
    fix: 'useChatState：判据只能是 store 里有没有消息，不能是任务是否活跃',
  },
  {
    name: '本页必须始终持有接口数据（先于缓存判断）',
    file: HOOK,
    ok: (s) => {
      const setLocal = s.indexOf('setLocalMessages(converted)')
      const cached = s.indexOf('if (!hasCachedMessages)')
      return setLocal > 0 && cached > 0 && setLocal < cached
    },
    // 旧写法：setLocalMessages 被关进缓存未命中的分支，缓存命中后本页没有回退数据
    broken: s => s.replace(/(\s+)setLocalMessages\(converted\)\n(\s+)if \(!hasCachedMessages\)/, '$1if (!hasCachedMessages)$1setLocalMessages(converted)'),
    fix: 'useChatState：缓存只决定是否覆盖 store，不决定页面自己的回退数据',
  },
  {
    name: '轮询不得与"缓存命中"耦合（否则 AI 回复永远拉不回来）',
    file: HOOK,
    ok: (s) => {
      const cachedBlock = s.indexOf('if (!hasCachedMessages)')
      const polling = s.indexOf('startPolling()')
      return cachedBlock > 0 && polling > cachedBlock
    },
    // 旧写法等价于「轮询不再被调用」（被关进缓存未命中的分支里）
    broken: s => s.replace('startPolling()', 'startPollingDisabled()'),
    fix: 'useChatState：只要任务未完成就启动轮询（缓存命中与否无关）',
  },
  {
    name: '加载骨架：判据是"没有可渲染消息"，不是"任务是否活跃"',
    file: PAGE,
    ok: s => s.includes('if (isLoading && displayMessages.length === 0)'),
    broken: s => s.replace('if (isLoading && displayMessages.length === 0)', 'if (isLoading && !isActiveTask)'),
    fix: 'page.tsx：加载中且无消息就出骨架（旧写法让活跃任务加载期一片空白）',
  },
  {
    // 判据必须锚在**三元表达式那一处**（条件紧跟问号），而不是字面量第一次出现处：
    // 骨架判据（上面第 4 条）恰好钉死同一个字面量 must 出现在更前面，锚第一次出现会把
    // 「空态 → 列表」的顺序闸变成永远命中骨架、与列表无关的假闸（2026-10-12 实测）。
    name: '一条消息都没有时也要给明确状态，绝不空白',
    file: PAGE,
    // 用 indexOf/includes 串起来，不写正则：转义层数一多，\\s 与 \\? 很容易在传递中丢一层，
    // 判据会悄悄变成"永远匹配不到"（那不是变严格，是变没了）。
    ok: (s) => {
      const m = /displayMessages[.]length === 0\s*[?]\s*[(]/.exec(s)
      if (m === null) return false
      const list = s.indexOf('ChatMessageList', m.index)
      return list > m.index && list - m.index <= 400 && s.includes("t('detail.waitingResponse')")
    },
    // 负向样本是**真实的空态回归**：空态分支不再渲染任何东西（整段换成 null），
    // 于是空态与列表之间的顺序关系消失，判据必须判红。
    broken: s => s.replace(
      /displayMessages[.]length === 0\s*[?]\s*[(][\s\S]*?[)]\s*[:]\s*[(]/ ,
      'displayMessages.length === 0 ? ( null ) : (',
    ),
    fix: 'page.tsx：空消息时渲染"等待 AI 响应"，而不是留白',
  },
]

const sources = new Map()
for (const spec of SPECS) if (!sources.has(spec.file)) sources.set(spec.file, read(join(product, spec.file)))

let failed = 0
console.log('对话投影防复发门禁（结构断言 + 负向对照）')
console.log('')
for (const spec of SPECS) {
  const src = sources.get(spec.file) ?? ''
  const present = src !== ''
  const forward = present && spec.ok(src)
  const backward = present && spec.ok(spec.broken(src)) === false
  const verdict = forward && backward ? 'PASS' : 'FAIL'
  if (verdict === 'FAIL') failed += 1
  console.log(verdict + '  ' + spec.name)
  console.log('      ' + spec.file)
  if (!present) console.log('      -> 文件不存在')
  else if (!forward) console.log('      -> 源码里找不到这道闸（回归）')
  else if (!backward) console.log('      -> 负向对照没判红：断言过宽（铁律 #16）')
  else console.log('      ' + spec.fix)
}
console.log('')
console.log('CHAT_PROJECTION checks=' + SPECS.length + ' fail=' + failed)
process.exit(failed === 0 ? 0 : 1)
