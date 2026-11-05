import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { ExchangeRateService } from './exchange-rate.service';

const CACHE_KEY = 'pay:fx:usd_cny';
const LAST_KEY = 'pay:fx:usd_cny:last';

function makeService(opts: { env?: Record<string, string>; seed?: Record<string, string> } = {}) {
  const env = { ...(opts.env ?? {}) };
  const store: Record<string, string> = { ...(opts.seed ?? {}) };
  const config = {
    get: (k: string, d?: string) => env[k] ?? d,
  } as unknown as ConfigService;
  const redis = {
    client: {
      get: jest.fn(async (k: string) => store[k] ?? null),
      set: jest.fn(async (k: string, v: string) => {
        store[k] = v;
        return 'OK';
      }),
    },
  };
  const service = new ExchangeRateService(config, redis as unknown as RedisService);
  return { service, redis, store, config };
}

/** 带 DailyFxRate 快照写入的构造（第三参 @Optional） */
function makeSnapshotService(
  opts: { env?: Record<string, string>; seed?: Record<string, string> } = {},
) {
  const base = makeService(opts);
  const prisma = {
    dailyFxRate: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const service = new ExchangeRateService(
    base.config,
    base.redis as unknown as RedisService,
    prisma as any,
  );
  return { ...base, service, prisma };
}

function mockRateJson(rate: unknown) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rates: { CNY: rate } }),
    } as any);
}

describe('ExchangeRateService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the fixed env rate without calling the API', async () => {
    const { service, redis } = makeService({ env: { PAY_CNY_PER_USD: '6.9' } });
    const spy = mockRateJson(7.2);
    await expect(service.getCnyPerUsd()).resolves.toBe(6.9);
    expect(spy).not.toHaveBeenCalled();
    expect(redis.client.get).not.toHaveBeenCalled();
  });

  it('ignores an out-of-range fixed rate and falls back to the API', async () => {
    const { service } = makeService({ env: { PAY_CNY_PER_USD: '0.5' } });
    mockRateJson(7.15);
    await expect(service.getCnyPerUsd()).resolves.toBe(7.15);
  });

  it('fetches the live rate and caches it with a TTL', async () => {
    const { service, redis, store } = makeService({
      env: { PAY_RATE_TTL_MS: '3600000' },
    });
    const spy = mockRateJson(7.11);
    await expect(service.getCnyPerUsd()).resolves.toBe(7.11);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(redis.client.set).toHaveBeenCalledWith(CACHE_KEY, '7.11', 'PX', 3600000);
    expect(store[LAST_KEY]).toBe('7.11');
  });

  it('memoizes within the process to protect the public config endpoint', async () => {
    const { service } = makeService();
    const spy = mockRateJson(7.1);
    await service.getCnyPerUsd();
    await service.getCnyPerUsd();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('serves a cached rate without hitting the API', async () => {
    const { service } = makeService({ seed: { [CACHE_KEY]: '7.33' } });
    const spy = mockRateJson(7.2);
    await expect(service.getCnyPerUsd()).resolves.toBe(7.33);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the last known rate when the API fails', async () => {
    const { service } = makeService({ seed: { [LAST_KEY]: '7.05' } });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(service.getCnyPerUsd()).resolves.toBe(7.05);
  });

  it('rejects garbage API payloads and uses the last known rate', async () => {
    const { service } = makeService({ seed: { [LAST_KEY]: '7.02' } });
    mockRateJson('abc');
    await expect(service.getCnyPerUsd()).resolves.toBe(7.02);
  });

  it('throws when the API fails and no fallback exists', async () => {
    const { service } = makeService();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(service.getCnyPerUsd()).rejects.toThrow(/实时汇率获取失败/);
  });

  it('still fetches when Redis is unavailable', async () => {
    const { service, redis } = makeService();
    (redis.client.get as jest.Mock).mockRejectedValue(new Error('redis down'));
    (redis.client.set as jest.Mock).mockRejectedValue(new Error('redis down'));
    mockRateJson(7.18);
    await expect(service.getCnyPerUsd()).resolves.toBe(7.18);
  });

  describe('当日汇率快照（DailyFxRate，供对账人民币列按日取值）', () => {
    it('取到汇率后 upsert 当日快照（北京时间日）', async () => {
      const { service, prisma } = makeSnapshotService({ env: { PAY_CNY_PER_USD: '6.9' } });

      await expect(service.getCnyPerUsd()).resolves.toBe(6.9);

      expect(prisma.dailyFxRate.upsert).toHaveBeenCalledTimes(1);
      const args = prisma.dailyFxRate.upsert.mock.calls[0][0];
      expect(args.where.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(args.create.day).toBe(args.where.day);
      expect(Number(args.create.cnyPerUsd)).toBe(6.9);
      expect(Number(args.update.cnyPerUsd)).toBe(6.9);
    });

    it('进程内 5 分钟节流：重复取值不反复写库', async () => {
      const { service, prisma } = makeSnapshotService({ env: { PAY_CNY_PER_USD: '7.0' } });

      await service.getCnyPerUsd();
      await service.getCnyPerUsd();
      await service.getCnyPerUsd();

      expect(prisma.dailyFxRate.upsert).toHaveBeenCalledTimes(1);
    });

    it('快照写库失败 fail-open：不影响汇率返回', async () => {
      const { service, prisma } = makeSnapshotService({ env: { PAY_CNY_PER_USD: '7.2' } });
      prisma.dailyFxRate.upsert.mockRejectedValue(new Error('db down'));

      await expect(service.getCnyPerUsd()).resolves.toBe(7.2);
    });

    it('未注入 Prisma（@Optional 缺省）时跳过快照，取值不受影响', async () => {
      const { service } = makeService({ env: { PAY_CNY_PER_USD: '6.5' } });

      await expect(service.getCnyPerUsd()).resolves.toBe(6.5);
    });
  });
});
