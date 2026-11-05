import { useState } from 'react';
import { App, Button, Card, DatePicker, Select, Space, Table, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { channelsApi, usageApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import QueryError from '../components/QueryError';
import { downloadBlob } from '../utils/csv';
import { formatCny, formatMoney, useCurrency } from '../utils/format';
import type { ReconciliationRow } from '../api/types';

/** 渠道×模型×日 对账：与上游账号账单按日/渠道核对（管理员全量，普通用户仅自己的渠道） */
export default function ReconciliationPage() {
  const { t } = useTranslation();
  useCurrency(); // 订阅展示币种：切换后金额列/合计刷新
  const { message } = App.useApp();
  const [range, setRange] = useState<[string, string] | null>(null);
  const [channelId, setChannelId] = useState<string | undefined>(undefined);

  const channelsQ = useQuery({
    queryKey: ['channels', 'reconciliation'],
    queryFn: ({ signal }) => channelsApi.list({ page: 1, pageSize: 100 }, signal),
  });
  const channels = channelsQ.data?.items ?? [];

  const rowsQ = useQuery({
    queryKey: ['usage', 'reconciliation', range, channelId],
    queryFn: ({ signal }) =>
      usageApi.reconciliationRows({ from: range?.[0], to: range?.[1], channelId }, signal),
  });
  const rows = rowsQ.data ?? [];

  const totals = rows.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      errors: acc.errors + r.errors,
      tokens: acc.tokens + r.total_tokens,
      cost: acc.cost + Number(r.cost_usd),
      billed: acc.billed + Number(r.billed_usd),
      costCny: acc.costCny + (r.cost_cny != null ? Number(r.cost_cny) : 0),
      billedCny: acc.billedCny + (r.billed_cny != null ? Number(r.billed_cny) : 0),
    }),
    { requests: 0, errors: 0, tokens: 0, cost: 0, billed: 0, costCny: 0, billedCny: 0 },
  );
  // 汇率快照缺失（历史日无快照且实时汇率不可用）时人民币列为 null：合计也不臆造
  const hasCny = rows.some((r) => r.cost_cny != null);

  const exportCsv = async () => {
    try {
      const blob = await usageApi.reconciliation({
        from: range?.[0],
        to: range?.[1],
        channelId,
      });
      downloadBlob('reconciliation.csv', blob);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <Card
      title={t('reconciliation.title')}
      extra={
        <Space wrap>
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
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t('reconciliation.channel')}
            style={{ width: 200 }}
            value={channelId}
            onChange={(v) => setChannelId(v ?? undefined)}
            options={channels.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => rowsQ.refetch()}>
            {t('reconciliation.refresh')}
          </Button>
          <Button onClick={exportCsv}>{t('reconciliation.export')}</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('reconciliation.help')}
      </Typography.Paragraph>

      <Space size={24} wrap style={{ marginBottom: 12 }}>
        <span>
          {t('reconciliation.requests')}: <strong>{totals.requests}</strong>
        </span>
        <span>
          {t('reconciliation.errors')}: <strong>{totals.errors}</strong>
        </span>
        <span>
          {t('reconciliation.tokens')}: <strong>{totals.tokens}</strong>
        </span>
        <span>
          {t('reconciliation.cost')}: <strong>{formatMoney(totals.cost)}</strong>
        </span>
        <span>
          {t('reconciliation.billed')}: <strong>{formatMoney(totals.billed)}</strong>
        </span>
        <span>
          {t('reconciliation.costCny')}: <strong>{hasCny ? formatCny(totals.costCny) : '—'}</strong>
        </span>
        <span>
          {t('reconciliation.billedCny')}:{' '}
          <strong>{hasCny ? formatCny(totals.billedCny) : '—'}</strong>
        </span>
      </Space>

      <QueryError show={rowsQ.isError} onRetry={() => rowsQ.refetch()} />

      <Table<ReconciliationRow>
        rowKey={(r) => `${r.day}|${r.channel}|${r.model}`}
        loading={rowsQ.isLoading}
        dataSource={rows}
        size="small"
        scroll={{ x: 1900 }}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('reconciliation.day'), dataIndex: 'day', width: 110 },
          {
            title: t('reconciliation.channelCol'),
            dataIndex: 'channel',
            width: 180,
            ellipsis: true,
          },
          { title: t('reconciliation.model'), dataIndex: 'model', width: 160, ellipsis: true },
          { title: t('reconciliation.requests'), dataIndex: 'requests', width: 90 },
          { title: t('reconciliation.ok'), dataIndex: 'ok', width: 70 },
          { title: t('reconciliation.errors'), dataIndex: 'errors', width: 80 },
          { title: t('reconciliation.prompt'), dataIndex: 'prompt_tokens', width: 120 },
          { title: t('reconciliation.completion'), dataIndex: 'completion_tokens', width: 120 },
          { title: t('reconciliation.cacheRead'), dataIndex: 'cache_read_tokens', width: 120 },
          { title: t('reconciliation.total'), dataIndex: 'total_tokens', width: 120 },
          {
            title: t('reconciliation.cost'),
            dataIndex: 'cost_usd',
            width: 140,
            render: (v: string) => formatMoney(v),
          },
          {
            title: t('reconciliation.billed'),
            dataIndex: 'billed_usd',
            width: 140,
            render: (v: string) => formatMoney(v),
          },
          {
            title: t('reconciliation.costCny'),
            dataIndex: 'cost_cny',
            width: 130,
            render: (v: string | null) => formatCny(v),
          },
          {
            title: t('reconciliation.billedCny'),
            dataIndex: 'billed_cny',
            width: 130,
            render: (v: string | null) => formatCny(v),
          },
          {
            title: t('reconciliation.fxRate'),
            dataIndex: 'fx_rate',
            width: 160,
            render: (v: string | null) => (v == null ? '—' : Number(v).toFixed(4)),
          },
          { title: t('reconciliation.byokRequests'), dataIndex: 'byok_requests', width: 110 },
          {
            title: t('reconciliation.byokCost'),
            dataIndex: 'byok_cost_usd',
            width: 140,
            render: (v: string) => formatMoney(v),
          },
        ]}
      />
    </Card>
  );
}
