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
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { groupsApi, modelsApi } from '../api/endpoints';
import QueryError from '../components/QueryError';
import type { ModelGroup, ModelInfo, ModelOrigin } from '../api/types';

type OriginFilter = 'ALL' | ModelOrigin;

export default function GroupsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ModelGroup | null>(null);
  const [originFilter, setOriginFilter] = useState<OriginFilter>('ALL');
  const [form] = Form.useForm();
  const selectedModels: string[] = Form.useWatch('models', form) ?? [];

  const { data: groups = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => groupsApi.list(signal),
  });
  const { data: models = [] } = useQuery({
    queryKey: ['models'],
    queryFn: ({ signal }) => modelsApi.list(signal),
  });

  const originLabel = (o: ModelOrigin) =>
    t(o === 'DOMESTIC' ? 'models.origin.domestic' : 'models.origin.overseas');

  const saveMut = useMutation({
    mutationFn: (v: {
      name?: string;
      displayName: string;
      description?: string;
      ratio?: number | null;
      status: ModelGroup['status'];
      priority: number;
      isDefault: boolean;
      models: string[];
    }) => {
      const payload = {
        displayName: v.displayName,
        description: v.description ?? null,
        ratio: v.ratio ?? null,
        status: v.status,
        priority: v.priority ?? 0,
        isDefault: v.isDefault ?? false,
        models: v.models ?? [],
      };
      return editing
        ? groupsApi.update(editing.id, payload)
        : groupsApi.create({ name: v.name!, ...payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      setOpen(false);
      setEditing(null);
      form.resetFields();
      message.success(editing ? t('groups.msg.updated') : t('groups.msg.created'));
    },
  });

  const defaultMut = useMutation({
    mutationFn: (id: string) => groupsApi.update(id, { isDefault: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      message.success(t('groups.setDefaultSuccess'));
    },
  });

  const removeMut = useMutation({
    mutationFn: groupsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      message.success(t('groups.msg.deleted'));
    },
  });

  const openCreate = () => {
    setEditing(null);
    setOriginFilter('ALL');
    form.resetFields();
    form.setFieldsValue({ status: 'ENABLED', priority: 0, isDefault: false, models: [] });
    setOpen(true);
  };

  const openEdit = (r: ModelGroup) => {
    setEditing(r);
    setOriginFilter('ALL');
    form.setFieldsValue({
      name: r.name,
      displayName: r.displayName,
      description: r.description ?? undefined,
      ratio: r.ratio ?? undefined,
      status: r.status,
      priority: r.priority,
      isDefault: r.isDefault,
      models: r.models,
    });
    setOpen(true);
  };

  // 按产地筛选后的候选模型；已选但被筛掉的模型仍保留 label，避免回显原始值
  const originFiltered = originFilter === 'ALL' ? models : models.filter((m) => m.origin === originFilter);
  const modelMap = new Map<string, ModelInfo>();
  for (const m of originFiltered) modelMap.set(m.name, m);
  for (const name of selectedModels) {
    if (!modelMap.has(name)) {
      const m = models.find((x) => x.name === name);
      if (m) modelMap.set(name, m);
    }
  }
  const modelOptions = [...modelMap.values()].map((m) => ({
    value: m.name,
    label: `${m.name} · ${originLabel(m.origin)}`,
  }));

  const pickOrigin = (origin: ModelOrigin) =>
    models.filter((m) => m.origin === origin).map((m) => m.name);
  const addModels = (names: string[]) =>
    form.setFieldValue('models', [
      ...new Set([...(form.getFieldValue('models') ?? []), ...names]),
    ]);

  return (
    <Card
      title={t('groups.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('groups.add')}
        </Button>
      }
    >
      <QueryError show={isError} onRetry={refetch} />

      <Table<ModelGroup>
        rowKey="id"
        loading={isLoading}
        dataSource={groups}
        pagination={false}
        scroll={{ x: 1100 }}
        columns={[
          { title: t('groups.column.name'), dataIndex: 'name', render: (v: string) => <code>{v}</code> },
          { title: t('groups.column.displayName'), dataIndex: 'displayName' },
          {
            title: t('groups.column.ratio'),
            dataIndex: 'ratio',
            width: 90,
            render: (v: number | null) => (v != null ? `×${v}` : '-'),
          },
          {
            title: t('groups.column.models'),
            width: 150,
            render: (_, r) =>
              r.models.length ? (
                <Tooltip title={r.models.join(', ')}>
                  <Tag color="blue">{t('groups.models.count', { count: r.models.length })}</Tag>
                </Tooltip>
              ) : (
                <Tag>{t('groups.models.unlimited')}</Tag>
              ),
          },
          {
            title: t('groups.column.bindings'),
            width: 150,
            render: (_, r) =>
              `${r.counts.users} / ${r.counts.apiKeys} / ${r.counts.channels}`,
          },
          {
            title: t('groups.column.default'),
            width: 100,
            render: (_, r) =>
              r.isDefault ? <Tag color="gold">{t('groups.default.yes')}</Tag> : t('groups.default.no'),
          },
          {
            title: t('groups.column.status'),
            dataIndex: 'status',
            width: 100,
            render: (v: string) =>
              v === 'ENABLED' ? (
                <Tag color="green">{t('groups.status.enabled')}</Tag>
              ) : (
                <Tag color="default">{t('groups.status.disabled')}</Tag>
              ),
          },
          {
            title: t('common.action'),
            fixed: 'right',
            width: 260,
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => openEdit(r)}>
                  {t('common.edit')}
                </Button>
                {!r.isDefault && (
                  <Popconfirm
                    title={t('groups.setDefaultConfirm')}
                    onConfirm={() => defaultMut.mutate(r.id)}
                  >
                    <Button size="small">{t('groups.setDefault')}</Button>
                  </Popconfirm>
                )}
                <Popconfirm
                  title={t('groups.confirmDelete')}
                  onConfirm={() => removeMut.mutate(r.id)}
                  disabled={r.isDefault}
                >
                  <Button size="small" danger disabled={r.isDefault}>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? t('groups.editTitle', { name: editing.name }) : t('groups.add')}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={saveMut.isPending}
        destroyOnClose
        width={640}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          requiredMark={false}
        >
          <Form.Item
            name="name"
            label={t('groups.form.name')}
            rules={[
              { required: true, message: t('groups.form.nameRequired') },
              { pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/, message: t('groups.form.nameRule') },
            ]}
          >
            <Input placeholder={t('groups.form.namePlaceholder')} disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="displayName"
            label={t('groups.form.displayName')}
            rules={[{ required: true, message: t('groups.form.displayNameRequired') }]}
          >
            <Input placeholder={t('groups.form.displayNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('groups.form.description')}>
            <Input placeholder={t('groups.form.descriptionPlaceholder')} />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item
              name="ratio"
              label={t('groups.form.ratio')}
              extra={t('groups.form.ratioExtra')}
            >
              <InputNumber
                min={0}
                step={0.05}
                style={{ width: 160 }}
                placeholder={t('groups.form.ratioPlaceholder')}
              />
            </Form.Item>
            <Form.Item name="status" label={t('groups.form.status')}>
              <Select
                style={{ width: 140 }}
                options={[
                  { value: 'ENABLED', label: t('groups.status.enabled') },
                  { value: 'DISABLED', label: t('groups.status.disabled') },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="priority"
              label={t('groups.form.priority')}
              tooltip={t('groups.form.priorityExtra')}
            >
              <InputNumber min={0} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          <Form.Item
            name="isDefault"
            label={t('groups.form.isDefault')}
            extra={t('groups.form.isDefaultExtra')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item name="models" label={t('groups.visible.label')} extra={t('groups.visible.extra')}>
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('groups.visible.placeholder')}
              options={modelOptions}
              maxTagCount="responsive"
            />
          </Form.Item>
          <div style={{ marginTop: -8, marginBottom: 8 }}>
            <Space size={8} wrap>
              <Segmented
                size="small"
                value={originFilter}
                onChange={(v) => setOriginFilter(v as OriginFilter)}
                options={[
                  { label: t('groups.visible.all'), value: 'ALL' },
                  { label: t('groups.visible.domestic'), value: 'DOMESTIC' },
                  { label: t('groups.visible.overseas'), value: 'OVERSEAS' },
                ]}
              />
              <Button size="small" onClick={() => addModels(originFiltered.map((m) => m.name))}>
                {t('groups.visible.selectAll')}
              </Button>
              <Button size="small" onClick={() => addModels(pickOrigin('DOMESTIC'))}>
                {t('groups.visible.selectDomestic')}
              </Button>
              <Button size="small" onClick={() => addModels(pickOrigin('OVERSEAS'))}>
                {t('groups.visible.selectOverseas')}
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', [])}>
                {t('groups.visible.clear')}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('groups.visible.selected', { count: selectedModels.length })}
              </Typography.Text>
            </Space>
          </div>
        </Form>
      </Modal>
    </Card>
  );
}
