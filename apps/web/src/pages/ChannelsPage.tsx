import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { channelsApi, modelsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { usePageClamp } from '../hooks/usePageClamp';
import type { ChannelInfo, ChannelTestResult } from '../api/types';

type PriceRow = {
  costInput?: number;
  costOutput?: number;
  priceInput?: number;
  priceOutput?: number;
  discount?: number;
};

type SetPrice = (model: string, key: keyof PriceRow, value: number | null) => void;

/** 渠道×模型 定价编辑表（成本/售价/折扣） */
function PricingTable({
  models,
  pricing,
  setP,
}: {
  models: string[];
  pricing: Record<string, PriceRow>;
  setP: SetPrice;
}) {
  const num = (model: string, key: keyof PriceRow, opts: { max?: number; step?: number } = {}) => (
    <InputNumber
      size="small"
      min={0}
      max={opts.max}
      step={opts.step}
      style={{ width: 84 }}
      value={pricing[model]?.[key]}
      onChange={(v) => setP(model, key, v as number)}
    />
  );
  return (
    <Table
      size="small"
      rowKey="model"
      pagination={false}
      scroll={{ y: 260, x: 620 }}
      style={{ marginTop: 6 }}
      dataSource={models.map((m) => ({ model: m }))}
      columns={[
        { title: '模型', dataIndex: 'model', width: 170, ellipsis: true },
        { title: '成本入', width: 94, render: (_: unknown, r: { model: string }) => num(r.model, 'costInput') },
        { title: '成本出', width: 94, render: (_: unknown, r: { model: string }) => num(r.model, 'costOutput') },
        { title: '售价入', width: 94, render: (_: unknown, r: { model: string }) => num(r.model, 'priceInput') },
        { title: '售价出', width: 94, render: (_: unknown, r: { model: string }) => num(r.model, 'priceOutput') },
        { title: '折扣', width: 94, render: (_: unknown, r: { model: string }) => num(r.model, 'discount', { max: 1, step: 0.05 }) },
      ]}
    />
  );
}

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI', placeholder: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', placeholder: 'https://api.anthropic.com/v1' },
  { value: 'gemini', label: 'Google Gemini', placeholder: 'https://generativelanguage.googleapis.com/v1beta' },
  { value: 'deepseek', label: 'DeepSeek', placeholder: 'https://api.deepseek.com/v1' },
  { value: 'moonshot', label: 'Moonshot', placeholder: 'https://api.moonshot.cn/v1' },
  { value: 'qwen', label: 'Qwen (DashScope)', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'zhipu', label: '智谱 GLM', placeholder: 'https://open.bigmodel.cn/api/paas/v4' },
  { value: 'custom', label: '自定义 (OpenAI 兼容)', placeholder: 'https://your-endpoint/v1' },
];

interface Filters {
  name?: string;
  provider?: string;
  status?: string;
  ownerType?: string;
  model?: string;
}

function TestResults({ result }: { result: ChannelTestResult }) {
  const { summary } = result;
  const tone = summary.failed === 0 ? 'green' : summary.ok === 0 ? 'red' : 'orange';
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Tag color={tone}>
        通过 {summary.ok}/{summary.total}
      </Tag>
      {result.results.map((r) => (
        <div key={r.model} style={{ borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
          <Space wrap>
            <Typography.Text code>{r.model}</Typography.Text>
            {r.ok ? (
              <Tag color="green">
                成功 · HTTP {r.status} · {r.latencyMs}ms
              </Tag>
            ) : (
              <Tag color="red">
                失败{r.status ? ` · HTTP ${r.status}` : ''} · {r.latencyMs}ms
              </Tag>
            )}
          </Space>
          {r.ok && r.sample ? (
            <div style={{ marginTop: 4, color: '#888', fontSize: 12 }}>示例：{r.sample}</div>
          ) : null}
          {!r.ok && r.error ? (
            <Alert
              style={{ marginTop: 6 }}
              type="error"
              showIcon
              message={r.error}
              description={
                r.detail && r.detail !== r.error ? (
                  <Typography.Paragraph
                    code
                    copyable
                    style={{ whiteSpace: 'pre-wrap', marginBottom: 0, maxHeight: 140, overflow: 'auto' }}
                  >
                    {r.detail}
                  </Typography.Paragraph>
                ) : undefined
              }
            />
          ) : null}
        </div>
      ))}
    </Space>
  );
}

export default function ChannelsPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelInfo | null>(null);
  const [form] = Form.useForm();

  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    channel: ChannelInfo;
    result: ChannelTestResult;
  } | null>(null);
  const [modalTesting, setModalTesting] = useState(false);
  const [modalTest, setModalTest] = useState<ChannelTestResult | null>(null);
  const [pricing, setPricing] = useState<Record<string, PriceRow>>({});
  const [priceChannel, setPriceChannel] = useState<ChannelInfo | null>(null);
  const selectedModels: string[] = Form.useWatch('models', form) ?? [];

  const setP = (model: string, key: keyof PriceRow, value: number | null) =>
    setPricing((p) => ({ ...p, [model]: { ...p[model], [key]: value ?? undefined } }));

  const buildModelPrices = (models: string[]) =>
    models.map((m) => {
      const r = pricing[m] ?? {};
      const entry: Record<string, unknown> = { model: m };
      if (r.costInput != null) entry.costInput = r.costInput;
      if (r.costOutput != null) entry.costOutput = r.costOutput;
      if (r.priceInput != null) entry.priceInput = r.priceInput;
      if (r.priceOutput != null) entry.priceOutput = r.priceOutput;
      if (r.discount != null) entry.discount = r.discount;
      return entry;
    });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['channels', filters, page, pageSize],
    queryFn: ({ signal }) => channelsApi.list({ ...filters, page, pageSize }, signal),
  });

  usePageClamp(page, setPage, data);
  const { data: catalog = [] } = useQuery({
    queryKey: ['models'],
    queryFn: ({ signal }) => modelsApi.list(signal),
  });
  const { data: suggestions = [] } = useQuery({
    queryKey: ['model-suggestions'],
    queryFn: ({ signal }) => modelsApi.suggestions(signal),
  });

  const modelOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const m of catalog) map.set(m.name, { value: m.name, label: m.name });
    for (const m of suggestions) {
      if (!map.has(m.name)) {
        map.set(m.name, { value: m.name, label: `${m.name} · ${m.provider}` });
      }
    }
    return [...map.values()];
  }, [catalog, suggestions]);

  const providerModelNames = (provider: string) =>
    suggestions.filter((m) => m.provider === provider).map((m) => m.name);
  const allModelNames = suggestions.map((m) => m.name);

  const applyFilters = (next: Filters) => {
    setFilters(next);
    setPage(1);
  };

  const saveMut = useMutation({
    mutationFn: async (values: any) => {
      if (editing) {
        const payload = { ...values };
        if (!payload.apiKey) delete payload.apiKey;
        return channelsApi.update(editing.id, payload);
      }
      return channelsApi.create(values);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      setModalOpen(false);
      setEditing(null);
      setModalTest(null);
      form.resetFields();
      message.success(editing ? '渠道已更新' : '渠道已创建');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openCreate = () => {
    setEditing(null);
    setModalTest(null);
    setPricing({});
    form.resetFields();
    form.setFieldValue('models', providerModelNames('openai'));
    setModalOpen(true);
  };

  const openEdit = (r: ChannelInfo) => {
    setEditing(r);
    setModalTest(null);
    form.resetFields();
    form.setFieldsValue({
      name: r.name,
      provider: r.provider,
      baseUrl: r.baseUrl,
      models: r.models,
      weight: r.weight,
      priority: r.priority,
    });
    const p: Record<string, PriceRow> = {};
    for (const mp of r.modelPrices ?? []) {
      p[mp.model] = {
        costInput: mp.costInput ?? undefined,
        costOutput: mp.costOutput ?? undefined,
        priceInput: mp.priceInput ?? undefined,
        priceOutput: mp.priceOutput ?? undefined,
        discount: mp.discount ?? undefined,
      };
    }
    setPricing(p);
    setModalOpen(true);
  };

  const testInModal = async () => {
    let values: any;
    try {
      values = await form.validateFields(['provider', 'baseUrl', 'models']);
    } catch {
      return;
    }
    const models: string[] = values.models ?? [];
    if (!models.length) {
      message.warning('请先填写支持模型');
      return;
    }
    setModalTesting(true);
    setModalTest(null);
    try {
      const result = await channelsApi.testConnection({
        provider: values.provider,
        baseUrl: values.baseUrl,
        models,
        apiKey: form.getFieldValue('apiKey') || undefined,
        channelId: editing?.id,
      });
      setModalTest(result);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setModalTesting(false);
    }
  };

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      channelsApi.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success('已更新');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: channelsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success('已删除');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openPricing = (r: ChannelInfo) => {
    const p: Record<string, PriceRow> = {};
    for (const mp of r.modelPrices ?? []) {
      p[mp.model] = {
        costInput: mp.costInput ?? undefined,
        costOutput: mp.costOutput ?? undefined,
        priceInput: mp.priceInput ?? undefined,
        priceOutput: mp.priceOutput ?? undefined,
        discount: mp.discount ?? undefined,
      };
    }
    setPricing(p);
    setPriceChannel(r);
  };

  const savePricingMut = useMutation({
    mutationFn: (r: ChannelInfo) =>
      channelsApi.update(r.id, { modelPrices: buildModelPrices(r.models) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      setPriceChannel(null);
      message.success('定价已保存');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const runTest = async (r: ChannelInfo) => {
    setTestingId(r.id);
    try {
      const result = await channelsApi.test(r.id, r.models);
      setTestResult({ channel: r, result });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <Card
      title="上游渠道"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          添加渠道
        </Button>
      }
    >
      <Form
        layout="inline"
        style={{ marginBottom: 16, rowGap: 8 }}
        onFinish={(v: Filters) => applyFilters(v)}
      >
        <Form.Item name="name">
          <Input allowClear placeholder="渠道名称" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="provider">
          <Select
            allowClear
            placeholder="服务商"
            style={{ width: 150 }}
            options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
          />
        </Form.Item>
        <Form.Item name="model">
          <Input allowClear placeholder="模型名" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="status">
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 120 }}
            options={[
              { value: 'ENABLED', label: '启用' },
              { value: 'DISABLED', label: '停用' },
            ]}
          />
        </Form.Item>
        {isAdmin && (
          <Form.Item name="ownerType">
            <Select
              allowClear
              placeholder="归属"
              style={{ width: 120 }}
              options={[
                { value: 'PLATFORM', label: '平台' },
                { value: 'USER', label: '用户' },
              ]}
            />
          </Form.Item>
        )}
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                form.resetFields();
                applyFilters({});
              }}
            >
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Table<ChannelInfo>
        rowKey="id"
        loading={isLoading || isFetching}
        dataSource={data?.items ?? []}
        scroll={{ x: 1000 }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '归属',
            dataIndex: 'ownerType',
            render: (v: string) =>
              v === 'PLATFORM' ? <Tag color="gold">平台</Tag> : <Tag color="blue">我的</Tag>,
          },
          { title: '服务商', dataIndex: 'provider' },
          { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
          {
            title: '模型',
            dataIndex: 'models',
            render: (models: string[]) => (
              <Space size={[0, 4]} wrap>
                {models.slice(0, 4).map((m) => (
                  <Tag key={m}>{m}</Tag>
                ))}
                {models.length > 4 && <Tag>+{models.length - 4}</Tag>}
              </Space>
            ),
          },
          { title: '优先级', dataIndex: 'priority' },
          { title: '权重', dataIndex: 'weight' },
          {
            title: 'Key',
            dataIndex: 'apiKeyPreview',
            render: (v: string) => <code>{v}</code>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v: string, r) =>
              v === 'ENABLED' ? (
                <Tag color="green">启用</Tag>
              ) : r.autoDisabled ? (
                <Tooltip title={r.lastErrorMsg ?? '因连续失败自动禁用'}>
                  <Tag color="red">自动禁用</Tag>
                </Tooltip>
              ) : (
                <Tag color="default">停用</Tag>
              ),
          },
          {
            title: '价格 / 折扣',
            render: (_: unknown, r: ChannelInfo) => {
              const rows = r.modelPrices ?? [];
              const priced = rows.filter(
                (m) => m.priceInput != null || m.priceOutput != null,
              ).length;
              const discounts = rows
                .map((m) => m.discount)
                .filter((d): d is number => d != null);
              return (
                <Space size={4} wrap>
                  {priced ? (
                    <Tag color="blue">{priced} 个售价</Tag>
                  ) : (
                    <Typography.Text type="secondary">默认价</Typography.Text>
                  )}
                  {discounts.length > 0 && (
                    <Tag color="orange">折扣 {Math.min(...discounts)}</Tag>
                  )}
                </Space>
              );
            },
          },
          {
            title: '操作',
            fixed: 'right',
            width: 340,
            render: (_, r) => (
              <Space>
                <Button size="small" loading={testingId === r.id} onClick={() => runTest(r)}>
                  测试
                </Button>
                <Button size="small" onClick={() => openPricing(r)}>
                  定价
                </Button>
                <Button size="small" onClick={() => openEdit(r)}>
                  编辑
                </Button>
                {r.status === 'ENABLED' ? (
                  <Button size="small" onClick={() => updateMut.mutate({ id: r.id, status: 'DISABLED' })}>
                    停用
                  </Button>
                ) : (
                  <Button size="small" onClick={() => updateMut.mutate({ id: r.id, status: 'ENABLED' })}>
                    启用
                  </Button>
                )}
                <Popconfirm title="确定删除该渠道？" onConfirm={() => removeMut.mutate(r.id)}>
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? `编辑渠道：${editing.name}` : '添加渠道'}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          setModalTest(null);
        }}
        footer={[
          <Button key="test" loading={modalTesting} onClick={testInModal}>
            测试连通性
          </Button>,
          <Button
            key="cancel"
            onClick={() => {
              setModalOpen(false);
              setEditing(null);
              setModalTest(null);
            }}
          >
            取消
          </Button>,
          <Button key="save" type="primary" loading={saveMut.isPending} onClick={() => form.submit()}>
            保存
          </Button>,
        ]}
        destroyOnClose
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate({ ...v, modelPrices: buildModelPrices(v.models ?? []) })}
          requiredMark={false}
          initialValues={{ provider: 'openai', weight: 1, priority: 0, ownerType: 'USER' }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：我的 OpenAI" />
          </Form.Item>
          {isAdmin && !editing && (
            <Form.Item name="ownerType" label="归属">
              <Select
                options={[
                  { value: 'USER', label: '我的 (BYOK)' },
                  { value: 'PLATFORM', label: '平台托管' },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="provider" label="服务商" rules={[{ required: true }]}>
            <Select
              options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
              onChange={(v) => {
                const p = PROVIDERS.find((x) => x.value === v);
                if (p) form.setFieldValue('baseUrl', p.placeholder);
                if (!editing) form.setFieldValue('models', providerModelNames(v));
              }}
            />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[{ required: true, message: '请输入 Base URL' }]}
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label="上游 API Key"
            rules={editing ? [] : [{ required: true, message: '请输入上游 Key' }]}
            extra={editing ? '留空则不修改已保存的密钥' : undefined}
          >
            <Input.Password placeholder={editing ? '留空则不修改' : 'sk-... / 上游密钥（加密存储）'} />
          </Form.Item>
          <Form.Item
            name="models"
            label="支持的模型"
            rules={[{ required: true, message: '至少填写一个模型' }]}
          >
            <Select
              mode="tags"
              placeholder="可搜索/多选，也可直接输入模型名后回车"
              options={modelOptions}
              optionFilterProp="label"
            />
          </Form.Item>
          <div style={{ marginTop: -12, marginBottom: 12 }}>
            <Space size={8} wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                快捷：
              </Typography.Text>
              <Button
                size="small"
                onClick={() =>
                  form.setFieldValue('models', providerModelNames(form.getFieldValue('provider')))
                }
              >
                选本服务商全部
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', allModelNames)}>
                选全部推荐
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', [])}>
                清空
              </Button>
            </Space>
          </div>

          {selectedModels.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                逐模型定价（可选，USD/1M tokens；留空则用模型目录默认价 × 折扣）
              </Typography.Text>
              <PricingTable models={selectedModels} pricing={pricing} setP={setP} />
            </div>
          )}
          <Space size={16}>
            <Form.Item name="priority" label="优先级（越大越优先）">
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="weight" label="权重（同级负载）">
              <InputNumber min={1} />
            </Form.Item>
          </Space>
        </Form>

        {modalTest && (
          <div style={{ marginTop: 8 }}>
            <TestResults result={modalTest} />
          </div>
        )}
      </Modal>

      <Modal
        title={`测试渠道：${testResult?.channel.name ?? ''}`}
        open={!!testResult}
        onCancel={() => setTestResult(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setTestResult(null)}>
            关闭
          </Button>,
        ]}
      >
        {testResult && <TestResults result={testResult.result} />}
      </Modal>

      <Modal
        title={`渠道定价：${priceChannel?.name ?? ''}`}
        open={!!priceChannel}
        onCancel={() => setPriceChannel(null)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setPriceChannel(null)}>
            取消
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={savePricingMut.isPending}
            onClick={() => priceChannel && savePricingMut.mutate(priceChannel)}
          >
            保存
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          成本 USD/1M tokens（用于按成本路由与毛利统计）；售价留空则用模型目录默认价 ×
          折扣。清空某项将恢复为默认。
        </Typography.Paragraph>
        {priceChannel && (
          <PricingTable models={priceChannel.models} pricing={pricing} setP={setP} />
        )}
      </Modal>
    </Card>
  );
}
