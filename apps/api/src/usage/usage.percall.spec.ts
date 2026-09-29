import { ConfigService } from '@nestjs/config';
import { UsageService } from './usage.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

describe('UsageService.record 按次计费', () => {
  function makeService() {
    const created: any[] = [];
    const tx = {
      requestLog: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return { id: 'log1' };
        }),
        update: jest.fn(),
      },
      apiKey: { update: jest.fn() },
    };
    const prisma = { $transaction: (cb: any) => cb(tx) };
    const billing = {
      recordConsumption: jest.fn().mockResolvedValue(0),
      getChannelPricing: jest.fn(),
      getUserMultiplier: jest.fn().mockResolvedValue(1),
    };
    const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
    const service = new UsageService(
      prisma as unknown as PrismaService,
      billing as unknown as BillingService,
      config,
    );
    return { service, created, billing };
  }

  it('costOverride 直接落账并跳过 token 计价', async () => {
    const { service, created, billing } = makeService();
    await service.record({
      userId: 'u1',
      apiKeyId: null,
      channelId: 'c1',
      model: 'gpt-image-2.5-flare',
      provider: 'custom',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      latencyMs: 12,
      status: 200,
      chargeable: true,
      isStream: false,
      multiplier: 1.5,
      multiplierSource: 'group',
      costOverride: 0.3,
      upstreamCostOverride: 0.144,
    });

    expect(billing.getChannelPricing).not.toHaveBeenCalled();
    expect(billing.getUserMultiplier).not.toHaveBeenCalled();
    const row = created[0];
    expect(row.cost).toBe(0.3);
    expect(row.upstreamCost).toBe(0.144);
    expect(row.multiplierApplied).toBe(1.5);
    expect(row.multiplierSource).toBe('group');
  });

  it('未给定 costOverride 时仍走 token 计价（兼容旧路径）', async () => {
    const { service, created, billing } = makeService();
    billing.getChannelPricing.mockResolvedValue({
      priceInput: 5,
      priceOutput: 30,
      costInput: 5,
      costOutput: 30,
      cacheReadPrice: 0,
      cacheWritePrice: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      pricePerCall: 0,
      costPerCall: 0,
      explicit: false,
    });
    await service.record({
      userId: 'u1',
      apiKeyId: null,
      channelId: 'c1',
      model: 'gpt-5.5',
      provider: 'openai',
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      latencyMs: 10,
      status: 200,
      chargeable: true,
      isStream: false,
      multiplier: 1,
    });
    expect(billing.getChannelPricing).toHaveBeenCalled();
    expect(created[0].cost).toBe(5);
  });
});
