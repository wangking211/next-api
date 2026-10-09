import { parseRetryAfterMs } from './upstream-error.util';

describe('parseRetryAfterMs（上游 Retry-After → 毫秒）', () => {
  it('delay-seconds：整数与小数都向上取整', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    expect(parseRetryAfterMs(' 30 ')).toBe(30_000);
  });

  it('零 / 负数 / 非法文本 / 空 → undefined（调用方回退自身退避）', () => {
    expect(parseRetryAfterMs('0')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('HTTP-date：未来时刻取剩余毫秒，已过期 → undefined', () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(80_000);
    expect(ms).toBeLessThanOrEqual(90_000);

    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBeUndefined();
  });

  it('接受响应对象：从 headers 读取（大小写不敏感语义由 Headers 保证）', () => {
    const res = { headers: { get: (n: string) => (n === 'retry-after' ? '42' : null) } };
    expect(parseRetryAfterMs(res)).toBe(42_000);

    // 无该头 / 无 headers（老 mock）都不应抛错
    expect(parseRetryAfterMs({ headers: { get: () => null } })).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
  });
});
