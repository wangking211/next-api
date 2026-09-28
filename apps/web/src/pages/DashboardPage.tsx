import { useState } from 'react';
import { Alert, Button, Card, Col, Row, Switch, Table, Tag, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { usageApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { toCredits } from '../utils/format';
import type { RequestLogRow } from '../api/types';
import { StatCard } from './dashboard/StatCard';
import { RankList } from './dashboard/RankBar';
import { DailyBars } from './dashboard/DailyBars';
import { PageHeader } from './dashboard/PageHeader';

export default function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [all, setAll] = useState(false);
  const scope = isAdmin && all ? 'all' : undefined;

  const { data: summary, isError, refetch } = useQuery({
    queryKey: ['usage', 'summary', scope],
    queryFn: ({ signal }) => usageApi.summary(30, scope, signal),
  });
  const { data: daily = [] } = useQuery({
    queryKey: ['usage', 'daily', scope],
    queryFn: ({ signal }) => usageApi.daily(30, scope, signal),
  });
  const { data: analytics } = useQuery({
    queryKey: ['usage', 'analytics', scope],
    queryFn: ({ signal }) => usageApi.analytics(30, scope, signal),
  });
  const { data: logs } = useQuery({
    queryKey: ['usage', 'logs', 'recent', scope],
    queryFn: ({ signal }) => usageApi.logs(1, 8, scope, {}, signal),
  });

  const successRate =
    summary && summary.requests > 0
      ? ((summary.successRequests / summary.requests) * 100).toFixed(1)
      : '—';
  const margin = analytics?.totals?.margin ?? 0;

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      {isError && (
        <Alert
          type="error"
          showIcon
          message="数据加载失败"
          description="部分统计可能无法显示，请重试。"
          action={
            <Button size="small" onClick={() => refetch()}>
              重试
            </Button>
          }
        />
      )}
      <PageHeader
        title="总览（近 30 天）"
        extra={
          isAdmin && (
            <span style={{ color: 'var(--text-2)' }}>
              查看全部用户 <Switch checked={all} onChange={setAll} />
            </span>
          )
        }
      />

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <StatCard label="请求数" value={summary?.requests ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label="成功率" value={successRate} suffix="%" />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label="Token 总量" value={summary?.totalTokens ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label="费用" value={toCredits(summary?.cost).toFixed(2)} suffix="积分" />
        </Col>
        {isAdmin && (
          <Col xs={12} md={6}>
            <StatCard
              label="毛利"
              value={toCredits(margin).toFixed(2)}
              suffix="积分"
              valueColor={margin >= 0 ? 'var(--ok)' : 'var(--err)'}
            />
          </Col>
        )}
      </Row>

      <Card title="每日 Token 用量">
        <DailyBars rows={daily} />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <RankList
            title="模型用量（tokens）"
            items={(analytics?.byModel ?? []).map((m) => ({
              key: m.model,
              label: m.model,
              value: m.tokens,
              sub: `· ${toCredits(m.cost).toFixed(2)} 积分${isAdmin ? ` · 毛利 ${toCredits(m.margin).toFixed(2)}` : ''} · 失败 ${m.errors}`,
            }))}
          />
        </Col>
        <Col xs={24} md={8}>
          <RankList
            title="渠道用量（tokens）"
            items={(analytics?.byChannel ?? []).map((c) => ({
              key: c.channelId ?? c.name,
              label: `${c.name}${c.provider ? ` (${c.provider})` : ''}`,
              value: c.tokens,
              sub: `· ${toCredits(c.cost).toFixed(2)} 积分${isAdmin ? ` · 毛利 ${toCredits(c.margin).toFixed(2)}` : ''}`,
            }))}
          />
        </Col>
        {(analytics?.byUser?.length ?? 0) > 0 && (
          <Col xs={24} md={8}>
            <RankList
              title="用户用量（tokens）"
              items={(analytics?.byUser ?? []).map((u) => ({
                key: u.userId,
                label: u.name,
                value: u.tokens,
                sub: `· ${toCredits(u.cost).toFixed(2)} 积分${isAdmin ? ` · 毛利 ${toCredits(u.margin).toFixed(2)}` : ''}`,
              }))}
            />
          </Col>
        )}
      </Row>

      <Card title="最近调用">
        <Table<RequestLogRow>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={logs?.items ?? []}
          columns={[
            {
              title: '时间',
              dataIndex: 'createdAt',
              render: (v: string) => new Date(v).toLocaleString(),
            },
            { title: '模型', dataIndex: 'model' },
            { title: 'Key', render: (_, r) => r.apiKey?.name ?? '-' },
            { title: '渠道', render: (_, r) => r.channel?.name ?? '-' },
            { title: 'Tokens', dataIndex: 'totalTokens' },
            { title: '延迟', dataIndex: 'latencyMs', render: (v) => (v != null ? `${v}ms` : '-') },
            {
              title: '状态',
              dataIndex: 'status',
              render: (v: number) =>
                v < 400 ? <Tag color="green">{v}</Tag> : <Tag color="red">{v}</Tag>,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
