import type { ReactNode } from 'react';
import { Skeleton } from 'antd';

interface StatCardProps {
  label: string;
  value?: ReactNode;
  suffix?: string;
  variant?: 'default' | 'accent';
  valueColor?: string;
  loading?: boolean;
}

const mono =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** DESIGN.md §5 StatCard：surface 卡片 → overline 标签 → mono 大数字 → 次要行 */
export function StatCard({ label, value, suffix, variant = 'default', valueColor, loading }: StatCardProps) {
  const accent = variant === 'accent' && !valueColor;
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 24,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 650,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {loading ? (
        <Skeleton.Input active size="small" />
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            fontFamily: mono,
            fontSize: 28,
            fontWeight: 650,
            lineHeight: 1.1,
            fontVariantNumeric: 'tabular-nums',
            ...(accent
              ? {
                  backgroundImage: 'var(--grad-brand)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  color: 'transparent',
                }
              : { color: valueColor ?? 'var(--text)' }),
          }}
        >
          <span>{value ?? '\u2014'}</span>
          {suffix && (
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-3)' }}>{suffix}</span>
          )}
        </div>
      )}
    </div>
  );
}
