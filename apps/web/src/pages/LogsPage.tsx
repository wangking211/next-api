import { useState } from 'react';
import {
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { adminApi, usageApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatCredits } from '../utils/format';
import { downloadBlob } from '../utils/csv';
import { usePageClamp } from '../hooks/usePageClamp';
import { usePagination } from '../hooks/usePagination';
import QueryError from '../components/QueryError';
import type { LogFilters, RequestLogRow } from '../api/types';

function TextBlock({ title, text }: { title: string; text: string | null }) {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text strong>{title}</Typography.Text>
      <pre
        style={{
          marginTop: 6,
          background: 'var(--ink)',
          border: '1px solid var(--ink-border)',
          color: 'var(--ink-text)',
          borderRadius: 6,
          padding: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 320,
          overflow: 'auto',
          fontSize: 13,
        }}
      >
        {text || t('logs.detail.none')}
      </pre>
    </div>
  );
}

export default function LogsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { message } = App.useApp();
  const isAdmin = user?.role === 'ADMIN';
  const [all, setAll] = useState(false);
  const [filters, setFilters] = useState<LogFilters>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const scope = isAdmin && all ? 'all' : undefined;

  const pg = usePagination();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['usage', 'logs', pg.page, pg.pageSize, scope, filters],
    queryFn: ({ signal }) => usageApi.logs(pg.page, pg.pageSize, scope, filters, signal),
    placeholderData: keepPreviousData,
  });

  usePageClamp(pg.page, pg.setPage, data);
  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailErr,
    refetch: detailRefetch,
  } = useQuery({
    queryKey: ['usage', 'log', detailId, scope],
    queryFn: ({ signal }) => usageApi.logDetail(detailId!, scope, signal),
    enabled: !!detailId,
  });
  const { data: userList } = useQuery({
    queryKey: ['admin', 'users', 'for-filter'],
    queryFn: ({ signal }) => adminApi.users({ page: 1, pageSize: 100 }, signal),
    enabled: !!isAdmin,
  });

  const apply = (v: any) => {
    setFilters({
      model: v.model || undefined,
      status: v.status || undefined,
      stream: v.stream,
      q: v.q || undefined,
      userId: v.userId || undefined,
      from: v.range?.[0]?.toISOString(),
      to: v.range?.[1]?.toISOString(),
    });
    pg.reset();
  };

  const reset = () => {
    form.resetFields();
    setFilters({});
    pg.reset();
  };

  const exportCsv = async () => {
    try {
      const blob = await usageApi.exportLogs({ scope, ...filters });
      downloadBlob('request-logs.csv', blob);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <Card
      title={t('logs.title')}
      extra={
        isAdmin && (
          <span>
            {t('logs.viewAllUsers')}{' '}
            <Switch
              checked={all}
              onChange={(checked) => {
                setAll(checked);
                // 「按用户筛选」只属于全量侧：切换范围时清掉该字段（含隐藏状态）并回第一页，
                // 否则 userId 会带着 scope 一起查（后端 userId 优先于 scope），看到的是另一侧的数据
                form.setFieldValue('userId', undefined);
                setFilters((f) => ({ ...f, userId: undefined }));
                pg.reset();
              }}
            />
          </span>
        )
      }
    >
      <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={apply}>
        <Form.Item name="model">
          <Input allowClear placeholder={t('logs.filter.model')} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="status">
          <Select
            allowClear
            placeholder={t('common.status')}
            style={{ width: 110 }}
            options={[
              { value: 'success', label: t('logs.filter.success') },
              { value: 'error', label: t('logs.filter.error') },
            ]}
          />
        </Form.Item>
        <Form.Item name="stream">
          <Select
            allowClear
            placeholder={t('logs.filter.type')}
            style={{ width: 110 }}
            options={[
              { value: true, label: t('logs.stream') },
              { value: false, label: t('logs.nonStream') },
            ]}
          />
        </Form.Item>
        {isAdmin && all && (
          <Form.Item name="userId">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('common.user')}
              style={{ width: 160 }}
              options={(userList?.items ?? []).map((u) => ({
                value: u.id,
                label: u.username,
              }))}
            />
          </Form.Item>
        )}
        <Form.Item name="q">
          <Input allowClear placeholder={t('logs.filter.keyword')} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="range">
          <DatePicker.RangePicker showTime style={{ width: 340 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              {t('logs.filter.submit')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={reset}>
              {t('logs.filter.reset')}
            </Button>
            <Button onClick={exportCsv}>{t('logs.exportCsv')}</Button>
          </Space>
        </Form.Item>
      </Form>

      <QueryError show={isError} onRetry={refetch} />

      <Table<RequestLogRow>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        scroll={{ x: 1200 }}
        pagination={pg.pagination(data?.total)}
        columns={[
          {
            title: t('common.time'),
            dataIndex: 'createdAt',
            width: 170,
            render: (v: string) => formatDateTime(v),
          },
          { title: t('common.model'), dataIndex: 'model' },
          {
            title: t('logs.column.provider'),
            dataIndex: 'provider',
            render: (v: string | null) => v ?? '-',
          },
          { title: 'Key', render: (_, r) => r.apiKey?.name ?? '-' },
          { title: t('logs.column.channel'), render: (_, r) => r.channel?.name ?? '-' },
          {
            title: t('logs.column.type'),
            dataIndex: 'isStream',
            width: 70,
            render: (v: boolean) =>
              v ? <Tag>{t('logs.stream')}</Tag> : <Tag>{t('logs.nonStream')}</Tag>,
          },
          {
            title: 'Tokens',
            render: (_, r) => (
              <Tooltip
                title={t('logs.tokensInOut', {
                  prompt: r.promptTokens,
                  completion: r.completionTokens,
                })}
              >
                {r.totalTokens}
              </Tooltip>
            ),
          },
          {
            title: t('logs.column.cost'),
            dataIndex: 'cost',
            width: 130,
            render: (v: string, r) =>
              r.chargeable ? (
                formatCredits(v)
              ) : (
                <Tooltip title={t('logs.byokTip', { value: formatCredits(v) })}>
                  <Tag>{t('logs.notBilled')}</Tag>
                </Tooltip>
              ),
          },
          {
            title: t('logs.column.latency'),
            dataIndex: 'latencyMs',
            render: (v: number | null) => (v != null ? `${v}ms` : '-'),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (v: number, r) =>
              v < 400 ? (
                <Tag color="green">{v}</Tag>
              ) : (
                <Tooltip title={r.errorMessage}>
                  <Tag color="red">{v}</Tag>
                </Tooltip>
              ),
          },
          {
            title: t('common.action'),
            fixed: 'right',
            width: 80,
            render: (_, r) => (
              <Button size="small" onClick={() => setDetailId(r.id)}>
                {t('logs.detail.open')}
              </Button>
            ),
          },
        ]}
      />

      <Drawer
        title={t('logs.detail.title')}
        width={760}
        open={!!detailId}
        onClose={() => setDetailId(null)}
      >
        {detailErr ? (
          // 查询失败不能停在 Spin 上（!detail 永远为真 → 永久转圈），给出重试入口
          <QueryError show onRetry={detailRefetch} />
        ) : detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label={t('common.time')}>
                {formatDateTime(detail.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.model')}>{detail.model}</Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.provider')}>
                {detail.provider ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.channel')}>
                {detail.channel?.name ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Key">{detail.apiKey?.name ?? '-'}</Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.type')}>
                {detail.isStream ? t('logs.stream') : t('logs.nonStream')}
              </Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.ioTokens')}>
                {detail.promptTokens} / {detail.completionTokens}
              </Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.totalTokens')}>
                {detail.totalTokens}
              </Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.cost')}>
                {detail.chargeable ? (
                  formatCredits(detail.cost)
                ) : (
                  <Tooltip title={t('logs.byokTip', { value: formatCredits(detail.cost) })}>
                    <Tag>{t('logs.notBilled')}</Tag>
                  </Tooltip>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.latency')}>
                {detail.latencyMs != null ? `${detail.latencyMs}ms` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.status')}>
                {detail.status < 400 ? (
                  <Tag color="green">{detail.status}</Tag>
                ) : (
                  <Tag color="red">{detail.status}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('logs.detail.id')}>{detail.id}</Descriptions.Item>
            </Descriptions>
            {detail.errorMessage && (
              <TextBlock title={t('logs.detail.error')} text={detail.errorMessage} />
            )}
            <TextBlock title={t('logs.detail.request')} text={detail.requestPreview} />
            <TextBlock title={t('logs.detail.response')} text={detail.responsePreview} />
          </>
        )}
      </Drawer>
    </Card>
  );
}
