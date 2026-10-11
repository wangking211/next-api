import { Input, InputNumber, Table, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { getCreditsPerUsd } from '../../utils/format';
import type { ModelInfo, RouteSignalRow } from '../../api/types';
import type { PriceRow, SetPrice } from './constants';

/** 渠道×模型 折扣编辑表；右侧实时显示按官方价折算的成本/售价（积分/1M）。
 *  L2 信号列展示滑窗被动指标（有效回复率/拒答率），辅助人工校准 qualityScore——
 *  只展示，不自动覆盖人工分。 */
export function PricingTable({
  models,
  pricing,
  setP,
  catalog,
  signals,
}: {
  models: string[];
  pricing: Record<string, PriceRow>;
  setP: SetPrice;
  catalog: ModelInfo[];
  /** L2 被动信号（GET /channels/:id/route-signals），未加载时列显示「—」 */
  signals?: RouteSignalRow[];
}) {
  const { t } = useTranslation();
  const signalOf = (model: string) => signals?.find((s) => s.model === model);
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const official = (name: string) => {
    const m = catalog.find((c) => c.name === name);
    return m ? { in: Number(m.inputPrice), out: Number(m.outputPrice) } : { in: 0, out: 0 };
  };
  const disc = (model: string, key: 'costDiscount' | 'priceDiscount') =>
    (pricing[model]?.[key] as number | undefined) ?? 1;
  const credits = (usdPerM: number, d: number) => (usdPerM * d * getCreditsPerUsd()).toFixed(2);
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
  /** 按次计价（USD/次）：仅图片等非 token 计费模型需要，留空 = 按 token 计价 */
  const perCall = (model: string, key: 'costPerCall' | 'pricePerCall') => (
    <InputNumber
      size="small"
      min={0}
      step={0.001}
      style={{ width: 96 }}
      value={pricing[model]?.[key]}
      placeholder="—"
      onChange={(v) => setP(model, key, v as number)}
    />
  );
  return (
    <Table
      size="small"
      rowKey="model"
      pagination={false}
      scroll={{ y: 260, x: 1270 }}
      style={{ marginTop: 6 }}
      dataSource={models.map((m) => ({ model: m }))}
      columns={[
        { title: t('common.model'), dataIndex: 'model', width: 150, ellipsis: true },
        {
          title: t('channels.pricing.upstreamModelName'),
          width: 160,
          render: (_: unknown, r: { model: string }) => (
            <Input
              size="small"
              style={{ width: 150 }}
              value={pricing[r.model]?.upstreamModelName}
              onChange={(e) => setP(r.model, 'upstreamModelName', e.target.value)}
            />
          ),
        },
        {
          title: t('channels.pricing.costDiscount'),
          width: 100,
          render: (_: unknown, r: { model: string }) => num(r.model, 'costDiscount'),
        },
        {
          title: t('channels.pricing.priceDiscount'),
          width: 100,
          render: (_: unknown, r: { model: string }) => num(r.model, 'priceDiscount'),
        },
        {
          title: (
            <Tooltip title={t('channels.pricing.qualityTip')}>
              {t('channels.pricing.qualityScore')}
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
          title: (
            <Tooltip title={t('channels.pricing.l2SignalTip')}>
              {t('channels.pricing.l2Signal')}
            </Tooltip>
          ),
          width: 150,
          render: (_: unknown, r: { model: string }) => {
            const s = signalOf(r.model);
            if (!s || s.samples === 0) {
              return <Typography.Text type="secondary">—</Typography.Text>;
            }
            return (
              <Tooltip
                title={`${t('channels.pricing.l2SignalTip')} · ${t('channels.pricing.l2Samples')}: ${s.samples}`}
              >
                <Typography.Text>
                  {pct(s.validRate)} / {pct(s.refuseRate)}
                </Typography.Text>
              </Tooltip>
            );
          },
        },
        {
          title: t('channels.pricing.costPerCall'),
          width: 120,
          render: (_: unknown, r: { model: string }) => perCall(r.model, 'costPerCall'),
        },
        {
          title: t('channels.pricing.pricePerCall'),
          width: 120,
          render: (_: unknown, r: { model: string }) => perCall(r.model, 'pricePerCall'),
        },
        {
          title: t('channels.pricing.cost'),
          width: 150,
          render: (_: unknown, r: { model: string }) => {
            const o = official(r.model);
            const d = disc(r.model, 'costDiscount');
            return (
              <Typography.Text type="secondary">
                {credits(o.in, d)} / {credits(o.out, d)}
              </Typography.Text>
            );
          },
        },
        {
          title: t('channels.pricing.salePrice'),
          width: 150,
          render: (_: unknown, r: { model: string }) => {
            const o = official(r.model);
            const d = disc(r.model, 'priceDiscount');
            return (
              <Typography.Text strong>
                {credits(o.in, d)} / {credits(o.out, d)}
              </Typography.Text>
            );
          },
        },
      ]}
    />
  );
}
