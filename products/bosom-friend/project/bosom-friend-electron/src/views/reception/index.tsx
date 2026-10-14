import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import {
  RECEPTION_PLATFORMS,
  ReceptionRule,
  receptionApi,
  TestReceptionResult,
} from '@/api/reception';
import { getAccountListApi } from '@web/api/accounts/account.api';

const AI_MODELS = [
  { value: 'user-llm', label: '使用已配置的大模型（设置 → 自定义大模型）' },
];

/**
 * 接待规则模板推荐：一键套用，降低小白用户配置门槛
 */
const RECEPTION_TEMPLATES = [
  {
    name: '报价咨询',
    keywords: ['报价', '价格', '多少钱', '收费', '费用', '怎么收费'],
    systemPrompt:
      '你是「Bosom FriendAI内容创作营销系统」的智能客服助手，回复要简洁、热情、专业，客户询问价格时主动介绍服务并引导留下联系方式或预约演示。',
    description: '客户询问价格/费用时，AI 自动介绍并引导留资',
  },
  {
    name: '合作洽谈',
    keywords: ['合作', '商务', '代理', '加盟', '招商'],
    systemPrompt:
      '你是「Bosom FriendAI内容创作营销系统」的商务接待助手，语气专业友好，介绍合作方式并邀请进一步沟通。',
    description: '合作伙伴/代理商咨询时生成建议并确认发送',
  },
  {
    name: '售后客服',
    keywords: ['售后', '退款', '坏了', '问题', '客服', '投诉'],
    systemPrompt:
      '你是「Bosom FriendAI内容创作营销系统」的售后客服，先安抚客户情绪，再了解具体问题并给出解决方案，必要时引导联系人工。',
    description: '售后/退款类问题自动响应',
  },
  {
    name: '新品促销',
    keywords: ['新品', '促销', '优惠', '活动', '下单', '购买'],
    systemPrompt:
      '你是「Bosom FriendAI内容创作营销系统」的营销助手，热情介绍新品与活动，突出优惠亮点并引导下单。',
    description: '新品/活动咨询自动介绍',
  },
];

const platformLabel = (value: string) =>
  RECEPTION_PLATFORMS.find(item => item.value === value)?.label || value;

export default function ReceptionPage() {
  const [rules, setRules] = useState<ReceptionRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<ReceptionRule | null>(null);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<TestReceptionResult | null>(null);
const [accountOptions, setAccountOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [form] = Form.useForm();
  const [testForm] = Form.useForm();
  const editingIdRef = useRef<string | null>(null);

  async function getRules() {
    setLoading(true);
    try {
      const res = await receptionApi.getRules();
      setRules(res || []);
    } catch {
      message.error('获取接待规则失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getRules();
    void (async () => {
      try {
        const res = await getAccountListApi()
        const raw = res?.data
        const list: Array<{ id: string; nickname?: string; type?: string }> = Array.isArray(raw) ? raw : (raw?.list ?? [])
        setAccountOptions(list.map(a => ({ label: a.nickname || a.type || a.id, value: a.id })))
      } catch { /* 账号列表加载失败不阻塞规则页 */ }
    })()
  }, []);

  function openCreate() {
    editingIdRef.current = null;
    setEditing(null);
    // 先打开弹窗，待表单挂载后再设默认值：
    // 弹窗 destroyOnClose，先 setFieldsValue 会导致 useForm 未连接（默认值丢失）
    setRuleModalOpen(true);
    window.setTimeout(() => {
      form.resetFields();
      form.setFieldsValue({
        platforms: [],
        keywords: [],
        matchMode: 'any',
        excludeKeywords: [],
        cooldownMinutes: 30,
        replyMode: 'ai',
        aiModel: 'user-llm',
        enabled: true,
        priority: 100,
        systemPrompt: '你是「Bosom FriendAI内容创作营销系统」的智能客服助手，请用简洁、热情、专业的中文回复访客。',
      });
    }, 0);
  }

  /**
   * 一键套用推荐模板
   */
  function applyTemplate(tpl: (typeof RECEPTION_TEMPLATES)[number]) {
    editingIdRef.current = null;
    setEditing(null);
    // 先打开弹窗，待表单挂载后再填模板值（避免 useForm 未连接导致模板丢失）
    setRuleModalOpen(true);
    window.setTimeout(() => {
      form.resetFields();
      form.setFieldsValue({
        name: tpl.name,
        keywords: tpl.keywords,
        platforms: [],
        matchMode: 'any',
        excludeKeywords: [],
        cooldownMinutes: 30,
        replyMode: 'ai',
        aiModel: 'user-llm',
        enabled: true,
        priority: 100,
        systemPrompt: tpl.systemPrompt,
      });
    }, 0);
  }

  function openEdit(rule: ReceptionRule) {
    editingIdRef.current = rule.id;
    setEditing(rule);
    // 先打开弹窗，待表单挂载后再回填（避免 useForm 未连接导致编辑值丢失）
    setRuleModalOpen(true);
    window.setTimeout(() => {
      form.resetFields();
      form.setFieldsValue({
        name: rule.name,
        accountId: rule.accountId || undefined,
        platforms: rule.platforms || [],
        keywords: rule.keywords || [],
        matchMode: rule.matchMode || 'any',
        excludeKeywords: rule.excludeKeywords || [],
        cooldownMinutes: rule.cooldownMinutes ?? 30,
        replyMode: rule.replyMode,
        template: rule.template,
        aiModel: rule.aiModel || 'user-llm',
        systemPrompt: rule.systemPrompt,
        enabled: rule.enabled,
        priority: rule.priority,
      });
    }, 0);
  }

  async function saveRule() {
    const values = await form.validateFields();
    try {
      if (editingIdRef.current) {
        await receptionApi.updateRule(editingIdRef.current, values);
        message.success('规则已更新');
      }
      else {
        await receptionApi.createRule(values);
        message.success('规则已创建');
      }
      setRuleModalOpen(false);
      getRules();
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message || '保存失败');
    }
  }

  async function removeRule(rule: ReceptionRule) {
    Modal.confirm({
      title: '删除规则',
      content: `确定删除「${rule.name}」吗？删除后该规则将不再生效。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await receptionApi.deleteRule(rule.id);
        message.success('已删除');
        getRules();
      },
    });
  }

  async function toggleRule(rule: ReceptionRule, enabled: boolean) {
    try {
      await receptionApi.updateRule(rule.id, { ...rule, enabled });
      getRules();
    } catch {
      message.error('更新状态失败');
    }
  }

  function openTest() {
    testForm.resetFields();
    setTestResult(null);
    setTestModalOpen(true);
  }

  async function runTest() {
    const values = await testForm.validateFields();
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await receptionApi.testReception({
        message: values.message,
        platform: values.platform,
      });
      setTestResult(res);
      } catch {
      message.error('测试失败');
    } finally {
      setTestLoading(false);
    }
  }

  const columns = [
    {
      title: '规则名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
    },
    {
      title: '触发关键词',
      dataIndex: 'keywords',
      key: 'keywords',
      render: (keywords: string[]) =>
        (keywords || []).map(keyword => <Tag key={keyword} color="green">{keyword}</Tag>),
    },
    {
      title: '匹配方式',
      dataIndex: 'matchMode',
      key: 'matchMode',
      width: 110,
      render: (mode?: string) =>
        mode === 'all' ? <Tag color="purple">全部命中</Tag> : <Tag color="cyan">任一命中</Tag>,
    },
    {
      title: '排除词',
      dataIndex: 'excludeKeywords',
      key: 'excludeKeywords',
      width: 160,
      render: (keywords: string[]) =>
        !keywords || keywords.length === 0
          ? <span>—</span>
          : keywords.map(keyword => <Tag key={keyword} color="red">{keyword}</Tag>),
    },
    {
      title: '适用账号',
      dataIndex: 'accountId',
      key: 'accountId',
      width: 140,
      render: (accountId: string) => accountId ? (accountOptions.find(a => a.value === accountId)?.label ?? accountId) : <Tag>全部账号</Tag>,
    },
    {
      title: '适用平台',
      dataIndex: 'platforms',
      key: 'platforms',
      width: 180,
      render: (platforms: string[]) =>
        !platforms || platforms.length === 0
          ? <Tag>全部平台</Tag>
          : platforms.map(platform => <Tag key={platform}>{platformLabel(platform)}</Tag>),
    },
    {
      title: '回复方式',
      dataIndex: 'replyMode',
      key: 'replyMode',
      width: 110,
      render: (mode: string) =>
        mode === 'ai'
          ? <Tag color="blue" icon={<RobotOutlined />}>AI 生成</Tag>
          : <Tag color="orange">固定模板</Tag>,
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 90,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (enabled: boolean, record: ReceptionRule) => (
        <Switch
          checked={enabled}
          onChange={value => toggleRule(record, value)}
          aria-label={`启用规则：${record.name}`}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_: unknown, record: ReceptionRule) => (
        <Space>
          <Button icon={<EditOutlined />} onClick={() => openEdit(record)} className="!h-9 !rounded-xl !px-4 !text-sm">编辑</Button>
          <Button icon={<RobotOutlined />} onClick={openTest} className="!h-9 !rounded-xl !px-4 !text-sm">测试</Button>
          <Button danger icon={<DeleteOutlined />} onClick={() => removeRule(record)} className="!h-9 !rounded-xl !px-4 !text-sm">删除</Button>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ minHeight: '100%' }}>
      <div className="reception-tabs-card">
        <Tabs
          defaultActiveKey="rules"
          items={[
          {
            key: 'rules',
            label: '接待规则',
            children: (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div>
                    <h2 className="section-title" style={{ margin: 0 }}>自动接待</h2>
                    <p style={{ margin: '6px 0 0', color: '#595959' }}>
                      配置触发关键词与 AI 客服；引擎 7×24 只读采集并登记待办，全自动模式由前端智能体自动发送，关闭模式则由你在平台通道确认发送。
                      评论/私信接待的待办处理与回复记录统一在「全局监控」，这里只保留规则配置。
                    </p>
                  </div>
                  <Space>
                    <Button icon={<RobotOutlined />} onClick={openTest} className="!h-9 !rounded-xl !px-4 !text-sm">测试接待</Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} className="!h-9 !rounded-xl !px-4 !text-sm">新建规则</Button>
                    <Button onClick={() => { window.location.hash = '#/monitor' }} className="!h-9 !rounded-xl !px-4 !text-sm">评论/私信接待 → 全局监控</Button>
                  </Space>
                </div>
                {/* 模板推荐 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    padding: '10px 12px',
                    marginBottom: 16,
                    background: 'linear-gradient(135deg, #f5f3ff, #eef2ff)',
                    border: '1px solid rgba(169, 137, 255, 0.18)',
                    borderRadius: 12,
                  }}
                >
                  <span className="text-sm font-medium text-primary">
                    推荐模板
                  </span>
                  {RECEPTION_TEMPLATES.map(tpl => (
                    <Button
                      key={tpl.name}
                      title={tpl.description}
                      onClick={() => applyTemplate(tpl)}
                      className="!h-9 !rounded-xl !px-4 !text-sm"
                    >
                      {tpl.name}
                    </Button>
                  ))}
                  <span className="text-xs text-muted-foreground">
                    点击即可一键套用，也可自行新建
                  </span>
                </div>
                <Table
                  rowKey="id"
                  loading={loading}
                  columns={columns}
                  dataSource={rules}
                  pagination={false}
                  locale={{
                    emptyText: (
                      <div style={{ padding: '30px 0' }}>
                        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 18 }}>
                          还没有接待规则，跟着三步快速开始：
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            gap: 14,
                            flexWrap: 'wrap',
                          }}
                        >
                          {['新建规则', '绑定触发词', '设置智能回复'].map((step, i) => (
                            <div
                              key={step}
                              style={{ display: 'flex', alignItems: 'center', gap: 14 }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '9px 16px',
                                  background: '#faf8ff',
                                  border: '1px solid rgba(169, 137, 255, 0.20)',
                                  borderRadius: 10,
                                }}
                              >
                                <span
                                  style={{
                                    width: 20,
                                    height: 20,
                                    borderRadius: '50%',
                                    background: '#a78bfa',
                                    color: '#fff',
                                    fontSize: 12,
                                    lineHeight: '20px',
                                    textAlign: 'center',
                                  }}
                                >
                                  {i + 1}
                                </span>
                                <span style={{ fontSize: 13, color: '#4b5563' }}>{step}</span>
                              </div>
                              {i < 2 && <span style={{ color: '#c4b5fd' }}>➜</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ),
                  }}
                />
              </>
            ),
          },
          ]}
        />
      </div>

      <Modal
        title={editing ? `编辑规则：${editing.name}` : '新建接待规则'}
        open={ruleModalOpen}
        onOk={saveRule}
        onCancel={() => setRuleModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={640}
        forceRender
        centered
        styles={{ body: { maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' } }}
      >
        <Form form={form} layout="vertical">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '8px 12px',
              marginBottom: 16,
              background: '#faf8ff',
              border: '1px solid rgba(169, 137, 255, 0.16)',
              borderRadius: 10,
            }}
          >
            <span className="text-sm font-medium text-primary">
              快速套用模板
            </span>
            {RECEPTION_TEMPLATES.map(tpl => (
              <Button
                key={tpl.name}
                size="small"
                type="link"
                title={tpl.description}
                onClick={() => applyTemplate(tpl)}
                style={{ padding: 0 }}
              >
                {tpl.name}
              </Button>
            ))}
          </div>
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input placeholder="例如：报价咨询、合作洽谈" maxLength={50} />
          </Form.Item>
          <Form.Item name="keywords" label="触发关键词" rules={[{ required: true, message: '请至少输入一个关键词' }]}>
            <Select
              mode="tags"
              placeholder="输入关键词后回车添加，例如：报价、多少钱、价格"
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Form.Item name="matchMode" label="关键词匹配方式">
            <Radio.Group>
              <Radio value="any">命中任一关键词即触发</Radio>
              <Radio value="all">全部关键词都命中才触发</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="excludeKeywords" label="排除词（可选）">
            <Select
              mode="tags"
              placeholder="输入后回车添加；命中任意排除词的访客消息不会触发该规则"
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Form.Item name="accountId" label="适用账号">
            <Select
              placeholder="不选则应用于全部账号（平台级规则）"
              options={accountOptions}
              allowClear
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="platforms" label="适用平台">
            <Select
              mode="multiple"
              placeholder="不选则匹配全部平台"
              options={RECEPTION_PLATFORMS}
              allowClear
            />
          </Form.Item>
          <Form.Item name="replyMode" label="回复方式" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value="ai">AI 智能生成</Radio>
              <Radio value="template">固定模板</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.replyMode !== cur.replyMode}>
            {({ getFieldValue }) =>
              getFieldValue('replyMode') === 'template'
                ? (
                  <Form.Item name="template" label="固定模板内容" rules={[{ required: true, message: '请输入模板内容' }]}>
                    <Input.TextArea rows={3} placeholder="例如：您好，感谢咨询！我们的顾问稍后与您联系，请留下您的联系方式。" />
                  </Form.Item>
                )
                : (
                  <>
                    <Form.Item name="aiModel" label="AI 模型">
                      <Select options={AI_MODELS} />
                    </Form.Item>
                    <Form.Item name="systemPrompt" label="客服人设（可选）">
                      <Input.TextArea rows={3} placeholder="告诉 AI 如何接待访客，例如：你是Bosom Friend平台客服，回复简洁友好…" />
                    </Form.Item>
                  </>
                )
            }
          </Form.Item>
          <Space size="large">
            <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
              <InputNumber min={1} max={1000} />
            </Form.Item>
            <Form.Item name="cooldownMinutes" label="失败重试冷却（分钟）">
              <InputNumber min={0} max={1440} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="测试接待建议"
        open={testModalOpen}
        onCancel={() => setTestModalOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <Form form={testForm} layout="vertical">
          <Form.Item name="platform" label="模拟来源平台">
            <Select
              placeholder="不选则匹配全部平台规则"
              options={RECEPTION_PLATFORMS}
              allowClear
            />
          </Form.Item>
          <Form.Item name="message" label="访客消息" rules={[{ required: true, message: '请输入访客消息' }]}>
            <Input.TextArea rows={3} placeholder="例如：你们平台怎么收费的？" />
          </Form.Item>
          <Button type="primary" loading={testLoading} onClick={runTest} className="!h-9 !rounded-xl !px-4 !text-sm">开始测试</Button>
        </Form>

        {testResult && (
          <div style={{ marginTop: 16, padding: 16, background: '#faf8ff', borderRadius: 10, border: '1px solid rgba(169, 137, 255, 0.25)' }}>
            {testResult.matched ? (
              <>
                <p style={{ margin: 0 }}>
                  命中规则：<Tag color="blue">{testResult.rule?.name}</Tag>
                  {testResult.aiUsed && <Tag color="green">AI 生成</Tag>}
                </p>
                <p style={{ margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{testResult.reply}</p>
              </>
            ) : (
              <p style={{ margin: 0, color: '#d46b08' }}>未命中任何规则，请检查关键词或平台配置。</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
