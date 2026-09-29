import { useState } from 'react';
import { Card, Input, Table, Tag, Tooltip, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { auditApi } from '../api/endpoints';
import { formatDateTime } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { AuditLog } from '../api/types';

export default function AuditLogsPage() {
  const { t } = useTranslation();
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', action, page, pageSize],
    queryFn: ({ signal }) => auditApi.list(page, pageSize, action || undefined, signal),
  });

  usePageClamp(page, setPage, data);

  return (
    <Card
      title={t('admin.audit.title')}
      extra={
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('admin.audit.filterPlaceholder')}
          style={{ width: 240 }}
          onPressEnter={(e) => {
            setAction((e.target as HTMLInputElement).value);
            setPage(1);
          }}
        />
      }
    >
      <Table<AuditLog>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        scroll={{ x: 1000 }}
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
            title: t('common.time'),
            dataIndex: 'createdAt',
            width: 180,
            render: (v: string) => formatDateTime(v),
          },
          {
            title: t('admin.audit.column.actor'),
            render: (_, r) =>
              r.actorName ? (
                <span>
                  {r.actorName}
                  {r.actorRole === 'ADMIN' && <Tag color="gold" style={{ marginLeft: 6 }}>{t('admin.audit.adminTag')}</Tag>}
                </span>
              ) : (
                <Typography.Text type="secondary">{t('admin.audit.anonymous')}</Typography.Text>
              ),
          },
          {
            title: t('common.action'),
            dataIndex: 'action',
            render: (v: string) => <code>{v}</code>,
          },
          {
            title: t('common.status'),
            dataIndex: 'statusCode',
            render: (v: number | null) =>
              v == null ? '-' : v < 400 ? <Tag color="green">{v}</Tag> : <Tag color="red">{v}</Tag>,
          },
          { title: t('admin.audit.column.ip'), dataIndex: 'ip', render: (v) => v ?? '-' },
          {
            title: t('admin.audit.column.path'),
            dataIndex: 'path',
            ellipsis: true,
            render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : '-'),
          },
        ]}
      />
    </Card>
  );
}
