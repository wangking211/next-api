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
import { agentApi, billingApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, formatDateTime, fromCredits } from '../utils/format';
import type { AgentMember, BalanceTransaction } from '../api/types';

export default function AgentPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [rechargeTarget, setRechargeTarget] = useState<AgentMember | null>(null);
  const [createForm] = Form.useForm();
  const [rechargeForm] = Form.useForm();

  const { data: overview, isLoading } = useQuery({
    queryKey: ['agent', 'overview'],
    queryFn: ({ signal }) => agentApi.overview(signal),
  });
  const { data: members, isLoading: mLoading } = useQuery({
    queryKey: ['agent', 'members'],
    queryFn: ({ signal }) => agentApi.members(signal),
  });
  const { data: commissions } = useQuery({
    queryKey: ['agent', 'commissions'],
    queryFn: ({ signal }) => billingApi.transactions(1, 50, 'COMMISSION', signal),
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
      message.success('成员已创建');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const rechargeMut = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      agentApi.rechargeMember(id, fromCredits(amount)),
    onSuccess: () => {
      invalidate();
      setRechargeTarget(null);
      rechargeForm.resetFields();
      message.success('充值成功');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card
        title="代理中心"
        loading={isLoading}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增成员
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          名下用户消耗的积分按「返点比例」计入你的余额；你可新建成员并用余额为其充值。
        </Typography.Paragraph>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="我的余额" value={formatCredits(overview?.balance ?? 0)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="累计返点" value={formatCredits(overview?.commissionTotal ?? 0)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="名下成员" value={overview?.memberCount ?? 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="成员近 30 天消费"
              value={formatCredits(overview?.membersUsage30d?.cost ?? 0)}
            />
          </Col>
        </Row>
        <Space style={{ marginTop: 12 }} size={16}>
          <span>
            返点比例：
            {overview?.rebateRate != null
              ? `${(overview.rebateRate * 100).toFixed(1)}%`
              : '未设置'}
          </span>
          <span>
            我的用户倍率：
            {overview?.priceMultiplier != null ? `×${overview.priceMultiplier}` : '×1'}
          </span>
        </Space>
      </Card>

      <Card title="名下成员" size="small">
        <Table<AgentMember>
          rowKey="id"
          size="small"
          loading={mLoading}
          dataSource={members ?? []}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '用户名', dataIndex: 'username' },
            { title: '邮箱', dataIndex: 'email' },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (v: string) =>
                v === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag color="red">封禁</Tag>,
            },
            {
              title: '余额',
              dataIndex: 'balance',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
            {
              title: '倍率',
              dataIndex: 'priceMultiplier',
              width: 80,
              render: (v: number | null) => (v != null ? `×${v}` : '×1'),
            },
            { title: '近30天请求', render: (_, r) => r.usage30d.requests, width: 100 },
            { title: '近30天Token', render: (_, r) => r.usage30d.tokens, width: 120 },
            {
              title: '近30天消费',
              width: 130,
              render: (_, r) => formatCredits(r.usage30d.cost),
            },
            {
              title: '操作',
              fixed: 'right',
              width: 90,
              render: (_, r) => (
                <Button size="small" onClick={() => setRechargeTarget(r)}>
                  充值
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card title="返点流水" size="small">
        <Table<BalanceTransaction>
          rowKey="id"
          size="small"
          dataSource={commissions?.items ?? []}
          pagination={false}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => formatDateTime(v),
            },
            {
              title: '返点金额',
              dataIndex: 'amount',
              width: 140,
              render: (v: string) => (
                <Typography.Text type="success">{formatCredits(v)}</Typography.Text>
              ),
            },
            { title: '说明', dataIndex: 'description', render: (v) => v ?? '-' },
          ]}
        />
      </Card>

      <Modal
        title="新增成员"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={(v) => createMut.mutate(v)} requiredMark={false}>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input placeholder="member@example.com" />
          </Form.Item>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, min: 3 },
              { pattern: /^[a-zA-Z0-9_]+$/, message: '仅字母数字下划线' },
            ]}
          >
            <Input placeholder="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, min: 8, message: '至少 8 位' },
              { pattern: /(?=.*[A-Za-z])(?=.*\d)/, message: '需含字母和数字' },
            ]}
          >
            <Input.Password placeholder="至少 8 位，含字母和数字" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`为成员充值 - ${rechargeTarget?.username ?? ''}`}
        open={!!rechargeTarget}
        onCancel={() => setRechargeTarget(null)}
        onOk={() => rechargeForm.submit()}
        confirmLoading={rechargeMut.isPending}
        destroyOnClose
      >
        <Form
          form={rechargeForm}
          layout="vertical"
          onFinish={(v) => rechargeTarget && rechargeMut.mutate({ id: rechargeTarget.id, amount: v.amount })}
          requiredMark={false}
        >
          <Form.Item
            name="amount"
            label="充值积分（从我的余额转出）"
            rules={[{ required: true, message: '请输入积分' }]}
          >
            <InputNumber min={1} step={100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
