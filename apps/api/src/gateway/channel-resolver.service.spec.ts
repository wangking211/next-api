import { ChannelResolverService } from './channel-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ConfigService } from '@nestjs/config';
import { ChannelOwnerType, ChannelStatus } from '@prisma/client';
import { RoutingMetricsService, RouteMetrics } from './routing-metrics.service';
import { fnv1a } from './routing-score';

function makeChannel(overrides: Record<string, unknown>) {
  return {
    id: String(Math.random()),
    ownerType: ChannelOwnerType.PLATFORM,
    ownerUserId: null,
    name: 'c',
    provider: 'openai',
    baseUrl: 'http://x/v1',
    apiKeyEnc: 'enc',
    models: ['m'],
    weight: 1,
    priority: 0,
    status: 'ENABLED',
    failureCount: 0,
    autoDisabled: false,
    lastErrorAt: null,
    dailyRequestLimit: null,
    dailyTokenLimit: null,
    ...overrides,
  } as any;
}

function makeCM(overrides: Record<string, unknown>) {
  return {
    id: String(Math.random()),
    channelId: 'c',
    modelName: 'm',
    enabled: true,
    costInput: null,
    costDiscount: null,
    priority: null,
    weight: null,
    qualityScore: 1,
    channel: makeChannel({}),
    ...overrides,
  } as any;
}

function mm(p: Partial<RouteMetrics> = {}): RouteMetrics {
  return {
    ok: 0,
    fail: 0,
    r429: 0,
    latSum: 0,
    latN: 0,
    slow: 0,
    slowTotal: 0,
    outSum: 0,
    outN: 0,
    valid: 0,
    inval: 0,
    refuse: 0,
    dayReq: 0,
    dayTok: 0,
    cf: 0,
    cdexp: 0,
    open: false,
    halfOpen: false,
    ...p,
  };
}

function makeService(
  rows: any[],
  decryptImpl?: (s: string) => string,
  metricsMap?: Map<string, RouteMetrics>,
) {
  const prisma = {
    channelModel: { findMany: jest.fn().mockResolvedValue(rows) },
    modelCatalog: { findUnique: jest.fn().mockResolvedValue(null) },
    channel: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const crypto = {
    decrypt: jest.fn((s: string) => (decryptImpl ? decryptImpl(s) : `key:${s}`)),
  };
  const metrics = {
    snapshot: jest.fn().mockResolvedValue(metricsMap ?? new Map<string, RouteMetrics>()),
    record: jest.fn(),
  };
  const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
  return {
    service: new ChannelResolverService(
      prisma as unknown as PrismaService,
      crypto as unknown as CryptoService,
      metrics as unknown as RoutingMetricsService,
      config,
    ),
    prisma,
    metrics,
  };
}

const ids = (r: { channel: { id: string } }[]) => r.map((x) => x.channel.id);
/** 找一个 FNV-1a 映射到指定下标的粘性键 */
function stickyKeyFor(idx: number, mod: number): string {
  for (let i = 0; i < 1000; i++) {
    const k = `s${i}`;
    if (fnv1a(k) % mod === idx) return k;
  }
  throw new Error('no sticky key found');
}

describe('ChannelResolverService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('prioritizes user BYOK channels over platform channels', async () => {
    const platform = makeCM({
      channel: makeChannel({ id: 'platform', ownerType: ChannelOwnerType.PLATFORM, priority: 999 }),
    });
    const own = makeCM({
      channel: makeChannel({ id: 'own', ownerType: ChannelOwnerType.USER, ownerUserId: 'u1', priority: 0 }),
    });
    const { service } = makeService([platform, own]);
    const result = await service.resolve('u1', 'm');
    expect(ids(result)).toEqual(['own', 'platform']);
  });

  it('orders by priority descending within the same tier', async () => {
    const low = makeCM({ channel: makeChannel({ id: 'low', priority: 1 }) });
    const high = makeCM({ channel: makeChannel({ id: 'high', priority: 10 }) });
    const { service } = makeService([low, high]);
    expect(ids(await service.resolve('u1', 'm'))).toEqual(['high', 'low']);
  });

  it('prefers lower upstream cost within the same priority and tier', async () => {
    const expensive = makeCM({ costInput: 5, channel: makeChannel({ id: 'exp', priority: 0 }) });
    const cheap = makeCM({ costInput: 1, channel: makeChannel({ id: 'cheap', priority: 0 }) });
    const { service } = makeService([expensive, cheap]);
    expect(ids(await service.resolve('u1', 'm'))).toEqual(['cheap', 'exp']);
  });

  it('skips channels that fail to decrypt', async () => {
    const bad = makeCM({ channel: makeChannel({ id: 'bad', apiKeyEnc: 'broken' }) });
    const good = makeCM({ channel: makeChannel({ id: 'good', apiKeyEnc: 'ok' }) });
    const { service } = makeService([bad, good], (s) => {
      if (s === 'broken') throw new Error('nope');
      return 'key';
    });
    expect(ids(await service.resolve('u1', 'm'))).toEqual(['good']);
  });

  it('queries enabled channel-model rows for the model', async () => {
    const { service, prisma } = makeService([]);
    await service.resolve('u1', 'gpt-4o');
    const arg = prisma.channelModel.findMany.mock.calls[0][0];
    expect(arg.where.modelName).toBe('gpt-4o');
    expect(arg.where.enabled).toBe(true);
    expect(arg.where.channel.OR).toHaveLength(2);
    // 可用性：启用，或自动禁用已过冷却期
    expect(arg.where.channel.AND[0].OR).toHaveLength(2);
    expect(arg.where.channel.AND[0].OR[0].status).toBe(ChannelStatus.ENABLED);
  });

  it('honors the routing strategy option (CHEAPEST vs FASTEST)', async () => {
    const cheap = makeCM({ costInput: 1, channel: makeChannel({ id: 'cheap', priority: 0 }) });
    const fast = makeCM({ costInput: 10, channel: makeChannel({ id: 'fast', priority: 0 }) });
    const map = new Map<string, RouteMetrics>([
      ['cheap', mm({ latN: 10, latSum: 100000 })],
      ['fast', mm({ latN: 10, latSum: 2000 })],
    ]);

    const a = makeService([cheap, fast], undefined, map);
    expect(ids(await a.service.resolve('u1', 'm', { strategy: 'CHEAPEST' }))).toEqual([
      'cheap',
      'fast',
    ]);

    const b = makeService([cheap, fast], undefined, map);
    expect(ids(await b.service.resolve('u1', 'm', { strategy: 'FASTEST' }))).toEqual([
      'fast',
      'cheap',
    ]);
  });

  it('excludes cooling-down channels and falls back when all are cooling', async () => {
    const a = makeCM({ channel: makeChannel({ id: 'a', priority: 0 }) });
    const b = makeCM({ channel: makeChannel({ id: 'b', priority: 0 }) });

    const one = makeService(
      [a, b],
      undefined,
      new Map([['a', mm({ open: true })], ['b', mm()]]),
    );
    expect(ids(await one.service.resolve('u1', 'm'))).toEqual(['b']);

    const all = makeService(
      [a, b],
      undefined,
      new Map([['a', mm({ open: true })], ['b', mm({ open: true })]]),
    );
    expect(await all.service.resolve('u1', 'm')).toHaveLength(2); // 兜底放行
  });

  it('excludes channels that hit their daily request limit', async () => {
    const full = makeCM({
      channel: makeChannel({ id: 'full', priority: 0, dailyRequestLimit: 100 }),
    });
    const free = makeCM({
      channel: makeChannel({ id: 'free', priority: 0, dailyRequestLimit: 100 }),
    });
    const map = new Map<string, RouteMetrics>([
      ['full', mm({ dayReq: 100 })],
      ['free', mm({ dayReq: 99 })],
    ]);
    const { service } = makeService([full, free], undefined, map);
    expect(ids(await service.resolve('u1', 'm'))).toEqual(['free']);
  });

  it('excludes channels that hit their daily token limit', async () => {
    const used = makeCM({
      channel: makeChannel({ id: 'used', priority: 0, dailyTokenLimit: 1000 }),
    });
    const fresh = makeCM({ channel: makeChannel({ id: 'fresh', priority: 0 }) });
    const map = new Map<string, RouteMetrics>([
      ['used', mm({ dayTok: 5000 })],
      ['fresh', mm({ dayTok: 10 })],
    ]);
    const { service } = makeService([used, fresh], undefined, map);
    expect(ids(await service.resolve('u1', 'm'))).toEqual(['fresh']);
  });

  it('ranks half-open candidates behind healthy ones', async () => {
    const half = makeCM({ channel: makeChannel({ id: 'half', priority: 0 }), costInput: 1 });
    const good = makeCM({ channel: makeChannel({ id: 'good', priority: 0 }), costInput: 5 });
    const map = new Map<string, RouteMetrics>([
      ['half', mm({ cf: 3, halfOpen: true, ok: 100, latN: 10, latSum: 1000 })],
      ['good', mm({ ok: 1, fail: 1, latN: 2, latSum: 90000 })],
    ]);
    const { service } = makeService([half, good], undefined, map);
    expect(ids(await service.resolve('u1', 'm'))[0]).toBe('good');
  });

  it('half-open recovery re-enables an auto-disabled channel', async () => {
    const row = makeCM({
      channel: makeChannel({
        id: 'z',
        status: ChannelStatus.DISABLED,
        autoDisabled: true,
        lastErrorAt: new Date(0),
      }),
    });
    const { service, prisma } = makeService([row]);
    expect(await service.resolve('u1', 'm')).toHaveLength(1);
    expect(prisma.channel.updateMany).toHaveBeenCalledWith({
      where: { id: 'z', status: ChannelStatus.DISABLED, autoDisabled: true },
      data: { status: ChannelStatus.ENABLED, autoDisabled: false, failureCount: 4 },
    });
  });

  it('sticks to a same-group candidate when scores are close', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // 噪声一致 → 同分稳定排序
    const a = makeCM({ channel: makeChannel({ id: 'a', priority: 0 }), costInput: 1 });
    const b = makeCM({ channel: makeChannel({ id: 'b', priority: 0 }), costInput: 1 });
    const { service } = makeService([a, b]);
    const res = await service.resolve('u1', 'm', { stickyKey: stickyKeyFor(1, 2) });
    expect(res[0].channel.id).toBe('b');
  });

  it('does not stick across priority boundaries', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const hi = makeCM({ channel: makeChannel({ id: 'hi', priority: 10 }), costInput: 1 });
    const lo = makeCM({ channel: makeChannel({ id: 'lo', priority: 0 }), costInput: 1 });
    const { service } = makeService([hi, lo]);
    expect(ids(await service.resolve('u1', 'm', { stickyKey: stickyKeyFor(1, 2) }))).toEqual([
      'hi',
      'lo',
    ]);
  });

  it('does not stick a clearly worse candidate', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const cheap = makeCM({ channel: makeChannel({ id: 'cheap', priority: 0 }), costInput: 1 });
    const pricey = makeCM({ channel: makeChannel({ id: 'pricey', priority: 0 }), costInput: 10 });
    const { service } = makeService([cheap, pricey]);
    expect(ids(await service.resolve('u1', 'm', { stickyKey: stickyKeyFor(1, 2) }))).toEqual([
      'cheap',
      'pricey',
    ]);
  });
});
