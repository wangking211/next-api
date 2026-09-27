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
  Switch,
  Table,
  Tag,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { ModelInfo } from '../api/types';

export default function ModelsPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ModelInfo | null>(null);
  const [form] = Form.useForm();

  const { data: models = [], isLoading } = useQuery({
    queryKey: ['models'],
    queryFn: ({ signal }) => modelsApi.list(signal),
  });

  const saveMut = useMutation({
    mutationFn: (v: any) =>
      editing ? modelsApi.update(editing.id, v) : modelsApi.create(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      setOpen(false);
      setEditing(null);
      form.resetFields();
      message.success(editing ? '模型已更新' : '模型已创建');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: modelsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      message.success('已删除');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ enabled: true, inputPrice: 0, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0 });
    setOpen(true);
  };

  const openEdit = (r: ModelInfo) => {
    setEditing(r);
    form.setFieldsValue({
      name: r.name,
      displayName: r.displayName,
      provider: r.provider,
      inputPrice: Number(r.inputPrice),
      outputPrice: Number(r.outputPrice),
      cacheReadPrice: Number(r.cacheReadPrice ?? 0),
      cacheWritePrice: Number(r.cacheWritePrice ?? 0),
      enabled: r.enabled,
    });
    setOpen(true);
  };

  return (
    <Card
      title="模型目录与官方价"
      extra={
        isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            添加模型
          </Button>
        )
      }
    >
      <Table<ModelInfo>
        rowKey="id"
        loading={isLoading}
        dataSource={models}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 1000 }}
        columns={[
          { title: '模型名', dataIndex: 'name', render: (v: string) => <code>{v}</code> },
          { title: '显示名', dataIndex: 'displayName' },
          { title: '服务商', dataIndex: 'provider', render: (v: string) => <Tag>{v}</Tag> },
          {
            title: '输入官方价 ($/1M)',
            dataIndex: 'inputPrice',
            render: (v: string) => Number(v).toFixed(4),
          },
          {
            title: '输出官方价 ($/1M)',
            dataIndex: 'outputPrice',
            render: (v: string) => Number(v).toFixed(4),
          },
          {
            title: '缓存读 ($/1M)',
            dataIndex: 'cacheReadPrice',
            render: (v: string) => Number(v ?? 0).toFixed(4),
          },
          {
            title: '缓存写 ($/1M)',
            dataIndex: 'cacheWritePrice',
            render: (v: string) => Number(v ?? 0).toFixed(4),
          },
          {
            title: '启用',
            dataIndex: 'enabled',
            render: (v: boolean) => (v ? <Tag color="green">是</Tag> : <Tag>否</Tag>),
          },
          ...(isAdmin
            ? [
                {
                  title: '操作',
                  fixed: 'right' as const,
                  width: 150,
                  render: (_: unknown, r: ModelInfo) => (
                    <Space>
                      <Button size="small" onClick={() => openEdit(r)}>
                        编辑
                      </Button>
                      <Popconfirm title="确定删除该模型？" onConfirm={() => removeMut.mutate(r.id)}>
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        title={editing ? `编辑模型：${editing.name}` : '添加模型'}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={saveMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          requiredMark={false}
        >
          <Form.Item
            name="name"
            label="模型名（上游实际名称）"
            rules={[{ required: true, message: '请输入模型名' }]}
          >
            <Input placeholder="gpt-4o-mini" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true }]}>
            <Input placeholder="GPT-4o mini" />
          </Form.Item>
          <Form.Item name="provider" label="服务商" rules={[{ required: true }]}>
            <Input placeholder="openai" />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="inputPrice" label="输入官方价 ($/1M)">
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="outputPrice" label="输出官方价 ($/1M)">
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="cacheReadPrice" label="缓存读 ($/1M)">
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="cacheWritePrice" label="缓存写 ($/1M)">
              <InputNumber min={0} step={0.01} />
            </Form.Item>
          </Space>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
