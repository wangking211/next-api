/** 统一的金额/时间格式化，避免各页面各写一份、精度不一致 */

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
