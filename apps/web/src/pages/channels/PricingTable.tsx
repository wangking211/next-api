import { InputNumber, Table, Tooltip, Typography } from 'antd';
import { getCreditsPerUsd } from '../../utils/format';
import type { ModelInfo } from '../../api/types';
import type { PriceRow, SetPrice } from './constants';

/** 渠道×模型 折扣编辑表；右侧实时显示按官方价折算的成本/售价（积分/1M） */
export function PricingTable({
  models,
  pricing,
  setP,
  catalog,
}: {
  models: string[];
  pricing: Record<string, PriceRow>;
  setP: SetPrice;
  catalog: ModelInfo[];
}) {
  const official = (name: string) => {
    const m = catalog.find((c) => c.name === name);
    return m ? { in: Number(m.inputPrice), out: Number(m.outputPrice) } : { in: 0, out: 0 };
  };
  const disc = (model: string, key: keyof PriceRow) => pricing[model]?.[key] ?? 1;
  const credits = (usdPerM: number, d: number) =>
    (usdPerM * d * getCreditsPerUsd()).toFixed(2);
  const num = (model: string, key: keyof PriceRow) => (
    <InputNumber
      size="small"
      min={0}
      max={1}
      step={0.05}
      style={{ width: 84 }}
      value={pricing[model]?.[key]}
      placeholder="1"
      onChange={(v) => setP(model, key, v as number)}
    />
  );
  return (
    <Table
      size="small"
      rowKey="model"
      pagination={false}
      scroll={{ y: 260, x: 720 }}
      style={{ marginTop: 6 }}
      dataSource={models.map((m) => ({ model: m }))}
      columns={[
        { title: '模型', dataIndex: 'model', width: 150, ellipsis: true },
        { title: '上游折扣', width: 100, render: (_: unknown, r: { model: string }) => num(r.model, 'costDiscount') },
        { title: '下游折扣', width: 100, render: (_: unknown, r: { model: string }) => num(r.model, 'priceDiscount') },
        {
          title: (
            <Tooltip title="人工质量分 0~2（1=正常）：官方直连 1.0、可用中转 0.85、疑似降智/蒸馏 0.6；参与智能路由评分">
              质量分
            </Tooltip>
          ),
          width: 90,
          render: (_: unknown, r: { model: string }) => (
            <InputNumber
              size="small"
              min={0}
              max={2}
              step={0.05}
              style={{ width: 84 }}
              value={pricing[r.model]?.qualityScore}
              placeholder="1"
              onChange={(v) => setP(r.model, 'qualityScore', v as number)}
            />
          ),
        },
        {
          title: '成本(积分/1M)',
          width: 150,
          render: (_: unknown, r: { model: string }) => {
            const o = official(r.model);
            const d = disc(r.model, 'costDiscount');
            return <Typography.Text type="secondary">{credits(o.in, d)} / {credits(o.out, d)}</Typography.Text>;
          },
        },
        {
          title: '售价(积分/1M)',
          width: 150,
          render: (_: unknown, r: { model: string }) => {
            const o = official(r.model);
            const d = disc(r.model, 'priceDiscount');
            return <Typography.Text strong>{credits(o.in, d)} / {credits(o.out, d)}</Typography.Text>;
          },
        },
      ]}
    />
  );
}
