import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import {
  formatCny,
  formatCredits,
  formatDateTime,
  formatMoney,
  formatUsd,
  fromCredits,
  moneyUnit,
  moneyValue,
  setCurrency,
  subscribeCurrency,
  toCredits,
} from './format';

/** 文案走 i18n，断言统一固定语言，避免跑在英文环境时用例随 navigator 变化 */
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('积分换算', () => {
  it('默认 1 USD = 100 积分', () => {
    expect(toCredits('1.5')).toBe(150);
    expect(toCredits(0.01)).toBeCloseTo(1);
    expect(fromCredits(150)).toBe(1.5);
  });

  it('空值与非法值折算为 0，不产生 NaN', () => {
    expect(toCredits(null)).toBe(0);
    expect(toCredits(undefined)).toBe(0);
    expect(toCredits('abc')).toBe(0);
    expect(fromCredits(null)).toBe(0);
    expect(fromCredits(Number.NaN)).toBe(0);
  });
});

describe('formatCredits', () => {
  it('保留两位小数并带单位', () => {
    expect(formatCredits(1.5)).toBe('150.00 积分');
    expect(formatCredits(null)).toBe('0.00 积分');
  });

  it('单位随界面语言切换', async () => {
    await i18n.changeLanguage('en');
    expect(formatCredits(1.5)).toBe('150.00 credits');
  });
});

describe('formatUsd', () => {
  it('固定 6 位小数', () => {
    expect(formatUsd('1.5')).toBe('$1.500000');
    expect(formatUsd(0)).toBe('$0.000000');
  });

  it('非法输入回退到 $0.000000，而不是打出 NaN', () => {
    expect(formatUsd('nope')).toBe('$0.000000');
    expect(formatUsd(null)).toBe('$0.000000');
  });
});

describe('formatMoney（展示币种开关）', () => {
  afterEach(() => setCurrency('credits'));

  it('默认积分口径与 formatCredits 完全一致', () => {
    expect(formatMoney(1.5)).toBe(formatCredits(1.5));
    expect(moneyUnit()).toBe('积分');
  });

  it('USD：按 1:1 展示，带 ISO 单位并保留小额精度', () => {
    setCurrency('usd');
    expect(formatMoney('1.5')).toBe('1.50 USD');
    expect(formatMoney('0.018')).toBe('0.018 USD');
    expect(moneyValue('1.5')).toBe('1.50');
    expect(moneyUnit()).toBe('USD');
  });

  it('CNY：按 1 USD = N 元换算（config 未加载时用展示兜底汇率）', () => {
    setCurrency('cny');
    expect(formatMoney(1.5)).toBe('10.50 CNY');
    expect(moneyUnit()).toBe('CNY');
  });

  it('切换持久化到 localStorage，并通知订阅者；退订后不再回调', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCurrency(listener);

    setCurrency('usd');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('aigw.currency')).toBe('usd');

    unsubscribe();
    setCurrency('cny');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('非法/空金额按 0 展示，不产生 NaN', () => {
    setCurrency('usd');
    expect(formatMoney(null)).toBe('0.00 USD');
    expect(formatMoney('abc')).toBe('0.00 USD');
  });
});

describe('formatCny（对账人民币列，固定 CNY 口径）', () => {
  it('汇率不可用（null）显示破折号', () => {
    expect(formatCny(null)).toBe('—');
    expect(formatCny(undefined)).toBe('—');
    expect(formatCny('abc')).toBe('—');
  });

  it('已折算值直接展示并带 CNY 单位', () => {
    expect(formatCny('0.1278')).toBe('0.1278 CNY');
    expect(formatCny(7)).toBe('7.00 CNY');
  });
});

describe('formatDateTime', () => {
  it('补零成 YYYY-MM-DD HH:mm:ss', () => {
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
    expect(formatDateTime(new Date(2026, 10, 5, 6, 7, 8))).toBe('2026-11-05 06:07:08');
  });

  it('空值与非法时间统一显示 "-"', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(undefined)).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(formatDateTime('not-a-date')).toBe('-');
    expect(formatDateTime(Number.NaN)).toBe('-');
  });
});
