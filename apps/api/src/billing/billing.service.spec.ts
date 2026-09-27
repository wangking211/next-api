import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceTxType } from '@prisma/client';

function makeService(balance: number) {
  const tx = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'user1', balance }),
      update: jest.fn(({ data }: any) => {
        const inc = data?.balance?.increment ?? 0;
        const dec = data?.balance?.decrement ?? 0;
        return Promise.resolve({ balance: balance + inc - dec });
      }),
    },
    balanceTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: (cb: any) => cb(tx),
  };
  const service = new BillingService(prisma as unknown as PrismaService);
  return { service, tx };
}

describe('BillingService', () => {
  it('recharges and records balanceAfter', async () => {
    const { service, tx } = makeService(5);
    await service.recharge('admin1', 'user1', 3, 'top up');
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { balance: { increment: 3 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: BalanceTxType.RECHARGE,
        amount: 3,
        balanceAfter: 8,
        operatorId: 'admin1',
        description: 'top up',
      }),
    });
  });

  it('recharge always takes absolute value', async () => {
    const { service, tx } = makeService(0);
    await service.recharge('admin1', 'user1', -3);
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 3, type: BalanceTxType.RECHARGE }),
    });
  });

  it('adjust supports negative amounts', async () => {
    const { service, tx } = makeService(10);
    await service.adjust('admin1', 'user1', -2.5, 'correction');
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { balance: { increment: -2.5 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: -2.5, balanceAfter: 7.5, type: BalanceTxType.ADJUST }),
    });
  });

  it('deducts consumption within a transaction', async () => {
    const { service, tx } = makeService(1);
    await service.recordConsumption(tx as any, 'user1', 0.000025, 'log1', 'call gpt');
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { balance: { decrement: 0.000025 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: BalanceTxType.CONSUME,
        amount: -0.000025,
        requestLogId: 'log1',
      }),
    });
  });

  it('ignores non-positive consumption', async () => {
    const { service, tx } = makeService(1);
    await service.recordConsumption(tx as any, 'user1', 0, 'log1');
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('throws when adjusting by zero', async () => {
    const { service } = makeService(1);
    await expect(service.adjust('a', 'u', 0)).rejects.toThrow(/non-zero/);
  });
});
