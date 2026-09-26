import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BalanceTxType, Prisma, RedeemCodeStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { generateRedeemCode, normalizeCode } from './redeem.util';

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return { balance: Number(user.balance) };
  }

  async listTransactions(
    userId: string,
    page = 1,
    pageSize = 20,
    type?: BalanceTxType,
  ) {
    const where: Prisma.BalanceTransactionWhereInput = {
      userId,
      ...(type ? { type } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.balanceTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.balanceTransaction.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  private async applyChange(
    operatorId: string | null,
    userId: string,
    amount: number,
    type: BalanceTxType,
    description?: string,
  ) {
    const delta = round6(amount);
    if (delta === 0) throw new NotFoundException('Amount must be non-zero');

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      if (!user) throw new NotFoundException('User not found');

      const balanceAfter = round6(Number(user.balance) + delta);
      await tx.user.update({
        where: { id: userId },
        data: { balance: balanceAfter },
      });
      return tx.balanceTransaction.create({
        data: {
          userId,
          type,
          amount: delta,
          balanceAfter,
          description: description ?? null,
          operatorId,
        },
      });
    });
  }

  recharge(operatorId: string, userId: string, amount: number, description?: string) {
    return this.applyChange(operatorId, userId, Math.abs(amount), BalanceTxType.RECHARGE, description);
  }

  adjust(operatorId: string, userId: string, amount: number, description?: string) {
    return this.applyChange(operatorId, userId, amount, BalanceTxType.ADJUST, description);
  }

  /** 在既有事务内扣除调用消费，保持与用量记录原子。 */
  async recordConsumption(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    requestLogId: string,
    description?: string,
  ): Promise<void> {
    const cost = round6(amount);
    if (cost <= 0) return;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });
    if (!user) return;
    const balanceAfter = round6(Number(user.balance) - cost);
    await tx.user.update({
      where: { id: userId },
      data: { balance: balanceAfter },
    });
    await tx.balanceTransaction.create({
      data: {
        userId,
        type: BalanceTxType.CONSUME,
        amount: -cost,
        balanceAfter,
        requestLogId,
        description: description ?? null,
      },
    });
  }

  // ---------------- 兑换码 ----------------

  async generateCodes(
    operatorId: string,
    opts: { amount: number; quantity: number; note?: string; expiresAt?: string },
  ) {
    const batchId = randomUUID();
    const codes: string[] = [];
    for (let i = 0; i < opts.quantity; i++) {
      codes.push(generateRedeemCode());
    }
    await this.prisma.redeemCode.createMany({
      data: codes.map((code) => ({
        code,
        amount: opts.amount,
        batchId,
        note: opts.note ?? null,
        createdById: operatorId,
        expiresAt: opts.expiresAt ? new Date(opts.expiresAt) : null,
      })),
    });
    return { batchId, count: codes.length, amount: opts.amount, codes };
  }

  async listCodes(page = 1, pageSize = 20, status?: RedeemCodeStatus, batchId?: string) {
    const where: Prisma.RedeemCodeWhereInput = {
      ...(status ? { status } : {}),
      ...(batchId ? { batchId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.redeemCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.redeemCode.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async disableCode(id: string) {
    const code = await this.prisma.redeemCode.findUnique({ where: { id } });
    if (!code) throw new NotFoundException('兑换码不存在');
    if (code.status === RedeemCodeStatus.USED) {
      throw new BadRequestException('兑换码已被使用，无法作废');
    }
    return this.prisma.redeemCode.update({
      where: { id },
      data: { status: RedeemCodeStatus.DISABLED },
    });
  }

  /** 用户兑换：加余额 + 标记已用，原子操作并防并发重复兑换。 */
  async redeem(userId: string, rawCode: string) {
    const code = normalizeCode(rawCode);
    if (!code) throw new BadRequestException('请输入兑换码');

    return this.prisma.$transaction(async (tx) => {
      const rc = await tx.redeemCode.findUnique({ where: { code } });
      if (!rc) throw new BadRequestException('兑换码无效');
      if (rc.status === RedeemCodeStatus.USED) {
        throw new BadRequestException('兑换码已被使用');
      }
      if (rc.status === RedeemCodeStatus.DISABLED) {
        throw new BadRequestException('兑换码已作废');
      }
      if (rc.expiresAt && rc.expiresAt.getTime() < Date.now()) {
        throw new BadRequestException('兑换码已过期');
      }

      const claimed = await tx.redeemCode.updateMany({
        where: { id: rc.id, status: RedeemCodeStatus.UNUSED },
        data: {
          status: RedeemCodeStatus.USED,
          usedById: userId,
          usedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('兑换码已被使用');
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      const amount = Number(rc.amount);
      const balanceAfter = round6(Number(user?.balance ?? 0) + amount);
      await tx.user.update({
        where: { id: userId },
        data: { balance: balanceAfter },
      });
      await tx.balanceTransaction.create({
        data: {
          userId,
          type: BalanceTxType.RECHARGE,
          amount,
          balanceAfter,
          description: `兑换码 ${code.slice(0, 4)}****`,
        },
      });
      return { balance: balanceAfter, amount };
    });
  }
}
