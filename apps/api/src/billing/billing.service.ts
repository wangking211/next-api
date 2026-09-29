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
  /** 缓存读/写 售价与成本（USD/1M tokens） */
  cacheReadPrice: number;
  cacheWritePrice: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  /** 按次售价/成本（USD/次）：图片等非 token 计费模型 */
  pricePerCall: number;
  costPerCall: number;
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
              pricePerCall: true,
              costPerCall: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.modelCatalog.findUnique({
        where: { name: model },
        select: {
          inputPrice: true,
          outputPrice: true,
          cacheReadPrice: true,
          cacheWritePrice: true,
          perCallPrice: true,
        },
      }),
    ]);

    const officialIn = catalog ? Number(catalog.inputPrice) : 0;
    const officialOut = catalog ? Number(catalog.outputPrice) : 0;
    const officialCacheRead = catalog ? Number(catalog.cacheReadPrice) : 0;
    const officialCacheWrite = catalog ? Number(catalog.cacheWritePrice) : 0;
    const officialPerCall =
      catalog?.perCallPrice != null ? Number(catalog.perCallPrice) : 0;
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
    const pricePerCall =
      cm?.pricePerCall != null ? Number(cm.pricePerCall) : officialPerCall * priceDisc;
    const costPerCall =
      cm?.costPerCall != null ? Number(cm.costPerCall) : officialPerCall * costDisc;

    return {
      priceInput,
      priceOutput,
      costInput,
      costOutput,
      cacheReadPrice: officialCacheRead * priceDisc,
      cacheWritePrice: officialCacheWrite * priceDisc,
      cacheReadCost: officialCacheRead * costDisc,
      cacheWriteCost: officialCacheWrite * costDisc,
      pricePerCall,
      costPerCall,
      explicit:
        cm?.priceInput != null ||
        cm?.priceOutput != null ||
        cm?.costInput != null ||
        cm?.costOutput != null ||
        cm?.pricePerCall != null ||
        cm?.costPerCall != null ||
        cm?.costDiscount != null ||
        cm?.priceDiscount != null ||
        cm?.discount != null,
    };
  }

  /** 该模型在渠道下是否为 0 价（免费，无需余额）；按次模型以按次价为准 */
  async isFree(channelId: string | null, model: string): Promise<boolean> {
    const p = await this.getChannelPricing(channelId, model);
    return p.priceInput === 0 && p.priceOutput === 0 && p.pricePerCall === 0;
  }

  /** 用户的有效售价倍率 = 用户倍率 > 所属代理倍率 > 1（作用在渠道价之上） */
  async getUserMultiplier(userId: string): Promise<number> {
    return (await this.getBillingMultiplier(userId)).value;
  }

  /**
   * 解析有效售价倍率及其来源（互斥优先，不叠乘）：
   * 用户个人倍率 > 分组倍率 > 所属代理倍率 > 1。
   * groupRatio 由网关按「令牌分组 > 用户分组 > 默认分组」解析后传入。
   */
  async getBillingMultiplier(
    userId: string,
    groupRatio?: number | null,
  ): Promise<{ value: number; source: 'user' | 'group' | 'agent' | 'default' }> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        priceMultiplier: true,
        agent: { select: { priceMultiplier: true } },
      },
    });
    if (!u) return { value: 1, source: 'default' };
    if (u.priceMultiplier != null) {
      const v = Number(u.priceMultiplier);
      if (v > 0) return { value: v, source: 'user' };
    }
    if (groupRatio != null && groupRatio > 0) {
      return { value: groupRatio, source: 'group' };
    }
    if (u.agent?.priceMultiplier != null) {
      const v = Number(u.agent.priceMultiplier);
      if (v > 0) return { value: v, source: 'agent' };
    }
    return { value: 1, source: 'default' };
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

    // 原子扣费（预授权是读判，不构成扣款）：
    // 1) 余额足够 → 条件自减（balance >= cost 才命中），并发下不会写出负数；
    // 2) 余额不足（并发透支）→ 按剩余余额封底扣减，CAS 匹配读到的快照值，
    //    避免覆盖并发的充值/扣费；快照失效则重试，最多 3 轮。
    // 3) 极端并发下仍无法扣减 → 本次少收（上限为当时余额），余额保持 >= 0。
    let debited = 0;
    for (let attempt = 0; attempt < 3 && debited === 0; attempt++) {
      const full = await tx.user.updateMany({
        where: { id: userId, balance: { gte: cost } },
        data: { balance: { decrement: cost } },
      });
      if (full.count === 1) {
        debited = cost;
        break;
      }
      const cur = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      if (!cur) return 0;
      const available = Number(cur.balance);
      if (available <= 0) break; // 已无可扣余额（并发下被其他请求扣完）
      const target = Math.min(cost, available);
      const floored = await tx.user.updateMany({
        where: { id: userId, balance: cur.balance },
        data: { balance: { decrement: target } },
      });
      if (floored.count === 1) {
        debited = target;
        break;
      }
      // 快照已被并发改动 → 重试（下一轮先尝试足额扣减）
    }

    if (debited > 0) {
      const row = await tx.user.findUnique({
        where: { id: userId },
        select: { balance: true },
      });
      const balanceAfter = round6(Number(row?.balance ?? 0));
      await tx.balanceTransaction.create({
        data: {
          userId,
          type: BalanceTxType.CONSUME,
          amount: -debited,
          balanceAfter,
          requestLogId,
          description: description ?? null,
        },
      });
    }
    // 返点按实际消费额（cost）发放，与扣款是否足额无关
    return this.payCommissions(tx, userId, exists.username, cost, requestLogId);
  }

  /**
   * 沿 agent 链向上发放返点，返回合计（USD）。
   * REBATE_MODE=stacked（默认）：各级各按自身 rebateRate 计算；
   * REBATE_MODE=differential：级差，各级只拿与更靠近用户的下一级的差额。
   */
  private async payCommissions(
    tx: Prisma.TransactionClient,
    userId: string,
    sourceName: string,
    cost: number,
    requestLogId: string,
  ): Promise<number> {
    // 收集代理链（由近及远）
    const chain: { id: string; rate: number }[] = [];
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
      chain.push({
        id: agent.id,
        rate: agent.rebateRate != null ? Number(agent.rebateRate) : 0,
      });
      currentId = agentId;
    }
    if (chain.length === 0) return 0;

    const mode = (process.env.REBATE_MODE ?? 'stacked').toLowerCase();
    let rates: number[];
    if (mode === 'differential') {
      let child = 0;
      rates = chain.map((lvl) => {
        const eff = Math.max(0, lvl.rate - child);
        child = Math.max(child, lvl.rate);
        return eff;
      });
    } else {
      rates = chain.map((lvl) => Math.max(0, lvl.rate));
    }

    let total = 0;
    for (let i = 0; i < chain.length; i++) {
      const commission = round6(cost * rates[i]);
      if (commission <= 0) continue;
      const upd = await tx.user.update({
        where: { id: chain[i].id },
        data: { balance: { increment: commission } },
        select: { balance: true },
      });
      await tx.balanceTransaction.create({
        data: {
          userId: chain[i].id,
          type: BalanceTxType.COMMISSION,
          amount: commission,
          balanceAfter: round6(Number(upd.balance)),
          requestLogId,
          description: `返点（来自 ${sourceName}）`,
        },
      });
      total = round6(total + commission);
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
