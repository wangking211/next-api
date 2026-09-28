import { UsageService, UsageEntry } from './usage.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { ConfigService } from '@nestjs/config';

/**
 * 计费口径：
 * - chargeable=true（平台渠道）→ 扣余额、累计 Key 费用额度与 UsageDaily.billedCost
 * - chargeable=false（用户自有 BYOK）→ 一律不扣，只写明细与折算金额
 */
function makeService() {
  const tx = {
    requestLog: { create: jest.fn().mockResolvedValue({ id: 'log1' }) },
    apiKey: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: (cb: any) => cb(tx),
    usageDaily: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
  };
  const billing = {
    getChannelPricing: jest.fn().mockResolvedValue({
      priceInput: 1,
      priceOutput: 2,
      cacheReadPrice: 0,
      cacheWritePrice: 0,
      costInput: 0.4,
      costOutput: 0.8,
      cacheReadCost: 0,
      cacheWriteCost: 0,
    }),
    getUserMultiplier: jest.fn().mockResolvedValue(1),
    recordConsumption: jest.fn().mockResolvedValue(0),
  };
  const config = { get: (_k: string, d?: unknown) => d };
  const service = new UsageService(
    prisma as unknown as PrismaService,
    billing as unknown as BillingService,
    config as unknown as ConfigService,
  );
  return { service, tx, prisma, billing };
}

const baseEntry: UsageEntry = {
  userId: 'user1',
  apiKeyId: 'k1',
  channelId: 'ch1',
  model: 'gpt-4o',
  provider: 'openai',
  promptTokens: 1_000_000,
  completionTokens: 0,
  totalTokens: 1_000_000,
  latencyMs: 12,
  status: 200,
  isStream: false,
  requestPreview: '',
  responsePreview: '',
};

describe('UsageService 计费口径', () => {
  it('BYOK 调用不扣余额、不消耗费用额度，但照常写明细与折算金额', async () => {
    const { service, tx, prisma, billing } = makeService();

    await service.record({ ...baseEntry, chargeable: false });

    expect(billing.recordConsumption).not.toHaveBeenCalled();
    expect(tx.requestLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ chargeable: false, cost: 1 }),
    });
    // 费用额度不被免费调用消耗
    expect(tx.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: expect.objectContaining({ quotaUsed: { increment: 1_000_000 }, costUsed: { increment: 0 } }),
    });
    // 日聚合：折算总额照记，实扣为 0
    expect(prisma.usageDaily.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ cost: 1, billedCost: 0 }),
    });
  });

  it('平台渠道调用扣余额并累计 billedCost 与费用额度', async () => {
    const { service, tx, prisma, billing } = makeService();

    await service.record({ ...baseEntry, chargeable: true });

    expect(billing.recordConsumption).toHaveBeenCalledWith(
      expect.anything(),
      'user1',
      1,
      'log1',
      '调用 gpt-4o',
    );
    expect(tx.requestLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ chargeable: true, cost: 1 }),
    });
    expect(tx.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: expect.objectContaining({ costUsed: { increment: 1 } }),
    });
    expect(prisma.usageDaily.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ cost: 1, billedCost: 1 }),
    });
  });

  it('chargeable 未显式传入时不扣费（与余额扣款保持同口径）', async () => {
    const { service, billing } = makeService();

    await service.record({ ...baseEntry });

    expect(billing.recordConsumption).not.toHaveBeenCalled();
  });
});
