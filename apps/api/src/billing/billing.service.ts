import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BalanceTxType, Prisma, RedeemCodeStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { generateRedeemCode, normalizeCode } from './redeem.util';

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface ChannelPricing {
  /** 对用户售价 USD/1M tokens */
  priceInput: number;
  priceOutput: number;
  /** 上游成本 USD/1M tokens */
  costInput: number;
  costOutput: number;
  /** 是否来自渠道×模型显式定价（否则为目录默认价） */
  explicit: boolean;
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

  /**
   * 计算某模型在指定渠道的售价与成本（USD/1M tokens）。
   * 成本 = 官方价 × costDiscount；售价 = 官方价 × priceDiscount；绝对字段存在时优先。
   */
  async getChannelPricing(
    channelId: string | null,
    model: string,
  ): Promise<ChannelPricing> {
    const [cm, catalog] = await Promise.all([
      channelId
        ? this.prisma.channelModel.findUnique({
            where: {
              channelId_modelName: { channelId, modelName: model },
            },
            select: {
              priceInput: true,
              priceOutput: true,
              costInput: true,
              costOutput: true,
              discount: true,
              costDiscount: true,
              priceDiscount: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.modelCatalog.findUnique({
        where: { name: model },
        select: { inputPrice: true, outputPrice: true },
      }),
    ]);

    const officialIn = catalog ? Number(catalog.inputPrice) : 0;
    const officialOut = catalog ? Number(catalog.outputPrice) : 0;
    // 兼容旧 discount：仅作为下游售价折扣
    const priceDisc =
      cm?.priceDiscount != null
        ? Number(cm.priceDiscount)
        : cm?.discount != null
          ? Number(cm.discount)
          : 1;
    const costDisc = cm?.costDiscount != null ? Number(cm.costDiscount) : 1;

    const priceInput =
      cm?.priceInput != null ? Number(cm.priceInput) : officialIn * priceDisc;
    const priceOutput =
      cm?.priceOutput != null ? Number(cm.priceOutput) : officialOut * priceDisc;
    const costInput =
      cm?.costInput != null ? Number(cm.costInput) : officialIn * costDisc;
    const costOutput =
      cm?.costOutput != null ? Number(cm.costOutput) : officialOut * costDisc;

    return {
      priceInput,
      priceOutput,
      costInput,
      costOutput,
      explicit:
        cm?.priceInput != null ||
        cm?.priceOutput != null ||
        cm?.costInput != null ||
        cm?.costOutput != null ||
        cm?.costDiscount != null ||
        cm?.priceDiscount != null ||
        cm?.discount != null,
    };
  }

  /** 该模型在渠道下是否为 0 价（免费，无需余额） */
  async isFree(channelId: string | null, model: string): Promise<boolean> {
    const p = await this.getChannelPricing(channelId, model);
    return p.priceInput === 0 && p.priceOutput === 0;
  }

  /** 用户的有效售价倍率 = 用户倍率 > 所属代理倍率 > 1（作用在渠道价之上） */
  async getUserMultiplier(userId: string): Promise<number> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        priceMultiplier: true,
        agent: { select: { priceMultiplier: true } },
      },
    });
    if (!u) return 1;
    const m =
      u.priceMultiplier != null
        ? Number(u.priceMultiplier)
        : u.agent?.priceMultiplier != null
          ? Number(u.agent.priceMultiplier)
          : 1;
    return m > 0 ? m : 1;
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

  /** 在既有事务内扣除调用消费，并给各级代理发放返点；返回返点合计。 */
  async recordConsumption(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
    requestLogId: string,
    description?: string,
  ): Promise<number> {
    const cost = round6(amount);
    if (cost <= 0) return 0;
    const exists = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });
    if (!exists) return 0;
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
    return this.payCommissions(tx, userId, exists.username, cost, requestLogId);
  }

  /** 沿 agent 链向上给各级代理按 rebateRate 发放返点，返回合计（USD）。 */
  private async payCommissions(
    tx: Prisma.TransactionClient,
    userId: string,
    sourceName: string,
    cost: number,
    requestLogId: string,
  ): Promise<number> {
    let total = 0;
    let currentId = userId;
    const seen = new Set<string>([userId]);
    for (let depth = 0; depth < 5; depth++) {
      const u = await tx.user.findUnique({
        where: { id: currentId },
        select: { agentId: true },
      });
      const agentId = u?.agentId;
      if (!agentId || seen.has(agentId)) break;
      seen.add(agentId);
      const agent = await tx.user.findUnique({
        where: { id: agentId },
        select: { id: true, rebateRate: true },
      });
      if (!agent) break;
      const rate = agent.rebateRate != null ? Number(agent.rebateRate) : 0;
      if (rate > 0) {
        const commission = round6(cost * rate);
        if (commission > 0) {
          const upd = await tx.user.update({
            where: { id: agent.id },
            data: { balance: { increment: commission } },
            select: { balance: true },
          });
          await tx.balanceTransaction.create({
            data: {
              userId: agent.id,
              type: BalanceTxType.COMMISSION,
              amount: commission,
              balanceAfter: round6(Number(upd.balance)),
              requestLogId,
              description: `返点（来自 ${sourceName}）`,
            },
          });
          total = round6(total + commission);
        }
      }
      currentId = agentId;
    }
    return total;
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
