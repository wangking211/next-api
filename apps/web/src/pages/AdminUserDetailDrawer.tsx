import { useEffect } from 'react';
import { Descriptions, Drawer, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { adminApi, usageApi } from '../api/endpoints';
import { formatCredits, formatDateTime, toCredits } from '../utils/format';
import { usePageClamp } from '../hooks/usePageClamp';
import { usePagination } from '../hooks/usePagination';
import type {
  AdminUser,
  ApiKeyInfo,
  ApiKeyStatus,
  BalanceTransaction,
  BalanceTxType,
  RequestLogRow,
} from '../api/types';

interface Props {
  user: AdminUser | null;
  onClose: () => void;
}

const PAGE_SIZE = 6;

/**
 * 用户详情抽屉：一屏看全「基本信息 / Key / 最近调用 / 余额流水」。
 * 数据分别来自 /admin/users/:id/keys、/usage/logs?userId=、/admin/users/:id/transactions。
 */
export default function AdminUserDetailDrawer({ user, onClose }: Props) {
  const { t } = useTranslation();
  const logsPg = usePagination(PAGE_SIZE);
  const txPg = usePagination(PAGE_SIZE);
  const resetPages = logsPg.reset;
  const resetTxPage = txPg.reset;

  // 切换用户时回到第一页
  useEffect(() => {
    resetPages();
    resetTxPage();
  }, [user?.id, resetPages, resetTxPage]);

  const { data: keys, isLoading: keysLoading } = useQuery({
    queryKey: ['admin', 'user-keys', user?.id],
    queryFn: ({ signal }) => adminApi.userKeys(user!.id, signal),
    enabled: !!user,
  });

  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ['admin', 'user-detail-logs', user?.id, logsPg.page],
    queryFn: ({ signal }) =>
      usageApi.logs(logsPg.page, PAGE_SIZE, undefined, { userId: user!.id }, signal),
    enabled: !!user,
  });

  const { data: txs, isLoading: txsLoading } = useQuery({
    queryKey: ['admin', 'user-tx', user?.id, txPg.page],
    queryFn: ({ signal }) => adminApi.userTransactions(user!.id, txPg.page, PAGE_SIZE, signal),
    enabled: !!user,
  });

  // 删除末页最后一条 / 数据变少时自动回退，抽屉里此前缺少这层保护会停在空白表格
  usePageClamp(logsPg.page, logsPg.setPage, logs);
  usePageClamp(txPg.page, txPg.setPage, txs);

  const TX_META: Record<BalanceTxType, { color: string; label: string }> = {
    RECHARGE: { color: 'green', label: t('billing.txnType.recharge') },
    CONSUME: { color: 'blue', label: t('billing.txnType.consume') },
    ADJUST: { color: 'orange', label: t('billing.txnType.adjust') },
    COMMISSION: { color: 'purple', label: t('billing.txnType.commission') },
    TRANSFER: { color: 'geekblue', label: t('billing.txnType.transfer') },
    WITHDRAW: { color: 'volcano', label: t('billing.txnType.withdraw') },
    CHANNEL_REVENUE: { color: 'cyan', label: t('billing.txnType.channelRevenue') },
  };

  const KEY_STATUS: Record<ApiKeyStatus, { color: string; label: string }> = {
    ACTIVE: { color: 'green', label: t('admin.users.detail.keyActive') },
    DISABLED: { color: 'orange', label: t('admin.users.detail.keyDisabled') },
    REVOKED: { color: 'red', label: t('admin.users.detail.keyRevoked') },
  };

  if (!user) return null;

  const roleLabel =
    user.role === 'ADMIN'
      ? t('admin.users.roleAdmin')
      : user.role === 'AGENT'
        ? t('admin.users.roleAgent')
        : t('common.user');
  const multiplier =
    user.priceMultiplier != null
      ? t('admin.users.multiplierCustom', { value: Number(user.priceMultiplier) })
      : user.agent?.priceMultiplier != null
        ? t('admin.users.multiplierAgent', { value: Number(user.agent.priceMultiplier) })
        : '×1';

  const sectionTitle = (label: string, count?: number) => (
    <Typography.Title level={5} style={{ margin: '18px 0 8px' }}>
      {label}
      {count != null && <Typography.Text type="secondary">{` (${count})`}</Typography.Text>}
    </Typography.Title>
  );

  return (
    <Drawer
      open
      onClose={onClose}
      width={880}
      title={`${t('admin.users.detail.title')} - ${user.username}`}
    >
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label={t('admin.users.column.email')}>
          {user.email}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.role')}>
          {roleLabel}
        </Descriptions.Item>
        <Descriptions.Item label={t('common.status')}>
          {user.status === 'ACTIVE' ? (
            <Tag color="green">{t('admin.users.statusActive')}</Tag>
          ) : (
            <Tag color="red">{t('admin.users.statusBanned')}</Tag>
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.balance')}>
          {formatCredits(user.balance)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.group')}>
          {user.group ? user.group.displayName : t('admin.users.groupNone')}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.agent')}>
          {user.agent?.username ?? t('admin.users.agentNone')}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.multiplier')}>
          {multiplier}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.rebate')}>
          {user.rebateRate != null ? `${(Number(user.rebateRate) * 100).toFixed(0)}%` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.lastActive')}>
          {user.lastActiveAt ? formatDateTime(user.lastActiveAt) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.sort.createdAt')}>
          {formatDateTime(user.createdAt)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.users.column.keyChannel')}>
          {`${user._count.apiKeys} / ${user._count.channels}`}
        </Descriptions.Item>
      </Descriptions>

      {sectionTitle(t('admin.users.detail.keys'), keys?.length ?? 0)}
      <Table<ApiKeyInfo>
        size="small"
        rowKey="id"
        loading={keysLoading}
        dataSource={keys ?? []}
        pagination={false}
        scroll={{ y: 240 }}
        locale={{ emptyText: t('admin.users.detail.noKeys') }}
        columns={[
          { title: t('keys.table.name'), dataIndex: 'name', ellipsis: true },
          {
            title: t('admin.users.detail.keyPrefix'),
            dataIndex: 'keyPrefix',
            width: 90,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 80,
            render: (v: ApiKeyStatus) => (
              <Tag color={KEY_STATUS[v]?.color}>{KEY_STATUS[v]?.label ?? v}</Tag>
            ),
          },
          {
            title: t('keys.table.group'),
            width: 120,
            ellipsis: true,
            render: (_, r) => r.group?.displayName ?? t('keys.table.groupNone'),
          },
          {
            title: t('keys.table.costUsage'),
            width: 130,
            render: (_, r) =>
              `${formatCredits(r.costUsed)}${
                r.costLimit ? ` / ${formatCredits(r.costLimit)}` : ` / ${t('keys.table.unlimited')}`
              }`,
          },
          {
            title: t('admin.users.detail.rpm'),
            dataIndex: 'rpmLimit',
            width: 80,
            render: (v: number | null) => (v ?? t('keys.table.unlimited')),
          },
          {
            title: t('keys.table.lastUsed'),
            dataIndex: 'lastUsedAt',
            width: 150,
            render: (v: string | null) => (v ? formatDateTime(v) : t('keys.table.never')),
          },
        ]}
      />

      {sectionTitle(t('admin.users.detail.recentCalls'), logs?.total ?? 0)}
      <Table<RequestLogRow>
        size="small"
        rowKey="id"
        loading={logsLoading}
        dataSource={logs?.items ?? []}
        locale={{ emptyText: t('admin.users.detail.noCalls') }}
        pagination={logsPg.pagination(logs?.total, {
          size: 'small',
          showSizeChanger: false,
        })}
        columns={[
          {
            title: t('common.time'),
            dataIndex: 'createdAt',
            width: 150,
            render: (v: string) => formatDateTime(v),
          },
          { title: t('common.model'), dataIndex: 'model', ellipsis: true },
          {
            title: t('admin.users.detail.keys'),
            ellipsis: true,
            render: (_, r) => r.apiKey?.name ?? '-',
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 80,
            render: (v: number) =>
              v < 400 ? <Tag color="green">{v}</Tag> : <Tag color="red">{v}</Tag>,
          },
          {
            title: 'Token',
            dataIndex: 'totalTokens',
            width: 90,
            render: (v: number) => v.toLocaleString(),
          },
          {
            title: t('admin.users.detail.cost'),
            dataIndex: 'cost',
            width: 100,
            render: (v: string) => formatCredits(v),
          },
        ]}
      />

      {sectionTitle(t('admin.users.detail.transactions'), txs?.total ?? 0)}
      <Table<BalanceTransaction>
        size="small"
        rowKey="id"
        loading={txsLoading}
        dataSource={txs?.items ?? []}
        locale={{ emptyText: t('admin.users.detail.noTransactions') }}
        pagination={txPg.pagination(txs?.total, {
          size: 'small',
          showSizeChanger: false,
        })}
        columns={[
          {
            title: t('common.time'),
            dataIndex: 'createdAt',
            width: 150,
            render: (v: string) => formatDateTime(v),
          },
          {
            title: t('billing.txnTable.type'),
            dataIndex: 'type',
            width: 90,
            render: (v: BalanceTxType) =>
              TX_META[v] ? (
                <Tag color={TX_META[v].color}>{TX_META[v].label}</Tag>
              ) : (
                <Tag>{v}</Tag>
              ),
          },
          {
            title: t('billing.txnTable.amount'),
            dataIndex: 'amount',
            width: 110,
            render: (v: string) => {
              const n = Number(v);
              return (
                <Typography.Text type={n >= 0 ? 'success' : 'danger'}>
                  {n >= 0 ? '+' : ''}
                  {toCredits(n).toFixed(2)}
                </Typography.Text>
              );
            },
          },
          {
            title: t('billing.txnTable.balanceSnapshot'),
            dataIndex: 'balanceAfter',
            width: 120,
            render: (v: string) => toCredits(v).toFixed(2),
          },
          {
            title: t('billing.txnTable.description'),
            dataIndex: 'description',
            ellipsis: true,
            render: (v) => v ?? '-',
          },
        ]}
      />
    </Drawer>
  );
}
