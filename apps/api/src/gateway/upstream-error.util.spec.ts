import { classifyUpstreamFailure, parseRetryAfterMs } from './upstream-error.util';
import { UpstreamError } from './types';

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

describe('classifyUpstreamFailure（统一分类口径：故障转移与流式中断共用）', () => {
  const ue = (status: number, retryable: boolean, message?: string) =>
    new UpstreamError(
      `Upstream error ${status}`,
      status,
      retryable,
      message ? { error: { message } } : undefined,
    );

  it('429 → limited（冷却退避，不计渠道失败）', () => {
    const c = classifyUpstreamFailure(ue(429, true, 'rate limit exceeded, try later'));
    expect(c.limited).toBe(true);
    expect(c.transient).toBe(false);
    expect(c.refusal).toBe(false);
  });

  it('5xx 可重试 → transient（计渠道失败）', () => {
    const c = classifyUpstreamFailure(ue(502, true));
    expect(c.transient).toBe(true);
    expect(c.limited).toBe(false);
    expect(c.status).toBe(502);
  });

  it('400 拒答文案 → refusal（不计失败、不熔断）', () => {
    const c = classifyUpstreamFailure(ue(400, false, 'content_policy violation'));
    expect(c.refusal).toBe(true);
    expect(c.transient).toBe(false);
  });

  it('5xx + 拒答文案 → 文案特征压过可重试状态码（不再累计渠道失败）', () => {
    const c = classifyUpstreamFailure(ue(503, true, 'response blocked by content filter'));
    expect(c.refusal).toBe(true);
    expect(c.transient).toBe(false);
    expect(c.limited).toBe(false);
  });

  it('401 → authFault；403 无权访问模型 → modelDenied（拒答不抢判定）', () => {
    expect(classifyUpstreamFailure(ue(401, false, 'invalid api key')).authFault).toBe(true);
    const denied = classifyUpstreamFailure(ue(403, false, 'no access to model gpt-x'));
    expect(denied.modelDenied).toBe(true);
    expect(denied.refusal).toBe(false);
    expect(denied.transient).toBe(false);
  });

  it('普通 Error（网络中断/解码失败）→ transient，signal 取 message', () => {
    const c = classifyUpstreamFailure(new Error('socket hang up'));
    expect(c.transient).toBe(true);
    expect(c.limited).toBe(false);
    expect(c.signal).toBe('socket hang up');
    expect(c.status).toBeUndefined();
  });

  it('客户端 4xx 无任何特征 → 全 false（不触健康度，防恶意请求禁用渠道）', () => {
    const c = classifyUpstreamFailure(ue(400, false, 'messages[0].content is required'));
    expect(c).toMatchObject({
      limited: false,
      transient: false,
      authFault: false,
      modelDenied: false,
      refusal: false,
    });
  });
});
