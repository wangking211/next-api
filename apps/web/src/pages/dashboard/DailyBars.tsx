import { Empty } from 'antd';
import { useTranslation } from 'react-i18next';
import type { UsageDailyRow } from '../../api/types';
import { toCredits } from '../../utils/format';

const mono =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** DESIGN.md §5 DailyBars：flex 柱阵，--grad-bar 圆角 4px 底对齐，title 含日期/tokens/请求/费用 */
export function DailyBars({ rows }: { rows: UsageDailyRow[] }) {
  const { t } = useTranslation();
  if (!rows.length) return <Empty description={t('dashboard.daily.empty')} />;
  const max = Math.max(...rows.map((r) => r.totalTokens), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 200, paddingTop: 8 }}>
      {rows.map((r) => {
        const h = Math.max((r.totalTokens / max) * 170, 4);
        const byok = r.cost - r.billedCost;
        return (
          <div
            key={r.date}
            title={`${r.date}\nTokens: ${r.totalTokens}\n${t('dashboard.daily.requests')}: ${
              r.requests
            }\n${t('dashboard.daily.billedCost')}: ${toCredits(r.billedCost).toFixed(2)} ${t(
              'dashboard.unit.credits',
            )}${
              byok > 0.0000005
                ? `\n${t('dashboard.daily.byokNote')}: ${toCredits(byok).toFixed(2)} ${t('dashboard.unit.credits')}`
                : ''
            }`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
          >
            <div
              style={{
                width: '100%',
                height: h,
                background: 'var(--grad-bar)',
                borderRadius: 4,
              }}
            />
            <span style={{ fontFamily: mono, fontSize: 10, whiteSpace: 'nowrap', color: 'var(--text-3)' }}>
              {r.date.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
