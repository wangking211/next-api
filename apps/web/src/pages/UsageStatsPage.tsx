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
        { label: '前缀', value: (r) => r.keyPrefix },
        { label: '请求', value: (r) => r.requests },
        { label: 'Token', value: (r) => r.tokens },
        { label: '费用-实扣(积分)', value: (r) => (r.billedCost * 100).toFixed(2) },
        { label: 'BYOK折算-不扣费(积分)', value: (r) => ((r.cost - r.billedCost) * 100).toFixed(2) },
        ...(isAdmin
          ? [
              {
                label: '成本-实付(积分)',
                value: (r: KeyRow) => (r.billedUpstreamCost * 100).toFixed(2),
              },
              { label: '毛利(积分)', value: (r: KeyRow) => (r.margin * 100).toFixed(2) },
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
        title="使用统计"
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
                查看全部用户 <Switch checked={all} onChange={setAll} />
              </span>
            )}
            <Button onClick={exportKeys}>导出 CSV</Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          不选时间段默认统计近 30 天。按 API Key 汇总每个 Key 的累计请求、Token 与费用。
          「费用（实扣）」与余额扣款同口径；BYOK 自带密钥的调用不扣积分，其折算金额单列显示。
        </Typography.Paragraph>
        <Row gutter={16}>
          <Col xs={12} md={4}>
            <Statistic title="请求" value={t?.requests ?? 0} loading={isLoading} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="成功 / 失败" value={`${t?.success ?? 0} / ${t?.errors ?? 0}`} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="Token" value={t?.tokens ?? 0} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="费用（实扣）" value={formatCredits(t?.billedCost ?? 0)} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="BYOK 折算（不扣费）"
              value={formatCredits((t?.cost ?? 0) - (t?.billedCost ?? 0))}
              valueStyle={{ color: 'var(--text-3)' }}
            />
          </Col>
          {isAdmin && (
            <>
              <Col xs={12} md={4}>
                <Statistic title="成本（实付）" value={formatCredits(t?.billedUpstreamCost ?? 0)} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic
                  title="毛利"
                  value={formatCredits(t?.margin ?? 0)}
                  valueStyle={{ color: (t?.margin ?? 0) >= 0 ? 'var(--ok)' : 'var(--err)' }}
                />
              </Col>
            </>
          )}
        </Row>
      </Card>

      <Card title="按 API Key" size="small">
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
            { title: '请求', dataIndex: 'requests', width: 90 },
            { title: 'Token', dataIndex: 'tokens', width: 130 },
                        costCol('费用（实扣）', 'billedCost'),
            ...(isAdmin
              ? [costCol('成本（实付）', 'billedUpstreamCost'), costCol('毛利', 'margin')]
              : []),
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="按模型" size="small">
            <Table<ModelRow>
              rowKey={(r) => r.model}
              size="small"
              loading={isLoading}
              dataSource={data?.byModel ?? []}
              pagination={false}
              scroll={{ x: 560 }}
              columns={[
                { title: '模型', dataIndex: 'model', ellipsis: true },
                { title: '请求', dataIndex: 'requests', width: 80 },
                { title: 'Token', dataIndex: 'tokens', width: 120 },
                            costCol('费用（实扣）', 'billedCost'),
                ...(isAdmin ? [costCol('毛利', 'margin')] : []),
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="按渠道" size="small">
            <Table<ChannelRow>
              rowKey={(r) => r.channelId ?? r.name}
              size="small"
              loading={isLoading}
              dataSource={data?.byChannel ?? []}
              pagination={false}
              scroll={{ x: 560 }}
              columns={[
                { title: '渠道', dataIndex: 'name', ellipsis: true },
                { title: '请求', dataIndex: 'requests', width: 80 },
                { title: 'Token', dataIndex: 'tokens', width: 120 },
                            costCol('费用（实扣）', 'billedCost'),
                ...(isAdmin ? [costCol('毛利', 'margin')] : []),
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
