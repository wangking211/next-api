import { useState } from 'react';
import { Card, Input, Table, Tag, Tooltip, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { auditApi } from '../api/endpoints';
import { formatDateTime } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import type { AuditLog } from '../api/types';

export default function AuditLogsPage() {
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
      title="操作审计"
      extra={
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="按操作过滤，如 channels"
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
            title: '时间',
            dataIndex: 'createdAt',
            width: 180,
            render: (v: string) => formatDateTime(v),
          },
          {
            title: '操作者',
            render: (_, r) =>
              r.actorName ? (
                <span>
                  {r.actorName}
                  {r.actorRole === 'ADMIN' && <Tag color="gold" style={{ marginLeft: 6 }}>管理员</Tag>}
                </span>
              ) : (
                <Typography.Text type="secondary">匿名</Typography.Text>
              ),
          },
          {
            title: '操作',
            dataIndex: 'action',
            render: (v: string) => <code>{v}</code>,
          },
          {
            title: '状态',
            dataIndex: 'statusCode',
            render: (v: number | null) =>
              v == null ? '-' : v < 400 ? <Tag color="green">{v}</Tag> : <Tag color="red">{v}</Tag>,
          },
          { title: 'IP', dataIndex: 'ip', render: (v) => v ?? '-' },
          {
            title: '路径',
            dataIndex: 'path',
            ellipsis: true,
            render: (v: string | null) => (v ? <Tooltip title={v}>{v}</Tooltip> : '-'),
          },
        ]}
      />
    </Card>
  );
}
