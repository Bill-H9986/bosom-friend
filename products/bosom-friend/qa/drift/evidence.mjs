/**
 * 统一证据模型：把三个检测方向的结果按**同一条能力**关联起来。
 *
 * 关键原则：
 *  - 本模块**不维护新的事实表**，只把已有提取结果按 (平台, 内容类型) 关联；
 *  - 每一层保留**原始证据位置**与**提取状态**，供追溯；
 *  - CLI action 存在**只证明入口存在**，不等于能力可执行。
 */

/** 内容形态 → 该形态在 CLI/实现里的命名特征。 */
const TYPE_HINTS = {
  video: /video/i,
  image_text: /note|image/i,
}

/**
 * 由 CLI action 列表推导该平台注册了哪些内容形态。
 * @param actions - CLI 注册的 action 名。
 * @returns 内容形态数组。
 */
export function typesFromActions(actions) {
  const out = []
  for (const [type, re] of Object.entries(TYPE_HINTS)) if (actions.some(a => re.test(a))) out.push(type)
  return out
}

/**
 * 构建统一证据链：每个 (平台, 内容类型) 一行，附三层证据与提取状态。
 *
 * @param input.uploaders - scan-uploaders.py 的结果。
 * @param input.cliActionsByPlatform - engineKey → 该平台注册的内容形态（由 action 推导）。
 * @param input.rawActionsByEngineKey - engineKey → action 名数组（原始证据）。
 * @param input.engineToCli - engineKey → CLI parser 名。
 * @param input.keys - platform-catalog 的目录→平台映射。
 * @param input.declaredTypes - 产品**实际对外声明**的内容形态（前端 modes 的来源）。
 * @param input.contractPlatforms - CLI 契约提取成功的平台集合。
 * @param input.dynamicMarkers - 无法排除的动态调用标记。
 * @returns 证据行数组。
 */
/**
 * 哪些 (平台, 动作) 的 CLI **必须**注册某个参数。
 *
 * 依据 2026-10-09 语义核验：只有 `douyin/upload-video` 的
 * `DouYinBaseUploader.set_self_declaration` 接收外部文本；
 * 百家号/微博自处理、小红书/虎扑是原创声明（语义不同）、
 * `douyin/upload-note` 的 Request 类没有该字段。
 *
 * 因此"产品有 declaration 字段"**不等于**"所有平台都必须注册该参数"——
 * 判据必须跟随真实契约，而不是要求全平台同构。
 */
export const REQUIRED_CLI_FIELDS_BY_TARGET = {
  // `--location` 同样只由 douyin/upload-video 消费（2026-10-09 DEF-235 语义核验）：
  // 抖音 set_location(page, text) 有调用点；小红书调用被注释；其余平台无实现。
  'douyin/upload-video': ['--declaration', '--location'],
}

export function buildEvidenceChain(input) {
  const rows = []
  input.__pid = ''
  const extraction = {
    uploaders: input.uploaders ? 'ok' : 'failed',
    contract: input.contractPlatforms ? 'ok' : 'failed',
    declared: input.declaredTypes ? 'ok' : 'failed',
  }
  for (const [dir, info] of Object.entries(input.uploaders?.uploaders ?? {})) {
    const preset = input.keys?.[dir]
    if (!preset) continue
    const platformId = preset.platform
    const engineKey = preset.engineKey
    const cliName = input.engineToCli?.[engineKey] ?? engineKey
    const actions = input.rawActionsByEngineKey?.[cliName] ?? []
    const registeredTypes = input.cliActionsByPlatform?.[engineKey] ?? []
    const declaredList = input.declaredTypes?.[platformId] ?? []
    // 该类实现上对应哪种内容形态（类名/阻断方法名只能作**线索**）
    for (const [cls, ci] of Object.entries(info.classes ?? {})) {
      const hinted = /note|image/i.test(cls) || (ci.blocked ?? []).some(b => /note|image/i.test(b.method))
        ? 'image_text'
        : (/video/i.test(cls) ? 'video' : null)
      if (hinted === null) continue
      input.__pid = platformId
      rows.push({
        platformId, engineKey, cliName, contentType: hinted,
        declaration: {
          declared: declaredList.includes(hinted),
          source: 'product modes（前端可见的能力声明）',
        },
        entry: {
          actions,
          actionExists: actions.some(a => TYPE_HINTS[hinted].test(a)),
          source: 'sau_cli.py 的 add_parser 注册（执行链证据）',
        },
        implementation: {
          cls,
          file: info.file,
          blocked: (ci.blocked ?? []).map(b => ({ method: b.method, raiseAt: b.raiseAt })),
          source: 'scan-uploaders.py 的 AST 提取（实现证据）',
        },
        protocol: {
          contractAvailable: (input.contractPlatforms ?? []).includes(cliName),
          // 该内容形态对应的 action 在契约里实际注册了哪些参数
          missingRequiredFields: (() => {
            const slot = input.contract?.[cliName]?.actions
            if (slot === undefined) return []
            const actionName = Object.keys(slot).find(a => TYPE_HINTS[hinted].test(a))
            if (actionName === undefined) return []
            // 只有登记在案的 (产品平台, 动作) 才要求对应参数
            const required = REQUIRED_CLI_FIELDS_BY_TARGET[input.__pid + '/' + actionName] ?? []
            const args = slot[actionName]?.args ?? {}
            return required.filter(f => !(f in args))
          })(),
          source: 'extract-contract.py 对真实 parser 的提取（协议证据）',
        },
        extraction,
        dynamicMarkers: input.dynamicMarkers ?? [],
      })
    }
  }
  return rows
}

/**
 * 跨层判定：按证据等级给出结论，**不把任一层的通过当成整链通过**。
 *
 * @param row - buildEvidenceChain 的一行。
 * @returns { status, why }
 */
export function judgeEvidenceRow(row) {
  const where = row.implementation.file + ':' + row.implementation.cls
  // ① 证据不足优先于一切结论
  if (row.extraction.uploaders === 'failed' || row.extraction.contract === 'failed' || row.extraction.declared === 'failed')
    return { status: 'EXTRACTION_FAILED', why: '必要源码提取失败：' + JSON.stringify(row.extraction) }
  if ((row.dynamicMarkers ?? []).length > 0)
    return { status: 'UNVERIFIED', why: '存在无法排除的动态调用（' + row.dynamicMarkers.join(',') + '），拒绝下结论' }
  const blocked = row.implementation.blocked.length > 0
  // ② 已声明：逐层核验
  if (row.declaration.declared) {
    if (!row.entry.actionExists)
      return { status: 'MISSING_ENTRY', why: '产品已声明 ' + row.platformId + '/' + row.contentType + '，但 CLI 未注册对应 action（' + where + '）' }
    if (blocked)
      return { status: 'IMPLEMENTATION_BLOCKED', why: '产品已声明 ' + row.platformId + '/' + row.contentType + '，action 已注册，但必要方法确定抛出 NotImplementedError（' + where + ' ' + row.implementation.blocked.map(b => b.method + '@' + b.raiseAt.join(',')).join('|') + '）' }
    if (!row.protocol.contractAvailable)
      return { status: 'CONTRACT_UNAVAILABLE', why: '声明与实现均在，但该平台的 CLI 参数契约提取不可用，协议层未核验' }
    if ((row.protocol.missingRequiredFields ?? []).length > 0)
      return { status: 'CONTRACT_MISMATCH', why: '产品声明 ' + row.platformId + '/' + row.contentType + '，但该 action 的 parser 未注册必需参数：' + row.protocol.missingRequiredFields.join(',') }
    // 链路各层齐备，但**语义执行**从未证明 —— 不得升级为"可用"
    return { status: 'SEMANTIC_EXECUTION_UNVERIFIED', why: '声明/入口/实现/协议四层齐备，但**参数是否被 action 实际消费**与真实账号执行均未验证（L2-syntactic 已过，L2-semantic/L3 未证）' }
  }
  // ③ 未声明：骨架不构成产品缺陷，但如实记录
  if (blocked)
    return { status: 'NO_COUNTEREXAMPLE_FOUND', why: '存在实现阻断（' + where + '），但产品未声明 ' + row.platformId + '/' + row.contentType + ' —— 骨架不算缺陷（阻断证据仍如实保留）' }
  return { status: 'NO_COUNTEREXAMPLE_FOUND', why: '未发现阻断证据 —— **这不等于已证明能力可用**' }
}