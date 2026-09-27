import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Input,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, formatDateTime, toCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { BalanceTransaction, BalanceTxType } from '../api/types';

const TYPE_META: Record<BalanceTxType, { color: string; label: string }> = {
  RECHARGE: { color: 'green', label: '充值' },
  CONSUME: { color: 'blue', label: '消费' },
  ADJUST: { color: 'orange', label: '调整' },
  COMMISSION: { color: 'purple', label: '返点' },
  TRANSFER: { color: 'geekblue', label: '转账' },
  WITHDRAW: { color: 'volcano', label: '提现' },
};

export default function BillingPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [type, setType] = useState<BalanceTxType | 'ALL'>('ALL');
  const [code, setCode] = useState('');

  const { data: balance } = useQuery({
    queryKey: ['billing', 'me'],
    queryFn: ({ signal }) => billingApi.me(signal),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['billing', 'transactions', page, pageSize, type],
    queryFn: ({ signal }) =>
      billingApi.transactions(page, pageSize, type === 'ALL' ? undefined : type, signal),
  });

  usePageClamp(page, setPage, data);

  const redeemMut = useMutation({
    mutationFn: billingApi.redeem,
    onSuccess: (res) => {
      message.success(`兑换成功，入账 ${formatCredits(res.amount)}`);
      setCode('');
      qc.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

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
            message="平台托管渠道按调用成本从余额扣费；BYOK（自带上游 Key）渠道不扣费。可通过兑换码或联系管理员充值。"
          />
        </Card>
      </Col>
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
    </Row>
  );
}
