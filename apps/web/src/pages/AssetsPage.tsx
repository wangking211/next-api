import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Image,
  Input,
  Pagination,
  Row,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PictureOutlined,
  ReloadOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { assetsApi } from '../api/endpoints';
import { errorMessage } from '../api/errorMessage';
import type { AssetStatus, MediaAssetRow } from '../api/types';
import { formatDateTime } from '../utils/format';
import { useAuth } from '../auth/AuthContext';
import { usePagination } from '../hooks/usePagination';
import { usePageClamp } from '../hooks/usePageClamp';
import QueryError from '../components/QueryError';

const { Text, Paragraph } = Typography;

const KIND_KEY = {
  VIDEO: 'assets.kind.VIDEO',
  IMAGE: 'assets.kind.IMAGE',
} as const;

const STATUS_KEY = {
  PENDING: 'assets.status.PENDING',
  CAPTURING: 'assets.status.CAPTURING',
  READY: 'assets.status.READY',
  FAILED: 'assets.status.FAILED',
} as const;

const STATUS_COLOR: Record<AssetStatus, string> = {
  PENDING: 'default',
  CAPTURING: 'processing',
  READY: 'success',
  FAILED: 'error',
};

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function AssetsPage() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'ADMIN';

  const [kind, setKind] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [model, setModel] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [downloading, setDownloading] = useState<string | null>(null);

  const pg = usePagination(24);
  const queryScope = isAdmin ? scope : 'mine';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['assets', pg.page, pg.pageSize, kind, status, model, queryScope],
    queryFn: ({ signal }) =>
      assetsApi.list(
        {
          page: pg.page,
          pageSize: pg.pageSize,
          kind: kind || undefined,
          status: status || undefined,
          model: model || undefined,
          scope: queryScope === 'all' ? 'all' : undefined,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
    // 有等待上游/抓取中的成品时自动刷新，完成后自动出预览
    refetchInterval: (query) => {
      const rows = query.state.data?.items ?? [];
      return rows.some((r) => r.status === 'PENDING' || r.status === 'CAPTURING') ? 15_000 : false;
    },
  });

  usePageClamp(pg.page, pg.setPage, data);

  const removeMut = useMutation({
    mutationFn: (id: string) => assetsApi.remove(id),
    onSuccess: () => {
      message.success(t('assets.deleted'));
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const retryMut = useMutation({
    mutationFn: (id: string) => assetsApi.retry(id),
    onSuccess: () => {
      message.success(t('assets.retried'));
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const purgeMut = useMutation({
    mutationFn: () => assetsApi.purge(),
    onSuccess: (r) => {
      message.success(
        t('assets.admin.purgeDone', { objects: r.deletedObjects, records: r.deletedRecords }),
      );
      void qc.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmPurge = () => {
    modal.confirm({
      title: t('assets.admin.purgeTitle'),
      content: t('assets.admin.purgeContent'),
      okButtonProps: { danger: true },
      onOk: () => purgeMut.mutate(),
    });
  };

  const confirmDelete = (row: MediaAssetRow) => {
    modal.confirm({
      title: t('common.confirmDelete'),
      content: t('assets.deleteConfirm'),
      okButtonProps: { danger: true },
      onOk: () => removeMut.mutate(row.id),
    });
  };

  async function download(row: MediaAssetRow) {
    setDownloading(row.id);
    try {
      const { blob, filename } = await assetsApi.download(row.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // 给浏览器留出落盘时间再回收 blob
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Card
      title={t('assets.title')}
      extra={
        <Space wrap>
          {isAdmin && (
            <Segmented
              value={scope}
              onChange={(v) => {
                setScope(v as 'mine' | 'all');
                pg.reset();
              }}
              options={[
                { label: t('assets.scope.mine'), value: 'mine' },
                { label: t('assets.scope.all'), value: 'all' },
              ]}
            />
          )}
          {isAdmin && (
            <Button
              danger
              icon={<ClearOutlined />}
              loading={purgeMut.isPending}
              onClick={confirmPurge}
            >
              {t('assets.admin.purge')}
            </Button>
          )}
        </Space>
      }
    >
      <Paragraph type="secondary" style={{ marginTop: -8 }}>
        {t('assets.subtitle')}
      </Paragraph>

      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          allowClear
          style={{ width: 140 }}
          placeholder={t('assets.filter.kind')}
          value={kind || undefined}
          onChange={(v) => {
            setKind(v ?? '');
            pg.reset();
          }}
          options={[
            { value: 'VIDEO', label: t('assets.kind.VIDEO') },
            { value: 'IMAGE', label: t('assets.kind.IMAGE') },
          ]}
        />
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder={t('assets.filter.status')}
          value={status || undefined}
          onChange={(v) => {
            setStatus(v ?? '');
            pg.reset();
          }}
          options={(['PENDING', 'CAPTURING', 'READY', 'FAILED'] as AssetStatus[]).map((s) => ({
            value: s,
            label: t(STATUS_KEY[s]),
          }))}
        />
        <Input.Search
          allowClear
          style={{ width: 220 }}
          placeholder={t('assets.filter.modelPlaceholder')}
          onSearch={(v) => {
            setModel(v.trim());
            pg.reset();
          }}
        />
      </Space>

      <QueryError show={isError} onRetry={refetch} />

      {!isLoading && (data?.items.length ?? 0) === 0 ? (
        <Empty description={t('assets.empty')} style={{ padding: '48px 0' }} />
      ) : (
        <Row gutter={[16, 16]}>
          {(data?.items ?? []).map((row) => (
            <Col key={row.id} xs={24} sm={12} lg={8} xl={6}>
              <AssetCard
                row={row}
                adminView={isAdmin && queryScope === 'all'}
                downloading={downloading === row.id}
                retryLoading={retryMut.isPending}
                deleteLoading={removeMut.isPending}
                onDownload={() => void download(row)}
                onRetry={() => retryMut.mutate(row.id)}
                onDelete={() => confirmDelete(row)}
              />
            </Col>
          ))}
        </Row>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Pagination
          current={pg.page}
          pageSize={pg.pageSize}
          total={data?.total ?? 0}
          showSizeChanger
          onChange={(p, size) => {
            pg.setPage(p);
            pg.setPageSize(size);
          }}
        />
      </div>
    </Card>
  );
}

function AssetCard(props: {
  row: MediaAssetRow;
  adminView: boolean;
  downloading: boolean;
  retryLoading: boolean;
  deleteLoading: boolean;
  onDownload: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { row } = props;

  const cover = !row.url ? (
    <div
      style={{
        height: 160,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fafafa',
        color: '#8c8c8c',
        padding: 12,
        textAlign: 'center',
      }}
    >
      {row.kind === 'VIDEO' ? (
        <VideoCameraOutlined style={{ fontSize: 30 }} />
      ) : (
        <PictureOutlined style={{ fontSize: 30 }} />
      )}
      <Tag color={STATUS_COLOR[row.status]} style={{ marginInlineEnd: 0 }}>
        {t(STATUS_KEY[row.status])}
      </Tag>
      <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: row.error }}>
        {row.status === 'FAILED' && row.error
          ? t('assets.statusHint.failed', { error: row.error })
          : t('assets.statusHint.pending')}
      </Text>
    </div>
  ) : row.kind === 'VIDEO' ? (
    <video
      src={row.url}
      controls
      preload="metadata"
      style={{ width: '100%', height: 160, background: '#000', objectFit: 'contain' }}
    />
  ) : (
    <Image
      src={row.url}
      height={160}
      style={{ objectFit: 'cover', width: '100%' }}
      preview={{ mask: t('assets.card.download') }}
    />
  );

  return (
    <Card
      size="small"
      hoverable
      cover={cover}
      title={
        <Space size={4} style={{ maxWidth: '100%' }}>
          <Tag color={row.kind === 'VIDEO' ? 'purple' : 'blue'} style={{ marginInlineEnd: 0 }}>
            {t(KIND_KEY[row.kind])}
          </Tag>
          <Text strong ellipsis={{ tooltip: row.model }} style={{ maxWidth: 150 }}>
            {row.model}
          </Text>
        </Space>
      }
      extra={
        row.status === 'READY' ? (
          <Tag color="success" style={{ marginInlineEnd: 0 }}>
            {formatBytes(row.bytes)}
          </Tag>
        ) : (
          <Tag color={STATUS_COLOR[row.status]} style={{ marginInlineEnd: 0 }}>
            {t(STATUS_KEY[row.status])}
          </Tag>
        )
      }
      actions={[
        <Tooltip key="download" title={t('assets.card.download')}>
          <Button
            type="text"
            size="small"
            icon={<DownloadOutlined />}
            disabled={!row.url}
            loading={props.downloading}
            onClick={props.onDownload}
          />
        </Tooltip>,
        <Tooltip key="retry" title={t('assets.card.retry')}>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            disabled={row.status === 'READY'}
            loading={props.retryLoading}
            onClick={props.onRetry}
          />
        </Tooltip>,
        <Tooltip key="delete" title={t('assets.card.delete')}>
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={props.deleteLoading}
            onClick={props.onDelete}
          />
        </Tooltip>,
      ]}
    >
      <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        <div>
          <Text type="secondary">{t('assets.meta.createdAt')}: </Text>
          {formatDateTime(row.createdAt)}
        </div>
        {row.durationSeconds ? (
          <div>
            <Text type="secondary">{t('assets.meta.duration')}: </Text>
            {row.durationSeconds}s
          </div>
        ) : null}
        {row.channel ? (
          <div>
            <Text type="secondary">{t('assets.meta.channel')}: </Text>
            {row.channel.name}
          </div>
        ) : null}
        {props.adminView && row.user ? (
          <div>
            <Text type="secondary">{t('assets.meta.user')}: </Text>
            {row.user.username}
          </div>
        ) : null}
        {row.sourceTaskId ? (
          <div>
            <Text type="secondary">{t('assets.meta.taskId')}: </Text>
            <Text copyable={{ text: row.sourceTaskId }} style={{ fontSize: 12 }}>
              {row.sourceTaskId.length > 18
                ? `${row.sourceTaskId.slice(0, 18)}…`
                : row.sourceTaskId}
            </Text>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
