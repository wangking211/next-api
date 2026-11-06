import { useEffect, useState } from 'react';
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
import { PlusOutlined, CopyOutlined, ApiOutlined, BookOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keysApi, groupsApi, channelsApi } from '../api/endpoints';
import { testKeyConnectivity } from '../api/keyConnectivity';
import type { KeyConnectivityResult } from '../api/keyConnectivity';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatMoney, useCurrency } from '../utils/format';
import QueryError from '../components/QueryError';
import type { ApiKeyCreated, ApiKeyInfo, KeyTestResult, RoutingStrategy } from '../api/types';

type StrategyOptionKey =
  | 'keys.strategyOption.balanced'
  | 'keys.strategyOption.cheapest'
  | 'keys.strategyOption.fastest'
  | 'keys.strategyOption.stable'
  | 'keys.strategyOption.qualityFirst';

type StrategyLabelKey =
  | 'keys.strategyLabel.balanced'
  | 'keys.strategyLabel.cheapest'
  | 'keys.strategyLabel.fastest'
  | 'keys.strategyLabel.stable'
  | 'keys.strategyLabel.qualityFirst';

/** 智能路由策略选项：评分权重预设（价格/速度/稳定性/质量/分流噪声） */
const STRATEGY_OPTIONS: { value: RoutingStrategy; labelKey: StrategyOptionKey }[] = [
  { value: 'BALANCED', labelKey: 'keys.strategyOption.balanced' },
  { value: 'CHEAPEST', labelKey: 'keys.strategyOption.cheapest' },
  { value: 'FASTEST', labelKey: 'keys.strategyOption.fastest' },
  { value: 'STABLE', labelKey: 'keys.strategyOption.stable' },
  { value: 'QUALITY_FIRST', labelKey: 'keys.strategyOption.qualityFirst' },
];

const STRATEGY_LABEL: Record<RoutingStrategy, StrategyLabelKey> = {
  BALANCED: 'keys.strategyLabel.balanced',
  CHEAPEST: 'keys.strategyLabel.cheapest',
  FASTEST: 'keys.strategyLabel.fastest',
  STABLE: 'keys.strategyLabel.stable',
  QUALITY_FIRST: 'keys.strategyLabel.qualityFirst',
};

export default function KeysPage() {
  const { t } = useTranslation();
  useCurrency(); // 订阅展示币种
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKeyInfo | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<KeyConnectivityResult | null>(null);
  // Key 列表的「测试连通性」：诊断探针（不扣费、不写调用记录），走服务端真实路由
  const [probeKey, setProbeKey] = useState<ApiKeyInfo | null>(null);
  const [probeModel, setProbeModel] = useState<string | undefined>();
  const [probeResult, setProbeResult] = useState<KeyTestResult | null>(null);
  const [form] = Form.useForm();

  /** 关闭创建弹窗并清掉连通测试结果，避免下次打开残留上次状态 */
  const closeCreated = () => {
    setCreated(null);
    setTestResult(null);
  };

  /** 用弹窗里的一次性明文 Key 请求 /v1/models：验证 Key 有效且网关可达（不计费） */
  const runConnectivityTest = async () => {
    if (!created?.plaintext) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testKeyConnectivity(created.plaintext));
    } finally {
      setTesting(false);
    }
  };

  const {
    data: keys = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['keys'],
    queryFn: ({ signal }) => keysApi.list(signal),
  });

  const { data: groups = [] } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => groupsApi.list(signal),
  });

  const probeModelsQ = useQuery({
    queryKey: ['keys', probeKey?.id, 'test-models'],
    queryFn: ({ signal }) => keysApi.testModels(probeKey!.id, signal),
    enabled: !!probeKey,
  });
  // 打开弹窗后自动选第一个可测模型（白名单优先；否则取可见渠道支持的模型）
  useEffect(() => {
    if (!probeKey) return;
    const list = probeModelsQ.data ?? [];
    if (!list.length) return;
    if (!probeModel || !list.includes(probeModel)) setProbeModel(list[0]);
  }, [probeKey, probeModelsQ.data, probeModel]);

  const probeMut = useMutation({
    mutationFn: () => keysApi.test(probeKey!.id, probeModel),
    onSuccess: (r) => setProbeResult(r),
  });
  const openProbe = (r: ApiKeyInfo) => {
    setProbeKey(r);
    setProbeModel(r.models?.[0]);
    setProbeResult(null);
  };
  const closeProbe = () => {
    setProbeKey(null);
    setProbeResult(null);
  };

  // 渠道白名单选项（普通用户接口只返回自有渠道，天然只能选自己的）
  const { data: channelList = [] } = useQuery({
    queryKey: ['channels', 'keyWhitelist'],
    queryFn: ({ signal }) =>
      channelsApi.list({ page: 1, pageSize: 100 }, signal).then((p) => p.items),
    staleTime: 60_000,
  });
  const channelName = (id: string) => channelList.find((c) => c.id === id)?.name ?? id;
  // 排除当前用户确定不可见的渠道：他人的私有渠道（admin 也路由不了别人的 PRIVATE，
  // 白名单只做可见性取交集）——选了也只是白填，不给这个选项
  const myId = user?.id;
  const selectableChannels = channelList.filter(
    (c) =>
      !(
        c.ownerType === 'USER' &&
        c.ownerUserId != null &&
        c.ownerUserId !== myId &&
        c.shareMode === 'PRIVATE'
      ),
  );

  const createMut = useMutation({
    mutationFn: keysApi.create,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      setCreateOpen(false);
      setEditing(null);
      form.resetFields();
      setCreated(data);
    },
  });

  const editMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof keysApi.update>[1] }) =>
      keysApi.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      setCreateOpen(false);
      setEditing(null);
      form.resetFields();
      message.success(t('keys.toast.updated'));
    },
  });

  /** 新建：清空表单后打开（与编辑共用同一弹窗） */
  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setCreateOpen(true);
  };

  /** 编辑：回填可修改字段（成本额度是 Decimal 字符串，转数字给 InputNumber） */
  const openEdit = (r: ApiKeyInfo) => {
    setEditing(r);
    form.setFieldsValue({
      name: r.name,
      quotaLimit: r.quotaLimit ?? undefined,
      costLimit: r.costLimit != null ? Number(r.costLimit) : undefined,
      rpmLimit: r.rpmLimit ?? undefined,
      tpmLimit: r.tpmLimit ?? undefined,
      routingStrategy: r.routingStrategy ?? undefined,
      models: r.models ?? [],
      allowedChannelIds: r.allowedChannelIds ?? [],
      groupId: r.groupId ?? undefined,
    });
    setCreateOpen(true);
  };

  const closeForm = () => {
    setCreateOpen(false);
    setEditing(null);
  };

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => keysApi.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      message.success(t('keys.toast.updated'));
    },
  });

  const removeMut = useMutation({
    mutationFn: keysApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      message.success(t('keys.toast.deleted'));
    },
  });

  const groupMut = useMutation({
    mutationFn: ({ id, groupId }: { id: string; groupId: string | null }) =>
      keysApi.update(id, { groupId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      message.success(t('keys.toast.updated'));
    },
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t('keys.toast.copied'));
    } catch {
      message.warning(t('keys.toast.copyFailed'));
    }
  };

  // 接入说明的地址按当前部署域名生成（本地/生产自动适配）
  const origin = window.location.origin;
  const baseUrl = `${origin}/v1`;
  const curlExample = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer sk-xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'`;

  return (
    <Card
      title="API Key"
      extra={
        <Space>
          <Button icon={<BookOutlined />} onClick={() => setDocsOpen(true)}>
            {t('keys.docs.button')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('keys.create')}
          </Button>
        </Space>
      }
    >
      <QueryError show={isError} onRetry={refetch} />

      <Table<ApiKeyInfo>
        rowKey="id"
        loading={isLoading}
        dataSource={keys}
        pagination={false}
        scroll={{ x: 1600 }}
        columns={[
          { title: t('keys.table.name'), dataIndex: 'name' },
          {
            title: <Tooltip title={t('keys.table.keyTooltip')}>Key</Tooltip>,
            dataIndex: 'keyPrefix',
            render: (v: string) => (
              <Tooltip title={t('keys.table.keyTooltip')}>
                <code>{v}</code>
              </Tooltip>
            ),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (v: string) => {
              const color = v === 'ACTIVE' ? 'green' : v === 'DISABLED' ? 'orange' : 'red';
              return <Tag color={color}>{v}</Tag>;
            },
          },
          {
            title: t('keys.table.tokenUsage'),
            render: (_, r) =>
              r.quotaLimit ? `${r.quotaUsed} / ${r.quotaLimit}` : `${r.quotaUsed} / ∞`,
          },
          {
            title: (
              <Tooltip title={t('keys.table.costUsageTooltip')}>
                {t('keys.table.costUsage')}
              </Tooltip>
            ),
            render: (_, r) =>
              r.costLimit
                ? `${formatMoney(r.costUsed)} / ${formatMoney(r.costLimit)}`
                : `${formatMoney(r.costUsed)} / ∞`,
          },
          {
            title: 'RPM',
            dataIndex: 'rpmLimit',
            render: (v: number | null) => v ?? '∞',
          },
          {
            title: (
              <Tooltip title={t('keys.table.strategyTooltip')}>
                {t('keys.table.routingStrategy')}
              </Tooltip>
            ),
            dataIndex: 'routingStrategy',
            width: 100,
            render: (v: RoutingStrategy | null) =>
              v ? (
                <Tag color="blue">{t(STRATEGY_LABEL[v])}</Tag>
              ) : (
                <Tag>{t('keys.strategyLabel.default')}</Tag>
              ),
          },
          {
            title: 'TPM',
            dataIndex: 'tpmLimit',
            render: (v: number | null) => v ?? '∞',
          },
          {
            title: t('keys.table.modelWhitelist'),
            dataIndex: 'models',
            width: 180,
            render: (v: string[]) =>
              v?.length ? (
                <Space size={[0, 4]} wrap>
                  {v.slice(0, 3).map((m) => (
                    <Tag key={m}>{m}</Tag>
                  ))}
                  {v.length > 3 ? <Tag>+{v.length - 3}</Tag> : null}
                </Space>
              ) : (
                t('keys.table.unlimited')
              ),
          },
          {
            title: t('keys.table.channelWhitelist'),
            dataIndex: 'allowedChannelIds',
            width: 170,
            render: (v: string[]) =>
              v?.length ? (
                <Space size={[0, 4]} wrap>
                  {v.slice(0, 3).map((id) => (
                    <Tag key={id}>{channelName(id)}</Tag>
                  ))}
                  {v.length > 3 ? <Tag>+{v.length - 3}</Tag> : null}
                </Space>
              ) : (
                t('keys.table.unlimited')
              ),
          },
          {
            title: t('keys.table.lastUsed'),
            dataIndex: 'lastUsedAt',
            render: (v: string | null) => (v ? formatDateTime(v) : t('keys.table.never')),
          },
          {
            title: t('keys.table.group'),
            dataIndex: 'group',
            width: 190,
            render: (_, r) =>
              isAdmin ? (
                <Select
                  size="small"
                  allowClear
                  style={{ width: 170 }}
                  placeholder={t('keys.table.groupNone')}
                  value={r.groupId ?? undefined}
                  options={groups.map((g) => ({ value: g.id, label: g.displayName }))}
                  onChange={(v) => groupMut.mutate({ id: r.id, groupId: v ?? null })}
                />
              ) : r.group ? (
                <Tooltip title={t('keys.form.groupAdminOnly')}>
                  <Tag color="cyan">{r.group.displayName}</Tag>
                </Tooltip>
              ) : (
                t('keys.table.groupNone')
              ),
          },
          {
            title: t('common.action'),
            fixed: 'right',
            width: 380,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<ApiOutlined />} onClick={() => openProbe(r)}>
                  {t('keys.test')}
                </Button>
                <Button size="small" onClick={() => openEdit(r)}>
                  {t('keys.edit')}
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    navigate(
                      `/logs?apiKeyId=${encodeURIComponent(r.id)}&apiKeyName=${encodeURIComponent(r.name)}`,
                    )
                  }
                >
                  {t('keys.usageRecords')}
                </Button>
                {r.status === 'ACTIVE' ? (
                  <Button
                    size="small"
                    onClick={() => updateMut.mutate({ id: r.id, status: 'DISABLED' })}
                  >
                    {t('keys.disable')}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    onClick={() => updateMut.mutate({ id: r.id, status: 'ACTIVE' })}
                  >
                    {t('keys.enable')}
                  </Button>
                )}
                <Popconfirm
                  title={t('keys.confirmDeleteKey')}
                  onConfirm={() => removeMut.mutate(r.id)}
                >
                  <Button size="small" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? t('keys.editModal.title') : t('keys.createModal.title')}
        open={createOpen}
        onCancel={closeForm}
        onOk={() => form.submit()}
        confirmLoading={editing ? editMut.isPending : createMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            if (!editing) {
              createMut.mutate(v);
              return;
            }
            // 编辑：空值显式传 null —— PATCH 语义里 undefined 表示「不修改」
            editMut.mutate({
              id: editing.id,
              body: {
                name: v.name,
                quotaLimit: v.quotaLimit ?? null,
                costLimit: v.costLimit ?? null,
                rpmLimit: v.rpmLimit ?? null,
                tpmLimit: v.tpmLimit ?? null,
                routingStrategy: v.routingStrategy ?? null,
                models: Array.isArray(v.models) && v.models.length ? v.models : null,
                allowedChannelIds:
                  Array.isArray(v.allowedChannelIds) && v.allowedChannelIds.length
                    ? v.allowedChannelIds
                    : null,
                ...(isAdmin ? { groupId: v.groupId ?? null } : {}),
              },
            });
          }}
          requiredMark={false}
        >
          <Form.Item
            name="name"
            label={t('keys.form.name')}
            rules={[{ required: true, message: t('keys.form.nameRequired') }]}
          >
            <Input placeholder={t('keys.form.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="quotaLimit" label={t('keys.form.quotaLimit')}>
            <InputNumber
              min={1}
              style={{ width: '100%' }}
              placeholder={t('keys.form.example', { value: 1000000 })}
            />
          </Form.Item>
          <Form.Item name="costLimit" label={t('keys.form.costLimit')}>
            <InputNumber
              min={0}
              step={0.1}
              style={{ width: '100%' }}
              placeholder={t('keys.form.example', { value: 10 })}
            />
          </Form.Item>
          <Form.Item name="rpmLimit" label={t('keys.form.rpmLimit')}>
            <InputNumber
              min={1}
              style={{ width: '100%' }}
              placeholder={t('keys.form.example', { value: 60 })}
            />
          </Form.Item>
          <Form.Item
            name="routingStrategy"
            label={t('keys.form.strategy')}
            tooltip={t('keys.form.strategyTooltip')}
          >
            <Select
              allowClear
              placeholder={t('keys.strategyOption.balanced')}
              options={STRATEGY_OPTIONS.map(({ value, labelKey }) => ({
                value,
                label: t(labelKey),
              }))}
            />
          </Form.Item>
          <Form.Item name="tpmLimit" label={t('keys.form.tpmLimit')}>
            <InputNumber
              min={1}
              style={{ width: '100%' }}
              placeholder={t('keys.form.example', { value: 100000 })}
            />
          </Form.Item>
          {isAdmin && (
            <Form.Item
              name="groupId"
              label={t('keys.form.group')}
              extra={t('keys.form.groupPlaceholder')}
            >
              <Select
                allowClear
                placeholder={t('keys.table.groupNone')}
                options={groups.map((g) => ({ value: g.id, label: g.displayName }))}
              />
            </Form.Item>
          )}
          <Form.Item
            name="models"
            label={t('keys.form.models')}
            normalize={(v: unknown) =>
              Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : v
            }
          >
            <Select
              mode="tags"
              tokenSeparators={[',', ' ']}
              placeholder={t('keys.form.modelsPlaceholder')}
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Form.Item
            name="allowedChannelIds"
            label={t('keys.form.channels')}
            extra={t('keys.form.channelsExtra')}
            normalize={(v: unknown) =>
              Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : v
            }
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('keys.form.channelsPlaceholder')}
              options={selectableChannels.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('keys.docs.title')}
        open={docsOpen}
        onCancel={() => setDocsOpen(false)}
        footer={
          <Button type="primary" onClick={() => setDocsOpen(false)}>
            {t('keys.docs.close')}
          </Button>
        }
        width={680}
      >
        <Typography.Paragraph type="secondary">{t('keys.docs.keyHint')}</Typography.Paragraph>

        <Typography.Text strong>{t('keys.docs.baseUrlLabel')}</Typography.Text>
        <Typography.Paragraph copyable={{ text: baseUrl }}>
          <Typography.Text code>{baseUrl}</Typography.Text>
        </Typography.Paragraph>

        <Typography.Text strong>{t('keys.docs.anthropicLabel')}</Typography.Text>
        <Typography.Paragraph copyable={{ text: origin }}>
          <Typography.Text code>{origin}</Typography.Text>
        </Typography.Paragraph>

        <Typography.Text strong>{t('keys.docs.authLabel')}</Typography.Text>
        <Typography.Paragraph>
          <Typography.Text code>Authorization: Bearer sk-xxxxxxxx</Typography.Text>{' '}
          <Typography.Text type="secondary">/ x-api-key: sk-xxxxxxxx</Typography.Text>
        </Typography.Paragraph>

        <Typography.Text strong>{t('keys.docs.endpointsLabel')}</Typography.Text>
        <ul style={{ margin: '6px 0 14px', paddingLeft: 20 }}>
          <li>
            <Typography.Text code>POST /v1/chat/completions</Typography.Text>
          </li>
          <li>
            <Typography.Text code>POST /v1/messages</Typography.Text>{' '}
            <Typography.Text type="secondary">Anthropic</Typography.Text>
          </li>
          <li>
            <Typography.Text code>POST /v1/embeddings</Typography.Text>
          </li>
          <li>
            <Typography.Text code>POST /v1/images/generations</Typography.Text>
          </li>
          <li>
            <Typography.Text code>GET /v1/models</Typography.Text>
          </li>
        </ul>

        <Typography.Text strong>{t('keys.docs.exampleLabel')}</Typography.Text>
        <Typography.Paragraph copyable={{ text: curlExample }}>
          <pre
            style={{
              margin: 0,
              marginTop: 6,
              background: 'var(--ink)',
              border: '1px solid var(--ink-border)',
              color: 'var(--ink-text)',
              borderRadius: 6,
              padding: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12.5,
            }}
          >
            {curlExample}
          </pre>
        </Typography.Paragraph>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('keys.docs.sdkNote')}
        </Typography.Paragraph>
      </Modal>

      <Modal
        title={t('keys.createdModal.title')}
        open={!!created}
        onCancel={closeCreated}
        footer={[
          <Button key="close" type="primary" onClick={closeCreated}>
            {t('keys.createdModal.saved')}
          </Button>,
        ]}
      >
        <Typography.Paragraph type="warning">{t('keys.createdModal.warning')}</Typography.Paragraph>
        <Typography.Paragraph>
          <Typography.Text strong>{t('keys.docs.baseUrlLabel')}</Typography.Text>
          <br />
          <Typography.Text code copyable={{ text: baseUrl }}>
            {baseUrl}
          </Typography.Text>
        </Typography.Paragraph>
        <Space.Compact style={{ width: '100%' }}>
          <Input readOnly value={created?.plaintext} />
          <Button type="primary" icon={<CopyOutlined />} onClick={() => copy(created!.plaintext)}>
            {t('common.copy')}
          </Button>
        </Space.Compact>
        <Space style={{ marginTop: 12 }}>
          <Button
            icon={<ApiOutlined />}
            loading={testing}
            disabled={!created?.plaintext}
            onClick={runConnectivityTest}
          >
            {t('keys.createdModal.test')}
          </Button>
          {testResult?.ok ? (
            <Typography.Text type="success">
              {t('keys.createdModal.testOk', {
                count: testResult.modelCount,
                ms: testResult.latencyMs,
              })}
            </Typography.Text>
          ) : null}
          {testResult && !testResult.ok ? (
            <Typography.Text type="danger">
              {t('keys.createdModal.testFail', { detail: testResult.detail })}
            </Typography.Text>
          ) : null}
        </Space>
      </Modal>

      <Modal
        title={t('keys.testModal.title', { name: probeKey?.name ?? '' })}
        open={!!probeKey}
        onCancel={closeProbe}
        footer={null}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">{t('keys.testModal.help')}</Typography.Paragraph>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            showSearch
            loading={probeModelsQ.isLoading}
            value={probeModel}
            onChange={setProbeModel}
            placeholder={t('keys.testModal.model')}
            options={(probeModelsQ.data ?? []).map((m) => ({ value: m, label: m }))}
          />
          <Button
            type="primary"
            icon={<ApiOutlined />}
            loading={probeMut.isPending}
            disabled={!probeModel}
            onClick={() => {
              setProbeResult(null);
              probeMut.mutate();
            }}
          >
            {t('keys.testModal.run')}
          </Button>
          {probeModelsQ.isSuccess && (probeModelsQ.data?.length ?? 0) === 0 ? (
            <Typography.Text type="warning">{t('keys.testModal.noModel')}</Typography.Text>
          ) : null}
          {probeMut.isError ? (
            <Alert type="error" showIcon message={errorMessage(probeMut.error)} />
          ) : null}
          {probeResult?.ok ? (
            <Alert
              type="success"
              showIcon
              message={t('keys.testModal.ok')}
              description={t('keys.testModal.okDesc', {
                channel: probeResult.channel?.name ?? '-',
                model: probeResult.upstreamModel ?? probeResult.model ?? '-',
                latency: probeResult.latencyMs ?? 0,
              })}
            />
          ) : null}
          {probeResult && !probeResult.ok ? (
            <Alert
              type="error"
              showIcon
              message={t('keys.testModal.fail')}
              description={
                probeResult.message ??
                ([probeResult.status ? `HTTP ${probeResult.status}` : '', probeResult.error ?? '']
                  .filter(Boolean)
                  .join(' · ') ||
                  '-')
              }
            />
          ) : null}
        </Space>
      </Modal>
    </Card>
  );
}
