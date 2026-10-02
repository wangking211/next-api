import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BalanceTxType, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

@Injectable()
export class WithdrawalService {
  constructor(private readonly prisma: PrismaService) {}

  /** 用户发起提现：冻结（扣减）余额并生成待审批申请 */
  async create(userId: string, amountUsd: number, note?: string) {
    const amount = round6(amountUsd);
    if (amount <= 0)
      throw new BadRequestException({
        code: 'WITHDRAW_AMOUNT_POSITIVE',
        message: 'Amount must be positive',
      });
    return this.prisma.$transaction(async (tx) => {
      // 原子冻结：条件更新保证并发下不会超额提现（余额足够才会 count=1）
      const frozen = await tx.user.updateMany({
        where: { id: userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (frozen.count !== 1) {
        const exists = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true },
        });
        if (!exists)
          throw new NotFoundException({
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          });
        throw new BadRequestException({
          code: 'BALANCE_INSUFFICIENT',
          message: '余额不足',
        });
      }
      const upd = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      const w = await tx.withdrawalRequest.create({
        data: { userId, amount, note: note ?? null },
      });
      await tx.balanceTransaction.create({
        data: {
          userId,
          type: BalanceTxType.WITHDRAW,
          amount: -amount,
          balanceAfter: round6(Number(upd?.balance ?? 0)),
          description: '提现申请',
        },
      });
      return w;
    });
  }

  listMine(userId: string) {
    return this.prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  listAll(status?: WithdrawalStatus) {
    return this.prisma.withdrawalRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, username: true, email: true } } },
    });
  }

  /** 管理员审批：通过=打款完成；驳回=退回余额 */
  async review(operatorId: string, id: string, action: 'APPROVE' | 'REJECT') {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!w)
        throw new NotFoundException({
          code: 'WITHDRAW_NOT_FOUND',
          message: 'Withdrawal not found',
        });

      const status = action === 'APPROVE' ? WithdrawalStatus.APPROVED : WithdrawalStatus.REJECTED;
      // 原子领取：只有把 PENDING 改成终态的那一次调用才执行资金动作，
      // 并发（双击 / 两个管理员）下不会重复退款或重复审批。
      const claimed = await tx.withdrawalRequest.updateMany({
        where: { id, status: WithdrawalStatus.PENDING },
        data: { status, reviewedById: operatorId, reviewedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException({
          code: 'WITHDRAW_ALREADY_PROCESSED',
          message: '该提现已处理',
        });
      }

      if (action === 'REJECT') {
        const amount = Number(w.amount);
        const upd = await tx.user.update({
          where: { id: w.userId },
          data: { balance: { increment: amount } },
          select: { balance: true },
        });
        await tx.balanceTransaction.create({
          data: {
            userId: w.userId,
            type: BalanceTxType.ADJUST,
            amount,
            balanceAfter: round6(Number(upd.balance)),
            description: '提现驳回退回',
            operatorId,
          },
        });
      }
      return tx.withdrawalRequest.findUnique({ where: { id } });
    });
  }
}
