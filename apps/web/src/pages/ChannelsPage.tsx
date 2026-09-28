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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { channelsApi, modelsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { usePageClamp } from '../hooks/usePageClamp';
import type { ChannelInfo, ChannelTestResult } from '../api/types';
import { PROVIDERS, type Filters, type PriceRow } from './channels/constants';
import { PricingTable } from './channels/PricingTable';
import { TestResults } from './channels/TestResults';
import { ChannelFilterForm } from './channels/ChannelFilterForm';
import { buildChannelColumns } from './channels/ChannelTableColumns';

export default function ChannelsPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelInfo | null>(null);
  const [form] = Form.useForm();

  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
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
  const selectedModels: string[] = Form.useWatch('models', form) ?? [];

  const setP = (model: string, key: keyof PriceRow, value: number | null) =>
    setPricing((p) => ({ ...p, [model]: { ...p[model], [key]: value ?? undefined } }));

  const buildModelPrices = (models: string[]) =>
    models.map((m) => {
      const r = pricing[m] ?? {};
      const entry: Record<string, unknown> = { model: m };
      if (r.costDiscount != null) entry.costDiscount = r.costDiscount;
      if (r.priceDiscount != null) entry.priceDiscount = r.priceDiscount;
      return entry;
    });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['channels', filters, page, pageSize],
    queryFn: ({ signal }) => channelsApi.list({ ...filters, page, pageSize }, signal),
  });

  usePageClamp(page, setPage, data);
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
    setPage(1);
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
      message.success(editing ? '渠道已更新' : '渠道已创建');
    },
    onError: (e) => message.error(errorMessage(e)),
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
    });
    const p: Record<string, PriceRow> = {};
    for (const mp of r.modelPrices ?? []) {
      p[mp.model] = {
        costDiscount: mp.costDiscount ?? undefined,
        priceDiscount: mp.priceDiscount ?? mp.discount ?? undefined,
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
      message.warning('请先填写支持模型');
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

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      channelsApi.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success('已更新');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: channelsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      message.success('已删除');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const openPricing = (r: ChannelInfo) => {
    const p: Record<string, PriceRow> = {};
    for (const mp of r.modelPrices ?? []) {
      p[mp.model] = {
        costDiscount: mp.costDiscount ?? undefined,
        priceDiscount: mp.priceDiscount ?? mp.discount ?? undefined,
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
      message.success('定价已保存');
    },
    onError: (e) => message.error(errorMessage(e)),
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
      title={isAdmin ? '上游渠道' : '我的渠道（BYOK）'}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          添加渠道
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

      <Table<ChannelInfo>
        rowKey="id"
        loading={isLoading || isFetching}
        dataSource={data?.items ?? []}
        scroll={{ x: 1000 }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
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
        title={editing ? `编辑渠道：${editing.name}` : '添加渠道'}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          setModalTest(null);
        }}
        footer={[
          <Button key="test" loading={modalTesting} onClick={testInModal}>
            测试连通性
          </Button>,
          <Button
            key="cancel"
            onClick={() => {
              setModalOpen(false);
              setEditing(null);
              setModalTest(null);
            }}
          >
            取消
          </Button>,
          <Button key="save" type="primary" loading={saveMut.isPending} onClick={() => form.submit()}>
            保存
          </Button>,
        ]}
        destroyOnClose
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate({ ...v, modelPrices: buildModelPrices(v.models ?? []) })}
          requiredMark={false}
          initialValues={{ provider: 'openai', weight: 1, priority: 0, ownerType: 'USER' }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：我的 OpenAI" />
          </Form.Item>
          {isAdmin && !editing && (
            <Form.Item name="ownerType" label="归属">
              <Select
                options={[
                  { value: 'USER', label: '我的 (BYOK)' },
                  { value: 'PLATFORM', label: '平台托管' },
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="provider" label="服务商" rules={[{ required: true }]}>
            <Select
              options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
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
            rules={[{ required: true, message: '请输入 Base URL' }]}
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label="上游 API Key"
            rules={editing ? [] : [{ required: true, message: '请输入上游 Key' }]}
            extra={editing ? '留空则不修改已保存的密钥' : undefined}
          >
            <Input.Password placeholder={editing ? '留空则不修改' : 'sk-... / 上游密钥（加密存储）'} />
          </Form.Item>
          <Form.Item
            name="models"
            label="支持的模型"
            rules={[{ required: true, message: '至少填写一个模型' }]}
          >
            <Select
              mode="tags"
              placeholder="可搜索/多选，也可直接输入模型名后回车"
              options={modelOptions}
              optionFilterProp="label"
            />
          </Form.Item>
          <div style={{ marginTop: -12, marginBottom: 12 }}>
            <Space size={8} wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                快捷：
              </Typography.Text>
              <Button
                size="small"
                onClick={() =>
                  form.setFieldValue('models', providerModelNames(form.getFieldValue('provider')))
                }
              >
                选本服务商全部
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', allModelNames)}>
                选全部推荐
              </Button>
              <Button size="small" onClick={() => form.setFieldValue('models', [])}>
                清空
              </Button>
            </Space>
          </div>

          {selectedModels.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                逐模型定价（可选，USD/1M tokens；留空则用模型目录默认价 × 折扣）
              </Typography.Text>
              <PricingTable models={selectedModels} pricing={pricing} setP={setP} catalog={catalog} />
            </div>
          )}
          <Space size={16}>
            <Form.Item name="priority" label="优先级（越大越优先）">
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="weight" label="权重（同级负载）">
              <InputNumber min={1} />
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
        title={`测试渠道：${testPick?.name ?? ''}`}
        open={!!testPick}
        onCancel={() => setTestPick(null)}
        okText="开始测试"
        confirmLoading={!!testPick && testingId === testPick.id}
        onOk={() => {
          if (testPick && pickModels.length > 0) runTest(testPick, pickModels);
          setTestPick(null);
        }}
        width={560}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          选择要测试的模型（默认全部）。模型较多时，可只测单个或部分。
        </Typography.Paragraph>
        <Space size={8} style={{ marginBottom: 8 }}>
          <Button size="small" onClick={() => setPickModels(testPick?.models ?? [])}>
            全选
          </Button>
          <Button size="small" onClick={() => setPickModels([])}>
            清空
          </Button>
          <Typography.Text type="secondary">
            已选 {pickModels.length} / {testPick?.models.length ?? 0}
          </Typography.Text>
        </Space>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder="选择模型"
          value={pickModels}
          onChange={setPickModels}
          optionFilterProp="label"
          options={(testPick?.models ?? []).map((m) => ({ value: m, label: m }))}
        />
      </Modal>

      <Modal
        title={`测试渠道：${testResult?.channel.name ?? ''}`}
        open={!!testResult}
        onCancel={() => setTestResult(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setTestResult(null)}>
            关闭
          </Button>,
        ]}
      >
        {testResult && <TestResults result={testResult.result} />}
      </Modal>

      <Modal
        title={`渠道定价：${priceChannel?.name ?? ''}`}
        open={!!priceChannel}
        onCancel={() => setPriceChannel(null)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setPriceChannel(null)}>
            取消
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={savePricingMut.isPending}
            onClick={() => priceChannel && savePricingMut.mutate(priceChannel)}
          >
            保存
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          成本 USD/1M tokens（用于按成本路由与毛利统计）；售价留空则用模型目录默认价 ×
          折扣。清空某项将恢复为默认。
        </Typography.Paragraph>
        {priceChannel && (
          <PricingTable models={priceChannel.models} pricing={pricing} setP={setP} catalog={catalog} />
        )}
      </Modal>
    </Card>
  );
}
