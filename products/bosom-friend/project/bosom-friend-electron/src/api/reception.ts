import http from './request';

/** 自动接待规则 */
export interface ReceptionRule {
  id: string;
  name: string;
  accountId?: string;
  platforms: string[];
  keywords: string[];
  matchMode?: 'any' | 'all';
  excludeKeywords?: string[];
  cooldownMinutes?: number;
  replyMode: 'ai' | 'template';
  template?: string;
  aiModel?: string;
  systemPrompt?: string;
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

/** 测试接待结果 */
export interface TestReceptionResult {
  matched: boolean;
  rule?: ReceptionRule;
  reply?: string;
  aiUsed?: boolean;
}

/** 接待建议草稿（只生成，不发送、不落接待日志）。 */
export interface ReceptionSuggestion {
  matched: boolean;
  ruleId?: string;
  ruleName?: string;
  reply?: string;
  aiUsed?: boolean;
}

/** 平台互动待办：引擎只读采集后登记，发送由前端按钮触发。 */
export interface ReceptionPendingItem {
  id: string;
  kind: 'comment' | 'dm';
  platform: string;
  accountId: string;
  workId?: string;
  workTitle?: string;
  commentKey?: string;
  commentText?: string;
  username?: string;
  sessionId?: string;
  peerName?: string;
  matched: boolean;
  ruleName?: string;
  reply?: string;
  at: string;
  status?: 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';
  handledAt?: string;
  error?: string;
  sentText?: string;
}

export const receptionApi = {
  getRules() {
    return http.get<ReceptionRule[]>('/v2/customer-reception/rules');
  },

  createRule(data: Partial<ReceptionRule>) {
    return http.post<ReceptionRule>('/v2/customer-reception/rules', data);
  },

  updateRule(ruleId: string, data: Partial<ReceptionRule>) {
    return http.put<ReceptionRule>(`/v2/customer-reception/rules/${ruleId}`, data);
  },

  deleteRule(ruleId: string) {
    return http.delete<{ ok: boolean }>(`/v2/customer-reception/rules/${ruleId}`);
  },

  testReception(data: { message: string; platform?: string }) {
    return http.post<TestReceptionResult>('/v2/customer-reception/test', data);
  },

  suggest(data: { message: string; platform?: string; accountId?: string }) {
    return http.post<ReceptionSuggestion>('/v2/customer-reception/suggest', data);
  },

  /** AI/规则实际回复记录（按客户收纳）。 */
  listReplies(params: {
    platform?: string;
    accountId?: string;
    kind?: 'comment' | 'dm';
    status?: 'sending' | 'succeeded' | 'failed';
    q?: string;
    limit?: number;
  } = {}) {
    const query = new URLSearchParams();
    if (params.platform) query.set('platform', params.platform);
    if (params.accountId) query.set('accountId', params.accountId);
    if (params.kind) query.set('kind', params.kind);
    if (params.status) query.set('status', params.status);
    if (params.q) query.set('q', params.q);
    query.set('limit', String(params.limit ?? 300));
    return http.get<ReceptionRepliesPayload>(`/v2/customer-reception/replies?${query.toString()}`);
  },

  clearReplies() {
    return http.delete<{ ok: boolean; cleared: number }>('/v2/customer-reception/replies');
  },

  /** 拉起「查看原对话」平台读取任务（私信读整段会话，评论读该作品评论线程）。 */
  startConversation(data: {
    platform: string;
    accountId: string;
    kind: 'comment' | 'dm';
    sessionId?: string;
    peerName?: string;
    workId?: string;
    workTitle?: string;
    createTime?: string;
    commentText?: string;
    username?: string;
  }) {
    return http.post<{ ok: boolean; taskId: string }>('/v2/customer-reception/conversation', data);
  },

  /** 读取原对话任务结果；done 时后端会把平台快照挂到 replyId 对应记录上。 */
  getConversation(taskId: string, replyId?: string) {
    const suffix = replyId ? `?replyId=${encodeURIComponent(replyId)}` : '';
    return http.get<ReceptionConversationResult>(`/v2/customer-reception/conversation/${taskId}${suffix}`);
  },
};

/** 平台原对话快照（消息来自平台页面/接口）。 */
export interface ReceptionConversationSnapshot {
  at: string;
  source: 'platform';
  kind: 'comment' | 'dm';
  messages: { from: 'me' | 'customer' | 'unknown'; text: string; time?: string }[];
  replyCount?: number;
  note?: string;
}

/** 原对话任务返回值：done 时带快照，failed 时带平台原因。 */
export interface ReceptionConversationResult {
  status: 'starting' | 'done' | 'failed';
  snapshot?: ReceptionConversationSnapshot;
  error?: string;
  ok?: boolean;
}

/** 一条 AI/规则回复记录（客户 + 原文 + 实际回复 + 平台结果）。 */
export interface ReceptionReplyRecord {
  id: string;
  taskId?: string;
  at: string;
  finishedAt?: string;
  platform: string;
  accountId: string;
  accountNickname?: string;
  kind: 'comment' | 'dm';
  customerKey: string;
  customerName: string;
  sourceText: string;
  workId?: string;
  workTitle?: string;
  replyText: string;
  ruleName?: string;
  status: 'sending' | 'succeeded' | 'failed';
  error?: string;
  conversation?: ReceptionConversationSnapshot;
}

/** 按客户聚合后的会话摘要（全局监控左栏用）。 */
export interface ReceptionCustomerThread {
  customerKey: string;
  customerName: string;
  platform: string;
  accountId: string;
  accountNickname?: string;
  kind: 'comment' | 'dm';
  lastAt: string;
  total: number;
  succeeded: number;
  failed: number;
  sending: number;
  lastSource: string;
  lastReply: string;
}

/** 回复记录接口返回。 */
export interface ReceptionRepliesPayload {
  total: number;
  records: ReceptionReplyRecord[];
  customers: ReceptionCustomerThread[];
}

/** 平台选项 */
export const RECEPTION_PLATFORMS = [
  { value: 'douyin', label: '抖音' },
  { value: 'xhs', label: '小红书' },
];

/** 平台互动（评论/私信）真实执行任务状态。 */
export interface InteractionTaskState {
  taskId?: string
  status?: 'starting' | 'done' | 'failed'
  op?: 'comments_list' | 'comment_reply' | 'dm_list' | 'dm_reply'
  platform?: string
  data?: {
    ok?: boolean
    comments?: Array<{
      key?: string
      workId?: string
      username?: string
      commentText?: string
      hasReply?: boolean
    }>
    conversations?: Array<{
      sessionId?: string
      peerName?: string
      lastText?: string
      time?: string
    }>
    status?: string
    message?: string
  }
  error?: string
  finishedAt?: string
}

/** 接待引擎真实状态（后台轮询回写）。 */
export interface ReceptionEngineStatus {
  enabled: boolean
  running: boolean
  lastPollAt: string | null
  rounds: number
  nextPollAt: string | null
  config: {
    intervalMinutes: number;
    maxRepliesPerRound: number;
    seenWindowMinutes?: number;
    cooldownMinutes?: number;
    maxPendingPerRound?: number;
  }
  accounts: Array<{
    accountId: string
    platform: string
    nickname?: string
    status: 'scanned' | 'risk' | 'no-login' | 'unsupported' | 'error'
    message?: string
    commentsFound?: number
    commentsReplied?: number
    commentsPending?: number
    dmsFound?: number
    dmsReplied?: number
    dmsPending?: number
    commentsFailed?: number
    dmsFailed?: number
    at: number
  }>
}

export const interactionApi = {
  /** 读取真实评论/私信（返回任务 id，轮询结果）。 */
  list(data: {
    platform: string
    accountId: string
    kind: 'comment' | 'dm'
    workId?: string
    workTitle?: string
    createTime?: string
  }) {
    return http.post<{ ok: boolean; taskId: string }>('/v2/customer-reception/interactions/list', data);
  },

  /** 在真实平台页面上回复评论/私信（返回任务 id，轮询结果）。 */
  reply(data: {
    platform: string
    accountId: string
    kind: 'comment' | 'dm'
    workId?: string
    workTitle?: string
    commentText?: string
    username?: string
    sessionId?: string
    peerName?: string
    replyText: string
  }) {
    return http.post<{ ok: boolean; taskId: string }>('/v2/customer-reception/interactions/reply', data);
  },

  getTask(taskId: string) {
    return http.get<InteractionTaskState>(`/v2/customer-reception/interactions/${taskId}`);
  },

  getStatus() {
    return http.get<ReceptionEngineStatus>('/v2/customer-reception/status');
  },

  /** 立即触发一轮轮询；triggered=false 表示引擎已在跑这一轮，本次没有启动新的一轮。 */
  pollNow() {
    return http.post<{ ok: boolean; triggered: boolean }>('/v2/customer-reception/poll-now', {});
  },

  getWorks(accountId: string) {
    return http.get<Array<{ workId: string; title?: string; createTime?: string }>>(`/v2/customer-reception/works/${accountId}`);
  },

  getPending() {
    return http.get<ReceptionPendingItem[]>('/v2/customer-reception/pending');
  },

  markPending(
    id: string,
    status: 'processing' | 'succeeded' | 'failed' | 'skipped',
    error?: string,
    sentText?: string,
  ) {
    return http.post<ReceptionPendingItem>(`/v2/customer-reception/pending/${id}/status`, {
      status,
      ...(error ? { error } : {}),
      ...(sentText ? { sentText } : {}),
    });
  },

  updateConfig(data: {
    intervalMinutes?: number;
    seenWindowMinutes?: number;
    cooldownMinutes?: number;
    maxPendingPerRound?: number;
  }) {
    return http.post<ReceptionEngineStatus['config']>('/v2/customer-reception/config', data);
  },
};

/** 轮询互动任务直到完成（最多 timeoutMs，默认 150 秒）。 */
export async function waitInteractionTask(taskId: string, timeoutMs = 150000): Promise<InteractionTaskState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await interactionApi.getTask(taskId);
      if (state && (state.status === 'done' || state.status === 'failed')) return state;
    } catch {
      // 网络瞬时错误继续重试
    }
    await new Promise(resolve => window.setTimeout(resolve, 1200));
  }
  return null;
}
