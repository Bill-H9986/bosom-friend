import { Button, Card, Input, List, message, Select, Space, Spin, Tag } from 'antd';
import { RobotOutlined, ReloadOutlined } from '@ant-design/icons';
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

interface WebWork {
  workId: string;
  title?: string;
  createTime?: string;
}

interface PlatformComment {
  key?: string;
  workId?: string;
  username?: string;
  commentText?: string;
  hasReply?: boolean;
}

/**
 * 评论接待：作品与评论列表来自真实平台页面；回复在平台评论管理页真实执行，
 * 发送成功与否以平台确认为准，不伪造记录。
 */
export default function ReceptionMonitor() {
  const [accounts, setAccounts] = useState<WebAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [works, setWorks] = useState<WebWork[]>([]);
  const [selectedWork, setSelectedWork] = useState<WebWork | null>(null);
  const [comments, setComments] = useState<PlatformComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [pendingItems, setPendingItems] = useState<ReceptionPendingItem[]>([]);
  const [suggesting, setSuggesting] = useState<string | null>(null);

  async function loadAccounts() {
    setLoading(true);
    try {
      const web = await http.get<{ total: number; list?: WebAccount[] }>('v2/channels/accounts', undefined, true);
      const list = ((web as unknown as { data?: { list?: WebAccount[] } })?.data?.list)
        ?? (web as unknown as { list?: WebAccount[] })?.list
        ?? [];
      setAccounts(list);
      if (list.length > 0 && selectedAccountId == null) setSelectedAccountId(list[0].id);
    } catch {
      message.warning('请先在「渠道」页扫码登录账号');
    } finally {
      setLoading(false);
    }
  }

  async function loadWorks(accountId?: string) {
    const id = accountId ?? selectedAccountId;
    if (!id) return;
    try {
      const list = await interactionApi.getWorks(id);
      setWorks(list ?? []);
    } catch {
      message.warning('拉取作品列表失败');
      setWorks([]);
    }
  }

  async function loadComments(work?: WebWork) {
    const id = selectedAccountId;
    const account = accounts.find(a => a.id === id);
    const target = work ?? selectedWork;
    if (!id || !account || !target) return;
    setCommentsLoading(true);
    try {
      const started = await interactionApi.list({
        platform: account.type,
        accountId: id,
        kind: 'comment',
        workId: target.workId,
        workTitle: target.title ?? '',
        createTime: target.createTime ?? '',
      });
      if (!started?.taskId) throw new Error('任务创建失败');
      const state = await waitInteractionTask(started.taskId);
      if (!state || state.status === 'failed') {
        throw new Error(state?.error || state?.data?.message || '平台评论读取失败');
      }
      setComments(state.data?.comments ?? []);
      try {
        setPendingItems((await interactionApi.getPending()) || []);
      } catch {
        setPendingItems([]);
      }
      if (!state.data?.ok && state.data?.message) message.warning(state.data.message);
    } catch (error) {
      message.warning('平台评论读取失败：' + String(error instanceof Error ? error.message : error));
      setComments([]);
    } finally {
      setCommentsLoading(false);
    }
  }

  function findPending(comment: PlatformComment): ReceptionPendingItem | undefined {
    const key = comment.key ?? comment.commentText ?? '';
    return pendingItems.find(item =>
      item.kind === 'comment'
      && item.accountId === selectedAccountId
      && item.workId === selectedWork?.workId
      && ((comment.key && item.commentKey === key) || (item.commentText && item.commentText === comment.commentText)),
    );
  }

  async function suggestReply(comment: PlatformComment) {
    const id = selectedAccountId;
    const account = accounts.find(a => a.id === id);
    if (!id || !account) return;
    const key = comment.key ?? comment.commentText ?? '';
    const pending = findPending(comment);
    setSuggesting(key);
    try {
      if (pending?.reply) {
        setReplyTexts(prev => ({ ...prev, [key]: pending.reply ?? '' }));
      } else {
        const suggested = await receptionApi.suggest({
          message: comment.commentText ?? '',
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

  async function reply(comment: PlatformComment) {
    const id = selectedAccountId;
    const account = accounts.find(a => a.id === id);
    if (!id || !account || !selectedWork) return;
    const key = comment.key ?? comment.commentText ?? '';
    const text = (replyTexts[key] ?? '').trim();
    if (text === '') {
      message.warning('请输入回复内容');
      return;
    }
    setReplying(key);
    setResults(prev => ({ ...prev, [key]: '' }));
    try {
      const started = await interactionApi.reply({
        platform: account.type,
        accountId: id,
        kind: 'comment',
        workId: selectedWork.workId,
        workTitle: selectedWork.title ?? '',
        commentText: comment.commentText ?? '',
        username: comment.username ?? '',
        replyText: text,
      });
      if (!started?.taskId) throw new Error('任务创建失败');
      const state = await waitInteractionTask(started.taskId);
      if (!state || state.status === 'failed') {
        throw new Error(state?.error || state?.data?.message || '回复失败');
      }
      const data = state.data ?? {};
      const ok = data.ok === true;
      const pending = findPending(comment);
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
        [key]: ok ? `平台已确认：${data.message ?? '回复成功'}` : `平台未确认：${data.message ?? '失败'}`,
      }));
      if (ok) {
        message.success('已在真实平台回复该评论');
        setReplyTexts(prev => ({ ...prev, [key]: '' }));
        loadComments();
      } else {
        message.error(data.message ?? '平台未确认回复');
      }
    } catch (error) {
      setResults(prev => ({ ...prev, [key]: '回复失败：' + String(error instanceof Error ? error.message : error) }));
      message.error('回复失败：' + String(error instanceof Error ? error.message : error));
    } finally {
      setReplying(null);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId != null) {
      loadWorks();
    }
  }, [selectedAccountId]);

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>评论接待</h2>
          <p style={{ margin: '6px 0 0', color: '#595959' }}>
            选择账号与作品，读取平台真实评论；回复在平台评论管理页真实执行，平台确认后才显示“已回复”。
          </p>
        </div>
        <Tag color="green" icon={<RobotOutlined />}>真实平台通道</Tag>
      </div>

      <Card size="small" title="选择账号与作品" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            style={{ width: 280 }}
            placeholder="选择账号"
            aria-label="选择账号"
            value={selectedAccountId}
            onChange={(v) => {
              setSelectedAccountId(v);
              setSelectedWork(null);
              setComments([]);
            }}
            options={accounts.map(a => ({
              value: a.id,
              label: `${a.nickname || '未命名'}（${PLATFORM_LABEL[a.type] || a.type}）`,
            }))}
          />
          <Select
            style={{ width: 360 }}
            placeholder="选择作品"
            aria-label="选择作品"
            value={selectedWork?.workId}
            onChange={(v) => {
              const work = works.find(w => w.workId === v) ?? null;
              setSelectedWork(work);
              setComments([]);
              if (work) loadComments(work);
            }}
            options={works.map(w => ({
              value: w.workId,
              label: w.title ? `${w.title.slice(0, 24)} · ${w.workId.slice(0, 12)}` : `作品 ${w.workId.slice(0, 16)}`,
            }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadWorks()} className="!h-9 !rounded-xl !px-4 !text-sm">刷新作品</Button>
        </Space>
      </Card>

      <Card
        size="small"
        title={`${selectedAccount ? PLATFORM_LABEL[selectedAccount.type] || selectedAccount.type : ''} 平台评论（实时读取）`}
        extra={<Button type="link" onClick={() => loadComments()}>重新读取评论</Button>}
      >
        <Spin spinning={commentsLoading}>
          <List
            dataSource={comments}
            locale={{ emptyText: '该作品暂无未回复评论，或选择作品后点击「重新读取评论」' }}
            renderItem={(comment) => {
              const key = comment.key ?? comment.commentText ?? '';
              const pending = findPending(comment);
              const pendingTag = pending
                ? pending.status === 'succeeded'
                  ? <Tag color="green">已处理</Tag>
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
                        <span>{comment.username || '访客'}</span>
                        {comment.hasReply ? <Tag>已有回复</Tag> : <Tag color="blue">待回复</Tag>}
                        {pendingTag}
                      </Space>
                    }
                    description={comment.commentText || ''}
                  />
                  <Space direction="vertical" style={{ width: '48%' }}>
                    {pending?.reply ? (
                      <div style={{ fontSize: 12, color: '#5b4bc4' }}>
                        AI/规则建议：{pending.reply.length > 80 ? `${pending.reply.slice(0, 80)}…` : pending.reply}
                        <Button
                          size="small"
                          type="link"
                          icon={<RobotOutlined />}
                          onClick={() => suggestReply(comment)}
                        >填入</Button>
                      </div>
                    ) : null}
                    <Input.TextArea
                      rows={2}
                      value={replyTexts[key] ?? ''}
                      onChange={e => setReplyTexts(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder="输入要回复到平台的内容"
                    />
                    <Button
                      type="primary"
                      loading={replying === key}
                      onClick={() => reply(comment)}
                      disabled={pending?.status === 'succeeded' || pending?.status === 'skipped' || pending?.status === 'processing'}
                      className="!h-9 !rounded-xl !px-4 !text-sm"
                    >
                      回复到平台
                    </Button>
                    <Button
                      icon={<RobotOutlined />}
                      loading={suggesting === key}
                      onClick={() => suggestReply(comment)}
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
