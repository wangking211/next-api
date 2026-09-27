import { Injectable } from '@nestjs/common';
import { BalanceTxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService) {}

  /** 代理概览：余额、返点比例/倍率、名下成员数与近 30 天成员消费、累计返点 */
  async overview(agentId: string) {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [user, memberCount, commissionAgg, members] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: agentId },
        select: { balance: true, rebateRate: true, priceMultiplier: true },
      }),
      this.prisma.user.count({ where: { agentId } }),
      this.prisma.balanceTransaction.aggregate({
        where: { userId: agentId, type: BalanceTxType.COMMISSION },
        _sum: { amount: true },
      }),
      this.prisma.user.findMany({ where: { agentId }, select: { id: true } }),
    ]);

    const ids = members.map((m) => m.id);
    const usage = ids.length
      ? await this.prisma.requestLog.aggregate({
          where: { userId: { in: ids }, createdAt: { gte: since } },
          _count: { _all: true },
          _sum: { totalTokens: true, cost: true },
        })
      : null;

    return {
      balance: user ? Number(user.balance) : 0,
      rebateRate: user?.rebateRate != null ? Number(user.rebateRate) : null,
      priceMultiplier:
        user?.priceMultiplier != null ? Number(user.priceMultiplier) : null,
      memberCount,
      commissionTotal: commissionAgg._sum.amount
        ? Number(commissionAgg._sum.amount)
        : 0,
      membersUsage30d: {
        requests: usage?._count._all ?? 0,
        tokens: usage?._sum.totalTokens ?? 0,
        cost: usage?._sum.cost ? Number(usage._sum.cost) : 0,
      },
    };
  }

  /** 名下成员（含近 30 天用量） */
  async members(agentId: string) {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const members = await this.prisma.user.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        balance: true,
        priceMultiplier: true,
        createdAt: true,
      },
    });
    const ids = members.map((m) => m.id);
    const usage = ids.length
      ? await this.prisma.requestLog.groupBy({
          by: ['userId'],
          where: { userId: { in: ids }, createdAt: { gte: since } },
          _count: { _all: true },
          _sum: { totalTokens: true, cost: true },
        })
      : [];
    const map = new Map(usage.map((u) => [u.userId, u]));

    return members.map((m) => {
      const u = map.get(m.id);
      return {
        id: m.id,
        username: m.username,
        email: m.email,
        status: m.status,
        balance: Number(m.balance),
        priceMultiplier:
          m.priceMultiplier != null ? Number(m.priceMultiplier) : null,
        createdAt: m.createdAt,
        usage30d: {
          requests: u?._count._all ?? 0,
          tokens: u?._sum?.totalTokens ?? 0,
          cost: u?._sum?.cost ? Number(u._sum.cost) : 0,
        },
      };
    });
  }
}
