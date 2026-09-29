import { useState } from 'react';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { usageApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { formatCredits } from '../utils/format';
import { downloadCsv, toCsv } from '../utils/csv';
import type { UsageAnalytics } from '../api/types';

type KeyRow = UsageAnalytics['byApiKey'][number];
type ModelRow = UsageAnalytics['byModel'][number];
type ChannelRow = UsageAnalytics['byChannel'][number];

const costCol = (title: string, dataIndex: string, width = 120) => ({
  title,
  dataIndex,
  width,
  render: (v: number) => formatCredits(v),
});

export default function UsageStatsPage() {
  const { t: tr } = useTranslation();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [all, setAll] = useState(false);
  const [range, setRange] = useState<[string, string] | null>(null);

  const scope = isAdmin && all ? 'all' : undefined;

  const { data, isLoading } = useQuery({
    queryKey: ['usage', 'stats', scope, range],
    queryFn: ({ signal }) =>
      usageApi.analytics(30, scope, signal, undefined, range?.[0], range?.[1]),
  });

  const t = data?.totals;

  const exportKeys = () => {
    const rows = data?.byApiKey ?? [];
    const csv = toCsv<KeyRow>(
      [
        { label: 'Key', value: (r) => r.name },
        { label: tr('usage.csv.prefix'), value: (r) => r.keyPrefix },
        { label: tr('usage.requests'), value: (r) => r.requests },
        { label: 'Token', value: (r) => r.tokens },
        { label: tr('usage.csv.billedCost'), value: (r) => (r.billedCost * 100).toFixed(2) },
        { label: tr('usage.csv.byokCost'), value: (r) => ((r.cost - r.billedCost) * 100).toFixed(2) },
        ...(isAdmin
          ? [
              {
                label: tr('usage.csv.upstreamCost'),
                value: (r: KeyRow) => (r.billedUpstreamCost * 100).toFixed(2),
              },
              { label: tr('usage.csv.margin'), value: (r: KeyRow) => (r.margin * 100).toFixed(2) },
            ]
          : []),
      ],
      rows,
    );
    downloadCsv('usage-by-key.csv', csv);
  };

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card
        title={tr('usage.title')}
        extra={
          <Space>
            <DatePicker.RangePicker
              onChange={(dates) => {
                if (!dates || !dates[0] || !dates[1]) {
                  setRange(null);
                  return;
                }
                setRange([
                  dates[0].startOf('day').toISOString(),
                  dates[1].endOf('day').toISOString(),
                ]);
              }}
            />
            {isAdmin && (
              <span>
                {tr('usage.viewAllUsers')} <Switch checked={all} onChange={setAll} />
              </span>
            )}
            <Button onClick={exportKeys}>{tr('usage.exportCsv')}</Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {tr('usage.help')}
        </Typography.Paragraph>
        <Row gutter={16}>
          <Col xs={12} md={4}>
            <Statistic title={tr('usage.requests')} value={t?.requests ?? 0} loading={isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title={tr('usage.successErrors')} value={`${t?.success ?? 0} / ${t?.errors ?? 0}`} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="Token" value={t?.tokens ?? 0} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title={tr('usage.costBilled')} value={formatCredits(t?.billedCost ?? 0)} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title={tr('usage.byokNotCharged')}
              value={formatCredits((t?.cost ?? 0) - (t?.billedCost ?? 0))}
              valueStyle={{ color: 'var(--text-3)' }}
            />
          </Col>
          {isAdmin && (
            <>
              <Col xs={12} md={4}>
                <Statistic title={tr('usage.costPaid')} value={formatCredits(t?.billedUpstreamCost ?? 0)} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic
                  title={tr('usage.margin')}
                  value={formatCredits(t?.margin ?? 0)}
                  valueStyle={{ color: (t?.margin ?? 0) >= 0 ? 'var(--ok)' : 'var(--err)' }}
                />
              </Col>
            </>
          )}
        </Row>
      </Card>

      <Card title={tr('usage.byApiKey')} size="small">
        <Table<KeyRow>
          rowKey={(r) => r.apiKeyId ?? r.name}
          size="small"
          loading={isLoading}
          dataSource={data?.byApiKey ?? []}
          pagination={false}
          scroll={{ x: 800 }}
          columns={[
            {
              title: 'Key',
              render: (_, r) => (
                <Space>
                  <span>{r.name}</span>
                  {r.keyPrefix && <Tag>{`${r.keyPrefix}...`}</Tag>}
                </Space>
              ),
            },
            { title: tr('usage.requests'), dataIndex: 'requests', width: 90 },
            { title: 'Token', dataIndex: 'tokens', width: 130 },
                        costCol(tr('usage.costBilled'), 'billedCost'),
            ...(isAdmin
              ? [costCol(tr('usage.costPaid'), 'billedUpstreamCost'), costCol(tr('usage.margin'), 'margin')]
              : []),
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title={tr('usage.byModel')} size="small">
            <Table<ModelRow>
              rowKey={(r) => r.model}
              size="small"
              loading={isLoading}
              dataSource={data?.byModel ?? []}
              pagination={false}
              scroll={{ x: 560 }}
              columns={[
                { title: tr('common.model'), dataIndex: 'model', ellipsis: true },
                { title: tr('usage.requests'), dataIndex: 'requests', width: 80 },
                { title: 'Token', dataIndex: 'tokens', width: 120 },
                            costCol(tr('usage.costBilled'), 'billedCost'),
                ...(isAdmin ? [costCol(tr('usage.margin'), 'margin')] : []),
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={tr('usage.byChannel')} size="small">
            <Table<ChannelRow>
              rowKey={(r) => r.channelId ?? r.name}
              size="small"
              loading={isLoading}
              dataSource={data?.byChannel ?? []}
              pagination={false}
              scroll={{ x: 740 }}
              columns={[
                { title: tr('usage.column.channel'), dataIndex: 'name', ellipsis: true },
                { title: tr('usage.requests'), dataIndex: 'requests', width: 80 },
                { title: 'Token', dataIndex: 'tokens', width: 120 },
                {
                  title: tr('usage.column.errors'),
                  dataIndex: 'errors',
                  width: 70,
                  render: (v: number) =>
                    v > 0 ? <span style={{ color: '#cf1322' }}>{v}</span> : v,
                },
                {
                  title: tr('usage.column.avgLatency'),
                  dataIndex: 'avgLatency',
                  width: 95,
                  render: (v: number) => `${v}ms`,
                },
                            costCol(tr('usage.costBilled'), 'billedCost'),
                ...(isAdmin ? [costCol(tr('usage.margin'), 'margin')] : []),
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
