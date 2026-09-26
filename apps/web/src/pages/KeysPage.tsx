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
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keysApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import type { ApiKeyCreated, ApiKeyInfo } from '../api/types';

export default function KeysPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [form] = Form.useForm();

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ['keys'],
    queryFn: keysApi.list,
  });

  const createMut = useMutation({
    mutationFn: keysApi.create,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      setCreateOpen(false);
      form.resetFields();
      setCreated(data);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      keysApi.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      message.success('已更新');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: keysApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['keys'] });
      message.success('已删除');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.warning('复制失败，请手动选择复制');
    }
  };

  return (
    <Card
      title="API Key"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建 Key
        </Button>
      }
    >
      <Table<ApiKeyInfo>
        rowKey="id"
        loading={isLoading}
        dataSource={keys}
        pagination={false}
        scroll={{ x: 900 }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: 'Key', dataIndex: 'keyPrefix', render: (v: string) => <code>{v}</code> },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v: string) => {
              const color = v === 'ACTIVE' ? 'green' : v === 'DISABLED' ? 'orange' : 'red';
              return <Tag color={color}>{v}</Tag>;
            },
          },
          {
            title: 'Token 用量',
            render: (_, r) => (r.quotaLimit ? `${r.quotaUsed} / ${r.quotaLimit}` : `${r.quotaUsed} / ∞`),
          },
          {
            title: '费用用量',
            render: (_, r) =>
              r.costLimit
                ? `$${Number(r.costUsed).toFixed(4)} / $${Number(r.costLimit).toFixed(4)}`
                : `$${Number(r.costUsed).toFixed(4)} / ∞`,
          },
          {
            title: 'RPM',
            dataIndex: 'rpmLimit',
            render: (v: number | null) => (v ?? '∞'),
          },
          {
            title: '最近使用',
            dataIndex: 'lastUsedAt',
            render: (v: string | null) => (v ? new Date(v).toLocaleString() : '从未'),
          },
          {
            title: '操作',
            fixed: 'right',
            width: 170,
            render: (_, r) => (
              <Space>
                {r.status === 'ACTIVE' ? (
                  <Button size="small" onClick={() => updateMut.mutate({ id: r.id, status: 'DISABLED' })}>
                    停用
                  </Button>
                ) : (
                  <Button size="small" onClick={() => updateMut.mutate({ id: r.id, status: 'ACTIVE' })}>
                    启用
                  </Button>
                )}
                <Popconfirm
                  title="确定删除该 Key？"
                  onConfirm={() => removeMut.mutate(r.id)}
                >
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
        title="创建 API Key"
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
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：生产环境" />
          </Form.Item>
          <Form.Item name="quotaLimit" label="Token 额度（留空不限）">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="例如 1000000" />
          </Form.Item>
          <Form.Item name="costLimit" label="费用额度 USD（留空不限）">
            <InputNumber min={0} step={0.1} style={{ width: '100%' }} placeholder="例如 10" />
          </Form.Item>
          <Form.Item name="rpmLimit" label="每分钟请求上限 RPM（留空不限）">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="例如 60" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Key 创建成功"
        open={!!created}
        onCancel={() => setCreated(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setCreated(null)}>
            我已保存
          </Button>,
        ]}
      >
        <Typography.Paragraph type="warning">
          {created?.warning}
        </Typography.Paragraph>
        <Space.Compact style={{ width: '100%' }}>
          <Input readOnly value={created?.plaintext} />
          <Tooltip title="复制">
            <Button icon={<CopyOutlined />} onClick={() => copy(created!.plaintext)} />
          </Tooltip>
        </Space.Compact>
      </Modal>
    </Card>
  );
}
