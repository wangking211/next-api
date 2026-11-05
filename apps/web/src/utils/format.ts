/** 统一的金额/时间格式化，避免各页面各写一份、精度不一致 */

import { useSyncExternalStore } from 'react';
import { getCreditsPerUsd, getPayRate } from '../api/config';
import i18n from '../i18n';

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

/** 按积分展示（2 位小数），单位后缀随界面语言 */
export function formatCredits(usd: string | number | null | undefined): string {
  const c = toCredits(usd);
  const value = c.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return i18n.t('common.creditsValue', { value });
}

/** 展示币种：只影响展示换算，记账本位恒为 USD；选择持久化到 localStorage */
export type DisplayCurrency = 'credits' | 'usd' | 'cny';

const CURRENCY_KEY = 'aigw.currency';
const currencyListeners = new Set<() => void>();
let displayCurrency: DisplayCurrency = readCurrency();

function readCurrency(): DisplayCurrency {
  try {
    const saved = localStorage.getItem(CURRENCY_KEY);
    if (saved === 'credits' || saved === 'usd' || saved === 'cny') return saved;
  } catch {
    /* localStorage 不可用（隐私模式等）时保持默认积分口径 */
  }
  return 'credits';
}

export function getCurrency(): DisplayCurrency {
  return displayCurrency;
}

/** 切换展示币种：持久化并通知订阅组件重渲染 */
export function setCurrency(currency: DisplayCurrency): void {
  if (currency === displayCurrency) return;
  displayCurrency = currency;
  try {
    localStorage.setItem(CURRENCY_KEY, currency);
  } catch {
    /* ignore */
  }
  currencyListeners.forEach((listener) => listener());
}

/** 订阅展示币种变化（导出便于单测；组件请用 useCurrency） */
export function subscribeCurrency(listener: () => void): () => void {
  currencyListeners.add(listener);
  return () => {
    currencyListeners.delete(listener);
  };
}

/** 当前展示币种；页面组件顶层调用一次，切换后即可重渲染 */
export function useCurrency(): DisplayCurrency {
  return useSyncExternalStore(subscribeCurrency, getCurrency, getCurrency);
}

/** config 未就绪/汇率暂缺时的 CNY 展示兜底系数（loadConfig 返回后自动纠正） */
const FALLBACK_CNY_PER_USD = 7;

/** USD 记账值 → 当前展示币种的换算系数 */
function moneyFactor(): number {
  if (displayCurrency === 'usd') return 1;
  if (displayCurrency === 'cny') return getPayRate() ?? FALLBACK_CNY_PER_USD;
  return getCreditsPerUsd();
}

function group(value: number, maxFractionDigits: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFractionDigits,
  });
}

/** 金额的数值部分（不含单位）：积分 2 位小数；USD/CNY 最多 6 位（避免小额被抹成 0） */
export function moneyValue(usd: string | number | null | undefined): string {
  const n = Number(usd ?? 0);
  const value = Number.isFinite(n) ? n * moneyFactor() : 0;
  return group(value, displayCurrency === 'credits' ? 2 : 6);
}

/** 金额单位：积分随界面语言；USD/CNY 用 ISO 代码（无需翻译） */
export function moneyUnit(): string {
  if (displayCurrency === 'usd') return 'USD';
  if (displayCurrency === 'cny') return 'CNY';
  return i18n.t('common.unit.credits');
}

/** 按当前展示币种格式化金额（入参为 USD 记账值） */
export function formatMoney(usd: string | number | null | undefined): string {
  if (displayCurrency === 'credits') return formatCredits(usd);
  return `${moneyValue(usd)} ${moneyUnit()}`;
}

/** 展示已折算好的人民币金额（对账人民币列：按当日汇率快照，不随展示币种变化） */
export function formatCny(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${group(n, 6)} CNY`;
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
