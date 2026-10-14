/**
 * verify-drift.mjs —— 第二份事实（漂移）常驻门禁。
 *
 * 用法:
 *   node qa/verify-drift.mjs              跑规则；有 DRIFT → exit 1
 *   node qa/verify-drift.mjs --selftest   验证门禁自身 6 个条件
 *   node qa/verify-drift.mjs --mutate <id> 注入漂移，断言必须报 DRIFT
 *
 * 设计要点：
 * - CLI 契约**每次现提取**（python ast → 临时文件），不读快照，避免快照成为新的漂移源。
 * - 提取失败一律 EXTRACTION_FAILED，绝不伪装成 CONSISTENT。
 * - 例外表只允许 cross-world / planned 两类，禁止「为了让检测通过」的例外。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { loadSources, loadAddressFacts, loadDeadFacts, loadConstraintFacts, loadUploaderFacts } from './drift/sources.mjs'
import { RULES, judgeDeadObjects, judgeConstraints, judgeCounterexamples, judgeEvidence } from './drift/rules.mjs'
import { buildEvidenceChain } from './drift/evidence.mjs'
import { R } from './drift/relations.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'drift', '.contract.runtime.json')
const args = process.argv.slice(2)
const mi = args.indexOf('--mutate')
const mutate = mi >= 0 ? args[mi + 1] : null
const selftest = args.includes('--selftest')

function extractContract() {
  const r = spawnSync('python', [join(HERE, 'drift', 'extract-contract.py'), TMP], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('契约提取失败: ' + (r.stderr || r.stdout || '').trim().slice(0, 200))
  return TMP
}

function runRules({ contractPath, mutate: m = null, address = null }) {
  const sources = loadSources({ contractPath, mutate: m })
  // 协议层证据：真实 parser 契约里已提取到的平台集合
  const contract = contractPath && existsSync(contractPath)
    ? JSON.parse(readFileSync(contractPath, 'utf8'))
    : {}
  sources.address = loadAddressFacts({ mutate: m })
  sources.dead = loadDeadFacts({ mutate: m })
  sources.constraints = loadConstraintFacts({ mutate: m })
  sources.uploaders = loadUploaderFacts({ mutate: m })
  {
    const base = loadSources({})
    const u = sources.uploaders
    const declaredTypes = {}
    for (const k of Object.values(base.keys)) declaredTypes[k.platform] = u.cliActionsByPlatform?.[k.engineKey] ?? []
    sources.evidenceRows = buildEvidenceChain({
      uploaders: u,
      cliActionsByPlatform: u.cliActionsByPlatform,
      rawActionsByEngineKey: u.rawActionsByEngineKey,
      engineToCli: u.engineToCli,
      keys: base.keys,
      declaredTypes,
      contractPlatforms: Object.keys(contract ?? {}),
      contract,
      dynamicMarkers: u.dynamicMarkers,
    })
  }
  sources.address = address ?? loadAddressFacts({ mutate: m })
  sources.dead = loadDeadFacts({ mutate: m })
  return RULES.map(rule => {
    let r
    try { r = rule.run(sources) }
    catch (e) { r = { status: R.EXTRACTION_FAILED, detail: [String(e.message).slice(0, 140)] } }
    return { id: rule.id, title: rule.title, relation: rule.relation, ...r }
  })
}

const icon = s => ({ CONSISTENT: '✓', DRIFT: '✗', SINGLE_SOURCE: '·', DECLARED_EXCEPTION: '≈', DEAD_CODE: '☠', EXTRACTION_FAILED: '!', UNVERIFIED: '?', INTENTIONAL_DIFFERENCE: '≈', NOT_APPLICABLE: '—' }[s] ?? '?')

function print(results) {
  console.log('规则'.padEnd(24) + '结果'.padEnd(20) + '明细')
  console.log('-'.repeat(100))
  for (const r of results)
    console.log(r.id.padEnd(24) + (icon(r.status) + ' ' + r.status).padEnd(20) + (r.detail.join(' ; ').slice(0, 110) || ''))
  console.log('-'.repeat(100))
  const drift = results.filter(r => r.status === R.DRIFT)
  const failed = results.filter(r => r.status === R.EXTRACTION_FAILED || r.status === R.UNVERIFIED)
  const dead = results.filter(r => r.status === R.DEAD_CODE)
  const factUn = results.flatMap(r => r.facts ?? []).filter(f => f.status === R.UNVERIFIED).length
  const factDrift = results.flatMap(r => r.facts ?? []).filter(f => f.status === R.DRIFT).length
  console.log('规则级：DRIFT=' + drift.length + '  EXTRACTION_FAILED/UNVERIFIED=' + failed.length + '  DEAD_CODE(告警不阻塞)=' + dead.length + '  其它=' + (results.length - drift.length - failed.length - dead.length))
  // 事实级单独统计：规则级会被更高优先级状态吞掉，只看规则级会误以为「没有未声明的候选关系」
  console.log('事实级：DRIFT=' + factDrift + '  UNVERIFIED=' + factUn + '（未声明的候选关系在此计数）')
  return { drift, failed }
}

try {
  // ─────────── 自检模式：验证门禁自身的 6 个条件 ───────────
  if (selftest) {
    const checks = []
    const contract = extractContract()
    const base = runRules({ contractPath: contract })

    // 条件 1：基线无漂移（wxGzh 已于 2026-10-09 移除；"能报红"由条件 6 的 mutation 证明）
    const wx = base.find(r => r.id === 'platform-keys')
    checks.push(['1 基线无漂移 (platform-keys 已随 wxGzh 移除而 CONSISTENT)', wx.status === R.CONSISTENT, wx.status])
    // 条件 2：正常状态→绿（用注入契约的对照：除 platform-keys 外必须全绿）
    // DEAD_CODE 是告警（不阻塞门禁），不计入"噪音"
    // 已知待确认发现（登记在缺陷台账，缺陷修复后须从本清单移除）
    // 已知待确认发现（登记在缺陷台账；缺陷关闭后须从本清单移除）
    // DEF-233 声明修正后本条反例已不再产生，故不留豁免项
    const KNOWN_OPEN = []
    const others = base.filter(r => r.id !== 'platform-keys' && r.id !== 'dead-code' && !KNOWN_OPEN.includes(r.id))
    // INTENTIONAL_DIFFERENCE = 已声明且满足关系的**有意差异**，不是噪音
    const allGreen = others.every(r => r.status === R.CONSISTENT || r.status === R.SINGLE_SOURCE || r.status === 'INTENTIONAL_DIFFERENCE')
    checks.push(['2 其余规则全绿（无噪音）', allGreen, others.map(r => r.id + '=' + r.status).join(' ')])
    // 条件 3：planned → 不误报（xianyu 在例外表）
    checks.push(['3 planned 例外不误报 (xianyu)', base.find(r => r.id === 'platform-keys').detail.join(';').includes('xianyu') === false, 'xianyu 未出现在 DRIFT 明细'])
    // 条件 4：cross-world → 不误报（youtube 在例外表）
    checks.push(['4 cross-world 例外不误报 (youtube)', base.find(r => r.id === 'publish-platforms').status === R.CONSISTENT, base.find(r => r.id === 'publish-platforms').status])
    // 条件 5：提取失败 → 不得伪装成一致
    let cond5 = false, c5detail = ''
    try {
      runRules({ contractPath: join(HERE, 'drift', '__no_such_file__.json') })
      c5detail = '未抛错（危险：伪装成一致）'
    } catch (e) { cond5 = String(e.message).includes('EXTRACTION_FAILED'); c5detail = String(e.message).slice(0, 80) }
    checks.push(['5 提取失败→EXTRACTION_FAILED（不伪装一致）', cond5, c5detail])
    // 条件 6：mutation → 一定抓住
    const muts = ['platform-keys', 'publish-platforms', 'display-name']
    const mutResults = muts.map(m => {
      const rs = runRules({ contractPath: contract, mutate: m })
      const t = rs.find(r => r.id === m)
      return { m, status: t ? t.status : 'n/a', caught: !!t && t.status === R.DRIFT }
    })
    checks.push(['6 mutation 全部被抓住', mutResults.every(x => x.caught), mutResults.map(x => x.m + '=' + x.status).join(' ')])
    const groupA = checks.length

    // ── DEAD_CODE 三维判据自证 ──
    // A 组：被检对象**当前状态**（证明当前产品没有被误判）
    const judgedNow = judgeDeadObjects(loadDeadFacts({}).objects)
    const sc = judgedNow.find(j => j.id === 'store.channels')
    const pc = judgedNow.find(j => j.id === 'PLATFORM_CONSTRAINTS')
    checks.push(['A1 store.channels 当前 → DEAD_CODE', sc.status === 'DEAD_CODE', sc.status + ' | ' + sc.why + ' | 意图=' + sc.intent])
    checks.push(['A2 PLATFORM_CONSTRAINTS 当前 → CONSISTENT（不误报）', pc.status === 'CONSISTENT', pc.status + ' | ' + pc.why + ' | 空值守卫=' + (pc.guardOk ? '有' : '无')])
    const groupB = checks.length

    // B 组：检测器**自身有效性**（mutation 注入，证明它能识别）
    const b1 = judgeDeadObjects(loadDeadFacts({ mutate: 'dead-code' }).objects).find(j => j.id === 'store.channels')
    checks.push(['B1 注入有效消费点 → 不再报 DEAD_CODE', b1.status !== 'DEAD_CODE', b1.status + ' | ' + b1.why])
    const b2 = judgeDeadObjects(loadDeadFacts({ mutate: 'dead-code-dynamic' }).objects).find(j => j.id === 'store.channels')
    checks.push(['B2 注入无法排除的动态访问 → UNVERIFIED', b2.status === 'UNVERIFIED', b2.status + ' | ' + b2.why])
    let b3 = false, b3d = ''
    try { loadDeadFacts({ mutate: 'dead-code-scan' }); b3d = '未抛错（危险：会伪装成一致）' }
    catch (e) { b3 = String(e.message).includes('EXTRACTION_FAILED'); b3d = String(e.message).slice(0, 70) }
    checks.push(['B3 扫描失败 → EXTRACTION_FAILED（不伪装一致）', b3, b3d])

    const groupC = checks.length
    // ── 约束关系：C 组 = 被检对象当前状态；D 组 = 规则自身有效性 ──
    const cNow = loadConstraintFacts({})
    const fNow = judgeConstraints(cNow)
    const pcField = fNow.find(f => f.kind === 'producer-consumer')
    const relNow = fNow.find(f => f.kind === 'decl' && f.id.includes('MAX_TOPICS'))
    // DEF-230 修复后：maxTotalTextLength 已删除并退役（不再监控）；topic.maxTotalLength 按**可选契约**处理
    const retiredGone = !fNow.some(f => f.id.includes('maxTotalTextLength'))
    checks.push(['C1 已退役字段 maxTotalTextLength 不再进入监控', retiredGone, retiredGone ? '监控清单中已无该字段' : '仍在监控'])
    const optField = fNow.find(f => f.kind === 'producer-consumer-optional')
    checks.push(['C1b topic.maxTotalLength 按可选契约 → CONSISTENT（不误报）', optField?.status === 'CONSISTENT', optField ? optField.why : '(无)'])
    // 2026-10-09：xhs.topics 退役后表中已无任何已声明话题上限 → 规则前提合法缺失，
    // 判 NOT_APPLICABLE（**不适用**，既不是通过，也不是提取失败）。
    checks.push(['C2 无已声明话题上限时 MAX_TOPICS 关系 → NOT_APPLICABLE（不适用，非通过）', relNow?.status === 'NOT_APPLICABLE', relNow ? relNow.why : '(无)'])
    const fNo = judgeConstraints(loadConstraintFacts({ mutate: 'constraint-nodecl' }))
    const unNo = fNo.find(f => f.kind === 'undeclared')
    checks.push(['C3 移除声明后 → UNVERIFIED（未声明不判 DRIFT，避免误报合理差异）', unNo?.status === 'UNVERIFIED', unNo ? unNo.why : '(无)'])
    const groupD = checks.length
    const fDecl = judgeConstraints(loadConstraintFacts({ mutate: 'constraint-decl' }))
    const gen = fDecl.find(f => f.kind === 'decl' && f.id.includes('MAX_TOPICS'))
    checks.push(['D1 注入 gen-le-platform 声明 → INTENTIONAL_DIFFERENCE', gen?.status === 'INTENTIONAL_DIFFERENCE', gen ? gen.why : '(无)'])
    const ss = fDecl.find(f => f.id.includes('同源'))
    checks.push(['D2 注入 same-source 声明 → CONSISTENT', ss?.status === 'CONSISTENT', ss ? ss.why : '(无)'])
    const fViol = judgeConstraints(loadConstraintFacts({ mutate: 'constraint-violate' }))
    const gv = fViol.find(f => f.kind === 'decl' && f.id.includes('MAX_TOPICS'))
    checks.push(['D3 平台上限降到低于生成上限 → DRIFT（声明不能放行违规）', gv?.status === 'DRIFT', gv ? gv.why : '(无)'])
    const fBad = judgeConstraints(loadConstraintFacts({ mutate: 'constraint-badmark' }))
    const bm = fBad.find(f => f.id.includes('无 target'))
    checks.push(['D4 标记缺 @constraintTarget → UNVERIFIED（标记本身也会漂移）', bm?.status === 'UNVERIFIED', bm ? bm.why : '(无)'])
    const fProd = judgeConstraints(loadConstraintFacts({ mutate: 'constraint-producer' }))
    const d5drift = fProd.filter(f => f.kind === 'producer-consumer' && f.status === 'DRIFT')
    const d5ok = fProd.find(f => f.kind === 'producer-consumer' && f.status === 'CONSISTENT')
    checks.push(['D5 注入生产者 → 该字段转为 CONSISTENT，不再有 DRIFT', d5drift.length === 0, d5ok ? d5ok.why : (d5drift.length ? '仍 DRIFT：' + d5drift.map(x => x.id).join(',') : '(无)')])
    let d6 = false, d6d = ''
    try { loadConstraintFacts({ mutate: 'constraint-scan' }); d6d = '未抛错（危险）' }
    catch (e) { d6 = String(e.message).includes('EXTRACTION_FAILED'); d6d = String(e.message).slice(0, 60) }
    checks.push(['D6 破坏必要数据源 → EXTRACTION_FAILED', d6, d6d])
    // D7/D8：**合法空集**与**提取失败**必须区分（本轮门禁修正的核心，2026-10-09）
    const fEmpty = judgeConstraints(loadConstraintFacts({}))
    const emptyRel = fEmpty.find(f => f.kind === 'decl' && f.id.includes('MAX_TOPICS'))
    checks.push(['D7 表结构有效但零个已声明上限 → NOT_APPLICABLE（不是 EXTRACTION_FAILED）', emptyRel?.status === 'NOT_APPLICABLE', emptyRel ? emptyRel.status + ' | ' + emptyRel.why : '(无)'])
    let d8ok = false, d8d = ''
    try { loadConstraintFacts({ mutate: 'constraint-scan' }); d8d = '未抛错（危险）' }
    catch (e) { d8ok = String(e.message).includes('EXTRACTION_FAILED') && !String(e.message).includes('NOT_APPLICABLE'); d8d = String(e.message).slice(0, 70) }
    checks.push(['D8 真实解析失败 → 仍 EXTRACTION_FAILED（不得降级为 NOT_APPLICABLE）', d8ok, d8d])
    let d9ok = false, d9d = ''
    try { loadConstraintFacts({ mutate: 'constraint-notable' }); d9d = '未抛错（危险）' }
    catch (e) { d9ok = String(e.message).includes('EXTRACTION_FAILED'); d9d = String(e.message).slice(0, 78) }
    checks.push(['D9 表结构无法解析 → EXTRACTION_FAILED（不得伪装成空集）', d9ok, d9d])

    const groupE = checks.length
    const dirToPlatform = dir => { const k = loadSources({}).keys[dir]; return k ? k.platform : null }
    const baseSources = loadSources({})
    const baseDecl = baseSources.enginePublish
    // 各平台**实际注册**的内容类型（与产品推导同源：CLI action）
    const declaredTypes = {}
    for (const [pid, acts] of Object.entries(baseSources.cliActionsByPlatform ?? {})) declaredTypes[pid] = acts
    // E 组：当前产品状态
    const uNow = loadUploaderFacts({})
    const fNow2 = judgeCounterexamples(uNow, baseDecl, dirToPlatform, declaredTypes)
    const tn = fNow2.find(f => f.id.startsWith('TencentNote'))
    checks.push(['E1 声明已修正后 wxSph+图文不再被判为已声明能力', tn?.status === 'NO_COUNTEREXAMPLE_FOUND', tn ? tn.why.slice(0, 120) : '(无)'])
    const dy = fNow2.find(f => f.id.startsWith('DouYinNote'))
    checks.push(['E2 对照组 DouYinNote 不被误报（无阻断证据）', dy === undefined, dy ? dy.status : '未出现在反例清单'])
    checks.push(['E3 当前反例清单为空（声明与实现一致）', fNow2.filter(f => String(f.status).startsWith('COUNTEREXAMPLE')).length === 0, '反例数=' + fNow2.filter(f => String(f.status).startsWith('COUNTEREXAMPLE')).length])
    checks.push(['E4 阻断证据仍被如实记录（不是失明，是不算缺陷）', String(tn?.why ?? '').includes('有阻断'), String(tn?.why ?? '').slice(0, 60)])
    const groupF = checks.length
    // F 组：检测器自身有效性（mutation）
    // 反向验证（产品负责人要求）：人为把视频号**重新声明**为支持图文 → 必须再次报出反例并阻止放行
    const reU = loadUploaderFacts({ mutate: 'counterexample-redeclare' })
    const reTypes = { ...declaredTypes, wxSph: ['video', 'image_text'] }
    const inj = judgeCounterexamples(reU, baseDecl, dirToPlatform, reTypes)
    const injHit = inj.filter(f => String(f.status).startsWith('COUNTEREXAMPLE'))
    checks.push(['F1 人为重新声明视频号图文 → 必须再次报出反例', injHit.length > 0, injHit.length ? injHit[0].status + ' | ' + injHit[0].why.slice(0, 100) : '未报出（危险）'])
    checks.push(['F5 该反例能阻止门禁放行（状态为 DRIFT 级）', injHit.some(f => f.status === 'COUNTEREXAMPLE_BLOCKED_NO_ENTRY'), injHit.map(f => f.status).join(',') || '(无)'])
    const clr = judgeCounterexamples(loadUploaderFacts({ mutate: 'counterexample-clear' }), baseDecl, dirToPlatform, declaredTypes)
    checks.push(['F2 移除该阻断后 → 不再报同一条反例', !clr.some(f => f.id.startsWith('TencentNote')), clr.map(f => f.id + '=' + f.status).join(',').slice(0, 80)])
    const dyn = judgeCounterexamples(loadUploaderFacts({ mutate: 'counterexample-dynamic' }), baseDecl, dirToPlatform, declaredTypes)
    checks.push(['F3 存在动态调用无法排除 → UNVERIFIED（不当作没有入口）', dyn[0]?.status === 'UNVERIFIED', dyn[0]?.status ?? '(无)'])
    let f4 = false, f4d = ''
    try { loadUploaderFacts({ mutate: 'counterexample-scan' }); f4d = '未抛错（危险）' }
    catch (e) { f4 = String(e.message).includes('EXTRACTION_FAILED'); f4d = String(e.message).slice(0, 60) }
    checks.push(['F4 扫描器失败 → EXTRACTION_FAILED（不伪装成没有反例）', f4, f4d])

    const groupG = checks.length
    // G 组：证据链（跨层判定）—— 当前状态 + mutation
    // 场景 2：把某个 action 的必需参数抹掉，验证能定位到 CLI 契约层
    const injectMissing = c => {
      const copy = JSON.parse(JSON.stringify(c))
      // 只有 douyin/upload-video 是登记在案的 declaration 消费者（语义核验结论）
      const slot = copy['douyin']?.actions?.['upload-video']
      if (slot) delete slot.args['--declaration']
      return copy
    }
    const mkRows = (m) => {
      const b = loadSources({})
      const uu = loadUploaderFacts({ mutate: m })
      const decl = {}
      for (const k of Object.values(b.keys)) decl[k.platform] = uu.cliActionsByPlatform?.[k.engineKey] ?? []
      const forced = uu.__forceDeclared ?? {}
      for (const [p, t] of Object.entries(forced)) decl[p] = t
      const contractObj = JSON.parse(readFileSync(extractContract(), 'utf8'))
      return buildEvidenceChain({
        uploaders: uu, cliActionsByPlatform: uu.cliActionsByPlatform,
        rawActionsByEngineKey: uu.rawActionsByEngineKey, engineToCli: uu.engineToCli,
        keys: b.keys, declaredTypes: decl, contractPlatforms: Object.keys(contractObj), contract: m === 'evidence-contract' ? injectMissing(contractObj) : contractObj,
        dynamicMarkers: uu.dynamicMarkers,
      })
    }
    const g0 = judgeEvidence(mkRows(null))
    const g0contra = g0.filter(j => ['MISSING_ENTRY', 'IMPLEMENTATION_BLOCKED', 'CONTRACT_MISMATCH'].includes(j.status))
    // 当前基线**存在**协议层真发现（--declaration 仅在部分 action 注册），断言如实反映：
    const g0byKind = {}
    for (const j of g0contra) g0byKind[j.status] = (g0byKind[j.status] ?? 0) + 1
    checks.push(['G1 当前基线跨层矛盾如实分类（已知：协议层 --declaration 缺失）', g0contra.every(j => j.status === 'CONTRACT_MISMATCH'), '行数=' + g0.length + ' 分类=' + JSON.stringify(g0byKind)])
    checks.push(['G2 四层齐备的能力一律不外推为可用', g0.filter(j => j.status === 'SEMANTIC_EXECUTION_UNVERIFIED').length > 0, 'SEMANTIC_EXECUTION_UNVERIFIED=' + g0.filter(j => j.status === 'SEMANTIC_EXECUTION_UNVERIFIED').length])
    const g1 = judgeEvidence(mkRows('evidence-blocked'))
    const g1hit = g1.filter(j => j.status === 'IMPLEMENTATION_BLOCKED')
    checks.push(['G3 action 存在但实现被阻断 → 必须报红（你说的隐患）', g1hit.length > 0, g1hit.length ? g1hit[0].platformId + '/' + g1hit[0].contentType + '：' + g1hit[0].why.slice(0, 90) : '未报出（危险）'])
    const g2 = judgeEvidence(mkRows('evidence-declare-only'))
    const g2hit = g2.filter(j => j.status === 'MISSING_ENTRY')
    checks.push(['G4 只恢复声明不给 action → 判为执行入口缺失', g2hit.length > 0, g2hit.length ? g2hit[0].platformId + '/' + g2hit[0].contentType : '未报出（危险）'])
    const g3 = judgeEvidence(mkRows('evidence-declare-and-action'))
    const g3hit = g3.filter(j => j.status === 'IMPLEMENTATION_BLOCKED')
    checks.push(['G5 声明与 action 都恢复 → 落到实现阻断（wxSph 图文）', g3hit.length > 0, g3hit.length ? g3hit[0].platformId + '/' + g3hit[0].contentType : '未报出（危险）'])
    let g6 = false, g6d = ''
    try { const b = loadSources({}); buildEvidenceChain({ uploaders: null, cliActionsByPlatform: {}, rawActionsByEngineKey: {}, engineToCli: {}, keys: b.keys, declaredTypes: {}, contractPlatforms: [], dynamicMarkers: [] }); g6d = '未抛错' }
    catch (e) { g6 = true; g6d = 'evidenceRows 为空时规则报 EXTRACTION_FAILED' }
    const g6rule = RULES.find(r => r.id === 'evidence-chain').run({ evidenceRows: [] })
    checks.push(['G6 证据链为空 → EXTRACTION_FAILED（不伪装成一致）', g6rule.status === R.EXTRACTION_FAILED, g6rule.status])

    const h2 = judgeEvidence(mkRows('evidence-contract')).filter(j => j.status === 'CONTRACT_MISMATCH')
    checks.push(['H1 唯一合法承载者(douyin/upload-video)缺必需参数 → 定位到契约层', h2.length > 0, h2.length ? h2[0].platformId + '/' + h2[0].contentType + '：' + (h2[0].row?.protocol?.missingRequiredFields ?? []).join(',') : '未报出（危险）'])
    // 反向对照：抹掉与不抹掉的差集必须**恰好**是多出来的那几行，证明定位精确而非泛红
    const h3 = judgeEvidence(mkRows(null)).filter(j => j.status === 'CONTRACT_MISMATCH')
    // 注入后应**恰好多出 1 条**命中（定位精确，不是泛红）
    const delta = h2.length - h3.length
    checks.push(['H2 注入使命中数恰好 +1（定位精确，不是泛红）', delta === 1, '注入前=' + h3.length + ' 注入后=' + h2.length + ' 差=' + (delta >= 0 ? '+' + delta : String(delta))])

    console.log('=== verify-drift 自检 ===')
    console.log('【第一部分】门禁整体 6 个条件（真漂移红 / 无噪音 / 例外不误报 / 提取失败 / mutation）')
    let allOk = true
    for (const [name, ok, detail] of checks) {
      if (!ok) allOk = false
      console.log((ok ? '✓ ' : '✗ ') + name + '  |  ' + detail)
    }
    console.log(allOk ? '\n自检全部通过' : '\n自检存在失败项')
    process.exit(allOk ? 0 : 1)
  }

  // ─────────── 单规则 mutate 自证 ───────────
  const contract = extractContract()
  const results = runRules({ contractPath: contract, mutate })
  const { drift, failed } = print(results)

  if (mutate) {
    const target = results.find(r => r.id === mutate)
    const ok = target && target.status === R.DRIFT
    console.log('\n=== 自证：注入 "' + mutate + '" → ' + (target ? target.status : 'n/a') + ' ===')
    console.log(ok ? '✓ 检测器抓住了注入的漂移' : '✗ 未抓住注入的漂移')
    process.exit(ok ? 0 : 1)
  }

  if (drift.length > 0) {
    console.log('\n[verify-drift] 发现 ' + drift.length + ' 条第二份事实漂移 —— 门禁红')
    process.exit(1)
  }
  if (failed.length > 0) {
    console.log('\n[verify-drift] ' + failed.length + ' 条规则提取失败 —— 门禁红（不得伪装成通过）')
    process.exit(1)
  }
  console.log('\n[verify-drift] 通过')
  process.exit(0)
} finally {
  if (existsSync(TMP)) rmSync(TMP, { force: true })
}