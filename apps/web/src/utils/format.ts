/** 统一的金额/时间格式化，避免各页面各写一份、精度不一致 */

import { getCreditsPerUsd } from '../api/config';

export { getCreditsPerUsd };

/** 积分与美元换算：1 USD = N 积分（N 由后端 /api/config 提供，默认 100） */
export function toCredits(usd: string | number | null | undefined): number {
  const n = Number(usd ?? 0);
  return Number.isFinite(n) ? n * getCreditsPerUsd() : 0;
}

export function fromCredits(credits: number | null | undefined): number {
  const n = Number(credits ?? 0);
  return Number.isFinite(n) ? n / getCreditsPerUsd() : 0;
}

/** 按积分展示（2 位小数） */
export function formatCredits(usd: string | number | null | undefined): string {
  const c = toCredits(usd);
  return `${c.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} 积分`;
}

/** 官方价等仍以 USD 展示 */
export function formatUsd(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '$0.000000';
  return `$${n.toFixed(6)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
