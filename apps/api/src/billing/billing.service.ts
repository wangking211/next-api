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

  /** 读取模型单价（USD/1M tokens）；目录缺失返回 null。 */
  async getModelPrices(
    model: string,
  ): Promise<{ input: number; output: number } | null> {
    const row = await this.prisma.modelCatalog.findUnique({
      where: { name: model },
      select: { inputPrice: true, outputPrice: true },
    });
    if (!row) return null;
    return { input: Number(row.inputPrice), output: Number(row.outputPrice) };
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
    if (delta === 0) throw new BadRequestException('Amount must be non-zero');

    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('User not found');

      // 原子自增，避免读-改-写丢更新
      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: delta } },
        select: { balance: true },
      });
      const balanceAfter = round6(Number(updated.balance));
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
    const exists = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) return;
    // 原子自减，避免并发下读-改-写丢更新
    const updated = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: cost } },
      select: { balance: true },
    });
    const balanceAfter = round6(Number(updated.balance));
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

      const amount = Number(rc.amount);
      const updated = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      const balanceAfter = round6(Number(updated.balance));
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
