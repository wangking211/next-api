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
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { billingApi, paymentApi } from '../api/endpoints';
import { getCreditsPerCny, getPayRate, isPayEnabled } from '../api/config';
import { formatDateTime, toCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import { usePagination } from '../hooks/usePagination';
import QueryError from '../components/QueryError';
import type {
  BalanceTransaction,
  BalanceTxType,
  PaymentOrder,
  PaymentOrderCreated,
} from '../api/types';

/** 充值档位（元）；也可自定义输入 */
const PRESET_AMOUNTS = [1, 10, 50, 100, 500];

export default function BillingPage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [type, setType] = useState<BalanceTxType | 'ALL'>('ALL');
  const [code, setCode] = useState('');
  const [amountYuan, setAmountYuan] = useState(10);
  const [wayCode, setWayCode] = useState('QR_CASHIER');
  const [created, setCreated] = useState<PaymentOrderCreated | null>(null);

  const payEnabled = isPayEnabled();
  const creditsPerCny = getCreditsPerCny();
  const payRate = getPayRate();
  const isMobile = useMemo(() => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent), []);

  const TYPE_META: Record<BalanceTxType, { color: string; label: string }> = {
    RECHARGE: { color: 'green', label: t('billing.txnType.recharge') },
    CONSUME: { color: 'blue', label: t('billing.txnType.consume') },
    ADJUST: { color: 'orange', label: t('billing.txnType.adjust') },
    COMMISSION: { color: 'purple', label: t('billing.txnType.commission') },
    TRANSFER: { color: 'geekblue', label: t('billing.txnType.transfer') },
    WITHDRAW: { color: 'volcano', label: t('billing.txnType.withdraw') },
    CHANNEL_REVENUE: { color: 'cyan', label: t('billing.txnType.channelRevenue') },
  };

  const PAY_STATUS_META: Record<PaymentOrder['status'], { color: string; label: string }> = {
    PENDING: { color: 'processing', label: t('billing.payStatus.pending') },
    PAID: { color: 'green', label: t('billing.payStatus.paid') },
    CLOSED: { color: 'default', label: t('billing.payStatus.closed') },
    FAILED: { color: 'red', label: t('billing.payStatus.failed') },
  };

  const WAY_OPTIONS = [
    { label: t('billing.pay.way.cashier'), value: 'QR_CASHIER' },
    { label: t('billing.pay.way.wechat'), value: 'WX_NATIVE' },
    { label: t('billing.pay.way.alipay'), value: 'ALI_QR' },
  ];

  const creditsText = (credits: number): string =>
    t('common.creditsValue', {
      value: Number(credits ?? 0).toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    });

  const {
    data: balance,
    isError: balErr,
    refetch: balRefetch,
  } = useQuery({
    queryKey: ['billing', 'me'],
    queryFn: ({ signal }) => billingApi.me(signal),
  });
  const pg = usePagination();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['billing', 'transactions', pg.page, pg.pageSize, type],
    queryFn: ({ signal }) =>
      billingApi.transactions(pg.page, pg.pageSize, type === 'ALL' ? undefined : type, signal),
    placeholderData: keepPreviousData,
  });
  const {
    data: orders,
    isError: ordersErr,
    refetch: ordersRefetch,
  } = useQuery({
    queryKey: ['billing', 'pay-orders'],
    queryFn: ({ signal }) => paymentApi.orders(8, signal),
    enabled: payEnabled,
  });

  usePageClamp(pg.page, pg.setPage, data);

  const redeemMut = useMutation({
    mutationFn: billingApi.redeem,
    onSuccess: (res) => {
      message.success(t('billing.redeem.success', { credits: creditsText(toCredits(res.amount)) }));
      setCode('');
      qc.invalidateQueries({ queryKey: ['billing'] });
    },
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
      message.success(t('billing.pay.paidMsg'));
      qc.invalidateQueries({ queryKey: ['billing'] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data?.status]);

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Card>
          {/* 余额查询失败必须显式报错：静默渲染 0.00 会被读成「账户没钱」 */}
          <QueryError show={balErr} onRetry={balRefetch} />
          <Statistic
            title={t('billing.balance.title')}
            value={balErr ? '—' : toCredits(balance?.balance).toFixed(2)}
            suffix={t('billing.balance.suffix')}
          />
          <Space.Compact style={{ marginTop: 16, maxWidth: 420 }}>
            <Input
              placeholder={t('billing.redeem.placeholder')}
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
              {t('billing.redeem.button')}
            </Button>
          </Space.Compact>
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            message={
              payEnabled && creditsPerCny
                ? t('billing.notice.feeOnline', {
                    per: creditsPerCny,
                    rateNote: payRate ? t('billing.notice.rateNote', { rate: payRate }) : '',
                  })
                : t('billing.notice.feeRedeem')
            }
          />
        </Card>
      </Col>

      {payEnabled && (
        <Col span={24}>
          <Card title={t('billing.pay.title')}>
            {!creditsPerCny ? (
              <Alert type="warning" showIcon message={t('billing.pay.rateError')} />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap align="center">
                  <Segmented
                    value={amountYuan}
                    onChange={(v) => setAmountYuan(Number(v))}
                    options={PRESET_AMOUNTS.map((a) => ({
                      label: t('billing.pay.denomination', { value: a }),
                      value: a,
                    }))}
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
                  <Typography.Text type="secondary">{t('billing.pay.method')}</Typography.Text>
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
                    {t('billing.pay.submit', { value: amountYuan })}
                  </Button>
                  <Typography.Text type="secondary">
                    {t('billing.pay.estimated', {
                      credits: creditsText(amountYuan * creditsPerCny),
                      per: creditsPerCny,
                      rateNote: payRate ? t('billing.pay.rateNote', { rate: payRate }) : '',
                    })}
                  </Typography.Text>
                </Space>
              </Space>
            )}
          </Card>
        </Col>
      )}

      {/* 查询失败时也要露出卡片并给出重试，而不是整块消失（最近订单静默不可见） */}
      {payEnabled && ((orders?.items?.length ?? 0) > 0 || ordersErr) && (
        <Col span={24}>
          <Card title={t('billing.orders.title')} size="small">
            <QueryError show={ordersErr} onRetry={ordersRefetch} />
            <Table<PaymentOrder>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={orders?.items ?? []}
              scroll={{ x: 720 }}
              columns={[
                {
                  title: t('common.time'),
                  dataIndex: 'createdAt',
                  width: 180,
                  render: (v: string) => formatDateTime(v),
                },
                {
                  title: t('common.amount'),
                  dataIndex: 'amountCents',
                  width: 110,
                  render: (v: number) => `¥${(v / 100).toFixed(2)}`,
                },
                {
                  title: t('billing.orders.credits'),
                  dataIndex: 'credits',
                  width: 140,
                  render: (v: number) => creditsText(v),
                },
                { title: t('billing.orders.way'), dataIndex: 'wayCode', width: 130 },
                {
                  title: t('common.status'),
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
          title={t('billing.txnTable.title')}
          extra={
            <Segmented
              value={type}
              onChange={(v) => {
                setType(v as BalanceTxType | 'ALL');
                pg.reset();
              }}
              options={[
                { label: t('common.all'), value: 'ALL' },
                { label: t('billing.txnType.recharge'), value: 'RECHARGE' },
                { label: t('billing.txnType.consume'), value: 'CONSUME' },
                { label: t('billing.txnType.adjust'), value: 'ADJUST' },
                { label: t('billing.txnType.channelRevenue'), value: 'CHANNEL_REVENUE' },
              ]}
            />
          }
        >
          <QueryError show={isError} onRetry={refetch} />

          <Table<BalanceTransaction>
            rowKey="id"
            loading={isLoading}
            dataSource={data?.items ?? []}
            scroll={{ x: 800 }}
            pagination={pg.pagination(data?.total)}
            columns={[
              {
                title: t('common.time'),
                dataIndex: 'createdAt',
                width: 180,
                render: (v: string) => formatDateTime(v),
              },
              {
                title: t('billing.txnTable.type'),
                dataIndex: 'type',
                render: (v: BalanceTxType) => (
                  <Tag color={TYPE_META[v].color}>{TYPE_META[v].label}</Tag>
                ),
              },
              {
                title: t('billing.txnTable.amount'),
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
                title: t('billing.txnTable.balanceSnapshot'),
                dataIndex: 'balanceAfter',
                render: (v: string) => toCredits(v).toFixed(2),
              },
              {
                title: t('billing.txnTable.description'),
                dataIndex: 'description',
                render: (v) => v ?? '-',
              },
            ]}
          />
        </Card>
      </Col>

      <Modal
        title={t('billing.payModal.title')}
        open={!!created}
        onCancel={() => setCreated(null)}
        footer={null}
        width={400}
        destroyOnClose
      >
        {created?.status === 'PAID' ? (
          <Result
            status="success"
            title={t('billing.payModal.successTitle')}
            subTitle={t('billing.payModal.successSub', { credits: creditsText(created.credits) })}
          />
        ) : (
          <div style={{ textAlign: 'center' }}>
            {created?.payData ? (
              created.payDataType === 'codeImgUrl' ? (
                <img
                  src={created.payData}
                  alt={t('billing.payModal.qrAlt')}
                  style={{ width: 220, height: 220 }}
                />
              ) : (
                <QRCode value={created.payData} size={220} />
              )
            ) : (
              <Typography.Text type="warning">{t('billing.payModal.qrMissing')}</Typography.Text>
            )}
            <Typography.Paragraph style={{ marginTop: 12, marginBottom: 4 }}>
              {t('billing.payModal.payable')}{' '}
              <Typography.Text strong>
                ¥{((created?.amountCents ?? 0) / 100).toFixed(2)}
              </Typography.Text>
              {t('billing.payModal.credited')}{' '}
              <Typography.Text strong>{creditsText(created?.credits ?? 0)}</Typography.Text>
            </Typography.Paragraph>
            <Typography.Text type="secondary">{t('billing.payModal.hint')}</Typography.Text>
          </div>
        )}
      </Modal>
    </Row>
  );
}
