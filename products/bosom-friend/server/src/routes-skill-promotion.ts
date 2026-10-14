/**
 * 「把这条经验变成技能」的两条路由：可升格清单、升格动作。
 *
 * 2026-10-12 从 `api.ts` 搬出。为什么搬：`api.ts` 被冻结增长（总纲 L102「路由文件不再增长」，
 * 门禁 `qa/verify-api-size.mjs`），而这两条路由正是把它撑长的改动（8610 → 8647 行）；
 * 门禁给的三条路里走「把代码搬出去」——唯一能让基线只降不升的那条。
 *
 * 零循环依赖：本模块只依赖 agent-skills / knowledge-distill / http / agent-context。
 * `streamLlmWithDeltas` 与 `readStoredLlm` 定义在 api.ts，直接 import 会形成
 * api.ts ↔ 本模块的循环，因此由挂载方注入（见 {@link SkillPromotionPorts}）。
 */
import type { Deps, LlmOverride, RouteDef } from './api.ts'
import type { DistillationRecord, KnowledgeState } from './knowledge-distill.ts'
import { MIN_SKILL_RATING } from './knowledge-distill.ts'
import { writeFail, writeOk } from './http.ts'
import { dshHomeOf } from './agent-context.ts'
import {
  buildSkillDistillPrompt,
  curateSkills,
  eligibleForSkill,
  normalizeProcedure,
  skillBaseName,
  skillFilesToKeep,
  skillRoleOfRecord,
  skillSlug,
  writeSkill,
} from './agent-skills.ts'

/** 挂载方注入的模型能力：打破 api.ts ↔ 本模块的循环依赖。 */
export interface SkillPromotionPorts {
  /** 读当前生效的模型配置；没配置时路由给出可执行的提示。 */
  readStoredLlm: (dataRoot: string) => LlmOverride | undefined
  /** 用指定配置跑一次纯文本生成。 */
  streamLlm: (prompt: string, llm: LlmOverride) => Promise<{ text: string; error?: string }>
}

/** 追加「经验升格为技能」的路由。 */
export function appendSkillPromotionRoutes(deps: Deps, routes: RouteDef[], ports: SkillPromotionPorts): void {
  routes.push(
    {
      m: 'GET',
      p: 'knowledge/distill/promotable',
      h: ({ res, query }) => {
        // 「把这条经验变成技能」的服务端视图：够格的与已经升格过的各列一份。
        //
        // 为什么要有它：账本里攒着上千条经验，而升格端点只认 sourceId——
        // 内核管家拿不到这个 id，用户说「把这条经验变成技能」时它只能答「你去界面上点」，
        // 能力就等于没进对话。够格判定复用 eligibleForSkill，
        // 门槛（MIN_SKILL_RATING）因此仍然只有 knowledge-distill.ts 一个事实源。
        const limit = Math.max(1, Math.min(100, Number(query.get('limit') ?? 20) || 20))
        const all = (deps.store.files.knowledge.load() as KnowledgeState).distillations ?? []
        const newestFirst = (left: DistillationRecord, right: DistillationRecord): number =>
          right.createdAt.localeCompare(left.createdAt)
        const project = (record: DistillationRecord) => ({
          // sourceId 是升格那把钥匙（POST knowledge/distill/promote 认它）。
          sourceId: record.sourceId,
          id: record.id,
          // 人话标签是技能名的来源（见 skillBaseName）：投影掉它，
          // 管家与界面就只能拿带脚手架的原始指令当名字，读都读不懂。
          label: skillBaseName(record).slice(0, 80),
          task: record.task,
          rating: record.rating,
          createdAt: record.createdAt,
          skillPath: record.skillPath ?? '',
        })
        writeOk(res, {
          threshold: MIN_SKILL_RATING,
          promotable: all
            .filter(record => eligibleForSkill(record) && (record.skillPath ?? '') === '')
            .sort(newestFirst)
            .slice(0, limit)
            .map(project),
          promoted: all
            .filter(record => (record.skillPath ?? '') !== '')
            .sort(newestFirst)
            .slice(0, limit)
            .map(project),
          // 成功但还没到门槛的条数：管家据此实说「这条还差一次打分」，
          // 而不是含糊地答「没找到这条经验」。
          belowThreshold: all.filter(record => record.status === 'success' && record.rating < MIN_SKILL_RATING).length,
          total: all.length,
        })
      },
    },
    {
      m: 'POST',
      p: 'knowledge/distill/promote',
      h: async ({ res, body }) => {
        // 升格是**用户点出来的**动作，不是自动发生的：技能会被模型当成"该照做的流程"，
        // 自动升格等于让模型自己决定以后怎么做（其中包括把一次侥幸的成功固化成习惯）。
        const params = body as { sourceId?: unknown }
        const sourceId = typeof params.sourceId === 'string' ? params.sourceId : ''
        const knowledge = deps.store.files.knowledge.load() as KnowledgeState
        const record = (knowledge.distillations ?? []).find(item => item.sourceId === sourceId)
        if (record === undefined) {
          writeFail(res, '找不到这条样例', 40404)
          return
        }
        if (!eligibleForSkill(record)) {
          writeFail(res, '只有成功、并且被你打了 ' + String(MIN_SKILL_RATING) + ' 分以上的样例才能升格成技能', 40400)
          return
        }
        const llmOverride = ports.readStoredLlm(deps.dataRoot)
        if (llmOverride === undefined || llmOverride.model.trim() === '') {
          writeFail(res, '还没有配置大模型，请到 设置 → 自定义大模型 填好地址与密钥', 40401)
          return
        }
        const out = await ports.streamLlm(buildSkillDistillPrompt(record.instruction, record.output), llmOverride)
        if (out.text === '') {
          writeFail(res, '大模型没有返回内容：' + (out.error ?? '未知原因'), 40400)
          return
        }
        const procedure = normalizeProcedure(out.text)
        if (procedure === '') {
          writeFail(res, '模型这次没有给出可用的流程，请重试', 40400)
          return
        }
        // 人话标签（可能是中文）只进说明文本；**名字必须是合法的 ASCII kebab-case**，
        // 否则 provider 会静默丢弃整个技能（见 SKILL_NAME_PATTERN）。
        // 名字里带来源哈希后缀，保证两条不同样例不会互相覆盖。
        const label = skillBaseName(record)
        const name = skillSlug(record.sourceId, label)
        // 角色：账本里没有这个字段，靠 sourceId 反查任务；拿不到一律总管（见 skillRoleOfRecord）。
        // 技能因此落在**该角色自己的目录**里，而 preset 的 skill-filesystem 只扫本角色目录——
        // 发布类经验不会再被创作管家看到，这是「技能面即职责」在数据侧的同一刀。
        const tasks = deps.store.files.tasks.load()
        const role = skillRoleOfRecord(record, tasks)
        const file = writeSkill(dshHomeOf(deps.dataRoot), {
          slug: name,
          name,
          description: '「' + label + '」这一类任务被验证过的做法（由本机的成功样例蒸馏）',
          whenToUse: '用户要求做「' + label + '」这一类任务时',
          body: procedure,
        }, role)
        // 先写文件再记账：账本是技能的来源，记完这一次它才"存在"。
        record.skillPath = file
        deps.store.files.knowledge.save(knowledge)
        // 立刻按账本收一次：超上限的旧技能在这一刻归档，目录始终等于账本的投影。
        // 收只收**本角色**那一桶：其它角色的目录不归这次升格动（上限也是每角色一份）。
        curateSkills(dshHomeOf(deps.dataRoot), skillFilesToKeep(knowledge.distillations ?? [], role, tasks), role)
        writeOk(res, { path: file, name, chars: procedure.length, role })
      },
    },
  )
}
