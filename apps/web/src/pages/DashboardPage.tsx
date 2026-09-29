import { useState } from 'react';
import { Alert, Button, Card, Col, Row, Switch, Table, Tag, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { usageApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { toCredits } from '../utils/format';
import type { RequestLogRow } from '../api/types';
import { StatCard } from './dashboard/StatCard';
import { RankList } from './dashboard/RankBar';
import { DailyBars } from './dashboard/DailyBars';
import { PageHeader } from './dashboard/PageHeader';

export default function DashboardPage() {
  const { t } = useTranslation();
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
  /** 折算总额与实扣的差额即 BYOK（自带密钥）未计费的部分 */
  const byokNote = (cost: number, billed: number) =>
    cost - billed > 0.0000005
      ? ` · ${t('dashboard.rank.byokNote', { value: toCredits(cost - billed).toFixed(2) })}`
      : '';

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      {isError && (
        <Alert
          type="error"
          showIcon
          message={t('dashboard.alert.errorTitle')}
          description={t('dashboard.alert.errorDesc')}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      <PageHeader
        title={t('dashboard.header.title')}
        extra={
          isAdmin && (
            <span style={{ color: 'var(--text-2)' }}>
              {t('dashboard.header.viewAllUsers')} <Switch checked={all} onChange={setAll} />
            </span>
          )
        }
      />

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <StatCard label={t('dashboard.stat.requests')} value={summary?.requests ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label={t('dashboard.stat.successRate')} value={successRate} suffix="%" />
        </Col>
        <Col xs={12} md={6}>
          <StatCard label={t('dashboard.stat.totalTokens')} value={summary?.totalTokens ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard
            label={t('dashboard.stat.billedCost')}
            value={toCredits(summary?.billedCost ?? 0).toFixed(2)}
            suffix={t('dashboard.unit.credits')}
          />
        </Col>
        {isAdmin && (
          <Col xs={12} md={6}>
            <StatCard
              label={t('dashboard.stat.grossProfit')}
              value={toCredits(margin).toFixed(2)}
              suffix={t('dashboard.unit.credits')}
              valueColor={margin >= 0 ? 'var(--ok)' : 'var(--err)'}
            />
          </Col>
        )}
      </Row>

      <Card title={t('dashboard.card.dailyTokens')}>
        <DailyBars rows={daily} />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <RankList
            title={t('dashboard.rank.byModel')}
            items={(analytics?.byModel ?? []).map((m) => ({
              key: m.model,
              label: m.model,
              value: m.tokens,
              sub: `· ${t('common.creditsValue', { value: toCredits(m.billedCost).toFixed(2) })}${byokNote(
                m.cost,
                m.billedCost,
              )}${isAdmin ? ` · ${t('dashboard.stat.grossProfit')} ${toCredits(m.margin).toFixed(2)}` : ''} · ${t('dashboard.rank.failed')} ${m.errors}`,
            }))}
          />
        </Col>
        <Col xs={24} md={8}>
          <RankList
            title={t('dashboard.rank.byChannel')}
            items={(analytics?.byChannel ?? []).map((c) => ({
              key: c.channelId ?? c.name,
              label: `${c.name}${c.provider ? ` (${c.provider})` : ''}`,
              value: c.tokens,
              sub: `· ${t('common.creditsValue', { value: toCredits(c.billedCost).toFixed(2) })}${byokNote(
                c.cost,
                c.billedCost,
              )}${isAdmin ? ` · ${t('dashboard.stat.grossProfit')} ${toCredits(c.margin).toFixed(2)}` : ''}`,
            }))}
          />
        </Col>
        {(analytics?.byUser?.length ?? 0) > 0 && (
          <Col xs={24} md={8}>
            <RankList
              title={t('dashboard.rank.byUser')}
              items={(analytics?.byUser ?? []).map((u) => ({
                key: u.userId,
                label: u.name,
                value: u.tokens,
                sub: `· ${t('common.creditsValue', { value: toCredits(u.billedCost).toFixed(2) })}${byokNote(
                  u.cost,
                  u.billedCost,
                )}${isAdmin ? ` · ${t('dashboard.stat.grossProfit')} ${toCredits(u.margin).toFixed(2)}` : ''}`,
              }))}
            />
          </Col>
        )}
      </Row>

      <Card title={t('dashboard.card.recentCalls')}>
        <Table<RequestLogRow>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={logs?.items ?? []}
          columns={[
            {
              title: t('common.time'),
              dataIndex: 'createdAt',
              render: (v: string) => new Date(v).toLocaleString(),
            },
            { title: t('common.model'), dataIndex: 'model' },
            { title: 'Key', render: (_, r) => r.apiKey?.name ?? '-' },
            { title: t('dashboard.table.channel'), render: (_, r) => r.channel?.name ?? '-' },
            { title: 'Tokens', dataIndex: 'totalTokens' },
            { title: t('dashboard.table.latency'), dataIndex: 'latencyMs', render: (v) => (v != null ? `${v}ms` : '-') },
            {
              title: t('common.status'),
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
