import { useState } from 'react';
import { App, Button, Card, Popconfirm, Segmented, Space, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { withdrawalsApi } from '../api/endpoints';
import { formatCredits, formatDateTime } from '../utils/format';
import QueryError from '../components/QueryError';
import { downloadCsv, toCsv } from '../utils/csv';
import type { Withdrawal, WithdrawalStatus } from '../api/types';

export default function AdminWithdrawalsPage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<WithdrawalStatus | 'ALL'>('PENDING');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'withdrawals', status],
    queryFn: ({ signal }) =>
      withdrawalsApi.listAll(status === 'ALL' ? undefined : status, signal),
  });

  const reviewMut = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'APPROVE' | 'REJECT' }) =>
      withdrawalsApi.review(id, action),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['admin', 'withdrawals'] });
      message.success(v.action === 'APPROVE' ? t('common.approved') : t('admin.withdraw.rejectSuccess'));
    },
  });

  return (
    <Card
      title={t('admin.withdraw.title')}
      extra={
        <Space>
          <Segmented
            value={status}
            onChange={(v) => setStatus(v as WithdrawalStatus | 'ALL')}
            options={[
              { label: t('common.pending'), value: 'PENDING' },
              { label: t('common.approved'), value: 'APPROVED' },
              { label: t('common.rejected'), value: 'REJECTED' },
              { label: t('common.all'), value: 'ALL' },
            ]}
          />
          <Button
            onClick={() =>
              downloadCsv(
                'withdrawals.csv',
                toCsv<Withdrawal>(
                  [
                    { label: t('common.time'), value: (r) => formatDateTime(r.createdAt) },
                    { label: t('common.user'), value: (r) => r.user?.username ?? r.userId },
                    { label: t('admin.withdraw.csvAmount'), value: (r) => (Number(r.amount) * 100).toFixed(2) },
                    { label: t('common.status'), value: (r) => r.status },
                    { label: t('common.remark'), value: (r) => r.note ?? '' },
                  ],
                  data ?? [],
                ),
              )
            }
          >
            {t('admin.withdraw.exportCsv')}
          </Button>
        </Space>
      }
    >
      <QueryError show={isError} onRetry={refetch} />

      <Table<Withdrawal>
        rowKey="id"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        scroll={{ x: 900 }}
        columns={[
          {
            title: t('common.time'),
            dataIndex: 'createdAt',
            width: 180,
            render: (v: string) => formatDateTime(v),
          },
          {
            title: t('common.user'),
            render: (_, r) => r.user?.username ?? r.userId,
          },
          {
            title: t('common.amount'),
            dataIndex: 'amount',
            width: 130,
            render: (v: string) => formatCredits(v),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 100,
            render: (v: string) =>
              v === 'APPROVED' ? (
                <Tag color="green">{t('common.approved')}</Tag>
              ) : v === 'REJECTED' ? (
                <Tag color="red">{t('common.rejected')}</Tag>
              ) : (
                <Tag color="orange">{t('common.pending')}</Tag>
              ),
          },
          { title: t('common.remark'), dataIndex: 'note', render: (v) => v ?? '-' },
          {
            title: t('common.action'),
            fixed: 'right',
            width: 170,
            render: (_, r) =>
              r.status === 'PENDING' ? (
                <Space>
                  <Popconfirm
                    title={t('admin.withdraw.approveConfirm', { amount: formatCredits(r.amount) })}
                    onConfirm={() => reviewMut.mutate({ id: r.id, action: 'APPROVE' })}
                  >
                    <Button size="small" type="primary">
                      {t('admin.withdraw.approve')}
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={t('admin.withdraw.rejectConfirm')}
                    onConfirm={() => reviewMut.mutate({ id: r.id, action: 'REJECT' })}
                  >
                    <Button size="small" danger>
                      {t('admin.withdraw.reject')}
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
