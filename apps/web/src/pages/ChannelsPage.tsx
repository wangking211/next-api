import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { channelsApi, groupsApi, modelsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { usePageClamp } from '../hooks/usePageClamp';
import { usePagination } from '../hooks/usePagination';
import QueryError from '../components/QueryError';
import type { ChannelInfo, ChannelTestResult } from '../api/types';
import { PROVIDERS, type Filters, type PriceRow } from './channels/constants';
import { PricingTable } from './channels/PricingTable';
import { TestResults } from './channels/TestResults';
import { ChannelFilterForm } from './channels/ChannelFilterForm';
import { buildChannelColumns } from './channels/ChannelTableColumns';

export default function ChannelsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelInfo | null>(null);
  const [form] = Form.useForm();

  const [filters, setFilters] = useState<Filters>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    channel: ChannelInfo;
    result: ChannelTestResult;
  } | null>(null);
  const [modalTesting, setModalTesting] = useState(false);
  const [modalTest, setModalTest] = useState<ChannelTestResult | null>(null);
  const [pricing, setPricing] = useState<Record<string, PriceRow>>({});
  const [priceChannel, setPriceChannel] = useState<ChannelInfo | null>(null);
  const [testPick, setTestPick] = useState<ChannelInfo | null>(null);
  const [pickModels, setPickModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const selectedModels: string[] = Form.useWatch('models', form) ?? [];
  const ownerTypeValue = Form.useWatch('ownerType', form);

  // 归属=我的（BYOK）：上游费用用户自付、平台不扣费，隐藏「逐模型定价」（仅影响折算展示，无计费作用）
  const isByok = editing
    ? editing.ownerType === 'USER'
    : isAdmin
      ? ownerTypeValue !== 'PLATFORM'
      : true;

  const setP = (model: string, key: keyof PriceRow, value: number | string | null) =>
    setPricing((p) => ({ ...p, [model]: { ...p[model], [key]: value ?? undefined } }));

  const buildModelPrices = (models: string[]) =>
    models.map((m) => {
      const r = pricing[m] ?? {};
      const entry: Record<string, unknown> = { model: m };
      if (r.costDiscount != null) entry.costDiscount = r.costDiscount;
      if (r.priceDiscount != null) entry.priceDiscount = r.priceDiscount;
      if (r.qualityScore != null) entry.qualityScore = r.qualityScore;
      if (r.upstreamModelName) entry.upstreamModelName = r.upstreamModelName;
      if (r.costPerCall != null) entry.costPerCall = r.costPerCall;
      if (r.pricePerCall != null) entry.pricePerCall = r.pricePerCall;
      return entry;
    });

  const pg = usePagination();
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['channels', filters, pg.page, pg.pageSize],
    queryFn: ({ signal }) =>
      channelsApi.list({ ...filters, page: pg.page, pageSize: pg.pageSize }, signal),
    placeholderData: keepPreviousData,
  });

  usePageClamp(pg.page, pg.setPage, data);
  const { data: groups = [] } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => groupsApi.list(signal),
  });
  const { data: catalog = [] } = useQuery({
    queryKey: ['models'],
    queryFn: ({ signal }) => modelsApi.list(signal),
  });
  const { data: suggestions = [] } = useQuery({
    queryKey: ['model-suggestions'],
    queryFn: ({ signal }) => modelsApi.suggestions(signal),
  });

  const modelOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const m of catalog) map.set(m.name, { value: m.name, label: m.name });
    for (const m of suggestions) {
      if (!map.has(m.name)) {
        map.set(m.name, { value: m.name, label: `${m.name} · ${m.provider}` });
      }
    }
    return [...map.values()];
  }, [catalog, suggestions]);

  const providerModelNames = (provider: string) =>
    suggestions.filter((m) => m.provider === provider).map((m) => m.name);
  const allModelNames = suggestions.map((m) => m.name);

  const applyFilters = (next: Filters) => {
    setFilters(next);
    pg.reset();
  };

  const saveMut = useMutation({
    mutationFn: async (values: any) => {
      if (editing) {
        const payload = { ...values };
        if (!payload.apiKey) delete payload.apiKey;
        return channelsApi.update(editing.id, payload);
      }
      return channelsApi.create(values);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      setModalOpen(false);
      setEditing(null);
      setModalTest(null);
      form.resetFields();
      message.success(
        editing ? t('channels.message.channelUpdated') : t('channels.message.channelCreated'),
      );
    },
  });

  const openCreate = () => {
    setEditing(null);
    setModalTest(null);
    setPricing({});
    form.resetFields();
    form.setFieldValue('models', providerModelNames('openai'));
    setModalOpen(true);
  };

  const openEdit = (r: ChannelInfo) => {
    setEditing(r);
    setModalTest(null);
    form.resetFields();
    form.setFieldsValue({
      name: r.name,
      provider: r.provider,
      baseUrl: r.baseUrl,
      models: r.models,
      weight: r.weight,
      priority: r.priority,
      groups: r.groups?.map((g) => g.id) ?? [],
      upstreamGroup: r.upstreamGroup ?? undefined,
      dailyRequestLimit: r.dailyRequestLimit ?? undefined,
      dailyTokenLimit: r.dailyTokenLimit ?? undefined,
    });
    const p: Record<string, PriceRow> = {};
    for (const mp of r.modelPrices ?? []) {
      p[mp.model] = {
        costDiscount: mp.costDiscount ?? undefined,
        priceDiscount: mp.priceDiscount ?? mp.discount ?? undefined,
        qualityScore: mp.qualityScore ?? undefined,
        upstreamModelName: mp.upstreamModelName ?? undefined,
        costPerCall: mp.costPerCall ?? undefined,
        pricePerCall: mp.pricePerCall ?? undefined,
      };
    }
    setPricing(p);
    setModalOpen(true);
  };

  const testInModal = async () => {
    let values: any;
    try {
      values = await form.validateFields(['provider', 'baseUrl', 'models']);
    } catch {
      return;
    }
    const models: string[] = values.models ?? [];
    if (!models.length) {
      message.warning(t('channels.message.fillModels'));
      return;
    }
    setModalTesting(true);
    setModalTest(null);
    try {
      const result = await channelsApi.testConnection({
        provider: values.provider,
        baseUrl: values.baseUrl,
        models,
        apiKey: form.getFieldValue('apiKey') || undefined,
        channelId: editing?.id,
      });
      setModalTest(result);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setModalTesting(false);
    }
  };

  /** 调上游 /models 拉取全部可用模型，填入「支持的模型」；编辑态复用已存 Key */
  const fetchUpstreamModels = async () => {
    let v: any;
    try {
      v = await form.validateFields(
        editing ? ['provider', 'baseUrl'] : ['provider', 'baseUrl', 'apiKey'],
      );
    } catch {
      return; // 必填提示由表单展示
    }
    setFetchingModels(true);
    try {
      const r = await channelsApi.fetchModels({
        provider: v.provider,
        baseUrl: v.baseUrl,
        apiKey: v.apiKey || undefined,
        channelId: editing?.id,
      });
      form.setFieldValue('models', r.models);
      message.success(t('channels.message.upstreamModels', { count: r.models.length }));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      channelsApi.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success(t('channels.message.updated'));
    },
  });

  const removeMut = useMutation({
    mutationFn: channelsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success(t('channels.message.removed'));
    },
  });

  const openPricing = (r: ChannelInfo) => {
    const p: Record<string, PriceRow> = {};
    for (const mp of r.modelPrices ?? []) {
      p[mp.model] = {
        costDiscount: mp.costDiscount ?? undefined,
        priceDiscount: mp.priceDiscount ?? mp.discount ?? undefined,
        qualityScore: mp.qualityScore ?? undefined,
        upstreamModelName: mp.upstreamModelName ?? undefined,
        costPerCall: mp.costPerCall ?? undefined,
        pricePerCall: mp.pricePerCall ?? undefined,
      };
    }
    setPricing(p);
    setPriceChannel(r);
  };

  const savePricingMut = useMutation({
    mutationFn: (r: ChannelInfo) =>
      channelsApi.update(r.id, { modelPrices: buildModelPrices(r.models) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      setPriceChannel(null);
      message.success(t('channels.message.pricingSaved'));
    },
  });

  const runTest = async (r: ChannelInfo, models: string[]) => {
    setTestingId(r.id);
    try {
      const result = await channelsApi.test(r.id, models);
      setTestResult({ channel: r, result });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <Card
      title={isAdmin ? t('channels.page.upstreamTitle') : t('channels.page.byokTitle')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('channels.addChannel')}
        </Button>
      }
    >
      <ChannelFilterForm
        isAdmin={isAdmin}
        onSearch={applyFilters}
        onReset={() => {
          form.resetFields();
          applyFilters({});
        }}
      />

      <QueryError show={isError} onRetry={refetch} />

      <Table<ChannelInfo>
        rowKey="id"
        loading={isLoading || isFetching}
        dataSource={data?.items ?? []}
        scroll={{ x: 1200 }}
        pagination={pg.pagination(data?.total, {
          showTotal: (total) => t('channels.table.total', { count: total }),
        })}
        columns={buildChannelColumns({
          testingId,
          onTest: (r) => {
            setTestPick(r);
            setPickModels(r.models);
          },
          onPricing: openPricing,
          onEdit: openEdit,
          onToggle: (r) =>
            updateMut.mutate({
              id: r.id,
              status: r.status === 'ENABLED' ? 'DISABLED' : 'ENABLED',
            }),
          onRemove: (id) => removeMut.mutate(id),
        })}
      />

      <Modal
        title={
          editing ? t('channels.modal.editTitle', { name: editing.name }) : t('channels.addChannel')
        }
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          setModalTest(null);
        }}
        footer={[
          <Button key="test" loading={modalTesting} onClick={testInModal}>
            {t('channels.action.testConnection')}
          </Button>,
          <Button
            key="cancel"
            onClick={() => {
              setModalOpen(false);
              setEditing(null);
              setModalTest(null);
            }}
          >
            {t('common.cancel')}
          </Button>,
          <Button key="save" type="primary" loading={saveMut.isPending} onClick={() => form.submit()}>
            {t('common.save')}
          </Button>,
        ]}
        destroyOnClose
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) =>
            saveMut.mutate({
              ...v,
              // 清空输入框 = 清除限额（发 null，undefined 会被后端视为不修改）
              dailyRequestLimit: v.dailyRequestLimit ?? null,
              dailyTokenLimit: v.dailyTokenLimit ?? null,
              upstreamGroup: v.upstreamGroup || null,
              groups: v.groups ?? [],
              modelPrices: buildModelPrices(v.models ?? []),
            })
          }
          requiredMark={false}
          initialValues={{ provider: 'openai', weight: 1, priority: 0, ownerType: 'USER' }}
        >
          <Form.Item
            name="name"
            label={t('channels.form.name')}
            rules={[{ required: true, message: t('channels.form.nameRequired') }]}
          >
            <Input placeholder={t('channels.form.namePlaceholder')} />
          </Form.Item>
          {isAdmin && !editing && (
            <Form.Item name="ownerType" label={t('channels.form.ownerType')}>
              <Select
                options={[
                  { value: 'USER', label: t('channels.form.ownerUser') },
                  { value: 'PLATFORM', label: t('channels.form.ownerPlatform') },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="provider" label={t('channels.form.provider')} rules={[{ required: true }]}>
            <Select
              options={PROVIDERS.map((p) => ({ value: p.value, label: p.label() }))}
              onChange={(v) => {
                const p = PROVIDERS.find((x) => x.value === v);
                if (p) form.setFieldValue('baseUrl', p.placeholder);
                if (!editing) form.setFieldValue('models', providerModelNames(v));
              }}
            />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[{ required: true, message: t('channels.form.baseUrlRequired') }]}
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label={t('channels.form.apiKey')}
            rules={editing ? [] : [{ required: true, message: t('channels.form.apiKeyRequired') }]}
            extra={editing ? t('channels.form.apiKeyExtra') : undefined}
          >
            <Input.Password
              placeholder={
                editing ? t('channels.form.apiKeyPlaceholderKeep') : t('channels.form.apiKeyPlaceholderNew')
              }
            />
          </Form.Item>
          {isAdmin && (
            <Form.Item
              name="groups"
              label={t('channels.form.groups')}
              extra={t('channels.form.groupsExtra')}
            >
              <Select
                mode="multiple"
                allowClear
                placeholder={t('channels.form.groupsPlaceholder')}
                options={groups.map((g) => ({ value: g.id, label: g.displayName }))}
              />
            </Form.Item>
          )}
          <Form.Item
            name="upstreamGroup"
            label={t('channels.form.upstreamGroup')}
            extra={t('channels.form.upstreamGroupExtra')}
          >
            <Input placeholder={t('channels.form.upstreamGroupPlaceholder')} />
          </Form.Item>
          <Form.Item
            name="models"
            label={t('channels.form.models')}
            rules={[{ required: true, message: t('channels.form.modelsRequired') }]}
          >
            <Select
              mode="tags"
              placeholder={t('channels.form.modelsPlaceholder')}
              options={modelOptions}
              optionFilterProp="label"
            />
          </Form.Item>
          <div style={{ marginTop: -12, marginBottom: 12 }}>
            <Space size={8} wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('channels.form.quick')}
              </Typography.Text>
              <Button
                size="small"
                loading={fetchingModels}
                onClick={fetchUpstreamModels}
                title={t('channels.form.fetchModelsTooltip')}
              >
                {t('channels.form.fetchModels')}
              </Button>
              <Button
                size="small"
                onClick={() =>
                  form.setFieldValue('models', providerModelNames(form.getFieldValue('provider')))
                }
              >
                {t('channels.form.selectAllProvider')}
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', allModelNames)}>
                {t('channels.form.selectAllRecommended')}
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', [])}>
                {t('channels.form.clear')}
              </Button>
            </Space>
          </div>

          {selectedModels.length > 0 && !isByok && (
            <div style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('channels.form.pricingHint')}
              </Typography.Text>
              <PricingTable models={selectedModels} pricing={pricing} setP={setP} catalog={catalog} />
            </div>
          )}
          <Space size={16} wrap>
            <Form.Item name="priority" label={t('channels.form.priority')}>
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="weight" label={t('channels.form.weight')}>
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item
              name="dailyRequestLimit"
              label={t('channels.form.dailyRequestLimit')}
              tooltip={t('channels.form.dailyRequestLimitTip')}
            >
              <InputNumber min={0} placeholder={t('channels.form.unlimited')} style={{ width: 130 }} />
            </Form.Item>
            <Form.Item
              name="dailyTokenLimit"
              label={t('channels.form.dailyTokenLimit')}
              tooltip={t('channels.form.dailyTokenLimitTip')}
            >
              <InputNumber min={0} placeholder={t('channels.form.unlimited')} style={{ width: 150 }} />
            </Form.Item>
          </Space>
        </Form>

        {modalTest && (
          <div style={{ marginTop: 8 }}>
            <TestResults result={modalTest} />
          </div>
        )}
      </Modal>

      <Modal
        title={t('channels.testModal.title', { name: testPick?.name ?? '' })}
        open={!!testPick}
        onCancel={() => setTestPick(null)}
        okText={t('channels.testModal.start')}
        confirmLoading={!!testPick && testingId === testPick.id}
        onOk={() => {
          if (testPick && pickModels.length > 0) runTest(testPick, pickModels);
          setTestPick(null);
        }}
        width={560}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('channels.testModal.hint')}
        </Typography.Paragraph>
        <Space size={8} style={{ marginBottom: 8 }}>
          <Button size="small" onClick={() => setPickModels(testPick?.models ?? [])}>
            {t('channels.testModal.selectAll')}
          </Button>
          <Button size="small" onClick={() => setPickModels([])}>
            {t('channels.form.clear')}
          </Button>
          <Typography.Text type="secondary">
            {t('channels.testModal.selected', {
              selected: pickModels.length,
              total: testPick?.models.length ?? 0,
            })}
          </Typography.Text>
        </Space>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder={t('channels.testModal.modelPlaceholder')}
          value={pickModels}
          onChange={setPickModels}
          optionFilterProp="label"
          options={(testPick?.models ?? []).map((m) => ({ value: m, label: m }))}
        />
      </Modal>

      <Modal
        title={t('channels.testModal.title', { name: testResult?.channel.name ?? '' })}
        open={!!testResult}
        onCancel={() => setTestResult(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setTestResult(null)}>
            {t('common.close')}
          </Button>,
        ]}
      >
        {testResult && <TestResults result={testResult.result} />}
      </Modal>

      <Modal
        title={t('channels.pricing.title', { name: priceChannel?.name ?? '' })}
        open={!!priceChannel}
        onCancel={() => setPriceChannel(null)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setPriceChannel(null)}>
            {t('common.cancel')}
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={savePricingMut.isPending}
            onClick={() => priceChannel && savePricingMut.mutate(priceChannel)}
          >
            {t('common.save')}
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          {t('channels.pricing.hint')}
        </Typography.Paragraph>
        {priceChannel && (
          <PricingTable models={priceChannel.models} pricing={pricing} setP={setP} catalog={catalog} />
        )}
      </Modal>
    </Card>
  );
}
