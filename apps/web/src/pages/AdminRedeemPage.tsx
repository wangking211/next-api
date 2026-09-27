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
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, CopyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { redeemCodesApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatDateTime, formatUsd } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { RedeemCode, RedeemCodeStatus } from '../api/types';

const STATUS_META: Record<RedeemCodeStatus, { color: string; label: string }> = {
  UNUSED: { color: 'green', label: '未使用' },
  USED: { color: 'default', label: '已使用' },
  DISABLED: { color: 'red', label: '已作废' },
};

export default function AdminRedeemPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<RedeemCodeStatus | 'ALL'>('ALL');
  const [generated, setGenerated] = useState<string[] | null>(null);
  const [form] = Form.useForm();

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
      expiresAt?: { toISOString: () => string };
    }) =>
      redeemCodesApi.generate({
        amount: values.amount,
        quantity: values.quantity,
        note: values.note,
        expiresAt: values.expiresAt ? values.expiresAt.toISOString() : undefined,
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
      message.success('已作废');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText((generated ?? []).join('\n'));
      message.success('已复制全部兑换码');
    } catch {
      message.warning('复制失败，请手动选择复制');
    }
  };

  return (
    <Card
      title="兑换码"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          生成兑换码
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
            { label: '全部', value: 'ALL' },
            { label: '未使用', value: 'UNUSED' },
            { label: '已使用', value: 'USED' },
            { label: '已作废', value: 'DISABLED' },
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
          { title: '兑换码', dataIndex: 'code', render: (v: string) => <code>{v}</code> },
          {
            title: '面值',
            dataIndex: 'amount',
            render: (v: string) => formatUsd(v),
          },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v: RedeemCodeStatus) => (
              <Tag color={STATUS_META[v].color}>{STATUS_META[v].label}</Tag>
            ),
          },
          { title: '备注', dataIndex: 'note', render: (v) => v ?? '-' },
          {
            title: '过期时间',
            dataIndex: 'expiresAt',
            render: (v: string | null) => (v ? formatDateTime(v) : '永久'),
          },
          {
            title: '使用时间',
            dataIndex: 'usedAt',
            render: (v: string | null) => (v ? formatDateTime(v) : '-'),
          },
          {
            title: '操作',
            fixed: 'right',
            width: 100,
            render: (_, r) =>
              r.status === 'UNUSED' ? (
                <Popconfirm title="确定作废该兑换码？" onConfirm={() => disableMut.mutate(r.id)}>
                  <Button size="small" danger>
                    作废
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />

      <Modal
        title="生成兑换码"
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
          initialValues={{ quantity: 10 }}
        >
          <Form.Item name="amount" label="单个面值 (USD)" rules={[{ required: true, message: '请输入面值' }]}>
            <InputNumber min={0.000001} step={1} style={{ width: '100%' }} placeholder="例如 10" />
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}>
            <InputNumber min={1} max={1000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注（批次说明）">
            <Input placeholder="例如：双十一活动" />
          </Form.Item>
          <Form.Item name="expiresAt" label="过期时间（留空永久有效）">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="兑换码已生成"
        open={!!generated}
        width={560}
        onCancel={() => setGenerated(null)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={copyAll}>
            复制全部
          </Button>,
          <Button key="close" type="primary" onClick={() => setGenerated(null)}>
            完成
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary">
          共 {generated?.length ?? 0} 个，请及时复制保存。
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
