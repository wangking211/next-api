import { Card, Empty } from 'antd';

const mono =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export interface RankBarItem {
  key: string;
  label: string;
  value: number;
  sub?: string;
}

/** DESIGN.md §5 RankBar：标签（截断 + title 兜底）+ mono 数值；下方 6px 轨，--surface-2 底 / --grad-bar 填充 */
function RankBar({ item, max }: { item: RankBarItem; max: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
        <span
          style={{
            maxWidth: '58%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-2)',
          }}
          title={item.label}
        >
          {item.label}
        </span>
        <span
          style={{
            fontFamily: mono,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-2)',
            whiteSpace: 'nowrap',
          }}
        >
          {item.value.toLocaleString()} {item.sub}
        </span>
      </div>
      <div
        style={{
          height: 6,
          background: 'var(--surface-2)',
          borderRadius: 3,
          marginTop: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 6,
            width: `${(item.value / max) * 100}%`,
            background: 'var(--grad-bar)',
            borderRadius: 3,
          }}
        />
      </div>
    </div>
  );
}

export function RankList({ title, items }: { title: string; items: RankBarItem[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <Card title={title} size="small" style={{ height: '100%' }}>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((it) => (
            <RankBar key={it.key} item={it} max={max} />
          ))}
        </div>
      )}
    </Card>
  );
}
