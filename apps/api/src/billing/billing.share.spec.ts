import { BalanceTxType, Prisma } from '@prisma/client';
import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';

interface ShareArgs {
  ownerUserId: string;
  cost: number;
  feeBps: number;
  requestLogId: string;
  label: string;
}

function makeTx() {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'owner1' }),
      update: jest.fn().mockResolvedValue({ balance: '12.34567891' }),
    },
    balanceTransaction: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeService() {
  return new BillingService({} as unknown as PrismaService);
}

function pay(
  service: BillingService,
  tx: ReturnType<typeof makeTx>,
  overrides: Partial<ShareArgs> = {},
): Promise<number> {
  return service.payChannelRevenue(tx as unknown as Prisma.TransactionClient, {
    ownerUserId: 'owner1',
    cost: 1,
    feeBps: 2000,
    requestLogId: 'log1',
    label: 'gpt-4o',
    ...overrides,
  });
}

function expectNoDbCalls(tx: ReturnType<typeof makeTx>) {
  expect(tx.user.findUnique).not.toHaveBeenCalled();
  expect(tx.user.update).not.toHaveBeenCalled();
  expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
}

describe('BillingService.payChannelRevenue（渠道共享分成入账）', () => {
  it('round6 后 cost <= 0 直接返回 0，不做任何数据库读写', async () => {
    for (const cost of [0, -0.5, 1e-9]) {
      const tx = makeTx();
      const service = makeService();
      await expect(
        pay(service, tx, { cost }),
      ).resolves.toBe(0);
      expectNoDbCalls(tx);
    }
  });

  it('feeBps 为负数时截断为 0：收入 = 成本（全额入账）', async () => {
    const tx = makeTx();
    const service = makeService();
    await expect(pay(service, tx, { cost: 1, feeBps: -500 })).resolves.toBe(1);
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner1' },
      select: { id: true },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'owner1' },
      data: { balance: { increment: 1 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 1 }),
    });
  });

  it('feeBps = 15000 截断为 10000：收入为 0，直接返回 0 且无任何读写', async () => {
    const tx = makeTx();
    const service = makeService();
    await expect(pay(service, tx, { cost: 1, feeBps: 15000 })).resolves.toBe(0);
    expectNoDbCalls(tx);
  });

  it('非整数 feeBps 向下取整（2000.9 → 2000）', async () => {
    const tx = makeTx();
    const service = makeService();
    // 1 × (1 − 2000/10000) = 0.8
    await expect(pay(service, tx, { cost: 1, feeBps: 2000.9 })).resolves.toBe(0.8);
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: 0.8 } },
      }),
    );
  });

  it('收入按 round6 取整到 6 位小数（cost 先取整，再分成后取整）', async () => {
    const tx = makeTx();
    const service = makeService();
    // cost 先 round6：0.3333333 → 0.333333（333333.3 进位到 333333）
    // 再分成：0.333333 × 0.8 = 0.2666664 → round6 → 0.266666
    await expect(
      pay(service, tx, { cost: 0.3333333, feeBps: 2000 }),
    ).resolves.toBe(0.266666);
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: 0.266666 } },
      }),
    );
  });

  it('收入取整后 <= 0 → 返回 0，不做任何数据库读写', async () => {
    const tx = makeTx();
    const service = makeService();
    // 0.000001 × (1 − 9999/10000) = 1e-10 → round6 → 0
    await expect(
      pay(service, tx, { cost: 0.000001, feeBps: 9999 }),
    ).resolves.toBe(0);
    expectNoDbCalls(tx);
  });

  it('渠道主不存在时返回 0，不更新余额也不记账', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue(null);
    const service = makeService();
    await expect(pay(service, tx, { cost: 1, feeBps: 2000 })).resolves.toBe(0);
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('happy path：加余额并写 CHANNEL_REVENUE 流水，返回入账金额', async () => {
    const tx = makeTx();
    const service = makeService();
    // 1 × (1 − 2000/10000) = 0.8
    await expect(pay(service, tx, { cost: 1, feeBps: 2000 })).resolves.toBe(0.8);
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner1' },
      select: { id: true },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'owner1' },
      data: { balance: { increment: 0.8 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner1',
        type: BalanceTxType.CHANNEL_REVENUE,
        amount: 0.8,
        // round6(Number('12.34567891')) = 12.345679
        balanceAfter: 12.345679,
        requestLogId: 'log1',
        description: '渠道共享收益 · gpt-4o',
      }),
    });
  });
});
