import {
  Button,
  Card,
  Col,
  Collapse,
  Divider,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CommentOutlined,
  MessageOutlined,
  ReloadOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import http from '@web/utils/request';
import {
  interactionApi,
  receptionApi,
  ReceptionConversationSnapshot,
  ReceptionCustomerThread,
  ReceptionEngineStatus,
  ReceptionReplyRecord,
  ReceptionRepliesPayload,
} from '@/api/reception';
import { useReceptionAutoStore } from '@web/store/receptionAuto';
import { runReceptionAutoOnce } from '@web/utils/receptionAutoRunner';
import ReceptionMonitor from './ReceptionMonitor';
import DmReception from './DmReception';

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xhs: '小红书',
};

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  scanned: { color: 'green', text: '已接入' },
  risk: { color: 'orange', text: '平台风控' },
  'no-login': { color: 'red', text: '未登录' },
  unsupported: { color: 'default', text: '待接入' },
  error: { color: 'red', text: '异常' },
};

const REPLY_STATUS: Record<ReceptionReplyRecord['status'], { color: string; text: string; icon: ReactNode }> = {
  succeeded: { color: 'green', text: '已发送', icon: <CheckCircleOutlined /> },
  failed: { color: 'red', text: '发送失败', icon: <CloseCircleOutlined /> },
  sending: { color: 'processing', text: '发送中', icon: <ClockCircleOutlined /> },
};

function formatTime(ts?: string | null): string {
  if (!ts) return '—';
  const value = new Date(ts).getTime();
  if (Number.isNaN(value)) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 相对时间：客户列表里比绝对时间更好扫。 */
function formatAgo(ts?: string | null): string {
  if (!ts) return '—';
  const value = new Date(ts).getTime();
  if (Number.isNaN(value)) return '—';
  const diff = Date.now() - value;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function shorten(text: string, max = 42): string {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (value === '') return '（无文本内容）';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 全局监控中心：按客户收纳 AI/规则真实发出的评论与私信回复。
 *
 * 数据全部来自后端回复记录（发起时落库 + 平台互动任务状态核对），
 * 前端不推断成功、不伪造记录；没有记录时如实展示原因。
 */
export default function GlobalMonitor() {
  const [status, setStatus] = useState<ReceptionEngineStatus | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; type: string; nickname?: string }[]>([]);
  const [replies, setReplies] = useState<ReceptionRepliesPayload>({ total: 0, records: [], customers: [] });
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  /** 盯盘令牌：新一轮触发会作废上一轮的盯盘，避免两轮的结果互相覆盖。 */
  const roundWatchRef = useRef(0);
  const [savingConfig, setSavingConfig] = useState(false);
  const [processingNow, setProcessingNow] = useState(false);
  const [lastManualResult, setLastManualResult] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filterPlatform, setFilterPlatform] = useState<string>('');
  const [filterAccount, setFilterAccount] = useState<string>('');
  /** 评论 / 私信分开两个页签：各自独立的客户列表与往来线程。 */
  const [activeKind, setActiveKind] = useState<'comment' | 'dm'>('comment');
  /** 待办处理区的评论/私信切换：与下方回复记录的切换互不影响。 */
  const [todoKind, setTodoKind] = useState<'comment' | 'dm'>('comment');
  const [drawerCustomer, setDrawerCustomer] = useState<ReceptionCustomerThread | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState('');
  const [platformThread, setPlatformThread] = useState<ReceptionConversationSnapshot | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | 'succeeded' | 'failed' | 'sending'>('all');
  const [keyword, setKeyword] = useState('');
  const receptionAutoEnabled = useReceptionAutoStore(state => state.enabled);
  const receptionAutoRunning = useReceptionAutoStore(state => state.running);
  const receptionAutoLastProcessedId = useReceptionAutoStore(state => state.lastProcessedId);
  const receptionAutoLastProcessedAt = useReceptionAutoStore(state => state.lastProcessedAt);
  const receptionAutoLastError = useReceptionAutoStore(state => state.lastError);
  const setReceptionAutoEnabled = useReceptionAutoStore(state => state.setEnabled);
  const [config, setConfig] = useState<ReceptionEngineStatus['config']>({
    intervalMinutes: 10,
    maxRepliesPerRound: 3,
    seenWindowMinutes: 7 * 24 * 60,
    cooldownMinutes: 30,
    maxPendingPerRound: 3,
  });

  async function load() {
    try {
      const [engineStatus, web, replyPayload] = await Promise.all([
        interactionApi.getStatus(),
        http.get<{ total: number; list?: { id: string; type: string; nickname?: string }[] }>(
          'v2/channels/accounts',
          undefined,
          true,
        ),
        receptionApi.listReplies({
          ...(filterPlatform ? { platform: filterPlatform } : {}),
          ...(filterAccount ? { accountId: filterAccount } : {}),
          ...(filterStatus === 'all' ? {} : { status: filterStatus }),
          ...(keyword.trim() ? { q: keyword.trim() } : {}),
          limit: 300,
        }).catch(() => null),
      ]);
      setStatus(engineStatus ?? null);
      if (engineStatus?.config) {
        setConfig(prev => ({ ...prev, ...engineStatus.config }));
      }
      const list = ((web as unknown as { data?: { list?: { id: string; type: string; nickname?: string }[] } })?.data?.list)
        ?? (web as unknown as { list?: { id: string; type: string; nickname?: string }[] })?.list
        ?? [];
      setAccounts(list);
      if (replyPayload) {
        setReplies({
          total: replyPayload.total ?? 0,
          records: replyPayload.records ?? [],
          customers: replyPayload.customers ?? [],
        });
      }
    } catch {
      // 拉取失败保留上次状态，不打断页面
    } finally {
      setLoading(false);
    }
  }

  async function pollNow() {
    setPolling(true);
    try {
      const beforeRounds = status?.rounds ?? 0;
      const result = await interactionApi.pollNow();
      // 引擎已在跑一轮时服务端不会重复触发：如实说，不能让按钮看起来生效了其实什么都没做。
      if (result?.triggered === false) {
        message.info('接待引擎正在跑这一轮，等它跑完即可，无需重复触发');
      } else {
        message.success('已触发一轮轮询：采集完成后，命中规则的评论/私信会出现在下方');
        void watchRound(beforeRounds);
      }
    } catch {
      message.error('触发轮询失败，请查看上方引擎状态');
    } finally {
      setPolling(false);
      await load();
    }
  }

  /**
   * 触发后盯住这一轮：跑完自动刷新页面数据并告知，用户不必反复点「刷新数据」。
   * 一轮真实采集要 40~90 秒（要拉起浏览器扫平台），没有这个闭环时页面看上去「点了没反应」。
   *
   * @param beforeRounds - 触发前的已完成轮次，用来确认这一轮真的推进了。
   */
  async function watchRound(beforeRounds: number) {
    const token = roundWatchRef.current + 1;
    roundWatchRef.current = token;
    for (let i = 0; i < 60; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      if (roundWatchRef.current !== token) return;
      const next = await interactionApi.getStatus().catch(() => null);
      if (next === null || next === undefined) return;
      const finished = next.running !== true && (next.rounds ?? 0) > beforeRounds;
      if (finished) {
        await load();
        if (roundWatchRef.current === token) message.success('本轮轮询已完成，结果已刷新');
        return;
      }
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    try {
      const next = await interactionApi.updateConfig(config);
      setConfig(prev => ({ ...prev, ...next }));
      message.success('接待引擎参数已保存，并按新间隔重新排程');
      await load();
    } catch {
      message.error('保存接待引擎参数失败');
    } finally {
      setSavingConfig(false);
    }
  }

  async function processNow() {
    setProcessingNow(true);
    try {
      const result = await runReceptionAutoOnce();
      if (result.processedId) {
        const text = result.ok ? `已自动处理待办 ${result.processedId}` : `自动处理未成功：${result.error ?? '平台未确认'}`;
        setLastManualResult(text);
        message.info(text);
      } else {
        setLastManualResult('当前没有待处理的新互动');
        message.info('当前没有待处理的新互动');
      }
    } catch {
      setLastManualResult('自动处理待办失败');
      message.error('自动处理待办失败');
    } finally {
      setProcessingNow(false);
      await load();
    }
  }

  /** 打开某客户的原对话抽屉：先展示本地往来，已缓存过平台快照就直接展示。 */
  function openConversation(customer: ReceptionCustomerThread) {
    const latest = replies.records.find(r => r.customerKey === customer.customerKey);
    setDrawerCustomer(customer);
    setPlatformThread(latest?.conversation ?? null);
    setPullError('');
  }

  /** 从平台拉取原对话：私信读整段会话，评论读该作品评论线程；结果由后端挂到记录上。 */
  async function pullConversation(customer: ReceptionCustomerThread) {
    const latest = replies.records.find(r => r.customerKey === customer.customerKey);
    setPulling(true);
    setPullError('');
    try {
      const started = await receptionApi.startConversation({
        platform: customer.platform,
        accountId: customer.accountId,
        kind: customer.kind,
        ...(customer.kind === 'dm'
          ? {
              sessionId: customer.customerKey.startsWith('dm:') ? customer.customerKey.slice(3) : '',
              peerName: customer.customerName,
            }
          : {
              commentText: latest?.sourceText ?? '',
              username: customer.customerName,
              ...(latest?.workId ? { workId: latest.workId } : {}),
              ...(latest?.workTitle ? { workTitle: latest.workTitle } : {}),
            }),
      });
      const taskId = started?.taskId;
      if (!taskId) {
        setPullError('平台读取任务未启动（账号可能未登录）');
        return;
      }
      const deadline = Date.now() + 150000;
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        const result = await receptionApi.getConversation(taskId, latest?.id);
        if (result?.status === 'done' && result.snapshot) {
          setPlatformThread(result.snapshot);
          await load();
          return;
        }
        if (result?.status === 'failed') {
          setPullError(result.error || '平台未返回原对话');
          return;
        }
        if (Date.now() > deadline) {
          setPullError('平台读取超时（2.5 分钟），请稍后重试');
          return;
        }
      }
    }
    catch (error) {
      setPullError(error instanceof Error ? error.message : '拉取原对话失败');
    }
    finally {
      setPulling(false);
    }
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
    // 筛选条件变化时立即重拉一次；load 内部读取最新筛选值。
  }, [filterPlatform, filterAccount, filterStatus, keyword]);

  const customers = useMemo(
    () => replies.customers.filter(customer => customer.kind === activeKind),
    [replies.customers, activeKind],
  );
  const succeeded = replies.records.filter(r => r.status === 'succeeded').length;
  const failed = replies.records.filter(r => r.status === 'failed').length;
  const sending = replies.records.filter(r => r.status === 'sending').length;

  const activeCustomer: ReceptionCustomerThread | undefined = useMemo(
    () => customers.find(c => c.customerKey === selectedKey) ?? customers[0],
    [customers, selectedKey],
  );
  const activeRecords = useMemo(
    () => (activeCustomer ? replies.records.filter(r => r.customerKey === activeCustomer.customerKey) : []),
    [replies.records, activeCustomer],
  );
  /** 抽屉里的本地往来：按时间正序，方便对照平台原对话。 */
  const drawerRecords = useMemo(
    () => (drawerCustomer ? replies.records.filter(r => r.customerKey === drawerCustomer.customerKey).slice().reverse() : []),
    [replies.records, drawerCustomer],
  );

  const engineAccounts = status?.accounts ?? [];
  const bound = accounts.length;
  const problems = engineAccounts.filter(a => a.status !== 'scanned' && a.status !== 'unsupported');
  /** 没有回复记录时，如实给出平台侧原因（不编造"运行中"）。 */
  const emptyReason = bound === 0
    ? '还没有绑定平台账号：到「添加频道」扫码登录后，接待引擎才会采集评论/私信。'
    : engineAccounts.length === 0
      ? `接待引擎本轮没有产出结果：${bound} 个账号已绑定但引擎状态里没有记录（服务重启会中断在途的一轮）。点「立即轮询」跑一轮后，这里会按客户显示真实回复。`
      : problems.length > 0
        ? `当前账号未取到平台数据：${problems.map(a => `${PLATFORM_LABEL[a.platform] || a.platform} ${STATUS_TAG[a.status]?.text ?? a.status}${a.message ? `（${a.message}）` : ''}`).join('；')}`
        : '暂无回复记录：引擎已纳入轮询，命中规则的评论/私信会在这里按客户出现，AI 发出回复后回写结果。';

  const platformRows = (Object.keys(PLATFORM_LABEL) as string[]).map((pt) => {
    const typeAccounts = accounts.filter(a => a.type === pt);
    const statuses = engineAccounts.filter(s => s.platform === pt);
    const scanned = statuses.filter(s => s.status === 'scanned').length;
    const riskCount = statuses.filter(s => s.status === 'risk').length;
    const noLoginCount = statuses.filter(s => s.status === 'no-login').length;
    return {
      key: pt,
      type: pt,
      bound: typeAccounts.length,
      commentStatus:
        typeAccounts.length === 0
          ? '待绑定'
          : scanned > 0
            ? '已接入'
            : riskCount > 0
              ? '平台风控'
              : noLoginCount === statuses.length && statuses.length > 0
                ? '未登录'
                : statuses.length > 0
                  ? '异常'
                  : '待首轮轮询',
      dmStatus:
        pt === 'douyin' || pt === 'xhs'
          ? (typeAccounts.length > 0 ? (riskCount > 0 ? '平台风控' : '待首轮轮询') : '待绑定')
          : '待官方插件',
    };
  });

  const accountColumns = [
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 100,
      render: (t: string) => <Tag color="blue">{PLATFORM_LABEL[t] || t}</Tag>,
    },
    {
      title: '账号',
      dataIndex: 'nickname',
      key: 'nickname',
      render: (nickname: string | undefined, record: { accountId: string }) => (
        <span>
          {nickname || '未命名'}
          <span style={{ color: '#595959', marginLeft: 8, fontSize: 12 }}>ID: {record.accountId}</span>
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: string) => {
        const cfg = STATUS_TAG[s] || { color: 'default', text: s };
        return <Tag color={cfg.color}>{cfg.text}</Tag>;
      },
    },
    {
      title: '平台真实说明',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      render: (m?: string) => m || '—',
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <p className="mt-1.5 text-muted-foreground" style={{ margin: 0 }}>
            按客户收纳 AI 智能体的真实回复：谁说了什么、AI 回了什么、有没有发出去，全部来自平台真实结果。
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b4bc4' }}>
            引擎状态：{status?.running ? '轮询中' : '常驻待命'}
            {' · '}已完成轮次 {status?.rounds ?? 0}
            {' · '}上次轮询 {formatTime(status?.lastPollAt)}
            {' · '}下次轮询 {formatTime(status?.nextPollAt)}
          </p>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={load}
            title="只重新读取这一页的数据（状态、账号、回复记录），不触发任何平台采集"
            className="!h-9 !rounded-xl !px-4 !text-sm"
          >
            刷新数据
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={polling}
            onClick={pollNow}
            title="立刻让接待引擎跑一轮真实采集（打开账号去平台扫评论/私信），跑完结果会自动出现在下方"
            className="!h-9 !rounded-xl !px-4 !text-sm"
          >
            立即轮询
          </Button>
        </Space>
      </div>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}><Card size="small" title="客户数"><div className="text-2xl font-semibold">{customers.length}<span className="text-sm text-muted-foreground"> 位</span></div></Card></Col>
        <Col span={6}><Card size="small" title="回复总数"><div className="text-2xl font-semibold">{replies.records.length}<span className="text-sm text-muted-foreground"> 条</span></div></Card></Col>
        <Col span={6}><Card size="small" title="已发送成功"><div className="text-2xl font-semibold" style={{ color: '#389e0d' }}>{succeeded}<span className="text-sm text-muted-foreground"> 条</span></div></Card></Col>
        <Col span={6}><Card size="small" title="失败 / 发送中"><div className="text-2xl font-semibold" style={{ color: failed > 0 ? '#cf1322' : undefined }}>{failed}<span className="text-sm text-muted-foreground"> / {sending}</span></div></Card></Col>
      </Row>

      {/* 待办处理：平台只读采集后的评论/私信待办与人工回复入口。
          与「接待规则」分居两处：规则在账号页配置，执行与记录统一在本页。 */}
      <Card size="small" style={{ marginBottom: 12 }} data-testid="reception-todo-board">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Segmented
            value={todoKind}
            onChange={value => setTodoKind(value as 'comment' | 'dm')}
            options={[{ value: 'comment', label: '评论待办' }, { value: 'dm', label: '私信待办' }]}
          />
          <span className="text-xs text-muted-foreground">待办回复会在真实平台上发送，成功与否以平台确认为准</span>
        </div>
        {todoKind === 'comment' ? <ReceptionMonitor /> : <DmReception />}
      </Card>

      <Card size="small" style={{ marginBottom: 12 }} data-testid="reply-customer-board">
        <Segmented
          block
          value={activeKind}
          onChange={(value) => {
            setActiveKind(value as 'comment' | 'dm');
            setSelectedKey(null);
            setPlatformThread(null);
            setPullError('');
            setDrawerCustomer(null);
          }}
          options={[
            { value: 'comment', label: `评论接待（${replies.customers.filter(c => c.kind === 'comment').length} 位客户）` },
            { value: 'dm', label: `私信接待（${replies.customers.filter(c => c.kind === 'dm').length} 位客户）` },
          ]}
          style={{ marginBottom: 12 }}
        />
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            value={filterPlatform}
            onChange={setFilterPlatform}
            style={{ width: 130 }}
            options={[{ value: '', label: '全部平台' }, ...Object.keys(PLATFORM_LABEL).map(k => ({ value: k, label: PLATFORM_LABEL[k] }))]}
            aria-label="平台筛选"
          />
          <Select
            value={filterAccount}
            onChange={setFilterAccount}
            style={{ width: 190 }}
            options={[{ value: '', label: '全部账号' }, ...accounts.map(a => ({ value: a.id, label: `${PLATFORM_LABEL[a.type] || a.type}·${a.nickname || a.id}` }))]}
            aria-label="账号筛选"
          />
          <Segmented
            value={filterStatus}
            onChange={value => setFilterStatus(value as 'all' | 'succeeded' | 'failed' | 'sending')}
            options={[{ value: 'all', label: '全部状态' }, { value: 'succeeded', label: '已发送' }, { value: 'failed', label: '失败' }, { value: 'sending', label: '发送中' }]}
          />
          <Input.Search
            allowClear
            placeholder="搜客户 / 原文 / 回复内容"
            style={{ width: 240 }}
            onSearch={setKeyword}
            aria-label="搜索回复记录"
          />
        </Space>

        {customers.length === 0
          ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span style={{ maxWidth: 620, display: 'inline-block' }}>{loading ? '正在读取回复记录…' : emptyReason}</span>}
              />
            )
          : (
              <Row gutter={12}>
                <Col span={9}>
                  <div
                    style={{ maxHeight: 520, overflowY: 'auto', borderRight: '1px solid #f0f0f0', paddingRight: 8 }}
                    data-testid="reply-customer-list"
                  >
                    {customers.map((customer) => {
                      const active = activeCustomer?.customerKey === customer.customerKey;
                      return (
                        <div
                          key={customer.customerKey}
                          onClick={() => setSelectedKey(customer.customerKey)}
                          style={{
                            cursor: 'pointer',
                            padding: '10px 12px',
                            marginBottom: 8,
                            borderRadius: 10,
                            border: active ? '1px solid #a78bfa' : '1px solid #f0f0f0',
                            background: active ? '#faf8ff' : '#fff',
                          }}
                          data-testid={`reply-customer-${customer.customerKey}`}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <UserOutlined />
                              {customer.customerName}
                            </span>
                            <span style={{ fontSize: 12, color: '#8c8c8c' }}>{formatAgo(customer.lastAt)}</span>
                          </div>
                          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                            <Tag color="blue">{PLATFORM_LABEL[customer.platform] || customer.platform}</Tag>
                            <Tag icon={customer.kind === 'dm' ? <MessageOutlined /> : <CommentOutlined />} color={customer.kind === 'dm' ? 'purple' : 'geekblue'}>
                              {customer.kind === 'dm' ? '私信' : '评论'}
                            </Tag>
                            {customer.succeeded > 0 && <Tag color="green">已回 {customer.succeeded}</Tag>}
                            {customer.failed > 0 && <Tag color="red">失败 {customer.failed}</Tag>}
                            {customer.sending > 0 && <Tag color="processing">发送中 {customer.sending}</Tag>}
                          </div>
                          <div style={{ marginTop: 6, fontSize: 12, color: '#595959' }}>
                            对方：{shorten(customer.lastSource, 34)}
                          </div>
                          <div style={{ marginTop: 2, fontSize: 12, color: '#5b4bc4' }}>
                            AI：{shorten(customer.lastReply, 34)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Col>
                <Col span={15}>
                  {activeCustomer === undefined
                    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧客户查看完整往来" />
                    : (
                        <>
                          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <div style={{ fontSize: 16, fontWeight: 600 }}>
                              {activeCustomer.customerName}
                              <span style={{ marginLeft: 8, fontSize: 12, color: '#8c8c8c' }}>
                                {PLATFORM_LABEL[activeCustomer.platform] || activeCustomer.platform}
                                {' · '}
                                {activeCustomer.accountNickname || activeCustomer.accountId}
                                {' · '}
                                {activeCustomer.kind === 'dm' ? '私信' : '评论'}
                                {' · '}
                                共 {activeCustomer.total} 条
                              </span>
                            </div>
                            <Button
                              size="small"
                              icon={<MessageOutlined />}
                              onClick={() => openConversation(activeCustomer)}
                              data-testid="open-conversation"
                            >
                              查看原对话
                            </Button>
                          </div>
                          <div style={{ maxHeight: 460, overflowY: 'auto' }} data-testid="reply-thread">
                            {activeRecords.map((record) => {
                              const cfg = REPLY_STATUS[record.status];
                              return (
                                <Card
                                  key={record.id}
                                  size="small"
                                  style={{ marginBottom: 10 }}
                                  title={(
                                    <Space size={6}>
                                      <Tag color={cfg.color} icon={cfg.icon}>{cfg.text}</Tag>
                                      {record.ruleName ? <Tag>规则：{record.ruleName}</Tag> : null}
                                      <span style={{ fontSize: 12, color: '#8c8c8c' }}>{formatTime(record.at)}</span>
                                    </Space>
                                  )}
                                >
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                                      {record.kind === 'dm' ? '对方私信' : '对方评论'}
                                      {record.workTitle ? ` · 作品：${record.workTitle}` : ''}
                                    </div>
                                    <div style={{ background: '#fafafa', borderRadius: 8, padding: '8px 10px', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                                      {record.sourceText || '（平台未返回文本内容）'}
                                    </div>
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 12, color: '#5b4bc4' }}>
                                      <RobotOutlined /> AI 回复
                                    </div>
                                    <div style={{ background: '#f5f3ff', borderRadius: 8, padding: '8px 10px', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                                      {record.replyText}
                                    </div>
                                  </div>
                                  {record.status === 'failed' && record.error
                                    ? <div style={{ marginTop: 8, color: '#cf1322', fontSize: 12 }}>平台结果：{record.error}</div>
                                    : null}
                                  {record.finishedAt
                                    ? <div style={{ marginTop: 6, fontSize: 12, color: '#8c8c8c' }}>平台回执时间：{formatTime(record.finishedAt)}</div>
                                    : null}
                                </Card>
                              );
                            })}
                          </div>
                        </>
                      )}
                </Col>
              </Row>
            )}
      </Card>

      <Collapse
        style={{ marginBottom: 12 }}
        items={[
          {
            key: 'engine',
            label: '引擎参数与 7×24 全自动接待',
            children: (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <span>轮询间隔</span>
                  <InputNumber min={1} max={1440} value={config.intervalMinutes} onChange={value => setConfig(prev => ({ ...prev, intervalMinutes: value ?? 10 }))} addonAfter="分钟" />
                  <span>每账号每轮上限</span>
                  <InputNumber min={0} max={100} value={config.maxPendingPerRound} onChange={value => setConfig(prev => ({ ...prev, maxPendingPerRound: value ?? 3 }))} addonAfter="条" />
                  <span>去重窗口</span>
                  <InputNumber min={1} max={30 * 24 * 60} value={config.seenWindowMinutes} onChange={value => setConfig(prev => ({ ...prev, seenWindowMinutes: value ?? 10080 }))} addonAfter="分钟" />
                  <span>失败重试冷却</span>
                  <InputNumber min={0} max={1440} value={config.cooldownMinutes} onChange={value => setConfig(prev => ({ ...prev, cooldownMinutes: value ?? 30 }))} addonAfter="分钟" />
                  <Button type="primary" loading={savingConfig} onClick={saveConfig} className="!h-9 !rounded-xl !px-4 !text-sm">保存参数</Button>
                </Space>
                <Space wrap>
                  <Switch checked={receptionAutoEnabled} onChange={setReceptionAutoEnabled} aria-label="全自动接待" />
                  <span>
                    {receptionAutoEnabled
                      ? receptionAutoRunning ? '运行中：正在处理待办…' : '已开启：前端将自动读取并发送待办'
                      : '已关闭：只巡检登记，需手动确认发送'}
                  </span>
                  <Button loading={processingNow} onClick={processNow} className="!h-9 !rounded-xl !px-4 !text-sm">立即处理待办</Button>
                  {receptionAutoLastProcessedId && (
                    <Tag color="green">上次处理 {receptionAutoLastProcessedId} {formatTime(receptionAutoLastProcessedAt)}</Tag>
                  )}
                  {receptionAutoLastError && <Tag color="red">{receptionAutoLastError}</Tag>}
                  {lastManualResult && <span aria-live="polite" data-testid="reception-auto-result">{lastManualResult}</span>}
                </Space>
              </>
            ),
          },
          {
            key: 'overview',
            label: '平台统一监控总览与账号级状态',
            children: (
              <>
                <Table rowKey="key" size="small" loading={loading} pagination={false} dataSource={platformRows} columns={[
                  { title: '平台', dataIndex: 'type', key: 'type', width: 110, render: (t: string) => <Tag color="blue">{PLATFORM_LABEL[t] || t}</Tag> },
                  { title: '绑定账号', dataIndex: 'bound', key: 'bound', width: 100, render: (v: number) => <b>{v}</b> },
                  { title: '评论接待', dataIndex: 'commentStatus', key: 'commentStatus', width: 140, render: (v: string) => <Tag color={v === '已接入' ? 'green' : v === '平台风控' ? 'orange' : v === '未登录' ? 'red' : 'default'}>{v}</Tag> },
                  { title: '私信接待', dataIndex: 'dmStatus', key: 'dmStatus', width: 140, render: (v: string) => <Tag color={v === '平台风控' ? 'orange' : v === '未登录' ? 'red' : 'default'}>{v}</Tag> },
                ]} />
                <Table
                  style={{ marginTop: 12 }}
                  rowKey="accountId"
                  size="small"
                  loading={loading}
                  columns={accountColumns}
                  dataSource={engineAccounts}
                  pagination={false}
                  locale={{ emptyText: <Spin spinning={false} /> }}
                />
              </>
            ),
          },
        ]}
      />

      <Drawer
        open={drawerCustomer !== null}
        onClose={() => setDrawerCustomer(null)}
        width={620}
        title={drawerCustomer ? `原对话 · ${drawerCustomer.customerName}` : '原对话'}
      >
        {drawerCustomer !== null && (
          <div data-testid="reply-conversation-drawer">
            <Space wrap size={6} style={{ marginBottom: 8 }}>
              <Tag color="blue">{PLATFORM_LABEL[drawerCustomer.platform] || drawerCustomer.platform}</Tag>
              <Tag color={drawerCustomer.kind === 'dm' ? 'purple' : 'geekblue'} icon={drawerCustomer.kind === 'dm' ? <MessageOutlined /> : <CommentOutlined />}>
                {drawerCustomer.kind === 'dm' ? '私信' : '评论'}
              </Tag>
              <Tag>{drawerCustomer.accountNickname || drawerCustomer.accountId}</Tag>
              {drawerRecords.find(record => record.workTitle)?.workTitle
                ? <Tag>作品：{drawerRecords.find(record => record.workTitle)?.workTitle}</Tag>
                : null}
            </Space>
            <Space wrap style={{ marginBottom: 8 }}>
              <Button type="primary" size="small" loading={pulling} onClick={() => void pullConversation(drawerCustomer)} data-testid="pull-conversation">
                从平台拉取原对话
              </Button>
              {platformThread !== null && (
                <span style={{ fontSize: 12, color: '#8c8c8c' }}>平台读取时间：{formatTime(platformThread.at)}</span>
              )}
            </Space>
            {pullError !== '' && (
              <div style={{ color: '#cf1322', fontSize: 12, marginBottom: 8 }}>平台读取失败：{pullError}</div>
            )}

            <Divider orientation="left" style={{ margin: '8px 0' }}>平台原对话</Divider>
            {platformThread === null
              ? (
                  <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                    {drawerCustomer.kind === 'dm'
                      ? '还没有读取过这段会话。点上面的按钮读平台上的完整往来（需要该账号登录态有效）。'
                      : '还没有读取过这条评论的线程。点上面的按钮读平台上该作品的评论（含本条与回复情况）。'}
                  </div>
                )
              : (
                  <div data-testid="conversation-messages">
                    {platformThread.note ? (
                      <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 6 }}>{platformThread.note}</div>
                    ) : null}
                    {platformThread.messages.length === 0
                      ? <div style={{ fontSize: 12, color: '#8c8c8c' }}>平台未返回消息内容。</div>
                      : platformThread.messages.map((msg, index) => (
                          <div
                            key={`${index}-${msg.text.slice(0, 8)}`}
                            style={{ display: 'flex', justifyContent: msg.from === 'me' ? 'flex-end' : 'flex-start', marginBottom: 8 }}
                          >
                            <div style={{ maxWidth: '78%', background: msg.from === 'me' ? '#f5f3ff' : '#fafafa', borderRadius: 10, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
                              <div style={{ fontSize: 11, color: '#8c8c8c', marginBottom: 2 }}>
                                {msg.from === 'me' ? '我们（AI）' : msg.from === 'customer' ? drawerCustomer.customerName : '平台未标注来源'}
                                {msg.time ? ` · ${msg.time}` : ''}
                              </div>
                              {msg.text}
                            </div>
                          </div>
                        ))}
                  </div>
                )}

            <Divider orientation="left" style={{ margin: '12px 0 8px' }}>本地记录（AI 回复了什么）</Divider>
            {drawerRecords.length === 0
              ? <div style={{ fontSize: 12, color: '#8c8c8c' }}>这位客户还没有本地回复记录。</div>
              : drawerRecords.map(record => (
                  <Card key={record.id} size="small" style={{ marginBottom: 8 }}>
                    <Space size={6} style={{ marginBottom: 4 }}>
                      <Tag color={REPLY_STATUS[record.status].color} icon={REPLY_STATUS[record.status].icon}>
                        {REPLY_STATUS[record.status].text}
                      </Tag>
                      <span style={{ fontSize: 12, color: '#8c8c8c' }}>{formatTime(record.at)}</span>
                    </Space>
                    <div style={{ fontSize: 12, color: '#8c8c8c' }}>对方：</div>
                    <div style={{ background: '#fafafa', borderRadius: 8, padding: '6px 8px', whiteSpace: 'pre-wrap' }}>{record.sourceText || '（无文本）'}</div>
                    <div style={{ fontSize: 12, color: '#5b4bc4', marginTop: 6 }}>AI 回复：</div>
                    <div style={{ background: '#f5f3ff', borderRadius: 8, padding: '6px 8px', whiteSpace: 'pre-wrap' }}>{record.replyText}</div>
                    {record.status === 'failed' && record.error
                      ? <div style={{ color: '#cf1322', fontSize: 12, marginTop: 4 }}>{record.error}</div>
                      : null}
                  </Card>
                ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}
