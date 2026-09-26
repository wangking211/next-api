import { useState } from 'react';
import {
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
import { useQuery } from '@tanstack/react-query';
import { adminApi, usageApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import type { LogFilters, RequestLogRow } from '../api/types';

function TextBlock({ title, text }: { title: string; text: string | null }) {
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text strong>{title}</Typography.Text>
      <pre
        style={{
          marginTop: 6,
          background: '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 6,
          padding: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 320,
          overflow: 'auto',
          fontSize: 13,
        }}
      >
        {text || '（无）'}
      </pre>
    </div>
  );
}

export default function LogsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<LogFilters>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const scope = isAdmin && all ? 'all' : undefined;

  const { data, isLoading } = useQuery({
    queryKey: ['usage', 'logs', page, pageSize, scope, filters],
    queryFn: () => usageApi.logs(page, pageSize, scope, filters),
  });
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['usage', 'log', detailId, scope],
    queryFn: () => usageApi.logDetail(detailId!, scope),
    enabled: !!detailId,
  });
  const { data: userList } = useQuery({
    queryKey: ['admin', 'users', 'for-filter'],
    queryFn: () => adminApi.users(undefined, 1, 100),
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
    setPage(1);
  };

  const reset = () => {
    form.resetFields();
    setFilters({});
    setPage(1);
  };

  return (
    <Card
      title="调用日志"
      extra={
        isAdmin && (
          <span>
            查看全部用户 <Switch checked={all} onChange={setAll} />
          </span>
        )
      }
    >
      <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={apply}>
        <Form.Item name="model">
          <Input allowClear placeholder="模型名" style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="status">
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 110 }}
            options={[
              { value: 'success', label: '成功' },
              { value: 'error', label: '失败' },
            ]}
          />
        </Form.Item>
        <Form.Item name="stream">
          <Select
            allowClear
            placeholder="类型"
            style={{ width: 110 }}
            options={[
              { value: true, label: '流式' },
              { value: false, label: '非流式' },
            ]}
          />
        </Form.Item>
        {isAdmin && all && (
          <Form.Item name="userId">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="用户"
              style={{ width: 160 }}
              options={(userList?.items ?? []).map((u) => ({
                value: u.id,
                label: u.username,
              }))}
            />
          </Form.Item>
        )}
        <Form.Item name="q">
          <Input allowClear placeholder="内容关键词" style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="range">
          <DatePicker.RangePicker showTime style={{ width: 340 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button icon={<ReloadOutlined />} onClick={reset}>
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      <Table<RequestLogRow>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        scroll={{ x: 1200 }}
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
            width: 170,
            render: (v: string) => new Date(v).toLocaleString(),
          },
          { title: '模型', dataIndex: 'model' },
          { title: '服务商', dataIndex: 'provider', render: (v: string | null) => v ?? '-' },
          { title: 'Key', render: (_, r) => r.apiKey?.name ?? '-' },
          { title: '渠道', render: (_, r) => r.channel?.name ?? '-' },
          {
            title: '类型',
            dataIndex: 'isStream',
            width: 70,
            render: (v: boolean) => (v ? <Tag>流式</Tag> : <Tag>非流式</Tag>),
          },
          {
            title: 'Tokens',
            render: (_, r) => (
              <Tooltip title={`输入 ${r.promptTokens} / 输出 ${r.completionTokens}`}>
                {r.totalTokens}
              </Tooltip>
            ),
          },
          { title: '费用', dataIndex: 'cost', render: (v: string) => `$${Number(v).toFixed(6)}` },
          { title: '延迟', dataIndex: 'latencyMs', render: (v: number | null) => (v != null ? `${v}ms` : '-') },
          {
            title: '状态',
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
            title: '操作',
            fixed: 'right',
            width: 80,
            render: (_, r) => (
              <Button size="small" onClick={() => setDetailId(r.id)}>
                详情
              </Button>
            ),
          },
        ]}
      />

      <Drawer title="调用详情" width={760} open={!!detailId} onClose={() => setDetailId(null)}>
        {detailLoading || !detail ? (
          <Spin />
        ) : (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="时间">
                {new Date(detail.createdAt).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="模型">{detail.model}</Descriptions.Item>
              <Descriptions.Item label="服务商">{detail.provider ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="渠道">{detail.channel?.name ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Key">{detail.apiKey?.name ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="类型">
                {detail.isStream ? '流式' : '非流式'}
              </Descriptions.Item>
              <Descriptions.Item label="输入/输出 Tokens">
                {detail.promptTokens} / {detail.completionTokens}
              </Descriptions.Item>
              <Descriptions.Item label="总 Tokens">{detail.totalTokens}</Descriptions.Item>
              <Descriptions.Item label="费用">
                ${Number(detail.cost).toFixed(6)}
              </Descriptions.Item>
              <Descriptions.Item label="延迟">
                {detail.latencyMs != null ? `${detail.latencyMs}ms` : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                {detail.status < 400 ? (
                  <Tag color="green">{detail.status}</Tag>
                ) : (
                  <Tag color="red">{detail.status}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="日志 ID">{detail.id}</Descriptions.Item>
            </Descriptions>
            {detail.errorMessage && <TextBlock title="错误信息" text={detail.errorMessage} />}
            <TextBlock title="输入（请求 messages）" text={detail.requestPreview} />
            <TextBlock title="输出（模型回复）" text={detail.responsePreview} />
          </>
        )}
      </Drawer>
    </Card>
  );
}
