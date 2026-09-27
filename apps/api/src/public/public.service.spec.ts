import { PublicService } from './public.service';
import { PrismaService } from '../prisma/prisma.service';

function makeService(models: any[] = [], channelCount = 0) {
  const prisma = {
    modelCatalog: {
      findMany: jest.fn().mockImplementation((args: any) => {
        if (args?.distinct) {
          const seen = new Set<string>();
          const out: { provider: string }[] = [];
          for (const m of models) {
            if (!seen.has(m.provider)) {
              seen.add(m.provider);
              out.push({ provider: m.provider });
            }
          }
          return Promise.resolve(out);
        }
        return Promise.resolve(models.filter((m) => m.enabled !== false));
      }),
      count: jest.fn().mockResolvedValue(models.filter((m) => m.enabled !== false).length),
    },
    channel: {
      count: jest.fn().mockResolvedValue(channelCount),
    },
  };
  return { service: new PublicService(prisma as unknown as PrismaService), prisma };
}

const ROW = {
  name: 'gpt-5.6',
  displayName: 'GPT-5.6',
  provider: 'openai',
  inputPrice: '1.25',
  outputPrice: '10',
  cacheReadPrice: '0.125',
  cacheWritePrice: '1.875',
  enabled: true,
};

describe('PublicService', () => {
  it('返回启用模型并把价格从 Decimal 转成 number', async () => {
    const { service } = makeService([ROW]);
    const res = await service.models();
    expect(res.count).toBe(1);
    expect(res.providers).toEqual(['openai']);
    expect(res.items[0]).toEqual({
      name: 'gpt-5.6',
      displayName: 'GPT-5.6',
      provider: 'openai',
      inputPrice: 1.25,
      outputPrice: 10,
      cacheReadPrice: 0.125,
      cacheWritePrice: 1.875,
    });
  });

  it('providers 去重且排序稳定', async () => {
    const { service } = makeService([
      { ...ROW, provider: 'anthropic' },
      { ...ROW, name: 'claude-sonnet-5', provider: 'anthropic' },
      { ...ROW, name: 'gemini-3-pro', provider: 'google' },
    ]);
    const res = await service.models();
    expect(res.count).toBe(3);
    expect(res.providers).toEqual(['anthropic', 'google']);
  });

  it('stats 聚合模型数 / 提供商数 / 启用渠道数与协议列表', async () => {
    const { service, prisma } = makeService(
      [ROW, { ...ROW, name: 'claude', provider: 'anthropic' }, { ...ROW, name: 'x', enabled: false }],
      4,
    );
    const stats = await service.stats();
    expect(stats.modelCount).toBe(2);
    expect(stats.providerCount).toBe(2);
    expect(stats.channelCount).toBe(4);
    expect(stats.protocolCount).toBe(3);
    expect(stats.protocols).toEqual(['openai', 'anthropic', 'gemini']);
    expect(prisma.channel.count).toHaveBeenCalledWith({
      where: { status: 'ENABLED', ownerType: 'PLATFORM' },
    });
  });

  it('空目录时返回空集合而不报错', async () => {
    const { service } = makeService([]);
    const [models, stats] = await Promise.all([service.models(), service.stats()]);
    expect(models).toEqual({ items: [], providers: [], count: 0 });
    expect(stats.modelCount).toBe(0);
    expect(stats.providerCount).toBe(0);
  });
});
