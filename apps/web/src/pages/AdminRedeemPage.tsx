import { useState } from 'react';
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { redeemCodesApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, formatDateTime, fromCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { RedeemCode, RedeemCodeStatus } from '../api/types';

const getStatusMeta = (
  t: TFunction,
): Record<RedeemCodeStatus, { color: string; label: string }> => ({
  UNUSED: { color: 'green', label: t('admin.redeem.statusUnused') },
  USED: { color: 'default', label: t('admin.redeem.statusUsed') },
  DISABLED: { color: 'red', label: t('admin.redeem.statusVoid') },
});

/** 有效期快速选择：常用时长一键生成，免去每次手选日期 */
const getExpiryPresets = (t: TFunction): Array<{ label: string; value: string }> => [
  { label: t('admin.redeem.expiryForever'), value: 'forever' },
  { label: t('admin.redeem.expiry7d'), value: '7d' },
  { label: t('admin.redeem.expiry1m'), value: '1m' },
  { label: t('admin.redeem.expiry3m'), value: '3m' },
  { label: t('admin.redeem.expiry6m'), value: '6m' },
  { label: t('admin.redeem.expiry1y'), value: '1y' },
  { label: t('admin.redeem.expiryCustom'), value: 'custom' },
];

/** 按快捷时长计算截止时间（ISO）；forever 返回 undefined，custom 由日期选择器提供 */
function expiryFromPreset(preset: string): string | undefined {
  const d = new Date();
  switch (preset) {
    case '7d':
      d.setDate(d.getDate() + 7);
      break;
    case '1m':
      d.setMonth(d.getMonth() + 1);
      break;
    case '3m':
      d.setMonth(d.getMonth() + 3);
      break;
    case '6m':
      d.setMonth(d.getMonth() + 6);
      break;
    case '1y':
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      return undefined;
  }
  return d.toISOString();
}

export default function AdminRedeemPage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const statusMeta = getStatusMeta(t);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<RedeemCodeStatus | 'ALL'>('ALL');
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [form] = Form.useForm();
  const expiryPreset = Form.useWatch('expiryPreset', form) ?? 'forever';

  const { data, isLoading } = useQuery({
    queryKey: ['redeem-codes', page, pageSize, status],
    queryFn: ({ signal }) =>
      redeemCodesApi.list(page, pageSize, status === 'ALL' ? undefined : status, signal),
  });

  usePageClamp(page, setPage, data);

  const generateMut = useMutation({
    mutationFn: (values: {
      amount: number;
      quantity: number;
      note?: string;
      expiryPreset: string;
      expiresAt?: { toISOString: () => string };
    }) =>
      redeemCodesApi.generate({
        amount: fromCredits(values.amount),
        quantity: values.quantity,
        note: values.note,
        expiresAt:
          values.expiryPreset === 'custom'
            ? values.expiresAt?.toISOString()
            : expiryFromPreset(values.expiryPreset),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['redeem-codes'] });
      setOpen(false);
      form.resetFields();
      setGenerated(res.codes);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const disableMut = useMutation({
    mutationFn: redeemCodesApi.disable,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['redeem-codes'] });
      message.success(t('admin.redeem.voidSuccess'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText((generated ?? []).join('\n'));
      message.success(t('admin.redeem.copyAllSuccess'));
    } catch {
      message.warning(t('admin.redeem.copyAllFail'));
    }
  };

  return (
    <Card
      title={t('admin.redeem.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t('admin.redeem.generate')}
        </Button>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v as RedeemCodeStatus | 'ALL');
            setPage(1);
          }}
          options={[
            { label: t('common.all'), value: 'ALL' },
            { label: t('admin.redeem.statusUnused'), value: 'UNUSED' },
            { label: t('admin.redeem.statusUsed'), value: 'USED' },
            { label: t('admin.redeem.statusVoid'), value: 'DISABLED' },
          ]}
        />
      </div>

      <Table<RedeemCode>
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
          { title: t('admin.redeem.column.code'), dataIndex: 'code', render: (v: string) => <code>{v}</code> },
          {
            title: t('admin.redeem.column.denomination'),
            dataIndex: 'amount',
            render: (v: string) => formatCredits(v),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (v: RedeemCodeStatus) => (
              <Tag color={statusMeta[v].color}>{statusMeta[v].label}</Tag>
            ),
          },
          { title: t('common.remark'), dataIndex: 'note', render: (v) => v ?? '-' },
          {
            title: t('admin.redeem.column.expires'),
            dataIndex: 'expiresAt',
            render: (v: string | null) => (v ? formatDateTime(v) : t('admin.redeem.permanent')),
          },
          {
            title: t('admin.redeem.column.usedAt'),
            dataIndex: 'usedAt',
            render: (v: string | null) => (v ? formatDateTime(v) : '-'),
          },
          {
            title: t('common.action'),
            fixed: 'right',
            width: 100,
            render: (_, r) =>
              r.status === 'UNUSED' ? (
                <Popconfirm title={t('admin.redeem.voidConfirm')} onConfirm={() => disableMut.mutate(r.id)}>
                  <Button size="small" danger>
                    {t('admin.redeem.void')}
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />

      <Modal
        title={t('admin.redeem.generate')}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={generateMut.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => generateMut.mutate(v)}
          requiredMark={false}
          initialValues={{ quantity: 10, expiryPreset: 'forever' }}
        >
          <Form.Item name="amount" label={t('admin.redeem.amountLabel')} rules={[{ required: true, message: t('admin.redeem.amountRequired') }]}>
            <InputNumber min={1} step={100} style={{ width: '100%' }} placeholder={t('admin.redeem.amountPlaceholder')} />
          </Form.Item>
          <Form.Item name="quantity" label={t('admin.redeem.quantityLabel')} rules={[{ required: true }]}>
            <InputNumber min={1} max={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label={t('admin.redeem.noteLabel')}>
            <Input placeholder={t('admin.redeem.notePlaceholder')} />
          </Form.Item>
          <Form.Item name="expiryPreset" label={t('admin.redeem.expiryLabel')}>
            <Select options={getExpiryPresets(t)} />
          </Form.Item>
          {expiryPreset === 'custom' && (
            <Form.Item
              name="expiresAt"
              label={t('admin.redeem.customExpiryLabel')}
              rules={[{ required: true, message: t('admin.redeem.customExpiryRequired') }]}
            >
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title={t('admin.redeem.generatedTitle')}
        open={!!generated}
        width={560}
        onCancel={() => setGenerated(null)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={copyAll}>
            {t('admin.redeem.copyAll')}
          </Button>,
          <Button key="close" type="primary" onClick={() => setGenerated(null)}>
            {t('admin.redeem.done')}
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary">
          {t('admin.redeem.generatedCount', { total: generated?.length ?? 0 })}
        </Typography.Paragraph>
        <Input.TextArea
          readOnly
          value={(generated ?? []).join('\n')}
          autoSize={{ minRows: 6, maxRows: 12 }}
        />
      </Modal>
    </Card>
  );
}
