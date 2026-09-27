import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      if (!u) throw new NotFoundException('User not found');
      if (Number(u.balance) < amount) {
        throw new BadRequestException('余额不足');
      }
      const upd = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: amount } },
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
          balanceAfter: round6(Number(upd.balance)),
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
  async review(
    operatorId: string,
    id: string,
    action: 'APPROVE' | 'REJECT',
  ) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawalRequest.findUnique({ where: { id } });
      if (!w) throw new NotFoundException('Withdrawal not found');
      if (w.status !== WithdrawalStatus.PENDING) {
        throw new BadRequestException('该提现已处理');
      }
      if (action === 'APPROVE') {
        return tx.withdrawalRequest.update({
          where: { id },
          data: {
            status: WithdrawalStatus.APPROVED,
            reviewedById: operatorId,
            reviewedAt: new Date(),
          },
        });
      }
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
      return tx.withdrawalRequest.update({
        where: { id },
        data: {
          status: WithdrawalStatus.REJECTED,
          reviewedById: operatorId,
          reviewedAt: new Date(),
        },
      });
    });
  }
}
