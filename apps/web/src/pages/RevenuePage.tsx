import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { billingApi, withdrawalsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, formatDateTime, fromCredits } from '../utils/format';
import QueryError from '../components/QueryError';
import type { RevenueChannel, Withdrawal } from '../api/types';

const { Text } = Typography;

/** UTC+8 口径的近 12 个自然月标签（与后端 getRevenue 归月一致），升序 */
function last12Months(): string[] {
  const now = new Date(Date.now() + 8 * 3600_000);
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** 我的收益：累计/本月/余额统计卡 + 各渠道明细 + 月度趋势 + 提现 */
export default function RevenuePage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawForm] = Form.useForm();

  const {
    data: summary,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['revenue', 'summary'],
    queryFn: ({ signal }) => billingApi.revenue(signal),
  });
  const {
    data: balance,
    isError: balErr,
    refetch: balRefetch,
  } = useQuery({
    queryKey: ['billing', 'me'],
    queryFn: ({ signal }) => billingApi.me(signal),
  });
  const {
    data: withdrawals,
    isLoading: wLoading,
    isError: wErr,
    refetch: wRefetch,
  } = useQuery({
    queryKey: ['revenue', 'withdrawals'],
    queryFn: ({ signal }) => withdrawalsApi.mine(signal),
  });

  const withdrawMut = useMutation({
    mutationFn: (amount: number) => withdrawalsApi.create(fromCredits(amount)),
    onSuccess: () => {
      // 提现冻结余额、记录进「我的收益」页列表；两个缓存一并失效
      qc.invalidateQueries({ queryKey: ['revenue'] });
      qc.invalidateQueries({ queryKey: ['billing'] });
      setWithdrawOpen(false);
      withdrawForm.resetFields();
      message.success(t('billing.revenue.withdrawSuccess'));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const months = last12Months();
  const revenueByMonth = new Map((summary?.months ?? []).map((m) => [m.month, m.revenue]));
  const trendRows = months.map((month) => ({ month, revenue: revenueByMonth.get(month) ?? 0 }));
  const monthRevenue = revenueByMonth.get(months[months.length - 1]) ?? 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <QueryError show={isError} onRetry={refetch} />
      <QueryError show={balErr} onRetry={balRefetch} />
      <QueryError show={wErr} onRetry={wRefetch} />

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card loading={isLoading}>
            <Statistic
              title={t('billing.revenue.total')}
              value={formatCredits(summary?.total ?? 0)}
            />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card loading={isLoading}>
            <Statistic title={t('billing.revenue.monthly')} value={formatCredits(monthRevenue)} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card
            extra={
              <Button type="primary" size="small" onClick={() => setWithdrawOpen(true)}>
                {t('billing.revenue.withdraw')}
              </Button>
            }
          >
            <Statistic
              title={t('billing.balance.title')}
              value={formatCredits(balance?.balance ?? 0)}
            />
          </Card>
        </Col>
      </Row>

      <Card title={t('billing.revenue.channelsTitle')}>
        <Table<RevenueChannel>
          rowKey="id"
          size="small"
          loading={isLoading}
          dataSource={summary?.channels ?? []}
          pagination={false}
          locale={{ emptyText: <Text type="secondary">{t('billing.revenue.empty')}</Text> }}
          columns={[
            { title: t('billing.revenue.channelCol'), dataIndex: 'name' },
            {
              title: t('channels.table.revenue'),
              dataIndex: 'revenue',
              width: 160,
              render: (v: number) => formatCredits(v),
            },
            {
              title: t('billing.revenue.callsCol'),
              dataIndex: 'calls',
              width: 110,
            },
            {
              title: t('billing.revenue.lastAtCol'),
              dataIndex: 'lastAt',
              width: 190,
              render: (v: string | null) => formatDateTime(v),
            },
          ]}
        />
      </Card>

      <Card title={t('billing.revenue.trendTitle')}>
        <Table
          rowKey="month"
          size="small"
          dataSource={trendRows}
          pagination={false}
          columns={[
            { title: t('billing.revenue.monthCol'), dataIndex: 'month', width: 140 },
            {
              title: t('channels.table.revenue'),
              dataIndex: 'revenue',
              render: (v: number) => formatCredits(v),
            },
          ]}
        />
      </Card>

      <Card title={t('billing.revenue.withdrawRecords')}>
        <Table<Withdrawal>
          rowKey="id"
          size="small"
          loading={wLoading}
          dataSource={withdrawals ?? []}
          pagination={false}
          columns={[
            {
              title: t('common.time'),
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => formatDateTime(v),
            },
            {
              title: t('common.amount'),
              dataIndex: 'amount',
              width: 130,
              render: (v: string) => formatCredits(v),
            },
            {
              title: t('common.status'),
              dataIndex: 'status',
              width: 100,
              render: (v: string) =>
                v === 'APPROVED' ? (
                  <Tag color="green">{t('common.approved')}</Tag>
                ) : v === 'REJECTED' ? (
                  <Tag color="red">{t('common.rejected')}</Tag>
                ) : (
                  <Tag color="orange">{t('common.pending')}</Tag>
                ),
            },
            {
              title: t('common.remark'),
              dataIndex: 'note',
              render: (v: string | null) => v ?? '-',
            },
          ]}
        />
      </Card>

      <Modal
        title={t('billing.revenue.withdrawModalTitle')}
        open={withdrawOpen}
        onCancel={() => setWithdrawOpen(false)}
        onOk={() => withdrawForm.submit()}
        confirmLoading={withdrawMut.isPending}
        destroyOnClose
      >
        <Form
          form={withdrawForm}
          layout="vertical"
          onFinish={(v) => withdrawMut.mutate(v.amount)}
          requiredMark={false}
        >
          <Form.Item
            name="amount"
            label={t('billing.revenue.withdrawAmountLabel')}
            rules={[{ required: true, message: t('billing.revenue.enterCredits') }]}
          >
            <InputNumber min={1} step={100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
