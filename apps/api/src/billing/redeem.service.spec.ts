import { BillingService } from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedeemCodeStatus } from '@prisma/client';

function makeService(code: any, balance = 0, claimCount = 1) {
  const tx = {
    redeemCode: {
      findUnique: jest.fn().mockResolvedValue(code),
      updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ balance }),
      update: jest.fn().mockResolvedValue({}),
    },
    balanceTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: (cb: any) => cb(tx) };
  return { service: new BillingService(prisma as unknown as PrismaService), tx };
}

describe('BillingService.redeem', () => {
  it('credits balance and marks code used', async () => {
    const { service, tx } = makeService({
      id: 'rc1',
      code: 'AAAA-BBBB-CCCC-DDDD',
      amount: 10,
      status: RedeemCodeStatus.UNUSED,
      expiresAt: null,
    }, 5);
    const res = await service.redeem('user1', 'aaaa-bbbb-cccc-dddd');
    expect(res).toEqual({ balance: 15, amount: 10 });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { balance: 15 },
    });
    expect(tx.redeemCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'rc1', status: RedeemCodeStatus.UNUSED },
      data: expect.objectContaining({ status: RedeemCodeStatus.USED, usedById: 'user1' }),
    });
    expect(tx.balanceTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'RECHARGE', amount: 10, balanceAfter: 15 }),
    });
  });

  it('rejects unknown code', async () => {
    const { service } = makeService(null);
    await expect(service.redeem('user1', 'NOPE-NOPE-NOPE-NOPE')).rejects.toThrow(/无效/);
  });

  it('rejects already used code', async () => {
    const { service } = makeService({
      id: 'rc1',
      amount: 10,
      status: RedeemCodeStatus.USED,
    });
    await expect(service.redeem('user1', 'AAAA')).rejects.toThrow(/已被使用/);
  });

  it('rejects disabled code', async () => {
    const { service } = makeService({ id: 'rc1', amount: 10, status: RedeemCodeStatus.DISABLED });
    await expect(service.redeem('user1', 'AAAA')).rejects.toThrow(/已作废/);
  });

  it('rejects expired code', async () => {
    const { service } = makeService({
      id: 'rc1',
      amount: 10,
      status: RedeemCodeStatus.UNUSED,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.redeem('user1', 'AAAA')).rejects.toThrow(/已过期/);
  });

  it('guards against concurrent claims', async () => {
    const { service } = makeService(
      { id: 'rc1', amount: 10, status: RedeemCodeStatus.UNUSED, expiresAt: null },
      0,
      0,
    );
    await expect(service.redeem('user1', 'AAAA')).rejects.toThrow(/已被使用/);
  });
});
