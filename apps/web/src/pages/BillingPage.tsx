import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Modal,
  QRCode,
  Result,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingApi, paymentApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { getCreditsPerCny, getPayRate, isPayEnabled } from '../api/config';
import { formatDateTime, toCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type {
  BalanceTransaction,
  BalanceTxType,
  PaymentOrder,
  PaymentOrderCreated,
} from '../api/types';

const TYPE_META: Record<BalanceTxType, { color: string; label: string }> = {
  RECHARGE: { color: 'green', label: '充值' },
  CONSUME: { color: 'blue', label: '消费' },
  ADJUST: { color: 'orange', label: '调整' },
  COMMISSION: { color: 'purple', label: '返点' },
  TRANSFER: { color: 'geekblue', label: '转账' },
  WITHDRAW: { color: 'volcano', label: '提现' },
};

const PAY_STATUS_META: Record<PaymentOrder['status'], { color: string; label: string }> = {
  PENDING: { color: 'processing', label: '待支付' },
  PAID: { color: 'green', label: '已到账' },
  CLOSED: { color: 'default', label: '已关闭' },
  FAILED: { color: 'red', label: '失败' },
};

/** 充值档位（元）；也可自定义输入 */
const PRESET_AMOUNTS = [1, 10, 50, 100, 500];
const WAY_OPTIONS = [
  { label: '通用收银台', value: 'QR_CASHIER' },
  { label: '微信扫码', value: 'WX_NATIVE' },
  { label: '支付宝扫码', value: 'ALI_QR' },
];

function creditsText(credits: number): string {
  return `${Number(credits ?? 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} 积分`;
}

export default function BillingPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [type, setType] = useState<BalanceTxType | 'ALL'>('ALL');
  const [code, setCode] = useState('');
  const [amountYuan, setAmountYuan] = useState(10);
  const [wayCode, setWayCode] = useState('QR_CASHIER');
  const [created, setCreated] = useState<PaymentOrderCreated | null>(null);

  const payEnabled = isPayEnabled();
  const creditsPerCny = getCreditsPerCny();
  const payRate = getPayRate();
  const isMobile = useMemo(
    () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent),
    [],
  );

  const { data: balance } = useQuery({
    queryKey: ['billing', 'me'],
    queryFn: ({ signal }) => billingApi.me(signal),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['billing', 'transactions', page, pageSize, type],
    queryFn: ({ signal }) =>
      billingApi.transactions(page, pageSize, type === 'ALL' ? undefined : type, signal),
  });
  const { data: orders } = useQuery({
    queryKey: ['billing', 'pay-orders'],
    queryFn: ({ signal }) => paymentApi.orders(8, signal),
    enabled: payEnabled,
  });

  usePageClamp(page, setPage, data);

  const redeemMut = useMutation({
    mutationFn: billingApi.redeem,
    onSuccess: (res) => {
      message.success(`兑换成功，入账 ${creditsText(toCredits(res.amount))}`);
      setCode('');
      qc.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const createPayMut = useMutation({
    mutationFn: () =>
      paymentApi.createOrder({ amountCents: Math.round(amountYuan * 100), wayCode }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['billing', 'pay-orders'] });
      // 手机端：收银台链接直接跳转；PC 端：展示二维码
      if (res.payDataType === 'payurl' && res.payData && isMobile) {
        window.location.href = res.payData;
        return;
      }
      setCreated(res);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // 待支付订单轮询（每 3 秒）
  const poll = useQuery({
    queryKey: ['billing', 'pay-order', created?.id],
    queryFn: ({ signal }) => paymentApi.order(created!.id, signal),
    enabled: !!created?.id && created?.status === 'PENDING',
    refetchInterval: 3000,
  });

  useEffect(() => {
    const status = poll.data?.status;
    if (!status || status === 'PENDING') return;
    setCreated((c) => (c ? { ...c, status } : c));
    if (status === 'PAID') {
      message.success('支付成功，积分已到账');
      qc.invalidateQueries({ queryKey: ['billing'] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data?.status]);

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Card>
          <Statistic
            title="账户余额"
            value={toCredits(balance?.balance).toFixed(2)}
            suffix="积分"
          />
          <Space.Compact style={{ marginTop: 16, maxWidth: 420 }}>
            <Input
              placeholder="输入兑换码，如 XXXX-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onPressEnter={() => code && redeemMut.mutate(code)}
            />
            <Button
              type="primary"
              disabled={!code}
              loading={redeemMut.isPending}
              onClick={() => redeemMut.mutate(code)}
            >
              兑换
            </Button>
          </Space.Compact>
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            message={
              payEnabled && creditsPerCny
                ? `平台托管渠道按调用成本从余额扣费；BYOK（自带上游 Key）渠道不扣费。可通过在线充值（微信/支付宝）、兑换码充值。当前 1 元 = ${creditsPerCny} 积分${payRate ? `（1 美元 = ${payRate} 元）` : ''}。`
                : '平台托管渠道按调用成本从余额扣费；BYOK（自带上游 Key）渠道不扣费。可通过兑换码或联系管理员充值。'
            }
          />
        </Card>
      </Col>

      {payEnabled && (
        <Col span={24}>
          <Card title="在线充值（微信 / 支付宝）">
            {!creditsPerCny ? (
              <Alert
                type="warning"
                showIcon
                message="实时汇率获取失败，暂时无法下单充值，请稍后重试（或联系管理员配置固定汇率）。"
              />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap align="center">
                  <Segmented
                    value={amountYuan}
                    onChange={(v) => setAmountYuan(Number(v))}
                    options={PRESET_AMOUNTS.map((a) => ({ label: `${a} 元`, value: a }))}
                  />
                  <InputNumber
                    addonBefore="¥"
                    min={1}
                    max={5000}
                    step={1}
                    style={{ width: 160 }}
                    value={amountYuan}
                    onChange={(v) => setAmountYuan(Number(v) || 1)}
                  />
                </Space>
                <Space wrap align="center">
                  <Typography.Text type="secondary">支付方式</Typography.Text>
                  <Segmented
                    value={wayCode}
                    onChange={(v) => setWayCode(String(v))}
                    options={WAY_OPTIONS}
                  />
                </Space>
                <Space wrap align="center">
                  <Button
                    type="primary"
                    loading={createPayMut.isPending}
                    onClick={() => createPayMut.mutate()}
                  >
                    立即充值 ¥{amountYuan}
                  </Button>
                  <Typography.Text type="secondary">
                    预计到账 {creditsText(amountYuan * creditsPerCny)}（1 元 = {creditsPerCny} 积分
                    {payRate ? `，实时汇率 1 美元 = ${payRate} 元` : ''}）
                  </Typography.Text>
                </Space>
              </Space>
            )}
          </Card>
        </Col>
      )}

      {payEnabled && (orders?.items?.length ?? 0) > 0 && (
        <Col span={24}>
          <Card title="充值订单（最近 8 笔）" size="small">
            <Table<PaymentOrder>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={orders?.items ?? []}
              scroll={{ x: 720 }}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'createdAt',
                  width: 180,
                  render: (v: string) => formatDateTime(v),
                },
                {
                  title: '金额',
                  dataIndex: 'amountCents',
                  width: 110,
                  render: (v: number) => `¥${(v / 100).toFixed(2)}`,
                },
                {
                  title: '到账积分',
                  dataIndex: 'credits',
                  width: 140,
                  render: (v: number) => creditsText(v),
                },
                { title: '方式', dataIndex: 'wayCode', width: 130 },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 110,
                  render: (v: PaymentOrder['status']) => (
                    <Tag color={PAY_STATUS_META[v].color}>{PAY_STATUS_META[v].label}</Tag>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      )}

      <Col span={24}>
        <Card
          title="账单明细"
          extra={
            <Segmented
              value={type}
              onChange={(v) => {
                setType(v as BalanceTxType | 'ALL');
                setPage(1);
              }}
              options={[
                { label: '全部', value: 'ALL' },
                { label: '充值', value: 'RECHARGE' },
                { label: '消费', value: 'CONSUME' },
                { label: '调整', value: 'ADJUST' },
              ]}
            />
          }
        >
          <Table<BalanceTransaction>
            rowKey="id"
            loading={isLoading}
            dataSource={data?.items ?? []}
            scroll={{ x: 800 }}
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
              {
                title: '时间',
                dataIndex: 'createdAt',
                width: 180,
                render: (v: string) => formatDateTime(v),
              },
              {
                title: '类型',
                dataIndex: 'type',
                render: (v: BalanceTxType) => (
                  <Tag color={TYPE_META[v].color}>{TYPE_META[v].label}</Tag>
                ),
              },
              {
                title: '金额 (积分)',
                dataIndex: 'amount',
                render: (v: string) => {
                  const n = Number(v);
                  return (
                    <Typography.Text type={n >= 0 ? 'success' : 'danger'}>
                      {n >= 0 ? '+' : ''}
                      {toCredits(n).toFixed(2)}
                    </Typography.Text>
                  );
                },
              },
              {
                title: '余额快照 (积分)',
                dataIndex: 'balanceAfter',
                render: (v: string) => toCredits(v).toFixed(2),
              },
              { title: '说明', dataIndex: 'description', render: (v) => v ?? '-' },
            ]}
          />
        </Card>
      </Col>

      <Modal
        title="扫码支付"
        open={!!created}
        onCancel={() => setCreated(null)}
        footer={null}
        width={400}
        destroyOnClose
      >
        {created?.status === 'PAID' ? (
          <Result
            status="success"
            title="支付成功"
            subTitle={`${creditsText(created.credits)}已到账`}
          />
        ) : (
          <div style={{ textAlign: 'center' }}>
            {created?.payData ? (
              created.payDataType === 'codeImgUrl' ? (
                <img
                  src={created.payData}
                  alt="支付二维码"
                  style={{ width: 220, height: 220 }}
                />
              ) : (
                <QRCode value={created.payData} size={220} />
              )
            ) : (
              <Typography.Text type="warning">未获取到支付二维码，请重试</Typography.Text>
            )}
            <Typography.Paragraph style={{ marginTop: 12, marginBottom: 4 }}>
              应付 <Typography.Text strong>¥{((created?.amountCents ?? 0) / 100).toFixed(2)}</Typography.Text>
              ，到账 <Typography.Text strong>{creditsText(created?.credits ?? 0)}</Typography.Text>
            </Typography.Paragraph>
            <Typography.Text type="secondary">
              请用微信或支付宝扫码支付，到账后自动刷新（每 3 秒检测）
            </Typography.Text>
          </div>
        )}
      </Modal>
    </Row>
  );
}
