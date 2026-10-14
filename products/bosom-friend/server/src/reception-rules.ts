/**
 * 接待规则纯函数匹配器。
 *
 * 只做规则决策，不访问平台、不落库、不调用大模型；供后端只读采集与前端建议共用，
 * 避免 routes-content 和 reception-engine 各写一份匹配逻辑导致漂移。
 * @module @deepseek-ai/dsh-bosom-friend-server/reception-rules
 */

import type { ReceptionRule } from './types.ts'

/** 规则匹配输入（与 platform/account 范围共用）。 */
export interface ReceptionMatchInput {
  message?: string
  platform?: string
  accountId?: string
}

/** 规则匹配结果（模板规则直接返回固定回复，AI 规则只标记需要生成）。 */
export interface ReceptionMatchOutcome {
  matched: boolean
  rule?: ReceptionRule
  ruleId?: string
  reply?: string
  aiUsed?: boolean
}

/**
 * 归一化访客消息：统一全半角（NFKC）、大小写、连续空白。
 * 这是平台文本处理通用做法，避免“什么时候到？”与“什么时候到”或全角问号漏匹配。
 */
export function normalizeReceptionText(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function ruleAppliesPlatform(rule: ReceptionRule, platform?: string): boolean {
  return rule.platforms.length === 0 || platform === undefined || rule.platforms.includes(platform)
}

function ruleMatchesKeywords(rule: ReceptionRule, message: string): boolean {
  // 兜底规则命中全部消息；未声明 matchAll 时空关键词仍视为不匹配，
  // 避免一条误配的空规则吞掉全部消息——两者语义必须分开。
  if (rule.matchAll === true) return true
  const keywords = (rule.keywords ?? [])
    .map(normalizeReceptionText)
    .filter(keyword => keyword !== '')
  if (keywords.length === 0) return false
  const excluded = (rule.excludeKeywords ?? [])
    .map(normalizeReceptionText)
    .filter(keyword => keyword !== '')
  if (excluded.some(keyword => message.includes(keyword))) return false
  return rule.matchMode === 'all'
    ? keywords.every(keyword => message.includes(keyword))
    : keywords.some(keyword => message.includes(keyword))
}

function matchInRules(rules: ReceptionRule[], input: ReceptionMatchInput): ReceptionMatchOutcome | undefined {
  const message = normalizeReceptionText(input.message ?? '')
  for (const rule of rules) {
    if (!ruleAppliesPlatform(rule, input.platform) || !ruleMatchesKeywords(rule, message)) continue
    if (rule.replyMode === 'template') {
      return {
        matched: true,
        rule,
        ruleId: rule.id,
        reply: rule.template ?? '',
        aiUsed: false,
      }
    }
    return { matched: true, rule, ruleId: rule.id, aiUsed: true }
  }
  return undefined
}

/**
 * 按优先级匹配接待规则。
 *
 * 既有语义保持：账号专属规则优先，未命中再回退平台级通用规则；
 * 同一层级按 priority 升序（数字小优先），平台为空表示全部平台。
 */
export function matchReceptionRules(rules: ReceptionRule[], input: ReceptionMatchInput): ReceptionMatchOutcome {
  const all = rules.filter(rule => rule.enabled)
  const hasAccount = input.accountId !== undefined && input.accountId !== ''
  const accountRules = hasAccount
    ? all.filter(rule => rule.accountId === input.accountId)
    : []
  const genericRules = all.filter(rule => rule.accountId === undefined)
  const byPriority = (list: ReceptionRule[]): ReceptionRule[] =>
    [...list].sort((a, b) => a.priority - b.priority)

  const accountHit = matchInRules(byPriority(accountRules), input)
  if (accountHit !== undefined) return accountHit
  return matchInRules(byPriority(genericRules), input) ?? { matched: false }
}
