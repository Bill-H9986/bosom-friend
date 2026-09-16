/*
 * 小红书网页版私信（IM）客户端
 * 使用当前生效的官方端点（edith.xiaohongshu.com /api/im/web/*，实测 200 无需签名）：
 * 会话列表 /api/im/web/v3/chats、消息历史 /api/im/web/messages/history；
 * 发送走官方聊天页引擎（xhsImSender，隐藏窗口）。
 */
import { AccountModel } from '../../db/models/account';
import { xiaohongshuService } from '../../plat/xiaohongshu';

export interface XhsImConversation {
  sessionId: string;
  peerUserId?: string;
  peerNickname?: string;
  peerAvatar?: string;
  unreadCount?: number;
  lastMsgTime?: number;
}

export interface XhsImMessage {
  id: string;
  sessionId: string;
  fromUserId?: string;
  fromNickname?: string;
  content: string;
  time?: number;
}

/** 官方 IM 消息 content 为 JSON 字符串，取出展示文本 */
function extractImText(raw: string): string {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    return j?.content || j?.front_chain || '';
  } catch {
    return raw;
  }
}

export class XhsImClient {
  constructor(private account: AccountModel) {}

  private get cookies(): Electron.Cookie[] {
    return JSON.parse(this.account.loginCookie);
  }

  /** 会话列表（v3 会话，含陌生人会话；sessionId = chat_user_id） */
  async getConversations(): Promise<XhsImConversation[]> {
    const res: any = await xiaohongshuService.getImConversations(this.cookies);
    // 平台风控信号：-104=私信权限被收回、-1=会话失效，抛出专用错误让轮询层冷却，
    // 避免持续请求加重账号风控等级。
    this.throwIfRisk(res);
    const raw = res?.data?.chats ?? res?.data?.data?.chats ?? [];
    return (Array.isArray(raw) ? raw : [])
      .map((c: any) => ({
        sessionId: c.chat_user_id || c.user_id || '',
        peerUserId: c.chat_user_id || c.user_id || '',
        peerNickname: c.info?.nickname || c.info?.user_name || '',
        peerAvatar: c.info?.avatar || '',
        unreadCount: c.unread_count ?? 0,
        lastMsgTime: c.last_msg_time ?? c.update_time ?? undefined,
      }))
      .filter((c: XhsImConversation) => c.sessionId);
  }

  /** 拉取会话消息列表（out_message_list，content 需解 JSON） */
  async getMessages(sessionId: string): Promise<XhsImMessage[]> {
    const res: any = await xiaohongshuService.getImMessages(
      this.cookies,
      sessionId,
    );
    this.throwIfRisk(res);
    const raw =
      res?.data?.out_message_list ?? res?.data?.data?.out_message_list ?? [];
    return (Array.isArray(raw) ? raw : [])
      .map((m: any) => ({
        id: String(m.id ?? m.uuid ?? ''),
        sessionId,
        fromUserId: m.sender_id ?? '',
        fromNickname: '',
        content: extractImText(m.content),
        time: m.created_at ?? undefined,
      }))
      .filter((m: XhsImMessage) => m.id && m.content);
  }

  /** 发送文本消息（官方聊天页引擎） */
  async sendMessage(
    sessionId: string,
    content: string,
  ): Promise<{ ok: boolean; msg?: string }> {
    try {
      const res: any = await xiaohongshuService.sendImMessage(
        this.cookies,
        sessionId,
        content,
      );
      this.throwIfRisk(res);
      const code = res?.code ?? res?.data?.code;
      return {
        ok: code === 0 || res?.data?.success === true || res?.success === true,
        msg: res?.msg ?? res?.data?.msg ?? res?.message ?? undefined,
      };
    } catch (e) {
      // 风控错误需要上抛给轮询层冷却（不能吞成普通失败）
      if ((e as any)?.xhsImRisk) throw e;
      return { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 平台风控信号统一判定：-104=私信权限被收回、-1=会话失效、-101=参数/权限异常 */
  private throwIfRisk(res: any): void {
    const code = res?.code ?? res?.data?.code;
    if (code === -104 || code === -1 || code === -101) {
      const err: any = new Error('XHS_IM_RISK:' + (res?.msg || code));
      err.xhsImRisk = true;
      throw err;
    }
  }

  /** 获取登录者自己的小红书 user_id（用于过滤自己发出的消息，防止自回复死循环） */
  async getSelfUserId(): Promise<string | null> {
    try {
      const info = await xiaohongshuService.getUserInfo(this.cookies);
      return info?.authorId || null;
    } catch {
      return null;
    }
  }
}