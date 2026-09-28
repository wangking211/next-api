import { Empty } from 'antd';
import type { UsageDailyRow } from '../../api/types';
import { toCredits } from '../../utils/format';

const mono =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** DESIGN.md §5 DailyBars：flex 柱阵，--grad-bar 圆角 4px 底对齐，title 含日期/tokens/请求/费用 */
export function DailyBars({ rows }: { rows: UsageDailyRow[] }) {
  if (!rows.length) return <Empty description="暂无用量数据" />;
  const max = Math.max(...rows.map((r) => r.totalTokens), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 200, paddingTop: 8 }}>
      {rows.map((r) => {
        const h = Math.max((r.totalTokens / max) * 170, 4);
        return (
          <div
            key={r.date}
            title={`${r.date}\nTokens: ${r.totalTokens}\n请求: ${r.requests}\n费用: ${toCredits(r.cost).toFixed(2)} 积分`}
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
