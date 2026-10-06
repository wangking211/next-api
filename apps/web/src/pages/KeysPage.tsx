import { useState } from 'react';
import {
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
import { PlusOutlined, CopyOutlined, ApiOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { keysApi, groupsApi } from '../api/endpoints';
import { testKeyConnectivity } from '../api/keyConnectivity';
import type { KeyConnectivityResult } from '../api/keyConnectivity';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatCredits } from '../utils/format';
import QueryError from '../components/QueryError';
import type { ApiKeyCreated, ApiKeyInfo, RoutingStrategy } from '../api/types';

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
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<KeyConnectivityResult | null>(null);
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

  const createMut = useMutation({
    mutationFn: keysApi.create,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      setCreateOpen(false);
      form.resetFields();
      setCreated(data);
    },
  });

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

  return (
    <Card
      title="API Key"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('keys.create')}
        </Button>
      }
    >
      <QueryError show={isError} onRetry={refetch} />

      <Table<ApiKeyInfo>
        rowKey="id"
        loading={isLoading}
        dataSource={keys}
        pagination={false}
        scroll={{ x: 1100 }}
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
                ? `${formatCredits(r.costUsed)} / ${formatCredits(r.costLimit)}`
                : `${formatCredits(r.costUsed)} / ∞`,
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
            width: 170,
            render: (_, r) => (
              <Space>
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
        title={t('keys.createModal.title')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createMut.mutate(v)}
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
        </Form>
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
    </Card>
  );
}
