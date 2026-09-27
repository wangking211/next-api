import { useState } from 'react';
import { App, Button, Card, Popconfirm, Segmented, Space, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { withdrawalsApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { formatCredits, formatDateTime } from '../utils/format';
import { downloadCsv, toCsv } from '../utils/csv';
import type { Withdrawal, WithdrawalStatus } from '../api/types';

export default function AdminWithdrawalsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<WithdrawalStatus | 'ALL'>('PENDING');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'withdrawals', status],
    queryFn: ({ signal }) =>
      withdrawalsApi.listAll(status === 'ALL' ? undefined : status, signal),
  });

  const reviewMut = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'APPROVE' | 'REJECT' }) =>
      withdrawalsApi.review(id, action),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['admin', 'withdrawals'] });
      message.success(v.action === 'APPROVE' ? '已通过' : '已驳回并退回余额');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Card
      title="提现管理"
      extra={
        <Space>
          <Segmented
            value={status}
            onChange={(v) => setStatus(v as WithdrawalStatus | 'ALL')}
            options={[
              { label: '待审批', value: 'PENDING' },
              { label: '已通过', value: 'APPROVED' },
              { label: '已驳回', value: 'REJECTED' },
              { label: '全部', value: 'ALL' },
            ]}
          />
          <Button
            onClick={() =>
              downloadCsv(
                'withdrawals.csv',
                toCsv<Withdrawal>(
                  [
                    { label: '时间', value: (r) => formatDateTime(r.createdAt) },
                    { label: '用户', value: (r) => r.user?.username ?? r.userId },
                    { label: '金额(积分)', value: (r) => (Number(r.amount) * 100).toFixed(2) },
                    { label: '状态', value: (r) => r.status },
                    { label: '备注', value: (r) => r.note ?? '' },
                  ],
                  data ?? [],
                ),
              )
            }
          >
            导出 CSV
          </Button>
        </Space>
      }
    >
      <Table<Withdrawal>
        rowKey="id"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        scroll={{ x: 900 }}
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 180,
            render: (v: string) => formatDateTime(v),
          },
          {
            title: '用户',
            render: (_, r) => r.user?.username ?? r.userId,
          },
          {
            title: '金额',
            dataIndex: 'amount',
            width: 130,
            render: (v: string) => formatCredits(v),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (v: string) =>
              v === 'APPROVED' ? (
                <Tag color="green">已通过</Tag>
              ) : v === 'REJECTED' ? (
                <Tag color="red">已驳回</Tag>
              ) : (
                <Tag color="orange">待审批</Tag>
              ),
          },
          { title: '备注', dataIndex: 'note', render: (v) => v ?? '-' },
          {
            title: '操作',
            fixed: 'right',
            width: 170,
            render: (_, r) =>
              r.status === 'PENDING' ? (
                <Space>
                  <Popconfirm
                    title={`确认通过并打款 ${formatCredits(r.amount)}？`}
                    onConfirm={() => reviewMut.mutate({ id: r.id, action: 'APPROVE' })}
                  >
                    <Button size="small" type="primary">
                      通过
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title="驳回并退回余额？"
                    onConfirm={() => reviewMut.mutate({ id: r.id, action: 'REJECT' })}
                  >
                    <Button size="small" danger>
                      驳回
                    </Button>
                  </Popconfirm>
                </Space>
              ) : (
                '-'
              ),
          },
        ]}
      />
    </Card>
  );
}
