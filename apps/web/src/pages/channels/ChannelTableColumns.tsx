import { Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ChannelInfo } from '../../api/types';

export type ChannelColumnDeps = {
  testingId: string | null;
  onTest: (r: ChannelInfo) => void;
  onPricing: (r: ChannelInfo) => void;
  onEdit: (r: ChannelInfo) => void;
  onToggle: (r: ChannelInfo) => void;
  onRemove: (id: string) => void;
};

export function buildChannelColumns({
  testingId,
  onTest,
  onPricing,
  onEdit,
  onToggle,
  onRemove,
}: ChannelColumnDeps): ColumnsType<ChannelInfo> {
  return [
    { title: '名称', dataIndex: 'name' },
    {
      title: '归属',
      dataIndex: 'ownerType',
      render: (v: string) =>
        v === 'PLATFORM' ? <Tag color="gold">平台</Tag> : <Tag color="blue">我的</Tag>,
    },
    { title: '服务商', dataIndex: 'provider' },
    { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
    {
      title: '模型',
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
    { title: '优先级', dataIndex: 'priority' },
    { title: '权重', dataIndex: 'weight' },
    {
      title: 'Key',
      dataIndex: 'apiKeyPreview',
      render: (v: string) => <code>{v}</code>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: string, r) =>
        v === 'ENABLED' ? (
          <Tag color="green">启用</Tag>
        ) : r.autoDisabled ? (
          <Tooltip title={r.lastErrorMsg ?? '因连续失败自动禁用'}>
            <Tag color="red">自动禁用</Tag>
          </Tooltip>
        ) : (
          <Tag color="default">停用</Tag>
        ),
    },
    {
      title: '价格 / 折扣',
      render: (_: unknown, r: ChannelInfo) => {
        const rows = r.modelPrices ?? [];
        const priced = rows.filter(
          (m) => m.priceInput != null || m.priceOutput != null,
        ).length;
        const discounts = rows
          .map((m) => m.discount)
          .filter((d): d is number => d != null);
        return (
          <Space size={4} wrap>
            {priced ? (
              <Tag color="blue">{priced} 个售价</Tag>
            ) : (
              <Typography.Text type="secondary">默认价</Typography.Text>
            )}
            {discounts.length > 0 && (
              <Tag color="orange">折扣 {Math.min(...discounts)}</Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      fixed: 'right',
      width: 340,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
            loading={testingId === r.id}
            onClick={() => onTest(r)}
          >
            测试
          </Button>
          <Button size="small" onClick={() => onPricing(r)}>
            定价
          </Button>
          <Button size="small" onClick={() => onEdit(r)}>
            编辑
          </Button>
          <Button size="small" onClick={() => onToggle(r)}>
            {r.status === 'ENABLED' ? '停用' : '启用'}
          </Button>
          <Popconfirm title="确定删除该渠道？" onConfirm={() => onRemove(r.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
}
