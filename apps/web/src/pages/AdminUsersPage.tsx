import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { adminApi, groupsApi, usageApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, fromCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { AdminUser } from '../api/types';

type Mode = 'recharge' | 'adjust';

export default function AdminUsersPage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [mode, setMode] = useState<Mode>('recharge');
  const [usageUser, setUsageUser] = useState<AdminUser | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', q, page, pageSize],
    queryFn: ({ signal }) => adminApi.users(q || undefined, page, pageSize, signal),
  });

  usePageClamp(page, setPage, data);

  const { data: agents } = useQuery({
    queryKey: ['admin', 'agents'],
    queryFn: ({ signal }) => adminApi.users(undefined, 1, 100, signal, 'AGENT'),
  });

  const { data: groups = [] } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => groupsApi.list(signal),
  });

  const saveEditMut = useMutation({
    mutationFn: async (values: {
      role?: string;
      priceMultiplier?: number | null;
      agentId?: string | null;
      rebateRate?: number | null;
      groupId?: string | null;
    }) => {
      if (!editUser) return;
      await adminApi.updateUser(editUser.id, {
        role: values.role,
        priceMultiplier: values.priceMultiplier ?? null,
        agentId: values.agentId ?? null,
        rebateRate: values.rebateRate ?? null,
        groupId: values.groupId ?? null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setEditUser(null);
      editForm.resetFields();
      message.success(t('admin.users.saveSuccess'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openEdit = (u: AdminUser) => {
    setEditUser(u);
    editForm.setFieldsValue({
      role: u.role,
      priceMultiplier: u.priceMultiplier != null ? Number(u.priceMultiplier) : undefined,
      rebateRate: u.rebateRate != null ? Number(u.rebateRate) : undefined,
      agentId: u.agentId ?? undefined,
      groupId: u.groupId ?? undefined,
    });
  };

  const { data: uSummary } = useQuery({
    queryKey: ['admin', 'user-usage', 'summary', usageUser?.id],
    queryFn: ({ signal }) => usageApi.summary(30, undefined, signal, usageUser!.id),
    enabled: !!usageUser,
  });
  const { data: uAnalytics } = useQuery({
    queryKey: ['admin', 'user-usage', 'analytics', usageUser?.id],
    queryFn: ({ signal }) => usageApi.analytics(30, undefined, signal, usageUser!.id),
    enabled: !!usageUser,
  });

  const mutate = useMutation({
    mutationFn: async (values: { amount: number; description?: string }) => {
      if (!target) return;
      // 输入为积分，转换为内部 USD（1 USD = 100 积分）
      const usd = fromCredits(values.amount);
      if (mode === 'recharge') {
        await adminApi.recharge(target.id, usd, values.description);
      } else {
        await adminApi.adjust(target.id, usd, values.description);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['billing'] });
      setTarget(null);
      form.resetFields();
      message.success(mode === 'recharge' ? t('admin.users.rechargeSuccess') : t('admin.users.adjustSuccess'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openModal = (user: AdminUser, m: Mode) => {
    setTarget(user);
    setMode(m);
    form.resetFields();
  };

  return (
    <Card
      title={t('admin.users.title')}
      extra={
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('admin.users.searchPlaceholder')}
          style={{ width: 240 }}
          onPressEnter={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setPage(1);
          }}
        />
      }
    >
      <Table<AdminUser>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        scroll={{ x: 1000 }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        columns={[
          { title: t('admin.users.column.username'), dataIndex: 'username' },
          { title: t('admin.users.column.email'), dataIndex: 'email' },
          {
            title: t('admin.users.column.role'),
            dataIndex: 'role',
            render: (v: string) =>
              v === 'ADMIN' ? (
                <Tag color="gold">{t('admin.users.roleAdmin')}</Tag>
              ) : v === 'AGENT' ? (
                <Tag color="purple">{t('admin.users.roleAgent')}</Tag>
              ) : (
                <Tag>{t('common.user')}</Tag>
              ),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (v: string) =>
              v === 'ACTIVE' ? (
                <Tag color="green">{t('admin.users.statusActive')}</Tag>
              ) : (
                <Tag color="red">{t('admin.users.statusBanned')}</Tag>
              ),
          },
          {
            title: t('admin.users.column.balance'),
            dataIndex: 'balance',
            render: (v: string) => formatCredits(v),
          },
          {
            title: t('admin.users.column.multiplier'),
            render: (_, r) => {
              if (r.priceMultiplier != null)
                return t('admin.users.multiplierCustom', { value: Number(r.priceMultiplier) });
              if (r.agent?.priceMultiplier != null)
                return t('admin.users.multiplierAgent', { value: Number(r.agent.priceMultiplier) });
              return '×1';
            },
          },
          {
            title: t('admin.users.column.rebate'),
            render: (_, r) =>
              r.rebateRate != null ? `${(Number(r.rebateRate) * 100).toFixed(0)}%` : '-',
          },
          {
            title: t('admin.users.column.agent'),
            render: (_, r) => r.agent?.username ?? '-',
          },
          {
            title: t('admin.users.column.group'),
            render: (_, r) =>
              r.group ? <Tag color="cyan">{r.group.displayName}</Tag> : t('admin.users.groupNone'),
          },
          {
            title: t('admin.users.column.keyChannel'),
            render: (_, r) => `${r._count.apiKeys} / ${r._count.channels}`,
          },
          {
            title: t('common.action'),
            fixed: 'right',
            width: 240,
            render: (_, r) => (
              <Space>
                <Button size="small" type="primary" onClick={() => openModal(r, 'recharge')}>
                  {t('admin.users.recharge')}
                </Button>
                <Button size="small" onClick={() => openModal(r, 'adjust')}>
                  {t('admin.users.adjust')}
                </Button>
                <Button size="small" onClick={() => openEdit(r)}>
                  {t('common.edit')}
                </Button>
                <Button size="small" onClick={() => setUsageUser(r)}>
                  {t('admin.users.usage')}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`${mode === 'recharge' ? t('admin.users.recharge') : t('admin.users.adjustBalance')} - ${target?.username ?? ''}`}
        open={!!target}
        onCancel={() => setTarget(null)}
        onOk={() => form.submit()}
        confirmLoading={mutate.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => mutate.mutate(v)} requiredMark={false}>
          <Form.Item
            name="amount"
            label={mode === 'recharge' ? t('admin.users.rechargeAmount') : t('admin.users.adjustAmount')}
            rules={[{ required: true, message: t('admin.users.amountRequired') }]}
          >
            <InputNumber
              min={mode === 'recharge' ? 1 : undefined}
              max={100000000}
              step={100}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="description" label={t('common.remark')}>
            <Input placeholder={t('admin.users.remarkPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`${t('admin.users.usageTitle')} - ${usageUser?.username ?? ''}`}
        open={!!usageUser}
        onCancel={() => setUsageUser(null)}
        footer={[
          <Button key="close" onClick={() => setUsageUser(null)}>
            {t('common.close')}
          </Button>,
        ]}
        width={760}
      >
        {uSummary && (
          <Row gutter={16} style={{ marginBottom: 12 }}>
            <Col span={6}>
              <Statistic title={t('admin.users.statRequests')} value={uSummary.requests} />
            </Col>
            <Col span={6}>
              <Statistic title="Token" value={uSummary.totalTokens} />
            </Col>
            <Col span={6}>
              <Statistic title={t('admin.users.statCost')} value={formatCredits(uSummary.billedCost ?? 0)} />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('admin.users.statMargin')}
                value={formatCredits(uAnalytics?.totals?.margin ?? 0)}
                valueStyle={{
                  color: (uAnalytics?.totals?.margin ?? 0) >= 0 ? 'var(--ok)' : 'var(--err)',
                }}
              />
            </Col>
          </Row>
        )}
        <Table
          size="small"
          rowKey="model"
          pagination={false}
          loading={!uAnalytics}
          dataSource={uAnalytics?.byModel ?? []}
          columns={[
            { title: t('common.model'), dataIndex: 'model', ellipsis: true },
            { title: t('admin.users.statRequests'), dataIndex: 'requests', width: 80 },
            { title: 'Token', dataIndex: 'tokens', width: 110 },
            {
              title: t('admin.users.statCost'),
              dataIndex: 'billedCost',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
            {
              title: t('admin.users.statMargin'),
              dataIndex: 'margin',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
          ]}
        />
      </Modal>

      <Modal
        title={`${t('admin.users.editUser')} - ${editUser?.username ?? ''}`}
        open={!!editUser}
        onCancel={() => {
          setEditUser(null);
          editForm.resetFields();
        }}
        onOk={() => editForm.submit()}
        confirmLoading={saveEditMut.isPending}
        destroyOnClose
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) => saveEditMut.mutate(v)}
          requiredMark={false}
        >
          <Form.Item name="role" label={t('admin.users.column.role')}>
            <Select
              options={[
                { value: 'USER', label: t('common.user') },
                { value: 'AGENT', label: t('admin.users.roleAgentDistributor') },
                { value: 'ADMIN', label: t('admin.users.roleAdmin') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="agentId"
            label={t('admin.users.agentField')}
            extra={t('admin.users.agentExtra')}
          >
            <Select
              allowClear
              placeholder={t('admin.users.agentNone')}
              options={(agents?.items ?? []).map((a) => ({
                value: a.id,
                label: a.username,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="groupId"
            label={t('admin.users.groupField')}
            extra={t('admin.users.groupExtra')}
          >
            <Select
              allowClear
              placeholder={t('admin.users.groupNone')}
              options={groups.map((g) => ({ value: g.id, label: g.displayName }))}
            />
          </Form.Item>
          <Form.Item
            name="priceMultiplier"
            label={t('admin.users.multiplierLabel')}
            extra={t('admin.users.multiplierExtra')}
          >
            <InputNumber
              min={0}
              step={0.05}
              style={{ width: '100%' }}
              placeholder={t('admin.users.multiplierPlaceholder')}
            />
          </Form.Item>
          <Form.Item
            name="rebateRate"
            label={t('admin.users.rebateLabel')}
            extra={t('admin.users.rebateExtra')}
          >
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              placeholder={t('admin.users.rebatePlaceholder')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
