import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConsoleRateLimitGuard } from './console-rate-limit.guard';

/**
 * 控制台每 IP 全局限流的行为特征化：
 * - 只统计 /api/**（/v1 由 ApiKeyGuard 的 RPM/TPM 管，两边不能重复计数）
 * - 超限抛 429 + code=RATE_LIMITED（前端按 api.tooManyRequests 本地化）
 * - Redis 故障放行、CONSOLE_RATE_LIMIT=0 关闭
 */
function makeGuard(opts?: { limit?: string }) {
  const evalMock = jest.fn().mockResolvedValue(1);
  const redis = { client: { eval: evalMock } };
  const env: Record<string, string> = {};
  if (opts?.limit !== undefined) env.CONSOLE_RATE_LIMIT = opts.limit;
  const config = { get: (k: string, d?: string) => env[k] ?? d };
  const guard = new ConsoleRateLimitGuard(redis as never, config as never);
  return { guard, evalMock };
}

function ctxOf(path: string, ip = '203.0.113.7'): ExecutionContext {
  const req = { path, ip, socket: { remoteAddress: ip } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** 捕获 guard 抛出的异常（成功放行则返回 null） */
async function caught(guard: ConsoleRateLimitGuard, path: string) {
  try {
    await guard.canActivate(ctxOf(path));
    return null;
  } catch (e) {
    return e;
  }
}

describe('ConsoleRateLimitGuard', () => {
  it('放行 /api 请求并按 IP+窗口计数（键带 TTL）', async () => {
    const { guard, evalMock } = makeGuard();
    await expect(guard.canActivate(ctxOf('/api/keys'))).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keyCount, key, ttl] = evalMock.mock.calls[0];
    expect(keyCount).toBe(1);
    expect(key).toMatch(/^ratelimit:console:203\.0\.113\.7:\d+$/);
    expect(ttl).toBe(65); // 60s 窗口 + 5s 余量，键不残留
    expect(String(script)).toContain('INCR');
  });

  it('/v1 网关路径不计数（由 ApiKeyGuard 管，互不重复）', async () => {
    const { guard, evalMock } = makeGuard();
    await expect(guard.canActivate(ctxOf('/v1/chat/completions'))).resolves.toBe(true);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('超过上限抛 429 + RATE_LIMITED', async () => {
    const { guard, evalMock } = makeGuard();
    evalMock.mockResolvedValue(601); // 上限 600，本窗口第 601 次
    const err = await caught(guard, '/api/usage/summary');
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    expect(http.getStatus()).toBe(429);
    expect(http.getResponse()).toEqual({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded: 600 requests per 60s',
    });
  });

  it('恰好到上限仍放行，超出才拦', async () => {
    const { guard, evalMock } = makeGuard();
    evalMock.mockResolvedValue(600);
    await expect(guard.canActivate(ctxOf('/api/keys'))).resolves.toBe(true);
    evalMock.mockResolvedValue(601);
    await expect(guard.canActivate(ctxOf('/api/keys'))).rejects.toThrow(HttpException);
  });

  it('Redis 故障时放行（可用性优先，只告警不阻断）', async () => {
    const { guard, evalMock } = makeGuard();
    evalMock.mockRejectedValue(new Error('redis down'));
    await expect(guard.canActivate(ctxOf('/api/channels'))).resolves.toBe(true);
  });

  it('CONSOLE_RATE_LIMIT=0 关闭限流（不碰 Redis）', async () => {
    const { guard, evalMock } = makeGuard({ limit: '0' });
    await expect(guard.canActivate(ctxOf('/api/channels'))).resolves.toBe(true);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('同一窗口同桶号，窗口滚动后换桶', async () => {
    const { guard, evalMock } = makeGuard();
    const bucketOf = (call: unknown[]) =>
      (call[2] as string).slice((call[2] as string).lastIndexOf(':') + 1);

    const nowBucket = Math.floor(Date.now() / 60000);
    await guard.canActivate(ctxOf('/api/models'));
    await guard.canActivate(ctxOf('/api/models'));
    expect(bucketOf(evalMock.mock.calls[0])).toBe(bucketOf(evalMock.mock.calls[1]));
    // 两次调用落在当前窗口或其上一个窗口（跨分钟边界的极小概率）
    const b = Number(bucketOf(evalMock.mock.calls[0]));
    expect([nowBucket, nowBucket - 1]).toContain(b);

    // 窗口秒数可配：CONSOLE_RATE_WINDOW=10 → 桶粒度变粗
    const eval2 = jest.fn().mockResolvedValue(1);
    const g2 = new ConsoleRateLimitGuard(
      { client: { eval: eval2 } } as never,
      { get: (k: string, d?: string) => (k === 'CONSOLE_RATE_WINDOW' ? '10' : d) } as never,
    );
    await g2.canActivate(ctxOf('/api/models'));
    const b10 = Number(bucketOf(eval2.mock.calls[0]));
    expect(Math.floor(Date.now() / 10000)).toBe(b10);
  });
});
