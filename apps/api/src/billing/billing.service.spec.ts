import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceTxType } from '@prisma/client';

function makeService(initial: number) {
  let balance = initial;
  const tx = {
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'user1', username: 'user1', balance, agentId: null }),
      ),
      update: jest.fn(({ data }: any) => {
        const inc = data?.balance?.increment ?? 0;
        const dec = data?.balance?.decrement ?? 0;
        balance = balance + inc - dec;
        return Promise.resolve({ balance });
      }),
      // 条件扣费模拟：
      //  - where.balance = { gte } → 余额足够才命中（原子足额扣减）
      //  - where.balance = 数值    → CAS：与当前余额一致才命中（封底扣减）
      updateMany: jest.fn(({ where, data }: any) => {
        const cond = where?.balance;
        let hit = true;
        if (cond && typeof cond === 'object' && 'gte' in cond) {
          hit = balance >= cond.gte;
        } else if (cond !== undefined) {
          hit = Number(cond) === balance;
        }
        if (!hit) return Promise.resolve({ count: 0 });
        const dec = data?.balance?.decrement ?? 0;
        balance = balance - dec;
        return Promise.resolve({ count: 1 });
      }),
    },
    balanceTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: (cb: any) => cb(tx),
  };
  const service = new BillingService(prisma as unknown as PrismaService);
  return {
    service,
    tx,
    getBalance: () => balance,
    setBalance: (v: number) => {
      balance = v;
    },
  };
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

  it('deducts consumption with an atomic conditional update', async () => {
    const { service, tx, getBalance } = makeService(1);
    const commission = await service.recordConsumption(
      tx as any,
      'user1',
      0.000025,
      'log1',
      'call gpt',
    );
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user1', balance: { gte: 0.000025 } },
      data: { balance: { decrement: 0.000025 } },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: BalanceTxType.CONSUME,
        amount: -0.000025,
        balanceAfter: 0.999975,
        requestLogId: 'log1',
        description: 'call gpt',
      }),
    });
    expect(getBalance()).toBeCloseTo(0.999975, 10);
    expect(commission).toBe(0);
  });

  it('floors consumption at zero instead of going negative', async () => {
    const { service, tx, getBalance } = makeService(0.004);
    await service.recordConsumption(tx as any, 'user1', 0.01, 'log1');
    expect(getBalance()).toBe(0);
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: BalanceTxType.CONSUME,
        amount: -0.004,
        balanceAfter: 0,
        requestLogId: 'log1',
      }),
    });
  });

  it('never writes a negative balance when the user is already drained', async () => {
    const { service, tx, getBalance } = makeService(0);
    await service.recordConsumption(tx as any, 'user1', 0.01, 'log1');
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
    expect(getBalance()).toBe(0);
  });

  it('retries the full deduction when the balance snapshot changes concurrently', async () => {
    const { service, tx, getBalance, setBalance } = makeService(0.004);
    const base = tx.user.updateMany.getMockImplementation()!;
    let casAttempts = 0;
    tx.user.updateMany.mockImplementation(async (args: any) => {
      const cond = args?.where?.balance;
      const isCas = cond !== undefined && !(typeof cond === 'object' && 'gte' in cond);
      if (isCas && casAttempts++ === 0) {
        setBalance(1); // 模拟快照读取后被并发修改（充值到 1）
        return { count: 0 };
      }
      return base(args);
    });
    await service.recordConsumption(tx as any, 'user1', 0.01, 'log1');
    expect(casAttempts).toBe(1);
    expect(getBalance()).toBeCloseTo(0.99, 10);
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: -0.01, balanceAfter: 0.99 }),
    });
  });

  it('ignores non-positive consumption', async () => {
    const { service, tx } = makeService(1);
    await service.recordConsumption(tx as any, 'user1', 0, 'log1');
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('throws when adjusting by zero', async () => {
    const { service } = makeService(1);
    await expect(service.adjust('a', 'u', 0)).rejects.toThrow(/non-zero/);
  });
});
