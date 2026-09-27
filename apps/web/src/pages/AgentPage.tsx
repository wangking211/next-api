import { Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { agentApi, billingApi } from '../api/endpoints';
import { formatCredits, formatDateTime } from '../utils/format';
import type { AgentMember, BalanceTransaction } from '../api/types';

export default function AgentPage() {
  const { data: overview, isLoading } = useQuery({
    queryKey: ['agent', 'overview'],
    queryFn: ({ signal }) => agentApi.overview(signal),
  });
  const { data: members, isLoading: mLoading } = useQuery({
    queryKey: ['agent', 'members'],
    queryFn: ({ signal }) => agentApi.members(signal),
  });
  const { data: commissions } = useQuery({
    queryKey: ['agent', 'commissions'],
    queryFn: ({ signal }) => billingApi.transactions(1, 50, 'COMMISSION', signal),
  });

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card title="代理中心" loading={isLoading}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          名下用户消耗的积分按「返点比例」计入你的余额。
        </Typography.Paragraph>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="我的余额" value={formatCredits(overview?.balance ?? 0)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="累计返点" value={formatCredits(overview?.commissionTotal ?? 0)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="名下成员" value={overview?.memberCount ?? 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="成员近 30 天消费"
              value={formatCredits(overview?.membersUsage30d?.cost ?? 0)}
            />
          </Col>
        </Row>
        <Space style={{ marginTop: 12 }} size={16}>
          <span>
            返点比例：
            {overview?.rebateRate != null
              ? `${(overview.rebateRate * 100).toFixed(1)}%`
              : '未设置'}
          </span>
          <span>
            我的用户倍率：
            {overview?.priceMultiplier != null ? `×${overview.priceMultiplier}` : '×1'}
          </span>
        </Space>
      </Card>

      <Card title="名下成员" size="small">
        <Table<AgentMember>
          rowKey="id"
          size="small"
          loading={mLoading}
          dataSource={members ?? []}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '用户名', dataIndex: 'username' },
            { title: '邮箱', dataIndex: 'email' },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (v: string) =>
                v === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag color="red">封禁</Tag>,
            },
            {
              title: '余额',
              dataIndex: 'balance',
              width: 130,
              render: (v: number) => formatCredits(v),
            },
            {
              title: '倍率',
              dataIndex: 'priceMultiplier',
              width: 80,
              render: (v: number | null) => (v != null ? `×${v}` : '×1'),
            },
            { title: '近30天请求', render: (_, r) => r.usage30d.requests, width: 100 },
            { title: '近30天Token', render: (_, r) => r.usage30d.tokens, width: 120 },
            {
              title: '近30天消费',
              width: 130,
              render: (_, r) => formatCredits(r.usage30d.cost),
            },
          ]}
        />
      </Card>

      <Card title="返点流水" size="small">
        <Table<BalanceTransaction>
          rowKey="id"
          size="small"
          dataSource={commissions?.items ?? []}
          pagination={false}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              width: 180,
              render: (v: string) => formatDateTime(v),
            },
            {
              title: '返点金额',
              dataIndex: 'amount',
              width: 140,
              render: (v: string) => (
                <Typography.Text type="success">{formatCredits(v)}</Typography.Text>
              ),
            },
            { title: '说明', dataIndex: 'description', render: (v) => v ?? '-' },
          ]}
        />
      </Card>
    </Space>
  );
}
