import { BalanceTxType, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WithdrawalService } from './withdrawal.service';

/**
 * 资金安全回归：提现与审批必须走条件更新（原子领取），
 * 否则并发下会出现「超额提现」与「重复退款」。
 */
function makeService(
  opts: {
    freezeCount?: number;
    user?: any;
    claimCount?: number;
    withdrawal?: any;
  } = {},
) {
  const withdrawal = {
    id: 'w1',
    userId: 'u1',
    amount: 2,
    status: WithdrawalStatus.PENDING,
    ...(opts.withdrawal ?? {}),
  };
  const tx = {
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.freezeCount ?? 1 }),
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.user === undefined ? { id: 'u1', balance: 8 } : opts.user),
      update: jest.fn().mockResolvedValue({ balance: 10 }),
    },
    withdrawalRequest: {
      create: jest.fn().mockResolvedValue(withdrawal),
      findUnique: jest.fn().mockResolvedValue(opts.withdrawal === null ? null : withdrawal),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
    },
    balanceTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: (cb: any) => cb(tx) };
  const service = new WithdrawalService(prisma as unknown as PrismaService);
  return { service, tx };
}

describe('WithdrawalService.create', () => {
  it('原子冻结余额（带余额下限条件）并记录流水', async () => {
    const { service, tx } = makeService();

    await service.create('u1', 2, 'test');

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', balance: { gte: 2 } },
      data: { balance: { decrement: 2 } },
    });
    expect(tx.withdrawalRequest.create).toHaveBeenCalledWith({
      data: { userId: 'u1', amount: 2, note: 'test' },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        type: BalanceTxType.WITHDRAW,
        amount: -2,
        balanceAfter: 8,
      }),
    });
  });

  it('余额不足时不创建申请（并发下也只有一次冻结成功）', async () => {
    const { service, tx } = makeService({ freezeCount: 0 });

    await expect(service.create('u1', 2)).rejects.toThrow(/余额不足/);
    expect(tx.withdrawalRequest.create).not.toHaveBeenCalled();
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('用户不存在时报未找到', async () => {
    const { service } = makeService({ freezeCount: 0, user: null });

    await expect(service.create('ghost', 2)).rejects.toThrow(/User not found/);
  });

  it('拒绝非正数金额', async () => {
    const { service, tx } = makeService();
    await expect(service.create('u1', 0)).rejects.toThrow(/positive/);
    await expect(service.create('u1', -5)).rejects.toThrow(/positive/);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });
});

describe('WithdrawalService.review', () => {
  it('通过：原子领取后置为 APPROVED，不动余额', async () => {
    const { service, tx } = makeService();

    await service.review('admin1', 'w1', 'APPROVE');

    expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', status: WithdrawalStatus.PENDING },
      data: expect.objectContaining({
        status: WithdrawalStatus.APPROVED,
        reviewedById: 'admin1',
      }),
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('驳回：原子领取后退回余额并记调整流水', async () => {
    const { service, tx } = makeService();

    await service.review('admin1', 'w1', 'REJECT');

    expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', status: WithdrawalStatus.PENDING },
      data: expect.objectContaining({ status: WithdrawalStatus.REJECTED }),
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { balance: { increment: 2 } },
      select: { balance: true },
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: BalanceTxType.ADJUST,
        amount: 2,
        balanceAfter: 10,
        description: '提现驳回退回',
      }),
    });
  });

  it('重复审批（并发双击）不再退款 —— 二次驳回被拒绝且无资金动作', async () => {
    const { service, tx } = makeService({ claimCount: 0 });

    await expect(service.review('admin1', 'w1', 'REJECT')).rejects.toThrow(/已处理/);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('重复审批（并发双击）不再改状态 —— 二次通过被拒绝', async () => {
    const { service, tx } = makeService({ claimCount: 0 });

    await expect(service.review('admin1', 'w1', 'APPROVE')).rejects.toThrow(/已处理/);
    expect(tx.withdrawalRequest.findUnique).toHaveBeenCalled();
  });

  it('申请不存在时报未找到', async () => {
    const { service } = makeService({ withdrawal: null });
    await expect(service.review('admin1', 'nope', 'APPROVE')).rejects.toThrow(
      /Withdrawal not found/,
    );
  });
});
