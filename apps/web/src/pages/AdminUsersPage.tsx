import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
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
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', q, page, pageSize],
    queryFn: ({ signal }) => adminApi.users(q || undefined, page, pageSize, signal),
  });

  const mutate = useMutation({
    mutationFn: async (values: { amount: number; description?: string }) => {
      if (!target) return;
      if (mode === 'recharge') {
        await adminApi.recharge(target.id, values.amount, values.description);
      } else {
        await adminApi.adjust(target.id, values.amount, values.description);
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
            title: '余额',
            dataIndex: 'balance',
            render: (v: string) => `$${Number(v).toFixed(6)}`,
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
            label={mode === 'recharge' ? '充值金额 (USD)' : '调整金额 (USD，可负)'}
            rules={[{ required: true, message: '请输入金额' }]}
          >
            <InputNumber
              min={mode === 'recharge' ? 0.000001 : undefined}
              step={0.1}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="description" label="备注">
            <Input placeholder="例如：微信充值 / 活动赠送" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
