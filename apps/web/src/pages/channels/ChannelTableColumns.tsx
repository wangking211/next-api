import { Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ChannelInfo } from '../../api/types';
import { formatDateTime } from '../../utils/format';
import i18n from '../../i18n';

export type ChannelColumnDeps = {
  testingId: string | null;
  onTest: (r: ChannelInfo) => void;
  onPricing: (r: ChannelInfo) => void;
  onShare: (r: ChannelInfo) => void;
  onEdit: (r: ChannelInfo) => void;
  onToggle: (r: ChannelInfo) => void;
  onRemove: (id: string) => void;
};

export function buildChannelColumns({
  testingId,
  onTest,
  onPricing,
  onShare,
  onEdit,
  onToggle,
  onRemove,
}: ChannelColumnDeps): ColumnsType<ChannelInfo> {
  // i18n.t 于每次渲染调用本函数时求值，语言切换后随父组件重渲染而更新
  const t = i18n.t.bind(i18n);
  return [
    { title: t('channels.table.name'), dataIndex: 'name' },
    {
      title: t('channels.table.ownerType'),
      dataIndex: 'ownerType',
      render: (v: string) =>
        v === 'PLATFORM' ? (
          <Tag color="gold">{t('channels.status.platform')}</Tag>
        ) : (
          <Tag color="blue">{t('channels.status.mine')}</Tag>
        ),
    },
    { title: t('channels.table.provider'), dataIndex: 'provider' },
    {
      title: t('channels.table.share'),
      dataIndex: 'shareMode',
      width: 160,
      render: (_: unknown, r: ChannelInfo) => {
        // 平台渠道不参与共享，只读；自有渠道整列可点，打开共享设置弹窗
        const editable = r.ownerType === 'USER';
        const isPrivate = !r.shareMode || r.shareMode === 'PRIVATE';
        if (isPrivate && !editable) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const used = Number(r.shareUsedCostUsd ?? 0);
        const quotaCost = r.shareQuotaCostUsd != null ? Number(r.shareQuotaCostUsd) : null;
        const quotaReq = r.shareQuotaRequests ?? null;
        const usedReq = r.shareUsedRequests ?? 0;
        const until = r.shareUntil ? new Date(r.shareUntil).getTime() : null;
        // 与路由侧 shareExhausted() 同口径：到期或额度用尽即不再接单
        const exhausted =
          (until != null && until <= Date.now()) ||
          (quotaCost != null && quotaCost > 0 && used >= quotaCost) ||
          (quotaReq != null && quotaReq > 0 && usedReq >= quotaReq);
        const tips = [
          quotaCost != null
            ? t('channels.share.quotaCost', { used: used.toFixed(2), quota: quotaCost })
            : null,
          quotaReq != null
            ? t('channels.share.quotaRequests', { used: usedReq, quota: quotaReq })
            : null,
          until ? t('channels.share.until', { until: formatDateTime(until) }) : null,
        ].filter(Boolean);
        const label = isPrivate
          ? t('channels.share.private')
          : t(r.shareMode === 'PUBLIC' ? 'channels.share.public' : 'channels.share.group');
        return (
          <Tooltip
            title={
              tips.length
                ? tips.join(' · ')
                : editable
                  ? t('channels.form.shareSection')
                  : undefined
            }
          >
            <Tag
              color={
                isPrivate
                  ? 'default'
                  : exhausted
                    ? 'default'
                    : r.shareMode === 'PUBLIC'
                      ? 'purple'
                      : 'geekblue'
              }
              style={editable ? { cursor: 'pointer' } : undefined}
              onClick={editable ? () => onShare(r) : undefined}
            >
              {label}
              {exhausted ? ` · ${t('channels.share.exhausted')}` : ''}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: t('channels.table.revenue'),
      dataIndex: 'revenue',
      width: 110,
      render: (v: string) => {
        const n = Number(v ?? 0);
        // 无共享分账（平台渠道 / 还没人调用）时不占视觉重量
        if (!Number.isFinite(n) || n <= 0) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        return (
          <Typography.Text type="success" strong>
            ${n.toFixed(2)}
          </Typography.Text>
        );
      },
    },
    {
      title: t('channels.table.groups'),
      dataIndex: 'groups',
      width: 170,
      render: (gs: { id: string; displayName: string }[]) =>
        gs?.length ? (
          <Space size={[0, 4]} wrap>
            {gs.map((g) => (
              <Tag key={g.id} color="cyan">
                {g.displayName}
              </Tag>
            ))}
          </Space>
        ) : (
          <Tag>{t('channels.table.groupNone')}</Tag>
        ),
    },
    {
      title: t('channels.table.upstreamGroup'),
      dataIndex: 'upstreamGroup',
      width: 120,
      render: (v: string | null) => (v ? <code>{v}</code> : '-'),
    },
    { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
    {
      title: t('common.model'),
      dataIndex: 'models',
      render: (models: string[]) => (
        <Space size={[0, 4]} wrap>
          {models.slice(0, 4).map((m) => (
            <Tag key={m}>{m}</Tag>
          ))}
          {models.length > 4 && <Tag>+{models.length - 4}</Tag>}
        </Space>
      ),
    },
    { title: t('channels.table.priority'), dataIndex: 'priority' },
    { title: t('channels.table.weight'), dataIndex: 'weight' },
    {
      title: 'Key',
      dataIndex: 'apiKeyPreview',
      render: (v: string) => <code>{v}</code>,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      render: (v: string, r) =>
        v === 'ENABLED' ? (
          <Tag color="green">{t('channels.status.enabled')}</Tag>
        ) : r.autoDisabled ? (
          <Tooltip title={r.lastErrorMsg ?? t('channels.status.autoDisabledReason')}>
            <Tag color="red">{t('channels.status.autoDisabled')}</Tag>
          </Tooltip>
        ) : (
          <Tag color="default">{t('channels.status.disabled')}</Tag>
        ),
    },
    {
      title: t('channels.table.priceDiscount'),
      render: (_: unknown, r: ChannelInfo) => {
        const rows = r.modelPrices ?? [];
        const priced = rows.filter((m) => m.priceInput != null || m.priceOutput != null).length;
        const discounts = rows.map((m) => m.discount).filter((d): d is number => d != null);
        return (
          <Space size={4} wrap>
            {priced ? (
              <Tag color="blue">{t('channels.table.pricedCount', { count: priced })}</Tag>
            ) : (
              <Typography.Text type="secondary">{t('channels.table.defaultPrice')}</Typography.Text>
            )}
            {discounts.length > 0 && (
              <Tag color="orange">
                {t('channels.table.discountTag', { value: Math.min(...discounts) })}
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: t('common.action'),
      fixed: 'right',
      width: 340,
      render: (_, r) => (
        <Space>
          <Button size="small" loading={testingId === r.id} onClick={() => onTest(r)}>
            {t('channels.action.test')}
          </Button>
          <Button size="small" onClick={() => onPricing(r)}>
            {t('channels.action.pricing')}
          </Button>
          <Button size="small" onClick={() => onEdit(r)}>
            {t('common.edit')}
          </Button>
          <Button size="small" onClick={() => onToggle(r)}>
            {r.status === 'ENABLED' ? t('channels.status.disabled') : t('channels.status.enabled')}
          </Button>
          <Popconfirm title={t('channels.action.confirmDelete')} onConfirm={() => onRemove(r.id)}>
            <Button size="small" danger>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
}
