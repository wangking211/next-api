import { deriveChannelPricing, isPeakTime } from './pricing.util';

describe('isPeakTime（峰段判定）', () => {
  const windows = '01:00-04:00,06:00-10:00';
  const weekdays = '1-5';
  const at = (iso: string) => new Date(iso);

  it('工作日峰段内 → true（2026-10-30 为周五）', () => {
    expect(isPeakTime(at('2026-10-30T02:30:00Z'), windows, weekdays)).toBe(true);
    expect(isPeakTime(at('2026-10-30T07:00:00Z'), windows, weekdays)).toBe(true);
  });

  it('工作日非峰段 → false（终点不含）', () => {
    expect(isPeakTime(at('2026-10-30T00:59:00Z'), windows, weekdays)).toBe(false);
    expect(isPeakTime(at('2026-10-30T04:00:00Z'), windows, weekdays)).toBe(false);
    expect(isPeakTime(at('2026-10-30T10:00:00Z'), windows, weekdays)).toBe(false);
    expect(isPeakTime(at('2026-10-30T12:30:00Z'), windows, weekdays)).toBe(false);
  });

  it('周末 → 全天低谷', () => {
    expect(isPeakTime(at('2026-10-31T02:30:00Z'), windows, weekdays)).toBe(false);
  });

  it('节假日清单命中 → 全天低谷', () => {
    expect(isPeakTime(at('2026-10-30T02:30:00Z'), windows, weekdays, ['2026-10-30'])).toBe(false);
  });

  it('窗口为空 → 永远峰段（关闭峰谷计价）', () => {
    expect(isPeakTime(at('2026-10-31T02:30:00Z'), '', weekdays)).toBe(true);
  });

  it('支持跨午夜窗口', () => {
    const w = '22:00-02:00';
    expect(isPeakTime(at('2026-10-30T23:00:00Z'), w, '')).toBe(true);
    expect(isPeakTime(at('2026-10-31T01:00:00Z'), w, '')).toBe(true);
    expect(isPeakTime(at('2026-10-30T12:00:00Z'), w, '')).toBe(false);
  });
});

describe('deriveChannelPricing 峰谷倍率', () => {
  const catalog = {
    inputPrice: 0.3,
    outputPrice: 1.2,
    cacheReadPrice: 0.006,
    cacheWritePrice: 0.3,
    offPeakMultiplier: 0.5,
  };

  it('峰段 → 原价', () => {
    const p = deriveChannelPricing(null, catalog);
    expect(p.priceInput).toBeCloseTo(0.3);
    expect(p.costOutput).toBeCloseTo(1.2);
  });

  it('低谷 → 成本/售价/缓存价统一 ×0.5（显式渠道价同样打折）', () => {
    const cm = { costInput: 0.3, costOutput: 1.2, priceInput: 0.6, priceOutput: 2.4 };
    const p = deriveChannelPricing(cm, catalog, { offPeak: true });
    expect(p.priceInput).toBeCloseTo(0.3);
    expect(p.priceOutput).toBeCloseTo(1.2);
    expect(p.costInput).toBeCloseTo(0.15);
    expect(p.costOutput).toBeCloseTo(0.6);
    expect(p.cacheReadPrice).toBeCloseTo(0.003);
    expect(p.cacheReadCost).toBeCloseTo(0.003);
    expect(p.explicit).toBe(true);
  });

  it('未配置倍率 → 低谷也按原价', () => {
    const p = deriveChannelPricing(
      null,
      { ...catalog, offPeakMultiplier: null },
      { offPeak: true },
    );
    expect(p.priceOutput).toBeCloseTo(1.2);
  });
});
