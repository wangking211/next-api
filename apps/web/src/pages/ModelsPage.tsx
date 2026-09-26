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
  const [form] = Form.useForm();

  const { data: models = [], isLoading } = useQuery({
    queryKey: ['models'],
    queryFn: modelsApi.list,
  });

  const createMut = useMutation({
    mutationFn: modelsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      setOpen(false);
      form.resetFields();
      message.success('模型已创建');
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

  return (
    <Card
      title="模型目录与定价"
      extra={
        isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
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
        scroll={{ x: 800 }}
        columns={[
          { title: '模型名', dataIndex: 'name', render: (v: string) => <code>{v}</code> },
          { title: '显示名', dataIndex: 'displayName' },
          { title: '服务商', dataIndex: 'provider', render: (v: string) => <Tag>{v}</Tag> },
          {
            title: '输入价 ($/1M)',
            dataIndex: 'inputPrice',
            render: (v: string) => Number(v).toFixed(4),
          },
          {
            title: '输出价 ($/1M)',
            dataIndex: 'outputPrice',
            render: (v: string) => Number(v).toFixed(4),
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
                  width: 100,
                  render: (_: unknown, r: ModelInfo) => (
                    <Popconfirm title="确定删除该模型？" onConfirm={() => removeMut.mutate(r.id)}>
                      <Button size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        title="添加模型"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createMut.mutate(v)}
          requiredMark={false}
          initialValues={{ enabled: true, inputPrice: 0, outputPrice: 0 }}
        >
          <Form.Item
            name="name"
            label="模型名（上游实际名称）"
            rules={[{ required: true, message: '请输入模型名' }]}
          >
            <Input placeholder="gpt-4o-mini" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true }]}>
            <Input placeholder="GPT-4o mini" />
          </Form.Item>
          <Form.Item name="provider" label="服务商" rules={[{ required: true }]}>
            <Input placeholder="openai" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="inputPrice" label="输入价 ($/1M tokens)">
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="outputPrice" label="输出价 ($/1M tokens)">
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
