import { useState } from 'react';
import { Card, Col, Empty, Row, Statistic, Switch, Table, Tag, Typography, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { usageApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import type { UsageDailyRow, RequestLogRow } from '../api/types';

const { Text } = Typography;

function DailyBars({ rows }: { rows: UsageDailyRow[] }) {
  if (!rows.length) return <Empty description="暂无用量数据" />;
  const max = Math.max(...rows.map((r) => r.totalTokens), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 200, paddingTop: 8 }}>
      {rows.map((r) => {
        const h = Math.max((r.totalTokens / max) * 170, 4);
        return (
          <div
            key={r.date}
            title={`${r.date}\nTokens: ${r.totalTokens}\n请求: ${r.requests}\n费用: $${r.cost}`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
          >
            <div
              style={{
                width: '100%',
                height: h,
                background: 'linear-gradient(180deg,#1677ff,#69b1ff)',
                borderRadius: 4,
              }}
            />
            <Text style={{ fontSize: 10, whiteSpace: 'nowrap' }} type="secondary">
              {r.date.slice(5)}
            </Text>
          </div>
        );
      })}
    </div>
  );
}

interface BarItem {
  key: string;
  label: string;
  value: number;
  sub?: string;
}

function BarList({ title, items }: { title: string; items: BarItem[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <Card title={title} size="small" style={{ height: '100%' }}>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((it) => (
            <div key={it.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span
                  style={{
                    maxWidth: '58%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={it.label}
                >
                  {it.label}
                </span>
                <span style={{ color: '#888' }}>
                  {it.value.toLocaleString()} {it.sub}
                </span>
              </div>
              <div style={{ height: 6, background: '#f0f0f0', borderRadius: 3, marginTop: 4 }}>
                <div
                  style={{
                    height: 6,
                    width: `${(it.value / max) * 100}%`,
                    background: '#1677ff',
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [all, setAll] = useState(false);
  const scope = isAdmin && all ? 'all' : undefined;

  const { data: summary } = useQuery({
    queryKey: ['usage', 'summary', scope],
    queryFn: () => usageApi.summary(30, scope),
  });
  const { data: daily = [] } = useQuery({
    queryKey: ['usage', 'daily', scope],
    queryFn: () => usageApi.daily(30, scope),
  });
  const { data: analytics } = useQuery({
    queryKey: ['usage', 'analytics', scope],
    queryFn: () => usageApi.analytics(30, scope),
  });
  const { data: logs } = useQuery({
    queryKey: ['usage', 'logs', 'recent', scope],
    queryFn: () => usageApi.logs(1, 8, scope),
  });

  const successRate =
    summary && summary.requests > 0
      ? ((summary.successRequests / summary.requests) * 100).toFixed(1)
      : '0.0';

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          总览（近 30 天）
        </Typography.Title>
        {isAdmin && (
          <span>
            查看全部用户 <Switch checked={all} onChange={setAll} />
          </span>
        )}
      </div>

      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="请求数" value={summary?.requests ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="成功率" value={successRate} suffix="%" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic title="Token 总量" value={summary?.totalTokens ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title="费用 (USD)"
              value={Number(summary?.cost ?? 0).toFixed(6)}
              prefix="$"
            />
          </Card>
        </Col>
      </Row>

      <Card title="每日 Token 用量">
        <DailyBars rows={daily} />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <BarList
            title="模型用量（tokens）"
            items={(analytics?.byModel ?? []).map((m) => ({
              key: m.model,
              label: m.model,
              value: m.tokens,
              sub: `· $${m.cost.toFixed(4)} · 失败 ${m.errors}`,
            }))}
          />
        </Col>
        <Col xs={24} md={8}>
          <BarList
            title="渠道用量（tokens）"
            items={(analytics?.byChannel ?? []).map((c) => ({
              key: c.channelId ?? c.name,
              label: `${c.name}${c.provider ? ` (${c.provider})` : ''}`,
              value: c.tokens,
              sub: `· $${c.cost.toFixed(4)}`,
            }))}
          />
        </Col>
        {(analytics?.byUser?.length ?? 0) > 0 && (
          <Col xs={24} md={8}>
            <BarList
              title="用户用量（tokens）"
              items={(analytics?.byUser ?? []).map((u) => ({
                key: u.userId,
                label: u.name,
                value: u.tokens,
                sub: `· $${u.cost.toFixed(4)}`,
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
