import { Button, Card, Input, List, Select, Space, Spin, Tag, message } from 'antd';
import {
  MessageOutlined,
  ReloadOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useEffect, useState } from 'react';
import http from '@web/utils/request';
import {
  interactionApi,
  receptionApi,
  ReceptionPendingItem,
  waitInteractionTask,
} from '@/api/reception';

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xhs: '小红书',
};

interface WebAccount {
  id: string;
  type: string;
  nickname?: string;
  status?: number;
}

interface DmConversation {
  sessionId?: string;
  peerName?: string;
  lastText?: string;
  time?: string;
}

/**
 * 私信接待：会话列表与回复都来自真实平台页面（抖音创作者私信页 / 小红书官方 IM），
 * 发送成功与否以平台确认为准，不伪造“已回复”。
 */
export default function DmReception() {
  const [accounts, setAccounts] = useState<WebAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [pendingItems, setPendingItems] = useState<ReceptionPendingItem[]>([]);
  const [suggesting, setSuggesting] = useState<string | null>(null);

  async function loadAccounts() {
    try {
      const web = await http.get<{ total: number; list?: WebAccount[] }>('v2/channels/accounts', undefined, true);
      const list = ((web as unknown as { data?: { list?: WebAccount[] } })?.data?.list)
        ?? (web as unknown as { list?: WebAccount[] })?.list
        ?? [];
      setAccounts(list);
      if (list.length > 0 && selectedAccountId == null) {
        setSelectedAccountId(list[0].id);
      }
    } catch {
      message.warning('拉取账号列表失败，请先扫码登录账号');
    }
  }

  async function loadConversations(accountId?: string) {
    const id = accountId ?? selectedAccountId;
    const account = accounts.find(a => a.id === id);
    if (!id || !account) return;
    setConvLoading(true);
    try {
      const started = await interactionApi.list({ platform: account.type, accountId: id, kind: 'dm' });
      if (!started?.taskId) throw new Error('任务创建失败');
      const state = await waitInteractionTask(started.taskId);
      if (!state || state.status === 'failed') {
        throw new Error(state?.error || state?.data?.message || '平台私信读取失败');
      }
      setConversations(state.data?.conversations ?? []);
      try {
        setPendingItems((await interactionApi.getPending()) || []);
      } catch {
        setPendingItems([]);
      }
      if (!state.data?.ok && state.data?.message) {
        message.warning(state.data.message);
      }
    } catch (error) {
      message.warning('平台私信读取失败：' + String(error instanceof Error ? error.message : error));
      setConversations([]);
    } finally {
      setConvLoading(false);
    }
  }

  function findPending(conv: DmConversation): ReceptionPendingItem | undefined {
    return pendingItems.find(item =>
      item.kind === 'dm'
      && item.accountId === selectedAccountId
      && ((conv.sessionId && item.sessionId === conv.sessionId)
        || (item.peerName && item.peerName === conv.peerName)
        || (item.commentText && item.commentText === conv.lastText)),
    );
  }

  async function suggestReply(conv: DmConversation) {
    const id = selectedAccountId;
    const account = accounts.find(a => a.id === id);
    if (!id || !account) return;
    const key = conv.sessionId ?? conv.peerName ?? '';
    const pending = findPending(conv);
    setSuggesting(key);
    try {
      if (pending?.reply) {
        setReplyTexts(prev => ({ ...prev, [key]: pending.reply ?? '' }));
      } else {
        const suggested = await receptionApi.suggest({
          message: conv.lastText ?? '',
          platform: account.type,
          accountId: id,
        });
        if (suggested?.reply) {
          setReplyTexts(prev => ({ ...prev, [key]: suggested.reply ?? '' }));
          if (suggested.ruleName) message.success(`已按规则「${suggested.ruleName}」生成建议`);
        } else {
          message.warning('未命中规则且未配置可用的 AI 钥匙，请手动填写回复');
        }
      }
    } catch {
      message.warning('生成接待建议失败，请手动填写回复');
    } finally {
      setSuggesting(null);
    }
  }

  async function reply(conv: DmConversation) {
    const id = selectedAccountId;
    const account = accounts.find(a => a.id === id);
    if (!id || !account) return;
    const text = (replyTexts[conv.sessionId ?? conv.peerName ?? ''] ?? '').trim();
    if (text === '') {
      message.warning('请输入回复内容');
      return;
    }
    const key = conv.sessionId ?? conv.peerName ?? '';
    setReplying(key);
    setResults(prev => ({ ...prev, [key]: '' }));
    try {
      const started = await interactionApi.reply({
        platform: account.type,
        accountId: id,
        kind: 'dm',
        sessionId: conv.sessionId ?? '',
        peerName: conv.peerName ?? '',
        replyText: text,
      });
      if (!started?.taskId) throw new Error('任务创建失败');
      const state = await waitInteractionTask(started.taskId);
      if (!state || state.status === 'failed') {
        throw new Error(state?.error || state?.data?.message || '发送失败');
      }
      const data = state.data ?? {};
      const ok = data.ok === true;
      const pending = findPending(conv);
      if (pending) {
        await interactionApi.markPending(
          pending.id,
          ok ? 'succeeded' : 'failed',
          ok ? undefined : data.message ?? state.error,
          ok ? text : undefined,
        ).catch(() => undefined);
        setPendingItems(await interactionApi.getPending().catch(() => []));
      }
      setResults(prev => ({
        ...prev,
        [key]: ok ? `平台已确认发送：${data.message ?? '成功'}` : `平台未确认：${data.message ?? '失败'}`,
      }));
      if (ok) {
        message.success(`已向「${conv.peerName || '访客'}」真实发送私信`);
        setReplyTexts(prev => ({ ...prev, [key]: '' }));
      } else {
        message.error(data.message ?? '平台未确认发送');
      }
    } catch (error) {
      setResults(prev => ({ ...prev, [key]: '发送失败：' + String(error instanceof Error ? error.message : error) }));
      message.error('发送失败：' + String(error instanceof Error ? error.message : error));
    } finally {
      setReplying(null);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId != null) {
      loadConversations();
    }
  }, [selectedAccountId]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>私信接待</h2>
          <p style={{ margin: '6px 0 0', color: '#888' }}>
            会话列表来自平台真实私信页；点击回复即在真实平台上发送，结果以平台确认为准。
          </p>
        </div>
        <Tag color="green" icon={<RobotOutlined />} style={{ fontSize: 14, padding: '4px 12px' }}>
          真实平台通道
        </Tag>
      </div>

      <Card
        size="small"
        title={<Space><MessageOutlined />私信会话（平台实时）</Space>}
        extra={(
          <Space>
            <Select
              style={{ width: 260 }}
              placeholder="选择账号"
              value={selectedAccountId}
              onChange={(v) => setSelectedAccountId(v)}
              options={accounts.map(a => ({
                value: a.id,
                label: `${a.nickname || '未命名'}（${PLATFORM_LABEL[a.type] || a.type}）`,
              }))}
            />
            <Button icon={<ReloadOutlined />} onClick={() => loadConversations()} className="!h-9 !rounded-xl !px-4 !text-sm">
              读取平台私信
            </Button>
          </Space>
        )}
      >
        <Spin spinning={convLoading}>
          <List
            dataSource={conversations}
            locale={{ emptyText: '平台暂无待接待私信，点击「读取平台私信」拉取最新会话' }}
            renderItem={(conv) => {
              const key = conv.sessionId ?? conv.peerName ?? '';
              const pending = findPending(conv);
              const pendingTag = pending
                ? pending.status === 'succeeded'
                  ? <Tag color="green">已发送</Tag>
                  : pending.status === 'failed'
                    ? <Tag color="red">发送失败</Tag>
                    : pending.status === 'skipped'
                      ? <Tag>已跳过</Tag>
                      : pending.status === 'processing'
                        ? <Tag color="blue">处理中</Tag>
                        : <Tag color="orange">待确认</Tag>
                : null;
              return (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <span>{conv.peerName || '访客'}</span>
                        {pendingTag}
                        {conv.time ? <Tag>{conv.time}</Tag> : null}
                      </Space>
                    }
                    description={conv.lastText || '（无文本消息）'}
                  />
                  <Space direction="vertical" style={{ width: '52%' }}>
                    {pending?.reply ? (
                      <div style={{ fontSize: 12, color: '#5b4bc4' }}>
                        AI/规则建议：{pending.reply.length > 80 ? `${pending.reply.slice(0, 80)}…` : pending.reply}
                        <Button
                          size="small"
                          type="link"
                          icon={<RobotOutlined />}
                          onClick={() => suggestReply(conv)}
                        >填入</Button>
                      </div>
                    ) : null}
                    <Input.TextArea
                      rows={2}
                      value={replyTexts[key] ?? ''}
                      onChange={e => setReplyTexts(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder="输入要发送到平台的回复内容"
                    />
                    <Button
                      type="primary"
                      loading={replying === key}
                      onClick={() => reply(conv)}
                      disabled={pending?.status === 'succeeded' || pending?.status === 'skipped' || pending?.status === 'processing'}
                      className="!h-9 !rounded-xl !px-4 !text-sm"
                    >
                      发送到平台
                    </Button>
                    <Button
                      icon={<RobotOutlined />}
                      loading={suggesting === key}
                      onClick={() => suggestReply(conv)}
                      className="!h-9 !rounded-xl !px-4 !text-sm"
                    >
                      生成建议
                    </Button>
                    {results[key] ? <span style={{ fontSize: 12, color: results[key].startsWith('平台已确认') ? '#16a34a' : '#d46b08' }}>{results[key]}</span> : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </Spin>
      </Card>
    </div>
  );
}
