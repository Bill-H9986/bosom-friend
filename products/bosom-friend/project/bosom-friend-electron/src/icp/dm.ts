/*
 * 私信自动接待 IPC
 */

export interface DmStatus {
  enabled: boolean;
  lastPollAt: number | null;
  polling?: boolean;
  lastRound?: {
    accounts: number;
    conversations: number;
    replied: number;
    at: number;
  } | null;
}

export interface DmPollResult {
  accounts: number;
  conversations: number;
  replied: number;
}

/** 全局监控：评论接待账号状态 */
export interface ReplyAccountStatus {
  accountId: number;
  type: string;
  nickname?: string;
  status: 'scanned' | 'risk' | 'no-login' | 'unsupported' | 'error';
  message?: string;
  at: number;
}

/** 全局监控：评论接待单轮统计 */
export interface ReplyRoundStats {
  startedAt: number;
  finishedAt: number | null;
  accountsScanned: number;
  accountsSkipped: number;
  worksChecked: number;
  commentsReplied: number;
  errors: number;
}

export interface ReplyMonitorStatus {
  enabled: boolean;
  pollingNow: boolean;
  lastPollAt: number | null;
  lastRound: ReplyRoundStats | null;
  accountStatuses: ReplyAccountStatus[];
}

/** 全局监控总览：评论接待 + 私信接待 */
export interface GlobalMonitorStatus {
  comment: ReplyMonitorStatus;
  dm: DmStatus;
}

export interface DmConversation {
  conversationId: string;
  conversationShortId: string;
  senderName: string;
  lastText: string;
}

export interface DmReplyRecord {
  id: number;
  accountId: number;
  type: string;
  conversationId: string;
  conversationShortId: string;
  serverMessageId: string;
  senderUid?: string;
  senderName?: string;
  message: string;
  reply: string;
  status: number;
  createTime: string;
}

export async function icpDmGetStatus(): Promise<DmStatus> {
  return window.ipcRenderer.invoke('ICP_DM_GET_STATUS');
}

export async function icpDmSetEnabled(enabled: boolean): Promise<DmStatus> {
  return window.ipcRenderer.invoke('ICP_DM_SET_ENABLED', enabled);
}

export async function icpDmPollNow(): Promise<DmPollResult> {
  return window.ipcRenderer.invoke('ICP_DM_POLL_NOW');
}

export async function icpReplyPollNow(): Promise<unknown> {
  return window.ipcRenderer.invoke('ICP_REPLY_POLL_NOW');
}

export async function icpGetGlobalMonitorStatus(): Promise<GlobalMonitorStatus> {
  if (typeof window === 'undefined' || !window.ipcRenderer)
    return {
      comment: {
        enabled: false,
        pollingNow: false,
        lastPollAt: null,
        lastRound: null,
        accountStatuses: [],
      },
      dm: {
        enabled: false,
        lastPollAt: null,
        polling: false,
        lastRound: null,
      },
    }
  return window.ipcRenderer.invoke('ICP_GLOBAL_MONITOR_STATUS');
}

export async function icpDmGetRecords(limit = 50): Promise<DmReplyRecord[]> {
  return window.ipcRenderer.invoke('ICP_DM_GET_RECORDS', limit);
}

export async function icpDmListConversations(accountId: number): Promise<DmConversation[]> {
  return window.ipcRenderer.invoke('ICP_DM_LIST_CONVERSATIONS', accountId);
}
