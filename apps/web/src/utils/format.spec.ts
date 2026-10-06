import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { formatCredits, formatDateTime, formatUsd, fromCredits, toCredits } from './format';

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
