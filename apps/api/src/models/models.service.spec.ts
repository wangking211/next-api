import { ModelsService } from './models.service';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCacheService } from '../common/ttl-cache.service';

function makeService(rows: any[] = []) {
  const prisma = {
    modelCatalog: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (args: any) => ({ id: 'new', ...args.data })),
      update: jest.fn().mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data })),
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
