/*
 * 内容安全过滤：发布/回复前检查违规敏感词，从源头避免内容违规触发账号风控
 * 覆盖：广告法绝对化用语 / 平台敏感词 / 违法违规内容
 */

// 广告法及平台典型违禁/敏感词（营销内容最容易踩坑的部分）
const SENSITIVE_WORDS = [
  // 广告法绝对化用语
  '国家级',
  '世界级',
  '全球第一',
  '全国第一',
  '全网第一',
  '销量第一',
  '排名第一',
  '顶级',
  '极致',
  '绝无仅有',
  '独一无二',
  '史无前例',
  '万能',
  '绝对',
  '唯一',
  '首个',
  '首家',
  '独家',
  '百分百',
  '100%',
  '根治',
  '治愈',
  '永久',
  '包治',
  '保证',
  '最佳',
  '最低价',
  '全网最低',
  '零风险',
  '稳赚不赔',
  '躺着赚钱',
  '日入过万',
  '月入十万',
  '暴富',
  // 违法违规
  '赌博',
  '博彩',
  '彩票',
  '刷单',
  '刷粉',
  '刷赞',
  '刷量',
  '代刷',
  '外挂',
  '破解',
  '私服',
  '代购违禁',
  '枪支',
  '毒品',
  '冰毒',
  '海洛因',
  '卖淫',
  '嫖娼',
  '诈骗',
  '洗钱',
  '传销',
  '裸聊',
  // 平台导流/诱导（自动回复中避免）
  '加微信领',
  '加v领',
  '扫码领红包',
  '点击链接领',
  '私聊发资源',
  '关注送',
  '转发抽奖必中',
];

// 白名单：营销语境下允许使用的安全表达（避免误杀）
const WHITE_WORDS = ['保驾护航', '安全保障', '绝对安全'];

export interface ContentCheckResult {
  ok: boolean;
  hitWords: string[];
}

/**
 * 检查一段内容是否包含违规敏感词
 */
export function checkContent(text: string | undefined | null): ContentCheckResult {
  if (!text) return { ok: true, hitWords: [] };
  const lower = text.toLowerCase();
  const hitWords: string[] = [];
  for (const word of SENSITIVE_WORDS) {
    const wl = word.toLowerCase();
    if (lower.includes(wl)) {
      // 白名单豁免：命中白名单短语时跳过（同一敏感词仍可能命中其他位置）
      const exempted = WHITE_WORDS.some((w) => wl.includes(w.toLowerCase()) && lower.includes(w.toLowerCase()));
      if (!exempted && !hitWords.includes(word)) {
        hitWords.push(word);
      }
    }
  }
  return { ok: hitWords.length === 0, hitWords };
}

/**
 * 过滤后返回安全的回复；若命中敏感词则返回 null，由上层决定重写或跳过
 */
export function sanitizeForPublish(
  text: string | undefined | null,
): { ok: boolean; safeText: string; hitWords: string[] } {
  const result = checkContent(text);
  return {
    ok: result.ok,
    safeText: text || '',
    hitWords: result.hitWords,
  };
}
