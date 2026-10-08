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
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { agentApi, billingApi, withdrawalsApi } from '../api/endpoints';
import { formatCredits, formatDateTime, fromCredits } from '../utils/format';
import QueryError from '../components/QueryError';
import type { AgentMember, BalanceTransaction, Withdrawal } from '../api/types';

export default function AgentPage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [rechargeTarget, setRechargeTarget] = useState<AgentMember | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [rechargeForm] = Form.useForm();
  const [withdrawForm] = Form.useForm();

  const {
    data: overview,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['agent', 'overview'],
    queryFn: ({ signal }) => agentApi.overview(signal),
  });
  const {
    data: members,
    isLoading: mLoading,
    isError: mErr,
    refetch: mRefetch,
  } = useQuery({
    queryKey: ['agent', 'members'],
    queryFn: ({ signal }) => agentApi.members(signal),
  });
  const {
    data: commissions,
    isLoading: cLoading,
    isError: cErr,
    refetch: cRefetch,
  } = useQuery({
    queryKey: ['agent', 'commissions'],
    queryFn: ({ signal }) => billingApi.transactions(1, 50, 'COMMISSION', signal),
  });
  const {
    data: withdrawals,
    isLoading: wLoading,
    isError: wErr,
    refetch: wRefetch,
  } = useQuery({
    queryKey: ['agent', 'withdrawals'],
    queryFn: ({ signal }) => withdrawalsApi.mine(signal),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['agent'] });
    qc.invalidateQueries({ queryKey: ['billing'] });
  };

  const createMut = useMutation({
    mutationFn: (v: { email: string; username: string; password: string }) =>
      agentApi.createMember(v),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      createForm.resetFields();
      message.success(t('agent.member.createSuccess'));
    },
  });

  const rechargeMut = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      agentApi.rechargeMember(id, fromCredits(amount)),
    onSuccess: () => {
      invalidate();
      setRechargeTarget(null);
      rechargeForm.resetFields();
      message.success(t('agent.recharge.success'));
    },
  });

  const withdrawMut = useMutation({
    mutationFn: (amount: number) => withdrawalsApi.create(fromCredits(amount)),
    onSuccess: () => {
      invalidate();
      setWithdrawOpen(false);
      withdrawForm.resetFields();
      message.success(t('agent.withdraw.success'));
    },
  });

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <QueryError show={isError} onRetry={refetch} />

      <Card
        title={t('agent.overview.title')}
        loading={isLoading}
        extra={
          <Space>
            <Button onClick={() => setWithdrawOpen(true)}>{t('agent.withdraw.button')}</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t('agent.member.createBtn')}
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {t('agent.overview.desc')}
        </Typography.Paragraph>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic
              title={t('agent.overview.balance')}
              value={formatCredits(overview?.balance ?? 0)}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title={t('agent.overview.commissionTotal')}
              value={formatCredits(overview?.commissionTotal ?? 0)}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title={t('agent.overview.memberCount')} value={overview?.memberCount ?? 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title={t('agent.overview.membersUsage30d')}
              value={formatCredits(overview?.membersUsage30d?.cost ?? 0)}
            />
          </Col>
        </Row>
        <Space style={{ marginTop: 12 }} size={16}>
          <span>
            {t('agent.overview.rebateRatio')}
            {overview?.rebateRate != null
              ? `${(overview.rebateRate * 100).toFixed(1)}%`
              : t('agent.overview.notSet')}
          </span>
          <span>
            {t('agent.overview.multiplierLabel')}
            {overview?.priceMultiplier != null ? `×${overview.priceMultiplier}` : '×1'}
          </span>
        </Space>
      </Card>

      <Card title={t('agent.member.title')} size="small">
        <QueryError show={mErr} onRetry={mRefetch} />
        <Table<AgentMember>
          rowKey="id"
          size="small"
          loading={mLoading}
          dataSource={members ?? []}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: t('agent.member.username'), dataIndex: 'username' },
            { title: t('agent.member.email'), dataIndex: 'email' },
            {
              title: t('common.status'),
              dataIndex: 'status',
              width: 90,
              render: (v: string) =>
                v === 'ACTIVE' ? (
                  <Tag color="green">{t('agent.member.statusActive')}</Tag>
                ) : (
                  <Tag color="red">{t('agent.member.statusBanned')}</Tag>
                ),
            },
            {
              title: t('agent.member.balance'),
              dataIndex: 'balance',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
            {
              title: t('agent.member.multiplier'),
              dataIndex: 'priceMultiplier',
              width: 80,
              render: (v: number | null) => (v != null ? `×${v}` : '×1'),
            },
            {
              title: t('agent.member.requests30d'),
              render: (_, r) => r.usage30d.requests,
              width: 100,
            },
            {
              title: t('agent.member.tokens30d'),
              render: (_, r) => r.usage30d.tokens,
              width: 120,
            },
            {
              title: t('agent.member.cost30d'),
              width: 130,
              render: (_, r) => formatCredits(r.usage30d.cost),
            },
            {
              title: t('common.action'),
              fixed: 'right',
              width: 90,
              render: (_, r) => (
                <Button size="small" onClick={() => setRechargeTarget(r)}>
                  {t('agent.member.rechargeBtn')}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card title={t('agent.commission.title')} size="small">
        <QueryError show={cErr} onRetry={cRefetch} />
        <Table<BalanceTransaction>
          rowKey="id"
          size="small"
          loading={cLoading}
          dataSource={commissions?.items ?? []}
          pagination={false}
          columns={[
            {
              title: t('common.time'),
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => formatDateTime(v),
            },
            {
              title: t('agent.commission.amount'),
              dataIndex: 'amount',
              width: 140,
              render: (v: string) => (
                <Typography.Text type="success">{formatCredits(v)}</Typography.Text>
              ),
            },
            {
              title: t('agent.commission.description'),
              dataIndex: 'description',
              render: (v) => v ?? '-',
            },
          ]}
        />
      </Card>

      <Modal
        title={t('agent.member.createModal.title')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={(v) => createMut.mutate(v)}
          requiredMark={false}
        >
          <Form.Item
            name="email"
            label={t('agent.member.email')}
            rules={[{ required: true, type: 'email' }]}
          >
            <Input placeholder="member@example.com" />
          </Form.Item>
          <Form.Item
            name="username"
            label={t('agent.member.username')}
            rules={[
              { required: true, min: 3 },
              {
                pattern: /^[a-zA-Z0-9_]+$/,
                message: t('agent.member.createModal.usernamePattern'),
              },
            ]}
          >
            <Input placeholder="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('agent.member.createModal.passwordLabel')}
            rules={[
              { required: true, min: 8, message: t('agent.member.createModal.passwordMin') },
              {
                pattern: /(?=.*[A-Za-z])(?=.*\d)/,
                message: t('agent.member.createModal.passwordPattern'),
              },
            ]}
          >
            <Input.Password placeholder={t('agent.member.createModal.passwordPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('agent.recharge.modalTitle', { username: rechargeTarget?.username ?? '' })}
        open={!!rechargeTarget}
        onCancel={() => setRechargeTarget(null)}
        onOk={() => rechargeForm.submit()}
        confirmLoading={rechargeMut.isPending}
        destroyOnClose
      >
        <Form
          form={rechargeForm}
          layout="vertical"
          onFinish={(v) =>
            rechargeTarget && rechargeMut.mutate({ id: rechargeTarget.id, amount: v.amount })
          }
          requiredMark={false}
        >
          <Form.Item
            name="amount"
            label={t('agent.recharge.amountLabel')}
            rules={[{ required: true, message: t('agent.form.enterCredits') }]}
          >
            <InputNumber min={1} step={100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Card title={t('agent.withdraw.recordsTitle')} size="small">
        <QueryError show={wErr} onRetry={wRefetch} />
        <Table<Withdrawal>
          rowKey="id"
          size="small"
          loading={wLoading}
          dataSource={withdrawals ?? []}
          pagination={false}
          columns={[
            {
              title: t('common.time'),
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => formatDateTime(v),
            },
            {
              title: t('common.amount'),
              dataIndex: 'amount',
              width: 130,
              render: (v: string) => formatCredits(v),
            },
            {
              title: t('common.status'),
              dataIndex: 'status',
              width: 100,
              render: (v: string) =>
                v === 'APPROVED' ? (
                  <Tag color="green">{t('common.approved')}</Tag>
                ) : v === 'REJECTED' ? (
                  <Tag color="red">{t('common.rejected')}</Tag>
                ) : (
                  <Tag color="orange">{t('common.pending')}</Tag>
                ),
            },
            {
              title: t('common.remark'),
              dataIndex: 'note',
              render: (v) => v ?? '-',
            },
          ]}
        />
      </Card>

      <Modal
        title={t('agent.withdraw.modalTitle')}
        open={withdrawOpen}
        onCancel={() => setWithdrawOpen(false)}
        onOk={() => withdrawForm.submit()}
        confirmLoading={withdrawMut.isPending}
        destroyOnClose
      >
        <Form
          form={withdrawForm}
          layout="vertical"
          onFinish={(v) => withdrawMut.mutate(v.amount)}
          requiredMark={false}
        >
          <Form.Item
            name="amount"
            label={t('agent.withdraw.amountLabel')}
            rules={[{ required: true, message: t('agent.form.enterCredits') }]}
          >
            <InputNumber min={1} step={100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
