import { describe, expect, it, vi, beforeEach } from 'vitest'
import { XhsImClient } from '../../electron/main/dm/xhs-im'

// 模拟 xiaohongshuService 返回，验证客户端映射与自回复保护逻辑
vi.mock('../../electron/plat/xiaohongshu', () => ({
  xiaohongshuService: {
    getImConversations: vi.fn(),
    getImMessages: vi.fn(),
    sendImMessage: vi.fn(),
    getUserInfo: vi.fn(),
  },
}))

import { xiaohongshuService } from '../../electron/plat/xiaohongshu'

const mockService = xiaohongshuService as unknown as Record<string, ReturnType<typeof vi.fn>>

const makeAccount = (loginCookie: string) => ({
  id: 9,
  type: 'xhs',
  loginCookie,
} as any)

describe('XhsImClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('解析会话列表（v3 chats 形状）并过滤无会话ID项', async () => {
    mockService.getImConversations.mockResolvedValue({
      data: {
        chats: [
          { chat_user_id: 'sid-1', info: { nickname: '访客甲', avatar: 'a.png' }, unread_count: 2 },
          { info: {} },
        ],
      },
    })
    const client = new XhsImClient(makeAccount('[]'))
    const convs = await client.getConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0].sessionId).toBe('sid-1')
    expect(convs[0].peerNickname).toBe('访客甲')
    expect(convs[0].unreadCount).toBe(2)
  })

  it('解析消息列表（out_message_list 形状，content 为 JSON 字符串）', async () => {
    mockService.getImMessages.mockResolvedValue({
      data: {
        out_message_list: [
          { id: 'm1', sender_id: 'u1', content: JSON.stringify({ content: '你好' }) },
          { uuid: 'm2', sender_id: 'self-id', content: '' },
        ],
      },
    })
    const client = new XhsImClient(makeAccount('[]'))
    const msgs = await client.getMessages('sid-1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe('m1')
    expect(msgs[0].content).toBe('你好')
  })

  it('发送消息成功判定：code 0 视为成功；风控码 -1 抛出 XHS_IM_RISK', async () => {
    mockService.sendImMessage.mockResolvedValue({ data: { code: 0, msg_id: 'new-1' } })
    const client = new XhsImClient(makeAccount('[]'))
    const res = await client.sendMessage('sid-1', '回复内容')
    expect(res.ok).toBe(true)

    mockService.sendImMessage.mockResolvedValue({ data: { code: -1 } })
    await expect(client.sendMessage('sid-1', '回复内容')).rejects.toThrow(/XHS_IM_RISK/)
  })

  it('自回复保护：拿不到本人 user_id 返回 null（调用方整账号跳过）', async () => {
    mockService.getUserInfo.mockRejectedValue(new Error('406'))
    const client = new XhsImClient(makeAccount('[]'))
    await expect(client.getSelfUserId()).resolves.toBeNull()

    mockService.getUserInfo.mockResolvedValue({ authorId: 'self-123' })
    await expect(client.getSelfUserId()).resolves.toBe('self-123')
  })
})
