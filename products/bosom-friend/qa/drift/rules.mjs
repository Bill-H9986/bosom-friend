/**
 * 规则集。每条规则声明：关系类型 + 事实源 + 判定。
 * 契约缺失时，依赖契约的规则必须报 EXTRACTION_FAILED，绝不伪装成 CONSISTENT。
 */
import { R, setEquality } from './relations.mjs'
import { judgeEvidenceRow } from './evidence.mjs'
import { exceptionValues } from './exceptions.mjs'

const engineKeyOf = (s, pid) =>
  Object.values(s.keys).find(v => v.platform === pid)?.engineKey
  ?? s.planned.find(v => v.platform === pid)?.engineKey

const toCli = (s, pid) => {
  const k = engineKeyOf(s, pid)
  return k ? s.cliMap[k] : undefined
}

/**
 * 死代码判定（导出以便自证直接复用同一套逻辑）。
 * 三维独立：使用状态决定结果；意图状态只作为**附加记录**；证据状态决定能否下结论。
 */
export function judgeDeadObjects(objects) {
  return objects.map(o => {
    const base = { id: o.id, note: o.note, intent: o.intent, uses: o.uses.length, dynamic: o.dynamicHits.length, guardOk: o.guardOk }
    if (!o.defFound) return { ...base, status: 'EXTRACTION_FAILED', why: '定义位置未找到' }
    if (o.uses.length > 0) return { ...base, status: 'CONSISTENT', why: '有效消费点 ' + o.uses.length + ' 处' }
    if (o.dynamicHits.length > 0) return { ...base, status: 'UNVERIFIED', why: '无直接消费点，但存在无法排除的动态访问 ' + o.dynamicHits.length + ' 处' }
    return { ...base, status: 'DEAD_CODE', why: '完整扫描后无有效消费路径，且未发现动态访问' }
  })
}

/**
 * 约束关系判定（导出以便自证复用同一套逻辑）。
 * 顺序：声明有效性 → 关系验证 → 未声明即 UNVERIFIED（**不猜**）。
 */
export function judgeConstraints(c) {
  const facts = []
  // ① 已声明的显式关系
  for (const d of c.declarations) {
    if (!d.valid) { facts.push({ id: d.relation + '(无 target)', kind: 'decl', status: 'UNVERIFIED', why: '结构化标记缺少 @constraintTarget，声明无效' }); continue }
    if (d.relation === 'gen-le-platform' && d.target === 'PLATFORM_CONTENT_LIMITS.*.topics') {
      const gen = c.numbers.MAX_TOPICS, floor = c.numbers.minDeclaredTopics
      const plats = (c.topicPlatforms ?? []).map(p => p.name + ' ' + p.topics).join('、')
      if (typeof floor !== 'number') {
        // 合法空集：表中确实没有任何已声明的话题上限 → 规则**不适用**。
        // 这与 PASS 有本质区别：**本规则未做数值比较**，不代表 MAX_TOPICS 与任何平台兼容。
        facts.push({
          id: 'MAX_TOPICS <= min(已声明平台话题上限)',
          kind: 'decl',
          status: 'NOT_APPLICABLE',
          why: '没有可用于比较的已声明话题上限（生成上限 ' + gen + '）—— 本规则未做数值比较，不代表约束已满足',
        })
      } else {
        const ok = typeof gen === 'number' && gen <= floor
        facts.push({
          id: 'MAX_TOPICS <= min(已声明平台话题上限)',
          kind: 'decl',
          status: ok ? 'INTENTIONAL_DIFFERENCE' : 'DRIFT',
          why: '生成 ' + gen + ' vs 最小值 ' + floor + '（参与平台：' + (plats || '-') + '；声明 ' + d.relation + '：' + (d.rationale ?? '-') + '）',
        })
      }
    }
    if (d.relation === 'same-source' && d.target === 'MAX_TITLE_CHARS') {
      facts.push({ id: 'MAX_TITLE_CHARS 同源', kind: 'decl', status: 'CONSISTENT', why: '两处渲染均 import 同一定义（' + d.relation + '）' })
    }
  }
  // ② 未声明关系、但数值上存在配对的对象 → UNVERIFIED（不猜是否漂移）
  const declaredTopics = c.declarations.some(d => d.valid && d.target === 'PLATFORM_CONTENT_LIMITS.*.topics')
  if (!declaredTopics && typeof c.numbers.MAX_TOPICS === 'number' && typeof c.numbers['PLATFORM_CONTENT_LIMITS.xhs.topics'] === 'number') {
    facts.push({ id: 'MAX_TOPICS vs min(已声明平台话题上限)', kind: 'undeclared', status: 'UNVERIFIED',
      why: '候选关系未被声明：生成 ' + c.numbers.MAX_TOPICS + ' vs 最小值 ' + c.numbers.minDeclaredTopics + '，未声明二者应如何关联（不猜、也不静默跳过）' })
  }
  // ③ producer-consumer：消费者存在而生产者缺失 → DRIFT（接线断裂）
  for (const [field, f] of Object.entries(c.fields)) {
    if (f.consumers === 0) continue
    if (f.producers > 0) {
      facts.push({ id: field + ' 生产者-消费者', kind: 'producer-consumer', status: 'CONSISTENT', why: '消费者 ' + f.consumers + ' 处、生产者 ' + f.producers + ' 处' })
      continue
    }
    if (f.required) {
      facts.push({ id: field + ' 生产者-消费者', kind: 'producer-consumer', status: 'DRIFT', why: '**必需链路**消费者 ' + f.consumers + ' 处、生产者 0 处（接线断裂）' })
    } else {
      // 可选字段：无生产者是合法状态（平台可能本就没有该数据），如实标注而不是判红
      facts.push({ id: field + ' 生产者-消费者', kind: 'producer-consumer-optional', status: 'CONSISTENT', why: '可选字段：消费者 ' + f.consumers + ' 处、生产者 0 处（契约允许，' + (f.note ?? '') + '）' })
    }
  }
  return facts
}

/**
 * 反例判定：**只报可证明的反例**，不推测可用性。
 * 三类结果：实现被阻断 / 入口缺失 / 无法判定；无发现时明确输出 NO_COUNTEREXAMPLE_FOUND（≠ 可用）。
 */
export function judgeCounterexamples(u, declaredPlatforms, dirToPlatform, declaredTypes = {}) {
  const facts = []
  if (!u || !u.uploaders) return [{ id: 'counterexample', status: 'EXTRACTION_FAILED', why: 'uploader 事实未提供' }]
  // 无法排除动态注册 → 不能断言"没有入口"
  if ((u.dynamicMarkers ?? []).length > 0) {
    return [{ id: 'counterexample', status: 'UNVERIFIED', why: 'CLI 存在动态调用标记（' + u.dynamicMarkers.join(',') + '），无法排除间接注册，拒绝下结论' }]
  }
  for (const [dir, info] of Object.entries(u.uploaders)) {
    if (info.error) { facts.push({ id: dir, status: 'EXTRACTION_FAILED', why: '解析失败: ' + info.error }); continue }
    const platform = dirToPlatform(dir)
    for (const [cls, ci] of Object.entries(info.classes ?? {})) {
      if (!ci.blocked || ci.blocked.length === 0) continue
      // **内容类型级**判定：类名与方法名只能作为内容形态的**线索**，
      // 声明是否成立要回查该平台实际注册的内容类型。
      const hinted = /note|image/i.test(cls) || ci.blocked.some(b => /note|image/i.test(b.method)) ? 'image_text'
        : (/video/i.test(cls) ? 'video' : null)
      const declaredList = platform ? (declaredTypes[platform] ?? []) : []
      const declared = platform ? declaredPlatforms.includes(platform) && (hinted === null || declaredList.includes(hinted)) : false
      // **关键**：该内容形态未被声明时，骨架存在不构成产品漂移
      if (!declared) {
        facts.push({
          id: cls,
          status: 'NO_COUNTEREXAMPLE_FOUND',
          why: '有阻断但' + (platform ? '平台 ' + platform + ' 未声明内容形态 ' + String(hinted) : '平台未登记') + ' —— 骨架不算缺陷（声明不支持就不承诺）',
        })
        continue
      }
      const hasEntry = (u.cli.imported.includes(cls)) || (u.cli.instantiated.includes(cls))
      const methods = ci.blocked.map(b => b.method + '@' + b.raiseAt.join(',')).join(' | ')
      facts.push({
        id: cls + '(' + platform + ')',
        status: hasEntry ? 'COUNTEREXAMPLE_BLOCKED' : 'COUNTEREXAMPLE_BLOCKED_NO_ENTRY',
        why: '已声明可发布的平台 ' + platform + '：' + ci.blocked.length + ' 个必要方法被明确阻断（' + methods + '）；统一发布 CLI ' + (hasEntry ? '有' : '**无**') + '该类引用',
        evidence: { file: info.file, methods: ci.blocked },
      })
    }
  }
  if (facts.length === 0) return [{ id: 'counterexample', status: 'NO_COUNTEREXAMPLE_FOUND', why: '未发现明确阻断证据 —— **这不等于已证明能力可用**（只说明本次扫描未见反例）' }]
  return facts
}

/**
 * 证据链规则：把三层证据按 (平台, 内容类型) 关联后**跨层判定**。
 * 不改动底层提取器，也不维护新的事实表。
 */
export function judgeEvidence(rows) {
  return rows.map(r => ({ ...judgeEvidenceRow(r), platformId: r.platformId, contentType: r.contentType, row: r }))
}

export const RULES = [
  {
    id: 'platform-keys',
    title: '① 平台键：前端 PlatType vs 后端频道清单 vs 目录映射',
    relation: 'R2/R3',
    needsContract: false,
    run(s) {
      const a = setEquality(s.productIdFrontend, s.productIdChannel, { exceptions: exceptionValues('platform-keys') })
      if (a.status !== R.CONSISTENT) return a
      const keysEngine = [...new Set(Object.values(s.keys).map(k => k.engineKey))]
      const missing = keysEngine.filter(k => !(k in s.cliMap))
      return missing.length
        ? { status: R.DRIFT, detail: ['engineKey 在 CLI_PLATFORM_MAP 缺失: ' + missing.join(',')] }
        : { status: R.CONSISTENT, detail: [] }
    },
  },
  {
    id: 'login-capability',
    title: '⑨ 登录能力：ENGINE_LOGIN_PLATFORMS vs worker.module_paths',
    relation: 'R3 集合',
    needsContract: false,
    run(s) {
      const pairs = s.engineLogin.map(pid => ({ pid, engine: engineKeyOf(s, pid) }))
      const noEngine = pairs.filter(x => !x.engine).map(x => x.pid)
      if (noEngine.length) return { status: R.DRIFT, detail: ['声明可登录但无 engineKey: ' + noEngine.join(',')] }
      const noModule = pairs.filter(x => !s.modulePaths.includes(x.engine)).map(x => x.pid + '(' + x.engine + ')')
      return noModule.length
        ? { status: R.DRIFT, detail: ['声明可登录但 worker 无模块: ' + noModule.join(',')] }
        : { status: R.CONSISTENT, detail: [] }
    },
  },
  {
    id: 'sync-capability',
    title: '⑩ 同步能力：DATA_CAPABLE(xhs,douyin) vs SYNC_ADAPTERS.canSync',
    relation: 'R3 集合',
    needsContract: false,
    run(s) { return setEquality(['xhs', 'douyin'], s.canSync) },
  },
  {
    id: 'display-name',
    title: '⑦ 平台显示名：PLATFORM_KEYS.name vs PLATFORM_CONTENT_LIMITS.name',
    relation: 'R6 字符串相等',
    needsContract: false,
    run(s) {
      const pairs = Object.values(s.keys).filter(k => s.limits[k.platform])
      if (pairs.length === 0) return { status: R.EXTRACTION_FAILED, detail: ['无可比对的平台'] }
      const bad = pairs.filter(k => s.limits[k.platform].name !== k.name)
        .map(k => k.platform + ': keys=' + k.name + ' limits=' + s.limits[k.platform].name)
      return bad.length ? { status: R.DRIFT, detail: bad } : { status: R.CONSISTENT, detail: [] }
    },
  },
  {
    id: 'publish-platforms',
    title: '③ 发布能力：ENGINE_PUBLISH_PLATFORMS（平台级） vs CLI parser（动作级）',
    relation: 'R4 子集',
    needsContract: true,
    run(s) {
      if (!s.hasContract) return { status: R.EXTRACTION_FAILED, detail: ['CLI 契约未提供'] }
      const noCli = s.enginePublish.filter(pid => {
        const cli = toCli(s, pid)
        return !cli || !s.cliPlatforms.includes(cli)
      })
      return noCli.length
        ? { status: R.DRIFT, detail: ['声明可发布但 CLI 无 parser: ' + noCli.join(',')] }
        : { status: R.CONSISTENT, detail: [] }
    },
  },
  {
    id: 'qa-base-address',
    title: '⑬ QA 目标地址默认值 vs 启动脚本实际监听端口',
    relation: 'R3 集合（所有默认值应指向同一端口）',
    needsContract: false,
    needsAddress: true,
    run(s) {
      const a = s.address
      if (!a) return { status: R.EXTRACTION_FAILED, detail: ['地址事实未提供'] }
      const bad = a.qaBasePorts.filter(x => x.port !== a.serverPort)
      if (bad.length === 0) return { status: R.CONSISTENT, detail: [] }
      const byPort = {}
      for (const x of bad) (byPort[x.port] ??= []).push(x.file)
      return {
        status: R.DRIFT,
        detail: Object.entries(byPort).map(([p, fs]) => '默认 ' + p + '（应为 ' + a.serverPort + '）: ' + fs.join(', ')),
      }
    },
  },
  {
    id: 'dead-code',
    title: '⑭ 死代码：使用状态 / 意图状态 / 证据状态（三维独立，仅登记对象）',
    relation: '使用证据 + 意图声明（结构化标记）+ 证据完整性',
    needsContract: false,
    needsDead: true,
    run(s) {
      const d = s.dead
      if (!d || !Array.isArray(d.objects) || d.objects.length === 0)
        return { status: R.EXTRACTION_FAILED, detail: ['死代码事实未提供'] }
      const judged = judgeDeadObjects(d.objects)
      const detail = judged.map(j =>
        j.id + '=' + j.status +
        '（' + j.why + '；意图=' + j.intent + (j.guardOk === null ? '' : '；空值守卫=' + (j.guardOk ? '有' : '无')) + '）')
      // 汇总：证据不足（UNVERIFIED / EXTRACTION_FAILED）优先于 DEAD_CODE ---
      if (judged.some(j => j.status === 'EXTRACTION_FAILED')) return { status: R.EXTRACTION_FAILED, detail }
      if (judged.some(j => j.status === 'UNVERIFIED')) return { status: R.UNVERIFIED, detail }
      if (judged.some(j => j.status === 'DEAD_CODE')) return { status: R.DEAD_CODE, detail }
      return { status: R.CONSISTENT, detail }
    },
  },
  {
    id: 'constraint-relations',
    title: '⑮ 约束关系：数值事实 / 关系声明 / 关系验证（仅登记对象）',
    relation: 'same-source · gen-le-platform · producer-consumer',
    needsContract: false,
    needsConstraints: true,
    run(s) {
      const c = s.constraints
      if (!c) return { status: R.EXTRACTION_FAILED, detail: ['约束事实未提供'] }
      const facts = judgeConstraints(c)
      const detail = facts.map(f => f.id + '=' + f.status + '（' + f.why + '）')
      if (facts.some(f => f.status === 'DRIFT')) return { status: R.DRIFT, detail, facts }
      if (facts.some(f => f.status === 'UNVERIFIED')) return { status: R.UNVERIFIED, detail, facts }
      if (facts.some(f => f.status === 'INTENTIONAL_DIFFERENCE')) return { status: 'INTENTIONAL_DIFFERENCE', detail, facts }
      return { status: R.CONSISTENT, detail, facts }
    },
  },
  {
    id: 'capability-counterexample',
    title: '⑯ 能力反例：实现阻断 / 入口缺失 / 无法判定（只报可证明的反例）',
    relation: '能力声明 × 实现阻断证据 × 执行入口',
    needsContract: false,
    needsUploaders: true,
    run(s) {
      const u = s.uploaders
      const dirToPlatform = dir => {
        const k = s.keys[dir]
        if (k) return k.platform
        const p = s.planned?.find(x => x.dir === dir)
        return p?.platform ?? null
      }
      const facts = judgeCounterexamples(u, s.enginePublish, dirToPlatform)
      const detail = facts.map(f => f.id + '=' + f.status + '（' + f.why + '）')
      if (facts.some(f => f.status === 'EXTRACTION_FAILED')) return { status: R.EXTRACTION_FAILED, detail, facts }
      if (facts.some(f => f.status === 'UNVERIFIED')) return { status: R.UNVERIFIED, detail, facts }
      if (facts.some(f => String(f.status).startsWith('COUNTEREXAMPLE'))) return { status: R.DRIFT, detail, facts }
      return { status: R.CONSISTENT, detail, facts }
    },
  },
  {
    id: 'evidence-chain',
    title: '⑰ 证据链：能力声明 × CLI action × 实现阻断 × 参数契约（跨层）',
    relation: '声明/入口/实现/协议 四层关联',
    needsContract: false,
    needsUploaders: true,
    needsEvidence: true,
    run(s) {
      const rows = s.evidenceRows
      if (!rows || rows.length === 0) return { status: R.EXTRACTION_FAILED, detail: ['证据链为空：底层提取可能失败'] }
      const judged = judgeEvidence(rows)
      const detail = judged.map(j => j.platformId + '/' + j.contentType + '=' + j.status)
      // 证据不足优先
      if (judged.some(j => j.status === 'EXTRACTION_FAILED')) return { status: R.EXTRACTION_FAILED, detail, facts: judged }
      if (judged.some(j => j.status === 'UNVERIFIED')) return { status: R.UNVERIFIED, detail, facts: judged }
      // 声明与执行链矛盾 → 红
      const contradictions = judged.filter(j => ['MISSING_ENTRY', 'IMPLEMENTATION_BLOCKED', 'CONTRACT_MISMATCH'].includes(j.status))
      if (contradictions.length > 0) return { status: R.DRIFT, detail: contradictions.map(j => j.platformId + '/' + j.contentType + '=' + j.status + '（' + j.why + '）'), facts: judged }
      return { status: R.CONSISTENT, detail, facts: judged }
    },
  },
  {
    id: 'cli-map-agreement',
    title: '⑧ 映射表一致性：PLATFORM_KEYS.engineKey vs worker.CLI_PLATFORM_MAP vs CLI 契约',
    relation: 'R1 映射一致',
    needsContract: true,
    run(s) {
      if (!s.hasContract) return { status: R.EXTRACTION_FAILED, detail: ['CLI 契约未提供'] }
      const keysEngine = [...new Set(Object.values(s.keys).map(k => k.engineKey))]
      const missing = keysEngine.filter(k => !(k in s.cliMap))
      if (missing.length) return { status: R.DRIFT, detail: ['CLI_PLATFORM_MAP 缺: ' + missing.join(',')] }
      const badValue = Object.entries(s.cliMap).filter(([, v]) => !s.cliPlatforms.includes(v))
      return badValue.length
        ? { status: R.DRIFT, detail: ['CLI_PLATFORM_MAP 值在契约里不存在: ' + badValue.map(x => x[0] + '→' + x[1]).join(',')] }
        : { status: R.CONSISTENT, detail: [] }
    },
  },
]