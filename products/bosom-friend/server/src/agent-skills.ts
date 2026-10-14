/**
 * 经验升格为**技能**：把一条被用户认可的成功样例，蒸馏成"下次遇到同类任务可以直接照做"的流程，
 * 写成官方技能通道认得的文件（`$DSH_HOME/skills/<slug>.md`）。
 *
 * 为什么落在磁盘上、而不是再拼一段提示词（ADR-003 口径四）：
 * - `dsh-skill-filesystem` 扫描 `$DSH_HOME/skills`，技能进的是**会话的技能目录**，
 *   模型可以按名字挑用，而不是被动接受一段上下文；
 * - 文件是用户的资产：他能读、能改、能删，也就不会出现"模型学了一堆我看不见的东西"。
 *
 * 与"质量语境"（{@link buildQualityContext}）的分工：那边喂的是**同类产出样例**（照着这个水准做），
 * 这边沉淀的是**流程**（这一类任务分几步做）。样例是原料，技能是方法。
 *
 * @module @deepseek-ai/dsh-bosom-friend-server/agent-skills
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeDataText } from './store.ts'

/** 一条待落盘的技能。 */
export interface SkillDraft {
  /** 文件 slug（含稳定后缀）：同一条样例重复升格时覆盖同一个文件。 */
  slug: string
  /** 技能名（模型在技能目录里看到的名字）。 */
  name: string
  /** 一句话说明"这个技能是干什么的"（模型据此判断要不要用）。 */
  description: string
  /** 什么时候该用它。 */
  whenToUse: string
  /** 流程正文（Markdown）。 */
  body: string
}

/**
 * 每个角色的技能目录里最多留多少个技能：太多会让技能目录变成第二个"什么都有"的知识库。
 * 2026-10-12 起按**角色**分别计数——共用一个上限时，总管的历史技能会把四个管家挤爆。
 */
export const MAX_SKILLS = 12
/** 技能名与 slug 的长度上限（文件名要跨平台安全）。 */
const MAX_NAME_CHARS = 40
/** 归档子目录：`dsh-skill-filesystem` 只扫根目录的顶层文件，子目录不会被当成技能。 */
const ARCHIVE_DIR = 'archive'

/**
 * 官方 provider 认的技能名：**只允许小写 ASCII 与连字符**。
 *
 * 规则来自 `@deepseek-ai/dsh-skill`：`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，
 * 不满足的技能会被**静默丢弃**（provider 只记一条 warning，模型侧看不出区别）。
 * 实测过：同一个技能文件，名字写成非 kebab-case 时技能目录里没有它，改成 kebab-case 就出现了
 * ——**用户点了升格、界面说成功，而模型永远看不到**。
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 把一段描述压成**合法的技能名**。
 *
 * 为什么不留汉字：provider 的名字规则不接受非 ASCII，保留汉字等于让整个技能消失。
 * 中文的"这是什么任务"走 {@link SkillDraft.description} 与 `whenToUse`——那两处是自由文本，
 * 而模型在技能目录里看到的正是"名字 + 说明"，所以人话一点都不少。
 *
 * @param text - 指令或标题原文。
 * @returns 合法短名；压不出任何 ASCII 字符时返回 `skill`。
 */
export function skillName(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/, '')
  return cleaned === '' ? 'skill' : cleaned
}

/** FNV-1a 32 位哈希：只为"同一条样例稳定映射到同一个文件"，不做安全用途。 */
function shortHash(text: string): string {
  let hash = 0x811C9DC5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(-7)
}

/**
 * 一条样例在技能目录里该用什么名字。
 *
 * 优先用账本上记的**人话标签**（对象级动作会记"AI 改标题：<对象标题>"），
 * 只有旧样本没有标签时才回退到原始指令——那段指令可能是带脚手架的整段提示词，
 * 拿它当名字会得到一串谁也读不懂的字段名。
 *
 * @param record - 账本记录里与命名有关的字段。
 * @returns 用于技能名与 slug 的短文本。
 */
export function skillBaseName(record: { instruction: string, instructionLabel?: string }): string {
  return record.instructionLabel !== undefined && record.instructionLabel.trim() !== ''
    ? record.instructionLabel
    : record.instruction
}

/**
 * 由样例来源 id 与指令算出稳定 slug。
 *
 * 为什么带哈希后缀：两条不同的指令完全可能压出同一个短名（都被截断到 40 字时尤其如此），
 * 只按短名落盘会让后一条**静默覆盖**前一条。后缀让"一条样例 ↔ 一个文件"成立，重复升格又是幂等的。
 *
 * @param sourceId - 蒸馏样本的来源 id。
 * @param instruction - 当时的用户指令。
 * @returns 文件名（不含扩展名）。
 */
export function skillSlug(sourceId: string, instruction: string): string {
  return skillName(instruction) + '-' + shortHash(sourceId)
}

/** YAML 双引号标量：走 JSON.stringify，中文与特殊字符都不需要额外转义规则。 */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * 渲染一个技能文件（frontmatter + 正文）。
 *
 * frontmatter 的 `name` 与 `description` 是官方 provider 的**必填**字段——
 * 少一个整个技能会被静默跳过（provider 只记一条 warning，模型侧看不出区别），
 * 所以这两个字段由本函数保证，不接受调用方省略。
 *
 * @param draft - 技能内容。
 * @returns 可直接落盘的 Markdown 文本。
 */
export function renderSkillFile(draft: SkillDraft): string {
  return [
    '---',
    'name: ' + yamlString(draft.name),
    'description: ' + yamlString(draft.description),
    'whenToUse: ' + yamlString(draft.whenToUse),
    'metadata:',
    '  managed-by: bosom-friend',
    '---',
    '',
    draft.body.trim(),
    '',
  ].join('\n')
}

/** 升格门槛：只有**成功**且被用户打了 {@link MIN_SKILL_RATING} 分以上的样例才有资格。 */
import { MIN_SKILL_RATING } from './knowledge-distill.ts'

export { MIN_SKILL_RATING }

/** 账本里与技能有关的那几个字段（只声明用到的，避免把整个记录类型拖进来）。 */
export interface PromotableRecord {
  status: string
  rating: number
  createdAt: string
  /** 升格后写到哪个技能文件；没升格过就没有这个字段。 */
  skillPath?: string
  /** 来源实体 id；按角色分桶时用它反查任务（缺省视为总管）。 */
  sourceId?: string
}

/** 任务的最小投影：升格记录靠 sourceId 反查它，拿归属管家。 */
export interface SkillTaskRef {
  id: string
  agentRole?: string
}

/**
 * 一条升格记录归哪个管家。
 *
 * 依据只有 sourceId：账本里没有角色字段，而 `POST agent/tasks` 那条链路的 sourceId 形如
 * `<taskId>-<sha8>`，能反查到任务就取它的 agentRole。反查不到（object-action-*、chat-*、
 * gen.id、reception-suggest-* 等来源）**一律归总管**——与 agentRoleOfFocus「判不准不猜」
 * 同一条纪律：写错一个管家比写「未登记」更糟，用户会以为这件事已经交给了别人。
 *
 * @param record - 至少要有 sourceId 的记录投影。
 * @param tasks - 当前任务表（`store.files.tasks`）。
 * @returns 角色代号；判不出来时是 `steward`。
 */
export function skillRoleOfRecord(record: { sourceId: string }, tasks: readonly SkillTaskRef[]): string {
  const match = /^(task-[a-z0-9]+)/.exec(record.sourceId)
  const task = match === null ? undefined : tasks.find(item => item.id === match[1])
  return task?.agentRole ?? 'steward'
}

/**
 * 这条样例有没有资格升格成技能。
 *
 * 为什么要门槛（ADR-003 口径四的硬约束）：技能会被模型当成"该照做的流程"，
 * 把一次失败或用户明确不满意的产出升格，等于把错误固化成习惯。
 *
 * @param record - 账本记录。
 * @returns 有资格时为 true。
 */
export function eligibleForSkill(record: PromotableRecord): boolean {
  return record.status === 'success' && record.rating >= MIN_SKILL_RATING
}

/**
 * 由账本算出"技能目录该留哪些文件"——**账本是事实源，目录是它的投影**。
 *
 * 排序按（评分降序，时间降序）：用户打了 5 分的比 4 分的更该留下；
 * 同分时新的优先。超出 {@link MAX_SKILLS} 的交给 {@link curateSkills} 归档。
 *
 * @param records - 全部账本记录。
 * @returns 该保留的技能文件名（含扩展名）。
 */
export function skillFilesToKeep(
  records: readonly PromotableRecord[],
  role?: string,
  tasks: readonly SkillTaskRef[] = [],
): string[] {
  const wanted = (role ?? '').trim()
  return records
    // 只要"任务成功且升格过"就保留——**这里不再要求评分**。
    //
    // 为什么与 {@link eligibleForSkill} 分开：「能不能学」和「学过的要不要留」是两件事。
    // 自动复盘（Nudge 的技能复盘、历史补课）用的是"工具调用次数"这条判据，那些样本 rating 是 0；
    // 若这里继续用 rating ≥4 过滤，就等于**刚学会就立刻被自己归档**——技能文件躺在
    // skills/archive/ 里，模型在技能目录里根本看不到它（2026-09-30 实测：三个自动学到的技能
    // 全进了 archive，其中两个是当天刚生成的，等于白学）。
    .filter(record => record.status === 'success' && typeof record.skillPath === 'string' && record.skillPath !== '')
    // 按角色分桶：上限是**每个角色** 12 个（多角色共用一个上限时，总管的历史技能会把
    // 四个管家挤爆）。role 为空时不过滤，旧调用（api.ts）行为不变。
    .filter(record => wanted === '' || skillRoleOfRecord({ sourceId: record.sourceId ?? '' }, tasks) === wanted)
    .sort((left, right) => right.rating - left.rating || right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_SKILLS)
    .map(record => record.skillPath as string)
}

/**
 * 升格提示词：要的是**流程**，不是把当时的产出再抄一遍。
 *
 * 为什么把这句写死在这里：模型的天性是复述输入。要它给出可复用的方法，
 * 必须明确"不要照抄产出"，并给一个具体的形状（几步、每步做什么、怎么算做完）。
 *
 * @param instruction - 当时的用户指令（这一类任务的代表）。
 * @param output - 当时被用户认可的产出。
 * @returns 送给模型的提示词。
 */
export function buildSkillDistillPrompt(instruction: string, output: string): string {
  return [
    '下面是一次**被用户认可**的内容任务（用户打了高分）。请把它蒸馏成一条可复用的流程，',
    '供以后遇到同类任务时直接照做。',
    '',
    '【当时的任务】',
    instruction,
    '',
    '【当时被认可的产出】',
    output,
    '',
    '【怎么蒸馏】',
    '- 只输出流程本身：分几步、每一步做什么、做完怎么判断这一步过了。',
    '- 不要照抄上面的产出内容，也不要复述这次的具体题材与数字。',
    '- 控制在 8 步以内，用 Markdown 有序列表；开头用一句话说明这条流程适用于哪类任务。',
  ].join('\n')
}

/** 流程正文上限：技能是"照做的方法"，不是长文档。 */
const MAX_PROCEDURE_CHARS = 4000

/**
 * 整理模型给出的流程正文：剥掉最外层代码围栏、收敛空行、限长。
 *
 * @param text - 模型输出。
 * @returns 可写进技能文件的正文。
 */
export function normalizeProcedure(text: string): string {
  let value = text.trim()
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(value)
  if (fenced?.[1] !== undefined) value = fenced[1]
  return value.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_PROCEDURE_CHARS)
}

/** 本应用自己写的技能才带这个标记；用户手写的技能没有。 */
const MANAGED_MARKER = 'managed-by: bosom-friend'

/** 列出技能根下的技能文件（不含归档子目录）。 */
function listSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter(name => name.endsWith('.md')).sort()
  }
  catch {
    // 目录读不了（权限/被占用）时按"没有技能"处理：刷新不该因此整轮失败，
    // 下一轮冷启动还会再试一次。
    return []
  }
}

/**
 * 技能根目录（官方 `dsh-skill-filesystem` 扫描的 user-dsh 根）。
 *
 * @param dshHome - 内核的 `DSH_HOME`（产品数据根的上一级）。
 * @returns 技能目录的绝对路径。
 */
export function skillsDirOf(dshHome: string, role?: string): string {
  const wanted = (role ?? '').trim()
  // role 为空 = 未接管的调用方（api.ts 里那两处旧写入点）：保持旧位置，行为不变。
  return wanted === '' ? join(dshHome, 'skills') : join(dshHome, '.agent-presets', wanted, 'skills')
}

/** 五个管家的词表：与 presets/roles.json 的键、server/src/types.ts 的 ZyAgentRole 一一对应。 */
const SKILL_ROLES = ['steward', 'creator', 'publisher', 'operator', 'device'] as const

/**
 * 一次把**所有角色**的技能目录收到与账本一致。
 *
 * 为什么需要它：整理发生在两处没有"当前角色"的上下文里——会话建立前的语境刷新
 * （api.ts 的 refreshAgentContext）与历史补课之后；而每个角色目录各有自己的 12 上限与归档，
 * 漏掉哪个，哪个目录就会长成没人管的堆积。
 *
 * @param dshHome - 内核的 DSH_HOME。
 * @param records - 蒸馏账本。
 * @param tasks - 任务表（角色判定用，见 {@link skillRoleOfRecord}）。
 * @returns 被归档的文件名（全部角色合计）。
 */
export function curateSkillsByRole(dshHome: string, records: readonly PromotableRecord[]): string[] {
  // 判据以**目录**为单位：文件在哪个角色目录，就归那个目录的上限管。账本只提供评分与时间。
  //
  // 口径提醒（2026-10-12 夜）：**「目录里的 .md 文件数」与「provider 实际接受的技能数」是两个数**。
  // 前者用 listSkillFiles 数；后者还要 frontmatter 的 name 合法（kebab-case，否则 provider 静默丢弃）
  // 并经 registry 按 rank 合并去重。两个数对不上时先分别量一次，再判断是"文件没了"还是"文件在但不认"——
  // 那晚 12 个升格技能被误归档时，两个数是一起掉的（文件真的从目录里消失）。
  //
  // 为什么不是「按记录反查出来的角色分桶」（2026-10-12 夜的事故）：升格记录只有文件名、没有目录，
  // 而反查角色依赖任务的 agentRole——**老任务的 agentRole 是 undefined，反查一律归总管**，
  // 于是按名字迁移进 publisher / creator / operator 目录的 12 个升格技能被当成「不属于本角色」
  // 整批归档，用户认可过的经验从模型可见面消失。目录才是文件的家（见 curateSkills 的 owned 参数）。
  const rank = new Map<string, { rating: number, createdAt: string }>()
  for (const record of records) {
    if (record.status !== 'success' || typeof record.skillPath !== 'string' || record.skillPath === '') continue
    rank.set(record.skillPath, { rating: record.rating, createdAt: record.createdAt })
  }
  const archived: string[] = []
  for (const role of SKILL_ROLES) {
    const owned = listSkillFiles(skillsDirOf(dshHome, role)).filter(file => rank.has(file))
    const keep = [...owned]
      .sort((left, right) => {
        /* v8 ignore next -- owned 里的每一项都来自 rank（上一步 filter），取不到即不可能 */
        const a = rank.get(left) ?? { rating: 0, createdAt: '' }
        const b = rank.get(right) ?? { rating: 0, createdAt: '' }
        return b.rating - a.rating || b.createdAt.localeCompare(a.createdAt)
      })
      .slice(0, MAX_SKILLS)
    archived.push(...curateSkills(dshHome, keep, role, owned))
  }
  return archived
}

/**
 * 写一个技能文件（升格这一步）。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param draft - 技能内容。
 * @returns 写出的文件名（含扩展名）。
 */
export function writeSkill(dshHome: string, draft: SkillDraft, role?: string): string {
  const dir = skillsDirOf(dshHome, role)
  mkdirSync(dir, { recursive: true })
  const file = draft.slug + '.md'
  writeDataText(join(dir, file), renderSkillFile(draft))
  return file
}

/**
 * Curator：只保留 `keep` 里的技能，其余归档。
 *
 * 归档而不是删除：技能是"用户认可过的经验"，删掉就找不回来了。
 * 归档目录在技能根之下、顶层之外——官方 provider 只扫顶层文件，所以归档即"退出目录"。
 *
 * @param dshHome - 内核的 `DSH_HOME`。
 * @param keep - 要保留的文件名（含扩展名）；其余一律归档。
 * @param role - 要整理的角色目录；缺省是旧位置（$DSH_HOME/skills）。
 * @param owned - 本角色目录**该有**的文件名全集（含超出上限的）。给了它就只归档
 *   「列在 owned 里、又不在 keep 里」的文件；不在 owned 里的文件一律不动。
 *   为什么需要这一层（2026-10-12 夜实测的事故）：升格记录只有文件名、没有目录，
 *   而「记录反查出来的角色」可能与文件**实际所在的目录**不一致（老任务的 agentRole 是
 *   undefined → 反查一律归总管）。只按 keep 归档时，那些文件会在所在目录里被当成
 *   「不属于本角色」整批归档——12 个用户认可过的经验因此从模型可见面消失。
 * @returns 被归档的文件名。
 */
export function curateSkills(dshHome: string, keep: readonly string[], role?: string, owned?: readonly string[]): string[] {
  const dir = skillsDirOf(dshHome, role)
  const kept = new Set(keep)
  const ownedSet = owned === undefined ? undefined : new Set(owned)
  const archived: string[] = []
  for (const file of listSkillFiles(dir)) {
    if (kept.has(file)) continue
    if (ownedSet !== undefined && !ownedSet.has(file)) continue
    // 只归档**本应用写的**技能：技能根是用户的空间，他手写的技能不在账本里，
    // 不分青红皂白地"投影"会把用户的东西搬走——那是数据丢失，不是整理。
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    }
    catch {
      // 读不了就当作不是我们的，留着：宁可少归档一个，也不要动用户的东西。
      continue
    }
    if (!text.includes(MANAGED_MARKER)) continue
    archived.push(file)
    const target = join(dir, ARCHIVE_DIR)
    mkdirSync(target, { recursive: true })
    const destination = join(target, file)
    // 同名的旧归档先清掉，否则 Windows 上 rename 到已存在的目标会直接抛。
    rmSync(destination, { force: true })
    renameSync(join(dir, file), destination)
  }
  return archived
}
