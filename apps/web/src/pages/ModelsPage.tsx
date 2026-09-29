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
  Switch,
  Table,
  Tag,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { modelsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { ModelInfo } from '../api/types';

export default function ModelsPage() {
  const { t } = useTranslation();
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
      message.success(editing ? t('models.msg.updated') : t('models.msg.created'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: modelsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['models'] });
      message.success(t('models.msg.deleted'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const classifyMut = useMutation({
    mutationFn: () => modelsApi.classifyOrigins(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['models'] });
      message.success(t('models.classify.success', { updated: r.updated, total: r.total }));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      enabled: true,
      origin: 'OVERSEAS',
      inputPrice: 0,
      outputPrice: 0,
      cacheReadPrice: 0,
      cacheWritePrice: 0,
    });
    setOpen(true);
  };

  const openEdit = (r: ModelInfo) => {
    setEditing(r);
    form.setFieldsValue({
      name: r.name,
      displayName: r.displayName,
      provider: r.provider,
      origin: r.origin,
      vendor: r.vendor ?? undefined,
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
      title={t('models.title')}
      extra={
        isAdmin && (
          <Space>
            <Popconfirm
              title={t('models.classify.confirm')}
              onConfirm={() => classifyMut.mutate()}
            >
              <Button loading={classifyMut.isPending} title={t('models.classify.tip')}>
                {t('models.classify.button')}
              </Button>
            </Popconfirm>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              {t('models.add')}
            </Button>
          </Space>
        )
      }
    >
      <Table<ModelInfo>
        rowKey="id"
        loading={isLoading}
        dataSource={models}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 1200 }}
        columns={[
          { title: t('models.column.name'), dataIndex: 'name', render: (v: string) => <code>{v}</code> },
          { title: t('models.column.displayName'), dataIndex: 'displayName' },
          { title: t('models.column.provider'), dataIndex: 'provider', render: (v: string) => <Tag>{v}</Tag> },
          {
            title: t('models.column.origin'),
            dataIndex: 'origin',
            width: 100,
            render: (v: string) =>
              v === 'DOMESTIC' ? (
                <Tag color="volcano">{t('models.origin.domestic')}</Tag>
              ) : (
                <Tag color="geekblue">{t('models.origin.overseas')}</Tag>
              ),
          },
          {
            title: t('models.column.vendor'),
            dataIndex: 'vendor',
            width: 120,
            render: (v: string | null) => v ?? '-',
          },
          {
            title: t('models.column.inputPrice'),
            dataIndex: 'inputPrice',
            render: (v: string) => Number(v).toFixed(4),
          },
          {
            title: t('models.column.outputPrice'),
            dataIndex: 'outputPrice',
            render: (v: string) => Number(v).toFixed(4),
          },
          {
            title: t('models.column.cacheRead'),
            dataIndex: 'cacheReadPrice',
            render: (v: string) => Number(v ?? 0).toFixed(4),
          },
          {
            title: t('models.column.cacheWrite'),
            dataIndex: 'cacheWritePrice',
            render: (v: string) => Number(v ?? 0).toFixed(4),
          },
          {
            title: t('models.column.enabled'),
            dataIndex: 'enabled',
            render: (v: boolean) => (v ? <Tag color="green">{t('common.yes')}</Tag> : <Tag>{t('common.no')}</Tag>),
          },
          ...(isAdmin
            ? [
                {
                  title: t('common.action'),
                  fixed: 'right' as const,
                  width: 150,
                  render: (_: unknown, r: ModelInfo) => (
                    <Space>
                      <Button size="small" onClick={() => openEdit(r)}>
                        {t('common.edit')}
                      </Button>
                      <Popconfirm title={t('models.confirmDelete')} onConfirm={() => removeMut.mutate(r.id)}>
                        <Button size="small" danger>
                          {t('common.delete')}
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
        title={editing ? t('models.editTitle', { name: editing.name }) : t('models.add')}
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
            label={t('models.form.nameLabel')}
            rules={[{ required: true, message: t('models.form.nameRequired') }]}
          >
            <Input placeholder="gpt-4o-mini" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="displayName" label={t('models.form.displayNameLabel')} rules={[{ required: true }]}>
            <Input placeholder="GPT-4o mini" />
          </Form.Item>
          <Form.Item name="provider" label={t('models.form.providerLabel')} rules={[{ required: true }]}>
            <Input placeholder="openai" />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="origin" label={t('models.form.originLabel')}>
              <Select
                style={{ width: 160 }}
                options={[
                  { value: 'DOMESTIC', label: t('models.origin.domestic') },
                  { value: 'OVERSEAS', label: t('models.origin.overseas') },
                ]}
              />
            </Form.Item>
            <Form.Item name="vendor" label={t('models.form.vendorLabel')}>
              <Input placeholder={t('models.form.vendorPlaceholder')} style={{ width: 200 }} />
            </Form.Item>
          </Space>
          <Space size={16} wrap>
            <Form.Item name="inputPrice" label={t('models.form.inputPriceLabel')}>
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="outputPrice" label={t('models.form.outputPriceLabel')}>
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="cacheReadPrice" label={t('models.form.cacheReadLabel')}>
              <InputNumber min={0} step={0.01} />
            </Form.Item>
            <Form.Item name="cacheWritePrice" label={t('models.form.cacheWriteLabel')}>
              <InputNumber min={0} step={0.01} />
            </Form.Item>
          </Space>
          <Form.Item name="enabled" label={t('models.form.enabledLabel')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
