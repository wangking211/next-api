import { ChannelResolverService } from './channel-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ConfigService } from '@nestjs/config';
import { ChannelOwnerType, ChannelStatus } from '@prisma/client';
import { RoutingMetricsService, RouteMetrics } from './routing-metrics.service';
import { GroupsService } from '../groups/groups.service';
import { TtlCacheService } from '../common/ttl-cache.service';
import { fnv1a } from './routing-score';
import { lookup } from 'dns/promises';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

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
  cache?: TtlCacheService,
  /** 测试默认关闭首选权重抽签（排序断言需要确定性）；抽签用例按需覆盖 */
  configVars: Record<string, string> = { ROUTING_WEIGHT_TAU: '0' },
) {
  const prisma = {
    channelModel: { findMany: jest.fn().mockResolvedValue(rows) },
    modelCatalog: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    channel: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const crypto = {
    decrypt: jest.fn((s: string) => (decryptImpl ? decryptImpl(s) : `key:${s}`)),
  };
  const metrics = {
    snapshot: jest.fn().mockResolvedValue(metricsMap ?? new Map<string, RouteMetrics>()),
    record: jest.fn(),
  };
  const config = {
    get: (k: string, d?: string) => (k in configVars ? configVars[k] : d),
  } as unknown as ConfigService;
  const groups = {
    channelVisibilityWhere: jest.fn((groupId: string | null) =>
      groupId ? { OR: [{ groups: { none: {} } }, { groups: { some: { id: groupId } } }] } : null,
    ),
    // 可见性统一由 GroupsService 给出：这里只回一个可断言的标记，
    // 「共享渠道 / 平台渠道」的具体条件由 groups.service.spec 覆盖
    channelScopeWhere: jest.fn((userId: string, groupId: string | null) => ({
      __scope: `${userId}|${groupId ?? 'none'}`,
    })),
  };
  return {
    service: new ChannelResolverService(
      prisma as unknown as PrismaService,
      crypto as unknown as CryptoService,
      metrics as unknown as RoutingMetricsService,
      groups as unknown as GroupsService,
      config,
      cache,
    ),
    prisma,
    metrics,
    groups,
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
      channel: makeChannel({
        id: 'own',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'u1',
        priority: 0,
      }),
    });
    const { service } = makeService([platform, own]);
    const result = await service.resolve('u1', 'm');
    expect(ids(result)).toEqual(['own', 'platform']);
  });

  it('SSRF 请求时复验（DNS rebinding）：production 下解析到私网的渠道被剔除，公网保留', async () => {
    const evil = makeCM({
      channel: makeChannel({ id: 'evil', baseUrl: 'http://rebind.resolver-evil.example/v1' }),
    });
    const good = makeCM({
      channel: makeChannel({ id: 'good', baseUrl: 'http://rebind.resolver-ok.example/v1' }),
    });
    const { service } = makeService([evil, good]);
    const lookupMock = lookup as unknown as jest.Mock;
    lookupMock.mockImplementation((host: string) =>
      Promise.resolve(
        host.includes('evil')
          ? [{ address: '169.254.169.254', family: 4 }] // 云元数据地址
          : [{ address: '93.184.216.34', family: 4 }],
      ),
    );

    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // 复验只在 production 生效
    try {
      const result = await service.resolve('u1', 'm');
      expect(ids(result)).toEqual(['good']);
    } finally {
      process.env.NODE_ENV = saved;
    }
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

  it('同层首选按权重抽签：ROUTING_WEIGHT_TAU>0 时同层高权重候选被抽中置顶', async () => {
    const poor = makeCM({ channel: makeChannel({ id: 'poor', weight: 1, priority: 5 }) });
    const heavy = makeCM({ channel: makeChannel({ id: 'heavy', weight: 100, priority: 5 }) });
    const { service } = makeService([poor, heavy], undefined, undefined, undefined, {
      ROUTING_WEIGHT_TAU: '0.1',
    });
    // 随机数全部等值 → gumbel 项相同 → 抽签值由 分数/τ + ln(权重) 决定，
    // heavy 的 ln(100)≈4.6 稳压噪声项 → 确定性中签（统计行为在 routing-score.spec 覆盖）
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const result = await service.resolve('u1', 'm');
      expect(ids(result)[0]).toBe('heavy');
      // 其余候选保持分数序（poor 单独垫底）
      expect(ids(result)).toEqual(['heavy', 'poor']);
    } finally {
      spy.mockRestore();
    }
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
    const { service, prisma, groups } = makeService([]);
    await service.resolve('u1', 'gpt-4o');
    const arg = prisma.channelModel.findMany.mock.calls[0][0];
    expect(arg.where.modelName).toBe('gpt-4o');
    expect(arg.where.enabled).toBe(true);
    // 可用性：启用，或自动禁用已过冷却期
    expect(arg.where.channel.AND[0].OR).toHaveLength(2);
    expect(arg.where.channel.AND[0].OR[0].status).toBe(ChannelStatus.ENABLED);
    // 渠道可见性：整体来自 GroupsService.channelScopeWhere（含共享渠道，见 groups.service.spec）
    expect(groups.channelScopeWhere).toHaveBeenCalledWith('u1', null);
    expect(arg.where.channel.AND[1]).toEqual({ __scope: 'u1|none' });
  });

  it('生效分组存在时，可见性交给 GroupsService 统一计算（含共享渠道）', async () => {
    const { service, prisma, groups } = makeService([]);
    await service.resolve('u1', 'gpt-4o', { groupId: 'g1' });
    const arg = prisma.channelModel.findMany.mock.calls[0][0];
    // 可见性条件整体来自 GroupsService.channelScopeWhere（内部已限定 ownerType）
    expect(arg.where.channel.AND[1]).toEqual({ __scope: 'u1|g1' });
    expect(groups.channelScopeWhere).toHaveBeenCalledWith('u1', 'g1');
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
      new Map([
        ['a', mm({ open: true })],
        ['b', mm()],
      ]),
    );
    expect(ids(await one.service.resolve('u1', 'm'))).toEqual(['b']);

    const all = makeService(
      [a, b],
      undefined,
      new Map([
        ['a', mm({ open: true })],
        ['b', mm({ open: true })],
      ]),
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

  it('resolves aliases to the canonical model name', async () => {
    const { service, prisma } = makeService([]);
    prisma.modelCatalog.findFirst.mockResolvedValue({ name: 'gpt-5.1' });
    await expect(service.resolveAlias('gpt-5')).resolves.toBe('gpt-5.1');
    const arg = prisma.modelCatalog.findFirst.mock.calls[0][0];
    expect(arg.where.OR[0]).toEqual({ name: 'gpt-5' });
    expect(arg.where.OR[1]).toEqual({ aliases: { has: 'gpt-5' } });
  });

  it('strips the :latest suffix and re-resolves the base name', async () => {
    const { service, prisma } = makeService([]);
    // 第一次查 `gpt-5:latest` 无命中，第二次查 `gpt-5` 命中别名 → 规范名
    prisma.modelCatalog.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: 'gpt-5.1' });
    await expect(service.resolveAlias('gpt-5:latest')).resolves.toBe('gpt-5.1');
  });

  it('falls back to stripping :latest when the catalog has no match', async () => {
    const { service } = makeService([]);
    await expect(service.resolveAlias('unknown:latest')).resolves.toBe('unknown');
  });

  it('returns unknown model names unchanged', async () => {
    const { service } = makeService([]);
    await expect(service.resolveAlias('mystery-model')).resolves.toBe('mystery-model');
  });

  describe('allowedModelSet / isModelAllowed', () => {
    it('returns null for an empty whitelist (no restriction)', async () => {
      const { service, prisma } = makeService([]);
      await expect(service.allowedModelSet([])).resolves.toBeNull();
      expect(prisma.modelCatalog.findMany).not.toHaveBeenCalled();
    });

    it('normalizes catalog hits to canonical names in one batch query', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([{ name: 'gpt-5.1', aliases: ['gpt-5'] }]);
      const set = await service.allowedModelSet(['gpt-5', 'unknown-model']);
      expect(set).toEqual(new Set(['gpt-5.1', 'unknown-model']));
      const arg = prisma.modelCatalog.findMany.mock.calls[0][0];
      expect(arg.where.OR).toEqual([
        { name: { in: ['gpt-5', 'unknown-model'] } },
        { aliases: { hasSome: ['gpt-5', 'unknown-model'] } },
      ]);
    });

    it('strips :latest from whitelist entries', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([]);
      const set = await service.allowedModelSet(['gpt-5:latest']);
      expect(set).toEqual(new Set(['gpt-5']));
    });

    it('degrades to literal matching when the catalog query fails', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockRejectedValue(new Error('db down'));
      const set = await service.allowedModelSet(['gpt-4o']);
      expect(set).toEqual(new Set(['gpt-4o']));
    });

    it('allows any model when the whitelist is empty', async () => {
      const { service } = makeService([]);
      await expect(service.isModelAllowed('anything', [])).resolves.toBe(true);
    });

    it('allows via the zero-query literal fast path (stripped :latest)', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([]);
      await expect(service.isModelAllowed('gpt-4o:latest', ['gpt-4o'])).resolves.toBe(true);
      expect(prisma.modelCatalog.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to alias resolution when the literal path misses', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([
        { name: 'claude-sonnet-4-5', aliases: ['sonnet'] },
      ]);
      prisma.modelCatalog.findFirst.mockResolvedValue({ name: 'claude-sonnet-4-5' });
      // 请求用别名、白名单存规范名 → 字面未命中 → 走 resolveAlias（findFirst）
      await expect(service.isModelAllowed('sonnet', ['claude-sonnet-4-5'])).resolves.toBe(true);
      expect(prisma.modelCatalog.findFirst).toHaveBeenCalled();
    });

    it('hits the fast path when the whitelist alias normalizes to the requested canonical name', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([
        { name: 'claude-sonnet-4-5', aliases: ['sonnet'] },
      ]);
      // 白名单 [sonnet] 归一为 claude-sonnet-4-5，与请求规范名字面一致 → 0 次 findFirst
      await expect(service.isModelAllowed('claude-sonnet-4-5', ['sonnet'])).resolves.toBe(true);
      expect(prisma.modelCatalog.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a model outside the whitelist', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([]);
      prisma.modelCatalog.findFirst.mockResolvedValue(null);
      await expect(service.isModelAllowed('o3-mini', ['gpt-4o'])).resolves.toBe(false);
    });

    it('treats a missing requested model as allowed', async () => {
      const { service, prisma } = makeService([]);
      prisma.modelCatalog.findMany.mockResolvedValue([]);
      await expect(service.isModelAllowed('', ['gpt-4o'])).resolves.toBe(true);
    });
  });
});

/**
 * 目录快照缓存：注入 TtlCacheService 后，别名解析 / 白名单 / 元数据 / 定价都走 60s 内存副本
 * （key `catalog:all`，loader 为 modelCatalog 全表 findMany），写路径在 models.service 按前缀失效。
 */
describe('ChannelResolverService catalog 快照缓存', () => {
  const ROW = {
    name: 'gpt-5.1',
    aliases: ['gpt-5'],
    provider: 'openai',
    capabilities: ['tool'],
    inputPrice: '1',
    outputPrice: '2',
    cacheReadPrice: '0.1',
    cacheWritePrice: '0.2',
    perCallPrice: null,
  };

  it('resolveAlias 命中快照：只加载一次，不走 findFirst', async () => {
    const { service, prisma } = makeService([], undefined, undefined, new TtlCacheService());
    prisma.modelCatalog.findMany.mockResolvedValue([ROW]);

    await expect(service.resolveAlias('gpt-5')).resolves.toBe('gpt-5.1');
    await expect(service.resolveAlias('gpt-5')).resolves.toBe('gpt-5.1');

    expect(prisma.modelCatalog.findFirst).not.toHaveBeenCalled();
    expect(prisma.modelCatalog.findMany).toHaveBeenCalledTimes(1);
  });

  it('allowedModelSet 与 catalogFor 共享同一份快照', async () => {
    const { service, prisma } = makeService([], undefined, undefined, new TtlCacheService());
    prisma.modelCatalog.findMany.mockResolvedValue([ROW]);

    await expect(service.allowedModelSet(['gpt-5'])).resolves.toEqual(new Set(['gpt-5.1']));
    const meta = await service.catalogFor(['gpt-5.1']);

    expect(meta.get('gpt-5.1')).toMatchObject({ provider: 'openai', capabilities: ['tool'] });
    expect(prisma.modelCatalog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.modelCatalog.findFirst).not.toHaveBeenCalled();
  });

  it('resolve 从快照 + 渠道行本地派生 pricing，不再 findUnique 目录', async () => {
    const { service, prisma } = makeService(
      [
        makeCM({
          priceInput: 3,
          priceOutput: 6,
          costInput: 0.4,
          costOutput: 0.8,
        }),
      ],
      undefined,
      undefined,
      new TtlCacheService(),
    );
    prisma.modelCatalog.findMany.mockResolvedValue([{ ...ROW, name: 'm', aliases: [] }]);

    const res = await service.resolve('u1', 'm');

    expect(res).toHaveLength(1);
    expect(res[0].pricing).toEqual({
      priceInput: 3,
      priceOutput: 6,
      costInput: 0.4,
      costOutput: 0.8,
      cacheReadPrice: 0.1,
      cacheWritePrice: 0.2,
      cacheReadCost: 0.1,
      cacheWriteCost: 0.2,
      pricePerCall: 0,
      costPerCall: 0,
      explicit: true,
    });
    expect(prisma.modelCatalog.findUnique).not.toHaveBeenCalled();
  });

  it('models.service 失效 catalog: 前缀后自动重载', async () => {
    const cache = new TtlCacheService();
    const { service, prisma } = makeService([], undefined, undefined, cache);
    prisma.modelCatalog.findMany.mockResolvedValue([ROW]);

    await service.resolveAlias('gpt-5');
    cache.invalidate('catalog:');
    await service.resolveAlias('gpt-5');

    expect(prisma.modelCatalog.findMany).toHaveBeenCalledTimes(2);
  });

  it('目录里 enabled=false 的模型不路由、也不出现在可用模型列表', async () => {
    const { service, prisma } = makeService(
      [makeCM({})],
      undefined,
      undefined,
      new TtlCacheService(),
    );
    prisma.modelCatalog.findMany.mockResolvedValue([
      { ...ROW, name: 'm', aliases: [], enabled: false },
    ]);

    await expect(service.resolve('u1', 'm')).resolves.toEqual([]);

    prisma.channelModel.findMany.mockResolvedValue([
      { modelName: 'm' },
      { modelName: 'gpt-5.1' },
    ] as never);
    await expect(service.availableModels('u1')).resolves.toEqual(['gpt-5.1']);
  });

  it('有分组时可见性交给 GroupsService，不再就地拼条件', async () => {
    const { service, prisma, groups } = makeService([]);
    await service.resolve('u1', 'm', { groupId: 'g1' });

    const where = prisma.channelModel.findMany.mock.calls[0][0].where;
    expect(where.channel.AND[1]).toEqual({ __scope: 'u1|g1' });
    expect(groups.channelScopeWhere).toHaveBeenCalledWith('u1', 'g1');

    await service.availableModels('u1', 'g1');
    const availWhere = prisma.channelModel.findMany.mock.calls[1][0].where;
    expect(availWhere.channel.AND[1]).toEqual({ __scope: 'u1|g1' });
  });

  it('共享额度用尽/到期的渠道不再派发', async () => {
    const expired = makeCM({
      channel: makeChannel({
        id: 'expired',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareUntil: new Date(Date.now() - 60_000),
      }),
    });
    const overQuota = makeCM({
      channel: makeChannel({
        id: 'over',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareQuotaCostUsd: 1,
        shareUsedCostUsd: 1,
      }),
    });
    const ok = makeCM({
      channel: makeChannel({
        id: 'ok',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareQuotaCostUsd: 5,
        shareUsedCostUsd: 1,
      }),
    });

    const { service } = makeService([expired, overQuota, ok]);
    await expect(service.resolve('u1', 'm')).resolves.toHaveLength(1);
    const res = await service.resolve('u1', 'm');
    expect(res[0].channel.id).toBe('ok');
  });

  it('渠道主自己的调用豁免共享闸门：已到期渠道仍派发给 owner', async () => {
    const expired = makeCM({
      channel: makeChannel({
        id: 'expired',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareUntil: new Date(Date.now() - 60_000),
      }),
    });
    const { service } = makeService([expired]);
    const res = await service.resolve('owner', 'm');
    expect(res).toHaveLength(1);
    expect(res[0].channel.id).toBe('expired');
    // 他人调用仍被拦截（回归原闸门行为）
    await expect(service.resolve('u1', 'm')).resolves.toHaveLength(0);
  });

  it('availableModels 豁免渠道主：已到期渠道的模型仍对 owner 可见', async () => {
    const expired = makeCM({
      channel: makeChannel({
        id: 'expired',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareUntil: new Date(Date.now() - 60_000),
      }),
    });
    const { service } = makeService([expired]);
    await expect(service.availableModels('owner')).resolves.toEqual(['m']);
    await expect(service.availableModels('u1')).resolves.toEqual([]);
  });

  it('共享紧急度按质量分门槛加优先级（FLUSH > HIGH > NORMAL）', async () => {
    const flush = makeCM({
      channel: makeChannel({
        id: 'flush',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareUrgency: 'FLUSH',
      }),
    });
    const normal = makeCM({
      channel: makeChannel({
        id: 'normal',
        ownerType: ChannelOwnerType.USER,
        ownerUserId: 'owner',
        shareMode: 'PUBLIC',
        shareUrgency: 'NORMAL',
      }),
    });
    // 同 tier（都是他人渠道→tier1）、同 priority，仅紧急度不同 → FLUSH 在前
    const { service } = makeService([normal, flush]);
    const ids = (await service.resolve('u1', 'm')).map((c) => c.channel.id);
    expect(ids[0]).toBe('flush');
  });
});
