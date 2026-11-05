import { ModelsService } from './models.service';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';

function makeService(rows: any[] = []) {
  const prisma = {
    modelCatalog: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (args: any) => ({ id: 'new', ...args.data })),
      update: jest
        .fn()
        .mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const cache = new TtlCacheService();
  return {
    service: new ModelsService(prisma as unknown as PrismaService, cache),
    prisma,
    cache,
  };
}

const KEY = 'catalog:all';

describe('ModelsService 目录写路径失效网关快照', () => {
  it('create 后快照失效', async () => {
    const { service, cache } = makeService();
    cache.set(KEY, ['stale'], 60_000);

    await service.create({ name: 'm', provider: 'openai', displayName: 'M' } as any);

    expect(cache.get(KEY)).toBeUndefined();
  });

  it('update / remove 后快照失效', async () => {
    const { service, cache, prisma } = makeService();
    prisma.modelCatalog.findUnique.mockResolvedValue({ id: 'm1' });

    cache.set(KEY, ['stale'], 60_000);
    await service.update('m1', { inputPrice: 1 } as any);
    expect(cache.get(KEY)).toBeUndefined();

    cache.set(KEY, ['stale'], 60_000);
    await service.remove('m1');
    expect(cache.get(KEY)).toBeUndefined();
  });

  it('查询类操作（list）不改动快照', async () => {
    const { service, cache } = makeService([]);
    cache.set(KEY, ['stale'], 60_000);

    await service.list();

    expect(cache.get(KEY)).toEqual(['stale']);
  });
});

describe('ModelsService.classifyOrigins 分组批量打标', () => {
  const ROWS = [
    { id: '1', name: 'gpt-4o', vendor: 'x', origin: 'DOMESTIC' },
    { id: '2', name: 'gpt-4.1', vendor: 'x', origin: 'DOMESTIC' },
    { id: '3', name: 'claude-sonnet-5', vendor: 'x', origin: 'DOMESTIC' },
    { id: '4', name: 'deepseek-v4', vendor: 'deepseek', origin: 'DOMESTIC' },
    { id: '5', name: 'qwen-max', vendor: 'x', origin: 'DOMESTIC' },
  ];

  it('按 (vendor, origin) 分组，查询数与表规模无关', async () => {
    const { service, prisma } = makeService(ROWS);

    const res = await service.classifyOrigins();

    // 已是正确打标的 deepseek 行不参与；其余 4 行归并成 3 组
    expect(res.total).toBe(5);
    expect(res.updated).toBe(4);
    expect(prisma.modelCatalog.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.modelCatalog.update).not.toHaveBeenCalled();

    const sizes = prisma.modelCatalog.updateMany.mock.calls.map(
      (c: any[]) => c[0].where.id.in.length,
    );
    expect(sizes.sort()).toEqual([1, 1, 2]);
    expect(res.byOrigin).toEqual({ DOMESTIC: 2, OVERSEAS: 3 });
  });

  it('全部已是正确打标时不写库也不失效快照', async () => {
    const { service, prisma, cache } = makeService([
      { id: '4', name: 'deepseek-v4', vendor: 'deepseek', origin: 'DOMESTIC' },
    ]);
    cache.set(KEY, ['stale'], 60_000);

    const res = await service.classifyOrigins();

    expect(res.updated).toBe(0);
    expect(prisma.modelCatalog.updateMany).not.toHaveBeenCalled();
    expect(cache.get(KEY)).toEqual(['stale']);
  });
});

describe('ModelsService 计价币种（官方价 → USD 记账本位）', () => {
  it('CNY 录入按汇率折算 USD，officialPrices 保留原币价', async () => {
    const { service, prisma } = makeService();

    await service.create({
      name: 'kimi-k2.5',
      provider: 'moonshot',
      displayName: 'Kimi',
      priceCurrency: 'CNY',
      fxRate: 7,
      inputPrice: 4,
      outputPrice: 16,
      cacheReadPrice: 1,
      perCallPrice: 0.07,
    } as any);

    const data = prisma.modelCatalog.create.mock.calls[0][0].data;
    expect(data.priceCurrency).toBe('CNY');
    expect(data.fxRate).toBe(7);
    expect(data.inputPrice).toBeCloseTo(4 / 7, 6);
    expect(data.outputPrice).toBeCloseTo(16 / 7, 6);
    expect(data.cacheReadPrice).toBeCloseTo(1 / 7, 6);
    expect(data.perCallPrice).toBeCloseTo(0.07 / 7, 6);
    expect(data.officialPrices).toEqual({
      input: 4,
      output: 16,
      cacheRead: 1,
      cacheWrite: 0,
      perCall: 0.07,
    });
  });

  it('USD 录入直通写入，fxRate 为 null', async () => {
    const { service, prisma } = makeService();

    await service.create({
      name: 'gpt-4o',
      provider: 'openai',
      displayName: 'GPT-4o',
      inputPrice: 1.25,
      outputPrice: 10,
    } as any);

    const data = prisma.modelCatalog.create.mock.calls[0][0].data;
    expect(data.priceCurrency).toBe('USD');
    expect(data.fxRate).toBeNull();
    expect(data.inputPrice).toBe(1.25);
    expect(data.outputPrice).toBe(10);
  });

  it('CNY 缺汇率 → 400 MODEL_FX_RATE_REQUIRED', async () => {
    const { service } = makeService();

    await expect(
      service.create({
        name: 'kimi-k2.5',
        provider: 'moonshot',
        displayName: 'Kimi',
        priceCurrency: 'CNY',
        inputPrice: 4,
      } as any),
    ).rejects.toMatchObject({ response: { code: 'MODEL_FX_RATE_REQUIRED' } });
  });

  it('update 变更币种但未携带全套官方价 → 400 MODEL_PRICE_SET_REQUIRED', async () => {
    const { service, prisma } = makeService();
    prisma.modelCatalog.findUnique.mockResolvedValue({
      id: 'm1',
      priceCurrency: 'USD',
      fxRate: null,
      officialPrices: { input: 1, output: 2 },
    });

    await expect(
      service.update('m1', { priceCurrency: 'CNY', fxRate: 7 } as any),
    ).rejects.toMatchObject({ response: { code: 'MODEL_PRICE_SET_REQUIRED' } });
    expect(prisma.modelCatalog.update).not.toHaveBeenCalled();
  });

  it('update 部分价格：沿用原币价基准折算并合并 officialPrices', async () => {
    const { service, prisma } = makeService();
    prisma.modelCatalog.findUnique.mockResolvedValue({
      id: 'm1',
      priceCurrency: 'CNY',
      fxRate: 7,
      officialPrices: { input: 4, output: 16, cacheRead: 1, cacheWrite: 2, perCall: null },
    });

    await service.update('m1', { outputPrice: 21 } as any);

    const data = prisma.modelCatalog.update.mock.calls[0][0].data;
    expect(data.outputPrice).toBeCloseTo(3, 6); // 21 ÷ 7
    expect(data.inputPrice).toBeUndefined(); // 未触碰的列不写
    expect(data.officialPrices).toEqual({
      input: 4,
      output: 21,
      cacheRead: 1,
      cacheWrite: 2,
      perCall: null,
    });
  });

  it('update 变更币种带全套官方价：按新汇率重算 USD 记账价', async () => {
    const { service, prisma } = makeService();
    prisma.modelCatalog.findUnique.mockResolvedValue({
      id: 'm1',
      priceCurrency: 'USD',
      fxRate: null,
      officialPrices: {
        input: 0.571429,
        output: 2.285714,
        cacheRead: 0,
        cacheWrite: 0,
        perCall: null,
      },
    });

    await service.update('m1', {
      priceCurrency: 'CNY',
      fxRate: 7,
      inputPrice: 4,
      outputPrice: 16,
      cacheReadPrice: 0,
      cacheWritePrice: 0,
      perCallPrice: null,
    } as any);

    const data = prisma.modelCatalog.update.mock.calls[0][0].data;
    expect(data.priceCurrency).toBe('CNY');
    expect(data.fxRate).toBe(7);
    expect(data.inputPrice).toBeCloseTo(4 / 7, 6);
    expect(data.outputPrice).toBeCloseTo(16 / 7, 6);
    expect(data.officialPrices).toEqual({
      input: 4,
      output: 16,
      cacheRead: 0,
      cacheWrite: 0,
      perCall: null,
    });
  });
});
