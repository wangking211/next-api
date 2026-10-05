import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter.service';
import { RedisService } from '../redis/redis.service';

function makeService(defaultRpm = '0') {
  const evalFn = jest.fn();
  const redis = { client: { eval: evalFn } };
  const config = { get: jest.fn().mockReturnValue(defaultRpm) };
  const service = new RateLimiterService(
    redis as unknown as RedisService,
    config as unknown as ConfigService,
  );
  return { service, evalFn, config };
}

/** 与服务端同口径的固定窗口桶号 */
const minuteBucket = () => Math.floor(Date.now() / 60000);

describe('RateLimiterService.check（RPM 固定窗口）', () => {
  it('默认 0（不限流）→ 放行且不访问 Redis；配置读取走 DEFAULT_RPM', async () => {
    const { service, evalFn, config } = makeService();
    await expect(service.check('k1', null)).resolves.toBeUndefined();
    await expect(service.check('k1', 0)).resolves.toBeUndefined();
    expect(evalFn).not.toHaveBeenCalled();
    expect(config.get).toHaveBeenCalledWith('DEFAULT_RPM', '0');
  });

  it('key 未设上限 → 回退 DEFAULT_RPM 配置并限流', async () => {
    const { service, evalFn } = makeService('2');
    evalFn.mockResolvedValue(3);
    await expect(service.check('k1', null)).rejects.toBeInstanceOf(HttpException);
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      `ratelimit:key:k1:${minuteBucket()}`,
      65,
    );
  });

  it('计数恰好等于上限 → 放行（边界不误杀）', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockResolvedValue(3);
    await expect(service.check('k1', 3)).resolves.toBeUndefined();
  });

  it('超限 → 429 + OpenAI 错误体（rate_limit_exceeded）', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockResolvedValue(4);
    const err = await service.check('k1', 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({
      error: {
        message: 'Rate limit exceeded: 3 requests per minute',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
  });

  it('anthropic 客户端 → Anthropic 错误体（type=rate_limit_error）', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockResolvedValue(4);
    const err = await service.check('k1', 3, 'anthropic').catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded: 3 requests per minute' },
    });
  });

  it('Redis 故障 → fail-open 放行，不抛错', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockRejectedValue(new Error('redis down'));
    await expect(service.check('k1', 1)).resolves.toBeUndefined();
  });
});

describe('RateLimiterService.checkTpm（TPM 预扣）', () => {
  it('无上限 / 预估 token 为 0 → 返回 null 且不访问 Redis', async () => {
    const { service, evalFn } = makeService();
    await expect(service.checkTpm('k1', null, 500)).resolves.toBeNull();
    await expect(service.checkTpm('k1', 1000, 0)).resolves.toBeNull();
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('预扣成功 → 返回窗口桶号，参数含预估值与上限', async () => {
    const { service, evalFn } = makeService();
    const bucket = minuteBucket();
    evalFn.mockResolvedValue(500);
    await expect(service.checkTpm('k1', 1000, 500)).resolves.toBe(bucket);
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      `ratelimit:tpm:k1:${bucket}`,
      500,
      1000,
    );
  });

  it('预扣超限（Lua 返回 -1）→ 429 + OpenAI 错误体（tokens_per_minute_exceeded）', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockResolvedValue(-1);
    const err = await service.checkTpm('k1', 1000, 1500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({
      error: {
        message: 'Rate limit exceeded: 1000 tokens per minute',
        type: 'rate_limit_error',
        code: 'tokens_per_minute_exceeded',
      },
    });
  });

  it('Redis 故障 → fail-open 返回 null', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockRejectedValue(new Error('redis down'));
    await expect(service.checkTpm('k1', 1000, 500)).resolves.toBeNull();
  });
});

describe('RateLimiterService.adjustTpm（事后校正）', () => {
  it('delta=0 → 不访问 Redis', async () => {
    const { service, evalFn } = makeService();
    await expect(service.adjustTpm('k1', 123, 0)).resolves.toBeUndefined();
    expect(evalFn).not.toHaveBeenCalled();
  });

  it('非 0 delta → 对预扣同一桶 INCRBY', async () => {
    const { service, evalFn } = makeService();
    await expect(service.adjustTpm('k1', 123, 50)).resolves.toBeUndefined();
    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, 'ratelimit:tpm:k1:123', 50);
  });

  it('Redis 故障 → 仅告警不抛错', async () => {
    const { service, evalFn } = makeService();
    evalFn.mockRejectedValue(new Error('redis down'));
    await expect(service.adjustTpm('k1', 123, -50)).resolves.toBeUndefined();
  });
});
