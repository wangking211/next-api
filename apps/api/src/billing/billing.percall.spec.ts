import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

describe('BillingService 按次计价（图片等）', () => {
  function svc(channelModel: unknown, catalog: unknown) {
    const prisma = {
      channelModel: { findUnique: jest.fn().mockResolvedValue(channelModel) },
      modelCatalog: { findUnique: jest.fn().mockResolvedValue(catalog) },
    };
    return new BillingService(prisma as unknown as PrismaService);
  }

  const tokenCatalog = {
    inputPrice: 5,
    outputPrice: 30,
    cacheReadPrice: 0.5,
    cacheWritePrice: 5,
    perCallPrice: null,
  };

  it('渠道显式按次价/成本优先', async () => {
    const p = await svc(
      { pricePerCall: 0.2, costPerCall: 0.144 },
      { ...tokenCatalog, perCallPrice: 0.3 },
    ).getChannelPricing('c1', 'nano-banana-2-on-demand');
    expect(p.pricePerCall).toBe(0.2);
    expect(p.costPerCall).toBe(0.144);
    expect(p.explicit).toBe(true);
  });

  it('无渠道覆盖时回退目录 perCallPrice（售价=成本=目录价）', async () => {
    const p = await svc(null, { ...tokenCatalog, perCallPrice: 0.144 }).getChannelPricing(
      'c1',
      'nano-banana-2-on-demand',
    );
    expect(p.pricePerCall).toBe(0.144);
    expect(p.costPerCall).toBe(0.144);
  });

  it('纯 token 模型按次价为 0（走 token 计价，不受影响）', async () => {
    const p = await svc(null, tokenCatalog).getChannelPricing(null, 'gpt-image-2');
    expect(p.pricePerCall).toBe(0);
    expect(p.costPerCall).toBe(0);
    expect(p.priceInput).toBe(5);
    expect(p.priceOutput).toBe(30);
  });

  it('isFree：按次模型以按次价为准', async () => {
    const paid = await svc(null, { ...tokenCatalog, perCallPrice: 0.144 }).isFree(
      'c1',
      'img-model',
    );
    expect(paid).toBe(false);
    const free = await svc(
      { priceInput: 0, priceOutput: 0, pricePerCall: 0 },
      { ...tokenCatalog, perCallPrice: null },
    ).isFree('c1', 'free-model');
    expect(free).toBe(true);
  });

  it('渠道按次折扣：显式按次价存在时不再叠加倍率', async () => {
    const p = await svc(
      { pricePerCall: 0.5, costPerCall: 0.25, costDiscount: 0.5, priceDiscount: 0.5 },
      { ...tokenCatalog, perCallPrice: 0.9 },
    ).getChannelPricing('c1', 'img-model');
    expect(p.pricePerCall).toBe(0.5);
    expect(p.costPerCall).toBe(0.25);
  });
});
