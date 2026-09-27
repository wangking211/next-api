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
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, usageApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, fromCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { AdminUser } from '../api/types';

type Mode = 'recharge' | 'adjust';

export default function AdminUsersPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [mode, setMode] = useState<Mode>('recharge');
  const [usageUser, setUsageUser] = useState<AdminUser | null>(null);
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', q, page, pageSize],
    queryFn: ({ signal }) => adminApi.users(q || undefined, page, pageSize, signal),
  });

  usePageClamp(page, setPage, data);

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
      message.success(mode === 'recharge' ? '充值成功' : '调整成功');
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
      title="用户管理"
      extra={
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索邮箱或用户名"
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
        scroll={{ x: 900 }}
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
          { title: '用户名', dataIndex: 'username' },
          { title: '邮箱', dataIndex: 'email' },
          {
            title: '角色',
            dataIndex: 'role',
            render: (v: string) =>
              v === 'ADMIN' ? <Tag color="gold">管理员</Tag> : <Tag>用户</Tag>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v: string) =>
              v === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag color="red">封禁</Tag>,
          },
          {
            title: '余额 (积分)',
            dataIndex: 'balance',
            render: (v: string) => formatCredits(v),
          },
          {
            title: 'Key / 渠道',
            render: (_, r) => `${r._count.apiKeys} / ${r._count.channels}`,
          },
          {
            title: '操作',
            fixed: 'right',
            width: 180,
            render: (_, r) => (
              <Space>
                <Button size="small" type="primary" onClick={() => openModal(r, 'recharge')}>
                  充值
                </Button>
                <Button size="small" onClick={() => openModal(r, 'adjust')}>
                  调整
                </Button>
                <Button size="small" onClick={() => setUsageUser(r)}>
                  用量
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`${mode === 'recharge' ? '充值' : '调整余额'} - ${target?.username ?? ''}`}
        open={!!target}
        onCancel={() => setTarget(null)}
        onOk={() => form.submit()}
        confirmLoading={mutate.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => mutate.mutate(v)} requiredMark={false}>
          <Form.Item
            name="amount"
            label={mode === 'recharge' ? '充值积分' : '调整积分（可负）'}
            rules={[{ required: true, message: '请输入金额' }]}
          >
            <InputNumber
              min={mode === 'recharge' ? 1 : undefined}
              max={100000000}
              step={100}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="description" label="备注">
            <Input placeholder="例如：微信充值 / 活动赠送" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`用量（近 30 天）- ${usageUser?.username ?? ''}`}
        open={!!usageUser}
        onCancel={() => setUsageUser(null)}
        footer={[
          <Button key="close" onClick={() => setUsageUser(null)}>
            关闭
          </Button>,
        ]}
        width={760}
      >
        {uSummary && (
          <Row gutter={16} style={{ marginBottom: 12 }}>
            <Col span={6}>
              <Statistic title="请求" value={uSummary.requests} />
            </Col>
            <Col span={6}>
              <Statistic title="Token" value={uSummary.totalTokens} />
            </Col>
            <Col span={6}>
              <Statistic title="费用" value={formatCredits(uSummary.cost)} />
            </Col>
            <Col span={6}>
              <Statistic
                title="毛利"
                value={formatCredits(uAnalytics?.totals?.margin ?? 0)}
                valueStyle={{
                  color: (uAnalytics?.totals?.margin ?? 0) >= 0 ? '#3f8600' : '#cf1322',
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
            { title: '模型', dataIndex: 'model', ellipsis: true },
            { title: '请求', dataIndex: 'requests', width: 80 },
            { title: 'Token', dataIndex: 'tokens', width: 110 },
            {
              title: '费用',
              dataIndex: 'cost',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
            {
              title: '毛利',
              dataIndex: 'margin',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
          ]}
        />
      </Modal>
    </Card>
  );
}
